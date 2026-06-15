# Refined Request: LLM I/O Inspector — a switch that opens a separate window recording the exact tool↔LLM conversation

## Category
Development

## Objective
Add a user-facing switch to `@biks2013/cli-agent` that, when enabled, surfaces an "LLM I/O inspector": a separate, clearly formatted view that records the full conversation between the CLI tool and the LLM, turn by turn. For every LLM round-trip the inspector must let the user inspect (a) the EXACT request the tool sent to the LLM — the complete assembled system prompt, the complete conversation memory, and the current user content, plus the tool-use instructions/tool schemas the tool supplies; and (b) the EXACT response received from the LLM — assistant text and any tool-call requests. The capture is a diagnostic/observability feature layered on top of the existing agent run loop; it must not change the agent's behaviour, output, or the bytes sent to the provider when the switch is off.

## Scope

- **In scope**:
  - A switch (final form decided in Open Questions, default: a CLI flag on the default `agent` command **and** an equivalent TUI slash command toggle) that turns capture ON for a session.
  - Capturing, per LLM turn, the request side: the fully-assembled system prompt (base + capabilities section + agent-tools block + `--system`/`--system-file` additions, exactly as produced by `buildSystemPromptForCfg` in `src/agent/system-prompt.ts`), the complete in-thread conversation memory (the `MemorySaver` message history for the active `thread_id`), and the new user/human content for that turn.
  - Capturing the tool-use instruction surface the tool exposes to the LLM: the per-tool prompt overlays / built-in tool prompts (`src/agent/tools/tool-prompt-overlay.ts`, `tool-prompts-builtin.ts`), the agent-tools prompt block, and the tool/function JSON schemas bound to the model. These are what the raw request calls "the instructions regarding the use of tools that the LLM requires via the CLI agent."
  - Capturing, per LLM turn, the response side: the assistant message content (assembled from the streamed tokens) and every tool-call the LLM requested (name + arguments), plus tool results returned back into the loop.
  - Presenting the captured records in a separate view that is readable and descriptive (clear per-turn sections, labelled request vs response, expandable/inspectable blocks for system prompt / memory / tool schemas).
  - A persisted, structured capture artifact on disk (JSONL) under the existing per-user agent directory, so a session can be inspected live and/or replayed after the fact.
  - Configuration wiring through the standard four-tier resolution chain (shell env → `~/.tool-agents/cli-agent/.env` → local `.env` → CLI flag) and a `config.json` key, consistent with every existing feature, including a typed error (no silent default) when an explicitly-requested inspector mode cannot be initialised.
  - Documentation updates: the `<cliAgent>` tool doc (`docs/tools/cli-agent.md`), `docs/design/project-functions.md`, `docs/design/project-design.md`, and `docs/design/configuration-guide.md`.
  - Unit/integration tests for the capture layer, the redaction behaviour, the switch precedence, and the off-state byte-stability invariant.

- **Out of scope**:
  - Editing, replaying-with-mutation, or re-sending captured requests to the LLM (read-only inspection only).
  - True on-the-wire provider-SDK byte capture (literal HTTP request/response bodies per provider). Default capture fidelity is the provider-normalized LangChain message layer (see Open Question 4); raw-wire capture, if ever wanted, is a separate follow-up.
  - A full graphical desktop application or any new heavy GUI framework / Electron.
  - Changing the existing `src/agent/logging.ts` event schema in a breaking way, or changing the existing transcript persistence format under `src/tui/transcript/`.
  - Multi-session aggregation dashboards, search across historical sessions, or analytics.
  - Capturing inside the capability-discovery LLM calls and the composite-synthesis LLM calls (the inspector targets the main interactive/one-shot agent conversation; discovery/synthesis instrumentation is a possible later extension, noted as an assumption).
  - Network transport of captures off the local machine.

## Requirements

Functional:

