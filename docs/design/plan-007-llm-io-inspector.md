---
status: complete
plan_number: 007
slug: llm-io-inspector
request_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/refined-request-llm-io-inspector.md
investigation_file: null
research_files:
  - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/research/langgraph-streamevents-io-capture.md
codebase_scan_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/codebase-scan-llm-io-inspector.md
based_on_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
scan_commit_match: true
steps: 21
open_questions: 0
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
implementation_units:
  - name: Unit A — Config wiring + CLI flags
    steps: [1, 2, 16]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/config/agent-config.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/cli.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/test_scripts/baselines/help-no-treat-as-tool.txt
  - name: Unit B — Capture core (IoCapture channel)
    steps: [3, 4, 14]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/io-capture.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/io-capture.spec.ts
  - name: Unit C — Graph + runner hooks
    steps: [5, 6, 7]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/graph.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/run.ts
  - name: Unit D — TUI controller + /inspect slash
    steps: [8, 9, 10]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/tui/controller.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/tui/slash/inspect.ts
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/tui/index.ts
  - name: Unit E — Tests
    steps: [11, 12, 13, 15]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/io-capture.spec.ts
  - name: Unit F — Documentation
    steps: [17, 18, 19, 20]
    files:
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/tools/cli-agent.md
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/project-functions.md
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/project-design.md
      - /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/configuration-guide.md
  - name: Unit G — Full verification
    steps: [21]
    files: []
build_command: "npm run build"
test_command: "npm test"
created_at: 2026-06-13T00:00:00Z
---

# Plan 007 — LLM I/O Inspector (a switch that records the exact tool↔LLM conversation)

## Objective
Add a diagnostic "LLM I/O inspector" to `@biks2013/cli-agent` that, when switched on, captures the EXACT provider-normalized request (assembled system prompt + full in-thread memory + current user content + bound tool/function JSON schemas) and the EXACT response (assistant text + parsed tool-calls) for every LLM turn, writing them to a tailable JSONL file under the per-user agent dir and rendering any completed turn on demand via an in-TUI `/inspect show [turn]` command. The capture is a parallel, additive channel — when the switch is off, the system prompt, provider payloads, streamed output, existing `logs/` JSONL, transcript files, and `--help` output remain byte-identical to `master`. Serves the refined request at `docs/reference/refined-request-llm-io-inspector.md` (FR-1..FR-12, NFR-1..NFR-6, AC-1..AC-11).

## Context
- Refined request (authoritative scope + acceptance criteria): @docs/reference/refined-request-llm-io-inspector.md — all 7 Open Questions resolved with the refiner's recommended defaults (see its "Open Questions — Resolutions" section).
- Technical research (capture seam + dependency verdict): @docs/research/langgraph-streamevents-io-capture.md
- Codebase scan (integration points, conventions, in/out-of-scope): @docs/reference/codebase-scan-llm-io-inspector.md
- Project design context: @docs/design/project-design.md
- No investigation file — the approach was fully fixed by the resolved Open Questions (Phase 3a intentionally skipped).

**Chosen approach.** A dedicated parallel capture channel (new `src/agent/io-capture.ts`) that mirrors the `Logger`/`FileLogger`/`NullLogger`/`createLogger` structure in `src/agent/logging.ts` but writes to its own `~/.tool-agents/cli-agent/io-captures/` store, REUSING the existing `src/util/redact.ts` helper, the 64 KiB field-cap + `_truncated` discipline, and the `0700`/`0600` + UTC-filename + `latest.jsonl` filesystem contract. The existing `LogEvent` union and transcript format are NOT modified (off-state byte-stability). The request is captured from the `streamEvents` `on_chat_model_start.data.input` message array (which already contains the SystemMessage = full assembled prompt + full memory + current human turn — research Recommendation 1 / Q4); the response from `on_chat_model_end.data.output` (an `AIMessageChunk` whose `.tool_calls` are already parsed objects — research Q3). Bound tool/function JSON schemas are serialized ONCE per session with `convertToOpenAITool` from `@langchain/core/utils/function_calling` (already installed; `zod-to-json-schema` is verified ABSENT and must NOT be imported — research Recommendation 2). The non-streaming `runOneShot` path has no stream events and is captured at the runner layer from `result['messages']` plus a checkpointer pre-read. The switch is BOTH a launch CLI flag (`--inspect-io`, `--inspect-io-raw`) and an in-session TUI slash (`/inspect on|off|show|status`). Redaction is ON by default; `--inspect-io-raw` / `CLI_AGENT_INSPECT_IO_RAW=1` opts out for captures only, with a prominent stderr warning. No new runtime dependency is introduced.

## Open Questions
none

