---
language: typescript
framework: langgraph
package_manager: npm
build_command: "npm run build"
test_command: "npm test"
lint_command: "npm run typecheck"
entry_points:
  - src/cli.ts
  - src/agent/run.ts
last_scanned_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
scanned_for_request: llm-io-inspector
scanned_at: "2026-06-13T00:00:00Z"
---

# Codebase Scan — @biks2013/cli-agent

## 1. Project Overview

TypeScript ESM package (`type: "module"`, Node >=22) that implements a generic LangGraph ReAct agent wrapping external CLI binaries. The agent is accessed via a `commander`-based CLI (`src/cli.ts`) that drives either a raw-mode TUI (`src/tui/controller.ts`) or a one-shot non-interactive path (`src/agent/run.ts`). All LLM calls pass through LangGraph's `createReactAgent` / `streamEvents v2` pipeline in `src/agent/graph.ts`. Structured artifacts (logs, transcripts, checkpoints) are persisted under `~/.tool-agents/cli-agent/` using a strict `0700`/`0600` permission regime and JSONL format. Build is TypeScript compile (`tsc`) with no bundler; test runner is Vitest.

---

## 2. Module Map

| Path | Purpose | Representative symbols |
|---|---|---|
| `src/cli.ts` | Commander program root; registers all subcommands and global flags; dispatches to runners in `src/commands/` | `program`, `collectTool`, `handleErrors` |
| `src/cli-agent-tools-flags.ts` | Maps `--agent-tools` / `--tools` flag pairs onto `AgentCliFlags` | `mapAgentToolFlags` |
| `src/cli-composite-flags.ts` | Flag-wiring helpers for composite subcommand | (flag parsers) |
| `src/errors.ts` | Typed error hierarchy with exit codes | `CliAgentError`, `ConfigurationError`, `UsageError`, `AgentRuntimeError` |
| `src/agent/graph.ts` | LangGraph graph builder and invocation boundary; `streamEvents v2` loop; produces `AgentStreamEvent` | `buildAgentGraph`, `runOneShot`, `streamOneShot`, `AgentGraph` |
| `src/agent/run.ts` | Top-level agent runners: one-shot (`runOneShotAgent`, `streamOneShotAgent`), interactive TUI (`runInteractiveAgent`), TUI runtime builder (`buildTuiAgentRuntime`) | `runOneShotAgent`, `streamOneShotAgent`, `runInteractiveAgent` |
| `src/agent/logging.ts` | Structured JSONL event logger; `0700`/`0600` permissions; 64 KiB field cap; redaction via `redactString`; `latest.jsonl` symlink; `LogEvent` union type | `FileLogger`, `createLogger`, `newTurnId`, `FIELD_TRUNCATE_BYTES` |
| `src/agent/system-prompt.ts` | System-prompt composer; assembles base + capabilities section + agent-tools block + user addendum | `buildSystemPromptForCfg`, `buildSystemPrompt`, `BUILTIN_DEFAULT_SYSTEM_PROMPT` |
| `src/agent/capabilities/` | Capability discovery (runs `--help` trees), caches to disk, composes capability section of system prompt | `composeCapabilitiesSystemPrompt`, `discoverAllTools`, `CapabilitySection` |
| `src/agent/tools/registry.ts` | Builds the `ToolCatalog` (DynamicStructuredTool[] + `AgentToolsCatalogMeta`) bound to the LLM | `buildToolCatalog`, `ToolCatalog`, `AnyTool` |
| `src/agent/tools/tool-prompt-overlay.ts` | Per-tool prompt overlay loader; parses overlay files and provides description/parameter overrides | `loadOverlayRegistry`, `OverlayRegistry`, `ParsedOverlay` |
| `src/agent/tools/tool-prompts-builtin.ts` | Hardcoded built-in tool descriptions/param docs for all 17 cross-cutting tools | `BUILTIN_TOOL_PROMPTS`, `BUILTIN_TOOL_NAMES` |
| `src/agent/tools/agent-tools/` | "Agent-tools" sub-suite (`agt_glob`, `agt_grep`, `agt_multiedit`, etc.); prompt block builder; permissions guard; todo session state | `buildAgentToolsPromptBlock`, `buildToolCatalog` (group-builder), `AgentToolsSession` |
| `src/agent/providers/` | LLM provider adapters for all 8 providers (OpenAI, Anthropic, Azure-OpenAI, Azure-AI-Inference, Gemini, Ollama, LiteLLM, MLX) | `createLLM`, `registry.ts` |
| `src/agent/checkpoint-store.ts` | Persists/restores `MemorySaver` checkpoints to disk for `/resume` | `saveCheckpoint`, `loadCheckpoint` |
| `src/config/agent-config.ts` | Four-tier config resolution (shell env → `~/.tool-agents/cli-agent/.env` → local `.env` → CLI flags); typed `AgentConfig`/`AgentConfigFile`/`AgentCliFlags`; all dir-path helpers; `bootstrapAgentDir` | `loadAgentConfig`, `AgentConfig`, `AgentCliFlags`, `bootstrapAgentDir`, `agentLogsDir` |
| `src/config/profile-*.ts` | Profile schema, loader, codec; type-safe profile overlays | `ProfileSchema`, `loadProfile`, `ProfileCodec` |
| `src/tui/controller.ts` | Raw-mode TUI session: owns `threadId`, message list, spinner lifecycle, slash dispatch, turn persistence | `TuiController`, `TuiControllerOptions`, `makeSlashContext`, `runTurn` |
| `src/tui/slash/` | Slash command registry + per-command modules (`/memory`, `/help`, `/new`, `/quit`, `/model`, `/tools`, etc.) | `registerCommand`, `dispatchSlash`, `SlashCommand`, `SlashContext`, `memoryCmd` |
| `src/tui/transcript/` | TUI transcript persistence (JSONL per thread, thread index, cursor); read/write thread files | `appendTurn`, `readThreadTurns`, `upsertIndexEntry`, `TurnRecord` |
| `src/tui/input/` | Raw-mode line editor + keybindings | `LineEditor`, `keybindings` |
| `src/tui/spinner.ts` | Raw-mode animated spinner (stdout-column-aware; stops before any write) | `createSpinner`, `Spinner` |
| `src/util/redact.ts` | String/object redaction; masks bearer tokens, JWTs, long base64 runs, named env-key=value pairs | `redactString`, `redactObject`, `PATTERNS`, `ENV_KEY_RE` |
| `src/commands/` | Commander action handlers: `agent.ts`, `show-capabilities.ts`, `audit-tool-prompts.ts`, `extract-tool-prompts.ts`, `refresh-capabilities.ts`, composite sub-pipeline, profile management | (per-command action functions) |

