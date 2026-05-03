/**
 * POSIX shim generator for composite tools (plan-006 P6 / U-WRAPPER).
 *
 * Generates an executable `/bin/sh` shim that, when run on macOS or
 * Linux, exec's the resolved cli-agent binary with the recorded
 * `--tool <member>` flags pre-baked, plus any caller-supplied
 * passthrough args, plus the user's runtime `"$@"` arguments.
 *
 * The shim follows the recommended template in
 * `docs/research/posix-wrapper-shim-design.md` §5 (modeled on npm's
 * `cmd-shim`):
 *
 *   - `#!/bin/sh` — POSIX-portable, no Alpine bash dependency
 *     (ADR-CMP-2; research §13).
 *   - No `set -euo pipefail` — `pipefail` is non-POSIX; `exec`
 *     handles propagation; `set -u` is hostile to `${1:-}` (research
 *     §3).
 *   - `exec` for both the doc-print branch and the cli-agent
 *     invocation — preserves the shim's PID (clean signal forwarding
 *     and exit-code propagation per research §4).
 *   - Atomic write via temp + rename with `mode: 0o755` set at file
 *     creation — eliminates the world-readable race window (research
 *     §10).
 *   - All embedded values (cli-agent path, doc path, member names,
 *     additional args) are POSIX single-quote escaped via the local
 *     `shellEscape` helper. The Cygwin / MINGW / MSYS branch from npm
 *     is intentionally omitted — cli-agent v1 targets macOS + Linux
 *     only.
 *
 * Public API:
 *   generateCompositeWrapperShim(spec [, options]) → ShimGenResult
 *   generatePathSymlink(shimPath, name [, options])    → { symlinkPath, warnings }
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { FileError } from '../../errors.js';
import type { CompositeWrapperShimSpec } from './types.js';

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface ShimGenResult {
  /** Absolute path of the written shim file. */
  readonly path: string;
  /** File mode applied at creation time (0o755). */
  readonly mode: number;
  /** Non-fatal advisories (e.g. nvm/volta/asdf detection). */
  readonly warnings: readonly string[];
}

export interface ShimGenOptions {
  /**
   * Extra arguments to bake into the shim BEFORE `"$@"`. Useful for
   * `--no-agent-tools --allow-mutations --per-tool-budget …`. Each
   * value is single-quote escaped. Optional; default empty.
   */
  readonly additionalArgs?: readonly string[];
  /**
   * Override the directory the shim is written into. When omitted the
   * generator uses `spec.shimDir` (which is the canonical
   * `<agentDir>/composites/<id>/` per §14.F).
   */
  readonly outputDir?: string;
}

export interface PathSymlinkOptions {
  /**
   * Directory in which to create the symlink. Default: `~/.local/bin`.
   * Created with mode 0o700 if missing.
   */
  readonly dir?: string;
  /**
   * If a regular file already exists at `<dir>/<name>` (and is NOT a
   * symlink to our shim), `force=true` overwrites it. Default false.
   */
  readonly force?: boolean;
}

