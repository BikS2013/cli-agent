/**
 * `glob` — find files by glob pattern, sorted by modification time
 * (descending). Uses ripgrep `--files --glob <pattern>` when available;
 * otherwise falls back to a JS implementation backed by `fast-glob` +
 * `ignore` for `.gitignore` honouring.
 *
 * Read-only. No permission gate is applied (the strict policy's fs
 * evaluators only cover writes).
 *
 * Output is the list of matched paths (relative to the resolved search
 * directory), one per line, sorted newest-first by mtime. The list is
 * truncation-capped via `_shared/truncate.ts`; metadata exposes
 * `matchCount` and the backend `source` (`'ripgrep' | 'fallback'`).
 */
'use strict';

import { existsSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { ToolExecutionError } from '../../errors.js';
import { loadPromptFile } from '../../prompts/loader.js';
import { registerPrompt } from '../../prompts/registry.js';
import type { AgentTool, ToolContext, ToolResult } from '../../types.js';
import { globFallback } from '../_shared/jsfallback.js';
import { probeRipgrep, runRipgrep } from '../_shared/ripgrep.js';
import { truncate } from '../_shared/truncate.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const inputSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('The glob pattern to match files against (e.g. "**/*.ts").'),
  path: z
    .string()
    .optional()
    .describe(
      'The directory to search in. Defaults to the working directory. ' +
        'Resolved relative to ctx.cwd when not absolute.',
    ),
});

export type GlobInput = z.infer<typeof inputSchema>;

export interface GlobOutputData {
  /** Resolved search directory (absolute). */
  readonly searchDir: string;
  /** Matched paths relative to `searchDir`, sorted by mtime DESC. */
  readonly matches: ReadonlyArray<string>;
  /** Backend that produced the result. */
  readonly source: 'ripgrep' | 'fallback';
}

// ---------------------------------------------------------------------------
// Prompt loading (with src/ fallback)
// ---------------------------------------------------------------------------

const PROMPT_BASENAME = 'glob.prompt.md';
const DESCRIPTION =
  'Find files by glob pattern. Returns paths relative to the search ' +
  'directory, sorted by mtime descending.';

function loadGlobPrompt(): string {
  // First try the file co-located with this module (works in src + when
  // a build pipeline copies *.prompt.md to dist).
  try {
    return loadPromptFile(import.meta.url, PROMPT_BASENAME);
  } catch (primaryErr) {
    // Fallback: the compiled module at `dist/src/tools/glob/index.js`
    // may not have its prompt copied alongside; resolve to the source
    // tree by rewriting the path segment.
    const here = fileURLToPath(import.meta.url);
    const candidates = [
      here.replace(`${'dist/'}src/`, 'src/'),
      here.replace(`${'/dist/src/'}`, '/src/'),
    ];
    for (const candidate of candidates) {
      const dir = candidate.slice(0, candidate.lastIndexOf('/'));
      const promptPath = `${dir}/${PROMPT_BASENAME}`;
      if (existsSync(promptPath)) {
        return loadPromptFile(promptPath);
      }
    }
    throw primaryErr;
  }
}

