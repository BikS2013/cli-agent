/**
 * LLM I/O capture channel (JSONL) for cli-agent — the parallel, additive
 * diagnostic surface behind the `--inspect-io` switch.
 *
 * This module is a sibling of (NOT an extension of) the operational logger in
 * `./logging.ts`. It writes the EXACT provider-normalized request (assembled
 * system prompt + full in-thread memory + current user content + bound tool /
 * function JSON schemas) and the EXACT response (assistant text + parsed
 * tool-calls + tool results) for every LLM turn to its own store:
 *
 *   ~/.tool-agents/cli-agent/io-captures/session-<UTC>-<sessionId>.jsonl
 *   ~/.tool-agents/cli-agent/io-captures/latest.jsonl  (symlink or copy-skip)
 *
 * Permissions: directory 0700, files 0600 (mirrors FileLogger).
 * Off-state: `cfg.inspectIo === null` → `NullIoCapture` (does literally nothing).
 * Field cap: 64 KiB per string field; truncated fields set `_truncated:true`
 *   plus `_orig_size_bytes` (mirrors logging.ts `truncateEvent`).
 * Redaction: ON by default — message `content` via `redactString`, tool-call
 *   `args` / `result` via `redactObject`. Skipped only when `redact === false`,
 *   in which case `createIoCapture` emits a one-line stderr warning BEFORE the
 *   file is opened.
 *
 * No new runtime dependency: bound tool schemas are serialized with
 * `convertToOpenAITool` from `@langchain/core/utils/function_calling` (already
 * installed). `zod-to-json-schema` is verified ABSENT on disk and MUST NOT be
 * imported.
 */