export interface PathSymlinkResult {
  readonly symlinkPath: string;
  readonly warnings: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const SHIM_MODE = 0o755;
const SYMLINK_DIR_MODE = 0o700;

/** Markers for nvm / volta / asdf paths embedded in the cli-agent
 *  binary location (research §13 / OQ-6). Detection emits a
 *  non-fatal warning so the user knows the shim will break if they
 *  switch versions. */
const VERSION_MANAGER_MARKERS: ReadonlyArray<{
  readonly fragment: string;
  readonly name: string;
}> = [
  { fragment: '/.nvm/', name: 'nvm' },
  { fragment: '/.volta/', name: 'volta' },
  { fragment: '/.asdf/', name: 'asdf' },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Minimal POSIX single-quote escaping for embedding values inside
 * shell literals. Wraps the value in single quotes; any embedded
 * single quote is escaped with the canonical `'\''` idiom (close
 * quote, literal quote, reopen quote).
 *
 * Examples:
 *   /usr/local/bin/cli-agent  → '/usr/local/bin/cli-agent'
 *   /home/user's dir          → '/home/user'\''s dir'
 *   path with \backslash       → 'path with \backslash'   (no special handling needed
 *                                                          inside single quotes)
 */
function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Detect whether the given binary path resolves under a Node version
 *  manager and return the manager name + the human warning string. */
function detectVersionManager(cliAgentBinPath: string): readonly string[] {
  const warnings: string[] = [];
  for (const m of VERSION_MANAGER_MARKERS) {
    if (cliAgentBinPath.includes(m.fragment)) {
      warnings.push(
        `cli-agent path resolves to a Node version manager (${m.name}): ` +
          `${cliAgentBinPath}. Switching versions will break this shim. ` +
          'Consider `npm link` or a stable global install (e.g. `/usr/local/bin/cli-agent`).',
      );
    }
  }
  return warnings;
}

/**
 * Build the shim text. Pure function — no I/O — so the snapshot test
 * can call it via the public generator and mask only the timestamp.
 */
function buildShimText(args: {
  readonly compositeName: string;
  readonly members: readonly string[];
  readonly cliAgentBinPath: string;
  readonly capabilityDocPath: string;
  readonly synthesizedAt: string;
  readonly additionalArgs: readonly string[];
}): string {
  const {
    compositeName,
    members,
    cliAgentBinPath,
    capabilityDocPath,
    synthesizedAt,
    additionalArgs,
  } = args;

  // One `--tool <m>` flag per member, members shell-escaped to tolerate
  // any future relaxation of the FR-CMP-011 regex.
  const toolFlags = members.map((m) => `--tool ${shellEscape(m)}`).join(' ');

  // Additional baked-in args (e.g. --no-agent-tools).
  const extra = additionalArgs.map((a) => shellEscape(a)).join(' ');

  // Trailing space only when extra is non-empty so the template stays
  // tidy when the caller passes nothing.
  const tail = extra.length > 0 ? `${extra} "$@"` : '"$@"';

  // The shim body. Every line below must be POSIX-sh-portable.
  // Note: the `basedir=` line uses the npm-cmd-shim sed dance verbatim
  // (research §5, point 8) — kept for forward compatibility.
  const lines = [
    '#!/bin/sh',
    `# Generated by cli-agent composite-synthesize @ ${synthesizedAt}; composite=${compositeName}`,
    `# cli-agent composite wrapper — ${compositeName}`,
    '# DO NOT HAND-EDIT — regenerate with:',
    `#   cli-agent --treat-as-tool --regenerate-capabilities --composite-name ${compositeName}`,
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
    `DOC=${shellEscape(capabilityDocPath)}`,
    'case "${1:-}" in',
    '  --help|-h)',
    '    if [ ! -r "$DOC" ]; then',
    `      echo "composite cache stale; re-run: cli-agent --treat-as-tool --regenerate-capabilities --composite-name ${compositeName}" >&2`,
    '      exit 6',
    '    fi',
    '    exec cat "$DOC"',
    '    ;;',
    'esac',
    `exec ${shellEscape(cliAgentBinPath)} ${toolFlags} ${tail}`,
  ];

  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* generateCompositeWrapperShim                                        */
/* ------------------------------------------------------------------ */

/**
 * Generate the POSIX shim for a composite tool and write it
 * atomically to `<outputDir>/<compositeName>` at mode 0o755.
 *
 * Atomicity contract:
 *   1. Write to `<outputDir>/<compositeName>.tmp` with `{ mode: 0o755 }`.
 *      The mode is set at creation, so the file is never visible
 *      world-readable-but-not-executable.
 *   2. `fsp.rename(tmp, finalPath)` — atomic on the same filesystem.
 *   3. On any failure the tmp file is cleaned up (best-effort).
 *
 * Idempotency:
 *   Re-running the generator with the same spec produces the same
 *   shim (modulo the timestamp comment line). The atomic rename always
 *   replaces the previous file in place.
 *
 * Errors:
 *   Any filesystem error is wrapped in `FileError` (exit code 6).
 *
 * Warnings (non-fatal):
 *   - `cli-agent path resolves to a Node version manager …` when
 *     `cliAgentBinPath` includes `/.nvm/`, `/.volta/`, or `/.asdf/`.
 */
export async function generateCompositeWrapperShim(
  spec: CompositeWrapperShimSpec,
  options: ShimGenOptions = {},
): Promise<ShimGenResult> {
  const additionalArgs = options.additionalArgs ?? [];
  const outputDir = options.outputDir ?? spec.shimDir;

  if (spec.members.length === 0) {
    throw new FileError(
      'E_FILE_PERMISSION',
      `generateCompositeWrapperShim: composite '${spec.compositeName}' has no members`,
      { compositeName: spec.compositeName },
    );
  }
  if (!path.isAbsolute(spec.cliAgentBinPath)) {
    throw new FileError(
      'E_FILE_PERMISSION',
      `generateCompositeWrapperShim: cliAgentBinPath must be absolute (got '${spec.cliAgentBinPath}')`,
      { cliAgentBinPath: spec.cliAgentBinPath },
    );
  }
  if (!path.isAbsolute(spec.capabilityDocPath)) {
    throw new FileError(
      'E_FILE_PERMISSION',
      `generateCompositeWrapperShim: capabilityDocPath must be absolute (got '${spec.capabilityDocPath}')`,
      { capabilityDocPath: spec.capabilityDocPath },
    );
  }

  const warnings = [...detectVersionManager(spec.cliAgentBinPath)];

  const shimText = buildShimText({
    compositeName: spec.compositeName,
    members: spec.members,
    cliAgentBinPath: spec.cliAgentBinPath,
    capabilityDocPath: spec.capabilityDocPath,
    synthesizedAt: spec.synthesizedAt,
    additionalArgs,
  });

  // Ensure the output directory exists at the canonical 0o700 mode.
  try {
    await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new FileError(
      'E_FILE_PERMISSION',
      `generateCompositeWrapperShim: failed to create output directory '${outputDir}': ${(err as Error).message}`,
      { outputDir },
    );
  }

  const finalPath = path.join(outputDir, spec.compositeName);
  const tmpPath = `${finalPath}.tmp`;

  try {
    // Mode is set at creation (research §10) — file never visible
    // without the executable bit.
    await fsp.writeFile(tmpPath, shimText, { encoding: 'utf8', mode: SHIM_MODE });
    await fsp.rename(tmpPath, finalPath);
  } catch (err) {
    // Best-effort cleanup of the tmp file on any failure.
    try {
      await fsp.unlink(tmpPath);
    } catch {
      /* tolerated: nothing to clean up, or already gone */
    }
    throw new FileError(
      'E_FILE_PERMISSION',
      `generateCompositeWrapperShim: failed to write shim '${finalPath}': ${(err as Error).message}`,
      { finalPath, tmpPath },
    );
  }

  // Some filesystems / umask combos can drop the mode on rename;
  // belt-and-braces chmod (no-op on success).
  try {
    await fsp.chmod(finalPath, SHIM_MODE);
  } catch {
    /* tolerated */
  }

  return {
    path: finalPath,
    mode: SHIM_MODE,
    warnings: Object.freeze(warnings),
  };
}

/* ------------------------------------------------------------------ */
/* generatePathSymlink                                                 */
/* ------------------------------------------------------------------ */

/**
 * Create (or refresh) a symlink at `<dir>/<name>` pointing at the
 * given shim path. Used by `--emit-wrapper-on-path` (form b, opt-in).
 *
 * Behaviour:
 *   - Default `dir` is `~/.local/bin`. The directory is created at
 *     mode 0o700 if missing.
 *   - If `<dir>/<name>` is already a symlink to the same shim path,
 *     the call is a no-op (idempotent re-emit).
 *   - If `<dir>/<name>` exists as some other file or a symlink to a
 *     different target:
 *       - When `options.force === true`: the existing entry is
 *         removed and replaced with our symlink. A warning is added
 *         when the previous entry was a regular file.
 *       - Otherwise: a `FileError` is raised (exit 6).
 *   - A warning is added when `<dir>` is not on `$PATH` at synthesis
 *     time — the user opted into PATH publication but the directory
 *     is not actually published.
 */
export async function generatePathSymlink(
  shimPath: string,
  name: string,
  options: PathSymlinkOptions = {},
): Promise<PathSymlinkResult> {
  if (!path.isAbsolute(shimPath)) {
    throw new FileError(
      'E_FILE_PERMISSION',
      `generatePathSymlink: shimPath must be absolute (got '${shimPath}')`,
      { shimPath },
    );
  }
  if (name.length === 0 || name.includes('/') || name.includes('\0')) {
    throw new FileError(
      'E_FILE_PERMISSION',
      `generatePathSymlink: invalid name '${name}'`,
      { name },
    );
  }

  const dir = options.dir ?? path.join(os.homedir(), '.local', 'bin');
  const symlinkPath = path.join(dir, name);
  const warnings: string[] = [];

  // Create the symlink directory with restrictive mode if missing.
  try {
    await fsp.mkdir(dir, { recursive: true, mode: SYMLINK_DIR_MODE });
  } catch (err) {
    throw new FileError(
      'E_FILE_PERMISSION',
      `generatePathSymlink: failed to create symlink directory '${dir}': ${(err as Error).message}`,
      { dir },
    );
  }

  // Inspect existing entry, if any.
  let existing: 'absent' | 'symlink-to-shim' | 'symlink-other' | 'file' = 'absent';
  try {
    const lstat = await fsp.lstat(symlinkPath);
    if (lstat.isSymbolicLink()) {
      const target = await fsp.readlink(symlinkPath);
      const resolved = path.isAbsolute(target) ? target : path.resolve(dir, target);
      existing = resolved === shimPath ? 'symlink-to-shim' : 'symlink-other';
    } else {
      existing = 'file';
    }
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') {
      throw new FileError(
        'E_FILE_PERMISSION',
        `generatePathSymlink: failed to stat '${symlinkPath}': ${e.message}`,
        { symlinkPath },
      );
    }
    // ENOENT — fall through, existing stays 'absent'.
  }

  if (existing === 'symlink-to-shim') {
    // Already correct — nothing to do.
  } else if (existing === 'absent') {
    try {
      await fsp.symlink(shimPath, symlinkPath);
    } catch (err) {
      throw new FileError(
        'E_FILE_PERMISSION',
        `generatePathSymlink: failed to create symlink '${symlinkPath}' → '${shimPath}': ${(err as Error).message}`,
        { symlinkPath, shimPath },
      );
    }
  } else {
    // existing is 'file' or 'symlink-other'.
    if (!options.force) {
      throw new FileError(
        'E_FILE_PERMISSION',
        `generatePathSymlink: '${symlinkPath}' already exists and is not a symlink to '${shimPath}'. ` +
          'Re-run with force=true to overwrite (or use --emit-wrapper-on-path --force).',
        { symlinkPath, shimPath, existing },
      );
    }
    if (existing === 'file') {
      warnings.push(
        `Replaced a non-symlink file at '${symlinkPath}' to publish composite '${name}' on PATH.`,
      );
    }
    try {
      await fsp.unlink(symlinkPath);
      await fsp.symlink(shimPath, symlinkPath);
    } catch (err) {
      throw new FileError(
        'E_FILE_PERMISSION',
        `generatePathSymlink: failed to replace '${symlinkPath}' with symlink to '${shimPath}': ${(err as Error).message}`,
        { symlinkPath, shimPath },
      );
    }
  }

  // PATH-publication advisory.
  const pathEnv = process.env['PATH'] ?? '';
  const pathDirs = pathEnv.split(path.delimiter).filter((p) => p.length > 0);
  // Compare normalised — trailing slashes etc. are tolerated.
  const normalised = path.resolve(dir);
  const onPath = pathDirs.some((p) => path.resolve(p) === normalised);
  if (!onPath) {
    warnings.push(
      `Symlink directory '${dir}' is not on $PATH; the composite '${name}' will not be discoverable as a bare command. ` +
        `Add '${dir}' to your shell rc to enable it.`,
    );
  }

  return {
    symlinkPath,
    warnings: Object.freeze(warnings),
  };
}
