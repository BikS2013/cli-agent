---
status: complete
design_number: 012
slug: file-ops-to-agt
request_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/refined-request-file-ops-to-agt.md
plan_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/plan-012-file-ops-to-agt.md
investigation_file: null
research_files: []
codebase_scan_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/codebase-scan-file-ops-to-agt.md
based_on_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
units_changed_from_plan: false
implementation_units:
  - name: U1 — Wrappers + barrel
    plan_steps: [1, 2, 3, 4, 5, 6]
    files:
      - src/agent/tools/agent-tools/agt-file-read.ts
      - src/agent/tools/agent-tools/agt-file-list.ts
      - src/agent/tools/agent-tools/agt-file-write.ts
      - src/agent/tools/agent-tools/agt-file-edit.ts
      - src/agent/tools/agent-tools/agt-file-append.ts
      - src/agent/tools/agent-tools/index.ts
    exposes:
      - AGT_FILE_READ_NAME
      - AGT_FILE_LIST_NAME
      - AGT_FILE_WRITE_NAME
      - AGT_FILE_EDIT_NAME
      - AGT_FILE_APPEND_NAME
      - AGT_FILE_READ_DESCRIPTION
      - AGT_FILE_LIST_DESCRIPTION
      - AGT_FILE_WRITE_DESCRIPTION
      - AGT_FILE_EDIT_DESCRIPTION
      - AGT_FILE_APPEND_DESCRIPTION
      - buildAgtFileReadTool
      - buildAgtFileListTool
      - buildAgtFileWriteTool
      - buildAgtFileEditTool
      - buildAgtFileAppendTool
      - AgtFileReadDeps
      - AgtFileListDeps
      - AgtFileWriteDeps
      - AgtFileEditDeps
      - AgtFileAppendDeps
    consumes:
      - BUILTIN_TOOL_PROMPTS
      - resolveSandboxPath
      - assertMaxBytes
  - name: U2 — Prompt registry
    plan_steps: [7]
    files:
      - src/agent/tools/tool-prompts-builtin.ts
    exposes:
      - BUILTIN_TOOL_PROMPTS
    consumes: []
  - name: U3 — Group-builder registration
    plan_steps: [8]
    files:
      - src/agent/tools/agent-tools/group-builder.ts
    exposes:
      - buildAgentToolsGroup
    consumes:
      - AGT_FILE_READ_NAME
      - AGT_FILE_LIST_NAME
      - AGT_FILE_WRITE_NAME
      - AGT_FILE_EDIT_NAME
      - AGT_FILE_APPEND_NAME
      - AGT_FILE_READ_DESCRIPTION
      - AGT_FILE_LIST_DESCRIPTION
      - AGT_FILE_WRITE_DESCRIPTION
      - AGT_FILE_EDIT_DESCRIPTION
      - AGT_FILE_APPEND_DESCRIPTION
      - buildAgtFileReadTool
      - buildAgtFileListTool
      - buildAgtFileWriteTool
      - buildAgtFileEditTool
      - buildAgtFileAppendTool
      - AgentConfig.agentTools.tools.fileRead
      - AgentConfig.agentTools.tools.fileList
      - AgentConfig.agentTools.tools.fileWrite
      - AgentConfig.agentTools.tools.fileEdit
      - AgentConfig.agentTools.tools.fileAppend
  - name: U4 — Registry built-in shrink + factory deletion
    plan_steps: [9, 10]
    files:
      - src/agent/tools/registry.ts
      - src/agent/tools/file/read-tool.ts
      - src/agent/tools/file/list-tool.ts
      - src/agent/tools/file/write-tool.ts
      - src/agent/tools/file/edit-tool.ts
      - src/agent/tools/file/append-tool.ts
    exposes:
      - buildToolCatalog
    consumes:
      - buildAgentToolsGroup
  - name: U5 — System-prompt built-in block
    plan_steps: [11]
    files:
      - src/agent/system-prompt.ts
    exposes:
      - BuiltinToolsPresence
      - buildBuiltinToolsPromptBlock
      - buildSystemPromptForCfg
    consumes: []
  - name: U6 — Config + env keys
    plan_steps: [12]
    files:
      - src/config/agent-config.ts
    exposes:
      - AgentConfig.agentTools.tools.fileRead
      - AgentConfig.agentTools.tools.fileList
      - AgentConfig.agentTools.tools.fileWrite
      - AgentConfig.agentTools.tools.fileEdit
      - AgentConfig.agentTools.tools.fileAppend
      - AgentCliFlags.agentTools.tools.fileRead
      - AgentCliFlags.agentTools.tools.fileList
      - AgentCliFlags.agentTools.tools.fileWrite
      - AgentCliFlags.agentTools.tools.fileEdit
      - AgentCliFlags.agentTools.tools.fileAppend
    consumes: []
  - name: U7 — CLI flags + mapper
    plan_steps: [13, 14]
    files:
      - src/cli.ts
      - src/cli-agent-tools-flags.ts
    exposes:
      - mapAgentToolFlags
    consumes:
      - AgentCliFlags.agentTools.tools.fileRead
      - AgentCliFlags.agentTools.tools.fileList
      - AgentCliFlags.agentTools.tools.fileWrite
      - AgentCliFlags.agentTools.tools.fileEdit
      - AgentCliFlags.agentTools.tools.fileAppend
  - name: U8 — Tests
    plan_steps: [15, 16, 17, 18, 19, 20]
    files:
      - src/agent/tools/agent-tools/agt-file-read.spec.ts
      - src/agent/tools/agent-tools/agt-file-list.spec.ts
      - src/agent/tools/agent-tools/agt-file-write.spec.ts
      - src/agent/tools/agent-tools/agt-file-edit.spec.ts
      - src/agent/tools/agent-tools/agt-file-append.spec.ts
      - src/agent/tools/tool-prompts-builtin.spec.ts
      - src/agent/tools/registry.spec.ts
      - src/agent/tools/agent-tools/group-builder.spec.ts
      - src/config/agent-config.spec.ts
      - src/agent/system-prompt.spec.ts
      - src/agent/tools/integration-profile-overlay-coexistence.spec.ts
    exposes: []
    consumes:
      - buildAgtFileReadTool
      - buildAgtFileListTool
      - buildAgtFileWriteTool
      - buildAgtFileEditTool
      - buildAgtFileAppendTool
      - buildToolCatalog
      - buildAgentToolsGroup
      - BUILTIN_TOOL_PROMPTS
      - mapAgentToolFlags
  - name: U9 — Docs + help baseline + full verify
    plan_steps: [21, 22]
    files:
      - docs/tools/cli-agent.md
      - docs/design/configuration-guide.md
      - docs/design/project-functions.md
      - docs/design/project-design.md
      - test_scripts/baselines/help-no-treat-as-tool.txt
      - test_scripts/baselines/help-no-treat-as-tool.sha256
    exposes: []
    consumes: []
