---
status: complete
plan_number: 012
slug: file-ops-to-agt
request_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/refined-request-file-ops-to-agt.md
investigation_file: null
research_files: []
codebase_scan_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/codebase-scan-file-ops-to-agt.md
based_on_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
scan_commit_match: true
steps: 22
open_questions: 0
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
implementation_units:
  - name: U1 — Wrappers + barrel
    steps: [1, 2, 3, 4, 5, 6]
    files:
      - src/agent/tools/agent-tools/agt-file-read.ts
      - src/agent/tools/agent-tools/agt-file-list.ts
      - src/agent/tools/agent-tools/agt-file-write.ts
      - src/agent/tools/agent-tools/agt-file-edit.ts
      - src/agent/tools/agent-tools/agt-file-append.ts
      - src/agent/tools/agent-tools/index.ts
  - name: U2 — Prompt registry
    steps: [7]
    files:
      - src/agent/tools/tool-prompts-builtin.ts
  - name: U3 — Group-builder registration
    steps: [8]
    files:
      - src/agent/tools/agent-tools/group-builder.ts
  - name: U4 — Registry built-in shrink + factory deletion
    steps: [9, 10]
    files:
      - src/agent/tools/registry.ts
      - src/agent/tools/file/read-tool.ts
      - src/agent/tools/file/list-tool.ts
      - src/agent/tools/file/write-tool.ts
      - src/agent/tools/file/edit-tool.ts
      - src/agent/tools/file/append-tool.ts
  - name: U5 — System-prompt built-in block
    steps: [11]
    files:
      - src/agent/system-prompt.ts
  - name: U6 — Config + env keys
    steps: [12]
    files:
      - src/config/agent-config.ts
  - name: U7 — CLI flags + mapper
    steps: [13, 14]
    files:
      - src/cli.ts
      - src/cli-agent-tools-flags.ts
  - name: U8 — Tests
    steps: [15, 16, 17, 18, 19, 20]
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
  - name: U9 — Docs + help baseline + full verify
    steps: [21, 22]
    files:
      - docs/tools/cli-agent.md
      - docs/design/configuration-guide.md
      - docs/design/project-functions.md
      - docs/design/project-design.md
      - test_scripts/baselines/help-no-treat-as-tool.txt
      - test_scripts/baselines/help-no-treat-as-tool.sha256
build_command: "tsc -p tsconfig.json && npm run postbuild:assets && npm run postbuild:chmod"
test_command: "vitest run"
created_at: 2026-06-15T00:00:00Z
---

# Plan 012 — Move native file operations into the agent-tools (`agt_`) pack

## Objective
Re-home the five native file tools (`file_read`, `file_list`, `file_write`, `file_edit`, `file_append`) out of the built-in cross-cutting toolkit and into the `agt_` pack as first-party wrappers `agt_file_read` / `agt_file_list` / `agt_file_write` / `agt_file_edit` / `agt_file_append`, reusing the existing file logic and the sandbox at `src/agent/tools/file/sandbox.ts`. After the change the built-in toolkit contains ONLY `bash_run`, `bash_list_allowed`, `bash_which`, and `tool_help`. This satisfies the 12 acceptance criteria in the refined request and mirrors the plan-011 web-tools move exactly.

## Context
- Refined request (authoritative scope, R1–R14, AC1–AC12, OQ-1/2/3): @docs/reference/refined-request-file-ops-to-agt.md
- Codebase scan (17 in-scope surfaces with file:line evidence, build/test/typecheck commands in frontmatter): @docs/reference/codebase-scan-file-ops-to-agt.md
- Structural precedent (the identical move for web tools — follow step-by-step): @docs/design/plan-011-web-into-agent-tools.md
- Reference wrappers to copy structure from: `src/agent/tools/agent-tools/agt-web-search.ts`, `src/agent/tools/agent-tools/agt-web-fetch.ts`

