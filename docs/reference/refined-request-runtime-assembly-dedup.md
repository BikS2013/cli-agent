# Refined Request: Runtime Assembly Deduplication

## Category
Development

## Objective
Eliminate duplicated runtime assembly logic in the current agent runner implementation so one-shot, streaming, TUI bootstrap, and legacy interactive paths use a shared setup path for common agent runtime construction.

## Scope
In scope:
- Refactor the duplicated setup sequence currently repeated in `src/agent/run.ts`.
- Preserve behavior for:
  - one-shot agent execution,
  - streaming one-shot execution,
  - TUI runtime bootstrap,
  - legacy readline interactive execution.
- Keep existing logging, profile logging, capability discovery, system prompt composition, tool catalog construction, graph construction, and LLM I/O capture behavior intact.
- Add focused tests proving the shared assembly helper centralizes the repeated behavior and still logs profile/session metadata.
- Update relevant project documentation and issue tracking to record the issue and solution.

Out of scope:
- Changing provider behavior, graph execution semantics, TUI slash command rebuild flows, capability discovery policy, or tool catalog composition.
- Adding new runtime dependencies.
- Changing the public CLI interface.

## Requirements
- Introduce a single reusable runtime assembly helper that owns the common sequence:
  - create logger,
  - create session id,
  - create LLM,
  - build tool catalog,
  - create LLM I/O capture channel when requested by config,
  - run wrapped-tool capability discovery when configured tools exist,
  - compose capability/system prompt,
  - log `session_start`,
  - log `profile_active` when `cfg.activeProfile` exists,
  - build the agent graph.
- Replace duplicated setup code in `runOneShotAgent`, `streamOneShotAgent`, `buildTuiAgentRuntime`, and `runInteractiveAgent` with calls to the shared helper.
- Preserve distinct per-path behavior:
  - one-shot and streaming paths still log their own `user_prompt` event and close both logger and I/O capture in `finally`,
  - TUI bootstrap still returns an open logger and I/O capture for the controller to own,
  - legacy interactive still uses a mutable thread id and existing readline command behavior.
- Do not create fallback configuration behavior.
- Do not perform version control operations.

## Constraints
- Follow the existing TypeScript ESM style with `.js` local import specifiers.
- Use existing project abstractions (`createLLM`, `buildToolCatalog`, `buildSystemPromptForCfg`, `buildAgentGraph`, `createIoCapture`) instead of introducing parallel concepts.
- Keep changes narrowly scoped to the runner/runtime assembly surface and documentation.
- New tests must use the existing Vitest setup.

## Acceptance Criteria
- `src/agent/run.ts` no longer repeats the shared runtime setup sequence across the four runner paths.
- The shared helper is covered by focused unit tests that verify:
  - discovery and prompt composition are invoked through the helper,
  - session/profile logging is centralized,
  - the graph and I/O capture are returned for caller-specific execution/cleanup.
- Existing runner exports remain available with the same names and signatures.
- `npm run typecheck` passes.
- Focused Vitest tests for the changed runtime assembly pass.
- Project documentation records the resolved issue and the design change.

## Assumptions
- The finding refers to the duplication visible in `src/agent/run.ts` rather than the TUI slash-command graph rebuilders, which are separate mid-session rebuild flows.
- Keeping the helper in the agent layer is acceptable as long as runner exports remain stable.
- Legacy interactive mode does not need new I/O capture wiring beyond preserving existing behavior.

## Open Questions
None blocking. If the TUI slash-command rebuilders should also use the same helper later, that can be a separate follow-up because those paths intentionally rebuild only part of the runtime against an existing logger/session.

## Original Request
I have this finding in the current project 

  3. Runtime assembly is duplicated. One-shot, streaming, TUI, and legacy interactive paths repeat setup logic in src/agent/run.ts:20,
     increasing drift risk.

I want you to fix it
