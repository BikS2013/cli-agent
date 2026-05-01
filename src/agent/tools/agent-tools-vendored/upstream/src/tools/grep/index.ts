/**
 * `grep` tool — content search by regex.
 *
 * Backend strategy (per `_shared/ripgrep.ts` three-tier probe):
 *   1. ripgrep (PATH or @vscode/ripgrep bundle) — invoked with `--json`
 *      and parsed line-by-line.
 *   2. JS fallback (`_shared/jsfallback.ts.grepFallback`) — used when
 *      no ripgrep binary is available, or when the ripgrep child fails
 *      to spawn.
 *
 * Output shape depends on `outputMode`:
 *   - `files_with_matches` (default) — newline-separated file paths.
 *   - `count`                          — `path: N` lines.
 *   - `content`                        — `path:line:matched-text` lines.
 *
 * The tool is read-only (no permission gate, `mutating: false`). Errors
 * are surfaced as `{ ok: false, error }` — never thrown.
 */
'use strict';

import { resolve as resolvePath, isAbsolute as isAbsolutePath, relative as relativePath, join as joinPath } from 'node:path';
import { statSync } from 'node:fs';

import { z } from 'zod';

import { InputValidationError, ToolExecutionError } from '../../errors.js';
import type { AgentTool, ToolContext, ToolResult } from '../../types.js';
import { loadPromptFile } from '../../prompts/loader.js';
import { registerPrompt } from '../../prompts/registry.js';
import {
  grepFallback,
  probeRipgrep,
  runRipgrep,
} from '../_shared/index.js';
import { truncate } from '../_shared/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_MATCHES = 100;
const MAX_LINE_LENGTH = 2000;
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024; // 256 KiB safety cap on the rendered output.

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const grepInputSchema = z.object({
  pattern: z.string().min(1, 'pattern is required'),
  path: z.string().optional(),
  include: z.string().optional(),
  outputMode: z.enum(['content', 'files_with_matches', 'count']).optional(),
});

export type GrepInput = z.infer<typeof grepInputSchema>;

interface GrepMatch {
  /** Absolute path of the file. */
  readonly path: string;
  /** 1-based line number. */
  readonly line: number;
  /** Full line text. */
  readonly text: string;
}

export interface GrepOutput {
  readonly mode: 'content' | 'files_with_matches' | 'count';
  readonly matches: ReadonlyArray<GrepMatch>;
  readonly truncated: boolean;
  readonly source: 'ripgrep' | 'js-fallback';
}

const PROMPT = loadPromptFile(import.meta.url, 'grep.prompt.md');

const DESCRIPTION =
  'Search file contents by regex. Returns matching files (or lines) sorted by mtime descending. Capped at 100 matches.';

registerPrompt('grep', DESCRIPTION, PROMPT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clipLine(text: string): string {
  if (text.length <= MAX_LINE_LENGTH) return text;
  return text.substring(0, MAX_LINE_LENGTH) + '...';
}

function resolveSearchRoot(ctx: ToolContext, p: string | undefined): string {
  if (p === undefined) return resolvePath(ctx.cwd);
  return isAbsolutePath(p) ? resolvePath(p) : resolvePath(ctx.cwd, p);
}

interface RipgrepJsonMessage {
  type: string;
  data?: {
    path?: { text?: string };
    line_number?: number;
    lines?: { text?: string };
  };
}

function parseRipgrepJson(stdout: string, cwd: string): GrepMatch[] {
  const out: GrepMatch[] = [];
  const lines = stdout.split('\n');
  for (const raw of lines) {
    if (raw.length === 0) continue;
    let msg: RipgrepJsonMessage;
    try {
      msg = JSON.parse(raw) as RipgrepJsonMessage;
    } catch {
      continue;
    }
    if (msg.type !== 'match') continue;
    const data = msg.data;
    if (!data || !data.path || typeof data.path.text !== 'string') continue;
    const line = typeof data.line_number === 'number' ? data.line_number : 0;
    const textRaw = data.lines && typeof data.lines.text === 'string' ? data.lines.text : '';
    // Strip trailing newline that ripgrep keeps in `lines.text`.
    const text = textRaw.replace(/\r?\n$/, '');
    const filePath = data.path.text;
    const abs = isAbsolutePath(filePath) ? filePath : joinPath(cwd, filePath);
    out.push({ path: abs, line, text });
  }
  return out;
}

interface RunResult {
  readonly matches: GrepMatch[];
  readonly source: 'ripgrep' | 'js-fallback';
}

async function runRipgrepBackend(args: {
  cwd: string;
  pattern: string;
  include: string | undefined;
  signal: AbortSignal | undefined;
}): Promise<RunResult> {
  const rgArgs: string[] = ['--json', '--no-require-git', '-e', args.pattern];
  if (args.include !== undefined) {
    rgArgs.push('--glob', args.include);
  }
  // Cap total matches to keep stdout bounded. `--no-require-git` makes
  // ripgrep honour any `.gitignore` files regardless of whether the
  // search root sits inside a git repo (matching the JS fallback).
  rgArgs.push('--max-count', String(DEFAULT_MAX_MATCHES * 4));
  const runOpts: { cwd: string; signal?: AbortSignal } = { cwd: args.cwd };
  if (args.signal !== undefined) runOpts.signal = args.signal;
  const result = await runRipgrep(rgArgs, runOpts);
  // Exit 1 from ripgrep means "no matches" — not an error.
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new ToolExecutionError(
      `ripgrep exited with code ${result.exitCode}: ${result.stderr.trim() || '<no stderr>'}`,
      { code: 'RIPGREP_FAILED' },
    );
  }
  const matches = parseRipgrepJson(result.stdout, args.cwd);
  return { matches, source: 'ripgrep' };
}