import fs from 'node:fs';
import path from 'node:path';
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { BaseMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import { redactString, redactObject } from '../util/redact.js';
import { ConfigurationError } from '../errors.js';
import type { AgentConfig } from '../config/agent-config.js';

/**
 * 64 KiB per-string-field cap. Replicated from `logging.ts`'s
 * `FIELD_TRUNCATE_BYTES` (which is module-private there); the capture channel
 * deliberately mirrors that discipline so both stores truncate identically.
 */
const FIELD_TRUNCATE_BYTES = 64 * 1024;

/** One normalized message in a captured request. */
export interface CapturedMessage {
  role: 'system' | 'human' | 'ai' | 'tool' | string;
  content: string;
  toolCalls?: Array<{ id?: string; name: string; args: unknown }>;
  toolCallId?: string; // present for tool messages
}

/** Serialized bound tool/function schema (FR-3d), OpenAI-normalized. */
export interface BoundToolSchema {
  name: string;
  description: string;
  parameters: unknown; // JSON Schema (convertToOpenAITool .function.parameters)
}

/** Shared correlation envelope for every record. */
export interface IoCaptureEnvelope {
  sessionId: string;
  threadId: string;
  turnId: string;
  stepIndex: number;
  ts: string; // ISO-8601 UTC
}

export type IoCaptureRecord =
  | (IoCaptureEnvelope & {
      kind: 'request';
      messages: CapturedMessage[];
      boundTools?: BoundToolSchema[]; // only on stepIndex === 0
    })
  | (IoCaptureEnvelope & {
      kind: 'response';
      finalText: string;
      toolCalls: Array<{ id?: string; name: string; args: unknown }>;
    })
  | (IoCaptureEnvelope & {
      kind: 'tool_result';
      toolName: string;
      ok: boolean;
      durationMs: number;
      result?: unknown;
    });

/** Input to captureRequest — the record minus its discriminant `kind`. */
export type RequestInput = Omit<Extract<IoCaptureRecord, { kind: 'request' }>, 'kind'>;
export type ResponseInput = Omit<Extract<IoCaptureRecord, { kind: 'response' }>, 'kind'>;
export type ToolResultInput = Omit<Extract<IoCaptureRecord, { kind: 'tool_result' }>, 'kind'>;

/** Parallel capture channel — mirrors the Logger interface in logging.ts. */
export interface IoCapture {
  /** Bound tool schemas captured once at construction (turn-invariant). */
  readonly boundToolSchemas: ReadonlyArray<BoundToolSchema>;
  readonly currentSessionId: string;
  readonly currentCapturePath: string; // '' for NullIoCapture
  captureRequest(rec: RequestInput): void;
  captureResponse(rec: ResponseInput): void;
  captureToolResult(rec: ToolResultInput): void;
  /** In-memory record list for /inspect show (no disk re-read). */
  read(): IoCaptureRecord[];
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a LangChain `BaseMessage` to a `CapturedMessage`.
 *
 * `role`    ← `m._getType?.() ?? m.role ?? 'msg'`.
 * `content` ← string as-is; content-block array → keep `type === 'text'`
 *             blocks, map `.text`, join; otherwise ''.
 * `toolCalls` ← present only when `m.tool_calls` is a non-empty array.
 * `toolCallId` ← present only when `m.tool_call_id` is set (tool messages).
 */
export function toCaptureMessage(m: BaseMessage): CapturedMessage {
  // The LangChain message surface we read (`_getType`, `content`,
  // `tool_calls`, `tool_call_id`) is not fully expressed on the public
  // `BaseMessage` type, so we read through a permissive view.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mm = m as any;
  const role: string = mm._getType?.() ?? mm.role ?? 'msg';
  let content = '';
  if (typeof mm.content === 'string') {
    content = mm.content;
  } else if (Array.isArray(mm.content)) {
    content = mm.content
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .filter((c: any) => c?.type === 'text')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((c: any) => c?.text ?? '')
      .join('');
  }
  const out: CapturedMessage = { role, content };
  if (Array.isArray(mm.tool_calls) && mm.tool_calls.length > 0) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    out.toolCalls = mm.tool_calls.map((tc: any) => ({ id: tc.id, name: tc.name, args: tc.args }));
  }
  if (mm.tool_call_id) {
    out.toolCallId = mm.tool_call_id as string;
  }
  return out;
}

/**
 * Defensively flatten `on_chat_model_start.data.input` into a `BaseMessage[]`.
 *
 * Covers the three documented shapes (research Q2): a bare `BaseMessage[]`, an
 * `{ messages: BaseMessage[] }` object, and an `{ messages: BaseMessage[][] }`
 * (array-of-arrays) object. Anything else yields `[]`.
 */
export function extractStartMessages(input: unknown): BaseMessage[] {
  if (Array.isArray(input)) {
    return (input as unknown[]).flat() as BaseMessage[];
  }
  if (input && typeof input === 'object' && 'messages' in input) {
    const m = (input as { messages: unknown }).messages;
    if (Array.isArray(m)) {
      return (m as unknown[]).flat() as BaseMessage[];
    }
  }
  return [];
}

/**
 * Serialize the bound toolset exactly as the model sees it (OpenAI-normalized).
 *
 * Uses `convertToOpenAITool` from `@langchain/core/utils/function_calling` —
 * the same helper the OpenAI/Azure adapters use — so the `parameters` JSON
 * Schema is the highest-fidelity provider-neutral artifact available with no
 * new dependency. `zod-to-json-schema` MUST NOT be imported (absent on disk).
 */
export function captureBoundToolSchemas(tools: DynamicStructuredTool[]): BoundToolSchema[] {
  return tools.map((t) => {
    const def = convertToOpenAITool(t); // { type:'function', function:{ name, description?, parameters } }
    return {
      name: def.function.name,
      description: def.function.description ?? '',
      parameters: def.function.parameters, // JSON Schema
    };
  });
}

// ---------------------------------------------------------------------------
// Internal: filename + field-cap helpers (mirror logging.ts)
// ---------------------------------------------------------------------------

/** `session-<UTC>-<sessionId>.jsonl` — identical format to FileLogger. */
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

/**
 * Deep-cap every string in `value` to `FIELD_TRUNCATE_BYTES`. Mirrors the
 * `truncateEvent` discipline (logging.ts:64-82) but walks nested structures
 * because capture records carry strings inside `messages[].content`, tool-call
 * `args`, and `result` — not only at the top level. Records the original byte
 * size of each truncated string keyed by a dotted path so the top-level marker
 * (`_truncated` / `_orig_size_bytes`) stays consistent with the logger's shape.
 */
function deepTruncate(
  value: unknown,
  pathKey: string,
  origSizes: Record<string, number>,
): unknown {
  if (typeof value === 'string') {
    const size = byteSize(value);
    if (size > FIELD_TRUNCATE_BYTES) {
      origSizes[pathKey] = size;
      return Buffer.from(value, 'utf8').subarray(0, FIELD_TRUNCATE_BYTES).toString('utf8');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v, i) => deepTruncate(v, `${pathKey}[${i}]`, origSizes));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = deepTruncate(v, pathKey ? `${pathKey}.${k}` : k, origSizes);
    }
    return out;
  }
  return value;
}