---

## 3. Conventions

- **ESM named-import style everywhere** — no default imports from first-party modules except the slash-command modules which export a `default` for side-effect registration (`src/tui/slash/memory.ts:46`, `export default memoryCmd`). External LangChain types arrive as `import type { ... }`.

- **Error handling via typed hierarchy, never silently swallowed** — all agent-facing errors extend `CliAgentError` (which carries `.exitCode` and `.code`); `ConfigurationError` and `UsageError` are the two public exit-gate classes (`src/errors.ts`). Logging `.log()` and spinner internals swallow errors locally (`src/agent/logging.ts:116`, `catch { /* swallow — logging must never break the agent */ }`), which is the only sanctioned exception.

- **Config is fully resolved before first LLM call; no runtime fallbacks** — `loadAgentConfig` in `src/config/agent-config.ts` raises `ConfigurationError` / `UsageError` for any missing required value. The four-tier resolution order is shell env → `~/.tool-agents/cli-agent/.env` → local `.env` → CLI flags (higher priority to the right).

- **All persisted artifacts follow the same filesystem contract** — directory `0700`, files opened with `O_CREAT | O_APPEND` at mode `0600`, UTC-stamped filenames `session-<UTC>-<sessionId>.jsonl`, `latest.jsonl` symlink; enforced identically in `src/agent/logging.ts:156-176` and `src/tui/transcript/persist.ts`. New features must inherit this contract.

