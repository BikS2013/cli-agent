/**
 * Three-tier ripgrep probe + spawn helper.
 *
 * Probe order (per `docs/research/ripgrep-distribution-strategy.md` §3):
 *   1. `which rg` (PATH probe) — POSIX `which`, Windows `where`.
 *   2. `import('@vscode/ripgrep')` dynamic — captures `rgPath`.
 *   3. None — caller must fall back to `_shared/jsfallback.ts`.
 *
 * The probe runs at most once per process: the resulting Promise is
 * cached at module scope.
 *
 * `runRipgrep` spawns the resolved binary with stdio piped, captures
 * stdout/stderr as utf-8 strings, surfaces non-zero exit codes as data
 * (NOT thrown), and signals binary-missing via a {@link ToolExecutionError}
 * with `code === 'RIPGREP_UNAVAILABLE'` so callers know to take the
 * JS fallback path.
 */
'use strict';

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

import { ToolExecutionError } from '../../errors.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RipgrepProbeResult {
  /** True when a usable ripgrep binary was found. */
  readonly available: boolean;
  /** Resolved absolute path to the binary, or null if unavailable. */
  readonly binaryPath: string | null;
  /** Origin of the binary. */
  readonly source: 'path' | 'bundled' | 'none';
}

export interface RunRipgrepOptions {
  /** Working directory passed to `child_process.spawn`. */
  readonly cwd: string;
  /** Optional cancellation signal. */
  readonly signal?: AbortSignal;
  /** Wall-clock timeout for the spawn. Default: 30_000 ms. */
  readonly timeoutMs?: number;
}

export interface RunRipgrepResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;

let _probeCache: Promise<RipgrepProbeResult> | null = null;

/**
 * Resolve a usable ripgrep binary, or report that none is available.
 * The probe runs once per process; subsequent calls return the cached
 * Promise.
 */
export function probeRipgrep(): Promise<RipgrepProbeResult> {
  if (_probeCache !== null) return _probeCache;
  _probeCache = doProbe();
  return _probeCache;
}

/**
 * Test seam: clears the cached probe so a subsequent call re-runs the
 * detection. Internal — not exposed via the package barrel.
 */
export function __resetProbeCacheForTesting(): void {
  _probeCache = null;
}

async function doProbe(): Promise<RipgrepProbeResult> {
  // Tier 1: PATH probe.
  const fromPath = await tryWhich();
  if (fromPath !== null) {
    return { available: true, binaryPath: fromPath, source: 'path' };
  }

  // Tier 2: @vscode/ripgrep optionalDependency.
  const fromBundle = await tryBundled();
  if (fromBundle !== null) {
    return { available: true, binaryPath: fromBundle, source: 'bundled' };
  }

  // Tier 3: none.
  return { available: false, binaryPath: null, source: 'none' };
}

function tryWhich(): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    let stdout = '';
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const child = spawn(cmd, ['rg'], { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => {
        if (code === 0) {
          const first = stdout.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
          finish(first ?? null);
        } else {
          finish(null);
        }
      });
    } catch {
      finish(null);
    }
  });
}

async function tryBundled(): Promise<string | null> {
  try {
    // Use createRequire so resolution honours pnpm/yarn-symlinks.
    const require = createRequire(import.meta.url);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('@vscode/ripgrep') as { rgPath?: unknown } | undefined;
    if (mod && typeof mod.rgPath === 'string' && mod.rgPath.length > 0) {
      return mod.rgPath;
    }
    return null;
  } catch {
    // Module not installed — fall through.
    return null;
  }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Spawn ripgrep with the supplied args. Honours AbortSignal and a
 * timeout; reports non-zero exits as data on the result object.
 *
 * If no binary was found, throws a {@link ToolExecutionError} with
 * `code === 'RIPGREP_UNAVAILABLE'`.
 */
export async function runRipgrep(
  args: readonly string[],
  opts: RunRipgrepOptions,
): Promise<RunRipgrepResult> {
  const probe = await probeRipgrep();
  if (!probe.available || probe.binaryPath === null) {
    throw new ToolExecutionError('ripgrep is not available', {
      code: 'RIPGREP_UNAVAILABLE',
    });
  }
  const bin = probe.binaryPath;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<RunRipgrepResult>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    let child;
    try {
      child = spawn(bin, [...args], { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(
        new ToolExecutionError(`Failed to spawn ripgrep at ${bin}`, {
          cause: err,
          code: 'RIPGREP_SPAWN_FAILED',
        }),
      );
      return;
    }

    const onAbort = (): void => {
      if (settled) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }
    }

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => {
      stdout += c;
    });
    child.stderr.on('data', (c: string) => {
      stderr += c;
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      reject(
        new ToolExecutionError(`ripgrep child process emitted error`, {
          cause: err,
          code: 'RIPGREP_CHILD_ERROR',
        }),
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode: typeof code === 'number' ? code : -1 });
    });
  });
}
