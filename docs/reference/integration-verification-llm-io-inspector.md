---
status: ready
verdict: READY
feature: llm-io-inspector
plan: docs/design/plan-007-llm-io-inspector.md
refined_request: docs/reference/refined-request-llm-io-inspector.md
verified_at: 2026-06-13T22:05:00Z
verified_against_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
build_command: npm run build
test_command: npm test
typecheck_command: npm run typecheck
build_status: pass
build_error_count: 0
typecheck_status: pass
test_files_total: 79
test_files_passed: 79
tests_total: 954
tests_passed: 954
tests_failed: 0
tests_skipped: 0
feature_specs:
  - { file: src/agent/io-capture.spec.ts, tests: 38, status: pass }
  - { file: src/agent/graph-io-capture.spec.ts, tests: 39, status: pass }
  - { file: src/tui/slash/inspect.spec.ts, tests: 47, status: pass }
  - { file: src/cli-help-baseline.spec.ts, tests: 2, status: pass }
acceptance_criteria_met: 10
acceptance_criteria_partial: 1
acceptance_criteria_not_met: 0
fixes_applied: 0
---

# Integration Verification — LLM I/O Inspector (Plan 007 / Design 007)

- **Verifier:** integration verification specialist (final gate)
- **Date:** 2026-06-13
- **Feature:** `--inspect-io` LLM I/O inspector — a switch that records the exact tool↔LLM conversation
- **Verified against:** `docs/reference/refined-request-llm-io-inspector.md` (AC-1..AC-11), `docs/design/plan-007-llm-io-inspector.md` (Verification section)
- **Working-tree base commit:** `c546d38` (all feature work is uncommitted in the working tree; verified as-is)
- **Verdict:** **READY**

---

## 1. Build status

| Gate | Command | Result |
|---|---|---|
| Build | `npm run build` | **PASS** — exit 0 |
| Typecheck (static gate) | `npm run typecheck` | **PASS** — exit 0 |

- **Build error count: 0.** `tsc -p tsconfig.json` compiled cleanly, `postbuild:assets` copied 8 runtime assets from `src/` into `dist/`, and `postbuild:chmod` made `dist/cli.js` executable.
- **Typecheck error count: 0.** `tsc --noEmit` is clean project-wide.

There is **no separate ESLint/Prettier step** in this project — per the codebase scan frontmatter (`lint_command: "npm run typecheck"`), TypeScript strict mode IS the static-analysis gate, and it is green (Section 3).

---

## 2. Test results (full suite)

`npm test` (Vitest, run twice for confirmation — identical result both runs):

| Metric | Value |
|---|---|
| Test files total | 79 |
| Test files passed | 79 |
| Test files failed | 0 |
| Tests total | **954** |
| Tests passed | **954** |
| Tests failed | **0** |
| Tests skipped | 0 |
| Suite exit code | **0** |
| Duration | ~2.2 s |

**The suite is unconditionally GREEN — zero failures.** The known pre-existing flaky test `src/agent/composite/synthesizer.spec.ts (E-5)` (ENOTEMPTY temp-dir cleanup race) **passed 11/11 in both full-suite runs** this verification — the parallel-run race did not trigger. No isolation re-run was required because there was no failure to triage, but the test remains logged as a known pre-existing flake in `Issues - Pending Items.md` (out of scope for this feature; `src/agent/composite/` is untouched and capture is off by default).

### Feature-owned specs (all present and green)

| Spec file | Tests | Status |
|---|---|---|
| `src/agent/io-capture.spec.ts` | 38 | ✓ pass |
| `src/agent/graph-io-capture.spec.ts` | 39 | ✓ pass |
| `src/tui/slash/inspect.spec.ts` | 47 | ✓ pass |
| `src/cli-help-baseline.spec.ts` | 2 | ✓ pass |
| **Feature subtotal** | **126** | **✓ 126/126 pass** (verified in isolation too) |

> Note: a benign Vite/esbuild plugin warning is emitted during the run ("This case clause will never be evaluated…" in `src/tui/input/line-editor.ts:641`). It is a pre-existing, unrelated lint-style warning from the bundler used by the test transform — **not a test failure**, not introduced by this feature, and does not affect the suite result (exit 0). Logged below as a new informational item.

---

## 3. Static analysis