- **64 KiB field-cap with `_truncated: true` marker** — `truncateEvent` in `src/agent/logging.ts:64-82` truncates any string field that exceeds `FIELD_TRUNCATE_BYTES = 65536` and sets `_truncated: true` + `_orig_size_bytes` on the emitted record. System-prompt and memory payloads in the capture channel must replicate this discipline (not merely drop large fields).

- **Byte-stability test discipline** — `src/cli-help-baseline.spec.ts` compares `cli-agent --help` against `test_scripts/baselines/help-no-treat-as-tool.txt` byte-for-byte; any flag addition triggers a deliberate baseline re-record. The same pattern is applied to subcommand help. New flags (`--inspect-io`, `--inspect-io-raw`) will require a baseline regeneration.

---

## 4. Integration Points

### In-Scope Files / Symbols

**`src/agent/graph.ts` — primary hook point**

- `streamOneShot` (lines 160-280): the `streamEvents v2` generator loop. This is where every LLM turn lives. The `on_chat_model_end` case (lines 237-249) already captures `finalText` and `toolCallsObserved` for the logger — the I/O capture writer must be called from the same event cases, receiving the same `turnId`, `sessionId`, assembled text, and tool-call list.
- `buildAgentGraph` (lines 60-90): where `systemPrompt` (as `stateModifier`) and `tools` are bound to `createReactAgent`. The system prompt string and the `DynamicStructuredTool[]` array (whose `.schema` carries the JSON schemas) are both available here and in `run.ts` immediately before this call — the capture writer can receive them at graph-build time or be passed as a closure into `streamOneShot`'s options.
- `runOneShot` (lines 92-134): the non-streaming path. Needs a parallel capture hook at `graph.invoke` that records the assembled request/response once the call completes (no streaming events to hook; read from `result['messages']`).
- `AgentStreamEvent` type (lines 53-58): the new capture writer consumes the same events; it does not need to modify this union type.
- `StreamOneShotOptions` interface (lines 138-142): extend with `ioCapture?: IoCapture` (the new capture writer instance) so callers can inject it without changing the signature.

**`src/agent/run.ts` — runner layer where system prompt + tools + sessionId converge**

- `runOneShotAgent` / `streamOneShotAgent` (lines 18 onward): both functions call `buildSystemPromptForCfg` then `buildAgentGraph` then `runOneShot`/`streamOneShot`. This is the place to (a) instantiate the `IoCapture` channel from config flags, (b) capture the assembled `systemPrompt` string, (c) pass the `tools` array (for schema extraction), and (d) thread the capture instance through `streamOneShot`'s options.
- `buildTuiAgentRuntime`: constructs the `TuiAgentRuntime` (`{ agentGraph, logger, sessionId }`). The `IoCapture` instance should be added as a fourth member and forwarded to `TuiController`.
- `runInteractiveAgent`: the TUI entry-point where `TuiController.runTurn` is called in a readline loop. The capture instance created here must survive the session.

**`src/agent/logging.ts` — pattern to mirror exactly**

- `LogEvent` union (lines 20-31): the capture channel defines its own analogous `IoCaptureEvent` union (request, response, tool-result records) with the same `sessionId`/`threadId`/`turnId` correlation fields. Do not extend `LogEvent` with large payload fields — this breaks the existing log's operational compactness.
- `FileLogger.open()` (lines 131-138): the new `IoCapture` writer opens its file identically — `O_WRONLY | O_CREAT | O_APPEND`, mode `0600`, under `~/.tool-agents/cli-agent/io-captures/`.
- `createLogger` / `formatSessionFilename` (lines 149-177): replicate the directory-creation logic (`mkdirSync` with `0700`), the `latest.jsonl` symlink, and the UTC filename format for the new `io-captures/` dir.
- `FIELD_TRUNCATE_BYTES` / `truncateEvent` pattern: reuse for system-prompt and memory payloads.
- `Logger` interface: define a parallel `IoCapture` interface with `captureRequest(...)`, `captureResponse(...)`, and `close()`; the `NullIoCapture` no-op must be the only instance when the switch is off.

