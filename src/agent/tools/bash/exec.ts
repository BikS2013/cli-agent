/**
 * Constrained subprocess spawner.
 *
 * Rules:
 *  - Uses child_process.spawn with explicit argv (never exec with a shell string)
 *  - Env stripping: child inherits ONLY passEnv list; credential-shaped vars stripped
 *  - Per-call timeout with SIGTERM → SIGKILL after 2s
 *  - Output capping per stream
 *  - No TTY allocation
 *  - stdin: static UTF-8 string only (closed after write)
 */

import { spawn } from 'node:child_process';

// Credential-shaped env var patterns — always stripped even if in passEnv
const CREDENTIAL_DENY_PATTERNS = [
  /API_KEY$/i,
  /API_SECRET$/i,
  /ACCESS_TOKEN$/i,
  /SECRET_KEY$/i,
  /PASSWORD$/i,
  /PRIVATE_KEY$/i,
  /MASTER_KEY$/i,
  /AUTH_TOKEN$/i,
  /^AWS_/,
  /^AZURE_/,
  /^GH_TOKEN/,
  /^GITHUB_TOKEN/,
  /^NPM_TOKEN/,
];

// Value shapes that look like credentials
const CREDENTIAL_VALUE_PATTERNS = [
  /^sk-[A-Za-z0-9]{20,}$/,
  /^ghp_[A-Za-z0-9]{36,}$/,
  /^xoxb-/,
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}$/,
];

function isCredentialName(name: string): boolean {
  return CREDENTIAL_DENY_PATTERNS.some((p) => p.test(name));
}

function isCredentialValue(value: string): boolean {
  return CREDENTIAL_VALUE_PATTERNS.some((p) => p.test(value));
}

export interface ExecOptions {
  command: string;
  args: string[];
  cwd?: string;
  stdin?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  passEnv?: string[];
  passSecrets?: string[];
  /** Extra env vars to inject (e.g. PAGER=cat for capability discovery). */
  extraEnv?: Record<string, string>;
}

export interface ExecResult {
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  _truncated?: boolean;
  _orig_stdout_bytes?: number;
  _orig_stderr_bytes?: number;
}

export function spawnCommand(opts: ExecOptions): Promise<ExecResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const timeoutMs = Math.min(opts.timeoutMs ?? 30000, 300000);
    const maxOutputBytes = opts.maxOutputBytes ?? 1024 * 1024;

    // Build child env
    const passEnv = opts.passEnv ?? ['PATH', 'HOME', 'LANG', 'TERM'];
    const passSecrets = opts.passSecrets ?? [];
    const childEnv: Record<string, string> = {};

    for (const key of passEnv) {
      const value = process.env[key];
      if (value !== undefined) {
        if (isCredentialName(key) && !passSecrets.includes(key)) continue;
        if (isCredentialValue(value) && !passSecrets.includes(key)) continue;
        childEnv[key] = value;
      }
    }

    for (const secret of passSecrets) {
      const value = process.env[secret];
      if (value !== undefined) childEnv[secret] = value;
    }

    if (opts.extraEnv) {
      for (const [k, v] of Object.entries(opts.extraEnv)) {
        childEnv[k] = v;
      }
    }

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd ?? process.cwd(),
      env: childEnv,
      shell: false, // NEVER use shell
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutCapped = false;
    let stderrCapped = false;

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - stdoutBytes;
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) stdoutCapped = true;
      } else {
        stdoutCapped = true;
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes < maxOutputBytes) {
        const remaining = maxOutputBytes - stderrBytes;
        stderrChunks.push(chunk.subarray(0, remaining));
        stderrBytes += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) stderrCapped = true;
      } else {
        stderrCapped = true;
      }
    });

    if (opts.stdin) {
      child.stdin.write(opts.stdin, 'utf8');
    }
    child.stdin.end();

    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* tolerated */ }
      }, 2000);
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;

      let stdout = Buffer.concat(stdoutChunks).toString('utf8');
      let stderr = Buffer.concat(stderrChunks).toString('utf8');

      if (stdoutCapped) stdout += '\n…TRUNCATED';
      if (stderrCapped) stderr += '\n…TRUNCATED';

      const truncated = stdoutCapped || stderrCapped;

      resolve({
        command: opts.command,
        args: opts.args,
        stdout,
        stderr,
        exitCode: killed ? -1 : (code ?? 0),
        durationMs,
        ...(truncated ? { _truncated: true } : {}),
        ...(stdoutCapped ? { _orig_stdout_bytes: stdoutBytes } : {}),
        ...(stderrCapped ? { _orig_stderr_bytes: stderrBytes } : {}),
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        command: opts.command,
        args: opts.args,
        stdout: '',
        stderr: err.message,
        exitCode: 1,
        durationMs: Date.now() - start,
      });
    });
  });
}