async function runJsBackend(args: {
  cwd: string;
  pattern: string;
  include: string | undefined;
  signal: AbortSignal | undefined;
}): Promise<RunResult> {
  // The JS fallback's `paths` is a directory/file list, not a glob —
  // include filtering is unsupported there. We instead enumerate
  // candidates that match the include glob via fast-glob's behaviour
  // baked into grepFallback's default scan, and post-filter by include.
  const fallbackOpts: {
    cwd: string;
    pattern: string;
    flags: string;
    maxMatches: number;
    signal?: AbortSignal;
  } = {
    cwd: args.cwd,
    pattern: args.pattern,
    flags: '',
    maxMatches: DEFAULT_MAX_MATCHES * 4,
  };
  if (args.signal !== undefined) fallbackOpts.signal = args.signal;
  const fbMatches = await grepFallback(fallbackOpts);
  let mapped: GrepMatch[] = fbMatches.map((m) => ({
    path: resolvePath(args.cwd, m.path),
    line: m.lineNumber,
    text: m.line,
  }));
  if (args.include !== undefined) {
    const includeRe = globToRegExp(args.include);
    mapped = mapped.filter((m) => includeRe.test(basename(m.path)));
  }
  return { matches: mapped, source: 'js-fallback' };
}

function basename(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Translate a simple glob (`*.ts`, `*.{ts,tsx}`) to a RegExp that
 * matches a file basename. Only handles the subset required for
 * `include` filtering.
 */
function globToRegExp(glob: string): RegExp {
  let i = 0;
  let out = '';
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      out += '[^/]*';
    } else if (ch === '?') {
      out += '[^/]';
    } else if (ch === '.') {
      out += '\\.';
    } else if (ch === '{') {
      // Find matching closing brace.
      const close = glob.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
      } else {
        const inner = glob.slice(i + 1, close);
        const parts = inner.split(',').map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'));
        out += '(?:' + parts.join('|') + ')';
        i = close + 1;
        continue;
      }
    } else if (ch !== undefined && /[+^$()|[\]\\]/.test(ch)) {
      out += '\\' + ch;
    } else if (ch !== undefined) {
      out += ch;
    }
    i++;
  }
  return new RegExp('^' + out + '$');
}

function sortByMtimeDesc(matches: GrepMatch[]): GrepMatch[] {
  const mtimes = new Map<string, number>();
  for (const m of matches) {
    if (mtimes.has(m.path)) continue;
    try {
      const st = statSync(m.path);
      mtimes.set(m.path, st.mtimeMs);
    } catch {
      mtimes.set(m.path, 0);
    }
  }
  return [...matches].sort((a, b) => {
    const ma = mtimes.get(a.path) ?? 0;
    const mb = mtimes.get(b.path) ?? 0;
    if (mb !== ma) return mb - ma;
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.line - b.line;
  });
}

function relPath(cwd: string, abs: string): string {
  const r = relativePath(cwd, abs);
  return r.length === 0 ? abs : r;
}