1. **FR-1 (Switch — enable capture).** Provide a way for the user to enable the LLM I/O inspector for a session. Default form (subject to Open Question 2): a CLI flag on the default agent command (proposed `--inspect-io`) AND a TUI slash command that toggles capture for the running session (proposed `/inspect`). When the switch is off, no capture work is performed and the agent's outward behaviour and provider payloads are byte-identical to today.

2. **FR-2 (Separate presentation surface).** When enabled, the captured conversation must be presented in a SEPARATE surface from the primary chat output — not interleaved into the normal streaming transcript. The concrete realisation of "separate window" is decided in Open Question 1; the default recommendation is: write a structured, human-readable capture file (JSONL plus an on-demand rendered/pretty view) that the user opens/tails in a second terminal or their own viewer, AND provide an in-TUI command (proposed `/inspect show [turn]`) that renders a chosen turn's full request+response in a clearly delimited, scrollable block. The chosen surface must not corrupt or race the raw-mode TUI rendering (cf. the spinner/stdout race already handled in `src/tui/controller.ts`).

3. **FR-3 (Exact request capture).** For each LLM turn, capture and present the exact request payload the tool handed to the model:
   - 3a. The complete assembled **system prompt** string (post-composition), as sent for that turn.
   - 3b. The complete **conversation memory**: the ordered list of prior messages (human/ai/tool) the model receives for that turn, sourced from the active thread's `MemorySaver` state / the messages passed into the graph invocation.
   - 3c. The current turn's **user/human content**.
   - 3d. The **tool-use instruction surface**: the effective per-tool prompt overlays / built-in tool prompts, the agent-tools prompt block, and the tool/function **JSON schemas** bound to the model for that turn (names, descriptions, parameter schemas).

4. **FR-4 (Exact response capture).** For each LLM turn, capture and present the exact response received from the model:
   - 4a. The assistant message **content** (final assembled text; and, where available, the streamed fragments).
   - 4b. Every **tool-call request** the model emitted (tool name + arguments object), in order.
   - 4c. The **tool results** subsequently fed back into the loop for that turn (tool name + result payload + duration + ok/error), so the request→response→tool-result chain is inspectable end to end.

5. **FR-5 (Turn correlation).** Each captured record must be correlated by `sessionId`, `threadId`, and `turnId` (the same identifiers already used by `src/agent/logging.ts` and `src/agent/graph.ts`), so request, response, tool calls, and tool results for one turn group together and render as one coherent unit.

6. **FR-6 (Clear, descriptive rendering).** The presented view must clearly label and visually separate: turn number/timestamp; the request block (system prompt, memory, user content, tool schemas) and the response block (assistant text, tool calls, tool results). Long blocks (system prompt, memory, schemas) must be individually identifiable and inspectable (e.g. collapsible/expandable or addressable by section) rather than dumped as one undifferentiated wall of text.

7. **FR-7 (Live vs replay).** The capture store must be written incrementally as the conversation proceeds (append-per-event), so it is usable live. The presentation surface must support at least post-hoc/on-demand inspection of any completed turn; live auto-refresh of the separate surface is desirable but its necessity is gated by Open Question 5 (default: file is written live and tailable; the in-TUI `/inspect show` renders on demand).

8. **FR-8 (Persistence + retrieval).** Captures must be persisted under the existing per-user agent directory using the established conventions (directory mode `0700`, files mode `0600`), at a path discoverable by the user (proposed `~/.tool-agents/cli-agent/io-captures/session-<UTC>-<sessionId>.jsonl`, with a `latest.jsonl` convenience pointer mirroring `src/agent/logging.ts`). The exact location is confirmed in Open Question 6.

9. **FR-9 (Redaction policy).** Reconcile "exact content" with secret-safety: by default, captured payloads written to disk and shown in the separate surface must pass through the existing redaction helper (`src/util/redact.ts`), matching the project's existing logging behaviour. Because the user explicitly asked for "exactly" what was sent, provide an explicit, clearly-named opt-out (proposed `--inspect-io-raw` / env equivalent) that disables redaction for the capture surface only, gated behind an explicit user choice and a visible warning. Default = redaction ON. Final policy confirmed in Open Question 3.

