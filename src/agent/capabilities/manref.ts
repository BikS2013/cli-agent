/**
 * Detect whether a wrapped binary has a man page, and return a stable
 * pointer the agent can use at execution time.
 *
 * Implementation: `man -w <name>` — the POSIX-portable "where is the man
 * page?" probe (supported on macOS, Linux, every BSD). Output is one or
 * more absolute paths (one per available section), one per line. We take
 * the first non-empty path and parse the section number from the
 * filename.
 *
 * No fallback: when `man` is missing, the binary has no man entry, the
 * call times out, or the output is unparseable, we return
 * `{ manRef: null, manPagePath: null }` and the caller treats that as
 * the explicit "no man page" state. There is no synthesised pointer.
 */
import { spawnCommand } from '../tools/bash/exec.js';

export interface ManRefResult {
  /**
   * Canonical identifier the LLM is told to refer to. Of the form
   * `man:<section> <name>` (e.g. `man:1 git`). `null` when no man page
   * was discovered for the binary.
   */
  readonly manRef: string | null;
  /**
   * Absolute path of the underlying man-page file (e.g.
   * `/usr/share/man/man1/git.1.gz`). Non-null exactly when `manRef` is
   * non-null. Recorded for debugging only — the agent never reads from
   * this path; it shells out to `man <section> <name>` instead.
   */
  readonly manPagePath: string | null;
}

const NULL_RESULT: ManRefResult = Object.freeze({ manRef: null, manPagePath: null });

/**
 * Parse a man-page filename into its section number.
 *
 * macOS / BSD: `/usr/share/man/man1/git.1`
 * Linux:       `/usr/share/man/man1/git.1.gz` (or `.bz2`, `.xz`, `.zst`)
 *
 * The section appears as the LAST numeric component of the filename
 * (immediately after the binary name), optionally followed by a
 * compression suffix. Some sections use suffixes like `1p` (POSIX
 * standard pages) or `3perl`; we capture digits + optional letters.
 */
export function parseSection(manPagePath: string): string | null {
  const slash = manPagePath.lastIndexOf('/');
  const base = slash >= 0 ? manPagePath.slice(slash + 1) : manPagePath;
  // Strip a single trailing compression suffix if present.
  const stripped = base.replace(/\.(?:gz|bz2|xz|zst|Z|lzma)$/i, '');
  // Match `.<digits><optional letters>` at the end of the stripped name.
  const m = stripped.match(/\.(\d+[a-zA-Z]*)$/);
  return m ? m[1]! : null;
}

export async function detectManRef(
  binaryName: string,
  timeoutMs: number,
): Promise<ManRefResult> {
  // Reject empty / suspicious names defensively. Binary names that need
  // man-page discovery are simple identifiers; anything with whitespace
  // or shell metacharacters means the caller is doing something wrong.
  if (!binaryName || /[\s'"`$\\;|&<>()]/.test(binaryName)) {
    return NULL_RESULT;
  }

  let result;
  try {
    result = await spawnCommand({
      command: 'man',
      args: ['-w', binaryName],
      timeoutMs,
      maxOutputBytes: 4096,
      passEnv: ['PATH', 'HOME', 'LANG', 'TERM', 'MANPATH'],
      extraEnv: { PAGER: 'cat', MANPAGER: 'cat', NO_COLOR: '1', TERM: 'dumb' },
    });
  } catch {
    return NULL_RESULT;
  }

  if (result.exitCode !== 0) return NULL_RESULT;

  const firstPath = result.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);

  if (!firstPath) return NULL_RESULT;

  const section = parseSection(firstPath);
  if (!section) return NULL_RESULT;

  return {
    manRef: `man:${section} ${binaryName}`,
    manPagePath: firstPath,
  };
}
