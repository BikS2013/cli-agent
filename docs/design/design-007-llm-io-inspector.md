---
status: complete
design_number: 007
slug: llm-io-inspector
request_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/refined-request-llm-io-inspector.md
plan_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/plan-007-llm-io-inspector.md
investigation_file: null
research_files:
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/research/langgraph-streamevents-io-capture.md
codebase_scan_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/codebase-scan-llm-io-inspector.md
based_on_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
units_changed_from_plan: true
implementation_units:
  - name: Unit A — Config wiring + CLI flags
    plan_steps: [1, 2, 16]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/config/agent-config.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/cli.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/test_scripts/baselines/help-no-treat-as-tool.txt
    exposes:
      - AgentConfig.inspectIo
      - AgentCliFlags.inspectIo
      - AgentCliFlags.inspectIoRaw
      - AgentConfigFile.inspectIo
      - agentIoCapturesDir
      - CLI_AGENT_INSPECT_IO
      - CLI_AGENT_INSPECT_IO_RAW
    consumes: []
  - name: Unit B — Capture core (IoCapture channel)
    plan_steps: [3, 4]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/io-capture.ts
    exposes:
      - IoCapture
      - IoCaptureRecord
      - CapturedMessage
      - BoundToolSchema
      - createIoCapture
      - NullIoCapture
      - FileIoCapture
      - toCaptureMessage
      - extractStartMessages
      - captureBoundToolSchemas
    consumes:
      - AgentConfig.inspectIo
      - agentIoCapturesDir
  - name: Unit C — Graph + runner hooks
    plan_steps: [5, 6, 7]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/graph.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/run.ts
    exposes:
      - StreamOneShotOptions.ioCapture
      - runOneShot.captureOpts
      - TuiAgentRuntime.ioCapture
    consumes:
      - IoCapture
      - createIoCapture
      - toCaptureMessage
      - extractStartMessages
      - AgentConfig.inspectIo
  - name: Unit D — TUI controller + /inspect slash
    plan_steps: [8, 9, 10]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/tui/controller.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/tui/slash/inspect.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/tui/index.ts
    exposes:
      - TuiControllerOptions.ioCapture
      - TuiController.ioCapture
      - inspectCmd
    consumes:
      - IoCapture
      - IoCaptureRecord
      - TuiAgentRuntime.ioCapture
      - StreamOneShotOptions.ioCapture
  - name: Unit E — Tests
    plan_steps: [11, 12, 13, 14, 15]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/io-capture.spec.ts
    exposes: []
    consumes:
      - IoCapture
      - IoCaptureRecord
      - createIoCapture
      - NullIoCapture
      - FileIoCapture
      - toCaptureMessage
      - extractStartMessages
      - captureBoundToolSchemas
      - AgentConfig.inspectIo
  - name: Unit F — Documentation
    plan_steps: [17, 18, 19, 20]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/tools/cli-agent.md
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/project-functions.md
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/project-design.md
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/configuration-guide.md
    exposes: []
    consumes: []
  - name: Unit G — Full verification
    plan_steps: [21]
    files: []
    exposes: []
    consumes: []
files_to_create:
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/io-capture.ts
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/io-capture.spec.ts
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/tui/slash/inspect.ts
files_to_modify:
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/config/agent-config.ts
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/cli.ts
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/graph.ts
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/run.ts
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/tui/controller.ts
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/tui/index.ts
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/test_scripts/baselines/help-no-treat-as-tool.txt
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/tools/cli-agent.md
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/project-functions.md
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/project-design.md
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/configuration-guide.md
decisions: 11
created_at: 2026-06-13T00:00:00Z
---

# Design 007 — LLM I/O Inspector (a switch that records the exact tool↔LLM conversation)

## Objective
Add a diagnostic LLM I/O inspector to `@biks2013/cli-agent`: a switch (`--inspect-io` / `--inspect-io-raw` CLI flags plus an in-TUI `/inspect on|off|show [turn]|status` slash command) that, when enabled, captures the EXACT provider-normalized request (assembled system prompt + full in-thread memory + current user content + bound tool/function JSON schemas) and the EXACT response (assistant text + parsed tool-calls + tool results) for every LLM turn, writing them incrementally to a tailable JSONL file under `~/.tool-agents/cli-agent/io-captures/` and rendering any completed turn on demand inside the TUI. The capture is a dedicated, parallel, additive channel. When the switch is off, the system prompt, provider payloads, streamed output, the operational `logs/` JSONL, transcript files, and `--help` output remain byte-identical to `master` (NFR-1). This design serves plan-007 and the refined request (FR-1..FR-12, NFR-1..NFR-6, AC-1..AC-11), honoring all 7 resolved Open Questions and the orchestrator's NEW-INTEGRATION-POINT directive verbatim.

## Architecture

### Component diagram

