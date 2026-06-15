# Code Review — LLM I/O Inspector (Design 007 / Plan 007)

- **Reviewer:** senior code-review pass (Phase 7), Serena + LSP-verified
- **Date:** 2026-06-13
- **Feature:** `--inspect-io` LLM I/O inspector — a switch that records the exact tool↔LLM conversation
- **Contract reviewed against:** `docs/design/design-007-llm-io-inspector.md`, `docs/reference/refined-request-llm-io-inspector.md` (AC-1..AC-11), `docs/research/langgraph-streamevents-io-capture.md`
- **Verdict:** **approved_with_concerns**

---

## 1. Files reviewed

Production / source (verified via Serena `find_symbol` / `get_symbols_overview` + LSP `get_diagnostics` + `find_references`, not just reading):

| File | Action | Verified |
|---|---|---|
| `src/config/agent-config.ts` | modified | interfaces (138-140, 197, 377-387), `agentIoCapturesDir` (458-460), `resolveInspectIo` (1290-1352), bootstrap dir (472-487) + `.env` seed (606-612), env keys (784/787), `loadAgentConfig` wiring (1093/1108) |
| `src/cli.ts` | modified | two flags (94-95), `AgentCliFlags` mapping (238-239) |
| `src/agent/io-capture.ts` | **new** | full module; `convertToOpenAITool` import (31); no `zod-to-json-schema`; `deepTruncate` (213-237); `FileIoCapture`/`NullIoCapture`/`createIoCapture` |
| `src/agent/graph.ts` | modified | `StreamOneShotOptions.ioCapture` (280-293); 3 guarded hooks (369-387, 431-449, 469-480); `runOneShot` capture-opts (95-156) + `captureInvokePath` (176-276) |
| `src/agent/run.ts` | modified | `createIoCapture` wired into all 3 runners (36, 149, 278); `TuiAgentRuntime.ioCapture` (262); close in `finally` (114, 242) |
| `src/tui/controller.ts` | modified | `TuiControllerOptions.ioCapture` (98) + field (106) + `runTurn` opts (247) |
| `src/tui/slash/inspect.ts` | **new** | `/inspect status|show|on|off` renderer; alias `/inspect-io`; render-budget clip |
| `src/tui/index.ts` | modified | slash import (30); `ioCapture: runtime.ioCapture` forward (153) |

Tests / fixtures:
- `src/agent/io-capture.spec.ts` (**new**, 38 tests) — content fidelity, redaction, truncation, four-tier precedence, no-fallback, filesystem conventions, off-state no-op.
- `src/agent/providers/registry.spec.ts` — 1-line fixture fix (`inspectIo: null`).
- `src/tui/controller.spec.ts` — 1-line fixture fix (`ioCapture: new NullIoCapture()`).

Docs (skimmed for accuracy): `docs/tools/cli-agent.md` (`## LLM I/O Inspector`), `docs/design/configuration-guide.md`, `docs/design/project-functions.md` (FR-IOI-*/NFR-IOI-*), `docs/design/project-design.md`.

---

## 2. Diagnostics found

**LSP `mcp__cclsp__get_diagnostics` on all 6 production files + the new module: clean — zero errors/warnings/hints.**

- `src/agent/io-capture.ts` — no diagnostics
- `src/agent/graph.ts` — no diagnostics
- `src/agent/run.ts` — no diagnostics
- `src/config/agent-config.ts` — no diagnostics
- `src/tui/slash/inspect.ts` — no diagnostics
- `src/tui/controller.ts` — no diagnostics