(All product/scope decisions are fixed by the refined request's resolved Open Questions. The two scan-vs-reality refinements discovered during verification — the slash-import registration site and the `runOneShot` non-options signature — are mechanical and resolved inside the steps below, not open questions.)

## Steps

### Step 1 — Config: add inspector flags, env keys, resolved shape, capture-dir helper, bootstrap, and no-fallback resolution
- **depends_on:** none
- **files:** `src/config/agent-config.ts` (modify)
- **action:** Extend the four-tier config surface for the inspector. (a) Add `readonly inspectIo?: boolean;` and `readonly inspectIoRaw?: boolean;` to the `AgentCliFlags` interface (currently lines 256-351). (b) Add `inspectIo?: { enabled?: boolean; redact?: boolean; dir?: string }` to the `AgentConfigFile` interface. (c) Add resolved `inspectIo: { enabled: boolean; redact: boolean; dir: string } | null` to the `AgentConfig` interface (use `null`, never silently defaulted, when not requested). (d) Add a new exported `agentIoCapturesDir(): string` helper returning `path.join(agentToolAgentsDir(), 'io-captures')`, modeled exactly on `agentLogsDir()` (line 414). (e) Add `'CLI_AGENT_INSPECT_IO'` and `'CLI_AGENT_INSPECT_IO_RAW'` to the `OTHER_ENV_KEYS` array (lines 692-721) so they flow through `ALL_ENV_KEYS`, `.env` loading, and the provider-env snapshot. (f) In `bootstrapAgentDir` (lines 420-563), add an `io-captures` directory creation block mirroring the existing `logsDir` block: `await fsp.mkdir(ioCapturesDir, { recursive: true, mode: 0o700 }); try { await fsp.chmod(ioCapturesDir, 0o700); } catch { /* tolerated */ }`. (g) In `loadAgentConfig`, add a resolution step (four-tier: CLI flag `flags.inspectIo` → env `CLI_AGENT_INSPECT_IO` → `config.json` `inspectIo.enabled` → resolved value): when the inspector is NOT requested, set `inspectIo: null`; when requested, set `enabled: true`, `redact: !(flags.inspectIoRaw || truthy CLI_AGENT_INSPECT_IO_RAW || config inspectIo.redact === false)`, and `dir: <config inspectIo.dir or agentIoCapturesDir()>`. If `enabled` is requested but the resolved `dir` cannot be created/accessed, throw `ConfigurationError` (no fallback to "disabled"). Validate any invalid `CLI_AGENT_INSPECT_IO` value (non-boolean string) by raising `ConfigurationError` via the existing `parseBooleanEnvVar` machinery — do NOT default. Follow the exact precedence idiom used for the agent-tools umbrella (`resolveOne` pattern around lines 1132-1182). Add a `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW` commented placeholder pair to the seeded `.env` block inside `bootstrapAgentDir` (under a `# --- LLM I/O inspector ---` header), all lines commented, never a real value.
- **verify:** `npm run typecheck` passes; `npx vitest run src/agent/io-capture.spec.ts` is not yet expected to pass (created later) — for this step run `node -e "const m=require('./dist/config/agent-config.js')" ` after `npm run build`, OR simply `npm run typecheck`. Grep confirms additions: `grep -n "agentIoCapturesDir\|CLI_AGENT_INSPECT_IO\b\|inspectIo" src/config/agent-config.ts` returns the new symbol, the two env keys, and the interface fields.
- **done:** `agentIoCapturesDir`, `CLI_AGENT_INSPECT_IO`, `CLI_AGENT_INSPECT_IO_RAW`, and the `inspectIo` fields on all three interfaces exist; `loadAgentConfig` resolves `inspectIo` via four-tier order and raises `ConfigurationError` on an un-creatable dir or invalid mode value with no fallback; `bootstrapAgentDir` creates `io-captures/` at `0700`; `npm run typecheck` is green.

### Step 2 — CLI: register `--inspect-io` / `--inspect-io-raw` on the agent command and map into AgentCliFlags
- **depends_on:** [1]
- **files:** `src/cli.ts` (modify)
- **action:** On the default `agent` command definition, immediately after the existing `.option('--system-file <path>', ...)` registration (line 92), add `.option('--inspect-io', 'Enable LLM I/O capture (writes provider-normalized request/response JSONL to ~/.tool-agents/cli-agent/io-captures/)')` and `.option('--inspect-io-raw', 'Disable redaction for I/O captures only (use with caution; prints a warning)')`. In the `AgentCliFlags` object literal assembled from `opts` (lines 219-234, where `system`/`systemFile`/`systemPromptFile` are mapped), add `inspectIo: opts['inspectIo'] as boolean | undefined,` and `inspectIoRaw: opts['inspectIoRaw'] as boolean | undefined,`. Do not alter `handleErrors` (it already routes `ConfigurationError`/`UsageError`). Confirm the new flags do not collide with `mapAgentToolFlags` wiring (they don't — different flag names).
- **verify:** `npm run build` then `node dist/cli.js --help | grep -E "inspect-io"` shows both options; `npm run typecheck` green. (The `cli-help-baseline.spec.ts` test will now FAIL — that is expected and is fixed deliberately in Step 16.)
- **done:** `cli-agent --help` lists `--inspect-io` and `--inspect-io-raw`; both flags arrive in `loadAgentConfig` via `AgentCliFlags`; typecheck green.

### Step 3 — Capture core: define IoCapture types, interface, record schema, and serialization helpers
- **depends_on:** none
- **files:** `src/agent/io-capture.ts` (create)
- **action:** Create the new parallel capture channel module. Define: (a) the `CapturedMessage` interface `{ role: 'system'|'human'|'ai'|'tool'|string; content: string; toolCalls?: Array<{ id?: string; name: string; args: unknown }>; toolCallId?: string }`; (b) a `BoundToolSchema` type `{ name: string; description: string; parameters: unknown }`; (c) the typed `IoCaptureRecord` union — `{ kind: 'request'; sessionId; threadId; turnId; stepIndex; ts; messages: CapturedMessage[]; boundTools?: BoundToolSchema[] }`, `{ kind: 'response'; sessionId; threadId; turnId; stepIndex; ts; finalText: string; toolCalls: Array<{ id?: string; name: string; args: unknown }> }`, and `{ kind: 'tool_result'; sessionId; threadId; turnId; stepIndex; ts; toolName: string; ok: boolean; durationMs: number; result?: unknown }` (FR-4c); (d) the `IoCapture` interface with `readonly boundToolSchemas: ReadonlyArray<BoundToolSchema>`, `readonly currentSessionId: string`, `captureRequest(rec)`, `captureResponse(rec)`, `captureToolResult(rec)`, `read(): IoCaptureRecord[]` (for `/inspect show`), and `close(): Promise<void>`; (e) the exported pure helpers `toCaptureMessage(m: BaseMessage): CapturedMessage` (reads `m._getType?.()`, normalizes `content` string-or-block-array, copies `tool_calls`/`tool_call_id`) and `extractStartMessages(input: unknown): BaseMessage[]` (defensive flatten over bare-array / `{messages: BaseMessage[]}` / `{messages: BaseMessage[][]}` — research Q2) and `captureBoundToolSchemas(tools): BoundToolSchema[]` using `import { convertToOpenAITool } from '@langchain/core/utils/function_calling'` (NOT `zod-to-json-schema`). Use `import type { BaseMessage, AIMessageChunk } from '@langchain/core/messages'` and `import type { DynamicStructuredTool } from '@langchain/core/tools'`. Do NOT extend `LogEvent` and do NOT modify `logging.ts`. Note in the action that this step defines types/interface/helpers only; the file-writing `FileIoCapture`, the no-op `NullIoCapture`, and the `createIoCapture` factory are added in Step 4.
- **verify:** `npm run typecheck` green; `grep -n "convertToOpenAITool\|zod-to-json-schema" src/agent/io-capture.ts` shows the former present and the latter ABSENT.
- **done:** `IoCapture`, `IoCaptureRecord`, `CapturedMessage`, `toCaptureMessage`, `extractStartMessages`, `captureBoundToolSchemas` are exported and typecheck; no import of `zod-to-json-schema`; no edit to `logging.ts`.

### Step 4 — Capture core: implement FileIoCapture + NullIoCapture + createIoCapture factory (filesystem + redaction + truncation)
- **depends_on:** [1, 3]
- **files:** `src/agent/io-capture.ts` (modify)
- **action:** Implement the three concrete pieces. (a) `NullIoCapture` — a no-op `IoCapture` whose `boundToolSchemas` is `[]`, whose capture methods do nothing, whose `read()` returns `[]`, and whose `close()` resolves; this is the ONLY instance used when the switch is off (NFR-1). (b) `FileIoCapture implements IoCapture` — opens its file with `fs.openSync(path, O_WRONLY | O_CREAT | O_APPEND, 0o600)` exactly as `FileLogger.open()` (logging.ts:133-135), under `agentIoCapturesDir()`, using a `formatSessionFilename`-equivalent UTC name `session-<UTC>-<sessionId>.jsonl`, and maintains the `latest.jsonl` symlink (with copy-skip fallback) exactly as `createLogger` (logging.ts:160-173). It holds the in-memory `IoCaptureRecord[]` so `read()` can serve `/inspect show` without re-reading disk. Its private `serialize(rec)` applies the 64 KiB field-cap with `_truncated: true` + `_orig_size_bytes` marker to large string fields (system-prompt/memory `content`) reusing the `FIELD_TRUNCATE_BYTES = 64*1024` discipline from `truncateEvent` (logging.ts:64-82), then applies `redactString` to message `content` and `redactObject` to tool-call `args` (research best-practice 7) UNLESS the instance was constructed with `redact: false`. Writes are wrapped in a local `try/catch { /* swallow — capture must never break the agent */ }` matching logging.ts:116. (c) `createIoCapture(cfg: AgentConfig, sessionId: string, tools: DynamicStructuredTool[]): IoCapture` factory — returns `NullIoCapture` when `cfg.inspectIo === null`; otherwise builds `boundToolSchemas = captureBoundToolSchemas(tools)`, and when `cfg.inspectIo.redact === false` writes a prominent one-line warning to `process.stderr` BEFORE opening the file (e.g. `[cli-agent] WARNING: --inspect-io-raw is set — I/O captures are written WITHOUT redaction; secrets/API keys in the system prompt, memory, or tool args will be stored in plaintext under <dir>.`), then constructs and returns a `FileIoCapture`. If the directory cannot be created here, throw `ConfigurationError` (no fallback). Reuse `agentIoCapturesDir` from Step 1.
- **verify:** `npm run typecheck` green; `npm run build` succeeds. (Behavioural assertions come in Steps 11-15.)
- **done:** `NullIoCapture`, `FileIoCapture`, and `createIoCapture` are exported; `FileIoCapture` opens `0600` files under `io-captures/`, maintains `latest.jsonl`, applies truncation + redaction (skippable), and swallows write errors; the raw opt-out emits a stderr warning before opening; typecheck + build green.

### Step 5 — Graph: extend StreamOneShotOptions and add the on_chat_model_start request hook + on_chat_model_end response hook
- **depends_on:** [3]
- **files:** `src/agent/graph.ts` (modify)
- **action:** Wire the capture into the streaming loop. (a) Extend the `StreamOneShotOptions` interface (lines 137-141) with `readonly ioCapture?: IoCapture;` — `import type { IoCapture } from './io-capture.js'` plus `import { extractStartMessages, toCaptureMessage } from './io-capture.js'`. (b) Inside `streamOneShot` (lines 159-279), read `const ioCapture = opts.ioCapture;` and declare `let stepIndex = 0;` near the existing `assembledText`/`toolCallsObserved` declarations. (c) Add a NEW `case 'on_chat_model_start':` to the event switch that, when `ioCapture` is set, calls `ioCapture.captureRequest({ sessionId, threadId, turnId, stepIndex, ts: new Date().toISOString(), messages: extractStartMessages(event.data?.input).map(toCaptureMessage), boundTools: stepIndex === 0 ? [...ioCapture.boundToolSchemas] : undefined })` (denormalize schemas onto the first request per turn only — research best-practice 4). (d) In the EXISTING `case 'on_chat_model_end':` (currently lines ~237-249), AFTER the existing `logger.log({ kind: 'llm_final', ... })` block, add `if (ioCapture) { const out = event.data?.output as AIMessageChunk | undefined; const finalText = out ? normalizeContent(out.content) : assembledText; const toolCalls = (out?.tool_calls ?? []).map(tc => ({ id: tc.id, name: tc.name, args: tc.args })); ioCapture.captureResponse({ sessionId, threadId, turnId, stepIndex, ts: new Date().toISOString(), finalText, toolCalls }); }` then increment `stepIndex += 1;` (read `tool_calls` from the END output, not per-chunk — research pitfalls 2/3). (e) In the existing `case 'on_tool_end':`, when `ioCapture` is set, also call `ioCapture.captureToolResult({ sessionId, threadId, turnId, stepIndex, ts, toolName, ok: true, durationMs })` so the request→tool-result chain is inspectable (FR-4c). Widen the `event.data` inline type to include `output?: unknown` (already present) and `chunk` with `tool_calls` — the existing inline type already covers `output`/`input`; add `tool_calls` to the chunk shape only if a cast isn't already used. Do NOT change any yielded `AgentStreamEvent` values, the logger calls, or `assembledText` — the off path (no `ioCapture`) must be byte-identical (NFR-1).
- **verify:** `npm run typecheck` green; `grep -n "on_chat_model_start\|ioCapture" src/agent/graph.ts` shows the new case and the three hook calls; visually confirm the existing `logger.log` lines and yields are unchanged.
- **done:** `StreamOneShotOptions.ioCapture` exists; `streamOneShot` captures request on `on_chat_model_start`, response on `on_chat_model_end`, and tool-results on `on_tool_end`, only when `ioCapture` is present; no change to existing logger output or yielded events; typecheck green.

### Step 6 — Run layer (streaming): instantiate IoCapture in streamOneShotAgent and thread it into streamOneShot
- **depends_on:** [1, 4, 5]
- **files:** `src/agent/run.ts` (modify)
- **action:** In `streamOneShotAgent` (lines 122-227), after `const { tools, agentToolsMeta } = buildToolCatalog(cfg, logger);` and after `sessionId` is known, add `const ioCapture = createIoCapture(cfg, sessionId, tools);` (`import { createIoCapture } from './io-capture.js'`). Add `ioCapture` to the `opts` object passed to `streamOneShot` (the `{ logger, sessionId, abortSignal? }` literal around lines 194-198) → add `ioCapture`. In the existing `finally` block (lines ~216-225, where `logger.close()` is awaited), add `await ioCapture.close();` after `await logger.close();`. Do not alter the system-prompt assembly, the `session_start` log, or any provider behaviour — when `cfg.inspectIo === null`, `createIoCapture` returns `NullIoCapture` and nothing changes.
- **verify:** `npm run typecheck` green; `grep -n "createIoCapture\|ioCapture" src/agent/run.ts` shows instantiation, the opts wiring, and the close call.
- **done:** `streamOneShotAgent` builds an `IoCapture` from `cfg`+`tools`, passes it into `streamOneShot`, and closes it in `finally`; off-state returns `NullIoCapture`; typecheck green.

### Step 7 — Run layer (non-streaming + TUI runtime): capture runOneShot from result['messages'] and add ioCapture to TuiAgentRuntime
- **depends_on:** [1, 4, 5]
- **files:** `src/agent/run.ts` (modify), `src/agent/graph.ts` (modify)
- **action:** Two non-streaming integrations. (a) **runOneShot capture (FR-4 invoke path):** `runOneShot` (graph.ts:91-133) currently takes NO options object. Add an optional 5th parameter `opts: { ioCapture?: IoCapture; sessionId?: string } = {}` to `runOneShot`'s signature WITHOUT changing existing call sites' behaviour (the param is optional). After `const result = await agentGraph.graph.invoke(...)`, when `opts.ioCapture` is set: read `const messages = result['messages'] as BaseMessage[]`, capture a single `captureRequest` for the turn (messages up to and including the last human message, `stepIndex: 0`, with `boundTools`), then iterate `messages` and for each AI message with non-empty `.tool_calls` call `captureResponse`/`captureToolResult` as appropriate, and a final `captureResponse` for the terminal AI text (research Q3 non-streaming block). Mint a `turnId` via `randomUUID()` inside `runOneShot` for correlation. `import type { BaseMessage } from '@langchain/core/messages'`. (b) **Runner instantiation for `runOneShotAgent`:** in the `runOneShotAgent` function, build `const ioCapture = createIoCapture(cfg, sessionId, tools);` and pass `{ ioCapture, sessionId }` into the `runOneShot(...)` call; close it in the same `finally`/cleanup path used for `logger`. (c) **TUI runtime:** extend the `TuiAgentRuntime` interface to add `readonly ioCapture: IoCapture;`, and in `buildTuiAgentRuntime` (lines 240-287) build `const ioCapture = createIoCapture(cfg, sessionId, tools);` after `buildToolCatalog`, and return it as a fourth member `{ agentGraph, logger, sessionId, ioCapture }`. Off-state stays `NullIoCapture` everywhere.
- **verify:** `npm run typecheck` green; `grep -n "ioCapture" src/agent/run.ts` shows instantiation in both `runOneShotAgent` and `buildTuiAgentRuntime`; `grep -n "opts.ioCapture\|opts: {" src/agent/graph.ts` shows the new `runOneShot` parameter.
- **done:** `runOneShot` accepts an optional capture-opts param and records request/response/tool-results from `result['messages']` when present; `runOneShotAgent` and `buildTuiAgentRuntime` instantiate and (for the one-shot path) close an `IoCapture`; `TuiAgentRuntime` carries `ioCapture`; existing call sites unaffected; typecheck green.

### Step 8 — TUI controller: accept and store ioCapture, expose it to slash context
- **depends_on:** [4, 7]
- **files:** `src/tui/controller.ts` (modify)
- **action:** Thread the capture channel into the TUI. (a) Add `readonly ioCapture: IoCapture;` to `TuiControllerOptions` (lines 83-89) and `import type { IoCapture } from '../agent/io-capture.js'`. (b) Store it as a public field on `TuiController` (assigned in the constructor from `opts.ioCapture`, alongside the existing `agentGraph`/`logger` fields the constructor already wires). (c) `makeSlashContext` (lines 128-134) already passes `controller: this`, so `/inspect` reaches the capture via `ctx.controller.ioCapture` — no change to `SlashContext` is required. (d) In `runTurn` (lines 198-319), do NOT add an interleaved capture call into the render loop — the capture already happens inside `streamOneShot` via the injected `ioCapture` (the controller's `streamOneShot` call at line ~232 currently passes `{ logger, sessionId, abortSignal }`; ADD `ioCapture: this.ioCapture` to that opts object). The response/tool-result capture is thus a side-effect of the event loop already running, with no spinner/stdout race (NFR-2). Update the caller of `new TuiController({...})` (in `src/tui/index.ts`'s `startTui`, where `buildTuiAgentRuntime`'s result is destructured) to forward `ioCapture: runtime.ioCapture` — note this edit lands in Step 10's file but is called out here as the controller's contract.
- **verify:** `npm run typecheck` green; `grep -n "ioCapture" src/tui/controller.ts` shows the option, the field, and the addition to the `streamOneShot` opts in `runTurn`.
- **done:** `TuiController` receives `ioCapture` via options, stores it as a field, passes it into the `streamOneShot` opts inside `runTurn`, and exposes it through `makeSlashContext`'s `controller`; typecheck green.

### Step 9 — TUI slash: implement the /inspect command (on|off|show [turn]|status)
- **depends_on:** [4, 8]
- **files:** `src/tui/slash/inspect.ts` (create)
- **action:** Create the `/inspect` slash command following the `src/tui/slash/memory.ts` template byte-for-byte in structure: `import { registerCommand, type SlashCommand } from './registry.js'`, `import { BOLD, DIM, RESET, CYAN } from '../ansi.js'`, define `const inspectCmd: SlashCommand = { name: '/inspect', aliases: ['/inspect-io'], summary: 'Inspect the captured LLM request/response for a turn', async run(ctx, args) { ... } }`, end with `registerCommand(inspectCmd); export default inspectCmd;`. The `run` handler parses `args[0]`: (i) `status` (and no-arg default) → print whether capture is active (`ctx.controller.ioCapture` is a `FileIoCapture` vs `NullIoCapture`), the capture file path, and the number of records captured this session; (ii) `show [turn]` → read `ctx.controller.ioCapture.read()`, group records by `turnId` in order, select the requested 1-based turn (or the latest when omitted), and render it via `ctx.println`/`ctx.printSystem` with clearly delimited, labelled sub-blocks — `Turn N · <ts>`, a REQUEST section (system prompt, memory messages by role, current user content, bound tool schemas) and a RESPONSE section (assistant text, each tool-call name+args, each tool result) per FR-6, truncating each long block with a visible `… [truncated]` marker for readability; (iii) `on`/`off` → emit a clear `[system]` message that mid-session enable/disable of file capture requires a relaunch with/without `--inspect-io` (the file writer + bound-tool snapshot are established at runtime build), i.e. `/inspect on|off` toggles only whether `/inspect show` reads from the active channel — document this limitation in the message rather than silently no-op (honours NFR re: no silent fallback and the request's "TUI slash toggle" intent within the constraint that the JSONL writer is wired at session build). All output goes through `ctx.println`/`ctx.printSystem` (same stdout path as every other command — no spinner race, NFR-2). Use `try/catch` around the read, printing a `failed to read captures: <msg>` system line on error (matching memory.ts:40-42).
- **verify:** `npm run typecheck` green; `grep -n "registerCommand\|export default\|name: '/inspect'" src/tui/slash/inspect.ts` confirms the registry pattern.
- **done:** `src/tui/slash/inspect.ts` exports `inspectCmd` (default + registered), handles `status`/`show [turn]`/`on`/`off`, renders a turn in clearly labelled request/response sub-blocks via the controller's stdout methods, and reads from `ctx.controller.ioCapture`; typecheck green.

### Step 10 — TUI wiring: register the /inspect command and forward ioCapture from runtime to controller
- **depends_on:** [8, 9]
- **files:** `src/tui/index.ts` (modify)
- **action:** Two edits in the TUI entry module (the actual slash-command registration hub — NOT `registry.ts`; the side-effect import list lives at `src/tui/index.ts` lines 21-36). (a) Add `import './slash/inspect.js';` to that import block (after `import './slash/memory.js';`) so the command self-registers (mirrors every other command). (b) In `startTui`, where `const runtime = await buildTuiAgentRuntime(cfg);` is destructured/used to construct `new TuiController({ cfg, agentGraph: runtime.agentGraph, logger: runtime.logger, ... })`, add `ioCapture: runtime.ioCapture` to the `TuiControllerOptions` literal so the (possibly `NullIoCapture`) channel reaches the controller. Confirm `runtime.ioCapture` exists (added in Step 7).
- **verify:** `npm run build` then run a non-TTY smoke (`CLI_AGENT_NO_TUI=1` path is irrelevant here) — instead `grep -n "slash/inspect.js\|runtime.ioCapture" src/tui/index.ts` confirms both edits; `npm run typecheck` green.
- **done:** `/inspect` is imported (self-registers and appears in `/help`); `TuiController` is constructed with `ioCapture: runtime.ioCapture`; typecheck + build green.

### Step 11 — Test: capture content fidelity (request + response + provider-neutral structure)
- **depends_on:** [4, 5, 7]
- **files:** `src/agent/io-capture.spec.ts` (create)
- **action:** Create the Vitest spec. Add unit tests that exercise the pure helpers and the `FileIoCapture` record shape WITHOUT a live LLM: (a) `toCaptureMessage` correctly maps fabricated `SystemMessage`/`HumanMessage`/`AIMessage` (with `tool_calls`)/`ToolMessage` (with `tool_call_id`) instances from `@langchain/core/messages` into `CapturedMessage` (role, content, toolCalls, toolCallId); (b) `extractStartMessages` flattens all three documented shapes (bare `BaseMessage[]`, `{ messages: BaseMessage[] }`, `{ messages: BaseMessage[][] }`) — research Q2; (c) `captureBoundToolSchemas` over a small `DynamicStructuredTool` (built with a Zod schema) yields `{ name, description, parameters }` where `parameters` is a JSON-Schema object (asserts `convertToOpenAITool` path, and that NO `zod-to-json-schema` import is needed); (d) a `FileIoCapture` written to a `tmpdir` produces a JSONL file whose parsed `request` record contains the system message + memory + user content and whose `response` record contains `finalText` + parsed `toolCalls` (args as objects), correlated by `sessionId`/`threadId`/`turnId`/`stepIndex` (FR-5, AC-2/AC-3); (e) the record structure is provider-neutral — feeding messages that imitate an Anthropic content-block array vs an OpenAI plain-string content yields the same `CapturedMessage` shape (AC-8). Write the temp dir under `os.tmpdir()` and clean up in `afterEach`.
- **verify:** `npx vitest run src/agent/io-capture.spec.ts` — these tests pass.
- **done:** Content-fidelity and provider-neutrality tests pass; assertions cover request/response capture, correlation IDs, and the OpenAI-normalized schema path.

### Step 12 — Test: redaction default ON + raw opt-out, and 64 KiB truncation marker
- **depends_on:** [4]
- **files:** `src/agent/io-capture.spec.ts` (modify)
- **action:** Add tests: (a) feed a known secret-shaped string (e.g. a bearer token / `OPENAI_API_KEY=sk-...`-style value) through a `FileIoCapture` built with `redact: true` (the default) inside both a message `content` and a tool-call `args` object, and assert the masked form appears in the written JSONL and the raw secret does NOT (AC-5, research best-practice 7 — redact both content and args via `redactString`/`redactObject`); (b) build a `FileIoCapture` with `redact: false`, capture the same secret, and assert it appears verbatim (AC-5 opt-out) AND that `createIoCapture` with `cfg.inspectIo.redact === false` wrote the stderr warning (spy on `process.stderr.write`); (c) capture a `content` string larger than `FIELD_TRUNCATE_BYTES` (64 KiB) and assert the written record's field is truncated and carries `_truncated: true` + `_orig_size_bytes` (NFR-3, AC matches logging discipline).
- **verify:** `npx vitest run src/agent/io-capture.spec.ts` — these tests pass.
- **done:** Redaction-default, raw-opt-out (with warning), and truncation-marker tests pass.

### Step 13 — Test: switch precedence (four-tier) and error-on-misconfiguration (no fallback)
- **depends_on:** [1]
- **files:** `src/agent/io-capture.spec.ts` (modify)
- **action:** Add config-resolution tests driving `loadAgentConfig` (or the inspector-resolution helper) with controlled env / config.json / flags: (a) CLI flag `inspectIo: true` wins over env `CLI_AGENT_INSPECT_IO` unset and config absent → `cfg.inspectIo.enabled === true`; (b) env `CLI_AGENT_INSPECT_IO=1` with no flag enables; (c) `config.json` `{ inspectIo: { enabled: true } }` with no flag/env enables; (d) nothing set → `cfg.inspectIo === null` (off, no capture); (e) `--inspect-io-raw` / `CLI_AGENT_INSPECT_IO_RAW=1` flips `redact` to `false`; (f) **no-fallback:** requesting the inspector with an un-creatable/unwritable `dir` (point `inspectIo.dir` at a path under a read-only parent, or stub `mkdirSync`/`fsp.mkdir` to throw) makes `loadAgentConfig` / `createIoCapture` throw `ConfigurationError` with the correct exit code — assert it does NOT silently produce `inspectIo: null` or a `NullIoCapture` (AC-7, FR-10); (g) an invalid `CLI_AGENT_INSPECT_IO` value (e.g. `maybe`) throws `ConfigurationError` rather than defaulting.
- **verify:** `npx vitest run src/agent/io-capture.spec.ts` — these tests pass.
- **done:** Four-tier precedence, raw-flag precedence, off-state (`null`), and no-fallback error tests pass.

### Step 14 — Test: capture writer filesystem conventions (0700 dir / 0600 file / latest pointer / UTC name)
- **depends_on:** [4]
- **files:** `src/agent/io-capture.spec.ts` (modify)
- **action:** Add a test that constructs a `FileIoCapture` against a temp agent dir and asserts (skipping the mode assertions on `process.platform === 'win32'`): the `io-captures/` directory exists at mode `0700`, the session file exists at mode `0600`, the filename matches the `session-<UTC>-<sessionId>.jsonl` pattern, and a `latest.jsonl` pointer resolves to the session file (AC-9). Use `fs.statSync(...).mode & 0o777` for mode checks, mirroring any existing logging/transcript persistence test if present.
- **verify:** `npx vitest run src/agent/io-capture.spec.ts` — this test passes (or is skipped on Windows).
- **done:** Filesystem-convention test passes on POSIX; mode/name/latest assertions hold.

### Step 15 — Test: off-state byte-stability regression (NFR-1)
- **depends_on:** [5, 6, 7]
- **files:** `src/agent/io-capture.spec.ts` (modify)
- **action:** Add the off-state byte-stability assertion mirroring the `cli-help-baseline.spec.ts` discipline at the capture layer: assert that when `cfg.inspectIo === null`, `createIoCapture(cfg, sessionId, tools)` returns a `NullIoCapture` whose capture methods are provable no-ops (call `captureRequest`/`captureResponse`/`captureToolResult` and assert no file is created under `io-captures/` and `read()` stays empty), so the streaming/invoke paths produce zero capture side-effects when off. (The `--help` byte-stability is covered by the regenerated baseline + the existing `cli-help-baseline.spec.ts` in Step 16; the provider-payload / log-line / transcript byte-stability is guaranteed structurally because `LogEvent`, `system-prompt.ts`, and the transcript writer are untouched — note this reasoning in a test comment.)
- **verify:** `npx vitest run src/agent/io-capture.spec.ts` — passes; then `npm test` to confirm the FULL existing suite (logging, transcript, system-prompt, registry specs) is still green (proves no collateral byte change), EXCEPT `cli-help-baseline.spec.ts` which is fixed in Step 16.
- **done:** Off-state no-op test passes; full suite green except the deliberately-pending help baseline (Step 16); the byte-stability reasoning is documented in the spec.

### Step 16 — Regenerate the --help baseline (deliberate, reviewed)
- **depends_on:** [2, 15]
- **files:** `test_scripts/baselines/help-no-treat-as-tool.txt` (modify)
- **action:** After the build includes the new flags, deliberately regenerate the byte-stable help baseline that `src/cli-help-baseline.spec.ts` compares against: run `npm run build` then `node dist/cli.js --help > test_scripts/baselines/help-no-treat-as-tool.txt`. Review the diff to confirm the ONLY additions are the two new `--inspect-io` / `--inspect-io-raw` lines (and nothing else shifted). This is a conscious, reviewed regeneration per the scan §5 and the project's byte-stability discipline — never an automated overwrite.
- **verify:** `npx vitest run src/cli-help-baseline.spec.ts` passes; `git diff --stat test_scripts/baselines/help-no-treat-as-tool.txt` shows only the inspector-flag additions.
- **done:** The help baseline includes exactly the two new flag lines; `cli-help-baseline.spec.ts` is green again.

### Step 17 — Docs: update the cli-agent tool documentation
- **depends_on:** [2, 9, 10]
- **files:** `docs/tools/cli-agent.md` (modify)
- **action:** Update the existing `<cliAgent>` tool doc (this is an EXTENSION of the existing tool — NO new tool scaffold, no new `~/.tool-agents/<name>/` folder). Document: the `--inspect-io` / `--inspect-io-raw` launch flags and the `/inspect on|off|show [turn]|status` slash commands; the capture location `~/.tool-agents/cli-agent/io-captures/session-<UTC>-<sessionId>.jsonl` + `latest.jsonl`; the JSONL record schema (request/response/tool_result with `sessionId`/`threadId`/`turnId`/`stepIndex`); the provider-normalized fidelity (and the deferred wire-byte limitation); the redaction-ON default and the raw opt-out's risk; the "tail in a second terminal" usage and the in-TUI `/inspect show` renderer. Keep it within the existing doc's structure/tone.
- **verify:** `grep -n "inspect-io\|/inspect\|io-captures" docs/tools/cli-agent.md` shows the new content.
- **done:** The tool doc describes the switch, slash commands, capture format/location, fidelity, and redaction policy/opt-out.

### Step 18 — Docs: register functional requirements in project-functions.md
- **depends_on:** none
- **files:** `docs/design/project-functions.md` (modify)
- **action:** Append a new "LLM I/O Inspector" feature section registering FR-1..FR-12 and NFR-1..NFR-6 verbatim from the refined request (the switch, separate surface, exact request capture incl. system prompt/memory/user content/tool schemas, exact response capture incl. tool-calls/tool-results, turn correlation, descriptive rendering, live-write+replay, persistence+retrieval, redaction policy, no-fallback config, reuse-don't-duplicate, provider neutrality; and the NFRs: off-state byte-stability, TUI safety, performance/truncation, security/permissions, TS/ESM consistency, documentation completeness). Cross-reference this plan (`plan-007-llm-io-inspector.md`). Match the file's existing FR/NFR formatting.
- **verify:** `grep -n "FR-1 \|NFR-1 \|I/O Inspector\|plan-007" docs/design/project-functions.md` shows the new section and its requirements.
- **done:** `project-functions.md` contains the inspector feature with FR-1..FR-12 and NFR-1..NFR-6 and references plan-007.

### Step 19 — Docs: reflect the design in project-design.md
- **depends_on:** none
- **files:** `docs/design/project-design.md` (modify)
- **action:** Add a section describing the I/O inspector architecture: the dedicated parallel capture channel (`src/agent/io-capture.ts`) sibling to the operational logger; the single provider-neutral hook at the `streamEvents` `on_chat_model_start`/`on_chat_model_end` boundary plus the non-streaming `result['messages']` path; the `createIoCapture` factory returning `NullIoCapture` when off (off-state byte-stability); the reuse of `redact.ts`, the 64 KiB field-cap, and the `0700`/`0600`+`latest.jsonl` filesystem contract; the `convertToOpenAITool` schema-serialization decision (and why `zod-to-json-schema` is NOT used — no new dependency); and the in-TUI `/inspect` surface vs the tailable JSONL file. Note the deferred follow-ups (wire-byte capture, discovery/synthesis-call capture, detached-window wrapper). Match the existing design-doc structure.
- **verify:** `grep -n "io-capture\|I/O inspector\|convertToOpenAITool\|on_chat_model_start" docs/design/project-design.md` shows the new section.
- **done:** `project-design.md` describes the capture channel, hook seam, factory/off-state, reuse, schema decision, and deferred items.

### Step 20 — Docs: configuration-guide treatment of the new variables
- **depends_on:** [1]
- **files:** `docs/design/configuration-guide.md` (modify)
- **action:** Add a configuration-guide entry for the inspector variables per the project's configuration-guide rule: for `CLI_AGENT_INSPECT_IO` (+ flag `--inspect-io`, + `config.json` `inspectIo.enabled`) and `CLI_AGENT_INSPECT_IO_RAW` (+ flag `--inspect-io-raw`, + `config.json` `inspectIo.redact`) and `inspectIo.dir`, document: purpose; how to set each; the four-tier precedence (shell env → `~/.tool-agents/cli-agent/.env` → local `.env` → CLI flag) and that the CLI flag wins; the default values (capture OFF by default; when ON, redaction ON by default, dir = `~/.tool-agents/cli-agent/io-captures/`); the recommended storage (these are non-secret toggles — set per-invocation via flag, or in `.env` for a persistent session preference); the explicit risk note that `--inspect-io-raw` disables redaction and writes secrets in plaintext, and that captures are NOT auto-pruned (user's responsibility). No expiration-date parameter applies (no expiring credential), but state that explicitly per the rule.
- **verify:** `grep -n "CLI_AGENT_INSPECT_IO\|--inspect-io\|inspectIo" docs/design/configuration-guide.md` shows the new entries with precedence + default + risk note.
- **done:** `configuration-guide.md` documents both env vars + flags + the config key, their precedence, defaults, storage recommendation, and the raw opt-out risk + no-auto-prune note.

### Step 21 — Full verification: build, typecheck, complete test suite
- **depends_on:** [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]
- **files:** none
- **action:** Run the full project gates to confirm the feature lands cleanly and nothing regressed. Confirm the new capture spec passes, the regenerated help baseline passes, and the entire pre-existing suite stays green.
- **verify:** `npm run typecheck` green; `npm run build` succeeds; `npm test` fully green (including `src/agent/io-capture.spec.ts`, `src/cli-help-baseline.spec.ts`, and all prior specs).
- **done:** typecheck + build + the complete `npm test` suite all pass.

## Implementation Units

Units B (capture core types/factory) is the foundation: its `IoCapture` interface and `createIoCapture` factory MUST land before Units C (graph/run hooks) and D (TUI/slash) can consume them, and before the test Unit E can assert behaviour. Unit A (config) is an independent prerequisite for the `inspectIo` resolved shape and `agentIoCapturesDir` that B's factory and C/D's instantiation read. Within those constraints the file sets are pairwise-disjoint and can be coded in parallel once their dependencies are met. Recommended fan-out order: **A and B in parallel first** → then **C and D in parallel** → then **E** (tests) → then **F** (docs, fully parallel, depends only on the code shapes being decided) → then **G** (final verification). Step-level `depends_on` fields encode the precise ordering; the unit grouping below guarantees no two concurrently-runnable units write the same file.

### Unit A — Config wiring + CLI flags
- **steps:** 1, 2, 16
- **files:** `src/config/agent-config.ts`, `src/cli.ts`, `test_scripts/baselines/help-no-treat-as-tool.txt`
- **interface contract consumed by others:** `AgentConfig.inspectIo: { enabled; redact; dir } | null`, `AgentCliFlags.inspectIo`/`inspectIoRaw`, the exported `agentIoCapturesDir()` helper, and the two env keys. (Step 16, the help-baseline regeneration, also touches `src/cli.ts`'s output and so belongs to this file-set/unit; it is ordered last because it depends on Step 2's flags AND Step 15's suite state.)

### Unit B — Capture core (IoCapture channel)
- **steps:** 3, 4, 14
- **files:** `src/agent/io-capture.ts`, `src/agent/io-capture.spec.ts`
- **interface contract this exposes:** `IoCapture` interface, `IoCaptureRecord` union, `CapturedMessage`, the `createIoCapture(cfg, sessionId, tools)` factory, `NullIoCapture`, and the pure helpers `toCaptureMessage`/`extractStartMessages`/`captureBoundToolSchemas`. (Note: `io-capture.spec.ts` is shared with Unit E — Steps 14/11/12/13/15 all append to that one spec file, so the spec-writing steps must be sequenced, not run as two concurrent units against the same file. They are listed across B and E for narrative grouping but share the file; treat the spec as a single serialized work item executed after the code it tests exists.)

### Unit C — Graph + runner hooks
- **steps:** 5, 6, 7
- **files:** `src/agent/graph.ts`, `src/agent/run.ts`
- **interface contract consumed:** Unit B's `IoCapture`/`createIoCapture`/helpers and Unit A's `AgentConfig.inspectIo`. Exposes: `StreamOneShotOptions.ioCapture`, the `runOneShot` optional capture-opts param, and `TuiAgentRuntime.ioCapture` for Unit D.

### Unit D — TUI controller + /inspect slash
- **steps:** 8, 9, 10
- **files:** `src/tui/controller.ts`, `src/tui/slash/inspect.ts`, `src/tui/index.ts`
- **interface contract consumed:** Unit B's `IoCapture` and Unit C's `TuiAgentRuntime.ioCapture`. Exposes: `TuiControllerOptions.ioCapture`, the public `TuiController.ioCapture` field, and the registered `/inspect` command.

### Unit E — Tests
- **steps:** 11, 12, 13, 15
- **files:** `src/agent/io-capture.spec.ts`
- **note:** This unit and Unit B both write `io-capture.spec.ts`. The spec is ONE file authored across Steps 11-15 in sequence (content fidelity → redaction/truncation → precedence/no-fallback → filesystem conventions → off-state byte-stability); it is NOT safe to split across two concurrent coders. A single coder owns the spec file end to end after the code under test (Units A-C) exists.

### Unit F — Documentation
- **steps:** 17, 18, 19, 20
- **files:** `docs/tools/cli-agent.md`, `docs/design/project-functions.md`, `docs/design/project-design.md`, `docs/design/configuration-guide.md`
- **interface contract consumed:** the final shapes of the flags/env/config key/capture format (decided by Units A-D). Fully parallelizable internally (four disjoint files).

### Unit G — Full verification
- **steps:** 21
- **files:** none
- **note:** Runs after all other units; gates the whole plan on `npm run typecheck` + `npm run build` + `npm test`.

## Risks & Mitigations
- **`io-capture.spec.ts` is shared by Units B and E (file-set overlap).** Two units name the same spec file, violating strict disjointness if run concurrently. → Mitigation: a single coder owns `io-capture.spec.ts` end to end; the spec is authored AFTER the code under test exists. Steps 11-15 carry sequential `depends_on` to enforce this. (This is the one honest exception to perfect unit disjointness — flagged rather than hidden.)
- **`on_chat_model_start.data.input` shape variance across LangChain/LangGraph versions** (bare array vs `{messages}` vs array-of-arrays — research Q2, pitfall 4). → Mitigation: the `extractStartMessages` defensive flatten (Step 3) covers all three; Step 11 tests all three shapes. A 3-line runtime probe on the first start event (log `Object.keys(event.data.input)`) during implementation can confirm the live shape if doubt remains (research "Uncertainties").
- **One user turn fires multiple `on_chat_model_start` events in the ReAct loop** (research Q2 nuance, pitfall 5). → Mitigation: the `stepIndex` counter (Step 5) records each model call under the shared per-turn `turnId`; `/inspect show` groups by `turnId`. Bound tool schemas are attached only on `stepIndex === 0` to avoid re-serialization (research best-practice 4).
- **Reading `tool_calls` from streamed chunks yields partial/empty args** (research pitfalls 2/3). → Mitigation: the plan reads `tool_calls` exclusively from the `on_chat_model_end.data.output` aggregated message (Step 5d), never from per-chunk `tool_calls`.
- **`runOneShot` currently takes no options object** (verified — graph.ts:91-133). → Mitigation: Step 7 adds an OPTIONAL 5th param so existing call sites are unaffected; capture for the invoke path reads `result['messages']`.
- **Slash-import registration site differs from the scan's heading.** The scan §4 titled the registration "src/tui/slash/registry.ts", but the actual side-effect import list is in `src/tui/index.ts` (verified lines 21-36). → Mitigation: Step 10 edits `src/tui/index.ts` (added to `files_to_modify`); `registry.ts` is unchanged.
- **Mid-session `/inspect on|off` cannot retro-actively create the JSONL writer** (the `FileIoCapture` + bound-tool snapshot are wired at runtime build). → Mitigation: Step 9 makes `/inspect on|off` clearly message that file capture is established at launch via `--inspect-io`, rather than silently no-opping — preserving the no-silent-fallback spirit; documented in Steps 17/20.
- **Off-state byte-stability could regress if a hook leaks onto the off path.** → Mitigation: every hook is guarded by `if (ioCapture)`/`opts.ioCapture`, `createIoCapture` returns `NullIoCapture` when `cfg.inspectIo === null`, and Step 15 asserts no file/side-effect when off; `LogEvent`, `system-prompt.ts`, and the transcript writer are never modified.
- **`convertToOpenAITool` renders the OpenAI tool envelope; non-OpenAI providers differ at the wrapper level** (research Q1 nuance, MEDIUM-confidence assumption). → Mitigation: the *parameters* schema is identical across providers; only the wrapper differs, and wire-byte/envelope capture is explicitly deferred (Open-Question-4 resolution). Documented as a known limitation in Steps 17/19.

## Acceptance Criteria Mapping
| Acceptance Criterion (from request_file) | Step(s) |
|---|---|
| AC-1 — Switch off = byte-identical provider req / output / logs / transcript / `--help` | 5, 6, 7, 15, 16 |
| AC-2 — Switch on, request fidelity (system prompt + memory + user content + tool schemas) | 3, 4, 5, 7, 11 |
| AC-3 — Switch on, response fidelity (assistant text + tool-calls + tool results, correlated) | 3, 4, 5, 7, 11 |
| AC-4 — Separate surface (tailable file + `/inspect show`), labelled, no stream/spinner corruption | 4, 8, 9, 10 |
| AC-5 — Redaction default + documented raw opt-out (with warning) | 4, 12 |
| AC-6 — Live incremental write + on-demand replay of any completed turn | 4, 9, 11 |
| AC-7 — No-fallback typed error on un-initialisable inspector state | 1, 4, 13 |
| AC-8 — Provider neutrality (equivalent record structure across providers) | 3, 5, 11 |
| AC-9 — Persistence conventions (`0700`/`0600`, UTC name, `latest` pointer) | 4, 14 |
| AC-10 — Docs updated (tool doc, functions, design, config-guide) | 17, 18, 19, 20 |
| AC-11 — New tests pass + existing suite green | 11, 12, 13, 14, 15, 16, 21 |

## Deviation Rules for Executors
1. **Auto-fix in-scope bugs and blockers** you hit mid-step (e.g. a wrong import path, a type mismatch, a missed call site) and document the fix in your final report (solo: also append a note to `Issues - Pending Items.md`).
2. **Add missing security/correctness essentials** without asking (e.g. an additional `redactObject` call on a payload that can carry secrets, a missing `0600` chmod, an un-awaited `close()`) and document them.
3. **STOP and surface anything architectural** — any change to the `LogEvent` union, the transcript format, `system-prompt.ts` composition, the provider adapters, the four-tier resolution semantics, or anything that would alter off-state bytes. Do not improvise these; report them.
4. **Log nice-to-haves instead of doing them** (e.g. a live-refreshing in-TUI pane, a detached-window wrapper, wire-byte capture, discovery/synthesis-call capture) — these are explicitly deferred. When running solo, append them directly to `Issues - Pending Items.md`; when running as one of several parallel executors, put them in your final report and let the orchestrator append them after the phase (parallel executors MUST NOT edit `Issues - Pending Items.md` directly).
5. **No fallback values for configuration** (hard project rule): any un-resolvable/un-initialisable required inspector state raises `ConfigurationError`/`UsageError` with the correct exit code — never a silent default or a downgrade to "capture disabled".

## Verification
Whole-plan gates (run from the project root, using the scan's commands):
- **Typecheck:** `npm run typecheck` — green.
- **Build:** `npm run build` — succeeds (compiles + copies assets + chmods `dist/cli.js`).
- **New capture suite:** `npx vitest run src/agent/io-capture.spec.ts` — all content-fidelity, redaction, truncation, precedence, no-fallback, filesystem-convention, and off-state tests pass.
- **Help baseline:** `npx vitest run src/cli-help-baseline.spec.ts` — green against the deliberately regenerated `test_scripts/baselines/help-no-treat-as-tool.txt` (only the two inspector-flag lines added).
- **Full regression:** `npm test` — the entire pre-existing suite (logging, transcript, system-prompt, slash registry, config, composite, etc.) stays green, proving off-state byte-stability and no collateral changes.
- **Manual smoke (optional, not gated):** with provider env set, run `node dist/cli.js --inspect-io "say hi and list files"` and confirm a `session-<UTC>-<sessionId>.jsonl` + `latest.jsonl` appear under `~/.tool-agents/cli-agent/io-captures/` at `0600`, then `node dist/cli.js` (TUI) + `/inspect show 1` renders the turn; run with `--inspect-io-raw` and confirm the stderr warning prints.
