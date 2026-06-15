---
status: approved
plan_number: 008
slug: tool-loading-toggles
based_on_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
approach: lightweight (design note + implement, user-confirmed)
naming_decision: "cross-cutting toolkit toggle = --no-builtin-tools (user-chosen, avoids overlap with the agt_* 'standard tools' wording)"
files_to_modify:
  - src/agent/tools/registry.ts
  - src/config/agent-config.ts
  - src/config/profile-schema.ts
  - src/cli.ts
  - test_scripts/baselines/help-no-treat-as-tool.txt
  - docs/tools/cli-agent.md
  - docs/design/configuration-guide.md
  - docs/design/project-functions.md
  - docs/design/project-design.md
files_to_create:
  - src/agent/tools/registry-toggles.spec.ts
---

# Plan 008 — Tool-loading toggles (composites + built-in tools), via CLI flags and profile

## Goal
Let the user suppress whole groups of tools at session build time, through **both** CLI flags and configuration profiles (and, for consistency, env vars + `config.json`). Two independent, net-new umbrella toggles, plus profile support for the existing agent-tools umbrella.

## The three toggles (independent per group, per user decision)

| Group | Members | Default | New surface |
|---|---|---|---|
| **Composites** | every virtual/composite tool (`loadVirtualToolsSync`) | loaded | CLI `--no-composites`/`--composites`, env `CLI_AGENT_DISABLE_COMPOSITES`, `config.json` `composites`, profile `tools.composites` |
| **Built-in tools** (cross-cutting toolkit) | `file_read/list/write/edit/append`, `web_search/fetch`, `bash_list_allowed/which/run`, `tool_help` (i.e. `readOnly` + `mutatingFile` + `bashRunTools`) | loaded | CLI `--no-builtin-tools`/`--builtin-tools`, env `CLI_AGENT_DISABLE_BUILTIN_TOOLS`, `config.json` `builtinTools`, profile `tools.builtin` |
| **Agent-tools pack** (`agt_*`) | `agt_glob/grep/multiedit/patch/todo_read/todo_write` | loaded | **already** has CLI `--no-agent-tools` + env + `config.json`; **add** profile `tools.agentTools` |

## Resolution precedence (uniform for all three)
`CLI flag  >  env var  >  config.json  >  profile  >  built-in default (load)`

Mirrors the existing `resolveAgentTools` chain (`agent-config.ts:1201`), with a **profile tier inserted just above the default**, applied uniformly to all three toggles (including a new profile tier added to `resolveAgentTools`). The "disable" env vars follow the existing inverted convention (`CLI_AGENT_DISABLE_*` truthy ⇒ group OFF), matching `CLI_AGENT_DISABLE_AGENT_TOOLS`.

## No-fallback rule
These are optional booleans whose **documented default is the current behaviour (load)** — exactly like the existing `agentTools` umbrella (default `true`) and `allowMutations` (default `false`). A documented optional-toggle default is **not** a substituted value for a missing *required* setting, so the project's no-fallback rule is not triggered. (No new required config is introduced.)

## Where it lands (code)

1. **`src/agent/tools/registry.ts` — `buildToolCatalog`** (the gate):
   - Built-in toolkit: when `cfg.builtinTools === false`, `readOnly`, `mutatingFile`, and `bashRunTools` are each `[]` (skip building them).
   - Composites: call `loadVirtualToolsSync` only when `cfg.composites !== false`; otherwise skip (no virtual handles).
   - Agent-tools pack already gated inside `buildAgentToolsGroup` via `cfg.agentTools.enabled` — only the *profile* value needs to flow into `cfg.agentTools` (see resolver change).
   - Profile `tools.{allow,deny,order}` scoping still runs afterward, unchanged (per-id deny continues to work on whatever survived the umbrellas).
   - If the final catalog is empty, emit one stderr notice (no error).

2. **`src/config/agent-config.ts`** (plumbing, mirroring `agentTools`):
   - `AgentCliFlags`: add `composites?: boolean`, `builtinTools?: boolean`.
   - `AgentConfigFile`: add `composites?: boolean`, `builtinTools?: boolean`.
   - `AgentConfig`: add resolved `composites: boolean`, `builtinTools: boolean` (required, always present).
   - `loadAgentConfig`: add a `resolveToolGroupToggle(cliFlag, disableEnvKey, configVal, profileVal, default=true)` helper (CLI>env>config>profile>default, inverted-disable env) for `composites` and `builtinTools`; pass the active profile's `tools.composites` / `tools.builtin`. Extend `resolveAgentTools` with the profile tier (`tools.agentTools`).
   - `OTHER_ENV_KEYS`: add `CLI_AGENT_DISABLE_COMPOSITES`, `CLI_AGENT_DISABLE_BUILTIN_TOOLS`.

3. **`src/config/profile-schema.ts`** — extend `ProfileToolsSchema` (`{allow,deny,order}`, `.strict()`) with `composites?: boolean`, `builtin?: boolean`, `agentTools?: boolean`. All tool-loading config now lives under the `tools` sub-tree.

4. **`src/cli.ts`** — register `--composites`/`--no-composites` and `--builtin-tools`/`--no-builtin-tools` on the default agent command (Commander `--no-*` ⇒ `opts.x === false`); map both into the `AgentCliFlags` literal. `--no-agent-tools` already exists.

## Behaviour notes (documented)
- **`--no-builtin-tools` removes `bash_run`**, which is how the agent executes *wrapped* CLIs — so with built-in tools off, the agent can act only through composites and the agent-tools pack (if those remain on).
- **An empty toolset is permitted** (all groups off, no wrapped CLI): the agent degrades to a plain conversational LLM. No error (the umbrella path is distinct from profile-scoping's empty-survivor error E7, which still applies to `allow`/`deny`). A one-line stderr notice is emitted.
- Resolved once at catalog-build time, like every other catalog decision.

## Tests (`src/agent/tools/registry-toggles.spec.ts` + config specs)
- `buildToolCatalog` with `builtinTools:false` ⇒ no `file_*`/`web_*`/`bash_*`/`tool_help`; `composites:false` ⇒ no virtual tools; each independent of `agentTools`.
- Resolution precedence CLI > env > config.json > profile > default for each toggle (incl. the new `agentTools` profile tier).
- Profile `tools.composites/builtin/agentTools` accepted; unknown still rejected (strict).
- Empty-catalog path emits the notice, raises no error.
- `--help` baseline re-recorded for the 4 new flag rows (deliberate, per plan-007 discipline).

## Docs
`docs/tools/cli-agent.md` (flags + behaviour + bash caveat), `docs/design/configuration-guide.md` (new variables, precedence, defaults; reserve "standard tools" wording fix — `agt_*` is consistently "the agent-tools pack"), `docs/design/project-functions.md` (FRs), `docs/design/project-design.md` (dated section).