files_to_create:
  - src/agent/tools/agent-tools/agt-file-read.ts
  - src/agent/tools/agent-tools/agt-file-list.ts
  - src/agent/tools/agent-tools/agt-file-write.ts
  - src/agent/tools/agent-tools/agt-file-edit.ts
  - src/agent/tools/agent-tools/agt-file-append.ts
  - src/agent/tools/agent-tools/agt-file-read.spec.ts
  - src/agent/tools/agent-tools/agt-file-list.spec.ts
  - src/agent/tools/agent-tools/agt-file-write.spec.ts
  - src/agent/tools/agent-tools/agt-file-edit.spec.ts
  - src/agent/tools/agent-tools/agt-file-append.spec.ts
files_to_modify:
  - src/agent/tools/agent-tools/index.ts
  - src/agent/tools/agent-tools/group-builder.ts
  - src/agent/tools/agent-tools/group-builder.spec.ts
  - src/agent/tools/tool-prompts-builtin.ts
  - src/agent/tools/tool-prompts-builtin.spec.ts
  - src/agent/tools/registry.ts
  - src/agent/tools/registry.spec.ts
  - src/agent/tools/integration-profile-overlay-coexistence.spec.ts
  - src/agent/system-prompt.ts
  - src/agent/system-prompt.spec.ts
  - src/config/agent-config.ts
  - src/config/agent-config.spec.ts
  - src/cli-agent-tools-flags.ts
  - src/cli.ts
  - test_scripts/baselines/help-no-treat-as-tool.txt
  - test_scripts/baselines/help-no-treat-as-tool.sha256
  - docs/tools/cli-agent.md
  - docs/design/configuration-guide.md
  - docs/design/project-functions.md
  - docs/design/project-design.md
files_to_delete:
  - src/agent/tools/file/read-tool.ts
  - src/agent/tools/file/list-tool.ts
  - src/agent/tools/file/write-tool.ts
  - src/agent/tools/file/edit-tool.ts
  - src/agent/tools/file/append-tool.ts
decisions: 7
created_at: 2026-06-15T00:00:00Z
---

# Design 012 — Move native file operations into the agent-tools (`agt_`) pack

## Objective
Re-home the five native file tools (`file_read`, `file_list`, `file_write`, `file_edit`, `file_append`) out of the built-in cross-cutting toolkit into the `agt_` pack as first-party wrappers `agt_file_read` / `agt_file_list` / `agt_file_write` / `agt_file_edit` / `agt_file_append`, reusing the existing file logic and the sandbox at `src/agent/tools/file/sandbox.ts`. This is the architecture + contract layer for plan-012 (`docs/design/plan-012-file-ops-to-agt.md`, 22 steps, units U1–U9) and the refined request (`docs/reference/refined-request-file-ops-to-agt.md`, R1–R14 / AC1–AC12). It mirrors the plan-011 web-tools move (`docs/design/plan-011-web-into-agent-tools.md`) exactly. The plan owns the step sequence; this design owns the end-state catalog shape and the between-unit interface surfaces.

## Architecture

### End-state catalog: two independent groups

After this change `buildToolCatalog` (`src/agent/tools/registry.ts`) assembles two independent tool groups (composites and profile scoping unchanged):

```
buildToolCatalog(cfg, logger)
│
├─ BUILT-IN TOOLKIT  (gated by cfg.builtinTools !== false)        ── registry.ts
│   ├─ readOnly = [ bash_list_allowed, bash_which, tool_help ]    (always when enabled)
│   └─ bashRunTools = [ bash_run ]                                (only if allowlist non-empty)
│        # NO file_* tools here anymore; mutatingFile array DELETED
│
└─ AGENT-TOOLS PACK  (gated by cfg.agentTools.enabled)            ── group-builder.ts
    registration order (stable; mirror in specs + docs):
      glob, grep,
      agt_web_search, agt_web_fetch,                              (read-only, plan-011)
      agt_file_read, agt_file_list,                               (read-only, NEW)
      agt_multiedit, agt_patch,                                   (mutation-gated)
      agt_file_write, agt_file_edit, agt_file_append,             (mutation-gated, NEW)
      agt_todo_read, agt_todo_write
```