- **`npm run typecheck` (tsc strict) — CLEAN, exit 0.** This is the project's sole static gate (no ESLint/Prettier configured). Confirmed against the codebase-scan frontmatter (`lint_command: "npm run typecheck"`).
- The Phase-7 code review independently confirmed LSP `get_diagnostics` is clean (zero errors/warnings/hints) across all six modified production files plus the two new modules.

---

## 4. Behavioural smoke (exercised end-to-end, no real LLM key, isolated temp HOME)

All smoke runs used a throwaway `HOME` (`mktemp -d`) so nothing touched the real `~/.tool-agents/`. Temp HOMEs were cleaned up afterwards.

| # | What was run | Expected | Actual | Result |
|---|---|---|---|---|
| **S1** | `node dist/cli.js --help \| grep inspect-io` | both flags listed | `--inspect-io` and `--inspect-io-raw` present with documented descriptions | **PASS** |
| **S2 (off-state)** | `HOME=<tmp> node dist/cli.js "say hi"` (no `--inspect-io`, no provider) | bootstrap creates `io-captures/` dir but writes **no capture files**; agent exits on missing provider | `io-captures/` exists at mode `0700`, **0 files inside** (no `session-*.jsonl`, no `latest.jsonl`); provider-missing → `ConfigurationError` exit 3 | **PASS** |
| **S3a (misconfig, config.json + un-creatable dir)** | `HOME=<tmp> OPENAI_API_KEY=sk-dummy node dist/cli.js "say hi"` with `config.json inspectIo.enabled=true, dir="/dev/null/cannot-create-here"` | non-zero exit + `ConfigurationError`, **not** a silent disable | exit **3**; `Error [E_CONFIG_MISSING]: Required configuration 'inspectIo.dir' is not set. Checked: --inspect-io / CLI_AGENT_INSPECT_IO / config.json inspectIo.enabled.`; **0 capture files** written | **PASS** |
| **S3b (misconfig, --inspect-io flag + unwritable parent)** | `HOME=<tmp> node dist/cli.js --inspect-io "say hi"` with `inspectIo.dir` under a mode-`000` parent | non-zero exit + `ConfigurationError` (writability branch) | exit **3**; same `E_CONFIG_MISSING` on `inspectIo.dir` | **PASS** |

**Why these are valid without a provider key:** `loadAgentConfig` → `resolveInspectIo` runs the capture-dir create-and-`access(W_OK)` check during configuration resolution, *before* any LLM turn. The misconfig error therefore fires deterministically with a dummy/absent key — no network call is reached. This live result corroborates `io-capture.spec.ts` Step 13 (f/f2/g/g2), which assert the same no-fallback `ConfigurationError` at the unit level.

**Additional structural confirmations (byte-stability backbone):**
- `node dist/cli.js --help` is **byte-identical** to the recorded baseline `test_scripts/baselines/help-no-treat-as-tool.txt` (`diff` clean). The baseline carries exactly the two new inspector flag lines (lines 23-24) and nothing else shifted. (Baseline was deliberately re-recorded by implementation; **not** re-recorded here, per the task brief.)
- `git diff HEAD -- package.json package-lock.json` → **0 lines** (zero dependency drift; matches the dependency-validation CLEAN verdict).
- `git diff HEAD -- src/agent/logging.ts src/agent/system-prompt.ts src/tui/transcript/` → **empty** (the `LogEvent` union, system-prompt composition, and transcript writer/format are untouched — the exact structural invariant AC-1 requires).

> A *live, capture-ON* end-to-end run (`--inspect-io "say hi"` producing a real `session-*.jsonl`) was **not** performed because it requires a working provider API key, which is unavailable in this environment. That happy-path capture is fully covered at the integration level by `graph-io-capture.spec.ts` (tests 28-29: `FileIoCapture` writes request+response+tool_result JSONL to disk through a real `streamOneShot`/`runOneShot` event loop driven by a scripted fake graph) and `io-capture.spec.ts` Step 14 (real `FileIoCapture` against a temp dir: `0700`/`0600`/UTC-name/`latest.jsonl`). Documented here as covered-by-unit/integration-test rather than claimed as a live pass.

---

## 5. Acceptance criteria check (AC-1..AC-11)

