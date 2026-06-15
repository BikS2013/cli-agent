---
language: typescript
framework: none
package_manager: npm
build_command: "tsc -p tsconfig.json && npm run postbuild:assets && npm run postbuild:chmod"
test_command: vitest run
lint_command: null
typecheck_command: "tsc --noEmit -p tsconfig.json"
entry_points:
  - src/cli.ts
last_scanned_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
scanned_for_request: file-ops-to-agt
scanned_at: "2026-06-15T00:00:00Z"
---

# Codebase Scan — cli-agent (file-ops-to-agt)

## 1. Project Overview

TypeScript/Node.js CLI binary (`@biks2013/cli-agent`) implementing a LangGraph ReAct agent that wraps external CLI binaries. The tool catalog is assembled at runtime from three independent groups: a built-in cross-cutting toolkit (`file_*` / `bash_*` / `tool_help`), an agent-tools pack (`agt_*` wrappers), and composite/virtual tools. The project uses `npm` with `tsc` for builds and `vitest` for testing. The current HEAD (`c546d38`) is the state immediately after plan-011 (web tools moved to agt pack); plan-012 (file-ops-to-agt) is the next in-flight change.

## 2. Module Map

| Path | Purpose | Representative symbols |
|---|---|---|
| `src/cli.ts` | Commander-based entry point; registers all CLI flags; dispatches the agent run | `program`, `--enable-agt-*` / `--disable-agt-*` option blocks (lines 118–133) |
| `src/cli-agent-tools-flags.ts` | Maps CLI flags into `AgentCliFlags['agentTools']`; conflict detection | `mapAgentToolFlags`, `ToolKey`, `pairs` table (lines 70–86) |
| `src/config/agent-config.ts` | Full config resolution; `AgentConfig`, `AgentConfigFile`, `AgentCliFlags` shapes; four-tier precedence chain | `AgentConfig`, `AgentConfigFile`, `AgentCliFlags`, `resolveAgentTools`, `resolveOne`, `ALL_ENV_KEYS` |
| `src/config/profile-*.ts` | Config profile loading, codec, schema | `loadProfile`, `ProfileSchema`, `ProfileTools` |
| `src/agent/system-prompt.ts` | Adaptive system-prompt assembly; built-in and agent-tools blocks | `buildBuiltinToolsPromptBlock`, `buildSystemPromptForCfg`, `LEGACY_DEFAULT_SYSTEM_PROMPTS` |
| `src/agent/tools/registry.ts` | Single point of catalog assembly; groups: `readOnly`, `mutatingFile`, `bashRunTools`, agent-tools pack, composites, profile scoping | `buildToolCatalog`, `ToolCatalog`, `AgentToolsCatalogMeta` |
| `src/agent/tools/tool-prompts-builtin.ts` | Canonical description/param registry for ALL tools (builtin + agt); registry-completeness invariant | `BUILTIN_TOOL_PROMPTS`, `BUILTIN_TOOL_NAMES`, `BuiltinToolPrompt` |
| `src/agent/tools/tool-prompt-overlay.ts` | User overlay resolution; `getToolDescription` / `getParamDescription` | `getToolDescription`, `getParamDescription`, `OverlayRegistry` |
| `src/agent/tools/file/` | Five native file tool factories + sandbox enforcement | `createFileReadTool`, `createFileListTool`, `createFileWriteTool`, `createFileEditTool`, `createFileAppendTool`, `resolveSandboxPath`, `assertMaxBytes` |
| `src/agent/tools/bash/` | `bash_run` / `bash_list_allowed` / `bash_which` + allowlist parsing | `createBashRunTool`, `parseAllowlistEntries` |
| `src/agent/tools/agent-tools/` | `agt_*` wrapper layer: glob, grep, multiedit, patch, todo-read/write, web-search/fetch (plan-011) | `buildAgentToolsGroup`, `buildAgtGlobTool` … `buildAgtWebFetchTool`, `index.ts` barrel |
| `src/agent/tools/agent-tools/group-builder.ts` | agt pack catalog assembly; per-tool + mutation gating; produces `AgentToolsGroup` + `AgentToolsCatalogMeta` | `buildAgentToolsGroup`, `AgentToolsCatalogMeta`, `AgentToolsGroup` |
| `src/agent/tools/agent-tools/index.ts` | Barrel: re-exports `AGT_*_NAME`, `AGT_*_DESCRIPTION`, `buildAgt*Tool`, `cliAgentPermissionPolicy` | all `AGT_*_NAME` constants, all `buildAgt*Tool` factories |
| `src/agent/tools/agent-tools-vendored/` | Upstream vendored agent-tools source (glob/grep/multiedit/patch/todo logic); do NOT modify | vendored upstream code |
| `src/agent/tools/web/` | Web backends (`backends/registry.ts`); formerly housed `search-tool.ts`/`fetch-tool.ts` (deleted by plan-011) | `getWebBackend`, `WebBackend` |
| `src/agent/graph.ts` | LangGraph ReAct agent construction; LLM I/O capture hooks (plan-007) | `buildAgent`, `compileAgent` |
| `src/agent/run.ts` | Top-level agent execution; wires tool catalog + system prompt into the graph | `runAgent` |
| `src/tui/` | Terminal UI: controller, slash commands, clipboard, transcript | `TuiController`, `/tools`, `/model`, `/resume` slash handlers |
| `src/agent/composite/` | Virtual/composite tool dispatch and registry (plan-006) | `loadVirtualToolsSync`, `dispatchComposite` |
| `src/agent/capabilities/` | CLI introspection and capability-doc assembly | `buildCapabilityDoc` |
| `src/errors.ts` | Typed error hierarchy | `FileError`, `WebError`, `ConfigurationError`, `UsageError` |
| `test_scripts/` | Manual smoke tests + `--help` byte-stability baseline | `baselines/help-no-treat-as-tool.txt`, `shim-e2e.ts` |
| `docs/design/` | Plans 001-011, project-design.md, configuration-guide.md, project-functions.md | plan-011 is the structural template for plan-012 |

