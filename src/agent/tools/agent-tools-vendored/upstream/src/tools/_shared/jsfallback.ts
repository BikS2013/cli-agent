/**
 * JS-only glob/grep fallback used when ripgrep is not available
 * (see {@link probeRipgrep} in `./ripgrep.ts`).
 *
 * Design (per `docs/research/ripgrep-distribution-strategy.md` §6–§7):
 *   - Glob: `fast-glob` finds candidate files. `.gitignore` is honoured
 *     by post-filtering with the `ignore` package, walking parent
 *     directories from `cwd` until a `.gitignore` is found at every
 *     level (capped at `cwd`'s root).
 *   - Grep: glob to enumerate, then for each file `fs.readFile` (utf-8)
 *     and run a regex against each line. Skip binaries (NUL byte in the
 *     first 1024 bytes). Honours an AbortSignal between files.
 */
'use strict';

import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import fg from 'fast-glob';
import ignore from 'ignore';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface GlobFallbackOptions {
  /** Resolved absolute working directory. Patterns are evaluated against this base. */
  readonly cwd: string;
  /** One or more glob patterns. */
  readonly patterns: ReadonlyArray<string>;
  /** Apply hierarchical .gitignore filtering. Default: true. */
  readonly respectGitignore?: boolean;
  /** Include dotfiles. Default: false. */
  readonly hidden?: boolean;
  /** AbortSignal honoured before/after the glob call. */
  readonly signal?: AbortSignal;
}

export interface GrepFallbackOptions {
  readonly cwd: string;
  /** Regex source string. */
  readonly pattern: string;
  /** Regex flags. Default: 'g'. */
  readonly flags?: string;
  /** Restrict search to these (cwd-relative) paths. Default: scan all. */
  readonly paths?: ReadonlyArray<string>;
  /** Apply hierarchical .gitignore filtering. Default: true. */
  readonly respectGitignore?: boolean;
  /** Include dotfiles. Default: false. */
  readonly hidden?: boolean;
  /** Stop after this many matches. Default: 1000. */
  readonly maxMatches?: number;
  /** AbortSignal honoured between files. */
  readonly signal?: AbortSignal;
}

