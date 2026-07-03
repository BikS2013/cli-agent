# Refined Request: Sync Design Docs for File Tools and Capability Invalidation

## Category
Documentation

## Objective
Update the project documentation so the design and functional requirements match the current implementation for file-tool registration and capability-cache behavior: file operations now live in the agent-tools pack as `agt_file_*` tools, and normal startup trusts an existing capability document via the doc-exists shortcut until the user explicitly refreshes capabilities.

## Scope
- **In scope**:
  - Update `docs/design/project-design.md` to remove or revise stale descriptions that present `file_read`, `file_list`, `file_write`, `file_edit`, or `file_append` as current built-in cross-cutting tools.
  - Update `docs/design/project-design.md` to describe the current built-in toolkit as `bash_run`, `bash_list_allowed`, `bash_which`, and `tool_help`, with file and web operations documented as `agt_*` agent-tools pack members.
  - Update `docs/design/project-design.md` to describe current capability discovery/cache behavior: normal startup uses the doc-exists shortcut and skips probing when a capability document already exists unless refresh is forced.
  - Update `docs/design/project-functions.md` so functional requirements no longer require automatic normal-startup invalidation on `binaryPath`, `binaryMtimeMs`, or `versionHash` changes, and instead specify explicit refresh as the refresh/invalidation mechanism.
  - Ensure the requirements still state that `cli-agent refresh-capabilities`, `--refresh-capabilities`, and the TUI `/refresh-capabilities` command perform full rediscovery.
  - Reconcile the matching pending item in `Issues - Pending Items.md` after the documentation fix is completed, either by moving it to completed or updating it to reflect any remaining work.
  - Preserve existing historical plan references where useful, but make the current contract unambiguous to future agents.
- **Out of scope**:
  - No source-code behavior changes.
  - No changes to runtime cache logic, tool registration logic, CLI flags, or tests except documentation-validation commands.
  - No rewrite of unrelated design sections.
  - No new investigation, architecture redesign, or alternative cache strategy evaluation.
  - No changes to already-current user-facing docs unless validation finds a directly conflicting statement in scope.

## Requirements
1. In `docs/design/project-design.md`, the architecture overview and tool catalog sections must no longer describe `file_read`, `file_list`, `file_write`, `file_edit`, or `file_append` as current built-in tools.
2. In `docs/design/project-design.md`, the current built-in cross-cutting toolkit must be documented as `bash_run`, `bash_list_allowed`, `bash_which`, and `tool_help`.
3. In `docs/design/project-design.md`, the agent-tools pack section must state that first-party file tools are `agt_file_read`, `agt_file_list`, `agt_file_write`, `agt_file_edit`, and `agt_file_append`.
4. The documentation must state that `agt_file_read` and `agt_file_list` are read-only and default-on when the agent-tools pack is enabled.
5. The documentation must state that `agt_file_write`, `agt_file_edit`, and `agt_file_append` are mutation-gated and only register when their per-tool flag is enabled and mutations are allowed.
6. The documentation must state that `--no-builtin-tools` does not disable `agt_file_*` tools, and that `--no-agent-tools` or the relevant `--disable-agt-file-*` flags govern those tools.
7. In `docs/design/project-design.md`, capability discovery/cache documentation must describe the current normal-startup behavior: if a valid capability document already exists and refresh is not forced, discovery treats it as cached and skips binary probing and LLM rediscovery.
8. In `docs/design/project-functions.md`, `FR-AGT-005` and `FR-AGT-006` must be revised so they do not require normal-startup cache invalidation on binary path, mtime, or version hash changes.
9. In `docs/design/project-functions.md`, explicit refresh behavior must remain documented: `cli-agent refresh-capabilities`, `--refresh-capabilities`, and TUI `/refresh-capabilities` bypass cached docs and perform complete capability investigation.
10. The final docs must be internally consistent with the current implementation evidence in `src/agent/capabilities/discover.ts`, `src/agent/tools/agent-tools/group-builder.ts`, and `src/agent/tools/agent-tools/index.ts`.
11. The existing pending issue titled "Project design and requirements still describe pre-plan-011/012 tool catalog and old capability invalidation" in `Issues - Pending Items.md` must be updated after the docs are fixed.
12. The documentation fix must not introduce fallback configuration behavior, dependency changes, new scripts, or new implementation requirements.