```
                         CLI / env / config.json
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  src/config/agent-config.ts  (Unit A)                             │
   │   AgentCliFlags.inspectIo / inspectIoRaw                          │
   │   AgentConfigFile.inspectIo {enabled?,redact?,dir?}              │
   │   loadAgentConfig → AgentConfig.inspectIo : {enabled;redact;dir} │
   │                                            | null   (off=null)   │
   │   agentIoCapturesDir()  ·  bootstrapAgentDir (mkdir 0700)        │
   │   CLI_AGENT_INSPECT_IO / CLI_AGENT_INSPECT_IO_RAW in ALL_ENV_KEYS│
   └───────────────────────────────┬──────────────────────────────────┘
                                    │ cfg.inspectIo
                                    ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  src/agent/io-capture.ts  (Unit B)  — PARALLEL CHANNEL           │
   │   interface IoCapture          (mirrors Logger)                   │
   │   class FileIoCapture          (mirrors FileLogger)              │
   │   class NullIoCapture          (mirrors NullLogger; off-state)   │
   │   createIoCapture(cfg,sid,tools)  (mirrors createLogger)         │
   │   helpers: toCaptureMessage · extractStartMessages ·            │
   │            captureBoundToolSchemas (convertToOpenAITool)         │
   │   reuses redact.ts · FIELD_TRUNCATE_BYTES · 0700/0600 · latest  │
   └───────────────────────────────┬──────────────────────────────────┘
                                    │ injected instance
            ┌───────────────────────┴────────────────────────┐
            ▼                                                 ▼
   ┌─────────────────────────────────┐        ┌──────────────────────────────┐
   │ src/agent/graph.ts  (Unit C)    │        │ src/agent/run.ts  (Unit C)   │
   │  StreamOneShotOptions.ioCapture │        │  streamOneShotAgent →        │
   │  streamEvents hooks:            │        │    createIoCapture + thread  │
   │   on_chat_model_start → REQUEST │◀───────│    into streamOneShot opts   │
   │   on_chat_model_end   → RESPONSE│        │  runOneShotAgent → invoke    │
   │   on_tool_end         → RESULT  │        │  buildTuiAgentRuntime →      │
   │  runOneShot(opts) ← invoke path │        │    TuiAgentRuntime.ioCapture │
   └─────────────────────────────────┘        └───────────────┬──────────────┘
                                                               │ runtime.ioCapture
                                                               ▼
                                          ┌──────────────────────────────────────┐
                                          │ src/tui/index.ts (Unit D) startTui    │
                                          │  new TuiController({ ioCapture })     │
                                          │  import './slash/inspect.js'          │
                                          └──────────────────┬────────────────────┘
                                                             ▼
                          ┌──────────────────────────────────────────────────────┐
                          │ src/tui/controller.ts (Unit D)                         │
                          │  TuiControllerOptions.ioCapture · field · runTurn     │
                          │  streamOneShot opts += ioCapture · makeSlashContext   │
                          └──────────────────┬─────────────────────────────────────┘
                                             │ ctx.controller.ioCapture
                                             ▼
                          ┌──────────────────────────────────────────────────────┐
                          │ src/tui/slash/inspect.ts (Unit D)  /inspect command   │
                          │  status · show [turn] · on · off                      │
                          │  reads ioCapture.read(); renders via println/printSys │
                          └──────────────────────────────────────────────────────┘

   On-disk surface:  ~/.tool-agents/cli-agent/io-captures/
                       session-<UTC>-<sessionId>.jsonl   (0600)
                       latest.jsonl  → relative symlink (copy-skip fallback)
```

### Responsibilities and landing locations

| Component | Responsibility | Landing location & scan citation |
|---|---|---|
| Config resolution | Resolve the four-tier inspector switch; expose `AgentConfig.inspectIo` (null when off); `agentIoCapturesDir()`; create `io-captures/` at `0700`; raise `ConfigurationError` on un-initialisable state | `src/config/agent-config.ts` — extends `AgentCliFlags` (256-351), `AgentConfigFile` (93-132), `AgentConfig` (159-253), `agentLogsDir` (414-416), `bootstrapAgentDir`, `OTHER_ENV_KEYS` (scan §4 "new config wiring") |
| Capture channel | The parallel JSONL writer + typed records + pure helpers; reuse redaction, truncation, filesystem contract | NEW `src/agent/io-capture.ts` — mirrors `Logger`/`FileLogger`/`NullLogger`/`createLogger` (scan §4 "New Integration Points"; directive item 1) |
| Graph hooks | Capture request/response/tool-result at the provider-neutral `streamEvents v2` seam; invoke-path capture from `result['messages']` | `src/agent/graph.ts` — `StreamOneShotOptions` (137-141), `streamOneShot` (160-280), `runOneShot` (91-133) (scan §4 "primary hook point"; directive item 3) |
| Runner wiring | Instantiate `IoCapture` from `cfg`+`tools`; thread into `streamOneShot`/`runOneShot`; carry on `TuiAgentRuntime`; close in `finally` | `src/agent/run.ts` — `streamOneShotAgent` (122-227), `buildTuiAgentRuntime` (240-287), `TuiAgentRuntime` (234-238) (scan §4 "runner layer"; directive item 5) |
| TUI controller | Receive `ioCapture`, store as field, inject into `runTurn`'s `streamOneShot` opts, expose via `makeSlashContext` | `src/tui/controller.ts` — `TuiControllerOptions` (83-89), `makeSlashContext` (scan §4; directive item 5) |
| `/inspect` slash | Render a captured turn on demand in clearly delimited request/response sub-blocks; status; on/off messaging | NEW `src/tui/slash/inspect.ts` — mirrors `memory.ts` (scan §4 "precedent for new slash command"; directive item 2) |
| Slash registration | Self-register `/inspect`; forward `runtime.ioCapture` to the controller | `src/tui/index.ts` (side-effect import list lines 21-36) — NOT `slash/registry.ts` (plan Risk; directive item 2) |

### Provider-neutral capture seam (definitive, from research)

The single seam is LangChain's `streamEvents v2`, emitted by `@langchain/core`'s Runnable/tracer machinery **above** the provider SDK, so all eight providers produce identical event names and `data` shapes (research Q6; FR-12, AC-8). The three hooks:

1. **REQUEST** — `on_chat_model_start.data.input` carries the literal `{ messages: BaseMessage[] }` the model is about to receive. The agent prebuilt prepends the system prompt as a `SystemMessage`, so FR-3a (assembled system prompt), FR-3b (full in-thread memory), and FR-3c (current user content) are captured for free in one snapshot — no reconstruction from the `buildSystemPromptForCfg` string (research Recommendation 1, Q4). The shape is normalized defensively by `extractStartMessages` (bare array / `{messages}` / array-of-arrays — research Q2, pitfall 4).
2. **RESPONSE** — `on_chat_model_end.data.output` is an `AIMessageChunk`; `finalText` from `normalizeContent(out.content)` and `toolCalls` read from the END event's already-aggregated `out.tool_calls` (parsed-object args), NEVER from per-stream chunks (research Q3, pitfalls 2/3).
3. **TOOL RESULT** — `on_tool_end` provides the tool name / ok / duration so the request→response→tool-result chain (FR-4c) is inspectable end to end.

**Non-streaming `runOneShot`** emits no stream events (research pitfall 10): capture reads `result['messages']` after `graph.invoke` — one request record for the turn, then a response (+ tool-result) record per AI message with non-empty `tool_calls`, plus the terminal AI text.

**Bound tool schemas (FR-3d)** are static for the whole session (the same `tools` array binds to `createReactAgent` once — research Assumptions, verified `graph.ts:60-90`), so they are serialized ONCE at capture-construction via `captureBoundToolSchemas(tools)` and denormalized onto the first request of each turn only (`stepIndex === 0`) — research best-practice 4. The tool-use **prose** overlays are already embedded inside the captured system-prompt `SystemMessage`, so no separate overlay capture is required for fidelity (research Q1 nuance, finding 5).

## Data Models