Net membership: built-in toolkit = `{ bash_run (allowlist-gated), bash_list_allowed, bash_which, tool_help }`; `agt_` pack = `{ agt_glob, agt_grep, agt_web_search, agt_web_fetch, agt_file_read, agt_file_list, agt_multiedit, agt_patch, agt_file_write, agt_file_edit, agt_file_append, agt_todo_read, agt_todo_write }`.

### Registration order and the meta↔tool lockstep invariant

`buildAgentToolsGroup` (`group-builder.ts:121-218`) builds two parallel arrays in a single pass — `tools: DynamicStructuredTool[]` and `registered: AgentToolsCatalogEntry[]`. The contract is **positional lockstep**: every `if (flags.X) { tools.push(...); registered.push({ name, description }); }` block pushes to BOTH arrays so `tools[i] ↔ meta.registered[i]` holds for the whole `agt_` subset. The five new blocks MUST preserve this — one `tools.push` paired with one `registered.push` each. The agent-tools prompt block (`buildAgentToolsPromptBlock`) is a pure projection of `registered`, so adding the five `registered` entries documents the new file tools automatically; no prompt-block code changes.

The exact insertion points (within the existing order) are: the two read-only file blocks go directly after the `webFetch` block and before the `multiedit` block; the three mutator blocks go directly after the `patch` block and before the `todoRead` block. This keeps read-only tools grouped ahead of mutation-gated tools, matching the existing layout.

Downstream, `buildToolCatalog` re-derives `agentToolsMeta.registered` after profile scoping by filtering the pre-scoping meta against the surviving tool names (`registry.ts:158-168`) — this is unchanged and already handles the new names because they flow through the same `registered` array. This is why R11/AC6 (profile `tools.deny: [agt_file_write]`) works with no special-casing.

### Landing location and conventions adopted

The five new wrappers land in `src/agent/tools/agent-tools/` — the same directory as the plan-011 web wrappers (codebase-scan §"New Integration Points": "no genuinely new integration points… landing location is `src/agent/tools/agent-tools/`"). They adopt the conventions the scan documented:
- ESM `.js` import extensions on all relative imports; named exports only (scan §3, `agt-web-search.ts:22-34`).
- DI via a typed `deps` bag (scan §3).
- `AGT_*_DESCRIPTION` aliases `BUILTIN_TOOL_PROMPTS[name]!.description` — one literal per tool (scan §3).
- `func` calls `mergeProfileToolArgs` first, wraps in `try/catch`, returns `handleToolError(err)` on failure, never throws from `func` (scan §3, tool factory pattern).
- Mutation gating separated from the per-tool flag: `resolveAgentTools` records intent, `group-builder.ts` enforces `&& cfg.allowMutations` (scan §3, config pattern).

## Data Models
None. No database, no persisted schema. The only structured shapes are the config flag matrix (TypeScript interfaces, see Contracts) and the JSON tool-result payloads emitted by `func` (unchanged — preserved verbatim from the existing factories).

## API & Interface Contracts

These are the surfaces between the nine units. Each is defined ONCE here; units reference these definitions rather than restating them.

### C1 — The five wrapper modules (U1 exposes; consumed by U3 via barrel, U8)

Each `src/agent/tools/agent-tools/agt-file-<x>.ts` exports exactly four symbols, mirroring `agt-web-search.ts`:

```ts
// agt-file-read.ts
export const AGT_FILE_READ_NAME = 'agt_file_read' as const;
export const AGT_FILE_READ_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_FILE_READ_NAME]!.description;
export interface AgtFileReadDeps { cfg: AgentConfig; overlays?: OverlayRegistry; }
export function buildAgtFileReadTool(deps: AgtFileReadDeps): DynamicStructuredTool;
```

The analogous quadruple for each of the other four (literal name values fixed):

| Module | NAME constant value | DESCRIPTION constant | Deps type | Factory |
|---|---|---|---|---|
| `agt-file-read.ts` | `AGT_FILE_READ_NAME = 'agt_file_read'` | `AGT_FILE_READ_DESCRIPTION` | `AgtFileReadDeps` | `buildAgtFileReadTool(deps): DynamicStructuredTool` |
| `agt-file-list.ts` | `AGT_FILE_LIST_NAME = 'agt_file_list'` | `AGT_FILE_LIST_DESCRIPTION` | `AgtFileListDeps` | `buildAgtFileListTool(deps): DynamicStructuredTool` |
| `agt-file-write.ts` | `AGT_FILE_WRITE_NAME = 'agt_file_write'` | `AGT_FILE_WRITE_DESCRIPTION` | `AgtFileWriteDeps` | `buildAgtFileWriteTool(deps): DynamicStructuredTool` |
| `agt-file-edit.ts` | `AGT_FILE_EDIT_NAME = 'agt_file_edit'` | `AGT_FILE_EDIT_DESCRIPTION` | `AgtFileEditDeps` | `buildAgtFileEditTool(deps): DynamicStructuredTool` |
| `agt-file-append.ts` | `AGT_FILE_APPEND_NAME = 'agt_file_append'` | `AGT_FILE_APPEND_DESCRIPTION` | `AgtFileAppendDeps` | `buildAgtFileAppendTool(deps): DynamicStructuredTool` |