## Constraints
- Follow the project documentation layout: design material belongs under `docs/design/`, reference material under `docs/reference/`, and issue tracking under `Issues - Pending Items.md`.
- Preserve the existing project convention that `docs/design/project-design.md` is the complete project design and `docs/design/project-functions.md` is the functional requirements registry.
- Do not implement runtime behavior changes; this request is limited to bringing documentation into alignment with already-current code.
- Do not perform version-control operations.
- Keep edits focused on the stale file-tool and capability-cache statements identified by the finding.
- Treat `docs/tools/cli-agent.md` and `README.md` as supporting context; they appear to already describe the current behavior and should not be rewritten unless a directly conflicting in-scope statement is found.

## Acceptance Criteria
1. `docs/design/project-design.md` no longer has any current-contract section that lists `file_read`, `file_list`, `file_write`, `file_edit`, or `file_append` as built-in tools.
2. `docs/design/project-design.md` explicitly lists the current built-in toolkit as `bash_run`, `bash_list_allowed`, `bash_which`, and `tool_help`.
3. `docs/design/project-design.md` explicitly documents `agt_file_read`, `agt_file_list`, `agt_file_write`, `agt_file_edit`, and `agt_file_append` under the agent-tools pack with the correct mutation gating and toggle ownership.
4. `docs/design/project-design.md` describes the doc-exists shortcut for normal startup and makes clear that path/mtime/version probing is not performed when an existing doc is trusted.
5. `docs/design/project-functions.md` no longer states that normal startup must invalidate capability cache entries whenever `binaryPath`, `binaryMtimeMs`, or `versionHash` changes.
6. `docs/design/project-functions.md` still states that explicit refresh commands perform complete rediscovery and bypass the cached document shortcut.
7. `Issues - Pending Items.md` no longer presents the design/requirements docs drift as unresolved after the docs are fixed, or else narrows the pending item to any remaining verified gap.
8. A targeted search over `docs/design/project-design.md` and `docs/design/project-functions.md` confirms remaining references to old `file_*` names are historical, migration-related, or explicitly contrasted with the current `agt_file_*` contract.
9. A targeted search over `docs/design/project-design.md` and `docs/design/project-functions.md` confirms remaining references to `binaryPath`, `binaryMtimeMs`, `mtime`, or `versionHash` do not describe current normal-startup invalidation.
10. No source files under `src/` are modified for this documentation-only request.

## Assumptions
- The current implementation is the source of truth: `src/agent/capabilities/discover.ts` intentionally implements the doc-exists shortcut, and the docs should be changed to match it rather than restoring automatic invalidation.
- `README.md` and `docs/tools/cli-agent.md` are already substantially aligned with the current behavior, based on their existing references to `agt_file_*` tools and explicit-refresh cache behavior.
- The requested "fix" includes updating the pending issue tracker because the project instructions require issues and solutions to be documented when issues are solved.
- Historical design notes may continue to mention old `file_*` names if they are clearly framed as prior behavior or migration history.

## Open Questions
- Should `FR-AGT-006` be renamed from "Capability Cache Invalidation" to a term such as "Capability Cache Refresh" to avoid implying automatic invalidation, or should the heading remain stable while the contract text changes?

## Original Request
I have this finding in the current project 

  4. Docs are behind implementation. The design still describes old built-in file-tool behavior and old capability invalidation, while
     current code uses agt_file_* and a doc-exists shortcut.

I want you to fix it
