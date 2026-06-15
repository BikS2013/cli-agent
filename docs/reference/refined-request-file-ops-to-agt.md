# Refined Request: Move native file operations into the agent-tools (`agt_`) pack

> Slug: `file-ops-to-agt` — reuse for every downstream artifact (investigation, codebase-scan, plan, design, validation reports).

## Category
Development (refactor / tool-catalog re-homing — TypeScript, LangGraph ReAct agent)

## Objective
Re-home the five native file tools (`file_read`, `file_list`, `file_write`, `file_edit`, `file_append`) out of the built-in cross-cutting toolkit and into the `agt_` pack as first-party members `agt_file_read`, `agt_file_list`, `agt_file_write`, `agt_file_edit`, `agt_file_append`, reusing the existing file-tool implementations in `src/agent/tools/file/*` and the existing sandbox at `src/agent/tools/file/sandbox.ts`. After the change the built-in toolkit contains ONLY bash support plus `tool_help` (`bash_run`, `bash_list_allowed`, `bash_which`, `tool_help`); the file tools are governed by the agent-tools umbrella (`--agent-tools`) and new per-tool flags, exactly mirroring the plan-011 precedent that moved `web_search`/`web_fetch` into the pack as `agt_web_search`/`agt_web_fetch`.

## Scope