10. **FR-10 (No-fallback configuration).** Follow the strict project rule: when the inspector is explicitly requested but cannot be initialised (e.g. the capture directory cannot be created, an invalid mode value is supplied, or the chosen "window" mechanism is unavailable), raise the appropriate typed error (`ConfigurationError` / `UsageError` with the correct exit code) — never silently disable capture or substitute a default mode.

11. **FR-11 (Reuse, do not duplicate).** Implement capture by extending the existing instrumentation seam rather than building an unrelated parallel pipeline where avoidable: the natural hook points are the graph invocation boundary in `src/agent/graph.ts` (`runOneShot` / `streamOneShot`, where messages, system prompt, and stream events are already visible) and the existing `Logger` in `src/agent/logging.ts`. Whether the capture is a new event channel on the existing logger or a sibling capture writer is an implementation decision (Open Question 7) but must not fork the redaction/permission conventions.

12. **FR-12 (Provider neutrality).** Capture must work uniformly across all eight supported providers at the normalized message layer, since it hooks above the provider SDK. No provider-specific capture code paths in the default fidelity level.

Non-functional:

13. **NFR-1 (Off-state byte-stability & zero overhead).** With the switch off, there must be measurable zero behavioural change: the system prompt, the provider request, the streamed output, the existing log lines, and the existing transcript files are byte-identical to current `master`. A regression test must assert this (mirroring the existing `cli-help-baseline.spec.ts` byte-stability discipline; note the new flag will require regenerating the `--help` baseline).

14. **NFR-2 (TUI safety).** The inspector must never corrupt the raw-mode TUI: no interleaving of capture output into the live token stream, no spinner/stdout column races, and graceful no-op on non-TTY / `CLI_AGENT_NO_TUI=1` contexts for any TUI-resident surface.

15. **NFR-3 (Performance).** Capture must not materially slow a turn. Large payloads (system prompt, memory) must be size-bounded with explicit truncation markers consistent with the existing 64 KiB field-cap behaviour in `src/agent/logging.ts`, rather than being dropped silently.

16. **NFR-4 (Security & permissions).** All capture artifacts inherit the existing secret-handling posture: `0700` dir / `0600` files, redaction on by default, and the redaction opt-out must be impossible to enable by accident (explicit flag/env + warning).

17. **NFR-5 (TypeScript / ESM consistency).** All new code is TypeScript ESM consistent with the existing `src/` layout, conventions, and lint rules; new persisted records are typed; new config keys are camelCase in `config.json` and `SCREAMING_SNAKE_CASE` for env vars (prefixed `CLI_AGENT_`).