No database. The capture artifact is a JSONL file (one JSON object per line) at `~/.tool-agents/cli-agent/io-captures/session-<UTC>-<sessionId>.jsonl`, plus a `latest.jsonl` relative symlink (copy-skip fallback). Each line is one `IoCaptureRecord`. The three record variants share the correlation envelope `{ sessionId, threadId, turnId, stepIndex, ts }`.

### `request` record
```jsonc
{
  "kind": "request",
  "sessionId": "lr8x...-3f2a1b9c",   // == logger.currentSessionId (FR-5)
  "threadId":  "f47ac10b-...",         // active thread_id (MemorySaver)
  "turnId":    "9b1d...",              // randomUUID, minted once per user turn
  "stepIndex": 0,                       // model-call index within the turn (0..N)
  "ts":        "2026-06-13T10:21:04.512Z",
  "messages": [                         // FR-3a/3b/3c — the literal model input
    { "role": "system", "content": "<full assembled system prompt>" },
    { "role": "human",  "content": "..." },
    { "role": "ai",     "content": "...", "toolCalls": [ { "id": "call_1", "name": "bash", "args": { } } ] },
    { "role": "tool",   "content": "<tool output>", "toolCallId": "call_1" }
  ],
  "boundTools": [                       // FR-3d — present only when stepIndex === 0
    { "name": "bash", "description": "...", "parameters": { "type": "object", "properties": { } } }
  ]
}
```

### `response` record
```jsonc
{
  "kind": "response",
  "sessionId": "...", "threadId": "...", "turnId": "...", "stepIndex": 0,
  "ts": "...",
  "finalText": "<assembled assistant text>",      // FR-4a
  "toolCalls": [ { "id": "call_1", "name": "bash", "args": { "cmd": "ls" } } ]  // FR-4b, parsed-object args
}
```

### `tool_result` record
```jsonc
{
  "kind": "tool_result",
  "sessionId": "...", "threadId": "...", "turnId": "...", "stepIndex": 0,
  "ts": "...",
  "toolName": "bash",          // FR-4c
  "ok": true,
  "durationMs": 142,
  "result": "<tool output, optional>"
}
```

### Field-cap & redaction markers
Capture records carry strings at several nesting depths (`messages[].content`, tool-call `args`, `tool_result.result`), so the writer deep-walks the record and truncates **every** string field exceeding `FIELD_TRUNCATE_BYTES` (64 KiB) to its first 64 KiB. When at least one field is truncated the record carries `_truncated: true` plus `_orig_size_bytes` (NFR-3; reuses the `truncateEvent` discipline, logging.ts:63-81). 

**As-built `_orig_size_bytes` shape (object-map, not scalar).** Because the cap is applied per-field across the whole record rather than to a single top-level string, `_orig_size_bytes` is an **object map** keyed by the truncated field's dotted path (e.g. `{ "messages[0].content": 81234 }`), each value the field's original pre-truncation byte length. This is the shipped shape in `FileIoCapture` (`deepTruncate`, `src/agent/io-capture.ts`); it is strictly richer than a single scalar (it identifies *which* fields were capped) and the `_truncated` boolean is unchanged. The on-disk record top level looks like:
```jsonc
{ "kind": "request", /* …envelope + fields… */
  "_truncated": true,
  "_orig_size_bytes": { "messages[0].content": 81234, "boundTools[2].parameters.properties.body.description": 70001 } }
```
When redaction is active (default), `message.content` is passed through `redactString` and tool-call `args` / `result` objects through `redactObject` (research best-practice 7, AC-5). When `redact === false` (raw opt-out) these passes are skipped and a one-line stderr warning was emitted before the file was opened.

## API & Interface Contracts

This section is the single authoritative source for every between-unit contract. Coders MUST reference these signatures, never restate them.

### `src/agent/io-capture.ts` (Unit B exposes)

```ts
import type { BaseMessage } from '@langchain/core/messages';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { AgentConfig } from '../config/agent-config.js';

/** One normalized message in a captured request. */
export interface CapturedMessage {
  role: 'system' | 'human' | 'ai' | 'tool' | string;
  content: string;
  toolCalls?: Array<{ id?: string; name: string; args: unknown }>;
  toolCallId?: string;            // present for tool messages
}

/** Serialized bound tool/function schema (FR-3d), OpenAI-normalized. */
export interface BoundToolSchema {
  name: string;
  description: string;
  parameters: unknown;            // JSON Schema (convertToOpenAITool .function.parameters)
}

/** Shared correlation envelope for every record. */
export interface IoCaptureEnvelope {
  sessionId: string;
  threadId: string;
  turnId: string;
  stepIndex: number;
  ts: string;                     // ISO-8601 UTC
}

export type IoCaptureRecord =
  | (IoCaptureEnvelope & {
      kind: 'request';
      messages: CapturedMessage[];
      boundTools?: BoundToolSchema[];        // only on stepIndex === 0
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
export type RequestInput   = Omit<Extract<IoCaptureRecord, { kind: 'request' }>,   'kind'>;
export type ResponseInput  = Omit<Extract<IoCaptureRecord, { kind: 'response' }>,  'kind'>;
export type ToolResultInput= Omit<Extract<IoCaptureRecord, { kind: 'tool_result' }>,'kind'>;

/** Parallel capture channel — mirrors the Logger interface in logging.ts. */
export interface IoCapture {
  /** Bound tool schemas captured once at construction (turn-invariant). */
  readonly boundToolSchemas: ReadonlyArray<BoundToolSchema>;
  readonly currentSessionId: string;
  readonly currentCapturePath: string;       // '' for NullIoCapture
  captureRequest(rec: RequestInput): void;
  captureResponse(rec: ResponseInput): void;
  captureToolResult(rec: ToolResultInput): void;
  /** In-memory record list for /inspect show (no disk re-read). */
  read(): IoCaptureRecord[];
  close(): Promise<void>;
}

/** Pure helper: normalize a LangChain BaseMessage to a CapturedMessage. */
export function toCaptureMessage(m: BaseMessage): CapturedMessage;

/** Pure helper: defensively flatten on_chat_model_start.data.input. */
export function extractStartMessages(input: unknown): BaseMessage[];

/** Pure helper: serialize bound tools via convertToOpenAITool (NOT zod-to-json-schema). */
export function captureBoundToolSchemas(tools: DynamicStructuredTool[]): BoundToolSchema[];

/** No-op capture — the ONLY instance used when the switch is off (NFR-1). */
export declare class NullIoCapture implements IoCapture { /* all methods no-op */ }

/** File-backed capture — mirrors FileLogger (0600 file, latest.jsonl, truncation, redaction). */
export declare class FileIoCapture implements IoCapture { /* see Error Handling + Algorithms */ }

/**
 * Factory — mirrors createLogger. Returns NullIoCapture when cfg.inspectIo === null;
 * otherwise serializes boundToolSchemas, emits the stderr raw-opt-out warning when
 * cfg.inspectIo.redact === false (BEFORE opening the file), and returns a FileIoCapture.
 * Throws ConfigurationError (no fallback) if the capture dir is un-creatable.
 */
export function createIoCapture(
  cfg: AgentConfig,
  sessionId: string,
  tools: DynamicStructuredTool[],
): IoCapture;
```