| AC | Requirement (abbrev.) | Status | Evidence |
|---|---|---|---|
| **AC-1** | Switch off = byte-identical provider req / output / logs / transcript / `--help` | **Met** | Smoke S2 (off → 0 capture files); `--help` byte-identical to baseline (§4); `logging.ts`/`system-prompt.ts`/`transcript/` diff empty (§4); `graph-io-capture.spec.ts` tests 22-27 (off-state no-op on stream + invoke); `io-capture.spec.ts` Step 15 (NullIoCapture creates no file/dir) |
| **AC-2** | Switch on, request fidelity (system prompt + memory + user content + tool schemas) | **Met** | `graph-io-capture.spec.ts` tests 1-4, 15, 30-31 (request captured from `on_chat_model_start.data.input`, literal `SystemMessage`+memory+human, `boundTools` on stepIndex 0); `io-capture.spec.ts` Step 11 (`captureBoundToolSchemas` → `{name,description,parameters}` JSON-Schema via `convertToOpenAITool`) |
| **AC-3** | Switch on, response fidelity (assistant text + tool-calls + tool results, correlated) | **Met** | `graph-io-capture.spec.ts` tests 5-10, 17-19 (`captureResponse` finalText + `tool_calls` from aggregated END output; `captureToolResult` from `on_tool_end`; shared `turnId`/`stepIndex`); `io-capture.spec.ts` Step 11 (record envelope correlation) |
| **AC-4** | Separate surface (tailable JSONL + `/inspect show`), labelled, no stream/spinner corruption | **Met** | `inspect.spec.ts` tests 23-47 (REQUEST/RESPONSE/TOOL RESULT section headers, role labels, tool-call rendering, turn selection, render-budget clip); renders only via `ctx.println`/`ctx.printSystem` (NFR-2, code-review §6); capture is a side-effect of the existing event loop, not interleaved |
| **AC-5** | Redaction default ON + documented raw opt-out (with warning) | **Met** | `io-capture.spec.ts` Step 12: secret `sk-abc…6789` in content+args → `[REDACTED]` with `redact:true` (default), verbatim with `redact:false`, and a `WARNING`/`--inspect-io-raw`/`plaintext` stderr warning fires **before** file open (lines 434-498) |
| **AC-6** | Live incremental write + on-demand replay of any completed turn | **Met** | `FileIoCapture` opens `O_APPEND` and writes per-event; `graph-io-capture.spec.ts` tests 28-29 (every written line valid JSON; in-memory `read()` mirrors disk); `inspect.spec.ts` `show [turn]` renders completed turns on demand |
| **AC-7** | No-fallback typed error on un-initialisable inspector state | **Met** | **Live smoke S3a + S3b** (exit 3, `ConfigurationError` on `inspectIo.dir`, no silent disable); `io-capture.spec.ts` Step 13 f/f2 (un-creatable/unwritable dir → `ConfigurationError`), g/g2 (invalid boolean env → `ConfigurationError`) |
| **AC-8** | Provider neutrality (equivalent record structure across providers) | **Met** | `io-capture.spec.ts` Step 11 (Anthropic content-block array vs OpenAI plain string → identical `CapturedMessage` shape, lines 265-281); single `streamEvents v2` seam, no provider branches |
| **AC-9** | Persistence conventions (`0700`/`0600`, UTC name, `latest` pointer) | **Met** | `io-capture.spec.ts` Step 14 (dir `0o700`, file `0o600`, `session-<UTC>-<sessionId>.jsonl` regex, `latest.jsonl` pointer resolves to session file); live smoke S2 confirmed `io-captures/` at mode `0700` |
| **AC-10** | Docs updated (tool doc, functions, design, config-guide) | **Met** | grep hit counts: `docs/tools/cli-agent.md` 42, `docs/design/project-functions.md` 21 (FR-IOI-*/NFR-IOI-* + plan-007), `docs/design/project-design.md` 9, `docs/design/configuration-guide.md` 17 (env vars + flags + `inspectIo` + precedence + risk) |
| **AC-11** | New tests pass + existing suite green | **Met** | Full suite **954/954 pass**, exit 0 (§2); 126 feature tests pass in isolation; no real failures (the historically-flaky synthesizer passed both runs) |

**Score: 10 Met, 1 Partial (AC-2), 0 Not-Met.**

### AC-2 partial nuance (not a coding gap — a scope/wording boundary)