export interface GrepFallbackMatch {
  /** Path relative to `cwd`. */
  readonly path: string;
  /** 1-based line number. */
  readonly lineNumber: number;
  /** Full line text (no trailing newline). */
  readonly line: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class AbortError extends Error {
  override readonly name = 'AbortError';
  constructor(message = 'The operation was aborted') {
    super(message);
  }
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AbortError();
}

/**
 * Build an `ignore.Ignore` instance covering every `.gitignore` from
 * `cwd` walking up to the filesystem root. Each gitignore's rules are
 * applied to paths relative to its own directory; we adapt by
 * computing the portion of the candidate path inside that directory.
 *
 * Rather than juggle multiple Ignore instances per gitignore root, we
 * evaluate hierarchically: for every candidate file, walk up its
 * ancestor directories looking for a `.gitignore`; if one matches the
 * file via its relative segment, the file is ignored.
 *
 * For simplicity and correctness with the `ignore` package, we
 * pre-collect every `.gitignore` (path + parsed Ignore) once and
 * reuse the set for every candidate.
 */
interface GitignoreEntry {
  /** Directory the gitignore lives in. Absolute. */
  readonly dir: string;
  /** Compiled `ignore` instance. */
  readonly ig: ReturnType<typeof ignore>;
}

function loadGitignoresAlongCwd(cwd: string): GitignoreEntry[] {
  const collected: GitignoreEntry[] = [];
  // Walk from cwd upwards adding any .gitignore we encounter.
  let dir = resolve(cwd);
  // Hard cap to avoid infinite loops on weird filesystems.
  for (let i = 0; i < 64; i++) {
    const giPath = join(dir, '.gitignore');
    if (existsSync(giPath)) {
      try {
        const ig = ignore().add(readFileSync(giPath, 'utf8'));
        collected.push({ dir, ig });
      } catch {
        // ignore unreadable .gitignore
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return collected;
}

function isIgnoredByAny(absPath: string, entries: ReadonlyArray<GitignoreEntry>): boolean {
  for (const entry of entries) {
    const r = relative(entry.dir, absPath);
    if (r.length === 0) continue;
    if (r.startsWith('..') || r.includes(`..${sep}`)) continue;
    const normalised = r.split(sep).join('/');
    try {
      if (entry.ig.ignores(normalised)) return true;
    } catch {
      // ignore package throws on absolute paths; we already pass relative.
    }
  }
  return false;
}

const NUL_PROBE_BYTES = 1024;

async function isBinaryFile(absPath: string): Promise<boolean> {
  try {
    const handle = await readFile(absPath);
    const slice = handle.subarray(0, NUL_PROBE_BYTES);
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------
// globFallback
// ---------------------------------------------------------------------------

export async function globFallback(opts: GlobFallbackOptions): Promise<string[]> {
  const respectGitignore = opts.respectGitignore !== false;
  const hidden = opts.hidden === true;

  checkAbort(opts.signal);

  const absCwd = resolve(opts.cwd);
  const entries = await fg([...opts.patterns], {
    cwd: absCwd,
    dot: hidden,
    onlyFiles: true,
    absolute: true,
    suppressErrors: true,
    followSymbolicLinks: false,
  });

  checkAbort(opts.signal);

  if (!respectGitignore) return entries.sort();

  const gitignores = loadGitignoresAlongCwd(absCwd);
  if (gitignores.length === 0) return entries.sort();

  return entries.filter((p) => !isIgnoredByAny(p, gitignores)).sort();
}

// ---------------------------------------------------------------------------
// grepFallback
// ---------------------------------------------------------------------------

export async function grepFallback(opts: GrepFallbackOptions): Promise<GrepFallbackMatch[]> {
  const flags = opts.flags ?? 'g';
  const maxMatches = opts.maxMatches ?? 1000;
  const respectGitignore = opts.respectGitignore !== false;
  const hidden = opts.hidden === true;

  checkAbort(opts.signal);

  const absCwd = resolve(opts.cwd);

  // Determine the candidate file list.
  let candidates: string[];
  if (opts.paths && opts.paths.length > 0) {
    candidates = [];
    for (const p of opts.paths) {
      const abs = resolve(absCwd, p);
      try {
        const st = statSync(abs);
        if (st.isFile()) {
          candidates.push(abs);
        } else if (st.isDirectory()) {
          const inDir = await fg(['**/*'], {
            cwd: abs,
            dot: hidden,
            onlyFiles: true,
            absolute: true,
            suppressErrors: true,
            followSymbolicLinks: false,
          });
          candidates.push(...inDir);
        }
      } catch {
        // ignore missing entries
      }
    }
  } else {
    candidates = await fg(['**/*'], {
      cwd: absCwd,
      dot: hidden,
      onlyFiles: true,
      absolute: true,
      suppressErrors: true,
      followSymbolicLinks: false,
    });
  }

  if (respectGitignore) {
    const gitignores = loadGitignoresAlongCwd(absCwd);
    if (gitignores.length > 0) {
      candidates = candidates.filter((p) => !isIgnoredByAny(p, gitignores));
    }
  }

  candidates = Array.from(new Set(candidates)).sort();

  // Scan.
  const matches: GrepFallbackMatch[] = [];
  for (const abs of candidates) {
    checkAbort(opts.signal);
    if (matches.length >= maxMatches) break;
    if (await isBinaryFile(abs)) continue;
    let content: string;
    try {
      content = await readFile(abs, 'utf8');
    } catch {
      continue;
    }
    // Build a fresh regex per file so internal `lastIndex` state is
    // never carried across files.
    let re: RegExp;
    try {
      re = new RegExp(opts.pattern, flags);
    } catch (err) {
      throw err;
    }
    const lines = content.split(/\r?\n/);
    const rel = relative(absCwd, abs);
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxMatches) break;
      const line = lines[i] as string;
      // Reset to allow `g` flag reuse on a fresh string.
      re.lastIndex = 0;
      if (re.test(line)) {
        matches.push({ path: rel, lineNumber: i + 1, line });
      }
    }
  }
  return matches;
}