18. **NFR-6 (Documentation completeness).** The feature is documented in the four canonical docs listed in scope, including the configuration-guide treatment of the new variables (purpose, how to set, precedence, default value, and — per project rule — an expiration-date note for any expiring credential, N/A here but the redaction opt-out's risk must be documented).

## Constraints

- **Technical stack**: TypeScript, ESM, `commander` for CLI surface (`src/cli.ts`), LangGraph/LangChain ReAct agent (`createReactAgent`, `MemorySaver`, `streamEvents` v2). Capture must hook at the `src/agent/graph.ts` invocation boundary and/or `src/agent/logging.ts`.
- **No new heavy UI dependency**: prefer the existing single-process Node/TS + raw-mode TUI approach. Any new runtime dependency must pass the project's `dependency-validation` skill before adoption; the default-recommended realisation (JSONL file + in-TUI renderer + "open in a second terminal") needs no new dependency.
- **No-fallback rule (hard)**: missing/!initialisable required configuration → typed exception, never a default substitute. Any deliberate exception must be recorded in the project memory file before implementation.
- **Redaction reuse**: reuse `src/util/redact.ts`; do not invent a second redaction scheme.
- **Filesystem conventions**: persist under `~/.tool-agents/cli-agent/`, dir `0700`, files `0600`, UTC-stamped filenames, optional `latest.*` pointer — matching `src/agent/logging.ts` and `src/tui/transcript/persist.ts`.
- **Byte-stability discipline**: the `--help` output baseline and any prompt-composition baselines must be preserved/regenerated deliberately (`cli-help-baseline.spec.ts` pattern).
- **Tooling/process**: per project rules, the implementation plan goes under `docs/design/plan-xxx-*.md`; functional requirements are registered in `docs/design/project-functions.md`; the full design is reflected in `docs/design/project-design.md`. This is an extension of the existing `cli-agent` tool, NOT a new standalone tool, so no new `docs/tools/<name>.md`/`~/.tool-agents/<name>/` scaffold is created — the existing `docs/tools/cli-agent.md` is updated.

## Acceptance Criteria

1. **AC-1 (Switch off = no change).** Running the agent without the inspector switch produces byte-identical provider requests, streamed output, existing JSONL log lines, transcript files, and `cli-agent --help` output compared to pre-change `master`. Verified by an automated byte-stability test.

2. **AC-2 (Switch on, request fidelity).** With the inspector enabled, after a multi-turn conversation that uses at least one tool call, the capture artifact and the separate presentation contain, for each turn: the complete assembled system prompt, the full ordered conversation memory, the user content, and the bound tool schemas + effective tool-use instruction text. A reviewer can read back exactly what context the model received for any chosen turn.

3. **AC-3 (Switch on, response fidelity).** For the same conversation, each turn's capture contains the assistant text, every tool-call (name + args) the model requested, and the corresponding tool results (name + result + duration + ok/error), correctly correlated by `sessionId`/`threadId`/`turnId`.

4. **AC-4 (Separate surface).** The captured conversation is presented in a surface distinct from the primary chat stream (a second-terminal-tailable file and/or an in-TUI `/inspect show` view), is clearly labelled (turn, request vs response, sub-blocks), and does not interleave with or corrupt the live token stream or the spinner.

5. **AC-5 (Redaction default + opt-out).** By default, secrets/API-key-shaped values in captured payloads are redacted using `src/util/redact.ts` (demonstrated by a test feeding a known secret-shaped string through a turn and asserting it is masked in the capture). The documented raw opt-out disables redaction for the capture only and emits a visible warning; with it off, the same value appears verbatim.

6. **AC-6 (Live write + replay).** The capture file is written incrementally during the session (a partially-completed session still yields a readable, valid-so-far artifact) and any completed turn can be inspected on demand after the session via the chosen retrieval path.

7. **AC-7 (No-fallback errors).** Forcing an un-initialisable inspector state (e.g. unwritable capture directory, invalid mode value) causes the agent to exit with the correct typed error and exit code, with a clear message — never a silent fallback to "capture disabled".

8. **AC-8 (Provider neutrality).** Capture produces equivalent record structure under at least two different providers (e.g. an OpenAI-compatible and an Anthropic path) without provider-specific capture branches.

9. **AC-9 (Persistence conventions).** Capture artifacts exist at the documented path with directory mode `0700` and file mode `0600`, UTC-stamped, with a working `latest` pointer (or documented equivalent).

10. **AC-10 (Docs).** `docs/tools/cli-agent.md`, `docs/design/project-functions.md`, `docs/design/project-design.md`, and `docs/design/configuration-guide.md` are updated to describe the switch, the separate surface, the capture format/location, the redaction policy and its opt-out risk, and the precedence of every new configuration variable.

11. **AC-11 (Tests green).** New unit/integration tests for capture content, redaction, switch precedence, off-state byte-stability, and error-on-misconfiguration pass, and the full existing suite remains green.

## Assumptions

- **A-1**: The phrase "a separate window" is interpreted, for a terminal-first Node/TS CLI, as a separate *presentation surface* rather than a literal OS-native GUI window — most pragmatically a structured capture file the user opens/tails in a second terminal, complemented by an in-TUI on-demand inspector view. The literal mechanism is escalated as Open Question 1. Basis: the tool is an established single-process raw-mode TUI with no GUI layer and an explicit "no Ink/Blessed" stance, and it already persists JSONL logs and transcripts under `~/.tool-agents/cli-agent/`.
- **A-2**: "The instructions regarding the use of tools that the LLM requires via the CLI agent" maps to the tool-prompt overlays / built-in tool prompts (`src/agent/tools/tool-prompt-overlay.ts`, `tool-prompts-builtin.ts`), the agent-tools prompt block, and the JSON tool/function schemas bound to the model — these are the artefacts that tell the LLM how to call the CLI agent's tools. They are part of the *request* surface (system prompt + bound schemas), even though the raw request grouped them under "the LLM response"; the inspector will surface them on the request side and also show the resulting tool-call requests on the response side. Basis: in this codebase tool-use instructions are authored by the tool and injected into the request; the LLM's tool *usage* appears as tool_calls in the response.
- **A-3**: Default capture fidelity is the provider-normalized LangChain message layer (the messages and config visible at `graph.invoke`/`streamEvents` in `src/agent/graph.ts`), not literal per-provider HTTP bytes. Escalated as Open Question 4. Basis: this is the single provider-agnostic seam where "exact content sent" is observable uniformly across all eight providers without SDK-specific hooks.
- **A-4**: Capture targets the main interactive (TUI), one-shot, and legacy-REPL agent conversations. The capability-discovery and composite-synthesis LLM calls are out of initial scope (possible later extension). Basis: the raw request is about "the conversation between the terminal and the LLM," i.e. the user-facing chat loop.
- **A-5**: New config follows existing patterns: a `config.json` key (proposed `inspectIo` object: `{ enabled?: boolean; redact?: boolean; dir?: string }`), env vars `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW`, and CLI flags `--inspect-io` / `--inspect-io-raw`, resolved via the standard four-tier chain. Defaults are explicit starting values applied after resolution, not runtime fallbacks for missing required config. Basis: mirrors `agentTools` and capability config in `src/config/agent-config.ts`.
- **A-6**: The conversation memory shown is the in-thread message history for the active `thread_id` (what the model actually receives), obtained from the `MemorySaver` checkpointer / the graph input, consistent with how `/memory` already reads `agentGraph.checkpointer.get(...)` in `src/tui/slash/memory.ts`.
- **A-7**: Captured payloads are size-bounded with explicit truncation markers (reusing the 64 KiB field-cap discipline from `src/agent/logging.ts`) rather than unbounded, to protect performance and disk. Basis: existing logging already caps fields.
- **A-8**: This is an extension of the existing `cli-agent` tool; no new tool scaffold is created. Basis: project "examine existing tools first / extend rather than fork" rule and the existing single-tool structure.
- **A-9**: No existing `docs/design/project-design.md`/`project-functions.md` content is being contradicted; these files exist and will be appended to. (Both files are present under `docs/design/`.)

## Open Questions

1. **Question**: What should "a separate window" concretely be? Options: (a) a detached native terminal window / `tmux` / `screen` pane spawned by the tool; (b) a local web UI auto-opened in the browser; (c) an in-TUI split-pane/overlay inside the existing raw-mode UI; (d) a live-tailed structured capture file (JSONL + rendered view) the user opens in a second terminal / their own viewer; (e) a combination.
   **Why it matters**: This is the single biggest scope and effort driver and dictates the entire UI sub-design (new dependencies, IPC, rendering, TTY handling). It determines whether a new runtime dependency or a web server is introduced and how much TUI-rendering risk is taken on.
   **Recommended default**: **(d) + a light (c)** — make the source of truth a structured, human-readable JSONL capture file (+ an on-demand pretty-rendered view) under `~/.tool-agents/cli-agent/io-captures/`, tailable in a second terminal, complemented by an in-TUI `/inspect show [turn]` command that renders a chosen turn's full request+response in a clearly delimited block. Rationale: zero new heavy dependencies, no IPC/web-server complexity, no Ink/Blessed (respecting the project's stated TUI stance), reuses the established JSONL+`latest.*` persistence pattern, works in non-TTY/one-shot contexts, and still gives a genuinely "separate," clearly presented surface. A detached terminal window (a) can be offered later as a thin convenience wrapper that simply tails the same file.