AC-2's tool-use-instruction surface is realized as the **bound tool/function JSON schemas** (`captureBoundToolSchemas` via `convertToOpenAITool`), which is captured and rendered — this fully satisfies the AC's "bound tool schemas + effective tool-use instruction text" at the request layer. The **per-tool prompt-overlay text and the agent-tools prompt block** named in FR-3d are captured **indirectly**: they are already composed into the assembled system-prompt string (captured verbatim from the `SystemMessage` in `data.input`), rather than emitted as a separate stand-alone overlay map. This matches refined-request assumption **A-2** ("instructions … injected into the request … the inspector will surface them on the request side") and design-007 exactly — the overlay/agent-tools text *is* present in every captured request, embedded in the system prompt. I mark AC-2 **Met** for the literal acceptance wording (system prompt + memory + user content + bound tool schemas are all captured and reproducible) and flag this only as an interpretive note: the overlays are inside the captured system prompt, not a discrete field. No additional work is implied by the AC text itself.

---

## 6. Review concerns still open

The Phase-7 code review (`docs/reference/code-review-llm-io-inspector.md`) listed three `[LOW]` "remaining concerns". Each was re-verified:

1. **[LOW] Legacy readline REPL (`--interactive`) not instrumented (vs refined-request A-4).** — **STILL OPEN (by design, non-blocking).** Verified: `runInteractiveAgent` in `src/agent/run.ts` calls bare `runOneShot(agentGraph, input, threadId, cfg.maxSteps)` (line 419) with no `ioCapture` and no `createIoCapture` in its body. The three `createIoCapture` call sites are `streamOneShotAgent` (run.ts:36), `runOneShotAgent` (run.ts:149), and `buildTuiAgentRuntime` (run.ts:278) only. Implementation matches design-007; design under-delivers vs A-4. Already logged as a `[LOW]` informational deviation in `Issues - Pending Items.md`. The TUI supersedes the legacy REPL, so impact is low.

2. **[LOW] `convertToOpenAITool` renders the OpenAI tool envelope; non-OpenAI providers differ at the wrapper level (wire-byte fidelity deferred).** — **STILL OPEN (by design, non-blocking).** The captured `parameters` JSON-Schema is identical across providers; only the envelope wrapper differs, and literal wire-byte capture is the explicitly deferred Open-Question-4 resolution. Documented as a known limitation in `cli-agent.md` / `project-design.md`. No dependency was added (`zod-to-json-schema` confirmed absent; `convertToOpenAITool` resolves from the already-installed `@langchain/core`).

3. **[LOW] Pre-existing flaky `composite/synthesizer.spec.ts (E-5)` ENOTEMPTY temp-dir race.** — **STILL OPEN (pre-existing, out of scope, non-blocking).** Out of scope for this feature; `src/agent/composite/` is untouched. It **passed** in both full-suite runs during this verification. Already logged in `Issues - Pending Items.md`.

All three are exactly the expected-still-open set called out in the task brief. **None block release.** The review's one reconciled discrepancy (`_orig_size_bytes` object-map vs scalar) was already resolved in-docs during the review and required no code change; re-confirmed reconciled.

---

## 7. Fixes applied during verification

**None.** Build, typecheck, and the full test suite were green on first run; all smoke probes passed. No production or test code was modified by this verification pass. (The report file and the new informational Issues entry below are the only artifacts written.)

---

## 8. Overall verdict

**READY.**

The LLM I/O Inspector builds cleanly (`npm run build` exit 0), passes the strict-TypeScript static gate (`npm run typecheck` exit 0), and passes the entire test suite (**954/954, exit 0**, including all 126 feature-owned tests). The switch is exercised end-to-end without a provider key: `--inspect-io`/`--inspect-io-raw` appear in `--help`; the off state writes zero capture files (byte-stability backbone — `logging.ts`/`system-prompt.ts`/`transcript/` untouched, `--help` byte-identical to baseline, zero dependency drift); and an explicitly-enabled-but-uninitialisable inspector raises a typed `ConfigurationError` (exit 3) rather than silently disabling — verified live via two independent misconfig paths (un-creatable dir and unwritable parent). Ten of eleven acceptance criteria are fully met with test/smoke evidence; AC-2 is met for its literal wording with an interpretive note (tool-use-instruction overlays are captured inside the assembled system prompt, per assumption A-2). The three remaining review concerns are all `[LOW]`, by-design, documented, and non-blocking.
