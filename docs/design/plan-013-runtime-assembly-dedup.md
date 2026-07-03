# Plan 013: Runtime Assembly Deduplication

## Provenance

- Refined request: `docs/reference/refined-request-runtime-assembly-dedup.md`
- Investigation: skipped; single established approach within the current runner layer.
- Technical research: skipped; no new technology or API is introduced.
- Codebase scan: `docs/reference/codebase-scan-runtime-assembly-dedup.md`

## Objective

Remove duplicated runtime assembly logic from the agent runner paths while preserving existing one-shot, streaming, TUI bootstrap, and legacy interactive behavior.

## Scope

In scope:
- Add a shared runtime assembly helper in the agent layer.
- Update `runOneShotAgent`, `streamOneShotAgent`, `buildTuiAgentRuntime`, and `runInteractiveAgent` to use it.
- Add focused Vitest coverage for the helper.
- Update project design, functional requirements, and issue tracking.

Out of scope:
- TUI slash-command rebuild helpers.
- Provider, tool catalog, capability discovery, or graph execution behavior changes.
- CLI flag or configuration behavior changes.

## Implementation Steps

1. Add a shared runtime assembly helper.
   - Own logger creation, LLM construction, tool catalog assembly, optional I/O capture construction, capability discovery, prompt composition, session/profile logging, and graph construction.
   - Accept a `threadId` option so callers can provide `tui-bootstrap` or a generated per-session id.

2. Refactor runner exports.
   - `runOneShotAgent` uses the helper, then logs `user_prompt`, invokes `runOneShot`, and closes logger plus I/O capture in `finally`.
   - `streamOneShotAgent` uses the helper, then logs `user_prompt`, streams with the existing abort-signal behavior, and closes logger plus I/O capture in `finally`.
- `buildTuiAgentRuntime` uses the helper and returns the open runtime for the TUI controller.
- `runInteractiveAgent` uses the helper and keeps its existing readline lifecycle, while closing the capture channel with the logger and passing it into per-turn `runOneShot`.

3. Add tests.
   - Mock the runtime dependencies and prove the helper executes the central sequence once.
   - Verify `session_start` and `profile_active` logging.
   - Verify the returned runtime carries the graph, logger, session id, thread id, and capture channel.

4. Update documentation and issue tracking.
   - Document the runtime assembly helper in `docs/design/project-design.md`.
   - Register the functional/non-functional requirement in `docs/design/project-functions.MD`.
   - Add a completed issue entry to `Issues - Pending Items.md` describing the duplication and fix.

## Files to Modify

- `src/agent/run.ts` — refactor duplicated assembly into shared helper and update runner paths.
- `src/agent/run.spec.ts` — new focused runtime assembly tests.
- `docs/design/project-design.md` — add design note for shared runtime assembly.
- `docs/design/project-functions.MD` — add requirement for centralized runtime assembly.
- `Issues - Pending Items.md` — completed issue/solution record.

## Validation

- `npm run typecheck`
- `npx vitest run src/agent/run.spec.ts`
- `npm run build`
- `npm test`

## Risks

- Closing ownership must remain path-specific: TUI must keep the logger and I/O capture open, while one-shot and streaming paths must close both.
- Legacy interactive now receives the same capture channel from the centralized runtime; this removes setup drift and makes close ownership explicit.
- Session start thread id must stay `tui-bootstrap` for TUI bootstrap logging.