**`src/agent/system-prompt.ts` — system-prompt capture**

- `buildSystemPromptForCfg` (lines 134-154): returns the fully assembled `systemPrompt: string`. The capture of FR-3a (complete assembled system prompt) is this return value, taken in `run.ts` just before `buildAgentGraph`. No change to this function is needed; it is called by the same runner functions that will instantiate the `IoCapture` writer.
- `buildSystemPrompt` (lines 85-112): composition order (base + capabilities + agent-tools block + custom) documented here is relevant for the rendering labels in the capture record (so each section can be annotated in the JSONL).

**`src/agent/capabilities/compose-system-prompt.ts` — capabilities section**

- `composeCapabilitiesSystemPrompt` produces the `capSection: string` passed into `buildSystemPromptForCfg`. The result is already embedded in the final `systemPrompt`; no separate capture needed for it. However, the function's `CapabilitySection[]` return shape (with `tool`, `content`, `bytes`, `truncated`) is useful documentation for annotating the system-prompt capture record.

**`src/agent/tools/registry.ts` — tool JSON schema capture**

- `buildToolCatalog` (lines — `ToolCatalog` interface): returns `{ tools: DynamicStructuredTool[], agentToolsMeta }`. The `tools` array is what gets bound to `createReactAgent`; each element's `.schema` property is the Zod schema that LangChain serializes into the provider-specific function/tool JSON schema. For FR-3d, the capture writer must serialize `tools.map(t => ({ name: t.name, description: t.description, schema: zodToJsonSchema(t.schema) }))` — or use LangChain's `formatToOpenAITool` helper — at the point the catalog is built in `run.ts`.

**`src/agent/tools/tool-prompt-overlay.ts` and `tool-prompts-builtin.ts` — tool-use instruction surface**

- `loadOverlayRegistry` / `OverlayRegistry.list()`: enumerates the effective per-tool overlays (description + parameter overrides). These are the "instructions regarding tool use" captured on the request side (FR-3d). The capture record should include the effective overlay for each tool as a map alongside the JSON schemas.
- `BUILTIN_TOOL_PROMPTS`: the hardcoded fallback descriptions. Together with overlays, these form the full tool-use instruction surface visible to the LLM.

**`src/agent/tools/agent-tools/prompt-block.ts`**

- `buildAgentToolsPromptBlock`: produces the agent-tools section of the system prompt. Its output is already embedded in the assembled `systemPrompt` string, so it is captured indirectly. No extra hook needed; note its presence for rendering labels.

**`src/config/agent-config.ts` — new config wiring**

- `AgentCliFlags` interface: add `inspectIo?: boolean` and `inspectIoRaw?: boolean` optional fields. These map to `--inspect-io` and `--inspect-io-raw` CLI flags.
- `AgentConfigFile` interface: add `inspectIo?: { enabled?: boolean; redact?: boolean; dir?: string }` key (camelCase, per NFR-5).
- `AgentConfig` interface: add resolved `inspectIo: { enabled: boolean; redact: boolean; dir: string } | undefined` (or `null` when not requested — never silently defaulted).
- `loadAgentConfig`: add resolution step for `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW` env vars, `config.json` `inspectIo` key, and CLI flags, in four-tier order. When `inspectIo.enabled` is explicitly `true` but the capture dir cannot be created (or an invalid mode is supplied), raise `ConfigurationError` — no fallback.
- `agentLogsDir` / `bootstrapAgentDir`: add a sibling `agentIoCapturesDir()` helper returning `~/.tool-agents/cli-agent/io-captures/`; add the directory to `bootstrapAgentDir`'s creation sequence (mode `0700`).
- `ALL_ENV_KEYS` / `OTHER_ENV_KEYS`: add `CLI_AGENT_INSPECT_IO` and `CLI_AGENT_INSPECT_IO_RAW`.

**`src/cli.ts` — flag registration**