**Deps object shape (all five identical):**

```ts
interface AgtFile<X>Deps {
  cfg: AgentConfig;          // carries fileEdit.root, fileEdit.allowPaths, perToolBudgetBytes, toolPromptOverlays
  overlays?: OverlayRegistry; // optional; falls back to cfg.toolPromptOverlays inside the factory
}
```

This deliberately drops the `requestBudget` field present in `AgtWebSearchDeps` — file tools have no per-session budget counter (the sandbox enforces per-call byte limits via `assertMaxBytes`; codebase-scan §"group-builder.ts": "No new per-session budget object needed"). Inside each factory: `const reg = deps.overlays ?? deps.cfg.toolPromptOverlays;` and the sandbox config is `{ root: deps.cfg.fileEdit.root, allowPaths: [...deps.cfg.fileEdit.allowPaths], maxBytes: deps.cfg.perToolBudgetBytes }` (verbatim from the current `createFileReadTool` body at `read-tool.ts:16-20`).

**Factory body = the current `create<X>Tool` body verbatim, with exactly these deltas:** (1) `TOOL_NAME` constant → `AGT_FILE_<X>_NAME`; (2) `BUILTIN_TOOL_PROMPTS` key → `agt_file_<x>`; (3) sandbox/overlay config read from `deps` instead of the `cfg` parameter. Everything else is preserved byte-for-byte: the zod schema, every `getParamDescription` call, `getToolDescription`, `mergeProfileToolArgs`, the `try/catch` + `handleToolError`, and the tool-specific logic (read: binary/base64 + `max_bytes` default `1024*1024` + ENOENT→`E_FILE_NOT_FOUND` / EACCES→`E_FILE_PERMISSION`; write/append: `confirmed` gate + `requires_confirmation` early return; edit: `use_regex` / escaped-literal branches + `occurrence` first/all + `E_FILE_EDIT_NO_MATCH` + replacement-count return).

All twenty symbols (5×{NAME, DESCRIPTION, Deps type, factory}) are re-exported from the barrel `src/agent/tools/agent-tools/index.ts`, mirroring the web blocks. The five `AgtFile<X>Deps` types are re-exported with `export type`.

### C2 — `BUILTIN_TOOL_PROMPTS` registry keys (U2 exposes; consumed by U1, U3, U8)

`BUILTIN_TOOL_PROMPTS` (`src/agent/tools/tool-prompts-builtin.ts`) is the single source of truth for tool descriptions and per-parameter help, keyed by LangChain tool name. After U2:
- **Removed keys:** `file_read`, `file_list`, `file_write`, `file_edit`, `file_append`.
- **Added keys:** `agt_file_read`, `agt_file_list`, `agt_file_write`, `agt_file_edit`, `agt_file_append`. Each new entry's `description` and every `parameters[...]` string is copied **verbatim** from the removed same-suffix entry, including the `[MUTATING] … Requires confirmed: true` wording on the three mutators.
- **Total entry count stays 17.** `BUILTIN_TOOL_NAMES = Object.keys(BUILTIN_TOOL_PROMPTS)` follows automatically — no manual edit.

Contract dependency direction: U1's `AGT_FILE_<X>_DESCRIPTION` aliases `BUILTIN_TOOL_PROMPTS[AGT_FILE_<X>_NAME]!.description`, so the entries (U2) MUST exist for U1's build to type-check. U2 has no source dependency on U1 and can land first.

### C3 — Config flag matrix (U6 exposes; consumed by U3 typecheck, U7, U8)

Five new boolean keys are added to the `agentTools.tools` sub-object in all three config shapes in `src/config/agent-config.ts`, alongside the existing `webSearch`/`webFetch` keys:

```ts
// AgentConfig.agentTools.tools  (resolved view — required booleans; agent-config.ts:235-245)
readonly fileRead: boolean;
readonly fileList: boolean;
readonly fileWrite: boolean;
readonly fileEdit: boolean;
readonly fileAppend: boolean;

// AgentConfigFile.agentTools.tools  (config.json shape — optional)  agent-config.ts:118-127
// AgentCliFlags.agentTools.tools   (CLI shape — optional)          agent-config.ts:339-348
fileRead?: boolean; fileList?: boolean; fileWrite?: boolean; fileEdit?: boolean; fileAppend?: boolean;
```