- **In scope**
  - Create five first-party `agt_` file wrappers under `src/agent/tools/agent-tools/` (`agt-file-read.ts`, `agt-file-list.ts`, `agt-file-write.ts`, `agt-file-edit.ts`, `agt-file-append.ts`) that REUSE the existing implementations in `src/agent/tools/file/read-tool.ts`, `list-tool.ts`, `write-tool.ts`, `edit-tool.ts`, `append-tool.ts` and the existing sandbox `src/agent/tools/file/sandbox.ts`. No behavior change to the file logic; only the LangChain-visible name and the prompt-registry key change to the `agt_file_*` key.
  - Export the new `AGT_FILE_*_NAME` / `AGT_FILE_*_DESCRIPTION` / `buildAgtFile*Tool` / deps types from the agent-tools barrel `src/agent/tools/agent-tools/index.ts`.
  - Register the five wrappers in `buildAgentToolsGroup` (`src/agent/tools/agent-tools/group-builder.ts`) behind new per-tool flags, with the three mutators (`agt_file_write`/`agt_file_edit`/`agt_file_append`) additionally gated on `cfg.allowMutations`.
  - Remove the five native file tools from the built-in catalog group in `src/agent/tools/registry.ts` (the `readOnly` array's `createFileReadTool`/`createFileListTool` and the entire `mutatingFile` array, plus their imports).
  - Add `agt_file_read`/`agt_file_list`/`agt_file_write`/`agt_file_edit`/`agt_file_append` entries to `BUILTIN_TOOL_PROMPTS` (`src/agent/tools/tool-prompts-builtin.ts`) and REMOVE the old `file_read`/`file_list`/`file_write`/`file_edit`/`file_append` entries; update `BUILTIN_TOOL_NAMES` accordingly (it is derived from the object keys, so it follows automatically).
  - Update `src/agent/system-prompt.ts`: the adaptive built-in block (`buildBuiltinToolsPromptBlock`) must no longer mention the file tools; the `mutatingFile` presence flag and its derivation in `buildSystemPromptForCfg` must be reworked (the built-in block no longer has a mutating-file group). File-tool guidance now rides on the `agt_file_*` descriptions via the agent-tools block (`buildAgentToolsPromptBlock`, a pure projection).
  - Extend the config flag matrix in `src/config/agent-config.ts` (`AgentConfig.agentTools.tools`, `AgentConfigFile.agentTools.tools`, `AgentCliFlags.agentTools.tools`) with `fileRead`, `fileList`, `fileWrite`, `fileEdit`, `fileAppend` booleans; extend `resolveAgentTools` with the five keys and the matching `CLI_AGENT_AGT_FILE_*` env keys; add those env keys to the agt env-key set / `ALL_ENV_KEYS` membership where the existing `CLI_AGENT_AGT_*` keys are listed.
  - Add CLI flags `--enable-agt-file-read` / `--disable-agt-file-read` (and `-file-list`, `-file-write`, `-file-edit`, `-file-append`) in `src/cli.ts`, and map them in `mapAgentToolFlags` (`src/cli-agent-tools-flags.ts`) by extending the `ToolKey` union and the `pairs` table.
  - Re-record the `--help` byte-stability baseline `test_scripts/baselines/help-no-treat-as-tool.txt` (10 new flag rows) after a deliberate diff, and update the `--builtin-tools` / `--no-builtin-tools` help strings to reflect that the built-in toolkit no longer includes file tools.
  - Update tests across `registry.spec.ts`, the plan-008 toggle spec(s), `agent-config.spec.ts`, the agent-tools flag spec, `system-prompt.spec.ts`, `tool-prompts-builtin.spec.ts` (completeness test), and relocate/rename the file-tool unit specs to `agent-tools/agt-file-*.spec.ts` (preserving coverage: sandbox enforcement, read/list/write/edit/append behavior, overlay description resolution, mutation gating).
  - Update docs: `docs/tools/cli-agent.md`, `docs/design/configuration-guide.md`, `docs/design/project-functions.md`, and a dated section in `docs/design/project-design.md`.
  - Produce a plan file `docs/design/plan-012-file-ops-into-agent-tools.md` (next free plan number; verify at plan time) following the plan-011 template.

- **Out of scope**
  - Any behavior change to the file tools themselves (sandbox semantics, byte limits, error codes, `confirmed` gating on mutators, overlay/`mergeProfileToolArgs` plumbing) beyond the rename of the tool name and prompt key.
  - Any consolidation, deduplication, or behavior change to the existing `agt_glob` / `agt_grep` / `agt_multiedit` / `agt_patch` tools. The moved `agt_file_edit` (single find/replace) and `agt_file_list` (plain enumerate) deliberately COEXIST with `agt_glob` / `agt_multiedit`; no merging.
  - Moving `tool_help` — it STAYS in the built-in toolkit with the bash tools.
  - Touching the bash tools (`bash_run`, `bash_list_allowed`, `bash_which`) or their gating.
  - Vendoring upstream agent-tools' read/write/edit/list tools. The project deliberately rejected the upstream deps (`@mozilla/readability`, `jsdom`, `turndown`, `dotenv`); the five wrappers are FIRST-PARTY and reuse the existing first-party file backend — exactly as `agt_web_*` reused the existing web backend (plan-011). No new runtime dependency is added.
  - Editing `LEGACY_DEFAULT_SYSTEM_PROMPTS` in `src/agent/system-prompt.ts` (frozen historical snapshot — MUST NOT be modified).
  - Deleting `src/agent/tools/file/*` if any non-wrapper module still imports the `create*Tool` factories or the sandbox; the planner decides whether the old factories are deleted or retained-and-rewrapped (see Open Questions).

## Requirements

1. **R1 — Five first-party `agt_` file wrappers.** Create `agt-file-read.ts`, `agt-file-list.ts`, `agt-file-write.ts`, `agt-file-edit.ts`, `agt-file-append.ts` under `src/agent/tools/agent-tools/`. Each exports `AGT_FILE_<X>_NAME = 'agt_file_<x>'`, `AGT_FILE_<X>_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_FILE_<X>_NAME]!.description`, a `buildAgtFile<X>Tool(deps)` factory returning a `DynamicStructuredTool`, and a deps type. Each wrapper reuses the existing file logic and the sandbox (`src/agent/tools/file/sandbox.ts`); the only differences from the current `create*Tool` body are `name`/description-key = `agt_file_<x>` and the deps-injection shape chosen by the planner.

2. **R2 — Implementation reuse, not duplication.** The wrappers MUST reuse the existing first-party file logic + sandbox; they MUST NOT vendor or pull upstream read/write/edit/list tools and MUST NOT introduce `@mozilla/readability`, `jsdom`, `turndown`, `dotenv`, or any other new runtime dependency.

3. **R3 — Built-in catalog reduced to bash + tool_help.** After the change, the built-in group assembled in `buildToolCatalog` (`src/agent/tools/registry.ts`) contains ONLY: `bash_list_allowed`, `bash_which`, `tool_help` (always when `builtinTools !== false`) and `bash_run` (only when the allowlist is non-empty). No `file_*` tool is constructed in this group; the `mutatingFile` array and the file-tool imports are removed.

4. **R4 — agt pack registers the five file tools with correct gating.** In `buildAgentToolsGroup` (`src/agent/tools/agent-tools/group-builder.ts`): `agt_file_read` and `agt_file_list` register iff their per-tool flag is true (read-only, NO `allowMutations` gate). `agt_file_write`, `agt_file_edit`, `agt_file_append` register iff their per-tool flag is true AND `cfg.allowMutations === true` (silently dropped when the flag is set but `allowMutations` is off, matching the existing `agt_multiedit`/`agt_patch` rule and the former native `mutatingFile` gating). Each registered tool pushes a `{name, description}` meta entry (via `getToolDescription(overlays, …)`) so the agent-tools prompt block documents it automatically.

5. **R5 — Prompt registry updated.** `BUILTIN_TOOL_PROMPTS` (`src/agent/tools/tool-prompts-builtin.ts`) gains `agt_file_read`/`agt_file_list`/`agt_file_write`/`agt_file_edit`/`agt_file_append` entries (description + per-parameter help copied verbatim from the existing `file_*` entries, including the `[MUTATING] … Requires confirmed: true` text on the mutators) and LOSES the old `file_read`/`file_list`/`file_write`/`file_edit`/`file_append` entries. The registry-completeness test (`tool-prompts-builtin.spec.ts`) — which asserts every name returned by `buildToolCatalog` has an entry — must still pass.

6. **R6 — System prompt no longer describes file tools in the built-in block.** `buildBuiltinToolsPromptBlock` must remove the `file_read / file_list` available-tools bullet, the mutating-file clause, the file-mutation OUT-OF-SCOPE lines, and any read-only-evidence wording that references file output specifically as a built-in concern. The `mutatingFile` presence flag (`BuiltinToolsPresence`) and its derivation in `buildSystemPromptForCfg` (which currently checks `names.has('file_write'|'file_edit'|'file_append')`) must be reworked so the built-in block no longer has a mutating-file group. The `agt_file_*` guidance appears via the agent-tools block when those tools are registered.

7. **R7 — Config flag matrix + env keys.** Add `fileRead`, `fileList`, `fileWrite`, `fileEdit`, `fileAppend` to the three `agentTools.tools` shapes in `src/config/agent-config.ts`; resolve each via `resolveAgentTools`/`resolveOne` with the env keys `CLI_AGENT_AGT_FILE_READ`, `CLI_AGENT_AGT_FILE_LIST`, `CLI_AGENT_AGT_FILE_WRITE`, `CLI_AGENT_AGT_FILE_EDIT`, `CLI_AGENT_AGT_FILE_APPEND`; extend the `resolveOne` `envKey` union and add the five keys to the agt env-key list and `ALL_ENV_KEYS` membership (alongside the existing `CLI_AGENT_AGT_*` keys at `agent-config.ts:827-835`). Defaults: see R12 / Open Questions (preserve current effective behavior).

8. **R8 — CLI flags + mapper.** Register `--enable-agt-file-read` / `--disable-agt-file-read` and the four analogous pairs in `src/cli.ts` (alongside the existing `--enable-agt-*` block at `cli.ts:118-133`), and extend the `ToolKey` union and `pairs` table in `mapAgentToolFlags` (`src/cli-agent-tools-flags.ts:70-86`) with the five keys, reading `enableAgtFileRead`/`disableAgtFileRead` etc. Per-tool enable+disable conflicts and the umbrella conflict must continue to surface as `UsageError` (exit code 2).

9. **R9 — `--builtin-tools` / `--no-builtin-tools` semantics + help text updated.** The help strings for `--builtin-tools` / `--no-builtin-tools` (and the in-code comment block at `registry.ts:51-59`) must be updated to state that the built-in toolkit is now `bash_run` + `bash_list_allowed` + `bash_which` + `tool_help`, and that `--no-builtin-tools` removes ONLY those (file tools are governed by `--agent-tools` / `--disable-agt-file-*`).

10. **R10 — `--help` baseline re-recorded.** `test_scripts/baselines/help-no-treat-as-tool.txt` must be regenerated deliberately (diff first) to include the 10 new flag rows and any changed `--builtin-tools` help text, so `cli-help-baseline.spec.ts` stays green.

11. **R11 — Profile name-based scoping works for the new names.** A profile `tools.deny: [agt_file_write]` (or `tools.allow`, `tools.order`) referencing the new names must work through the existing `applyProfileToolScoping` path with NO special-casing — the names flow through the same post-scoping invariant in `registry.ts`.

12. **R12 — Preserve current effective load behavior under defaults.** With all defaults (built-in on, agent-tools on, no `--allow-mutations`), the same file tools that load today (read + list) must still load (now as `agt_file_read`/`agt_file_list`), and with `--allow-mutations` the three mutators must appear (now as `agt_file_write`/`agt_file_edit`/`agt_file_append`). The per-tool flag defaults must be chosen to honor this (planner to confirm against plan-011 precedent: read-only default-on, mutating default-on-but-mutation-gated).

13. **R13 — Documentation updated.** `docs/tools/cli-agent.md` (file tools now `agt_file_*` in the pack; new per-tool flags; `--no-builtin-tools` no longer affects file tools; `--no-agent-tools` / `--disable-agt-file-*` do), `docs/design/configuration-guide.md` (five new flags/env/config keys + four-tier precedence + defaults), `docs/design/project-functions.md` (functional requirement entry), and a dated section in `docs/design/project-design.md` recording the design decision and citing this refined-request file plus the codebase-scan and plan.

14. **R14 — Plan artifact.** A plan file `docs/design/plan-NNN-file-ops-into-agent-tools.md` (next free `NNN`; plan-011 is the structural template) listing files-to-create / files-to-modify / files-to-delete, the gating table, the test matrix, and the docs touch-list, referencing this refined-request file at the top.

## Constraints

- **TypeScript only**; conform to the existing project conventions and the patterns demonstrated by the `agt_web_*` move (plan-011) and the existing `agt-glob.ts` wrapper.
- **No new runtime dependency** (dependency-vetting rule). The deliberately-rejected upstream deps must not be reintroduced.
- **No-fallback config rule**: do not introduce default substitutes for missing required config. Per-tool flag *defaults* are starting values in the four-tier precedence chain (CLI > env > config.json > default), consistent with how the existing `agt_*` defaults work — this is the documented "default" tier, not a silent fallback for a missing required value.
- **Lockstep invariant**: `tools[i] ↔ meta.registered[i]` for the agt subset must be preserved in `group-builder.ts`, and the post-scoping meta re-derivation in `registry.ts` (`agent-config`/registry lines ~158-168) must continue to filter correctly by surviving name.
- **Frozen artifacts**: `LEGACY_DEFAULT_SYSTEM_PROMPTS` must NOT be edited. Phase artifacts (this refined request, the codebase scan, the plan) are authoritative once produced.
- **Single source of truth for descriptions**: each `AGT_FILE_*_DESCRIPTION` constant must alias `BUILTIN_TOOL_PROMPTS[<name>].description` (one literal per tool), matching every other agt wrapper.
- **Version control**: do not perform any git operation unless the user explicitly requests it.
- **Tooling gate**: this is an extension of the existing `cli-agent` tool, implemented in-repo as source changes — NOT a new project tool, so the `/tool-conventions scaffold` MANDATE does not apply here (the change modifies the cli-agent tool's own internals; its `docs/tools/cli-agent.md` is updated in R13).

## Acceptance Criteria

Each criterion is testable via the project's vitest suite, `--help` output, typecheck, and build.

1. **AC1** — `buildToolCatalog` built-in group contains ONLY `bash_run` (when the allowlist is non-empty), `bash_list_allowed`, `bash_which`, `tool_help` — and NO `file_*` tools. (registry spec)
2. **AC2** — The agt pack registers `agt_file_read`, `agt_file_list`, `agt_file_write`, `agt_file_edit`, `agt_file_append`, with `write`/`edit`/`append` mutation-gated, reusing the existing file logic + sandbox. (group-builder / registry spec)
3. **AC3** — With all defaults and NO `--allow-mutations`: `agt_file_read` and `agt_file_list` are present; `agt_file_write`/`agt_file_edit`/`agt_file_append` are absent; the bash inspection tools (`bash_list_allowed`, `bash_which`) are present. With `--allow-mutations`: the three mutators additionally appear. (registry / toggle spec)
4. **AC4** — `--no-builtin-tools` removes bash + `tool_help` only; the file tools are STILL present (governed by agent-tools). (toggle spec)
5. **AC5** — `--no-agent-tools` removes ALL `agt_*` tools including the five file tools; `bash_*` + `tool_help` are still present. (toggle spec)
6. **AC6** — A profile `tools.deny`/`tools.allow` referencing the new names (`agt_file_write`, etc.) takes effect via name-based scoping with no special-casing. (profile scoping spec)
7. **AC7** — `BUILTIN_TOOL_PROMPTS` has `agt_file_*` entries; the old `file_*` entries are removed; the registry-completeness test passes. (tool-prompts-builtin spec)
8. **AC8** — The system-prompt built-in block no longer mentions the file tools; the agent-tools block documents the `agt_file_*` tools when they are registered (and omits the mutators when `allowMutations` is off). (system-prompt spec)
9. **AC9** — `--help` shows the 10 new flags (`--enable`/`--disable-agt-file-read`/`-list`/`-write`/`-edit`/`-append`); the baseline is re-recorded and `cli-help-baseline.spec.ts` is green.
10. **AC10** — Config resolution honors the five new `CLI_AGENT_AGT_FILE_*` env keys and `config.json` `agentTools.tools.file*` keys with correct four-tier precedence. (agent-config spec)
11. **AC11** — `mapAgentToolFlags` maps the five new flag pairs correctly and still throws `UsageError` on enable+disable conflicts. (flag-mapper spec)
12. **AC12** — Full test suite, typecheck, and build are all green; `pnpm audit` (or the project's audit command) reports no new HIGH-or-above advisory (expected, since no dependency is added).

## Assumptions

- **A1 — plan-011 is the authoritative template.** The web-tools move (`docs/design/plan-011-web-into-agent-tools.md`) is treated as the exact structural precedent; this work mirrors it for the file tools. Basis: the raw request explicitly states "This mirrors plan-011 exactly," and the codebase confirms the parallel structure (`agt-web-search.ts`/`agt-web-fetch.ts`, `group-builder.ts:163-180`, `tool-prompts-builtin.ts:245-269`, `cli.ts:130-133`, env keys at `agent-config.ts:834-835`).
- **A2 — The five file backends + sandbox remain in `src/agent/tools/file/`** and are reused by the wrappers (matching how plan-011 kept `src/agent/tools/web/backends/` and only deleted the thin tool wrappers). Whether the old `create*Tool` factories are deleted, kept, or refactored into a shared helper is a planner decision (Open Questions OQ-1). Basis: raw request says "REUSE the existing implementations in `src/agent/tools/file/*` … and the existing sandbox."
- **A3 — Description/param text is copied verbatim** from the current `file_*` `BUILTIN_TOOL_PROMPTS` entries into the new `agt_file_*` entries (including `[MUTATING] … Requires confirmed: true`), with only the registry key renamed. Basis: plan-011 copied web entries verbatim; raw request says "move all five AS-IS … no behavior change."
- **A4 — Per-tool flag defaults preserve today's effective behavior**: read-only file tools default-on; mutating file tools default-on but mutation-gated (so with defaults + no `--allow-mutations`, read+list load and the mutators do not — identical to today). Basis: plan-011 precedent (`resolveOne(..., true)` for read-only web; `agt_multiedit`/`agt_patch` default-on-but-mutation-gated) and the existing native gating in `registry.ts:62-78`. Flagged for explicit planner confirmation (OQ-2).
- **A5 — Next plan number.** The plan file uses the next free `plan-NNN-` slot (likely `plan-012`); the planner verifies against `docs/design/` at plan time before fixing the number. Basis: highest existing is `plan-011`.
- **A6 — A codebase scan (`docs/reference/codebase-scan-file-ops-to-agt.md`) will precede planning**, per the project's Phase-3 gate, since this touches multiple source files in an existing module. Basis: project `CLAUDE.md` pre-implementation pipeline.
- **A7 — Investigation/technical-research are NOT required.** The approach is fixed by the user and a single in-project precedent (plan-011) already prescribes the pattern. Basis: project skip rule "a single, obvious approach already used in the project satisfies the request … an existing … plan already prescribes the approach."

## Open Questions

These are PLANNER decisions to confirm against the plan-011 precedent during planning. They do not block refinement; record each resolution in the plan and (where it changes scope) re-run the producing phase rather than editing this file silently.

- **OQ-1 — Fate of the existing `src/agent/tools/file/*` `create*Tool` factories.**
  - **Why it matters**: determines whether the wrappers re-implement the body inline (deleting the old factories) or delegate to the retained factories / a shared helper; affects `files_to_delete` in the plan and the deletion of any old `file/*-tool.spec.ts`.
  - **Recommended default**: mirror plan-011 — move the tool body into the new `agt-file-*.ts` wrappers and DELETE the old `read-tool.ts`/`list-tool.ts`/`write-tool.ts`/`edit-tool.ts`/`append-tool.ts` wrappers, KEEPING `sandbox.ts` (and any shared error/`FileError` plumbing) for reuse. Relocate/rename their unit specs to `agent-tools/agt-file-*.spec.ts`. Confirm no other module imports the deleted factories before deletion.

- **OQ-2 — Default on/off for each of the five new per-tool flags.**
  - **Why it matters**: governs which file tools load with defaults; must preserve today's effective behavior (AC3) and read coherently in `--help`.
  - **Recommended default**: `fileRead`/`fileList` default `true` (read-only); `fileWrite`/`fileEdit`/`fileAppend` default `true` but mutation-gated (so they appear only with `--allow-mutations`) — identical net behavior to today and consistent with plan-011's treatment of mutating agt tools. Reflect each default in the `--help` strings (e.g. "default-on; mutation-gated").

- **OQ-3 — Exact env-key list / `ALL_ENV_KEYS` membership wiring for the five `CLI_AGENT_AGT_FILE_*` keys.**
  - **Why it matters**: missing a key in `ALL_ENV_KEYS` (or the `resolveOne` `envKey` union) silently drops the env tier for that tool — a correctness bug not caught by typecheck if the union is widened loosely.
  - **Recommended default**: add all five keys in the SAME places the `CLI_AGENT_AGT_WEB_*` keys appear (`agent-config.ts:827-835` list, the `resolveOne` `envKey` union at `agent-config.ts:1332-1339`, and the per-tool `resolveOne(...)` calls at `agent-config.ts:1352-1360`), and add an `agent-config.spec.ts` assertion that each new key participates in precedence.

## Original Request

> Move the file operations out of the built-in cross-cutting toolkit into the agent-tools (`agt_`) pack, and keep only the bash support in the built-in toolkit.
>
> **Settled decisions (do NOT re-ask; fixed scope/constraints):**
> 1. **Naming**: the five native file tools move into the `agt_` pack by prefixing their current names with `agt_`: `file_read` → `agt_file_read`, `file_list` → `agt_file_list`, `file_write` → `agt_file_write`, `file_edit` → `agt_file_edit`, `file_append` → `agt_file_append`.
> 2. **Overlap handling**: move all five AS-IS. They coexist with the existing `agt_glob` / `agt_grep` / `agt_multiedit` / `agt_patch` (no consolidation, no behavior change to those). The simple single-replace `agt_file_edit` and plain-enumerate `agt_file_list` remain available alongside `agt_glob`/`agt_multiedit`.
> 3. **tool_help placement**: `tool_help` STAYS in the built-in toolkit with the bash tools. After the change the built-in toolkit = `bash_run`, `bash_list_allowed`, `bash_which`, `tool_help` only.
> 4. **Approach (fixed)**: these become FIRST-PARTY members of the `agt_` pack that REUSE the existing implementations in `src/agent/tools/file/*` (read-tool.ts, list-tool.ts, write-tool.ts, edit-tool.ts, append-tool.ts) and the existing sandbox at `src/agent/tools/file/sandbox.ts`. Do NOT vendor upstream agent-tools' read/write/edit/list tools (they pull deps the project deliberately rejected: @mozilla/readability, jsdom, turndown, dotenv). This mirrors plan-011 exactly, which moved the first-party web tools (web_search/web_fetch) into the pack as agt_web_search/agt_web_fetch reusing the existing web backend.
>
> **Authoritative context already verified in this codebase (cite as needed; do not contradict):**
> - Catalog assembly: `src/agent/tools/registry.ts` `buildToolCatalog(cfg, logger)` builds two independent groups. Built-in group (lines ~60-83): readOnly = file_read, file_list, bash_list_allowed, bash_which, tool_help; mutatingFile (only if cfg.allowMutations) = file_write, file_edit, file_append; bashRun (only if allowlist non-empty) = bash_run. Gated by `cfg.builtinTools !== false`.
> - agt pack assembly: `src/agent/tools/agent-tools/group-builder.ts` `buildAgentToolsGroup(cfg, policy)`; gated by `cfg.agentTools.enabled` umbrella + per-tool flags in `cfg.agentTools.tools`. Mutating agt tools (agt_multiedit, agt_patch) additionally require `cfg.allowMutations`. Each registered tool emits a `{name, description}` meta entry consumed by `buildAgentToolsPromptBlock` (a pure projection).
> - agt barrel: `src/agent/tools/agent-tools/index.ts` exports each wrapper's `AGT_*_NAME`, `AGT_*_DESCRIPTION`, `buildAgt*Tool`, deps type.
> - Prompt registry: `src/agent/tools/tool-prompts-builtin.ts` `BUILTIN_TOOL_PROMPTS` holds entries for BOTH built-in and agt_ tools (currently has file_read/file_list/file_write/file_edit/file_append and agt_glob/agt_grep/agt_multiedit/agt_patch/agt_todo_read/agt_todo_write/agt_web_search/agt_web_fetch). A registry-completeness test asserts every catalog tool name has an entry.
> - System prompt: `src/agent/system-prompt.ts` builds an adaptive built-in block (`buildBuiltinToolsPromptBlock`, plan-009/010) describing EXACTLY the registered built-in tools. The file tools are currently described there; after the move the built-in block describes only bash + tool_help, and the file tools' guidance rides on their agt_ descriptions via the agent-tools block. NOTE: `LEGACY_DEFAULT_SYSTEM_PROMPTS` is a frozen historical snapshot — must NOT be edited.
> - Config: `src/config/agent-config.ts` — `cfg.agentTools.tools` is a flag matrix resolved by `resolveAgentTools` (per-tool default true/false, env keys like CLI_AGENT_AGT_GLOB). plan-011 added webSearch/webFetch keys + CLI_AGENT_AGT_WEB_* env keys as the template to follow.
> - CLI flags: `src/cli.ts` registers `--enable-agt-<name>` / `--disable-agt-<name>` per tool; `src/cli-agent-tools-flags.ts` `mapAgentToolFlags` maps them. `--help` baseline at `test_scripts/baselines/help-no-treat-as-tool.txt` is byte-stability tested by `src/cli-help-baseline.spec.ts` (must be re-recorded for new flags).
> - Precedent doc: `docs/design/plan-011-web-into-agent-tools.md` is the step-by-step template for this exact kind of move.
>
> **Open design points the spec should flag for the planner (do NOT resolve by asking the user):**
> - Default on/off for each moved file tool's per-tool flag (precedent: read-only default-on; mutating default-on but mutation-gated). Preserve current effective behavior.
> - New env keys (CLI_AGENT_AGT_FILE_READ etc.) and config-file keys under agentTools.tools.
> - Mutation gating for agt_file_write/agt_file_edit/agt_file_append must require cfg.allowMutations (matching today's mutatingFile gating).
> - Consequence to document: after the move, `--no-builtin-tools` removes ONLY bash + tool_help; `--no-agent-tools` (or per-tool disables) removes the file tools. This changes the meaning of `--no-builtin-tools` and must be reflected in the `--builtin-tools`/`--no-builtin-tools` help strings + baseline and docs.
>
> **Acceptance criteria the spec must make explicit and testable**: [as enumerated in Acceptance Criteria above].
>
> **Output**: slug `file-ops-to-agt`; write to `docs/reference/refined-request-file-ops-to-agt.md`.
