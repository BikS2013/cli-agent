# Architecture Review: cli-agent

Date: 2026-06-15

Related prior artifacts:
- `docs/reference/refined-request-project-evaluation.md`
- `docs/reference/codebase-scan-project-evaluation.md`
- `docs/reference/project-evaluation.md`

## Scope

Review the current repository from an architectural and structural perspective and suggest fixes that improve maintainability, safety, efficiency, and robustness. This review is advisory; no source-code remediation is included.

## Verification

| Check | Result | Notes |
|---|---:|---|
| `npm run typecheck` | PASS | TypeScript strict compile check completed cleanly. |
| `npm test` | PASS | 87 test files, 1117 tests passed. |
| `npm audit --audit-level=high` | FAIL | 14 vulnerabilities: 9 moderate, 3 high, 2 critical. |

The test run still emits the known duplicate-case warning in `src/tui/input/line-editor.ts`.

## Architecture Summary

`cli-agent` has a coherent high-level architecture:

- `src/cli.ts` owns the Commander surface.
- `src/config/agent-config.ts` owns most configuration resolution and bootstrap behavior.
- `src/agent/run.ts` assembles runtime sessions.
- `src/agent/graph.ts` wraps LangGraph invoke/stream behavior.
- `src/agent/tools/registry.ts` builds the model-visible tool catalog.
- `src/agent/tools/agent-tools/` now owns file and web `agt_*` tools.
- `src/tui/` owns the raw terminal interface and slash-command surface.

The strongest architectural trait is the explicit separation between configuration, catalog assembly, system-prompt assembly, graph execution, and UI. The main weakness is that the system has grown enough parallel runtime paths and documentation surfaces that drift is now the main risk.

## Priority Findings

### 1. Dependency audit is release-blocking

`npm audit --audit-level=high` currently fails with high/critical issues in the dependency tree. The project has strong tests, but `prepublishOnly` only runs clean/build/test and does not include audit.

Recommended fix:
- Run a dedicated dependency-upgrade task, starting with non-breaking `npm update`.
- Isolate the `vitest` major upgrade because the audit-recommended full fix wants a breaking dev-toolchain jump.
- Add an audit gate to release validation after the tree is clean.

### 2. Web search credentials bypass the layered config architecture

`bootstrapAgentDir` seeds web backend variables into `.env`, and `loadAgentConfig` reads those names into `layered`. But `src/agent/tools/web/backends/registry.ts`, `agt_web_search`, `agt_web_fetch`, and `group-builder.ts` still read `process.env` directly for backend keys and request budgets.

Impact:
- `~/.tool-agents/cli-agent/.env` and local `.env` values can be ignored for web tools.
- The docs say the agent `.env` is a valid source, so users can get false missing-key errors.
- This breaks the otherwise good pattern where providers consume a frozen config snapshot.

Recommended fix:
- Add a resolved `webSearch` snapshot to `AgentConfig`, including backend, credentials, custom URL, and `maxRequests`.
- Populate it from the same layered resolver used for providers.
- Make all web backend/wrapper code consume `cfg.webSearch` and stop reading `process.env` directly.

### 3. Runtime assembly is duplicated across four paths

`runOneShotAgent`, `streamOneShotAgent`, `buildTuiAgentRuntime`, and `runInteractiveAgent` repeat the same sequence: create logger, create LLM, build catalog, discover capabilities, compose capability prompt, build system prompt, log profile metadata, and build the graph.

Impact:
- Feature additions must be wired four times.
- The legacy interactive path already differs from the newer paths: I/O capture is not passed into its `runOneShot` call.
- Future prompt/catalog/capture changes are likely to drift again.

Recommended fix:
- Extract a shared `createAgentRuntime(cfg, options)` helper returning logger, session id, tools, metadata, graph, I/O capture, and lifecycle helpers.
- Let one-shot, streaming, TUI, and legacy interactive modes differ only at the event/render loop layer.

### 4. Design and requirements are behind the implementation

`docs/design/project-design.md` still describes file tools as built-ins in the architecture diagram and standard tool table. `docs/design/project-design.md` and `docs/design/project-functions.md` also describe automatic cache invalidation by binary path, mtime, and version hash. The current code intentionally uses a doc-exists shortcut and skips probing unless refresh is forced.

Recommended fix:
- Update the design and requirements to state the current contracts:
  - built-in toolkit is `bash_*` plus `tool_help`;
  - file/web tools are `agt_*` members governed by `--agent-tools`;
  - normal startup trusts existing capability docs;
  - explicit refresh performs full rediscovery.

### 5. `AGENTS.md` instruction drift remains high-impact

The root `AGENTS.md` begins with an older, shorter `Structure & Conventions` chapter. The current user-level version includes request refinement, investigation/research, codebase scanning, and dependency-vetting rules that the project file does not include.

Recommended fix:
- Replace the leading `Structure & Conventions` block with the current user-level version.
- Preserve the concise `Tools` section.

### 6. Release and CI posture is not as strong as the codebase

The package has strict TypeScript and a broad test suite, but no lint script, no repository-local CI workflow, and no audit gate. The suite already surfaces a duplicate `case` warning that a lint/static-analysis pass should catch before test output.

Recommended fix:
- Add a lint/static-analysis gate after dependency cleanup.
- Add CI that runs typecheck, tests, build, audit, and `npm pack --dry-run`.
- Consider a small package-content assertion so the broad asset copy step cannot accidentally publish unrelated Markdown/JSON under `src/`.

### 7. Postbuild asset copying is broader than needed

`scripts/copy-vendored-assets.mjs` copies every `.md`, `.txt`, and `.json` under `src/` except a few fixture-like names. This works now, but it grows the chance of publishing unrelated runtime assets.

Recommended fix:
- Replace extension-based copying with explicit include globs for runtime prompt assets and any intentionally shipped JSON/TXT files.

### 8. File sandbox is good, but write-path hardening can improve

The sandbox realpaths existing paths and rejects paths outside the root. For nonexistent write targets it falls back to `path.resolve`, which is necessary but leaves a classic time-of-check/time-of-use window around symlink or parent-directory replacement.

Recommended fix:
- For write tools, realpath and validate the nearest existing parent directory.
- Use exclusive/atomic write patterns where possible.
- Add regression tests for symlinked parent directories and allowPath symlink behavior.

## Suggested Execution Order

1. Fix dependency audit and release gates.
2. Fix web config snapshot handling.
3. Sync `AGENTS.md`, `project-design.md`, and `project-functions.md`.
4. Extract shared runtime assembly.
5. Add lint/CI/package-content checks.
6. Narrow asset copying.
7. Harden write-path sandbox edge cases.

## Overall Assessment

The project is structurally strong and test-heavy. The next gains are mostly not feature work: they are drift control, release hardening, centralizing repeated runtime setup, and closing configuration/security edge cases.