**`captureBoundToolSchemas` body contract (design invariant — directive item 4):**
```ts
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
// MUST NOT import 'zod-to-json-schema' (verified ABSENT on disk; optional peer only).
export function captureBoundToolSchemas(tools: DynamicStructuredTool[]): BoundToolSchema[] {
  return tools.map((t) => {
    const def = convertToOpenAITool(t);           // { type:'function', function:{ name, description, parameters } }
    return {
      name: def.function.name,
      description: def.function.description ?? '',
      parameters: def.function.parameters,        // JSON Schema
    };
  });
}
```

### `src/agent/graph.ts` (Unit C exposes / consumes)

```ts
import type { IoCapture } from './io-capture.js';
import { extractStartMessages, toCaptureMessage } from './io-capture.js';

// EXTENSION of the existing interface (currently { logger?, sessionId?, abortSignal? }):
interface StreamOneShotOptions {
  readonly logger?: Logger;
  readonly sessionId?: string;
  readonly abortSignal?: AbortSignal;
  readonly ioCapture?: IoCapture;     // NEW — additive, optional
}

// runOneShot gains an OPTIONAL 5th param (existing 4-positional call sites unaffected):
export async function runOneShot(
  agentGraph: AgentGraph,
  prompt: string,
  threadId: string,
  maxSteps: number,
  captureOpts?: { ioCapture?: IoCapture; sessionId?: string },   // NEW
): Promise<string>;
```

`streamOneShot` adds `let stepIndex = 0;` and three guarded hooks (`if (ioCapture)`), and increments `stepIndex` after the `on_chat_model_end` capture. No existing `logger.log` call, yielded `AgentStreamEvent`, or `assembled` text is changed — the off path (no `ioCapture`) is byte-identical (NFR-1). The `on_chat_model_end` response read uses the existing `normalizeContent` (graph.ts:282) for `finalText` and reads `tool_calls` exclusively from `event.data.output` (the aggregated `AIMessageChunk`).

### `src/agent/run.ts` (Unit C exposes / consumes)

```ts
import { createIoCapture } from './io-capture.js';
import type { IoCapture } from './io-capture.js';

// EXTENSION of the existing interface (currently { agentGraph, logger, sessionId }):
export interface TuiAgentRuntime {
  agentGraph: AgentGraph;
  logger: ReturnType<typeof createLogger>;
  sessionId: string;
  ioCapture: IoCapture;               // NEW — 4th member (NullIoCapture when off)
}
```

- `streamOneShotAgent`: `const ioCapture = createIoCapture(cfg, sessionId, tools);` immediately after `buildToolCatalog`; add `ioCapture` to the `streamOneShot` opts literal; `await ioCapture.close();` after `await logger.close();` in `finally`.
- `runOneShotAgent`: `const ioCapture = createIoCapture(cfg, sessionId, tools);`; pass `{ ioCapture, sessionId }` into the `runOneShot(...)` call; close it in the same cleanup path as `logger`.
- `buildTuiAgentRuntime`: `const ioCapture = createIoCapture(cfg, sessionId, tools);` after `buildToolCatalog`; `return { agentGraph, logger, sessionId, ioCapture };` (the TUI controller owns the close on session end).

### `src/tui/controller.ts` (Unit D exposes / consumes)

```ts
import type { IoCapture } from '../agent/io-capture.js';

// EXTENSION of the existing interface (currently { cfg, agentGraph, logger, stdout?, stderr? }):
export interface TuiControllerOptions {
  readonly cfg: AgentConfig;
  readonly agentGraph: AgentGraph;
  readonly logger: Logger;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  readonly ioCapture: IoCapture;      // NEW — required (NullIoCapture when off)
}

class TuiController {
  readonly ioCapture: IoCapture;      // NEW public field, assigned from opts in ctor
  // runTurn: ADD `ioCapture: this.ioCapture` to the streamOneShot opts object only.
  // makeSlashContext: UNCHANGED — already passes `controller: this`; /inspect reads ctx.controller.ioCapture.
}
```

`SlashContext` is NOT modified — its `controller: TuiController` (registry.ts:16-22) already gives `/inspect` access to `ctx.controller.ioCapture`. The response/tool-result capture in the TUI is a side-effect of the event loop already running inside `streamOneShot`; no capture call is interleaved into the render loop (NFR-2).

### `src/tui/slash/inspect.ts` (Unit D exposes)

```ts
import { registerCommand, type SlashCommand } from './registry.js';
import { BOLD, DIM, RESET, CYAN } from '../ansi.js';

const inspectCmd: SlashCommand = {
  name: '/inspect',
  aliases: ['/inspect-io'],
  summary: 'Inspect the captured LLM request/response for a turn',
  async run(ctx, args): Promise<void> { /* status | show [turn] | on | off */ },
};
registerCommand(inspectCmd);
export default inspectCmd;
```

Sub-command contract (`args[0]`):
- `status` (and no-arg default) → report whether capture is active (`ioCapture instanceof FileIoCapture` vs `NullIoCapture`, distinguished by `currentCapturePath !== ''`), the capture file path, and `ioCapture.read().length`.
- `show [turn]` → `ioCapture.read()`, group by `turnId` in order, select the 1-based `[turn]` (or latest when omitted), render a `Turn N · <ts>` header, a REQUEST section (system prompt, memory messages by role, current user content, bound tool schemas) and a RESPONSE section (assistant text, each tool-call name+args, each tool result), each long block truncated with a visible `… [truncated]` marker (FR-6). All output via `ctx.println`/`ctx.printSystem` (same stdout path as every command — NFR-2). `try/catch` prints `failed to read captures: <msg>` on error (mirrors memory.ts:40-42).
- `on` / `off` → emit a clear `[system]` message that file capture is established at launch via `--inspect-io` and cannot be retro-actively created mid-session (the `FileIoCapture` + bound-tool snapshot are wired at runtime build); `/inspect on|off` documents this rather than silently no-opping (preserves the no-silent-fallback spirit).

