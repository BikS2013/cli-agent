---
status: completed
mode: write-and-run
scope_slug: llm-io-inspector-graph-hooks
language: typescript
framework: vitest
test_command_full: npx vitest run
test_command_scope: npx vitest run src/agent/graph-io-capture.spec.ts
test_dir: src/agent
target_path: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent
test_files_owned:
  - src/agent/graph-io-capture.spec.ts
tests_added: 39
tests_updated: 0
tests_run: 39
tests_passed: 39
tests_failed: 0
implementation_gaps: 0
built_at: 2026-06-13T22:00:00Z
last_built_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
---

# Test Build — LLM I/O Inspector: Graph/Runner Hook Wiring

## 1. Summary

Status: completed. All 39 tests written, run, and passed in 333 ms. Framework is vitest (colocated `*.spec.ts`). The new file `src/agent/graph-io-capture.spec.ts` covers the integration between `src/agent/graph.ts` and `src/agent/io-capture.ts` — specifically the three `streamEvents v2` hooks in `streamOneShot`, the `stepIndex` increment logic across multiple model calls per turn, the non-streaming `runOneShot` invoke-path capture via `captureInvokePath`, and the off-state invariant (no records produced, behavior unchanged) for both `undefined` ioCapture and explicit `NullIoCapture`. No production source was modified. No implementation gaps were found.

## 2. Scope Resolved

**Scope files:**
- `src/agent/graph.ts` — primary scope; contains `streamOneShot`, `runOneShot`, `captureInvokePath`, `buildAgentGraph`, `AgentGraph`, `StreamOneShotOptions`, `AgentStreamEvent`
- `src/agent/io-capture.ts` — consumed interface (`IoCapture`, `FileIoCapture`, `NullIoCapture`, `RequestInput`, `ResponseInput`, `ToolResultInput`, `captureBoundToolSchemas`)

**In-scope symbols exercised through the graph wiring layer:**

| Symbol | Location |
|---|---|
| `streamOneShot` | `graph.ts` — `on_chat_model_start` hook (captureRequest) |
| `streamOneShot` | `graph.ts` — `on_chat_model_end` hook (captureResponse) |
| `streamOneShot` | `graph.ts` — `on_tool_end` hook (captureToolResult) |
| `streamOneShot` | `graph.ts` — `stepIndex` increment logic |
| `runOneShot` | `graph.ts` — `captureOpts` parameter wiring |
| `captureInvokePath` | `graph.ts` — private function exercised via `runOneShot` |
| `IoCapture` (interface) | `io-capture.ts` — via `SpyIoCapture` stub + `NullIoCapture` + `FileIoCapture` |
| `FileIoCapture` | `io-capture.ts` — end-to-end JSONL write verification |
| `NullIoCapture` | `io-capture.ts` — off-state no-op invariant |

## 3. Existing Coverage

No existing test file covered the graph/runner wiring layer before this build. The file `src/agent/io-capture.spec.ts` (38 tests, owned by another unit) covers `io-capture.ts` internals in isolation (content fidelity, redaction, filesystem conventions, config precedence, off-state no-op). It does NOT call `streamOneShot` or `runOneShot`.

| Symbol | Existing test files |
|---|---|
| `streamOneShot` | none before this build |
| `runOneShot` (with captureOpts) | none before this build |
| `captureInvokePath` | none before this build |

## 4. Plan

