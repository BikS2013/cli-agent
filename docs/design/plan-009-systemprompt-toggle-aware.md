---
status: approved
plan_number: 009
slug: systemprompt-toggle-aware
based_on_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
approach: lightweight (design note + implement, user-confirmed)
completes: plan-008 (tool-loading toggles) — closes the gap where --no-builtin-tools dropped the schemas but not the system-prompt prose
decision: "Conditional blocks + slim default (user-chosen). Built-in-tool instructions become a runtime-injected conditional block gated on cfg.builtinTools; the seeded default base prompt is slimmed to the generic agent identity; unmodified legacy default prompts are upgraded in place by exact-match; customized prompts are left untouched (documented)."
files_to_modify:
  - src/agent/system-prompt.ts
  - src/config/agent-config.ts
  - docs/tools/cli-agent.md
  - docs/design/configuration-guide.md
  - docs/design/project-functions.md
  - docs/design/project-design.md
files_touch_tests:
  - src/agent/system-prompt.spec.ts
  - src/config/agent-config.spec.ts
---

# Plan 009 — Make the system prompt tool-loading-aware (slim base + conditional built-in-tools block)

## Problem (gap left by plan-008)
plan-008 gates the **bound tool schemas** (`--no-builtin-tools` ⇒ no `file_*`/`web_*`/`bash_*` schemas) but NOT the **system prompt prose**. The built-in-toolkit instructions (the `bash_run` framing, `CORE RULES`, `OUT-OF-SCOPE`, and the "three general-purpose tools" paragraph) are baked into the base prompt (`BUILTIN_DEFAULT_SYSTEM_PROMPT`, seeded to `~/.tool-agents/cli-agent/capabilities/system-prompt.md`) and loaded verbatim by `buildSystemPrompt`. So with `--no-builtin-tools` the model is still TOLD about tools it cannot call. (`--no-agent-tools` is already coherent — its block is conditional; `--no-composites` is already coherent — composite info rides on the bound-tool description, which plan-008 gates.)

## Fix — mirror the existing conditional-block pattern
The `agt_*` block and the wrapped-CLI capabilities section are already runtime-injected conditional blocks. Do the same for the built-in toolkit:

1. **`src/agent/system-prompt.ts`**
   - **Slim `BUILTIN_DEFAULT_SYSTEM_PROMPT`** down to the generic agent identity + generic conduct (no `bash_run`/`file_*`/`web_*`/`tool_help` specifics). Keep it short and tool-agnostic.
   - **Add `BUILTIN_TOOLS_PROMPT_BLOCK`** (a self-framed string, leading `\n\n`) carrying the moved content, reworded to read as a standalone `## Built-in tools` section (the `bash_run` framing + CORE RULES + OUT-OF-SCOPE + the three-tools paragraph), and **`buildBuiltinToolsPromptBlock(builtinTools: boolean): string`** returning the block when `builtinTools !== false`, else `''`.
   - **Extend `buildSystemPrompt`** with a `builtinTools: boolean` parameter (default `true` for backward-compat). Injection order: `base` → **built-in-tools block (if on)** → `capabilitiesSection` → `agent-tools block` → `custom`. (The block goes right after the base, before the wrapped-CLI capabilities, since it's the core tool framing.)
   - **Extend `buildSystemPromptForCfg`**: add `builtinTools: boolean` to its `cfg` param type and forward it. (`AgentConfig.builtinTools` already exists from plan-008.)
   - **Keep `LEGACY_DEFAULT_SYSTEM_PROMPTS: readonly string[]`** = `[ <the exact current full default text> ]` for migration detection (array so future default revisions can be appended).

2. **`src/config/agent-config.ts` — `bootstrapAgentDir` migration**
   - Where it seeds `system-prompt.md` if absent (~line 553-570): ADD an in-place upgrade — if the file EXISTS and its content is **byte-exactly equal to any entry in `LEGACY_DEFAULT_SYSTEM_PROMPTS`** (i.e. an unmodified prior default), overwrite it with the new slim `BUILTIN_DEFAULT_SYSTEM_PROMPT` (mode `0600`). If the content differs at all (user-customized, or already the new slim default) → leave it untouched. This safely upgrades unmodified defaults without ever clobbering user edits. (Still NOT a runtime fallback — a missing/unreadable file still raises `UsageError`.)

3. **Callers** (`src/agent/run.ts`): the `buildSystemPromptForCfg(cfg, capSection, agentToolsMeta)` call sites pass `cfg` already; just ensure `cfg.builtinTools` is included in the object handed in (it is part of `AgentConfig`). Find sites with `find_referencing_symbols`.

## Reconstruction & byte-stability
This is a **deliberate restructuring of the default prompt** (like re-recording a baseline). The split need NOT be byte-identical to the old default; author the slim base + block to read cleanly. Update `system-prompt.spec.ts` to assert the NEW default content and the new composition (the block present when on, absent when off). For an unmodified-default install the *net* prompt (with built-in tools on) changes only cosmetically; with built-in tools off it now correctly omits the built-in instructions.

## Customized-prompt behaviour (documented)
The built-in-tools block is injected on top of whatever base is on disk (same as the `agt_*` block today). For the **default** (or migrated) base — which is now slim — there is no duplication. For a **user-customized** base that still contains old tool prose, the injected block could duplicate it; this is the user's content to manage, exactly as a user who pasted tool descriptions into their prompt would already see with the `agt_*` block. Documented in the tool doc + config guide.

## Edge case (note, not in scope)
`--no-builtin-tools` removes `bash_run`, so the wrapped-CLI capabilities section's "available via bash_run" framing is moot in that combination (using `--no-builtin-tools` with `--tool <wrapped CLI>` is self-defeating). Left as-is for this fix; noted in Issues - Pending Items.md as a minor follow-up.

## Tests
- `system-prompt.spec.ts`: `buildSystemPrompt(..., builtinTools=false)` ⇒ assembled prompt contains NONE of `bash_run` / `file_read` / `web_search` / "three general-purpose tools"; `builtinTools=true` ⇒ the built-in block IS present; default (param omitted) ⇒ present. New default content asserted. `buildSystemPromptForCfg` reads `cfg.builtinTools`.
- `agent-config.spec.ts`: bootstrap upgrades a system-prompt.md whose content equals a `LEGACY_DEFAULT_SYSTEM_PROMPTS` entry; leaves a user-modified file byte-unchanged; leaves an already-slim file unchanged. (Temp HOME isolation, per existing specs.)
- End-to-end: a `cfg` with `builtinTools:false` produces an assembled prompt with no built-in tool instructions.

## Docs
`docs/tools/cli-agent.md` + `docs/design/configuration-guide.md`: note that `--no-builtin-tools` now ALSO removes the built-in tool instructions from the system prompt; describe the slim default + the in-place upgrade of unmodified defaults + the customized-prompt caveat. `project-functions.md` (FR), `project-design.md` (dated section).