2. **Question**: What is the scope of the switch — a CLI flag on the `agent` command, a TUI slash command, or both?
   **Why it matters**: Determines whether capture can be enabled at launch (needed for one-shot and for capturing the very first turn) versus toggled mid-session, and shapes the precedence/wiring surface.
   **Recommended default**: **Both** — a launch-time CLI flag (`--inspect-io`, plus `--inspect-io-raw`) so one-shot and first-turn capture work, AND an in-session TUI slash toggle (`/inspect on|off`, `/inspect show [turn]`) for interactive control.

3. **Question**: Must captured payloads be redacted via `src/util/redact.ts`, or shown verbatim (since the request emphasises "exactly" what was sent)? And how do we reconcile exactness with secret-safety?
   **Why it matters**: Captures will contain the full system prompt and memory, which can include credential-shaped values, `.env`-derived material, and tool output. Writing these verbatim to disk is a real secret-exposure risk; over-redacting undermines the "exact" goal.
   **Recommended default**: **Redaction ON by default**, reusing `src/util/redact.ts` (consistent with existing logging), WITH an explicit, clearly-named opt-out (`--inspect-io-raw` / `CLI_AGENT_INSPECT_IO_RAW=1`) that disables redaction for the capture surface only and prints a prominent warning. This satisfies "exact" on demand while keeping the safe path the default. The opt-out and its risk are documented in `configuration-guide.md`.

