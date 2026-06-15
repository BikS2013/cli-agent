---
status: approved
plan_number: 010
slug: builtin-block-adaptive
based_on_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
approach: lightweight (design note + implement, user-confirmed)
refines: plan-009 (the `## Built-in tools` block was static; make it describe exactly the registered built-in tools)
problem: "The built-in-tools prompt block statically describes bash_run and file_write/edit/append even when they are NOT bound (bash_run needs a non-empty allowlist; mutating-file tools need --allow-mutations). The inspector shows the prompt over-promising vs the bound schemas."
files_to_modify:
  - src/agent/system-prompt.ts
  - src/agent/run.ts
  - src/tui/slash/resume.ts
  - src/tui/slash/allow-mutations.ts
  - src/tui/slash/new.ts
  - src/tui/slash/provider.ts
  - src/tui/slash/tools.ts
  - src/tui/slash/model.ts
  - docs/tools/cli-agent.md
  - docs/design/configuration-guide.md
  - docs/design/project-functions.md
  - docs/design/project-design.md
files_touch_tests:
  - src/agent/system-prompt.spec.ts
---

# Plan 010 — Make the `## Built-in tools` prompt block describe exactly the registered tools

## Why
plan-009 made the *whole* built-in block conditional on `cfg.builtinTools`, but inside it the prose is static: it always describes `bash_run` and `file_write`/`file_edit`/`file_append`. Those two groups are gated by OTHER session config:
- `bash_run` is registered only when the command allowlist is non-empty (`registry.ts`: `parseAllowlistEntries(cfg.bash.allow).length > 0`).
- `file_write`/`file_edit`/`file_append` are registered only with `--allow-mutations` (`cfg.allowMutations`).
So with an empty allowlist + no mutations (the common case), the prompt promises `bash_run` and mutating-file tools the model cannot call. Make the block describe **exactly** the registered built-in tools.

## Design — derive the block from the registered tool NAMES (drift-free)
Every `buildSystemPromptForCfg(cfg, capSection, agentToolsMeta)` call site (10 of them: `run.ts` ×4, `tui/slash/{resume,allow-mutations,new,provider,tools,model}.ts`) already has the final `tools` array from `buildToolCatalog` in scope. Pass it in and derive presence from the real bound set (this also respects profile `deny` of a built-in).

1. **`src/agent/system-prompt.ts`**
   - Add the 4th param to `buildSystemPromptForCfg`: `registeredTools: ReadonlyArray<{ name: string }>`. Compute the name set inside.
   - Replace `buildBuiltinToolsPromptBlock(builtinTools: boolean)` with `buildBuiltinToolsPromptBlock(p: { builtinTools: boolean; bashRun: boolean; mutatingFile: boolean }): string`. Returns `''` when `!builtinTools`. Otherwise assembles the block from composable, gated sections (below).
   - `buildSystemPrompt(...)`: change the 5th param from `builtinTools: boolean` to the same `{ builtinTools, bashRun, mutatingFile }` presence object (default `{ builtinTools: true, bashRun: true, mutatingFile: true }` for backward-compat so omitting it = today's full block). Inject `buildBuiltinToolsPromptBlock(p)` in the same position (after base, before capabilities).
   - In `buildSystemPromptForCfg`, compute: `const names = new Set(registeredTools.map(t => t.name)); const builtinTools = cfg.builtinTools !== false; const bashRun = names.has('bash_run'); const mutatingFile = names.has('file_write') || names.has('file_edit') || names.has('file_append');` and forward `{ builtinTools, bashRun, mutatingFile }`.

2. **The 10 call sites** — pass the in-scope `tools` array as the new 4th arg: `buildSystemPromptForCfg(cfg, capSection, agentToolsMeta, tools)`.

## Adaptive block content (gated sections)
Header (always when builtinTools on):
> `## Built-in tools`
> You have a set of built-in tools this session; their JSON schemas are bound to you separately. Use them as described below.

Command execution:
- **bashRun ON:** "You act on the user's machine through the bash_run tool, which executes only the specific allow-listed binaries the user has permitted — never arbitrary shell." + CORE RULES 1 (call bash_list_allowed first…) and the `bash_run requires confirmed: true` rule.
- **bashRun OFF:** "No local commands are allow-listed in this session, so bash_run is not available — you cannot run binaries on the user's machine. If a task needs one, tell the user which binary to allow-list." (and OMIT the two bash_run CORE RULES.)

General CORE RULES (always, when builtinTools on): capability-docs/tool_help, read-only-evidence/no-secret-echo, error-JSON handling, `__truncated` handling, never-invent-URLs.

Available tools list (always describe the read-only built-ins that are present — file_read/file_list, web_search/web_fetch, bash_list_allowed/bash_which, tool_help):
- file_read/file_list line — append the mutating clause **only if mutatingFile**: "file_write / file_edit / file_append can modify files — use them only when the user has asked for a file change."
- bash line — include `/ bash_run` and "run allow-listed local commands…" **only if bashRun**; otherwise "inspect which local commands are allow-listed (currently none) and resolve binary paths on PATH."

OUT-OF-SCOPE:
- shell-features line **only if bashRun**.
- file-modification line adapts: mutatingFile ON ⇒ "modify files only when the user asked (file_write/edit/append enabled)"; OFF ⇒ "cannot modify files (file_write/edit/append disabled; pass --allow-mutations to enable)".
- web line always.

## Tests (`system-prompt.spec.ts`)
- `buildBuiltinToolsPromptBlock({builtinTools:true, bashRun:false, mutatingFile:false})` ⇒ contains NO "bash_run", NO "file_write"/"file_edit"/"file_append", but DOES contain file_read/web_search/bash_list_allowed/tool_help and the "no local commands are allow-listed" note.
- `{bashRun:true, mutatingFile:true}` ⇒ contains the bash_run framing + the mutating-file clause.
- `{builtinTools:false,...}` ⇒ `''`.
- `buildSystemPromptForCfg` derives presence from the `registeredTools` arg: pass `[{name:'file_read'},{name:'bash_list_allowed'}]` (no bash_run) ⇒ assembled prompt has no bash_run framing; pass a set including `bash_run`+`file_write` ⇒ it does.
- Update the existing block assertions (deliberate, like a baseline) and the 10 call sites' specs if any assert the prompt.

## Docs
`docs/tools/cli-agent.md` + `configuration-guide.md`: the built-in-tools section of the system prompt now adapts to the actually-registered tools — `bash_run` framing appears only with a non-empty allowlist; the mutating-file tools are described only with `--allow-mutations`. `project-functions.md` (FR), `project-design.md` (dated section).

## Note
This finally makes the inspector's "Bound tool schemas" and the system-prompt tool prose agree for the built-in toolkit across all gates (umbrella toggle, allowlist, --allow-mutations, profile deny).