**Approach (fixed by the refined request and plan-011):** create five first-party `agt-file-*.ts` wrappers under `src/agent/tools/agent-tools/`, each transplanting the corresponding `create*Tool` body verbatim with `name`/prompt-key changed to `agt_file_<x>` and a `{ cfg, overlays }` deps bag (the web wrappers' shape, minus `requestBudget` — file tools have no per-session budget). Keep `sandbox.ts` (reused). Delete the five old `file/*-tool.ts` factories once re-homed (verified: only `registry.ts` imports them). Register the wrappers in `group-builder.ts` behind new per-tool flags (read-only ungated; mutators additionally gated on `cfg.allowMutations`). Shrink the built-in catalog in `registry.ts` to bash + `tool_help`. Remove the now-dead `mutatingFile` presence flag from `system-prompt.ts` and rewrite the built-in block to describe only bash + `tool_help`. Wire five new config flags and `CLI_AGENT_AGT_FILE_*` env keys, ten CLI flags, the flag mapper, tests, docs, and the `--help` baseline.

## Open Questions
The refined request carried three planner-decision open questions. All three are RESOLVED here (per the caller's directive) and treated as decided throughout the plan:

1. **OQ-1 (fate of the old factories) — RESOLVED: move + delete.** Move each `create*Tool` body into a new `src/agent/tools/agent-tools/agt-file-*.ts` wrapper (named-export pattern `AGT_FILE_*_NAME` / `AGT_FILE_*_DESCRIPTION` / `buildAgtFile*Tool` + deps type, mirroring `agt-web-search.ts`). KEEP `src/agent/tools/file/sandbox.ts`. DELETE `src/agent/tools/file/{read,list,write,edit,append}-tool.ts` after re-homing. Verified at plan time: the ONLY importer of these five factories is `src/agent/tools/registry.ts:15-19,64-76`; `permissions.ts:150-151` is a comment, not an import. There are NO dedicated `file/*-tool.spec.ts` files today (only `sandbox.spec.ts`), so the new `agt-file-*.spec.ts` files are the first unit coverage — nothing to relocate, everything to author.

2. **OQ-2 (per-tool flag defaults) — RESOLVED: read/list default-on; write/edit/append default-on but mutation-gated.** This preserves today's effective behavior exactly: with defaults and no `--allow-mutations`, only `agt_file_read` + `agt_file_list` load; with `--allow-mutations`, the three mutators additionally appear. Identical to plan-011's treatment of mutating agt tools and the former native `mutatingFile` gating.

3. **OQ-3 (env-key wiring) — RESOLVED: add the five `CLI_AGENT_AGT_FILE_*` keys in every place the `CLI_AGENT_AGT_WEB_*` keys appear.** Namely the agt env-key list (`agent-config.ts:827-835`), the `resolveOne` `envKey` union (`agent-config.ts:1332-1339`), and the per-tool `resolveOne(...)` calls (`agent-config.ts:1352-1361`); plus a precedence assertion in `agent-config.spec.ts` proving each new key participates in the four-tier chain.

## Steps

### Step 1 — Create `agt-file-read.ts` (read-only wrapper)
- **depends_on:** none (the prompt entry it aliases is added in Step 7; build verification for this unit runs after Step 7)
- **files:** `src/agent/tools/agent-tools/agt-file-read.ts` (create)
- **action:** Copy the structure of `src/agent/tools/agent-tools/agt-web-search.ts`. Export `AGT_FILE_READ_NAME = 'agt_file_read' as const`, `AGT_FILE_READ_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_FILE_READ_NAME]!.description`, an `AgtFileReadDeps` interface `{ cfg: AgentConfig; overlays?: OverlayRegistry }`, and `buildAgtFileReadTool(deps): DynamicStructuredTool`. The factory body is `createFileReadTool` from `src/agent/tools/file/read-tool.ts` verbatim, with: tool name → `AGT_FILE_READ_NAME`; prompt key → `agt_file_read`; `reg = deps.overlays ?? deps.cfg.toolPromptOverlays`; sandbox config built from `deps.cfg.fileEdit.root` / `deps.cfg.fileEdit.allowPaths` / `deps.cfg.perToolBudgetBytes`. Keep `resolveSandboxPath` / `assertMaxBytes` imports from `'../file/sandbox.js'`, `FileError` from `'../../../errors.js'`, `handleToolError` from `'../types.js'`, `mergeProfileToolArgs` from `'../profile-tool-args.js'`. Preserve the ENOENT→`E_FILE_NOT_FOUND` / EACCES→`E_FILE_PERMISSION` mapping. ESM `.js` import extensions; named exports only.
- **verify:** `grep -n "AGT_FILE_READ_NAME\|buildAgtFileReadTool\|'../file/sandbox.js'" src/agent/tools/agent-tools/agt-file-read.ts` shows all three; full typecheck is deferred to Step 6.
- **done:** File exists exporting the three constants/factory + deps type, importing the sandbox from `../file/sandbox.js`, with no reference to the literal `file_read`.

### Step 2 — Create `agt-file-list.ts` (read-only wrapper)
- **depends_on:** none (prompt entry added Step 7)
- **files:** `src/agent/tools/agent-tools/agt-file-list.ts` (create)
- **action:** Same recipe as Step 1, sourced from `src/agent/tools/file/list-tool.ts` (`createFileListTool`). Exports `AGT_FILE_LIST_NAME = 'agt_file_list'`, `AGT_FILE_LIST_DESCRIPTION`, `AgtFileListDeps`, `buildAgtFileListTool`. Read-only; same `{ cfg, overlays }` deps and sandbox wiring.
- **verify:** `grep -n "AGT_FILE_LIST_NAME\|buildAgtFileListTool" src/agent/tools/agent-tools/agt-file-list.ts` shows both.
- **done:** File exists with the constants/factory; no reference to literal `file_list`.

### Step 3 — Create `agt-file-write.ts` (mutating wrapper)
- **depends_on:** none (prompt entry added Step 7)
- **files:** `src/agent/tools/agent-tools/agt-file-write.ts` (create)
- **action:** Same recipe, sourced from `src/agent/tools/file/write-tool.ts` (`createFileWriteTool`). Exports `AGT_FILE_WRITE_NAME = 'agt_file_write'`, `AGT_FILE_WRITE_DESCRIPTION`, `AgtFileWriteDeps`, `buildAgtFileWriteTool`. Preserve the `confirmed`-param gate and the `requires_confirmation` early-return body verbatim. (Runtime `allowMutations` gating lives in `group-builder.ts`, Step 8 — NOT in the wrapper.)
- **verify:** `grep -n "AGT_FILE_WRITE_NAME\|confirmed" src/agent/tools/agent-tools/agt-file-write.ts` shows the name and the confirmed gate.
- **done:** File exists; the `confirmed` gate and `requires_confirmation` return are intact; no literal `file_write`.

### Step 4 — Create `agt-file-edit.ts` (mutating wrapper)
- **depends_on:** none (prompt entry added Step 7)
- **files:** `src/agent/tools/agent-tools/agt-file-edit.ts` (create)
- **action:** Same recipe, sourced from `src/agent/tools/file/edit-tool.ts` (`createFileEditTool`). Exports `AGT_FILE_EDIT_NAME = 'agt_file_edit'`, `AGT_FILE_EDIT_DESCRIPTION`, `AgtFileEditDeps`, `buildAgtFileEditTool`. Preserve the full find/replace logic: `confirmed` gate, `use_regex` branch, escaped-literal branch, `occurrence` first/all flags, `E_FILE_EDIT_NO_MATCH` throw, and the replacement-count return. This is the most complex wrapper — transplant the body exactly.
- **verify:** `grep -n "AGT_FILE_EDIT_NAME\|E_FILE_EDIT_NO_MATCH\|use_regex" src/agent/tools/agent-tools/agt-file-edit.ts` shows all three.
- **done:** File exists; regex/literal/no-match logic intact; no literal `file_edit`.

### Step 5 — Create `agt-file-append.ts` (mutating wrapper)
- **depends_on:** none (prompt entry added Step 7)
- **files:** `src/agent/tools/agent-tools/agt-file-append.ts` (create)
- **action:** Same recipe, sourced from `src/agent/tools/file/append-tool.ts` (`createFileAppendTool`). Exports `AGT_FILE_APPEND_NAME = 'agt_file_append'`, `AGT_FILE_APPEND_DESCRIPTION`, `AgtFileAppendDeps`, `buildAgtFileAppendTool`. Preserve the `confirmed` gate and append body verbatim.
- **verify:** `grep -n "AGT_FILE_APPEND_NAME\|confirmed" src/agent/tools/agent-tools/agt-file-append.ts` shows both.
- **done:** File exists; confirmed gate intact; no literal `file_append`.

### Step 6 — Export the five wrappers from the agent-tools barrel
- **depends_on:** 1, 2, 3, 4, 5
- **files:** `src/agent/tools/agent-tools/index.ts` (modify)
- **action:** In the "Wrapper factories" section (after the `agt-web-fetch` block at lines 73-78), add five export blocks mirroring the web entries, each re-exporting `AGT_FILE_*_NAME`, `AGT_FILE_*_DESCRIPTION`, `buildAgtFile*Tool`, and `type AgtFile*Deps` from the corresponding `./agt-file-*.js` module. Add a comment noting these are first-party file wrappers (plan-012) reusing the existing sandbox.
- **verify:** `npx tsc --noEmit -p tsconfig.json` — fails ONLY on the not-yet-added `agt_file_*` prompt entries if Step 7 has not run; otherwise green. After Step 7, `grep -c "buildAgtFile" src/agent/tools/agent-tools/index.ts` returns 5.
- **done:** Barrel re-exports all five wrappers; the five `AgtFile*Deps` types are exported.

### Step 7 — Add `agt_file_*` entries to `BUILTIN_TOOL_PROMPTS`, remove `file_*` entries
- **depends_on:** none
- **files:** `src/agent/tools/tool-prompts-builtin.ts` (modify)
- **action:** In `BUILTIN_TOOL_PROMPTS` (lines ~50-91) REMOVE the five `file_read` / `file_list` / `file_write` / `file_edit` / `file_append` keyed objects. ADD five new entries keyed `agt_file_read` / `agt_file_list` / `agt_file_write` / `agt_file_edit` / `agt_file_append`, with `description` and every `parameters` string copied VERBATIM from the removed entries (including `[MUTATING]` and `Requires confirmed: true` wording on the three mutators). `BUILTIN_TOOL_NAMES` at line ~273 is `Object.keys(...)` — it follows automatically, no manual edit. Net count stays 17.
- **verify:** `grep -c "agt_file_" src/agent/tools/tool-prompts-builtin.ts` ≥ 5 and `grep -E "'file_(read|list|write|edit|append)'" src/agent/tools/tool-prompts-builtin.ts` returns nothing.
- **done:** Five `agt_file_*` entries present with verbatim copied text; zero old `file_*` entries; object key count unchanged at 17.

### Step 8 — Register the five wrappers in `buildAgentToolsGroup` with correct gating
- **depends_on:** 6, 7
- **files:** `src/agent/tools/agent-tools/group-builder.ts` (modify)
- **action:** Import the five `AGT_FILE_*_NAME` / `AGT_FILE_*_DESCRIPTION` / `buildAgtFile*Tool` from `./index.js` (extend the existing import block at lines 34-59). Extend the destructured `flags` usage to include `fileRead`, `fileList`, `fileWrite`, `fileEdit`, `fileAppend`. Add five registration blocks following the web pattern (lines 167-180) and the mutator pattern (lines 186-198): `if (flags.fileRead) {...}` and `if (flags.fileList) {...}` are read-only (NO `allowMutations` gate); `if (flags.fileWrite && cfg.allowMutations) {...}`, `if (flags.fileEdit && cfg.allowMutations) {...}`, `if (flags.fileAppend && cfg.allowMutations) {...}` are mutation-gated. Each block does `tools.push(buildAgtFile*Tool({ cfg, overlays }))` then `registered.push({ name: AGT_FILE_*_NAME, description: getToolDescription(overlays, AGT_FILE_*_NAME, AGT_FILE_*_DESCRIPTION) })`. Preserve the `tools[i] ↔ meta.registered[i]` lockstep invariant. (Registration order is internal; pick a stable order, e.g. read, list, then the three mutators — and use the SAME order in the Step 16 group-builder spec and Step 21 docs.)
- **verify:** `npx tsc --noEmit -p tsconfig.json` is green; `grep -c "buildAgtFile" src/agent/tools/agent-tools/group-builder.ts` returns 5; `grep -c "cfg.allowMutations" src/agent/tools/agent-tools/group-builder.ts` increased by 3.
- **done:** Five registration blocks present; read/list ungated, write/edit/append gated on `cfg.allowMutations`; typecheck green (this requires Step 12's flag-matrix additions — if typecheck flags missing `flags.fileRead` etc., Step 12 must land first; sequence U6 before U3's verify).

### Step 9 — Remove the five file tools from the built-in catalog in `registry.ts`
- **depends_on:** none
- **files:** `src/agent/tools/registry.ts` (modify)
- **action:** Remove the five imports at lines 15-19 (`createFileReadTool` … `createFileAppendTool`). In `buildToolCatalog`: remove `createFileReadTool(cfg)` and `createFileListTool(cfg)` from the `readOnly` array (lines 64-65) so `readOnly` becomes `[createBashListAllowedTool(cfg), createBashWhichTool(cfg), createToolHelpTool(cfg)]`; delete the entire `mutatingFile` array and its construction (lines 72-78); remove `...mutatingFile` from the `assembled` spread (line 95). Update the comment block at lines 51-59 to state the built-in toolkit is now `bash_run` + `bash_list_allowed` + `bash_which` + `tool_help` (file tools moved to the agt pack as `agt_file_*`, plan-012). Leave the bash, composites, profile-scoping, and lockstep-re-derivation logic untouched.
- **verify:** `grep -E "createFile(Read|List|Write|Edit|Append)Tool|mutatingFile" src/agent/tools/registry.ts` returns nothing.
- **done:** No `createFile*Tool` imports or calls remain; `mutatingFile` array gone; comment block updated; `readOnly` holds exactly the three bash/help factories.

### Step 10 — Delete the five old file-tool factories
- **depends_on:** 9
- **files:** `src/agent/tools/file/read-tool.ts`, `src/agent/tools/file/list-tool.ts`, `src/agent/tools/file/write-tool.ts`, `src/agent/tools/file/edit-tool.ts`, `src/agent/tools/file/append-tool.ts` (delete)
- **action:** Delete the five files (their logic now lives in the `agt-file-*.ts` wrappers). KEEP `src/agent/tools/file/sandbox.ts` and `src/agent/tools/file/sandbox.spec.ts` unchanged. Optionally update the stale comment at `src/agent/tools/agent-tools/permissions.ts:150-151` to reference the new wrapper paths (cosmetic; not required for green build).
- **verify:** `ls src/agent/tools/file/` lists only `sandbox.ts` and `sandbox.spec.ts`; `grep -rn --include="*.ts" -E "file/(read|list|write|edit|append)-tool" src` returns nothing.
- **done:** The five factory files are gone; the sandbox remains; no source references the deleted modules.

### Step 11 — Rewrite the built-in system-prompt block; remove the `mutatingFile` presence flag
- **depends_on:** none
- **files:** `src/agent/system-prompt.ts` (modify)
- **action:** (a) In the `BuiltinToolsPresence` interface (lines 143-150) REMOVE the `mutatingFile` field and its doc comment. (b) In `buildBuiltinToolsPromptBlock` (lines 225-287): change the parameter type to `{ builtinTools: boolean; bashRun: boolean }`; in the "Available tools" section remove the `file_read / file_list` bullet (lines 251-253) and the `if (p.mutatingFile)` file-mutation clause (lines 254-256), so the block describes ONLY `bash_run` framing (gated by `p.bashRun`), the bash inspection tools (`bash_list_allowed` / `bash_which`), and `tool_help`; in the OUT-OF-SCOPE section remove the entire `p.mutatingFile ? … : …` branch (lines 280-284) that emits the file-mutation line. Keep the `bashRun` framing, CORE RULES, and the shell-features OUT-OF-SCOPE line intact. (c) In `buildSystemPromptForCfg` (lines 422-429) remove the `mutatingFile:` property and its `names.has('file_write') || names.has('file_edit') || names.has('file_append')` derivation from the `builtinPresence` literal. (d) DO NOT touch `LEGACY_DEFAULT_SYSTEM_PROMPTS` (lines 52-100, frozen).
- **verify:** `grep -n "mutatingFile" src/agent/system-prompt.ts` returns nothing; `grep -n "file_read / file_list" src/agent/system-prompt.ts` returns nothing; `grep -c "LEGACY_DEFAULT_SYSTEM_PROMPTS" src/agent/system-prompt.ts` unchanged from baseline.
- **done:** No `mutatingFile` references remain; built-in block has no file-tool prose; `LEGACY_DEFAULT_SYSTEM_PROMPTS` byte-identical.

### Step 12 — Extend the config flag matrix and env keys
- **depends_on:** none
- **files:** `src/config/agent-config.ts` (modify)
- **action:** (a) Add `fileRead?`, `fileList?`, `fileWrite?`, `fileEdit?`, `fileAppend?` optional booleans to `AgentConfigFile.agentTools.tools` (lines 118-127) and to `AgentCliFlags.agentTools.tools` (lines 339-348). (b) Add `fileRead`, `fileList`, `fileWrite`, `fileEdit`, `fileAppend` required booleans to `AgentConfig.agentTools.tools` (lines 235-245) with a comment "First-party file wrappers (plan-012)". (c) Add `'CLI_AGENT_AGT_FILE_READ'`, `'CLI_AGENT_AGT_FILE_LIST'`, `'CLI_AGENT_AGT_FILE_WRITE'`, `'CLI_AGENT_AGT_FILE_EDIT'`, `'CLI_AGENT_AGT_FILE_APPEND'` to the agt env-key list immediately after `CLI_AGENT_AGT_WEB_FETCH` (line 835), with a plan-012 comment. (d) Extend the `resolveOne` `envKey` union (lines 1332-1339) with the five new literals. (e) Add five `resolveOne(flagTools?.file*, 'CLI_AGENT_AGT_FILE_*', cfgTools?.file*, true)` calls to the `tools` object (after `webFetch`, lines 1359-1361): all five default `true` (read/list read-only on; write/edit/append on-but-mutation-gated downstream in `group-builder.ts`). No fallback substitution — `true` is the documented default tier, consistent with every other agt key.
- **verify:** `grep -c "CLI_AGENT_AGT_FILE_" src/config/agent-config.ts` ≥ 11 (5 in the env-key list + 5 in the union + at least the calls); `npx tsc --noEmit -p tsconfig.json` is green (this is the change that makes Step 8 typecheck).
- **done:** All three `tools` shapes carry the five keys; five env keys in the list and the union; five `resolveOne` calls defaulting `true`; typecheck green.

### Step 13 — Register the ten new CLI flags and update `--no-builtin-tools` help text
- **depends_on:** none
- **files:** `src/cli.ts` (modify)
- **action:** After the `--disable-agt-web-fetch` option (line 133) add ten `.option(...)` calls: `--enable-agt-file-read` / `--disable-agt-file-read` ("Enable agt_file_read (default-on; read-only)" / "Disable agt_file_read"); the same for `-file-list` (read-only); and `-file-write` / `-file-edit` / `-file-append` with "(default-on; mutation-gated)" on the enable strings. Match the exact phrasing/style of the existing web rows (lines 130-133) so the `--help` diff is minimal and predictable. Update the `--builtin-tools` help string (line 112) and `--no-builtin-tools` help string (line 113) to state the built-in toolkit is now `bash_run`, `bash_list_allowed`, `bash_which`, `tool_help` and that file tools are governed by `--agent-tools` / `--disable-agt-file-*`.
- **verify:** `grep -c "agt-file-" src/cli.ts` returns 10; `grep -n "bash_run.*tool_help\|tool_help.*bash" src/cli.ts` shows the updated built-in help strings.
- **done:** Ten file flags registered with correct default annotations; both built-in help strings updated to exclude file tools.

### Step 14 — Extend the flag mapper
- **depends_on:** none
- **files:** `src/cli-agent-tools-flags.ts` (modify)
- **action:** Extend the `ToolKey` union (line 70) with `'fileRead' | 'fileList' | 'fileWrite' | 'fileEdit' | 'fileAppend'`. Add five rows to the `pairs` table (after the `webFetch` row, line 85), each `{ key, enableOpt, disableOpt, enableFlag, disableFlag }` using Commander's camelCased opt names (`enableAgtFileRead` / `disableAgtFileRead`, etc.) and the literal flag strings (`--enable-agt-file-read` / `--disable-agt-file-read`, etc.). The existing per-pair conflict loop then handles enable+disable conflicts and the umbrella conflict for the new keys with no further change.
- **verify:** `grep -c "fileRead\|fileList\|fileWrite\|fileEdit\|fileAppend" src/cli-agent-tools-flags.ts` ≥ 10 (union + pairs); `npx tsc --noEmit -p tsconfig.json` green.
- **done:** `ToolKey` includes the five keys; `pairs` has five new rows; typecheck green.

### Step 15 — Author the five `agt-file-*.spec.ts` unit specs
- **depends_on:** 6, 7, 8, 12
- **files:** `src/agent/tools/agent-tools/agt-file-read.spec.ts`, `agt-file-list.spec.ts`, `agt-file-write.spec.ts`, `agt-file-edit.spec.ts`, `agt-file-append.spec.ts` (create)
- **action:** First targeted unit coverage for the file logic (none exists today). For each wrapper, construct it via `buildAgtFile*Tool({ cfg })` against a tmp-dir sandbox root and invoke `.func(...)`. Cover: sandbox enforcement (path outside root → `E_FILE_PATH_OUTSIDE_ROOT`); the happy path; and tool-specific branches — read: binary/base64 mode + `E_FILE_NOT_FOUND` (ENOENT) + `max_bytes`/`E_FILE_TOO_LARGE`; list: directory enumeration; write/append: `confirmed:false` → `requires_confirmation` return, `confirmed:true` → file mutated; edit: literal replace, `use_regex`, `occurrence` first/all, `E_FILE_EDIT_NO_MATCH`. Add one overlay-description-resolution assertion per wrapper (overlay key = `agt_file_*`). Use the project's vitest patterns from existing agent-tools specs.
- **verify:** `npx vitest run src/agent/tools/agent-tools/agt-file-read.spec.ts src/agent/tools/agent-tools/agt-file-list.spec.ts src/agent/tools/agent-tools/agt-file-write.spec.ts src/agent/tools/agent-tools/agt-file-edit.spec.ts src/agent/tools/agent-tools/agt-file-append.spec.ts` — all green.
- **done:** Five spec files pass, covering sandbox + per-tool branches + overlay resolution.

### Step 16 — Update `group-builder.spec.ts`
- **depends_on:** 8, 12
- **files:** `src/agent/tools/agent-tools/group-builder.spec.ts` (modify)
- **action:** Extend the spec's `Flags` interface / `makeCfg` fixture to include `fileRead`, `fileList`, `fileWrite`, `fileEdit`, `fileAppend`. Add tests: read/list register without `allowMutations`; write/edit/append register ONLY when `allowMutations === true` (and are silently dropped, with their meta omitted, when the flag is set but `allowMutations` is off); the `tools.length === meta.registered.length` lockstep holds with the new tools present. Use the same registration order chosen in Step 8.
- **verify:** `npx vitest run src/agent/tools/agent-tools/group-builder.spec.ts` — green.
- **done:** Group-builder spec asserts read-only vs mutation-gated registration and lockstep for the five new tools.

### Step 17 — Update `registry.spec.ts`
- **depends_on:** 9, 12
- **files:** `src/agent/tools/registry.spec.ts` (modify)
- **action:** Add the five new flag keys to the spec's `makeCfg` `agentTools.tools` fixture. Remove any assertion that `file_*` appears in the built-in catalog. Assert (AC1) the built-in group contains ONLY `bash_run` (allowlist non-empty), `bash_list_allowed`, `bash_which`, `tool_help` and NO `file_*`. Assert (AC2/AC3) with defaults + agent-tools on + no `--allow-mutations`, `agt_file_read` and `agt_file_list` are present and the three mutators absent; with `--allow-mutations`, the mutators appear. Assert (AC6) profile `tools.deny: ['agt_file_write']` removes it via name-based scoping with no special-casing.
- **verify:** `npx vitest run src/agent/tools/registry.spec.ts` — green.
- **done:** Registry spec covers AC1, AC2, AC3 (catalog membership), and AC6.

### Step 18 — Update `registry.spec.ts` toggle assertions (AC4/AC5)
- **depends_on:** 9, 12
- **files:** `src/agent/tools/registry.spec.ts` (modify)
- **action:** In the same spec (the scan's "registry-toggles" assertions live here at this commit), assert AC4: `--no-builtin-tools` (`cfg.builtinTools === false`) removes bash + `tool_help` only and the `agt_file_*` tools are STILL present (governed by agent-tools). Assert AC5: `--no-agent-tools` (`cfg.agentTools.enabled === false`) removes ALL `agt_*` including the five file tools, while `bash_list_allowed` / `bash_which` / `tool_help` remain. (If a separate `registry-toggles.spec.ts` exists, apply these there instead — verify the filename before editing; do NOT create a duplicate.)
- **verify:** `npx vitest run src/agent/tools/registry.spec.ts` — green (and `registry-toggles.spec.ts` if present).
- **done:** AC4 and AC5 toggle behavior asserted.

### Step 19 — Update `tool-prompts-builtin.spec.ts`, `agent-config.spec.ts`, `system-prompt.spec.ts`
- **depends_on:** 7, 11, 12
- **files:** `src/agent/tools/tool-prompts-builtin.spec.ts`, `src/config/agent-config.spec.ts`, `src/agent/system-prompt.spec.ts` (modify)
- **action:** (a) `tool-prompts-builtin.spec.ts`: in the "exactly 17 documented tools" `expected` list (lines 107-113) remove `'file_read'`/`'file_list'`/`'file_write'`/`'file_edit'`/`'file_append'` and add `'agt_file_read'`/`'agt_file_list'`/`'agt_file_write'`/`'agt_file_edit'`/`'agt_file_append'` (count stays 17); update `makeMaximalCfg` to pass the five new flag keys so the completeness test (lines 95-101) exercises them. (b) `agent-config.spec.ts`: add resolution tests for `fileRead`/`fileList`/`fileWrite`/`fileEdit`/`fileAppend`, and assert (AC10/OQ-3) each of the five `CLI_AGENT_AGT_FILE_*` env keys participates in the four-tier precedence (CLI > env > config.json > default), including the env-tier-wins-over-config case. (c) `system-prompt.spec.ts`: assert (AC8) the built-in block no longer mentions any file tool and emits no `mutatingFile`/file-mutation prose; assert the `agt_file_*` descriptions appear in the agent-tools block when those tools are registered and the mutators' descriptions are omitted when `allowMutations` is off; remove/replace any prior assertion on the removed `mutatingFile` clause.
- **verify:** `npx vitest run src/agent/tools/tool-prompts-builtin.spec.ts src/config/agent-config.spec.ts src/agent/system-prompt.spec.ts` — all green.
- **done:** AC7, AC10 (with the five-env-key precedence assertion), and AC8 covered; the 17-tool list updated.

### Step 20 — Sweep `integration-profile-overlay-coexistence.spec.ts` for hard-coded old names
- **depends_on:** 9, 12
- **files:** `src/agent/tools/integration-profile-overlay-coexistence.spec.ts` (modify)
- **action:** This spec references `file_read`/`file_list`/`file_write`/`file_edit`/`file_append` in ~30 places (verified at plan time). Classify each occurrence: synthetic `fakeTool('file_read', ...)` fixtures and their local assertions test the scoping/overlay MECHANICS in a name-agnostic way — rename them to the `agt_file_*` names for consistency (the mechanics are identical, so renaming is safe and keeps the suite honest). Occurrences that assert against the REAL built-in catalog (e.g. lines ~290-326 allow/deny of `file_read`/`file_list`, the mutating-block test at ~429-452 asserting `file_write`/`file_edit`/`file_append` survive with `allowMutations`) MUST be updated to the `agt_file_*` names AND, where the test relied on those tools being in the built-in group, adjusted so they are now sourced from the agt pack (agent-tools enabled). Also fix the `order: ['web_search', 'file_read']` reference (line ~396) to current names (`agt_web_search`, `agt_file_read`). Do not weaken any assertion; preserve coverage of allow/deny/order + overlay resolution.
- **verify:** `npx vitest run src/agent/tools/integration-profile-overlay-coexistence.spec.ts` — green; `grep -E "'file_(read|list|write|edit|append)'" src/agent/tools/integration-profile-overlay-coexistence.spec.ts` returns nothing (all renamed).
- **done:** No literal old `file_*` tool names remain; the spec passes with `agt_file_*` names and equivalent coverage.

### Step 21 — Update documentation
- **depends_on:** 9, 11, 12, 13
- **files:** `docs/tools/cli-agent.md`, `docs/design/configuration-guide.md`, `docs/design/project-functions.md`, `docs/design/project-design.md` (modify)
- **action:** (a) `docs/tools/cli-agent.md`: file tools are now `agt_file_*` members of the agent-tools pack; document the ten new per-tool flags; state `--no-builtin-tools` now leaves only `bash_run` + `bash_list_allowed` + `bash_which` + `tool_help` (no longer affects file tools); state `--no-agent-tools` / `--disable-agt-file-*` govern file ops; note read/list are default-on and write/edit/append are default-on but mutation-gated. (b) `docs/design/configuration-guide.md`: add the five new CLI flags, the five `CLI_AGENT_AGT_FILE_*` env keys, and the five `agentTools.tools.file*` config.json keys, each with purpose, the four-tier precedence (CLI > env > config.json > default), and the default (`true`, with the mutation-gated caveat for write/edit/append). (c) `docs/design/project-functions.md`: add the functional-requirement entry for file-ops-to-agt (mirror the plan-011 web entry). (d) `docs/design/project-design.md`: add a dated section "2026-06-15 — plan-012: file operations moved into the agt_ pack" recording the decision and citing this plan, the refined request, and the codebase scan.
- **verify:** `grep -c "agt_file_" docs/tools/cli-agent.md` > 0; `grep -c "CLI_AGENT_AGT_FILE_" docs/design/configuration-guide.md` ≥ 5; `grep -c "2026-06-15" docs/design/project-design.md` ≥ 1; `grep -c "agt_file" docs/design/project-functions.md` > 0.
- **done:** All four docs updated; the provenance chain (refined-request → scan → plan → design) is cited in `project-design.md`.

### Step 22 — Re-record the `--help` baseline and run full verification
- **depends_on:** 1-21
- **files:** `test_scripts/baselines/help-no-treat-as-tool.txt`, `test_scripts/baselines/help-no-treat-as-tool.sha256` (modify)
- **action:** Build first (`npm run build`). Capture current help into a temp file (`node dist/cli.js --help`) with `NO_COLOR=1 FORCE_COLOR=0`, and DIFF it against the committed `test_scripts/baselines/help-no-treat-as-tool.txt`. Confirm the only differences are the 10 new `--enable/--disable-agt-file-read|list|write|edit|append` rows and the updated `--builtin-tools`/`--no-builtin-tools` help strings — nothing else. Then overwrite the baseline with the captured output and regenerate the companion `help-no-treat-as-tool.sha256` (the spec reads only the `.txt` byte-for-byte, but keep the checksum file consistent). Finally run the full suite, typecheck, and build.
- **verify:** `npm run build` succeeds; `npx vitest run` is fully green (incl. `src/cli-help-baseline.spec.ts`); `npx tsc --noEmit -p tsconfig.json` clean. The pre-overwrite diff shows ONLY the expected 10 flag rows + 2 changed built-in help strings.
- **done:** Baseline re-recorded deliberately after a verified diff; `cli-help-baseline.spec.ts` green; full `vitest run` + `tsc --noEmit` + `npm run build` all green (AC9, AC12).

## Implementation Units

Each unit has a pairwise-disjoint file set, so a coder fan-out can run them in parallel where dependencies allow. **Recommended sequencing for parallel execution:** land U6 (config) and U2 (prompt registry) early — U1's build verify, U3, and U8 depend on them; U3 (group-builder) typechecks only after U6. U4/U5/U7 are independent and can run in parallel with the others. U8 (tests) and U9 (docs + baseline + final verify) come last.

### U1 — Wrappers + barrel
- **steps:** 1, 2, 3, 4, 5, 6
- **files:** `agt-file-read.ts`, `agt-file-list.ts`, `agt-file-write.ts`, `agt-file-edit.ts`, `agt-file-append.ts`, `agent-tools/index.ts`
- **interface contract (exported, consumed by U3/U4-via-barrel/U8):** `AGT_FILE_READ_NAME` = `'agt_file_read'`, `AGT_FILE_LIST_NAME` = `'agt_file_list'`, `AGT_FILE_WRITE_NAME` = `'agt_file_write'`, `AGT_FILE_EDIT_NAME` = `'agt_file_edit'`, `AGT_FILE_APPEND_NAME` = `'agt_file_append'`; matching `AGT_FILE_*_DESCRIPTION` constants aliasing `BUILTIN_TOOL_PROMPTS[name]!.description`; `buildAgtFile*Tool(deps: { cfg: AgentConfig; overlays?: OverlayRegistry }): DynamicStructuredTool`; `AgtFile*Deps` types. All re-exported from `agent-tools/index.ts`.
- **depends on:** U2 (the `AGT_FILE_*_DESCRIPTION` aliases require the prompt entries to exist for build verification).

### U2 — Prompt registry
- **steps:** 7
- **files:** `tool-prompts-builtin.ts`
- **interface contract:** `BUILTIN_TOOL_PROMPTS` gains keys `agt_file_read|list|write|edit|append` (verbatim copies of the removed `file_*` entries) and loses the five `file_*` keys; total entry count stays 17. `BUILTIN_TOOL_NAMES` follows automatically.

### U3 — Group-builder registration
- **steps:** 8
- **files:** `agent-tools/group-builder.ts`
- **interface contract:** registers the five wrappers into `tools` + `meta.registered` in lockstep; read/list ungated, write/edit/append gated on `cfg.allowMutations`. Reads `cfg.agentTools.tools.file*` (provided by U6) and imports the `AGT_FILE_*` symbols (provided by U1).
- **depends on:** U1 (symbols), U2 (descriptions), U6 (flag matrix for typecheck).

### U4 — Registry built-in shrink + factory deletion
- **steps:** 9, 10
- **files:** `registry.ts`, the five `file/*-tool.ts` (deleted)
- **interface contract:** built-in `readOnly` = `[bash_list_allowed, bash_which, tool_help]`; `mutatingFile` removed; no `createFile*Tool` imports. `sandbox.ts` retained (U1 imports it).

### U5 — System-prompt built-in block
- **steps:** 11
- **files:** `system-prompt.ts`
- **interface contract:** `BuiltinToolsPresence` no longer has `mutatingFile`; `buildBuiltinToolsPromptBlock` param type is `{ builtinTools, bashRun }`. Any caller passing `mutatingFile` (only `buildSystemPromptForCfg`, same file) is updated in-unit.

### U6 — Config + env keys
- **steps:** 12
- **files:** `agent-config.ts`
- **interface contract (consumed by U3 typecheck + U7 + U8):** `AgentConfig.agentTools.tools` and the file/CLI shapes carry `fileRead`/`fileList`/`fileWrite`/`fileEdit`/`fileAppend`; five `CLI_AGENT_AGT_FILE_*` env keys in the env-key list and the `resolveOne` union; all five default `true`.

### U7 — CLI flags + mapper
- **steps:** 13, 14
- **files:** `cli.ts`, `cli-agent-tools-flags.ts`
- **interface contract:** ten new `--enable/--disable-agt-file-*` options; `ToolKey` + `pairs` extended with the five keys; updated `--builtin-tools`/`--no-builtin-tools` help strings. `mapAgentToolFlags` output feeds `AgentCliFlags['agentTools'].tools` (U6 shape).

### U8 — Tests
- **steps:** 15, 16, 17, 18, 19, 20
- **files:** the five `agt-file-*.spec.ts` (new), `group-builder.spec.ts`, `registry.spec.ts`, `tool-prompts-builtin.spec.ts`, `agent-config.spec.ts`, `system-prompt.spec.ts`, `integration-profile-overlay-coexistence.spec.ts`
- **depends on:** U1–U7 (exercises the runtime/config surfaces they create).

### U9 — Docs + help baseline + full verify
- **steps:** 21, 22
- **files:** `docs/tools/cli-agent.md`, `configuration-guide.md`, `project-functions.md`, `project-design.md`, `help-no-treat-as-tool.txt`, `help-no-treat-as-tool.sha256`
- **depends on:** U1–U8 (baseline + full suite green require all source/test changes landed).

## Risks & Mitigations
- **Step 8 typecheck depends on Step 12.** `group-builder.ts` reads `flags.fileRead` etc., which exist only after the `AgentConfig.agentTools.tools` shape is extended. Mitigation: sequence U6 before running U3's typecheck verify (noted in the unit sequencing).
- **U1 build verification depends on U2.** Each `AGT_FILE_*_DESCRIPTION` aliases `BUILTIN_TOOL_PROMPTS[name]!.description`, which throws/undefined-narrows at build if the entry is absent. Mitigation: U1 declared `depends on: U2`; run Step 7 before Step 6's full typecheck.
- **`integration-profile-overlay-coexistence.spec.ts` is large and name-heavy (~30 old-name occurrences).** A blind find/replace could rename name-agnostic `fakeTool` fixtures inconsistently or miss real-catalog assertions. Mitigation: Step 20 mandates per-occurrence classification (synthetic vs real-catalog) and a final grep proving zero literal `file_*` tool names remain.
- **`--help` baseline is byte-stability tested.** Any incidental whitespace/order change beyond the intended rows fails `cli-help-baseline.spec.ts`. Mitigation: Step 22 diffs BEFORE overwriting and asserts the diff is exactly the 10 new rows + 2 changed built-in help strings.
- **Lockstep invariant (`tools[i] ↔ meta.registered[i]`).** A registration block that pushes to `tools` but not `registered` (or vice versa) silently breaks the agent-tools prompt block. Mitigation: Step 8 pairs every `tools.push` with a `registered.push`; Step 16 asserts `tools.length === meta.registered.length` with the new tools present.
- **No-fallback config rule.** The five new keys default `true` in the `resolveOne` "default" tier — this is the documented starting value in the four-tier chain, NOT a silent substitute for a missing required value (consistent with every existing agt key). Step 19(b) asserts precedence rather than relying on the default alone.
- **Scan staleness:** none. `last_scanned_commit` (`c546d38…`) equals current `HEAD`; the scan structure is current.

## Acceptance Criteria Mapping
| Criterion (refined request) | Step(s) |
|---|---|
| AC1 — built-in group is bash + tool_help only, no `file_*` | 9, 17 |
| AC2 — agt pack registers five `agt_file_*` with write/edit/append mutation-gated, reusing file logic + sandbox | 1-5, 8, 16, 17 |
| AC3 — defaults: read+list present, mutators absent; with `--allow-mutations` mutators appear; bash inspection present | 8, 12, 16, 17 |
| AC4 — `--no-builtin-tools` removes bash + tool_help only; file tools still present | 9, 18 |
| AC5 — `--no-agent-tools` removes all `agt_*` incl. file tools; bash + tool_help remain | 18 |
| AC6 — profile `tools.deny`/`allow` on new names works via name-based scoping | 17, 20 |
| AC7 — `BUILTIN_TOOL_PROMPTS` has `agt_file_*`, old `file_*` removed, completeness test passes | 7, 19 |
| AC8 — built-in block no longer mentions file tools; agent-tools block documents `agt_file_*` (mutators omitted when allowMutations off) | 11, 19 |
| AC9 — `--help` shows 10 new flags; baseline re-recorded; baseline spec green | 13, 22 |
| AC10 — config honors five `CLI_AGENT_AGT_FILE_*` env keys + config.json keys with four-tier precedence | 12, 19 |
| AC11 — `mapAgentToolFlags` maps the five pairs and still throws `UsageError` on conflicts | 14, (mapper spec exercised via existing flag spec — extend in 19 if a dedicated spec exists) |
| AC12 — full suite, typecheck, build green; no new HIGH-or-above advisory (no dep added) | 22 |

> Note on AC11: the flag-mapper conflict behavior is covered by the existing agent-tools flag spec; the five new keys flow through the same loop. If a dedicated `cli-agent-tools-flags.spec.ts` exists, extend it in Step 19 with one map + one conflict case for a file key; otherwise the coverage rides on the registry/toggle specs and the `--help` baseline.

## Deviation Rules for Executors
1. **Auto-fix in-scope bugs and blockers** discovered mid-step (e.g. a wrong import path, a fixture that needs a new field) and document what you changed in your step notes.
2. **Add missing security/correctness essentials** (e.g. a missed `allowMutations` gate on a mutator, a missing sandbox check) and document them — these are not optional.
3. **STOP and surface anything architectural** — if a step cannot be done as written without changing an interface contract above, a deviation from plan-011's pattern, or touching an Out-of-Scope file from the scan, halt and report rather than improvising.
4. **Log nice-to-haves instead of doing them.** When running SOLO, append them directly to `Issues - Pending Items.md` (pending section, ordered by importance). When running as ONE OF SEVERAL PARALLEL agents, do NOT edit `Issues - Pending Items.md` directly — put the items in your final report and let the orchestrator append them after the phase.
5. **Do not perform any version-control operation** unless the user explicitly requests it (project rule).

## Verification
The whole plan has landed when, from the project root:
- `npm run build` succeeds (`tsc -p tsconfig.json && npm run postbuild:assets && npm run postbuild:chmod`).
- `npx tsc --noEmit -p tsconfig.json` reports no errors.
- `npx vitest run` is fully green — including `registry.spec.ts`, `group-builder.spec.ts`, `tool-prompts-builtin.spec.ts`, `agent-config.spec.ts`, `system-prompt.spec.ts`, `integration-profile-overlay-coexistence.spec.ts`, the five new `agt-file-*.spec.ts`, and `cli-help-baseline.spec.ts`.
- `node dist/cli.js --help` shows the ten new `--enable/--disable-agt-file-*` rows and the updated `--builtin-tools`/`--no-builtin-tools` help strings; the re-recorded baseline matches byte-for-byte.
- `grep -rn --include="*.ts" -E "file/(read|list|write|edit|append)-tool|createFile(Read|List|Write|Edit|Append)Tool|mutatingFile" src` returns nothing.
- `npm audit` (or the project's audit command) reports no new HIGH-or-above advisory (expected: no dependency added).