### `src/config/agent-config.ts` (Unit A exposes)

```ts
// AgentCliFlags (extend, lines 256-351):
readonly inspectIo?: boolean;
readonly inspectIoRaw?: boolean;

// AgentConfigFile (extend, lines 93-132):
readonly inspectIo?: { enabled?: boolean; redact?: boolean; dir?: string };

// AgentConfig (extend, lines 159-253) — resolved; null when NOT requested, NEVER silently defaulted:
readonly inspectIo: { enabled: boolean; redact: boolean; dir: string } | null;

// New helper (mirrors agentLogsDir, 414-416):
export function agentIoCapturesDir(): string {
  return path.join(agentToolAgentsDir(), 'io-captures');
}

// New env keys appended to OTHER_ENV_KEYS (→ flow through ALL_ENV_KEYS, .env loader, provider-env snapshot):
'CLI_AGENT_INSPECT_IO', 'CLI_AGENT_INSPECT_IO_RAW'
```

**Resolution contract (`loadAgentConfig`, four-tier, no fallback):**
- Requested? = CLI `flags.inspectIo` → env `CLI_AGENT_INSPECT_IO` → `config.json` `inspectIo.enabled` (first defined wins; higher priority to the right per the existing `resolveOne` idiom, agent-config.ts ~1132-1182).
- Not requested → `inspectIo = null`.
- Requested → `inspectIo = { enabled: true, redact, dir }` where:
  - `redact = !(flags.inspectIoRaw || truthy(CLI_AGENT_INSPECT_IO_RAW) || config.inspectIo?.redact === false)`.
  - `dir = config.inspectIo?.dir ?? agentIoCapturesDir()`.
- Invalid `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW` value (non-boolean) → `ConfigurationError` via the existing `parseBooleanEnvVar` machinery (never default).
- Requested but `dir` un-creatable/un-writable → `ConfigurationError` (no fallback to `null`).
- `bootstrapAgentDir` creates `io-captures/` at `0700` (mirrors the `logsDir` block) and seeds a commented `# --- LLM I/O inspector ---` `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW` placeholder pair in the `.env` block (all lines commented, never a real value).

### `src/cli.ts` (Unit A)

On the default `agent` command, after the `--system-file` option (line 92):
```ts
.option('--inspect-io', 'Enable LLM I/O capture (writes provider-normalized request/response JSONL to ~/.tool-agents/cli-agent/io-captures/)')
.option('--inspect-io-raw', 'Disable redaction for I/O captures only (use with caution; prints a warning)')
```
In the `AgentCliFlags` object literal (lines 219-234): `inspectIo: opts['inspectIo'] as boolean | undefined,` and `inspectIoRaw: opts['inspectIoRaw'] as boolean | undefined,`. `handleErrors` already routes `ConfigurationError`/`UsageError` — unchanged.

## Module Organization

| File | Action | Notes |
|---|---|---|
| `src/config/agent-config.ts` | modify | Interfaces + resolution + `agentIoCapturesDir` + env keys + bootstrap dir |
| `src/cli.ts` | modify | Register two flags; map into `AgentCliFlags` |
| `src/agent/io-capture.ts` | **create** | Parallel channel; ESM `import type` for LangChain; default-export-free (named exports only) |
| `src/agent/graph.ts` | modify | `StreamOneShotOptions.ioCapture`; three guarded hooks; `runOneShot` optional param |
| `src/agent/run.ts` | modify | Instantiate/close `IoCapture`; `TuiAgentRuntime.ioCapture` |
| `src/tui/controller.ts` | modify | `TuiControllerOptions.ioCapture`; field; `runTurn` opts |
| `src/tui/slash/inspect.ts` | **create** | Mirrors `memory.ts`; `default export` for side-effect registration (the sanctioned default-export exception, scan §3) |
| `src/tui/index.ts` | modify | `import './slash/inspect.js';` + forward `runtime.ioCapture` to `TuiController` |
| `src/agent/io-capture.spec.ts` | **create** | Single Vitest spec owned end-to-end by Unit E |
| `test_scripts/baselines/help-no-treat-as-tool.txt` | modify | Deliberate re-record (Unit A, after flags) |
| `docs/tools/cli-agent.md`, `docs/design/project-functions.md`, `docs/design/project-design.md`, `docs/design/configuration-guide.md` | modify | Unit F docs |

Conventions adopted (cited): ESM named imports + `import type` for LangChain (scan §3); the sanctioned `default export` for slash side-effect registration (scan §3, memory.ts:46); typed error hierarchy, no silent swallow except the writer's local catch (scan §3, logging.ts:116); `0700` dir / `0600` `O_CREAT|O_APPEND` files / UTC filename / `latest.jsonl` (scan §3, logging.ts:148-176); 64 KiB field cap with `_truncated`/`_orig_size_bytes` (scan §3, logging.ts:63-81); byte-stable `--help` baseline discipline (scan §3, cli-help-baseline.spec.ts).

## Error Handling Strategy

1. **No-fallback configuration (hard project rule, FR-10, AC-7).** When the inspector is explicitly requested but cannot be initialised — capture dir un-creatable/un-writable, or an invalid `CLI_AGENT_INSPECT_IO`/`CLI_AGENT_INSPECT_IO_RAW` boolean value — `loadAgentConfig` (or `createIoCapture` if the dir fails at construction) raises `ConfigurationError` with its existing exit code. It NEVER substitutes `inspectIo = null`, a default mode, or a `NullIoCapture` downgrade. There is no default value for any requested-but-unresolvable inspector setting.
2. **Off-state is `null`, not an error.** When the switch is simply not requested, `inspectIo = null` and `createIoCapture` returns `NullIoCapture` — this is the normal disabled state, distinct from a misconfiguration.
3. **Writer-local error swallow (the only sanctioned exception).** Inside `FileIoCapture`'s write path, the `try/catch { /* swallow — capture must never break the agent */ }` mirrors `FileLogger.log` (logging.ts:116). A failed capture write degrades the diagnostic, never the agent run. This swallow is strictly local to the writer and never masks a configuration error.
4. **Redaction never crashes the caller.** `redactString`/`redactObject` already return `[REDACTED_FALLBACK]`/`[REDACTED_OBJECT]` on internal failure (redact.ts:40-71); the capture path inherits that safety.
5. **Raw opt-out warning before exposure.** When `cfg.inspectIo.redact === false`, `createIoCapture` writes a prominent one-line `process.stderr` warning BEFORE opening the file, so plaintext-secret risk is surfaced before any unredacted byte is written (NFR-4, AC-5).
6. **`/inspect` read errors are reported, not thrown.** The slash handler wraps `ioCapture.read()` in `try/catch` and prints a `[system]` failure line (mirrors memory.ts), never crashing the TUI.