/**
 * Redact a `CapturedMessage` in place-equivalent (returns a new object):
 * message `content` through `redactString`, tool-call `args` through
 * `redactObject` (research best-practice 7 — secrets can ride in either).
 */
function redactMessage(msg: CapturedMessage): CapturedMessage {
  const out: CapturedMessage = {
    ...msg,
    content: redactString(msg.content),
  };
  if (msg.toolCalls) {
    out.toolCalls = msg.toolCalls.map((tc) => ({ ...tc, args: redactObject(tc.args) }));
  }
  return out;
}

/**
 * Apply redaction to a record's secret-bearing fields. Message `content` and
 * every tool-call `args` go through the redactors; the `tool_result` `result`
 * payload (which can echo command output containing tokens) goes through
 * `redactObject`.
 */
function redactRecord(rec: IoCaptureRecord): IoCaptureRecord {
  switch (rec.kind) {
    case 'request':
      return {
        ...rec,
        messages: rec.messages.map(redactMessage),
      };
    case 'response':
      return {
        ...rec,
        finalText: redactString(rec.finalText),
        toolCalls: rec.toolCalls.map((tc) => ({ ...tc, args: redactObject(tc.args) })),
      };
    case 'tool_result':
      return {
        ...rec,
        result: rec.result === undefined ? undefined : redactObject(rec.result),
      };
    default:
      return rec;
  }
}

// ---------------------------------------------------------------------------
// File-backed capture
// ---------------------------------------------------------------------------

/**
 * File-backed capture — mirrors FileLogger (0600 file via
 * `O_WRONLY|O_CREAT|O_APPEND`, `latest.jsonl` symlink with copy-skip fallback,
 * 64 KiB truncation, redaction, local write-error swallow). Keeps an in-memory
 * `IoCaptureRecord[]` so `read()` serves `/inspect show` without re-parsing disk.
 */
export class FileIoCapture implements IoCapture {
  public readonly boundToolSchemas: ReadonlyArray<BoundToolSchema>;
  public readonly currentSessionId: string;
  public readonly currentCapturePath: string;
  private readonly redact: boolean;
  private readonly records: IoCaptureRecord[] = [];
  private fd: number | null = null;