Resolution wiring (`resolveAgentTools`, `agent-config.ts:1325-1361`):
- The `resolveOne` `envKey` union (`agent-config.ts:1332-1339`) gains the five literals `'CLI_AGENT_AGT_FILE_READ' | 'CLI_AGENT_AGT_FILE_LIST' | 'CLI_AGENT_AGT_FILE_WRITE' | 'CLI_AGENT_AGT_FILE_EDIT' | 'CLI_AGENT_AGT_FILE_APPEND'`.
- The `tools` object (`agent-config.ts:1351-1361`) gains five calls, each defaulting `true`:
  ```ts
  fileRead:   resolveOne(flagTools?.fileRead,   'CLI_AGENT_AGT_FILE_READ',   cfgTools?.fileRead,   true),
  fileList:   resolveOne(flagTools?.fileList,   'CLI_AGENT_AGT_FILE_LIST',   cfgTools?.fileList,   true),
  fileWrite:  resolveOne(flagTools?.fileWrite,  'CLI_AGENT_AGT_FILE_WRITE',  cfgTools?.fileWrite,  true),
  fileEdit:   resolveOne(flagTools?.fileEdit,   'CLI_AGENT_AGT_FILE_EDIT',   cfgTools?.fileEdit,   true),
  fileAppend: resolveOne(flagTools?.fileAppend, 'CLI_AGENT_AGT_FILE_APPEND', cfgTools?.fileAppend, true),
  ```
- The five `CLI_AGENT_AGT_FILE_*` literals are added to the agt env-key list / `ALL_ENV_KEYS` membership immediately after `CLI_AGENT_AGT_WEB_FETCH` (`agent-config.ts:827-835`) so the env tier participates in precedence (OQ-3). Omitting a key here silently drops its env tier — a correctness bug not caught by typecheck.

The four-tier precedence is unchanged: CLI flag > env var > config.json > default. `true` is the documented "default" tier in this chain, NOT a fallback substitute for a missing required value (no-fallback config rule honored, consistent with every existing agt key).

### C4 — CLI flag mapper (U7 exposes; consumed by U8)

`mapAgentToolFlags` (`src/cli-agent-tools-flags.ts`):
- `ToolKey` union (`:70`) gains `'fileRead' | 'fileList' | 'fileWrite' | 'fileEdit' | 'fileAppend'`.
- The `pairs` table (`:78-86`) gains five rows (Commander camelCases `--enable-agt-file-read` → `enableAgtFileRead`):
  ```ts
  { key: 'fileRead',   enableOpt: 'enableAgtFileRead',   disableOpt: 'disableAgtFileRead',   enableFlag: '--enable-agt-file-read',   disableFlag: '--disable-agt-file-read' },
  { key: 'fileList',   enableOpt: 'enableAgtFileList',   disableOpt: 'disableAgtFileList',   enableFlag: '--enable-agt-file-list',   disableFlag: '--disable-agt-file-list' },
  { key: 'fileWrite',  enableOpt: 'enableAgtFileWrite',  disableOpt: 'disableAgtFileWrite',  enableFlag: '--enable-agt-file-write',  disableFlag: '--disable-agt-file-write' },
  { key: 'fileEdit',   enableOpt: 'enableAgtFileEdit',   disableOpt: 'disableAgtFileEdit',   enableFlag: '--enable-agt-file-edit',   disableFlag: '--disable-agt-file-edit' },
  { key: 'fileAppend', enableOpt: 'enableAgtFileAppend', disableOpt: 'disableAgtFileAppend', enableFlag: '--enable-agt-file-append', disableFlag: '--disable-agt-file-append' },
  ```

The existing per-pair conflict loop and the umbrella conflict then handle the five new keys with no further change: enable+disable for the same tool, or any tool flag combined with `--no-agent-tools`, surfaces as `UsageError` (exit code 2). `mapAgentToolFlags` output feeds `AgentCliFlags['agentTools'].tools` (the C3 shape) — the union key names MUST match the C3 config keys exactly.

`src/cli.ts` registers the ten `.option(...)` rows after `--disable-agt-web-fetch` (`cli.ts:133`), in the order read/list/write/edit/append, with help text `"Enable agt_file_read (default-on; read-only)"` etc. for read/list and `"(default-on; mutation-gated)"` on the three mutators. The `--builtin-tools` / `--no-builtin-tools` help strings (`cli.ts:112-113`) and the `registry.ts:51-59` comment block are updated to state the built-in toolkit is now `bash_run` + `bash_list_allowed` + `bash_which` + `tool_help`, and that file tools are governed by `--agent-tools` / `--disable-agt-file-*`.

### C5 — System-prompt presence contract (U5 exposes)

`BuiltinToolsPresence` (`src/agent/system-prompt.ts:143-150`) DROPS the `mutatingFile` field:

```ts
// BEFORE
export interface BuiltinToolsPresence {
  readonly builtinTools: boolean;
  readonly bashRun: boolean;
  readonly mutatingFile: boolean;   // ← REMOVE (field + doc comment)
}
// AFTER
export interface BuiltinToolsPresence {
  readonly builtinTools: boolean;
  readonly bashRun: boolean;
}
```

`buildBuiltinToolsPromptBlock`'s parameter type becomes `{ builtinTools: boolean; bashRun: boolean }`; it loses the `file_read / file_list` available-tools bullet, the `if (p.mutatingFile)` mutating-file clause, and the `p.mutatingFile ? … : …` OUT-OF-SCOPE branch. `buildSystemPromptForCfg` drops the `mutatingFile:` property and its `names.has('file_write') || names.has('file_edit') || names.has('file_append')` derivation from the `builtinPresence` literal (the `§19` plan-011 entry and `§18` plan-010 entry in `project-design.md` document this derivation as the thing being removed). The only caller passing `mutatingFile` is `buildSystemPromptForCfg` in the same file, so U5 is self-contained. `LEGACY_DEFAULT_SYSTEM_PROMPTS` (`:52-100`) is FROZEN — not touched.