## Algorithms & Business Logic (prose, implementation-precise)

**`toCaptureMessage(m)`** — read `m._getType?.() ?? m.role ?? 'msg'` for `role`; normalize `content` to a string (string → as-is; content-block array → filter `type === 'text'`, map `.text`, join; else `''`); if `m.tool_calls` is a non-empty array, map each to `{ id, name, args }`; if `m.tool_call_id` present, set `toolCallId`. (research §"Practical Integration Snippet".)

**`extractStartMessages(input)`** — if `input` is an array, return `input.flat()` (covers `BaseMessage[]` and `BaseMessage[][]`); if `input` is an object with a `messages` array, return `messages.flat()`; else `[]`. (research Q2.)

**`streamOneShot` hooks** — maintain `let stepIndex = 0`. On `on_chat_model_start` (new case): if `ioCapture`, `captureRequest({ ...envelope, messages: extractStartMessages(event.data?.input).map(toCaptureMessage), boundTools: stepIndex === 0 ? [...ioCapture.boundToolSchemas] : undefined })`. On `on_chat_model_end` (existing case, after the existing `logger.log`): if `ioCapture`, read `out = event.data?.output as AIMessageChunk`, `finalText = out ? normalizeContent(out.content) : assembled`, `toolCalls = (out?.tool_calls ?? []).map(tc => ({ id: tc.id, name: tc.name, args: tc.args }))`, `captureResponse({ ...envelope, finalText, toolCalls })`; then `stepIndex += 1`. On `on_tool_end` (existing case): if `ioCapture`, `captureToolResult({ ...envelope, toolName, ok: true, durationMs })`. The shared `turnId`/`sessionId`/`threadId` are the existing per-`streamOneShot` values (graph.ts mints `turnId` once per turn — research Q2 nuance); `stepIndex` distinguishes the N ReAct model calls within the turn (FR-4c).

**`runOneShot` invoke-path capture** — mint `turnId = randomUUID()`. After `graph.invoke`, if `captureOpts?.ioCapture`: read `messages = result['messages'] as BaseMessage[]`; `captureRequest` once for the turn (messages up to and including the last human message, `stepIndex: 0`, `boundTools`); iterate `messages`, and for each `ai` message with non-empty `tool_calls` emit a `captureResponse` (and `captureToolResult` for the paired `tool` message); finally a `captureResponse` for the terminal AI text. (research Q3 non-streaming block, pitfall 10.)

**`FileIoCapture.serialize(rec)`** — clone the record; for each string field exceeding `FIELD_TRUNCATE_BYTES`, truncate to the first 64 KiB and set `_truncated: true` + `_orig_size_bytes` (reuse the `truncateEvent` discipline, logging.ts:63-81); then, unless `redact === false`, pass message `content` through `redactString` and tool-call `args` / `result` through `redactObject`; `JSON.stringify` + `'\n'`; `fs.writeSync` inside `try/catch` (swallow). Also push the un-serialized record into the in-memory array for `read()`.

**`createIoCapture(cfg, sessionId, tools)`** — `if (cfg.inspectIo === null) return new NullIoCapture();` else `boundToolSchemas = captureBoundToolSchemas(tools)`; if `cfg.inspectIo.redact === false` write the stderr warning; construct `FileIoCapture` against `cfg.inspectIo.dir` with `session-<UTC>-<sessionId>.jsonl` + `latest.jsonl`; on dir failure throw `ConfigurationError`.

## Implementation Units

The plan's 7 units are the partition. **One change from the plan (`units_changed_from_plan: true`):** the plan listed `src/agent/io-capture.spec.ts` under BOTH Unit B and Unit E, which violates pairwise-disjoint file sets. This design assigns the spec to **Unit E only** (Unit B owns `io-capture.ts` exclusively), and moves plan Step 14 (the filesystem-conventions spec test) from Unit B into Unit E so the entire spec file has a single owner. After this change, every unit's file set is **pairwise-disjoint** (verified below). Step→unit mapping is total and one-to-one: every plan step 1–21 maps to exactly one unit.

### Unit A — Config wiring + CLI flags
- **Plan steps:** 1, 2, 16
- **Files:** `src/config/agent-config.ts`, `src/cli.ts`, `test_scripts/baselines/help-no-treat-as-tool.txt`
- **Exposes:** `AgentConfig.inspectIo` (`{ enabled; redact; dir } | null`), `AgentCliFlags.inspectIo`, `AgentCliFlags.inspectIoRaw`, `AgentConfigFile.inspectIo`, `agentIoCapturesDir(): string`, env keys `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW`. (Step 16 re-records the help baseline; it depends on Step 2's flags AND Step 15's suite state, so it runs last within the unit.)
- **Consumes:** nothing (foundation).

### Unit B — Capture core (IoCapture channel)
- **Plan steps:** 3, 4
- **Files:** `src/agent/io-capture.ts`
- **Exposes:** `IoCapture`, `IoCaptureRecord`, `CapturedMessage`, `BoundToolSchema`, `createIoCapture(cfg, sessionId, tools)`, `NullIoCapture`, `FileIoCapture`, `toCaptureMessage`, `extractStartMessages`, `captureBoundToolSchemas` (all per the API contract above).
- **Consumes:** `AgentConfig.inspectIo` and `agentIoCapturesDir` (Unit A).

### Unit C — Graph + runner hooks
- **Plan steps:** 5, 6, 7
- **Files:** `src/agent/graph.ts`, `src/agent/run.ts`
- **Exposes:** `StreamOneShotOptions.ioCapture`, `runOneShot`'s optional `captureOpts` param, `TuiAgentRuntime.ioCapture`.
- **Consumes:** Unit B's `IoCapture` / `createIoCapture` / `toCaptureMessage` / `extractStartMessages`; Unit A's `AgentConfig.inspectIo`.