4. **Question**: What fidelity of "exact" is required — provider-normalized LangChain messages (the objects passed at the `graph.invoke`/`streamEvents` boundary) or the literal on-the-wire provider HTTP request/response bytes (which differ per provider SDK)?
   **Why it matters**: Wire-level capture is materially more work (per-provider SDK hooks/interceptors, eight providers, brittle to SDK upgrades) and would fork the provider-neutral design; the normalized layer is one uniform seam but is one transformation step away from the literal bytes.
   **Recommended default**: **Provider-normalized message layer** as the shipped fidelity (uniform across all eight providers, single hook in `src/agent/graph.ts`). Treat literal wire-byte capture as an explicitly deferred follow-up, documented as a known limitation. If the user truly needs wire bytes, that becomes a separate, provider-by-provider effort.

5. **Question**: Must the separate surface update in real time as tokens stream, or is incremental-write-to-store plus on-demand presentation/replay acceptable?
   **Why it matters**: Live auto-refresh of a separate surface (especially a TUI pane or web UI) adds streaming/IPC/refresh complexity; on-demand rendering of completed turns is much simpler and matches how captures are typically reviewed.
   **Recommended default**: **Incremental write + on-demand/replay presentation.** The capture FILE is written live (so a second-terminal `tail -f` already shows it updating), but the structured in-TUI inspector renders a completed turn on demand rather than maintaining a live-refreshing pane. Full live-refresh of an in-app pane is deferred unless explicitly required.

6. **Question**: Should captures be persisted to disk for later inspection, and where?
   **Why it matters**: Determines whether the feature supports post-hoc review (likely the main use), and whether it reuses the established per-user directory conventions or introduces a new location.
   **Recommended default**: **Yes, persist** under the existing per-user agent dir at `~/.tool-agents/cli-agent/io-captures/session-<UTC>-<sessionId>.jsonl` with a `latest.jsonl` pointer, directory `0700` / files `0600`, mirroring `src/agent/logging.ts`. Not auto-pruned (consistent with the existing checkpoint-snapshot policy); pruning is the user's responsibility and documented.