  public constructor(opts: {
    dir: string;
    sessionId: string;
    redact: boolean;
    boundToolSchemas: ReadonlyArray<BoundToolSchema>;
  }) {
    this.currentSessionId = opts.sessionId;
    this.redact = opts.redact;
    this.boundToolSchemas = opts.boundToolSchemas;

    // Ensure the capture dir exists at 0700 (mirrors createLogger). A failure
    // here is a hard configuration error — the inspector was explicitly
    // requested, so there is NO fallback to a disabled/no-op channel.
    try {
      fs.mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(opts.dir, 0o700);
      } catch {
        /* tolerated (e.g. Windows / pre-existing) */
      }
    } catch (err) {
      throw new ConfigurationError('inspectIo.dir', [`directory '${opts.dir}'`], {
        reason: 'capture directory could not be created',
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    const filename = formatSessionFilename(new Date(), opts.sessionId);
    const capturePath = path.join(opts.dir, filename);
    const latestPath = path.join(opts.dir, 'latest.jsonl');
    this.currentCapturePath = capturePath;

    // Open the session file 0600 (mirrors FileLogger.open). A failure here is
    // likewise a hard configuration error (no fallback).
    try {
      this.fd = fs.openSync(
        capturePath,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND,
        0o600,
      );
      try {
        fs.fchmodSync(this.fd, 0o600);
      } catch {
        /* tolerated on Windows */
      }
    } catch (err) {
      throw new ConfigurationError('inspectIo.dir', [`file '${capturePath}'`], {
        reason: 'capture file could not be opened for writing',
        cause: err instanceof Error ? err.message : String(err),
      });
    }

    // Update latest.jsonl (symlink, or copy-skip fallback on platforms that
    // reject symlinks) — mirrors createLogger exactly.
    try {
      try {
        fs.unlinkSync(latestPath);
      } catch {
        /* ignore if missing */
      }
      fs.symlinkSync(filename, latestPath);
    } catch {
      // Fallback: skip the symlink (copy-on-close is not practical).
    }
  }

  public captureRequest(rec: RequestInput): void {
    this.write({ kind: 'request', ...rec });
  }

  public captureResponse(rec: ResponseInput): void {
    this.write({ kind: 'response', ...rec });
  }

  public captureToolResult(rec: ToolResultInput): void {
    this.write({ kind: 'tool_result', ...rec });
  }

  public read(): IoCaptureRecord[] {
    return this.records.slice();
  }

  public async close(): Promise<void> {
    if (this.fd === null) return;
    const fd = this.fd;
    this.fd = null;
    try {
      fs.closeSync(fd);
    } catch {
      /* tolerated */
    }
  }

  /**
   * Serialize one record and append it as a single JSONL line, then push the
   * (un-serialized) record into the in-memory mirror for `read()`.
   *
   * Pipeline: deep-truncate every string field over 64 KiB (setting the
   * `_truncated` / `_orig_size_bytes` markers) → (unless `redact === false`)
   * redact message `content` and tool-call `args` / `result` →
   * `JSON.stringify` + '\n' → `fs.writeSync` inside a local try/catch that
   * SWALLOWS write errors (capture must never break the agent — mirrors
   * FileLogger.log).
   */
  private write(record: IoCaptureRecord): void {
    // Always keep the raw record for the in-TUI renderer, regardless of write
    // outcome (the renderer applies its own truncation; redaction of the
    // on-disk artifact does not retroactively change the live in-memory copy).
    this.records.push(record);

    if (this.fd === null) return;

    // 1) Field cap (64 KiB) — deep walk, top-level marker.
    const origSizes: Record<string, number> = {};
    const capped = deepTruncate(record, '', origSizes) as IoCaptureRecord;
    const truncated = Object.keys(origSizes).length > 0;

    // 2) Redaction (default ON).
    const redacted = this.redact ? redactRecord(capped) : capped;

    // 3) Attach truncation markers at the record top level (mirrors logging.ts).
    const payload: Record<string, unknown> = { ...(redacted as unknown as Record<string, unknown>) };
    if (truncated) {
      payload['_truncated'] = true;
      payload['_orig_size_bytes'] = origSizes;
    }

    let line: string;
    try {
      line = JSON.stringify(payload) + '\n';
    } catch {
      line =
        JSON.stringify({
          kind: 'error',
          ts: new Date().toISOString(),
          sessionId: this.currentSessionId,
          code: 'E_IO_CAPTURE_SERIALIZATION',
          message: `Failed to serialize io-capture record of kind=${record.kind}`,
        }) + '\n';
    }
    try {
      fs.writeSync(this.fd, line);
    } catch {
      /* swallow — capture must never break the agent */
    }
  }
}

// ---------------------------------------------------------------------------
// No-op capture (off-state)
// ---------------------------------------------------------------------------

/**
 * No-op capture — the ONLY instance used when the switch is off (NFR-1).
 * Does literally nothing: no file/dir side-effects, empty schemas, empty reads.
 */
export class NullIoCapture implements IoCapture {
  public readonly boundToolSchemas: ReadonlyArray<BoundToolSchema> = [];
  public readonly currentSessionId = 'disabled';
  public readonly currentCapturePath = '';
  public captureRequest(_rec: RequestInput): void {
    /* no-op */
  }
  public captureResponse(_rec: ResponseInput): void {
    /* no-op */
  }
  public captureToolResult(_rec: ToolResultInput): void {
    /* no-op */
  }
  public read(): IoCaptureRecord[] {
    return [];
  }
  public async close(): Promise<void> {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Factory — mirrors `createLogger`. Returns `NullIoCapture` when
 * `cfg.inspectIo === null` (the legitimate off-state — NOT an error).
 * Otherwise serializes the bound tool schemas, emits a prominent one-line
 * stderr warning BEFORE opening the file when `cfg.inspectIo.redact === false`
 * (so plaintext-secret risk is surfaced before any unredacted byte is written),
 * and returns a `FileIoCapture`. A directory/file that cannot be created or
 * opened raises `ConfigurationError` (no fallback to `NullIoCapture`).
 */
export function createIoCapture(
  cfg: AgentConfig,
  sessionId: string,
  tools: DynamicStructuredTool[],
): IoCapture {
  if (cfg.inspectIo === null) {
    return new NullIoCapture();
  }

  const boundToolSchemas = captureBoundToolSchemas(tools);

  if (cfg.inspectIo.redact === false) {
    process.stderr.write(
      `[cli-agent] WARNING: --inspect-io-raw is set — I/O captures are written WITHOUT redaction; ` +
        `secrets/API keys in the system prompt, memory, or tool args will be stored in plaintext under ` +
        `${cfg.inspectIo.dir}.\n`,
    );
  }

  return new FileIoCapture({
    dir: cfg.inspectIo.dir,
    sessionId,
    redact: cfg.inspectIo.redact,
    boundToolSchemas,
  });
}