function renderOutput(args: {
  mode: 'content' | 'files_with_matches' | 'count';
  matches: ReadonlyArray<GrepMatch>;
  cwd: string;
}): string {
  const { mode, matches, cwd } = args;
  if (matches.length === 0) return '';

  if (mode === 'files_with_matches') {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const m of matches) {
      if (seen.has(m.path)) continue;
      seen.add(m.path);
      lines.push(relPath(cwd, m.path));
    }
    return lines.join('\n');
  }

  if (mode === 'count') {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const m of matches) {
      if (!counts.has(m.path)) {
        order.push(m.path);
        counts.set(m.path, 0);
      }
      counts.set(m.path, (counts.get(m.path) ?? 0) + 1);
    }
    return order.map((p) => `${relPath(cwd, p)}: ${counts.get(p) ?? 0}`).join('\n');
  }

  // content mode
  return matches.map((m) => `${relPath(cwd, m.path)}:${m.line}:${clipLine(m.text)}`).join('\n');
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const grepTool: AgentTool<typeof grepInputSchema, GrepOutput> = {
  id: 'grep',
  description: DESCRIPTION,
  category: 'fs',
  mutating: false,
  parameters: grepInputSchema,
  prompt: PROMPT,
  async execute(input: GrepInput, ctx: ToolContext): Promise<ToolResult<GrepOutput>> {
    // ----- Schema validation --------------------------------------------------
    const parsed = grepInputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        ok: false,
        error: new InputValidationError('grep input is invalid', parsed.error),
      };
    }
    const { pattern, path: pathArg, include, outputMode: modeArg } = parsed.data;
    const mode = modeArg ?? 'files_with_matches';

    // ----- Regex compile (early validation) -----------------------------------
    try {
      // Throws on invalid pattern; we don't keep the instance — both
      // backends compile their own.
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      new RegExp(pattern);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        error: new ToolExecutionError(`Invalid regex: ${msg}`, { code: 'INVALID_REGEX', cause: err }),
      };
    }

    // ----- Resolve search root -----------------------------------------------
    const searchRoot = resolveSearchRoot(ctx, pathArg);
    let rootCwd: string;
    try {
      const st = statSync(searchRoot);
      rootCwd = st.isDirectory() ? searchRoot : resolvePath(searchRoot, '..');
    } catch {
      return {
        ok: false,
        error: new ToolExecutionError(`path not found: ${searchRoot}`, { code: 'PATH_NOT_FOUND' }),
      };
    }

    const maxMatches = ctx.limits?.maxMatches ?? DEFAULT_MAX_MATCHES;

    // ----- Probe + run -------------------------------------------------------
    let runResult: RunResult;
    try {
      const probe = await probeRipgrep();
      const backendArgs: { cwd: string; pattern: string; include: string | undefined; signal: AbortSignal | undefined } = {
        cwd: rootCwd,
        pattern,
        include,
        signal: ctx.signal,
      };
      if (probe.available) {
        try {
          runResult = await runRipgrepBackend(backendArgs);
        } catch (err) {
          // If ripgrep is unavailable (race) or spawn failed, fall back.
          if (err instanceof ToolExecutionError && (err.code === 'RIPGREP_UNAVAILABLE' || err.code === 'RIPGREP_SPAWN_FAILED')) {
            runResult = await runJsBackend(backendArgs);
          } else {
            return { ok: false, error: err instanceof ToolExecutionError ? err : new ToolExecutionError(String(err), { cause: err }) };
          }
        }
      } else {
        runResult = await runJsBackend(backendArgs);
      }
    } catch (err) {
      const e = err instanceof ToolExecutionError ? err : new ToolExecutionError(err instanceof Error ? err.message : String(err), { cause: err });
      return { ok: false, error: e };
    }

    // ----- Sort + cap --------------------------------------------------------
    const sorted = sortByMtimeDesc(runResult.matches);
    const totalMatches = sorted.length;
    const truncatedByCap = totalMatches > maxMatches;
    const capped = truncatedByCap ? sorted.slice(0, maxMatches) : sorted;

    // ----- Render ------------------------------------------------------------
    const rendered = renderOutput({ mode, matches: capped, cwd: rootCwd });

    // ----- Output truncation -------------------------------------------------
    const trunc = truncate(rendered, { maxBytes: DEFAULT_MAX_OUTPUT_BYTES });
    const truncated = truncatedByCap || trunc.truncated;

    return {
      ok: true,
      output: trunc.output,
      data: {
        mode,
        matches: capped,
        truncated,
        source: runResult.source,
      },
      metadata: {
        truncated,
        matchCount: totalMatches,
        source: runResult.source,
        originalBytes: trunc.originalBytes,
        returnedBytes: trunc.returnedBytes,
      },
    };
  },
};