| # | target_symbol | category | test_file | test_name | intent |
|---|---|---|---|---|---|
| 1 | `streamOneShot` | unit | graph-io-capture.spec.ts | calls captureRequest once for a simple single-model-call turn | captureRequest is called exactly once per on_chat_model_start |
| 2 | `streamOneShot` | unit | graph-io-capture.spec.ts | maps literal input messages to CapturedMessage roles correctly | system+human messages in on_chat_model_start.data.input become CapturedMessages with correct roles |
| 3 | `streamOneShot` | unit | graph-io-capture.spec.ts | attaches boundTools to the stepIndex===0 request only | boundTools appears on stepIndex 0, absent on stepIndex 1 |
| 4 | `streamOneShot` | unit | graph-io-capture.spec.ts | all captureRequest calls in the same turn share the same turnId | turnId is stable across multiple on_chat_model_start events in one turn |
| 5 | `streamOneShot` | unit | graph-io-capture.spec.ts | calls captureResponse once for a simple turn: finalText from AIMessageChunk.content | captureResponse called with finalText extracted from the end-event output |
| 6 | `streamOneShot` | unit | graph-io-capture.spec.ts | reads tool_calls from AIMessageChunk.tool_calls (not mid-stream chunks) | tool_calls on captureResponse comes from the aggregated end-event, not streaming chunks |
| 7 | `streamOneShot` | unit | graph-io-capture.spec.ts | emits two captureResponse records when the model is called twice in one turn | one per model call, each with correct stepIndex |
| 8 | `streamOneShot` | unit | graph-io-capture.spec.ts | all captureResponse calls share the same turnId as captureRequest | turnId consistency across request and response records |
| 9 | `streamOneShot` | unit | graph-io-capture.spec.ts | calls captureToolResult once for a single tool execution | on_tool_end triggers captureToolResult with correct toolName, ok, durationMs |
| 10 | `streamOneShot` | unit | graph-io-capture.spec.ts | captureToolResult stepIndex equals the INCREMENTED stepIndex | stepIndex on tool result = 1 (after first on_chat_model_end increments from 0 to 1) |
| 11 | `streamOneShot` | unit | graph-io-capture.spec.ts | yields tool_call_start and tool_call_end AgentStreamEvents alongside capture calls | capture side-effects do not suppress the yielded AgentStreamEvents |
| 12 | `streamOneShot` | unit | graph-io-capture.spec.ts | stepIndex is 0 on first captureRequest, 1 on second | stepIndex increments correctly across two model calls |
| 13 | `streamOneShot` | unit | graph-io-capture.spec.ts | three model calls produce stepIndex 0,1,2 on captureRequest/captureResponse | stepIndex increments monotonically across three calls |
| 14 | `streamOneShot` | unit | graph-io-capture.spec.ts | stepIndex resets to 0 for a DIFFERENT turnId | each new streamOneShot call starts at stepIndex 0 |
| 15 | `runOneShot` | unit | graph-io-capture.spec.ts | calls captureRequest once for the request context | messages up to last human go to captureRequest with stepIndex 0 + boundTools |
| 16 | `runOneShot` | unit | graph-io-capture.spec.ts | calls captureResponse once for the terminal AI text (no tool calls) | terminal AI message produces a captureResponse with correct finalText |
| 17 | `runOneShot` | unit | graph-io-capture.spec.ts | emits captureResponse for each tool-calling AI message + a final terminal captureResponse | multi-step invoke path: two captureResponse records |
| 18 | `runOneShot` | unit | graph-io-capture.spec.ts | emits a captureToolResult for each tool message following a tool-calling AI message | ToolMessage paired with AI tool call → captureToolResult |
| 19 | `runOneShot` | unit | graph-io-capture.spec.ts | all invoke-path records share the same turnId | single UUID minted by runOneShot covers all record types |
| 20 | `runOneShot` | unit | graph-io-capture.spec.ts | returns the assembled answer string regardless of capture | return value is unaffected by capture side-effect |
| 21 | `runOneShot` | error_path | graph-io-capture.spec.ts | runOneShot with captureOpts omitted still returns the answer | off-state regression: no captureOpts → no crash, correct answer |
| 22 | `streamOneShot` | unit | graph-io-capture.spec.ts | OFF-STATE: still yields token events and returns assembled text | no ioCapture → streaming behavior unchanged |
| 23 | `streamOneShot` | unit | graph-io-capture.spec.ts | OFF-STATE: NullIoCapture produces zero records and normal token stream | NullIoCapture no-op invariant on streaming path |
| 24 | `streamOneShot` | unit | graph-io-capture.spec.ts | OFF-STATE: NullIoCapture leaves filesystem untouched | no files/dirs created when NullIoCapture is used |
| 25 | `runOneShot` | unit | graph-io-capture.spec.ts | OFF-STATE: no ioCapture returns answer and makes no capture calls | invoke called once, correct return value, no side-effects |
| 26 | `runOneShot` | unit | graph-io-capture.spec.ts | OFF-STATE: NullIoCapture produces zero records and returns normal answer | NullIoCapture no-op invariant on invoke path |
| 27 | `streamOneShot` | unit | graph-io-capture.spec.ts | OFF-STATE: with tool use and no ioCapture still yields tool events | tool AgentStreamEvents still fired even with no ioCapture |
| 28 | `streamOneShot` | integration | graph-io-capture.spec.ts | FileIoCapture: writes request+response+tool_result JSONL to disk | end-to-end JSONL write with correct record kinds and fields |
| 29 | `streamOneShot` | integration | graph-io-capture.spec.ts | read() on FileIoCapture returns all records written during the streaming turn | in-memory mirror matches disk records |
| 30 | `streamOneShot` | unit | graph-io-capture.spec.ts | handles on_chat_model_start with bare BaseMessage[] input | extractStartMessages bare-array form maps correctly |
| 31 | `streamOneShot` | unit | graph-io-capture.spec.ts | handles on_chat_model_start with array-of-arrays input | extractStartMessages array-of-arrays shape maps correctly |
| 32 | `streamOneShot` | unit | graph-io-capture.spec.ts | gracefully handles unknown/irrelevant events without errors | on_chain_start/on_prompt_start/on_chain_end events are silently ignored |
| 33 | `runOneShot` | unit | graph-io-capture.spec.ts | messages list with NO human message still emits a captureRequest | edge: lastHumanIdx === -1 → whole messages array as request context |
| 34 | `runOneShot` | unit | graph-io-capture.spec.ts | empty messages returns empty string without throw | edge: empty invoke result → '' answer, no crash |
| 35 | `streamOneShot` | unit | graph-io-capture.spec.ts | on_chat_model_end with no output object falls back to assembledText | missing output → captureResponse uses streamed assembledText as finalText |
| 36 | `streamOneShot` | unit | graph-io-capture.spec.ts | uses opts.sessionId when provided (overrides ioCapture.currentSessionId) | sessionId threading: explicit opts.sessionId wins |
| 37 | `streamOneShot` | unit | graph-io-capture.spec.ts | falls back to 'streaming' when opts.sessionId is absent and no logger | sessionId threading: default 'streaming' fallback |
| 38 | `runOneShot` | unit | graph-io-capture.spec.ts | uses captureOpts.sessionId when provided | sessionId threading on invoke path |
| 39 | `runOneShot` | unit | graph-io-capture.spec.ts | falls back to ioCapture.currentSessionId when captureOpts.sessionId absent | sessionId threading fallback on invoke path |