### Unit D — TUI controller + /inspect slash
- **Plan steps:** 8, 9, 10
- **Files:** `src/tui/controller.ts`, `src/tui/slash/inspect.ts`, `src/tui/index.ts`
- **Exposes:** `TuiControllerOptions.ioCapture`, the public `TuiController.ioCapture` field, the registered `/inspect` command (`inspectCmd`).
- **Consumes:** Unit B's `IoCapture` / `IoCaptureRecord` (`read()`, `FileIoCapture`/`NullIoCapture` discrimination); Unit C's `TuiAgentRuntime.ioCapture` and `StreamOneShotOptions.ioCapture`.

### Unit E — Tests (sole owner of `io-capture.spec.ts`)
- **Plan steps:** 11, 12, 13, 14, 15
- **Files:** `src/agent/io-capture.spec.ts`
- **Exposes:** nothing.
- **Consumes:** Unit B's full surface; Unit A's resolution (`loadAgentConfig` precedence + no-fallback). Coverage: content fidelity + provider-neutrality (11), redaction default/raw-opt-out + 64 KiB truncation (12), four-tier precedence + no-fallback error (13), filesystem conventions `0700`/`0600`/`latest`/UTC-name (14, moved here from plan Unit B), off-state no-op byte-stability (15). Authored AFTER Units A–C exist; a single coder owns the file end to end.

### Unit F — Documentation
- **Plan steps:** 17, 18, 19, 20
- **Files:** `docs/tools/cli-agent.md`, `docs/design/project-functions.md`, `docs/design/project-design.md`, `docs/design/configuration-guide.md`
- **Exposes / Consumes:** consumes the final flag/env/config/record shapes (Units A–D); four internally-disjoint files, fully parallelizable.

### Unit G — Full verification
- **Plan steps:** 21
- **Files:** none
- Runs after all units: `npm run typecheck` + `npm run build` + `npm test` (incl. `io-capture.spec.ts` and the regenerated `cli-help-baseline.spec.ts`).

### Pairwise-disjoint file-set verification (EXPLICIT)
```
A: {agent-config.ts, cli.ts, help-no-treat-as-tool.txt}
B: {io-capture.ts}
C: {graph.ts, run.ts}
D: {controller.ts, inspect.ts, index.ts}
E: {io-capture.spec.ts}
F: {cli-agent.md, project-functions.md, project-design.md, configuration-guide.md}
G: {}
```
No file appears in two units. The plan's single overlap (`io-capture.spec.ts` ∈ B ∩ E) is eliminated by assigning the spec to E only and moving Step 14 into E. **All file sets are pairwise-disjoint.** Recommended fan-out: **A + B in parallel** → **C + D in parallel** → **E** → **F** (parallel internally) → **G**. (B depends on A; C and D depend on B; D also depends on C's `TuiAgentRuntime.ioCapture`; E depends on A–C; F depends on the shapes from A–D.)

## Design Decisions

1. **Dedicated parallel capture channel, not an extension of `LogEvent`.** A new `src/agent/io-capture.ts` mirrors `Logger`/`FileLogger`/`NullLogger`/`createLogger` but writes to its own `io-captures/` store. **Rationale:** heavy system-prompt/memory payloads must never bloat the compact operational `logs/` stream, and the `LogEvent` union must stay byte-stable to preserve NFR-1 (Open Question 7 resolution; directive item 1; research pitfall 12). **Rejected:** adding `request`/`response` variants to `LogEvent` (couples two concerns, risks off-state log-line drift); a single combined writer (same coupling).

2. **Capture the request from `on_chat_model_start.data.input`, not the pre-composition `buildSystemPromptForCfg` string.** The start-event message array is the literal model input and already contains the system prompt as a `SystemMessage` plus full memory plus the current human turn. **Rationale:** one provider-neutral seam, zero reconstruction, robust to any future trimming/summarization middleware (research Recommendation 1, Q4; directive item 3). **Rejected:** reconstructing from the assembled string + a separate checkpointer read (re-derives what the framework hands you; risks drift) — this is the scan's original proposal, which the research and directive supersede.

3. **Serialize bound tool schemas with `convertToOpenAITool` from `@langchain/core/utils/function_calling`; never import `zod-to-json-schema`.** **Rationale (design invariant):** `zod-to-json-schema` is verified ABSENT on disk (only an optional peer of `@langchain/langgraph`); importing it is an undeclared-dependency violation that would also trigger the `dependency-validation` skill. `convertToOpenAITool` is already installed and is the same helper the OpenAI adapter uses, so its `parameters` JSON Schema is the highest-fidelity provider-neutral artifact with no new dependency (research Recommendation 2, Q1; directive item 4). **Rejected:** `zod-to-json-schema` (policy violation + runtime failure); raw Zod introspection (not the provider view).

4. **Read response `tool_calls` from the `on_chat_model_end` aggregated output, never from per-stream chunks.** **Rationale:** mid-stream chunks carry `tool_call_chunks` (partial JSON-string fragments); only the END event's `AIMessageChunk.tool_calls` are fully assembled parsed objects (research Q3, pitfalls 2/3). **Rejected:** scraping `event.data.chunk.tool_calls` (truncated/empty args).

