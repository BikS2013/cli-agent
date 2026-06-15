---
status: approved
plan_number: 011
slug: web-into-agent-tools
based_on_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
approach: lightweight (design note + implement, user-confirmed)
decision: "Move web_search/web_fetch out of the built-in toolkit into the agent-tools pack as agt_web_search / agt_web_fetch (first-party tools in the agt_ namespace, reusing the existing web backend). User-confirmed placement = agt_ pack."
files_to_create:
  - src/agent/tools/agent-tools/agt-web-search.ts
  - src/agent/tools/agent-tools/agt-web-fetch.ts
files_to_modify:
  - src/agent/tools/agent-tools/index.ts
  - src/agent/tools/agent-tools/group-builder.ts
  - src/agent/tools/tool-prompts-builtin.ts
  - src/agent/tools/registry.ts
  - src/agent/system-prompt.ts
  - src/config/agent-config.ts
  - src/cli-agent-tools-flags.ts
  - src/cli.ts
  - test_scripts/baselines/help-no-treat-as-tool.txt
  - docs/tools/cli-agent.md
  - docs/design/configuration-guide.md
  - docs/design/project-functions.md
  - docs/design/project-design.md
files_to_delete:
  - src/agent/tools/web/search-tool.ts
  - src/agent/tools/web/fetch-tool.ts
---

# Plan 011 — Move web_search/web_fetch into the agent-tools pack (agt_web_search / agt_web_fetch)

## Goal
Remove `web_search` / `web_fetch` from the built-in toolkit and re-home them in the `agt_*` pack as `agt_web_search` / `agt_web_fetch`, reusing the existing web backend (`src/agent/tools/web/backends/`). After this: web is governed by `--agent-tools` + the new `--enable/--disable-agt-web-search` / `-agt-web-fetch` per-tool flags (NOT by `--no-builtin-tools`).