## 5. Files Owned

| File | Reason |
|---|---|
| `src/agent/graph-io-capture.spec.ts` | NEW — created by this test build |

No existing files were modified.

## 6. Test Run Results

```
 RUN  v2.1.9 /Users/giorgosmarinos/aiwork/coding-platform/cli-agent

 ✓ src/agent/graph-io-capture.spec.ts (39 tests) 9ms

 Test Files  1 passed (1)
      Tests  39 passed (39)
   Start at  21:57:08
   Duration  333ms (transform 40ms, setup 0ms, collect 148ms, tests 9ms, environment 0ms, prepare 30ms)
```

All 39 tests passed. One test was initially authored with a `ToolMessage` missing its `.name` field (test was constructing `new ToolMessage({ content, tool_call_id })` without `name`). The implementation reads `tm.name ?? 'unknown'` — when LangGraph executes a real tool, the resulting `ToolMessage` has `.name` set to the tool function name. This was classified as a **test bug** (not an implementation gap) and corrected by adding `name: 'echo'` to the ToolMessage fixture, matching what LangGraph produces at runtime.

## 7. Implementation Gaps

None. All 39 tests passed. No designed behavior was found to be unimplemented or incorrectly implemented.

## 8. Manual Review Needed

None. No shared test infrastructure (`conftest.py`, `vitest.config.ts`, shared fixtures, `jest.config.*`) was required. All tests are self-contained in the owned file using:
- `SpyIoCapture` — a local stub implementing `IoCapture` with in-memory call recording (no filesystem)
- `FileIoCapture` — the real implementation against `fs.mkdtemp` temp dirs (cleaned in `afterEach`)
- `NullIoCapture` — the real no-op implementation
- Fake `AgentGraph` factories (`makeStreamGraph`, `makeInvokeGraph`) that inject scripted event sequences without touching any real LLM provider or network

## 9. Commands Run

| Command | Exit Code |
|---|---|
| `npx vitest run src/agent/graph-io-capture.spec.ts` | 1 (first run — 1 test failure: test bug on ToolMessage.name) |
| `npx vitest run src/agent/graph-io-capture.spec.ts` | 0 (after test-bug fix — 39/39 passed) |