7. **Question**: Should the capture extend the existing `src/agent/logging.ts` event stream / `src/tui/transcript/` persistence, or be a parallel capture channel?
   **Why it matters**: Extending the existing logger risks bloating the operational log with very large prompt/memory payloads and coupling two concerns; a parallel channel keeps the inspector's heavy payloads separate but adds a new writer to maintain.
   **Recommended default**: **A dedicated, parallel capture channel** (its own JSONL writer + typed record schema) that REUSES the existing redaction helper, filesystem conventions (`0700`/`0600`, UTC names, `latest.*`), and turn-correlation IDs from `src/agent/logging.ts` — but writes to its own `io-captures/` store so the heavy system-prompt/memory payloads never bloat the operational `logs/` stream. The existing logger and transcript formats remain unchanged (preserving NFR off-state stability).

## Open Questions — Resolutions (orchestrator + user, 2026-06-13)

All seven open questions were resolved with the user via the team-workflow Phase 1 open-questions gate. **Every question was answered with the refiner's recommended default.** These resolutions are now authoritative for all downstream phases (investigation, planning, design, implementation, review, testing):

1. **"Separate window" form → (d) + light (c): tailable JSONL capture file + in-TUI `/inspect show [turn]` renderer.** The source of truth is a structured, human-readable JSONL capture file under `~/.tool-agents/cli-agent/io-captures/`, tailable in a second terminal, complemented by an in-TUI `/inspect show [turn]` command that renders a chosen turn's full request+response in a clearly delimited block. No new heavy dependency, no web server, no Ink/Blessed, no detached-window spawning. A detached terminal window may be offered later as a thin convenience wrapper that tails the same file (explicitly deferred).
2. **Switch scope → Both.** A launch-time CLI flag (`--inspect-io`, plus `--inspect-io-raw`) so one-shot and first-turn capture work, AND an in-session TUI slash toggle (`/inspect on|off`, `/inspect show [turn]`).
3. **Redaction → Redaction ON by default, with explicit opt-out.** Captures pass through `src/util/redact.ts` by default; an explicit `--inspect-io-raw` / `CLI_AGENT_INSPECT_IO_RAW=1` disables redaction for the capture surface only, printing a prominent warning. Documented in `configuration-guide.md`.
4. **Capture fidelity → Provider-normalized LangChain message layer.** Single uniform hook at the `src/agent/graph.ts` invocation boundary across all eight providers. Literal on-the-wire per-provider HTTP-byte capture is explicitly deferred and documented as a known limitation.
5. **Live vs replay → Incremental live write + on-demand presentation.** The capture file is written incrementally (so a second-terminal `tail -f` updates live); the in-TUI inspector renders a completed turn on demand rather than maintaining a live-refreshing pane. Full in-app live-refresh is deferred.
6. **Persistence + location → Persist under the per-user agent dir.** `~/.tool-agents/cli-agent/io-captures/session-<UTC>-<sessionId>.jsonl` with a `latest.jsonl` pointer, directory `0700` / files `0600`, mirroring `src/agent/logging.ts`. Not auto-pruned (user's responsibility, documented).
7. **Capture channel → Dedicated parallel channel.** Its own JSONL writer + typed record schema in `io-captures/`, REUSING the existing redaction helper, filesystem conventions, and turn-correlation IDs from `src/agent/logging.ts`, but writing to its own store so heavy system-prompt/memory payloads never bloat the operational `logs/` stream. Existing logger and transcript formats remain unchanged (preserves off-state byte-stability).

## Original Request
I want you to add a switch to the CLI agent tool that opens a separate window where the conversation between the terminal and the LLM is recorded and presented clearly and descriptively.

This window should allow the user to inspect exactly the content the client tool sent to the LLM, and the exact response received, including the complete memory and system prompt sent to the LLM along with the content, and for the LLM response, the instructions regarding the use of tools that the LLM requires via the CLI agent.