- The `agent` subcommand action handler (the dominant entry point): add `.option('--inspect-io', 'Enable LLM I/O capture (writes to ~/.tool-agents/cli-agent/io-captures/)')` and `.option('--inspect-io-raw', 'Disable redaction for I/O captures (use with caution; prints warning)')` options to the `agent` command definition. Both flags are passed into `AgentCliFlags` and consumed by `loadAgentConfig`.
- `handleErrors` wrapper: `ConfigurationError` and `UsageError` thrown by the inspector initialisation are already handled by this wrapper — no change needed there.

**`src/cli-agent-tools-flags.ts`**

- `mapAgentToolFlags`: not directly touched, but the inspector flags follow the same flag-mapping pattern. Confirm the inspector flags do not conflict with agent-tools flag wiring.

**`src/tui/controller.ts` — new `/inspect` slash command integration point**

- `TuiControllerOptions`: add `ioCapture?: IoCapture` so the controller receives the (possibly null) capture channel.
- `TuiController` class: store `ioCapture` as a public field; `makeSlashContext` passes it to `SlashContext` so `/inspect show` can read from it.
- `runTurn` (the main turn loop): after `streamOneShot` yields all events, the capture channel's `captureResponse` is called with the assembled text + tool calls. The capture is a post-event-loop side-effect, not interleaved into the render loop, so it does not race the spinner.
- `println` / `printSystem`: the `/inspect show` renderer uses these two methods to emit the formatted turn view — same stdout path as all other TUI output, ensuring no stdout/spinner race.

**`src/tui/slash/registry.ts` — new `/inspect` slash command**

- `registerCommand` / `SlashCommand` interface: the new `/inspect` command is a `SlashCommand` object (`name: '/inspect'`, `aliases: ['/inspect-io']`) registered via `registerCommand(inspectCmd)` in a new file `src/tui/slash/inspect.ts` (following the pattern of `memory.ts`). The `run(ctx, args)` handler handles sub-args `on`, `off`, `show [turn]`.
- `SlashContext.controller`: the handler reads `ctx.controller.ioCapture` to toggle capture and to read captured records for rendering.
- `listCommands` / `/help` listing: the new command appears automatically in `/help` output after registration.

**`src/tui/slash/memory.ts` — precedent for new slash command**

- `memoryCmd` (lines 11-44): the exact structural template for `inspectCmd`. The pattern — `import { registerCommand }`, define a `SlashCommand` object, `registerCommand(inspectCmd)`, `export default inspectCmd` — must be followed identically. The `checkpointer.get(config)` call for reading memory (line 19) is the analogue of reading the `IoCapture` store for `/inspect show`.

**`src/tui/transcript/persist.ts` and `types.ts` — filesystem pattern**

- `ensureHistoryDir` / `appendTurn` / `writeCursor` in `persist.ts`: the capture writer's `ensureIoCapturesDir()` + `appendCaptureRecord()` + `updateLatestPointer()` helpers follow the same async-fsp API, same mode constants, same error-swallow discipline.
- `TurnRecord` / `ThreadIndexEntry` in `types.ts`: the new `IoCaptureRecord` typed union (request event, response event, tool-result event) follows the same interface-per-record-shape convention.

**`src/util/redact.ts` — reused without modification**

- `redactString` (lines 41-59): called in the capture writer's `serialize()` method exactly as it is in `FileLogger.log()` (logging.ts:104). When `--inspect-io-raw` is active, the call is skipped and a visible warning is emitted to stderr before the file is opened.
- `redactObject` (lines 65-72): usable for redacting the tool-call `args` objects in capture records.

**`src/cli-help-baseline.spec.ts` and `test_scripts/baselines/`**

- The `--inspect-io` and `--inspect-io-raw` flag additions to the `agent` command will change the `cli-agent --help` output. The baseline file `test_scripts/baselines/help-no-treat-as-tool.txt` must be deliberately regenerated (`node dist/cli.js --help > test_scripts/baselines/help-no-treat-as-tool.txt`) after the flags are added and the binary rebuilt. This regeneration must be a conscious, reviewed step — not automated.

### Out of Scope (modules not implicated by this request)