const PROMPT = loadGlobPrompt();
registerPrompt('glob', DESCRIPTION, PROMPT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default cap on emitted lines (mirrors upstream and grep). */
const DEFAULT_MAX_OUTPUT_LINES = 2000;

/** Default cap on emitted bytes (defensive). */
const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

interface MatchWithMtime {
  readonly path: string;
  readonly mtimeMs: number;
}

/**
 * Best-effort mtime stat. Returns 0 when the file disappears between
 * the glob and the stat (race) or when the OS denies stat permission.
 */
function safeStatMtime(absPath: string): number {
  try {
    return statSync(absPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Parse ripgrep's `--files --glob <pattern>` stdout into a list of
 * paths relative to `cwd`. Empty / blank lines are dropped.
 */
function parseRgFiles(stdout: string): string[] {
  if (stdout.length === 0) return [];
  return stdout
    .split('\n')
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// execute
// ---------------------------------------------------------------------------

async function execute(
  input: GlobInput,
  ctx: ToolContext,
): Promise<ToolResult<GlobOutputData>> {
  try {
    // Resolve search directory.
    const rawPath = input.path ?? ctx.cwd;
    const searchDir = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);

    // Existence + type check.
    let stat;
    try {
      stat = statSync(searchDir);
    } catch (err) {
      return {
        ok: false,
        error: new ToolExecutionError(`glob path not found: ${searchDir}`, {
          cause: err,
          code: 'GLOB_PATH_NOT_FOUND',
        }),
      };
    }
    if (!stat.isDirectory()) {
      return {
        ok: false,
        error: new ToolExecutionError(
          `glob path must be a directory: ${searchDir}`,
          { code: 'GLOB_PATH_NOT_DIRECTORY' },
        ),
      };
    }

    // Probe ripgrep; fall back to JS implementation if unavailable.
    const probe = await probeRipgrep();

    let relativePaths: string[];
    let source: 'ripgrep' | 'fallback';

    if (probe.available) {
      // `--no-require-git` so .gitignore is honoured even when the
      // search dir is not inside a git repo (matches the JS fallback's
      // behaviour, which always reads .gitignore).
      //
      // ripgrep treats explicit `--glob` patterns as overriding any
      // ignore logic (see `rg --help -- --iglob`). For the universal
      // pattern `**/*` (or `**`) we therefore omit `--glob` so the
      // gitignore is preserved; otherwise we forward the pattern.
      const isUniversal = /^(\*\*\/?\*?|\*\*)$/.test(input.pattern);
      const args: string[] = ['--files', '--no-require-git'];
      if (!isUniversal) {
        args.push('--glob', input.pattern);
      }
      const signalOpt: { signal?: AbortSignal } =
        ctx.signal !== undefined ? { signal: ctx.signal } : {};
      const result = await runRipgrep(args, { cwd: searchDir, ...signalOpt });
      // ripgrep `--files` exits 0 when matches found, 1 when no files
      // matched / the directory is empty. Treat both as success.
      if (result.exitCode !== 0 && result.exitCode !== 1) {
        return {
          ok: false,
          error: new ToolExecutionError(
            `ripgrep exited with code ${String(result.exitCode)}: ${result.stderr.trim()}`,
            { code: 'GLOB_RIPGREP_FAILED' },
          ),
        };
      }
      relativePaths = parseRgFiles(result.stdout);
      source = 'ripgrep';
    } else {
      const fallbackOpts: Parameters<typeof globFallback>[0] = {
        cwd: searchDir,
        patterns: [input.pattern],
        respectGitignore: true,
        hidden: false,
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
      };
      const absMatches = await globFallback(fallbackOpts);
      relativePaths = absMatches.map((abs) => relative(searchDir, abs));
      source = 'fallback';
    }

    // Stat each match for mtime; sort DESC.
    const enriched: MatchWithMtime[] = relativePaths.map((rel) => ({
      path: rel,
      mtimeMs: safeStatMtime(resolve(searchDir, rel)),
    }));
    enriched.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const sortedPaths = enriched.map((m) => m.path);

    // Build the textual output and apply truncation caps.
    const rawOutput = sortedPaths.join('\n');
    const maxLines = ctx.limits?.maxOutputLines ?? DEFAULT_MAX_OUTPUT_LINES;
    const maxBytes = ctx.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const truncRes = truncate(rawOutput, { maxLines, maxBytes });

    const data: GlobOutputData = {
      searchDir,
      matches: sortedPaths,
      source,
    };

    return {
      ok: true,
      output: truncRes.output,
      data,
      metadata: {
        truncated: truncRes.truncated,
        originalBytes: truncRes.originalBytes,
        returnedBytes: truncRes.returnedBytes,
        matchCount: sortedPaths.length,
        source,
      },
    };
  } catch (err) {
    if (err instanceof ToolExecutionError) {
      return { ok: false, error: err };
    }
    const message =
      err instanceof Error ? err.message : `Unknown glob failure: ${String(err)}`;
    return {
      ok: false,
      error: new ToolExecutionError(message, {
        cause: err,
        code: 'GLOB_FAILED',
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Public tool object
// ---------------------------------------------------------------------------

export const globTool: AgentTool<typeof inputSchema, GlobOutputData> = {
  id: 'glob',
  description: DESCRIPTION,
  category: 'fs',
  mutating: false,
  parameters: inputSchema,
  prompt: PROMPT,
  execute,
};