## Authoritative facts (verified)
- `agt_*` wrappers (`agt-glob.ts`) take `{ permissions, overlays }`, read description/params from `BUILTIN_TOOL_PROMPTS[<name>]`, are registered by `cfg.agentTools.tools.<key>` flags in `group-builder.ts`, and their meta (`{name,description}`) feeds `buildAgentToolsPromptBlock` (a pure projection — the pack's prompt section is automatic).
- `web_search`/`web_fetch` (`search-tool.ts`/`fetch-tool.ts`) take `{ cfg, requestBudget }`, use `getWebBackend(cfg)` + a per-session request budget (`WEB_SEARCH_MAX_REQUESTS`, default 50) + overlays. They live in the built-in `readOnly` array in `registry.ts`.
- `BUILTIN_TOOL_PROMPTS` already houses BOTH built-in and `agt_*` prompt entries; a registry-completeness test asserts every catalog tool name has an entry.

## Changes

### 1. New wrappers (reuse the backend; do NOT duplicate it)
- `src/agent/tools/agent-tools/agt-web-search.ts`: export `AGT_WEB_SEARCH_NAME = 'agt_web_search'`, `AGT_WEB_SEARCH_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_WEB_SEARCH_NAME]!.description`, and `buildAgtWebSearchTool(deps: { cfg: AgentConfig; requestBudget: { remaining: number }; overlays?: OverlayRegistry }): DynamicStructuredTool`. Body = the current `createWebSearchTool` body verbatim, but `name: AGT_WEB_SEARCH_NAME` and reading prompts from the `agt_web_search` key. Keep `getWebBackend(cfg)`, the budget decrement + `E_SEARCH_BUDGET_EXCEEDED`, `mergeProfileToolArgs`, `handleToolError`.
- `src/agent/tools/agent-tools/agt-web-fetch.ts`: same shape for `agt_web_fetch` from the current `createWebFetchTool`.
- DELETE `src/agent/tools/web/search-tool.ts` and `fetch-tool.ts` (their logic moved). KEEP `src/agent/tools/web/backends/` (reused).

### 2. `index.ts` (agent-tools): export the new `AGT_WEB_*_NAME` / `AGT_WEB_*_DESCRIPTION` / `buildAgtWeb*Tool` (so `group-builder` imports them like the other `agt_*` wrappers).

### 3. `group-builder.ts`
- Create ONE request budget at the top: `const requestBudget = { remaining: parseInt(process.env['WEB_SEARCH_MAX_REQUESTS'] ?? '50', 10) };` (mirrors what `registry.ts` did).
- Add registration (read-only, NO `allowMutations` gate), placed after grep:
  - `if (flags.webSearch) { tools.push(buildAgtWebSearchTool({ cfg, requestBudget, overlays })); registered.push({ name: AGT_WEB_SEARCH_NAME, description: getToolDescription(overlays, AGT_WEB_SEARCH_NAME, AGT_WEB_SEARCH_DESCRIPTION) }); }`
  - `if (flags.webFetch) { ...buildAgtWebFetchTool... }`

### 4. `tool-prompts-builtin.ts`
- Add `agt_web_search` / `agt_web_fetch` entries to `BUILTIN_TOOL_PROMPTS` (copy the existing `web_search` / `web_fetch` entries verbatim — same description incl. "Never fabricate URLs" + same params). Remove the old `web_search` / `web_fetch` entries (they leave the catalog). Update `BUILTIN_TOOL_NAMES` accordingly.

### 5. `registry.ts`
- Remove `createWebSearchTool` / `createWebFetchTool` from `readOnly` and their imports; remove the now-unused `maxRequests` / `requestBudget` locals (moved to group-builder). The cross-cutting toolkit `readOnly` now ends at `tool_help` (file_read/list, bash_list_allowed/which, tool_help).

### 6. `system-prompt.ts` — built-in block (plan-010) drops web
- In `buildBuiltinToolsPromptBlock`, REMOVE all web references (now that web is not built-in): the `web_search / web_fetch` bullet in the Available-tools list, the "NEVER invent URLs…" CORE RULE, and the OUT-OF-SCOPE "cannot access the internet beyond web_search/web_fetch" line. (The "never fabricate URLs" guidance now rides on the `agt_web_*` descriptions in the agent-tools block.) The `bashRun` / `mutatingFile` gating is unchanged.

### 7. Config (`agent-config.ts`)
- `AgentConfig.agentTools.tools`, `AgentConfigFile.agentTools.tools`, `AgentCliFlags.agentTools.tools`: add `webSearch` / `webFetch` booleans.
- `resolveAgentTools`: add `webSearch`/`webFetch` via the existing `resolveOne` (default `true`); extend its `envKey` union with `'CLI_AGENT_AGT_WEB_SEARCH' | 'CLI_AGENT_AGT_WEB_FETCH'`.
- Add `CLI_AGENT_AGT_WEB_SEARCH` / `CLI_AGENT_AGT_WEB_FETCH` to the agt env-key set (and `OTHER_ENV_KEYS`/`ALL_ENV_KEYS` as the existing `CLI_AGENT_AGT_*` keys are).

### 8. `cli-agent-tools-flags.ts` + `cli.ts`
- `mapAgentToolFlags`: add `webSearch`/`webFetch` to the per-tool table with `enableFlag: '--enable-agt-web-search'` / `disableFlag: '--disable-agt-web-search'` (and `-agt-web-fetch`), reading opts `enableAgtWebSearch`/`disableAgtWebSearch` etc.
- `cli.ts`: register `--enable-agt-web-search` / `--disable-agt-web-search` / `--enable-agt-web-fetch` / `--disable-agt-web-fetch` on the agent command, mirroring the existing `--enable-agt-glob` etc. (find the existing registrations and add alongside).

## Gating after this change (the point of the refactor)
- `agt_web_search`/`agt_web_fetch` appear iff: `cfg.agentTools.enabled` (umbrella `--no-agent-tools` off) AND the per-tool flag is on. They are read-only (no `--allow-mutations` needed). `--no-builtin-tools` no longer affects web.
- Profile `tools.deny: [agt_web_search]` works (name-based scoping, no code change).

## Tests
- `registry.spec.ts`: web NOT in the built-in catalog; with defaults (agent-tools on) `agt_web_search`/`agt_web_fetch` ARE present; with `--no-agent-tools` they're gone.
- `registry-toggles.spec.ts` (plan-008): `--no-builtin-tools` no longer removes web; `--no-agent-tools` removes `agt_web_*`. Update assertions.
- `agent-config.spec.ts`: `webSearch`/`webFetch` resolution + the two new env keys + precedence.
- `cli-composite-flags`/agent-tools flag spec: the new per-tool flags map correctly.
- `system-prompt.spec.ts` (plan-010): built-in block contains NO `web_search`/`web_fetch`/"invent URLs"; the `agt_web_*` descriptions appear via the agent-tools block when registered.
- `tool-prompts-builtin.spec.ts` / completeness test: `agt_web_search`/`agt_web_fetch` have entries; `web_search`/`web_fetch` removed (fix any reverse-completeness assertion).
- Relocate/rename any `web/search-tool.spec.ts` / `fetch-tool.spec.ts` to `agent-tools/agt-web-search.spec.ts` / `agt-web-fetch.spec.ts` (keep coverage of budget exhaustion, backend call, overlay).
- Re-record the `--help` baseline (4 new flag rows) deliberately, diffing first.

## Docs
`docs/tools/cli-agent.md` (web is now `agt_web_search`/`agt_web_fetch` in the agent-tools pack; new per-tool flags; `--no-builtin-tools` no longer affects web; `--no-agent-tools`/`--disable-agt-web-*` do); `configuration-guide.md` (new flags/env/config keys + precedence); `project-functions.md` (FR); `project-design.md` (dated §, 2026-06-14). Note in docs that `agt_web_*` are first-party tools in the `agt_` namespace (the only non-vendored members of the pack).