5. **`stepIndex` within a per-turn `turnId`.** One user turn fires N `on_chat_model_start` events in the ReAct loop; the existing `turnId` is minted once per turn. A monotonic `stepIndex` records each model call so the request→tool→request chain (FR-4c) is reconstructable; `/inspect show` groups by `turnId`. **Rationale:** research Q2 nuance, best-practice 6. **Rejected:** one record per turn (loses intermediate model calls); one `turnId` per model call (breaks correlation with the logger's per-turn id).

6. **Off-state = `AgentConfig.inspectIo: null` + `NullIoCapture`, with every hook guarded by `if (ioCapture)`.** **Rationale:** structurally guarantees NFR-1 — when off, no capture object is created, no hook fires, no file is written, and `LogEvent`/`system-prompt.ts`/the transcript writer are never touched, so provider payloads, streamed output, logs, transcripts, and `--help` are byte-identical to `master`. **Rejected:** a disabled `FileIoCapture` that opens nothing (more state, more surface for an off-state leak).

7. **No-fallback config with `null`-when-off semantics.** `inspectIo` resolves to `null` when not requested and to a fully-populated object when requested; an explicitly-requested-but-uninitialisable inspector raises `ConfigurationError`. **Rationale:** the hard project rule forbids substituting a default for missing/unresolvable required config (FR-10). The `null` sentinel cleanly distinguishes "off" from "misconfigured" without a fallback (directive item 7; mirrors the `agentTools` resolved-shape precedent at AgentConfig:159-253, adapted to off-by-default). **Rejected:** defaulting to "capture disabled" on dir failure (silent fallback — forbidden).

8. **Redaction ON by default; `--inspect-io-raw` opts out for captures only, with a pre-write stderr warning.** **Rationale:** captures contain the full system prompt and memory, which can carry credential-shaped values; reusing `src/util/redact.ts` matches existing logging and keeps the safe path the default while honoring the "exactly what was sent" request on explicit demand (Open Question 3; FR-9, NFR-4). Both message `content` and tool-call `args`/`result` are redacted (research best-practice 7). **Rejected:** verbatim-by-default (secret exposure); a second redaction scheme (forbidden — reuse `redact.ts`).

9. **Mid-session `/inspect on|off` informs rather than silently no-ops.** The `FileIoCapture` + bound-tool snapshot are wired at session build, so `/inspect on|off` cannot retro-actively create the JSONL writer; the command emits a clear `[system]` message that file capture is established at launch via `--inspect-io`. **Rationale:** preserves the request's "TUI slash toggle" intent within the architectural constraint, without a silent fallback (Open Question 2; plan Risk). **Rejected:** silently doing nothing (violates the no-silent-fallback spirit); rebuilding the runtime mid-session (out of scope, high TUI risk).

10. **In-memory record mirror for `/inspect show`.** `FileIoCapture` holds the `IoCaptureRecord[]` in memory so `read()` serves the renderer without re-parsing disk. **Rationale:** simpler, race-free with the live writer, and the session-bounded volume is modest under the 64 KiB cap (FR-7 on-demand replay; NFR-3). **Rejected:** re-reading and parsing the JSONL on every `/inspect show` (slower; races the append).

11. **Slash registration at `src/tui/index.ts`, not `slash/registry.ts`.** The actual side-effect import list lives at `src/tui/index.ts` (verified lines 21-36); `/inspect` self-registers via `import './slash/inspect.js'` there, mirroring every other command. **Rationale:** the scan §4 mis-titled the registration site; this design corrects it (plan Risk; directive item 2). **Rejected:** editing `registry.ts` (wrong site; would not register the command).

## Decisions Requiring User Review
Present these at the design-review gate before implementation:

1. **Final flag / env / config names.** `--inspect-io` + `--inspect-io-raw`; `CLI_AGENT_INSPECT_IO` + `CLI_AGENT_INSPECT_IO_RAW`; `config.json` `inspectIo: { enabled?, redact?, dir? }`. These match the refined request's proposed defaults but are user-facing surface that becomes a byte-stable `--help` baseline once shipped — confirm the spelling now to avoid a later rename + baseline churn.
2. **The exact JSONL record shape.** The three-variant `IoCaptureRecord` union (`request` / `response` / `tool_result`) with the `{ sessionId, threadId, turnId, stepIndex, ts }` envelope and the field names above (`finalText`, `toolCalls`, `boundTools`, `_truncated`, `_orig_size_bytes`) is the persisted, documented contract. Confirm these field names — they are documented in the tool doc and become a de-facto format other tooling may parse.
3. **Turn vs model-call granularity (raised by the research).** This design captures **per user turn** (one `turnId`), with each ReAct model call recorded as a `stepIndex` sub-step, and `/inspect show [turn]` addressing the 1-based user turn. The alternative is to treat each model call as the addressable unit. The per-turn-with-stepIndex choice matches the existing logger's per-turn `turnId` and the FR-4c "end-to-end chain" intent (research Clarifying Question 1). Confirm this is the desired granularity for the inspector view.
4. **Model name / temperature / `tool_choice` in the request record (optional, deferred by this design).** The start event does not expose these as a reliable provider-neutral field; this design does NOT record them (it would source them from `cfg`/the model instance). Confirm omission is acceptable, or request them as an explicit addition (research Clarifying Question 2).

## Risks
- **`on_chat_model_start.data.input` shape variance** across LangChain/LangGraph versions (bare array vs `{messages}` vs array-of-arrays — research Q2/pitfall 4). → `extractStartMessages` flattens all three; Unit E tests all three. A 3-line runtime probe on the first start event can confirm the live shape during implementation (research Uncertainties).
- **Multiple `on_chat_model_start` per user turn** (ReAct loop). → `stepIndex` records each call under the shared `turnId`; bound schemas attached only on `stepIndex === 0` (Decision 5).
- **Partial/empty `tool_calls` if read from streamed chunks.** → Read exclusively from the `on_chat_model_end` aggregated output (Decision 4).
- **`runOneShot` currently takes no options object** (verified graph.ts:91-133). → An OPTIONAL 5th `captureOpts` param keeps existing 4-positional call sites unaffected.
- **Mid-session `/inspect on|off` cannot create the writer retro-actively.** → The command messages this explicitly rather than no-opping (Decision 9); documented in the tool doc + config guide.
- **Off-state byte-stability could regress if a hook leaks onto the off path.** → Every hook guarded by `if (ioCapture)`; `createIoCapture` returns `NullIoCapture` when `cfg.inspectIo === null`; Unit E asserts zero side-effect when off; `LogEvent`/`system-prompt.ts`/transcript writer untouched (Decision 6).
- **`convertToOpenAITool` renders the OpenAI tool envelope; non-OpenAI providers differ at the wrapper level** (research Q1 nuance, MEDIUM-confidence assumption). → The `parameters` schema is identical across providers; only the wrapper differs, and wire-byte/envelope capture is explicitly deferred (Open Question 4). Documented as a known limitation in Unit F.
- **Gemini tool calls lack `id`.** → `tool_call.id` is typed optional and correlation is never keyed on it (research Q6/pitfall 8).
- **`io-capture.spec.ts` single-owner constraint.** → Assigned to Unit E only; Unit B owns `io-capture.ts` exclusively; the spec is authored after Units A–C exist (resolves the plan's one flagged overlap).
- **Scan staleness:** none. `last_scanned_commit` (`c546d389`) == plan `based_on_commit` == current HEAD; all load-bearing symbols (`StreamOneShotOptions`, `runOneShot`, `Logger`/`createLogger`/`truncateEvent`, `AgentConfig`/`AgentCliFlags`/`AgentConfigFile`, `agentLogsDir`, `TuiControllerOptions`, `SlashContext`/`SlashCommand`, `memoryCmd`, `redactString`/`redactObject`, `TuiAgentRuntime`, `streamOneShotAgent`, `buildTuiAgentRuntime`) and the `convertToOpenAITool` export were verified to exist with the signatures this design relies on.