## 3. Conventions

- **Import / module style** (`src/agent/tools/agent-tools/agt-web-search.ts:22-34`): ESM with `.js` extensions on all relative imports. Named exports only; no default exports. Dependency injection via a typed `deps` bag (`AgtWebSearchDeps`). The `AGT_*_DESCRIPTION` constant aliases `BUILTIN_TOOL_PROMPTS[name]!.description` — one literal, no duplication.

- **Tool factory pattern** (`src/agent/tools/file/read-tool.ts:15-66`): each `create*Tool(cfg)` or `buildAgt*Tool(deps)` constructs and returns a `DynamicStructuredTool`; schema is a `zod` object; description and param strings sourced from `BUILTIN_TOOL_PROMPTS` via `getToolDescription`/`getParamDescription` to honour user overlays. The `func` always calls `mergeProfileToolArgs` first, wraps logic in `try/catch`, returns `handleToolError(err)` on failure (never throws from `func`).

- **Error handling** (`src/agent/tools/file/edit-tool.ts:76-81`): typed `FileError`/`WebError`/`UsageError` from `src/errors.ts`; tool `func` catches and returns `handleToolError(err)` (JSON `{error: {code, message}}`). Config layer throws `ConfigurationError` or `UsageError` which bubble to Commander for non-zero exit.

- **Config pattern** (`src/config/agent-config.ts:1290-1366`): four-tier precedence (CLI flag > env var > config.json > default) enforced by `resolveOne(flagVal, envKey, cfgVal, defaultVal)`. No fallbacks for required config (raises exception). Per-tool defaults are documented starting values, not silent substitutes. Mutation gating is separated from the per-tool flag: `resolveAgentTools` records intent; `group-builder.ts` enforces the runtime gate (`&& cfg.allowMutations`).

- **Lockstep invariant** (`src/agent/tools/registry.ts:158-168`): after profile scoping, `agentToolsMeta.registered` is re-derived by filtering the pre-scoping meta against the post-scoping surviving tool names. This ensures `tools[i] ↔ meta.registered[i]` for the `agt_*` subset and prevents the system-prompt block from documenting tools that were scoped away.

- **`LEGACY_DEFAULT_SYSTEM_PROMPTS`** (`src/agent/system-prompt.ts:52-100`): frozen historical snapshot used ONLY by `bootstrapAgentDir` for upgrade detection. MUST NOT be edited under any circumstance.

## 4. Integration Points

### In-Scope