### C6 — Built-in catalog contract (U4 exposes)

`buildToolCatalog` (`src/agent/tools/registry.ts:46-173`):
- The five `createFile*Tool` imports (`:15-19`) are removed.
- `readOnly` becomes `[createBashListAllowedTool(cfg), createBashWhichTool(cfg), createToolHelpTool(cfg)]` (the two `createFile*Tool` calls removed).
- The entire `mutatingFile` array and its `...mutatingFile` spread in `assembled` are deleted.
- `sandbox.ts` is RETAINED (imported by U1's wrappers); the five `file/*-tool.ts` factories are DELETED.

Bash assembly, composites, profile scoping, and the lockstep re-derivation are untouched. The `agentToolsGroup.tools` spread already carries the five new tools (constructed by U3).

## Module Organization

| Action | Path | Notes |
|---|---|---|
| Create | `src/agent/tools/agent-tools/agt-file-read.ts` | C1; body from `file/read-tool.ts` |
| Create | `src/agent/tools/agent-tools/agt-file-list.ts` | C1; body from `file/list-tool.ts` |
| Create | `src/agent/tools/agent-tools/agt-file-write.ts` | C1; body from `file/write-tool.ts` |
| Create | `src/agent/tools/agent-tools/agt-file-edit.ts` | C1; body from `file/edit-tool.ts` |
| Create | `src/agent/tools/agent-tools/agt-file-append.ts` | C1; body from `file/append-tool.ts` |
| Modify | `src/agent/tools/agent-tools/index.ts` | re-export the five wrappers' symbols |
| Modify | `src/agent/tools/agent-tools/group-builder.ts` | five registration blocks (C-arch lockstep) |
| Modify | `src/agent/tools/tool-prompts-builtin.ts` | C2: swap five keys |
| Modify | `src/agent/tools/registry.ts` | C6: shrink built-in group |
| Delete | `src/agent/tools/file/{read,list,write,edit,append}-tool.ts` | re-homed into wrappers |
| Keep | `src/agent/tools/file/sandbox.ts`, `sandbox.spec.ts` | reused by wrappers; Out-of-Scope per scan |
| Modify | `src/agent/system-prompt.ts` | C5: drop `mutatingFile` |
| Modify | `src/config/agent-config.ts` | C3: flag matrix + env keys |
| Modify | `src/cli.ts`, `src/cli-agent-tools-flags.ts` | C4: flags + mapper |
| Create | five `agt-file-*.spec.ts`; Modify 6 existing specs | U8 |
| Modify | docs ×4, `--help` baseline ×2 | U9 |

## Gating / Defaults Matrix

| Tool | Per-tool flag (config key) | Default | Read-only vs mutation-gated | Env key | config.json key | CLI flags |
|---|---|---|---|---|---|---|
| `agt_file_read` | `fileRead` | `true` | read-only (no `allowMutations`) | `CLI_AGENT_AGT_FILE_READ` | `agentTools.tools.fileRead` | `--enable/--disable-agt-file-read` |
| `agt_file_list` | `fileList` | `true` | read-only (no `allowMutations`) | `CLI_AGENT_AGT_FILE_LIST` | `agentTools.tools.fileList` | `--enable/--disable-agt-file-list` |
| `agt_file_write` | `fileWrite` | `true` | mutation-gated (`&& cfg.allowMutations`) | `CLI_AGENT_AGT_FILE_WRITE` | `agentTools.tools.fileWrite` | `--enable/--disable-agt-file-write` |
| `agt_file_edit` | `fileEdit` | `true` | mutation-gated (`&& cfg.allowMutations`) | `CLI_AGENT_AGT_FILE_EDIT` | `agentTools.tools.fileEdit` | `--enable/--disable-agt-file-edit` |
| `agt_file_append` | `fileAppend` | `true` | mutation-gated (`&& cfg.allowMutations`) | `CLI_AGENT_AGT_FILE_APPEND` | `agentTools.tools.fileAppend` | `--enable/--disable-agt-file-append` |

**Net effective behavior (preserves today exactly, AC3/R12):** with all defaults and no `--allow-mutations`, only `agt_file_read` + `agt_file_list` load (read-only flags default-on, ungated). With `--allow-mutations`, the three mutators additionally appear (their flags default-on but require the runtime mutation gate). Defaults are the documented "default" tier of the four-tier chain, not silent fallbacks. The mutation gate lives in `group-builder.ts` (`if (flags.fileWrite && cfg.allowMutations)`), NOT in the wrapper — the wrapper still carries its own `confirmed`-param gate (per-call confirmation) verbatim, exactly as today.

## Error Handling Strategy

No behavior change. The wrappers preserve the existing two-layer scheme:
1. **Sandbox path confinement.** `resolveSandboxPath(input.path, sandboxCfg)` (from `file/sandbox.js`, retained) rejects paths outside `cfg.fileEdit.root` / `allowPaths` with `E_FILE_PATH_OUTSIDE_ROOT`; `assertMaxBytes` enforces the byte ceiling with `E_FILE_TOO_LARGE`.
2. **Typed-error + JSON contract.** `func` wraps logic in `try/catch`; on a typed `FileError` it returns `handleToolError(err)` → `{ "error": { "code", "message" } }`. The read tool's explicit ENOENT→`E_FILE_NOT_FOUND` / EACCES→`E_FILE_PERMISSION` remapping is preserved; the edit tool's `E_FILE_EDIT_NO_MATCH` throw is preserved; the mutators' `confirmed:false` → `requires_confirmation` early return is preserved. `func` never throws.

**Config-layer raise-on-missing.** The config layer (`agent-config.ts`) continues to raise `ConfigurationError` / `UsageError` (bubbling to Commander for a non-zero exit) rather than substituting defaults for genuinely-missing required configuration. The five new per-tool flags default to `true` as the documented final tier of the precedence chain — this is the established pattern for every `agt_*` flag and is NOT a fallback for a missing required setting. CLI flag conflicts (enable+disable, or a per-tool flag with `--no-agent-tools`) raise `UsageError` (exit 2) through the existing `mapAgentToolFlags` loop.

## Implementation Units

The plan's nine units (U1–U9) are adopted unchanged (`units_changed_from_plan: false`). File sets are pairwise disjoint; every plan step (1–22) maps to exactly one unit. Each unit's full file list and step mapping are in the frontmatter `implementation_units`; below is the contract each exposes/consumes.

### U1 — Wrappers + barrel  (steps 1–6)
- **Exposes (C1):** the five wrapper quadruples — `AGT_FILE_<X>_NAME` (literal values fixed in C1), `AGT_FILE_<X>_DESCRIPTION`, `AgtFile<X>Deps` (`{ cfg: AgentConfig; overlays?: OverlayRegistry }`), `buildAgtFile<X>Tool(deps): DynamicStructuredTool` — all re-exported from `agent-tools/index.ts`.
- **Consumes:** `BUILTIN_TOOL_PROMPTS` (C2, from U2 — required for the description aliases to type-check); `resolveSandboxPath` / `assertMaxBytes` from `file/sandbox.js` (retained by U4).
- **Build-order note:** U1's typecheck requires U2's prompt entries (the `!.description` alias). Land U2 first.

### U2 — Prompt registry  (step 7)
- **Exposes (C2):** `BUILTIN_TOOL_PROMPTS` with the five `agt_file_*` keys added and the five `file_*` keys removed; count 17.
- **Consumes:** nothing. Can land first.

### U3 — Group-builder registration  (step 8)
- **Exposes:** `buildAgentToolsGroup` registering the five wrappers into `tools` + `meta.registered` in positional lockstep (C-arch); read/list ungated, write/edit/append gated on `cfg.allowMutations`; insertion order per C-arch.
- **Consumes:** C1 (the five `buildAgtFile<X>Tool` + `AGT_FILE_<X>_NAME` + `AGT_FILE_<X>_DESCRIPTION` via barrel), C2 (descriptions), C3 (`cfg.agentTools.tools.file*` — required for typecheck). Land U6 before U3's typecheck verify.

### U4 — Registry built-in shrink + factory deletion  (steps 9–10)
- **Exposes (C6):** built-in `readOnly = [bash_list_allowed, bash_which, tool_help]`; `mutatingFile` removed; no `createFile*Tool` imports; `sandbox.ts` retained; the five `file/*-tool.ts` deleted.
- **Consumes:** `buildAgentToolsGroup` (the `agentToolsGroup.tools` spread now carries the file tools). Delete-after-shrink ordering: step 9 (remove imports/calls) before step 10 (delete files).

### U5 — System-prompt built-in block  (step 11)
- **Exposes (C5):** `BuiltinToolsPresence` without `mutatingFile`; `buildBuiltinToolsPromptBlock({ builtinTools, bashRun })`; `buildSystemPromptForCfg` without the `mutatingFile` derivation.
- **Consumes:** nothing cross-unit (the only `mutatingFile` caller is in-file). `LEGACY_DEFAULT_SYSTEM_PROMPTS` untouched.

### U6 — Config + env keys  (step 12)
- **Exposes (C3):** the five `file*` keys on all three `agentTools.tools` shapes; the five `CLI_AGENT_AGT_FILE_*` env keys in the env-key list + `resolveOne` union; all five default `true`.
- **Consumes:** nothing. Land early (U1 build, U3 typecheck, U7, U8 depend on it).

### U7 — CLI flags + mapper  (steps 13–14)
- **Exposes (C4):** ten `--enable/--disable-agt-file-*` options; `ToolKey` + `pairs` extended with the five keys (key names matching C3); updated `--builtin-tools`/`--no-builtin-tools` help strings.
- **Consumes:** C3 (the `AgentCliFlags['agentTools'].tools` shape `mapAgentToolFlags` writes into).

### U8 — Tests  (steps 15–20)
- **Consumes:** all of C1–C4 + `buildToolCatalog` (C6) + `BUILTIN_TOOL_PROMPTS` (C2). Covers AC1–AC8, AC10; relocates no specs (no `file/*-tool.spec.ts` exist today — these are the first unit-level file-tool specs). The "exactly 17 documented tools" list in `tool-prompts-builtin.spec.ts` swaps the five names. `integration-profile-overlay-coexistence.spec.ts` renames ~30 `file_*` occurrences to `agt_file_*` (synthetic fixtures renamed for honesty; real-catalog assertions re-sourced from the agt pack).
- **Exposes:** nothing.

### U9 — Docs + help baseline + full verify  (steps 21–22)
- **Consumes:** U1–U8 landed (the `--help` baseline and full suite require all source/test changes). Re-records `help-no-treat-as-tool.txt` + `.sha256` after a deliberate diff (10 new flag rows + 2 changed built-in help strings). Updates `docs/tools/cli-agent.md`, `configuration-guide.md`, `project-functions.md`, and the dated section in `project-design.md`.
- **Exposes:** nothing.

## Design Decisions

1. **Mirror plan-011 exactly; no new abstraction.** The web-tools move is the in-project precedent (`§19` of `project-design.md`); the file move reuses the same wrapper/registration/config/flag/prompt pattern. *Rationale:* lowest-risk, drift-free, the refined request fixes this approach (A1). *Rejected:* a shared `buildAgtFileTool(kind)` generic factory — would diverge from the per-tool web precedent, complicate the barrel/`BUILTIN_TOOL_PROMPTS` 1:1 mapping, and gold-plate beyond the plan.

2. **Deps shape `{ cfg, overlays? }` (drop `requestBudget`).** File tools have no per-session budget; the sandbox enforces per-call limits. *Rationale:* matches the actual dependency surface (codebase-scan §group-builder). *Rejected:* `{ sandboxCfg, overlays }` (OQ-1 alt) — would require the caller to pre-build the sandbox config, diverging from every other wrapper that takes `cfg`.

3. **Move + delete the old factories; keep `sandbox.ts`.** OQ-1 resolved in the plan: the only importer of the five factories is `registry.ts`; `permissions.ts:150-151` is a comment. *Rationale:* no dead code; single home for the file logic. *Rejected:* retain-and-delegate — leaves two layers and a dead export surface.

4. **Read/list default-on ungated; write/edit/append default-on but mutation-gated.** OQ-2 resolved. *Rationale:* reproduces today's effective behavior byte-for-byte (AC3/R12) and matches `agt_multiedit`/`agt_patch`. *Rejected:* mutators default-off — would change effective behavior (mutators would not appear even with `--allow-mutations`).

5. **Add `CLI_AGENT_AGT_FILE_*` env keys in all three places.** OQ-3 resolved: env-key list/`ALL_ENV_KEYS`, the `resolveOne` union, and the per-tool calls. *Rationale:* missing any one silently drops the env tier — a correctness bug typecheck won't catch. A precedence assertion per key proves the env tier participates.

6. **Remove the `mutatingFile` presence field rather than pin it `false`.** After the move no built-in mutating-file tools remain. *Rationale:* removing the field eliminates a permanently-dead code path and keeps `BuiltinToolsPresence` honest. *Rejected:* leaving it pinned `false` — a dead field that future readers must reason about.

7. **Adopt the plan's nine units verbatim.** File sets are already pairwise disjoint and every step maps cleanly. *Rationale:* the caller's directive forbids renumbering/re-scoping; no architectural reason to subdivide or merge. `units_changed_from_plan: false`.

## Decisions Requiring User Review

**Breaking change — tool RENAMES are user-visible (requires user awareness).** The five tools change their LangChain-visible names: `file_read` → `agt_file_read`, `file_list` → `agt_file_list`, `file_write` → `agt_file_write`, `file_edit` → `agt_file_edit`, `file_append` → `agt_file_append`. Any existing config profile that references the old names in `tools.allow` / `tools.deny` / `tools.order` / `toolArgs`, or any user overlay keyed on the old names, will silently stop matching after the upgrade and must be updated to the `agt_file_*` names. Additionally, `--no-builtin-tools` no longer removes file operations (it now leaves only `bash_run` + `bash_list_allowed` + `bash_which` + `tool_help`); file ops are governed by `--no-agent-tools` / `--disable-agt-file-*`. This is the intended, fixed scope of the request (settled decision 1), but the orchestrator should confirm the user accepts the breaking rename and the changed `--no-builtin-tools` semantics before implementation. The plan's docs step (U9) documents both in `docs/tools/cli-agent.md` and the configuration guide; no automatic profile migration is provided.

## Risks
- **U3 typecheck depends on U6** — `group-builder.ts` reads `flags.fileRead` etc., which exist only after C3 lands → sequence U6 before U3's typecheck verify.
- **U1 build depends on U2** — `AGT_FILE_<X>_DESCRIPTION` aliases `BUILTIN_TOOL_PROMPTS[name]!.description` → land U2 (C2) before U1's full typecheck.
- **Lockstep invariant** — a registration block pushing to `tools` but not `registered` (or vice versa) silently breaks the agent-tools prompt block → every new block pairs one `tools.push` with one `registered.push`; U8 asserts `tools.length === meta.registered.length` with the new tools present.
- **`--help` byte-stability baseline** — any incidental whitespace/order change beyond the 10 new rows + 2 changed built-in help strings fails `cli-help-baseline.spec.ts` → U9 diffs before overwriting.
- **`integration-profile-overlay-coexistence.spec.ts` name sweep (~30 occurrences)** — a blind find/replace could rename name-agnostic fixtures inconsistently or miss real-catalog assertions → U8 classifies each occurrence; final grep proves zero literal `file_*` tool names remain.
- **Breaking rename** — profiles/overlays referencing old `file_*` names stop matching (see Decisions Requiring User Review); no auto-migration.
- **Scan staleness: none.** `last_scanned_commit` (`c546d3891d273d3afdcf6271f6257cba3ce9022b`) equals current `HEAD`; the scan structure is current.