`npm run typecheck` — clean project-wide (re-run after this review's doc edits).

Test runs performed during review:
- `npx vitest run src/agent/io-capture.spec.ts src/agent/providers/registry.spec.ts src/tui/controller.spec.ts` → **53 passed (53)**.

---

## 3. Correctness vs design & research (priority 1)

All four research-critical invariants are honored as built:

1. **Request from `on_chat_model_start.data.input`** — `graph.ts:369-387` adds a new `case 'on_chat_model_start'` that captures `extractStartMessages(event.data?.input).map(toCaptureMessage)`. The literal message array (incl. the `SystemMessage` = full assembled prompt + full memory + current human turn) is captured with no reconstruction (research Recommendation 1 / Q4). ✓
2. **Response `tool_calls` from the aggregated END output, NOT mid-stream chunks** — `graph.ts:431-438` reads `out = event.data?.output as AIMessageChunk` and `out?.tool_calls` (parsed-object args). The existing `on_chat_model_stream` per-chunk `tool_calls` read (line 395) is used ONLY for the pre-existing logger path, never for capture (research Q3 / pitfalls 2-3). ✓
3. **`captureBoundToolSchemas` uses `convertToOpenAITool` from `@langchain/core/utils/function_calling`; does NOT import `zod-to-json-schema`** — `io-capture.ts:31` + `177-186`. Spec test `io-capture.spec.ts:313-325` asserts the import is present and the forbidden one is absent. ✓
4. **Non-streaming `runOneShot` reads `result['messages']`** — `graph.ts:128`, then `captureInvokePath` (176-276) reconstructs request (up to + incl. last human message), per-AI-step responses + paired tool results, and the terminal response, with de-dup when the turn ends on a tool-calling step (262-274). ✓

**Dependency invariant (verified at runtime, not just by reading):**
- `git diff HEAD -- package.json package-lock.json` → **empty** (no dependency added). ✓
- `node -e "require('@langchain/core/utils/function_calling').convertToOpenAITool"` → `function`. ✓
- `require.resolve('zod-to-json-schema')` → **Cannot find** (ABSENT, correctly not imported). ✓

`captureBoundToolSchemas` body matches the design invariant exactly (`def.function.name / description ?? '' / parameters`).

---

## 4. Off-state byte-stability (NFR-1 / AC-1)

**Structurally guaranteed and verified.**

- Every capture hook in `graph.ts` is guarded by `if (ioCapture)` (lines 376, 431, 469); `runOneShot` guards on `captureOpts.ioCapture` (135). When off, `createIoCapture` returns `NullIoCapture` (no file/dir side-effect).
- The off-path increments a local `stepIndex` but yields no observable output: every existing `logger.log`, every yielded `AgentStreamEvent`, and `assembledText` are unchanged.
- **`git diff HEAD -- src/agent/logging.ts src/agent/system-prompt.ts src/tui/transcript/` → empty.** The `LogEvent` union, the system-prompt assembly, and the transcript writer/format are untouched — the exact structural backbone AC-1 requires. ✓
- The only changed source files are the 6 expected modifications + 2 new files (`io-capture.ts`, `inspect.ts`). ✓
- `--help` baseline (`test_scripts/baselines/help-no-treat-as-tool.txt`) contains exactly the two new flag lines (23-24) and nothing else shifted (per task note; baseline deliberately re-recorded by implementation, `cli-help-baseline.spec.ts` green). ✓
- Spec `io-capture.spec.ts` Step 15 asserts `NullIoCapture` creates no file/dir and `read()` stays empty.

---

## 5. Security & no-fallback (FR-9/FR-10, NFR-4, AC-5/AC-7)

| Requirement | As-built | Status |
|---|---|---|
| Redaction ON by default | `resolveInspectIo` sets `redact = !(...)` (default true); `FileIoCapture.write` applies `redactRecord` unless `redact === false` | ✓ |
| Redact BOTH message content AND tool-call args/result | `redactMessage` → `redactString(content)` + `redactObject(tc.args)`; `redactRecord` `response`→`finalText`+`toolCalls.args`, `tool_result`→`result` via `redactObject` | ✓ |
| `--inspect-io-raw` warns BEFORE the file is opened | `createIoCapture` writes the stderr warning (io-capture.ts:503-509) *before* constructing `FileIoCapture` (which opens the fd) | ✓ |
| Capture dir 0700 / files 0600 | `FileIoCapture` ctor `mkdirSync(...,0o700)` + `chmodSync 0o700`; `openSync(O_WRONLY\|O_CREAT\|O_APPEND, 0o600)` + `fchmodSync 0o600`; `bootstrapAgentDir` creates `io-captures/` at 0700 | ✓ (spec Step 14 asserts both modes) |
| `createIoCapture` throws `ConfigurationError`, never downgrades to `NullIoCapture` | dir failure → `ConfigurationError('inspectIo.dir', …)` in both `resolveInspectIo` (1344) and `FileIoCapture` ctor (323/348); exit code 3 | ✓ (spec Step 13 f/f2) |
| Invalid boolean env → raise (no default) | `parseAgentToolsBoolEnvVar` throws `ConfigurationError` on unparseable `CLI_AGENT_INSPECT_IO` / `_RAW` | ✓ (spec Step 13 g/g2) |
| No command/path injection in dir handling | dir comes from `config.json inspectIo.dir` or `agentIoCapturesDir()`; used only as `path.join` base + `fs.*` calls; no shell, no interpolation into a command | ✓ |
| No secrets written verbatim by default | redaction default-ON; the only verbatim path is the explicit, warned `--inspect-io-raw` | ✓ |

`redactString`/`redactObject` are internally exception-safe (`[REDACTED_FALLBACK]`/`[REDACTED_OBJECT]`), so the capture path inherits that safety. The writer's `try/catch` swallow is strictly local (io-capture.ts:442-446) and never masks a config error.

**No-fallback config rule (hard project rule):** fully honored. `inspectIo` resolves to `null` only when the switch is *not requested*; an explicitly-requested-but-uninitialisable inspector always raises `ConfigurationError`. There is no default substitution anywhere in the resolution chain.

---

## 6. TUI safety (NFR-2)

- `/inspect` renders only on the explicit command, entirely through `ctx.println` / `ctx.printSystem` (the same stdout path every slash command uses). No capture write is interleaved into the live token stream or the spinner.
- Response/tool-result capture in the TUI is a side-effect of the event loop already running inside `streamOneShot` (controller passes `ioCapture: this.ioCapture` into the existing opts at `controller.ts:247`) — no extra call in the render loop.
- `read()` serves an in-memory mirror; `/inspect show` never re-parses disk, avoiding a race with the live append.
- `/inspect on|off` is informational (Design Decision 9) rather than a silent no-op, preserving the no-silent-fallback spirit.

---

## 7. AC-1..AC-11 coverage

| AC | Requirement | Status | Evidence |
|---|---|---|---|
| **AC-1** | Switch off = byte-identical provider req / output / logs / transcript / `--help` | **Met** | Hooks guarded by `if (ioCapture)`; `logging.ts`/`system-prompt.ts`/`transcript/` diff empty; `--help` baseline adds only the 2 flag lines; spec Step 15 |
| **AC-2** | Switch on, request fidelity (system prompt + memory + user content + tool schemas) | **Met** | `on_chat_model_start` captures full `data.input` incl. `SystemMessage`; `boundTools` on stepIndex 0; spec Step 11 (`request record reproduces system+memory+user content`) |
| **AC-3** | Switch on, response fidelity (assistant text + tool-calls + tool results, correlated) | **Met** | `on_chat_model_end` → `finalText` + parsed `toolCalls`; `on_tool_end` → `tool_result`; envelope `{sessionId,threadId,turnId,stepIndex}`; spec Step 11 |
| **AC-4** | Separate surface (tailable file + `/inspect show`), labelled, no stream/spinner corruption | **Met** | JSONL file + `/inspect show` with REQUEST/RESPONSE/TOOL RESULT blocks via `println`; render-budget clip; NFR-2 satisfied |
| **AC-5** | Redaction default + documented raw opt-out (with warning) | **Met** | `redactRecord` default; `--inspect-io-raw` warns before file open; spec Step 12 (3 redaction tests) |
| **AC-6** | Live incremental write + on-demand replay of any completed turn | **Met** | `write()` appends per-event (`O_APPEND`); `read()`/`/inspect show` render completed turns; spec Step 14 (`every written line is valid JSON`) |
| **AC-7** | No-fallback typed error on un-initialisable inspector state | **Met** | `ConfigurationError` (exit 3) on un-creatable / non-writable dir + invalid env; spec Step 13 f/f2/g/g2 |
| **AC-8** | Provider neutrality (equivalent record structure across providers) | **Met** | Single `streamEvents v2` seam; `normalizeContent` handles string vs content-block; `toCaptureMessage` provider-neutral; spec Step 11 (Anthropic-array vs OpenAI-string → same shape) |
| **AC-9** | Persistence conventions (0700/0600, UTC name, `latest` pointer) | **Met** | `FileIoCapture` ctor; `session-<UTC>-<sessionId>.jsonl` + `latest.jsonl` relative symlink (copy-skip fallback); spec Step 14 (mode + name + latest) |
| **AC-10** | Docs updated (tool doc, functions, design, config-guide) | **Met** | `## LLM I/O Inspector` in tool doc; FR-IOI-*/NFR-IOI-* in project-functions; inspector section in project-design; per-variable config-guide with precedence + RISK |
| **AC-11** | New tests pass + existing suite green | **Met (with 1 known unrelated flake)** | 38 new tests pass; full suite 867/868 — the one failure is the pre-existing `composite/synthesizer.spec.ts (E-5)` ENOTEMPTY temp-dir race in an OUT-OF-SCOPE suite (passes 11/11 in isolation), logged in Issues |

**One partial-against-refined-request nuance (not an AC gap):** refined-request A-4 names the *legacy readline REPL* (`runInteractiveAgent`, `--interactive`) among targeted surfaces, but the design's wiring table only covers TUI / one-shot / streaming. As built, `runInteractiveAgent` (run.ts:318-440) does NOT instantiate an `IoCapture` and its `runOneShot` call (run.ts:419) omits capture opts, so `--inspect-io --interactive` records nothing. **The implementation matches design-007 exactly** (the design did not wire that path); the design under-delivers vs A-4. This is already logged as a `[LOW]` informational deviation in `Issues - Pending Items.md` and is low-impact (the TUI supersedes the legacy REPL). Left as a remaining concern, not fixed (a fix would be an architectural addition beyond the design's scope — review deviation rule 3 says surface, don't improvise).

---

## 8. Discrepancy reconciled — `_orig_size_bytes` shape

**Resolved this review.** design-007's "Field-cap & redaction markers" prose showed `_orig_size_bytes: <n>` (a scalar), but the as-built `FileIoCapture.deepTruncate` (io-capture.ts:213-237) emits it as an **object map** of dotted field-path → original byte size, because it deep-walks nested strings inside `messages[].content`, tool-call `args`, and `tool_result.result` — a faithful realization of the design's "any string field over 64 KiB" wording that the scalar example under-specified. The richer object-map form is strictly more informative (it names *which* fields were capped) and `_truncated` is unchanged.

Reconciliation applied (keeping the richer implementation):
- **`docs/design/design-007-llm-io-inspector.md`** — "Field-cap & redaction markers" section rewritten to document the deep-walk and the object-map `_orig_size_bytes` shape, with a JSONc example of the top-level marker.
- **`docs/design/project-design.md`** — added a Phase-7 reconciliation note to the inspector section's as-built paragraph (which already documented the map shape).
- **`docs/tools/cli-agent.md`** — already documented the object-map shape (no change needed; verified lines 405-406).
- **`Issues - Pending Items.md`** — the `[MEDIUM]` entry for this discrepancy is **removed** (now reconciled); the `[LOW]` traceability entry updated to record the reconciliation.

The spec already asserts the as-built shape (`io-capture.spec.ts:522` reads `_orig_size_bytes as Record<string, number>` and checks `Object.values(...)`), so no test change was required.

---

## 9. Issues fixed / changed during this review

- **No production code changes** were required — the implementation is correct, type-clean, and contract-faithful. Surgical fixes were unnecessary.
- **Documentation reconciliation only** (Section 8): design-007 + project-design.md updated to match the as-built `_orig_size_bytes` object-map; Issues file `[MEDIUM]` entry removed and `[LOW]` entry updated.

---

## 10. Remaining concerns

1. **[LOW] Legacy REPL not instrumented.** `runInteractiveAgent` (`--interactive`) does not capture even with `--inspect-io` set (matches design-007; diverges from refined-request A-4). Already logged in Issues as a `[LOW]` informational deviation. Recommend either (a) a follow-up to wire `createIoCapture` + capture-opts into `runInteractiveAgent`, or (b) a one-line note in `cli-agent.md` that capture targets TUI + one-shot/streaming only. Non-blocking.
2. **[LOW] `convertToOpenAITool` renders the OpenAI envelope.** Non-OpenAI providers differ at the wrapper level; only the OpenAI-shaped `parameters` schema is recorded (MEDIUM-confidence research assumption). This is the intended normalized fidelity (wire-byte capture explicitly deferred) and is documented as a known limitation. Non-blocking.
3. **[LOW] Pre-existing flaky `composite/synthesizer.spec.ts (E-5)`** ENOTEMPTY temp-dir race — out of scope, untouched by this feature, logged in Issues. Not chased per the task brief.

None of these block release.

---

## 11. Overall verdict

**`approved_with_concerns`**

The LLM I/O Inspector is implemented faithfully to design-007 and the research seam: the request is captured from `on_chat_model_start.data.input` (literal messages incl. the `SystemMessage`), the response reads `tool_calls` from the aggregated `on_chat_model_end` output, the non-streaming path reconstructs from `result['messages']`, bound schemas use `convertToOpenAITool` with no new dependency, redaction is ON by default for both content and tool args/result with a pre-write warning on the raw opt-out, the filesystem contract (0700/0600/UTC/`latest`) is honored, and the no-fallback rule is enforced with typed `ConfigurationError`s. Off-state byte-stability is structurally guaranteed (logger/system-prompt/transcript untouched; every hook guarded). LSP diagnostics are clean across all touched files; the 38-test spec and the two fixture fixes pass; typecheck is green. The `_orig_size_bytes` design-vs-as-built discrepancy is reconciled in the docs (richer implementation kept). The concerns are all `[LOW]` and documented (legacy-REPL coverage vs A-4, the OpenAI-envelope normalization limitation, and the unrelated pre-existing flaky synthesizer test).