- `src/commands/composite/` — composite tool synthesis pipeline; explicitly excluded (capability-discovery/synthesis LLM calls are out of scope per A-4).
- `src/commands/extract-recipes.ts`, `src/commands/extract-tool-prompts.ts`, `src/commands/audit-tool-prompts.ts` — maintenance/dev utilities; no interaction with the I/O capture feature.
- `src/agent/capabilities/discover.ts`, `src/agent/capabilities/cache.ts` — capability discovery; out of scope (A-4).
- `src/config/profile-schema.ts`, `src/config/profile-codec.ts`, `src/config/profile-loader.ts` — profile subsystem; unaffected (inspector config is a top-level key, not a profile-level key).
- `src/tui/input/` — line editor and keybindings; no change needed.
- `src/tui/clipboard.ts`, `src/tui/utf8.ts`, `src/tui/ansi.ts` — low-level TUI utilities; no change needed (ANSI constants from `ansi.ts` will be reused by the `/inspect show` renderer, but the file itself is not modified).
- `src/agent/tools/bash/`, `src/agent/tools/file/`, `src/agent/tools/web/` — individual cross-cutting tool implementations; not modified.
- `src/agent/tools/agent-tools/permissions.ts`, `token-budget.ts` — agent-tools internals; not modified.
- `src/agent/tools/profile-scoping.ts`, `profile-tool-args.ts` — profile scoping; not modified.

### New Integration Points (not currently in the codebase)

- **`src/agent/io-capture.ts`** (new file): the `IoCapture` interface + `FileIoCapture` implementation + `NullIoCapture` + `createIoCapture(cfg)` factory. This is the parallel capture channel (Q7 resolution). Mirrors the `Logger` / `FileLogger` / `NullLogger` / `createLogger` structure in `logging.ts`.
- **`src/tui/slash/inspect.ts`** (new file): `/inspect` slash command implementation. Mirrors `memory.ts` structure. Sub-commands: `/inspect on`, `/inspect off`, `/inspect show [turn-number]`, `/inspect status`.
- **`src/agent/io-capture.spec.ts`** (new file): unit tests for capture content, redaction, switch precedence, off-state byte-stability invariant, and error-on-misconfiguration.
- **`agentIoCapturesDir()` helper** (new function in `src/config/agent-config.ts`): returns `~/.tool-agents/cli-agent/io-captures/`, added alongside the existing `agentLogsDir()`.
- **`CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW`** (new env-var keys): added to `ALL_ENV_KEYS` in `src/config/agent-config.ts` so the build-provider-env snapshot and the `.env` loader pick them up correctly.

---

## 5. Notes

- **`on_chat_model_end` is the natural LLM-response capture event**: `streamOneShot` already assembles `finalText` and `toolCallsObserved` and logs them there (lines 237-249). The capture writer's `captureResponse` call slots in immediately after the existing `logger.log({ kind: 'llm_final', ... })` call — minimal diff, zero duplication.

- **System-prompt string is available in `run.ts` before `buildAgentGraph`**: `const systemPrompt = await buildSystemPromptForCfg(...)` is already a named variable at that point; the capture writer can receive it as a plain `string` argument — no refactoring of `system-prompt.ts` is needed.

- **Tool JSON schema extraction requires a LangChain helper or Zod serialization**: `DynamicStructuredTool.schema` is a Zod schema; the capture writer will need `import { zodToJsonSchema } from 'zod-to-json-schema'` (already transitively available via `@langchain/core`) or LangChain's `formatToOpenAITool`. Verify the transitive availability before adding an explicit dependency; this is the one place where a new (or already-present) import may be needed.

- **The `--inspect-io` flag addition changes the byte-stable `--help` output**: the `cli-help-baseline.spec.ts` test will fail immediately after the flags are wired. The implementation plan must include an explicit step to re-record `test_scripts/baselines/help-no-treat-as-tool.txt` after the build.

- **`src/tui/controller.ts:runTurn` does not exist as a named public method in the current symbol map** (it appears in the class `Method` list); reading the full file body would confirm the exact signature before writing the hook. The scan saw `runTurn` listed as a method of `TuiController` — the implementer must read this method's body to determine the exact hook placement relative to the spinner stop/start sequence and the existing `persistTurn` call.