**`src/agent/tools/registry.ts` — `buildToolCatalog`** (`buildToolCatalog:62-83`)
- Lines 15-19: imports `createFileReadTool`, `createFileListTool`, `createFileWriteTool`, `createFileEditTool`, `createFileAppendTool` — all five imports must be removed.
- Lines 62-70: `readOnly` array includes `createFileReadTool(cfg)` and `createFileListTool(cfg)` — both must be removed (only `createBashListAllowedTool`, `createBashWhichTool`, `createToolHelpTool` remain in `readOnly`).
- Lines 72-78: entire `mutatingFile` array (`createFileWriteTool`, `createFileEditTool`, `createFileAppendTool`) must be removed.
- Lines 51-59: the comment block listing the toolkit contents must be updated to state `bash_run` + `bash_list_allowed` + `bash_which` + `tool_help` only.
- Action: **remove five imports, remove two factory calls from `readOnly`, delete `mutatingFile` array entirely, update comment block**.

**`src/agent/tools/file/read-tool.ts`** (factory to re-home; `createFileReadTool:15-66`)
- Exports `createFileReadTool(cfg: AgentConfig)` using `cfg.fileEdit.root`, `cfg.fileEdit.allowPaths`, `cfg.perToolBudgetBytes`, `cfg.toolPromptOverlays`.
- Deps shape for new wrapper: `{ cfg: AgentConfig; overlays?: OverlayRegistry }` (mirrors web wrappers' shape; `cfg` carries all sandbox config). Alternatively split to `{ sandboxCfg, overlays }` — planner decision (OQ-1).
- Action: **create `src/agent/tools/agent-tools/agt-file-read.ts`** — body is the current `createFileReadTool` body with name → `agt_file_read`, prompt key → `agt_file_read`, deps pattern from `AgtWebSearchDeps`.

**`src/agent/tools/file/list-tool.ts`** (factory to re-home; `createFileListTool:15-61`)
- Exports `createFileListTool(cfg: AgentConfig)`. Same sandbox config shape as `read-tool.ts`.
- Action: **create `agt-file-list.ts`** — analogous wrapper with name `agt_file_list`.

**`src/agent/tools/file/write-tool.ts`** (factory to re-home; `createFileWriteTool:14-59`)
- Exports `createFileWriteTool(cfg)`. Mutation gated: uses `confirmed` param.
- Action: **create `agt-file-write.ts`** — wrapper with name `agt_file_write`; `buildAgentToolsGroup` gates on `flags.fileWrite && cfg.allowMutations`.

**`src/agent/tools/file/edit-tool.ts`** (factory to re-home; `createFileEditTool:15-96`)
- Exports `createFileEditTool(cfg)`. Most complex file tool; mutation gated.
- Action: **create `agt-file-edit.ts`** — wrapper with name `agt_file_edit`; mutation-gated in `group-builder.ts`.

**`src/agent/tools/file/append-tool.ts`** (factory to re-home; `createFileAppendTool:14-59`)
- Exports `createFileAppendTool(cfg)`. Mutation gated.
- Action: **create `agt-file-append.ts`** — wrapper with name `agt_file_append`; mutation-gated.

**`src/agent/tools/file/sandbox.ts`** (KEEP; `SandboxConfig`, `resolveSandboxPath`, `assertMaxBytes`)
- Reused by all five new wrappers. Import path from `agt-file-*.ts` will be `'../file/sandbox.js'`. No modifications needed.
- Action: **keep unchanged**; update imports in new wrapper files to reference this module.

**`src/agent/tools/file/sandbox.spec.ts`** (KEEP)
- Tests `resolveSandboxPath`. Remains valid after the move since `sandbox.ts` is unchanged.
- Action: **keep unchanged**.

**`src/agent/tools/agent-tools/group-builder.ts`** (`buildAgentToolsGroup:122-219`)
- Line 135: `const flags = cfg.agentTools.tools` — must add `.fileRead`, `.fileList`, `.fileWrite`, `.fileEdit`, `.fileAppend` to the destructured flags shape.
- Lines 149-213: per-tool registration blocks — add five new blocks mirroring the web wrappers (lines 167-180). Read-only tools (`fileRead`, `fileList`): no `allowMutations` gate. Mutating tools (`fileWrite`, `fileEdit`, `fileAppend`): gate with `&& cfg.allowMutations` (matching `multiedit`/`patch` at lines 186-198).
- No new per-session budget object needed (file tools have no budget counter; the sandbox enforces limits per-call via `assertMaxBytes`).
- Action: **add five import entries, five registration blocks in correct order**.

**`src/agent/tools/agent-tools/index.ts`** (barrel; lines 1-99)
- Must export `AGT_FILE_READ_NAME`, `AGT_FILE_READ_DESCRIPTION`, `buildAgtFileReadTool`, `type AgtFileReadDeps` (and analogues for the other four) from each new `./agt-file-*.js` module.
- Pattern: add five export blocks at the bottom of the "Wrapper factories" section, exactly mirroring the `agt-web-search`/`agt-web-fetch` entries (lines 63-78).
- Action: **add five export blocks**.

**`src/agent/tools/agent-tools/agt-web-search.ts` and `agt-web-fetch.ts`** (template to copy)
- These two files are the EXACT structural template for the five new `agt-file-*.ts` files. The deps shape (`{ cfg, requestBudget, overlays }` — sans `requestBudget` for file tools), the `AGT_*_NAME`/`AGT_*_DESCRIPTION` export pattern, `BUILTIN_TOOL_PROMPTS[AGT_*_NAME]!.description` aliasing, `mergeProfileToolArgs`, `handleToolError`, `getToolDescription`/`getParamDescription` usage are all directly transplantable.
- Action: **copy structure; adapt name, deps, schema, and func body from the corresponding current `create*Tool` factory**.

**`src/agent/tools/tool-prompts-builtin.ts`** (`BUILTIN_TOOL_PROMPTS:46-275`)
- Lines 50-91: `file_read`, `file_list`, `file_write`, `file_edit`, `file_append` entries — must be REMOVED (keys and objects).
- Must ADD five new entries with keys `agt_file_read`, `agt_file_list`, `agt_file_write`, `agt_file_edit`, `agt_file_append` — descriptions and param texts copied verbatim from the removed entries (incl. `[MUTATING]` / `Requires confirmed: true` wording on mutators).
- `BUILTIN_TOOL_NAMES` at line 273 is `Object.keys(BUILTIN_TOOL_PROMPTS)` — no manual update needed; it follows automatically.
- `tool-prompts-builtin.spec.ts:104-116`: the "exactly 17 documented tools" assertion must be updated to list the new `agt_file_*` names and remove the old `file_*` names (total count stays 17 if we also remove the old 5 and add 5 new ones).
- Action: **remove 5 entries, add 5 new entries; update spec count assertion and tool-name list**.

**`src/agent/system-prompt.ts`** (`buildBuiltinToolsPromptBlock:224-286`, `buildSystemPromptForCfg:394-437`)

`buildBuiltinToolsPromptBlock` (lines 224-286):
- Lines 251-265: "Available tools" section hard-codes `file_read / file_list` bullet (line 252) and the `mutatingFile` extension `file_write / file_edit / file_append` (line 255). Both must be REMOVED.
- `BuiltinToolsPresence` interface (wherever defined — check lines ~195-230): the `mutatingFile` field drives the adaptive prose. After the move the built-in block has no mutating-file group — `mutatingFile` in the presence struct should become redundant; the field should be removed or permanently set to `false` so the block no longer emits the file-mutation clause.
- Lines 266-279: the OUT-OF-SCOPE block — remove the "cannot modify files in this session; the file-mutation tools are disabled" line (line 268-270) since file tools are no longer built-in.
- `LEGACY_DEFAULT_SYSTEM_PROMPTS` (lines 52-100): **DO NOT TOUCH** (frozen).

`buildSystemPromptForCfg` (lines 394-437):
- Lines 428-432: `builtinPresence.mutatingFile` is derived by `names.has('file_write') || names.has('file_edit') || names.has('file_append')`. After the move, these names will never appear in the built-in catalog — this check will always be `false`. The `mutatingFile` presence derivation and the corresponding `BuiltinToolsPresence.mutatingFile` field should be removed or collapsed.
- Action: **remove `file_read / file_list` bullet, remove `mutatingFile` clause in Available tools and OUT-OF-SCOPE, remove `mutatingFile` from `BuiltinToolsPresence` shape and its derivation**.

**`src/config/agent-config.ts`**

`AgentConfigFile.agentTools.tools` (lines 118-127): add `fileRead?`, `fileList?`, `fileWrite?`, `fileEdit?`, `fileAppend?` optional booleans.

`AgentConfig.agentTools.tools` (lines 235-245): add `fileRead`, `fileList`, `fileWrite`, `fileEdit`, `fileAppend` required booleans with comment "First-party file wrappers (plan-012)".

`AgentCliFlags.agentTools.tools` (lines 339-348): add `fileRead?`, `fileList?`, `fileWrite?`, `fileEdit?`, `fileAppend?` optional booleans.

`resolveAgentTools` / `resolveOne` (lines 1290-1366):
- `resolveOne` envKey union (lines 1332-1338): extend with `'CLI_AGENT_AGT_FILE_READ' | 'CLI_AGENT_AGT_FILE_LIST' | 'CLI_AGENT_AGT_FILE_WRITE' | 'CLI_AGENT_AGT_FILE_EDIT' | 'CLI_AGENT_AGT_FILE_APPEND'`.
- `tools` object build (lines 1352-1360): add five `resolveOne(flagTools?.fileRead, 'CLI_AGENT_AGT_FILE_READ', cfgTools?.fileRead, true)` calls. `fileRead` / `fileList`: default `true` (read-only, always-on like `webSearch`/`webFetch`). `fileWrite` / `fileEdit` / `fileAppend`: default `true` but mutation-gated downstream (matching `multiedit`/`patch` pattern).

Env-key list (lines 827-835 `AGT_*` block): add `'CLI_AGENT_AGT_FILE_READ'`, `'CLI_AGENT_AGT_FILE_LIST'`, `'CLI_AGENT_AGT_FILE_WRITE'`, `'CLI_AGENT_AGT_FILE_EDIT'`, `'CLI_AGENT_AGT_FILE_APPEND'` immediately after `CLI_AGENT_AGT_WEB_FETCH` (line 834), with a "First-party file wrappers (plan-012)" comment.

Action: **extend three interface shapes, extend `resolveOne` union, add five `resolveOne` calls, add five env keys to the env-key list**.

**`src/cli.ts`** (lines 118-133)
- Add ten new `.option(...)` calls after line 133 (`--disable-agt-web-fetch`):
  ```
  --enable-agt-file-read / --disable-agt-file-read
  --enable-agt-file-list / --disable-agt-file-list
  --enable-agt-file-write / --disable-agt-file-write (mutation-gated)
  --enable-agt-file-edit  / --disable-agt-file-edit  (mutation-gated)
  --enable-agt-file-append / --disable-agt-file-append (mutation-gated)
  ```
- Update `--builtin-tools` / `--no-builtin-tools` help strings (lines 112-113) to state that the built-in toolkit is `bash_run` + `bash_list_allowed` + `bash_which` + `tool_help` and that file tools are now governed by `--agent-tools` / `--disable-agt-file-*`.
- Action: **add 10 option calls, update 2 help strings**.

**`src/cli-agent-tools-flags.ts`** (`mapAgentToolFlags:45-120`)
- Line 70: `ToolKey` union must be extended with `'fileRead' | 'fileList' | 'fileWrite' | 'fileEdit' | 'fileAppend'`.
- Lines 78-86: `pairs` table must gain five new entries:
  - `{ key: 'fileRead',   enableOpt: 'enableAgtFileRead',   disableOpt: 'disableAgtFileRead',   enableFlag: '--enable-agt-file-read',   disableFlag: '--disable-agt-file-read' }`
  - (and analogous for `fileList`, `fileWrite`, `fileEdit`, `fileAppend`)
- Action: **extend `ToolKey` union, add 5 rows to `pairs` table**.

**`test_scripts/baselines/help-no-treat-as-tool.txt`** (9.2 KB)
- Must be regenerated deliberately (diff first) to include 10 new flag rows for `--enable/--disable-agt-file-*` and the updated `--builtin-tools`/`--no-builtin-tools` help text.
- The SHA-256 checksum file `help-no-treat-as-tool.sha256` must also be updated.
- Action: **re-record deliberately; update `.sha256`; `cli-help-baseline.spec.ts` becomes green**.

**Tests — in-scope files**

| File | What must change |
|---|---|
| `src/agent/tools/registry.spec.ts` | Remove `file_*` from built-in catalog assertions; assert `agt_file_*` present in agt pack; `makeCfg` fixture must add five new flag keys to `agentTools.tools` shape |
| `src/agent/tools/registry-toggles.spec.ts` | AC3/AC4/AC5: `--no-builtin-tools` must NOT remove file tools; `--no-agent-tools` must remove them; add assertions for mutation-gated agt file tools |
| `src/config/agent-config.spec.ts` | Add `fileRead`/`fileList`/`fileWrite`/`fileEdit`/`fileAppend` resolution tests; assert each of the 5 new `CLI_AGENT_AGT_FILE_*` env keys participates in four-tier precedence |
| `src/agent/tools/agent-tools/group-builder.spec.ts` | Extend `Flags` interface and `makeCfg` to include five new tool keys; add gating tests for read-only (no mutation gate) vs mutation-gated behavior |
| `src/agent/tools/tool-prompts-builtin.spec.ts` | Update "exactly 17 documented tools" list to `agt_file_*` (removing `file_*`; count stays 17); update `makeMaximalCfg` to pass the new flag keys |
| `src/agent/system-prompt.spec.ts` | Assert built-in block no longer mentions file tools; assert `agt_file_*` descriptions appear in agent-tools block when registered |
| New: `src/agent/tools/agent-tools/agt-file-read.spec.ts` | Port coverage from `file/` (sandbox enforcement, read path, binary mode, ENOENT/EACCES); test overlay description resolution |
| New: `src/agent/tools/agent-tools/agt-file-list.spec.ts` | Port sandbox + directory listing coverage |
| New: `src/agent/tools/agent-tools/agt-file-write.spec.ts` | Port sandbox + confirmed-gate + write coverage |
| New: `src/agent/tools/agent-tools/agt-file-edit.spec.ts` | Port sandbox + pattern-match + replacement + regex coverage; `E_FILE_EDIT_NO_MATCH` |
| New: `src/agent/tools/agent-tools/agt-file-append.spec.ts` | Port sandbox + confirmed-gate + append coverage |

Note: there are NO existing `file/read-tool.spec.ts`, `file/list-tool.spec.ts`, `file/write-tool.spec.ts`, `file/edit-tool.spec.ts`, or `file/append-tool.spec.ts` files. The file/ directory contains ONLY `sandbox.spec.ts`. The five factory functions currently have NO dedicated spec coverage beyond the integration-level `registry.spec.ts` assertions. The new `agt-file-*.spec.ts` files will be the FIRST unit-level coverage for the file tool logic.

**Docs — in-scope files**

| File | Required update |
|---|---|
| `docs/tools/cli-agent.md` | File tools now `agt_file_*` in the pack; new per-tool flags; `--no-builtin-tools` no longer affects file tools; `--no-agent-tools` / `--disable-agt-file-*` do |
| `docs/design/configuration-guide.md` | Five new env keys + config.json keys + four-tier precedence + defaults for each new key |
| `docs/design/project-functions.md` | Functional requirement entry for file-ops-to-agt |
| `docs/design/project-design.md` | Dated section (plan-012) recording the design decision and citing this scan and the refined-request file |

### Out-of-Scope

The following modules are implicated by the scan but must NOT be touched:

- `src/agent/tools/file/sandbox.ts` — reused unchanged by all five wrappers; no modification.
- `src/agent/tools/file/sandbox.spec.ts` — covers sandbox enforcement; remains valid after the re-homing.
- `src/agent/tools/bash/` (`run-tool.ts`, `list-allowed-tool.ts`, `which-tool.ts`, `allowlist.ts`) — bash tools stay in the built-in toolkit; no changes.
- `src/agent/tools/agent-tools-vendored/` — upstream vendored source; never modified.
- `src/agent/tools/web/` (`backends/` tree) — web backend shared by `agt_web_search`/`agt_web_fetch`; no changes. (The `search-tool.ts`/`fetch-tool.ts` wrappers were already deleted by plan-011.)
- `src/agent/tools/agent-tools/agt-glob.ts`, `agt-grep.ts`, `agt-multiedit.ts`, `agt-patch.ts`, `agt-todo-read.ts`, `agt-todo-write.ts`, `agt-web-search.ts`, `agt-web-fetch.ts` — existing wrappers are reference material only; no modifications.
- `src/agent/tools/agent-tools/prompt-block.ts`, `permissions.ts`, `token-budget.spec.ts`, `permissions.spec.ts` — agent-tools infrastructure; no changes.
- `src/agent/tools/profile-scoping.ts`, `profile-scoping.spec.ts`, `profile-tool-args.ts`, `profile-tool-args.spec.ts` — profile scoping path unchanged; new tool names flow through automatically (R11).
- `src/agent/tools/tool-prompt-overlay.ts`, `tool-prompt-overlay.spec.ts` — overlay infrastructure; unchanged.
- `src/agent/tools/tool-help-tool.ts` — `tool_help` stays in built-in toolkit; no changes.
- `src/agent/tools/types.ts`, `src/agent/tools/types.spec.ts` — shared types; unchanged.
- `src/agent/tools/integration-profile-overlay-coexistence.spec.ts` — integration spec for overlays + profiles; will pass without modification unless it explicitly asserts `file_*` names in the built-in catalog (inspect before finalising).
- `src/agent/composite/`, `src/agent/capabilities/`, `src/agent/graph.ts`, `src/agent/run.ts`, `src/agent/logging.ts`, `src/agent/providers/` — composite/graph/LLM layers; no changes.
- `src/agent/checkpoint-store.ts`, `src/tui/` — session persistence and TUI; no changes.
- `src/agent/io-capture.ts`, `src/agent/graph-io-capture.spec.ts`, `src/agent/io-capture.spec.ts` — LLM I/O inspector (plan-007); no changes.
- `src/config/profile-codec.ts`, `src/config/profile-loader.ts`, `src/config/profile-schema.ts` — profile infrastructure; no changes.
- `src/errors.ts` — `FileError` is still used by the five file factories; no changes to the error class itself.
- `src/commands/` — subcommand handlers; no changes.
- `src/util/` — shared utilities; no changes.
- `LEGACY_DEFAULT_SYSTEM_PROMPTS` in `src/agent/system-prompt.ts` — frozen; MUST NOT be edited.

### New Integration Points

No genuinely new integration points. This change mirrors plan-011 exactly. The five `agt-file-*.ts` files are new source files whose landing location is `src/agent/tools/agent-tools/` (same as the web wrappers created by plan-011). All conventions for naming, description aliasing, deps injection, and barrel re-export are established by the existing `agt-web-search.ts`/`agt-web-fetch.ts` files — copy those files' structure directly.

## 5. Notes

- **File tools have zero dedicated unit-spec coverage today.** The only spec in `src/agent/tools/file/` is `sandbox.spec.ts`. The five `create*Tool` factories are tested only indirectly through `registry.spec.ts` integration tests. The five new `agt-file-*.spec.ts` files will be the first targeted unit coverage. The plan should budget time for this spec authoring — it is non-trivial for `agt-file-edit.ts` (regex path, `E_FILE_EDIT_NO_MATCH`, ambiguous-match branch).

- **`tool-prompts-builtin.spec.ts` hardcodes the count as "exactly 17 documented tools"** (line 104). After removing 5 `file_*` entries and adding 5 `agt_file_*` entries the total stays 17. But the explicit name list at lines 107-113 must be updated (remove `file_read`/`file_list`/`file_write`/`file_edit`/`file_append`; add `agt_file_read`/`agt_file_list`/`agt_file_write`/`agt_file_edit`/`agt_file_append`). A coder who updates `BUILTIN_TOOL_PROMPTS` without updating the spec will see a failing test immediately — the invariant is strong.

- **`integration-profile-overlay-coexistence.spec.ts`** (17 KB, last modified 14 Jun) likely references `file_read`/`file_write` by name in overlay or scoping scenarios. This file is large and was recently modified; the coder must scan it for `file_read`/`file_list`/`file_write`/`file_edit`/`file_append` references and update them to the `agt_file_*` names before marking the spec suite green.

- **`buildBuiltinToolsPromptBlock` still has the `mutatingFile` field** in `BuiltinToolsPresence`. After this change that field is unused (no built-in mutating-file tools remain). The cleanest approach is to remove the field and all code paths that gate on it; otherwise a dead field persists in the type. The `system-prompt.spec.ts` assertions for the mutating-file clause must be updated accordingly.
