/**
 * Structured event logger (JSONL) for cli-agent.
 *
 * Storage:
 *   ~/.tool-agents/cli-agent/logs/session-<UTC>-<sessionId>.jsonl
 *   ~/.tool-agents/cli-agent/logs/latest.jsonl  (symlink or copy)
 *
 * Permissions: directory 0700, files 0600.
 * Disabled: set CLI_AGENT_LOG=off|0|false|no in env.
 * Field cap: 64 KiB per string field; truncated fields get _truncated:true.
 * All writes are redacted via redactString.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactString } from '../util/redact.js';

export type LogEvent =
  | { kind: 'session_start'; ts: string; sessionId: string; threadId: string; provider: string; model: string; allowMutations: boolean; cliVersion: string }
  | { kind: 'session_end'; ts: string; sessionId: string; reason: 'quit' | 'crash' | 'sigint' }
  | { kind: 'user_prompt'; ts: string; sessionId: string; turnId: string; prompt: string }
  | { kind: 'llm_chunk'; ts: string; sessionId: string; turnId: string; messageType: string; content: string; toolCalls?: ReadonlyArray<{ id?: string; name: string; args: unknown }> }
  | { kind: 'llm_final'; ts: string; sessionId: string; turnId: string; finalText: string; toolCallsObserved: ReadonlyArray<{ name: string; args: unknown }> }
  | { kind: 'tool_call'; ts: string; sessionId: string; turnId: string; toolName: string; args: unknown }
  | { kind: 'tool_result'; ts: string; sessionId: string; turnId: string; toolName: string; result: unknown; durationMs: number }
  | { kind: 'cli_invoke'; ts: string; sessionId: string; turnId: string; binary: string; argv: ReadonlyArray<string>; cwd: string }
  | { kind: 'cli_result'; ts: string; sessionId: string; turnId: string; binary: string; exitCode: number; durationMs: number; stdoutPreview: string; stderrPreview: string }
  | { kind: 'error'; ts: string; sessionId: string; turnId?: string; code: string; message: string; details?: unknown };

export interface Logger {
  log(event: LogEvent): void;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly currentLogPath: string;
  readonly currentSessionId: string;
}

export interface LoggerOptions {
  readonly toolDir: string;
  readonly sessionId?: string;
  readonly enabled?: boolean;
}

const FIELD_TRUNCATE_BYTES = 64 * 1024;
const CLI_VERSION = '0.1.0';

export { CLI_VERSION };

function formatSessionFilename(d: Date, sessionId: string): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  const ts =
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`;
  return `session-${ts}-${sessionId}.jsonl`;
}

function byteSize(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function truncateEvent(event: LogEvent): { event: Record<string, unknown>; truncated: boolean; origSizes: Record<string, number> } {
  const out: Record<string, unknown> = { ...(event as unknown as Record<string, unknown>) };
  const origSizes: Record<string, number> = {};
  let truncated = false;

  for (const [k, v] of Object.entries(out)) {
    if (typeof v === 'string') {
      const size = byteSize(v);
      if (size > FIELD_TRUNCATE_BYTES) {
        truncated = true;
        origSizes[k] = size;
        const buf = Buffer.from(v, 'utf8').subarray(0, FIELD_TRUNCATE_BYTES);
        out[k] = buf.toString('utf8');
      }
    }
  }

  return { event: out, truncated, origSizes };
}

class FileLogger implements Logger {
  public readonly currentLogPath: string;
  public readonly currentSessionId: string;
  private fd: number | null = null;

  public constructor(opts: { logPath: string; sessionId: string }) {
    this.currentLogPath = opts.logPath;
    this.currentSessionId = opts.sessionId;
  }

  public log(event: LogEvent): void {
    if (this.fd === null) return;
    const { event: e, truncated, origSizes } = truncateEvent(event);
    const payload: Record<string, unknown> = e;
    if (truncated) {
      payload['_truncated'] = true;
      payload['_orig_size_bytes'] = origSizes;
    }
    let line: string;
    try {
      line = redactString(JSON.stringify(payload)) + '\n';
    } catch {
      line = JSON.stringify({
        kind: 'error',
        ts: new Date().toISOString(),
        sessionId: this.currentSessionId,
        code: 'E_LOG_SERIALIZATION',
        message: `Failed to serialize event of kind=${(event as { kind?: string }).kind ?? 'unknown'}`,
      }) + '\n';
    }
    try {
      fs.writeSync(this.fd, line);
    } catch { /* swallow — logging must never break the agent */ }
  }

  public async flush(): Promise<void> {
    if (this.fd === null) return;
    try { fs.fsyncSync(this.fd); } catch { /* tolerated */ }
  }

  public async close(): Promise<void> {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try { fs.closeSync(fd); } catch { /* tolerated */ }
  }

  public open(): void {
    this.fd = fs.openSync(
      this.currentLogPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
      0o600,
    );
    try { fs.fchmodSync(this.fd, 0o600); } catch { /* tolerated on Windows */ }
  }
}

class NullLogger implements Logger {
  public readonly currentLogPath = '/dev/null';
  public readonly currentSessionId = 'disabled';
  public log(_event: LogEvent): void { /* no-op */ }
  public async flush(): Promise<void> { /* no-op */ }
  public async close(): Promise<void> { /* no-op */ }
}

export function createLogger(opts: LoggerOptions): Logger {
  if (opts.enabled === false) return new NullLogger();

  const sessionId = opts.sessionId ?? (Date.now().toString(36) + randomUUID().slice(0, 8));
  const logsDir = path.join(opts.toolDir, 'logs');

  // Ensure logs dir exists
  try {
    fs.mkdirSync(logsDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(logsDir, 0o700); } catch { /* tolerated */ }
  } catch { /* tolerated if exists */ }

  const filename = formatSessionFilename(new Date(), sessionId);
  const logPath = path.join(logsDir, filename);
  const latestPath = path.join(logsDir, 'latest.jsonl');

  const logger = new FileLogger({ logPath, sessionId });
  logger.open();

  // Update latest.jsonl symlink (or copy on platforms that reject symlinks)
  try {
    try { fs.unlinkSync(latestPath); } catch { /* ignore if missing */ }
    fs.symlinkSync(filename, latestPath);
  } catch {
    // Fallback: copy-on-close is not practical; just skip the symlink
  }

  return logger;
}

export function nullLogger(): Logger {
  return new NullLogger();
}

/** Generate a fresh turn ID for each LLM round-trip. */
export function newTurnId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
