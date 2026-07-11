# Refined Request: CLI Mode Simplification (`--mode` + generic per-tool flags)

## Category
Development

## Objective
Simplify the cli-agent CLI option surface by (1) introducing a single `--mode` option with the enum values `chat | basic | tool | composite` that replaces the three tool-group toggle flag pairs as the primary way to select which tool groups load, (2) keeping `--allow-mutations` unchanged as the orthogonal read-only/read-write axis, and (3) collapsing the per-tool `--enable-agt-*` / `--disable-agt-*` flag pairs into one generic, repeatable pair `--enable-tool <name>` / `--disable-tool <name>` keyed by canonical registered tool names. The default mode is `composite`, so a flagless invocation remains byte-identical in behavior to today.

## Scope

### In scope
- New `--mode <chat|basic|tool|composite>` CLI option on the default command (`src/cli.ts`).
- Full four-surface resolution for mode: CLI flag `--mode` > layered env `CLI_AGENT_MODE` (shell > `~/.tool-agents/cli-agent/.env` > local `.env`) > profile `cliParams.mode` > `config.json` key `mode` > default `composite` — i.e. the **pinnable-knob** chain (tier-5 `cliParams` insertion pattern, `src/config/agent-config.ts` ~1056–1092), NOT the group-toggle chain (`resolveToolGroupToggle`, ~1476–1489) where config.json outranks the profile.
- Mode → tool-group mapping (baseline the mode sets before any fine-grained overrides):

  | Mode | builtinTools | agentTools | composites |
  |---|---|---|---|
  | `chat` | OFF | OFF | OFF |
  | `basic` | OFF | ON | OFF |
  | `tool` | ON | ON | OFF |
  | `composite` (default) | ON | ON | ON |

- New generic repeatable pair `--enable-tool <name>` / `--disable-tool <name>` taking canonical registered tool names (e.g. `agt_web_fetch`, `agt_todo_write`), replacing the per-tool `--enable-agt-*` / `--disable-agt-*` flag pairs currently registered in `src/cli.ts` (~lines 118–143).
- Validation rules (all UsageError, exit 2, fail-fast):
  - invalid `--mode` value;
  - `--tool <name>` combined with effective mode `chat` or `basic` (no builtin toolkit → no `bash_run` → wrapped CLIs cannot execute);
  - unknown name passed to `--enable-tool` / `--disable-tool`;
  - the same name passed to both `--enable-tool` and `--disable-tool` (mirrors the existing `--enable-agt-x`/`--disable-agt-x` conflict precedent).
- Deprecation/removal of the three group-toggle flag pairs (`--builtin-tools/--no-builtin-tools`, `--agent-tools/--no-agent-tools`, `--composites/--no-composites`) from the primary CLI surface (severity per Open Question 1).
- Deprecation/removal of the per-tool `--enable-agt-*` / `--disable-agt-*` flags (same severity decision, Open Question 1).
- New TUI slash command `/mode [chat|basic|tool|composite]` that rebuilds the tool catalog in place, mirroring the existing `/allow-mutations` implementation (`src/tui/slash/allow-mutations.ts`).
- Conscious re-recording of the help byte-stability baseline (`src/cli-help-baseline.spec.ts` against `test_scripts/baselines/help-no-treat-as-tool.txt`) to capture the new, smaller help surface.
- Profile schema update: add `mode` to `ProfileCliParamsSchema` / `KNOWN_CLI_PARAMS` (`src/config/profile-schema.ts`); config-file schema update: add top-level `mode` key.
- Documentation updates: `docs/tools/cli-agent.md`, `docs/guides/agent-competency-levels.md` (present modes as the primary interface), `docs/guides/enabling-write-capabilities.md` (light touch), `docs/design/configuration-guide.md`, `docs/design/project-functions.md` (FRs), `docs/design/project-design.md`, `README.md`.
- Update `Issues - Pending Items.md`: the "[LOW] Profile tier sits at different precedence positions for pinnable knobs vs tool-group toggles" item is addressed for the primary surface by `--mode` resolving as a pinnable knob; move/annotate the item accordingly.

### Out of scope
- Any change to `--allow-mutations` and its surfaces (`AGENT_ALLOW_MUTATIONS` env, `config.json` `allowMutations`, profile `cliParams.allowMutations`) — it stays unchanged as the orthogonal axis.
- Any change to `--tool <name>` itself (wrapped-CLI declaration, auto-allowlisting, capability discovery) beyond the new mode-compatibility validation.
- Any change to the per-tool env vars (`CLI_AGENT_AGT_*`) or `config.json` `agentTools.tools.*` keys — they stay unchanged.
- Any change to mutation-gating semantics: `agt_file_write/edit/append`, `agt_multiedit`, `agt_patch` still require `--allow-mutations` regardless of enable flags.
- A fifth mode value (e.g. `shell` for builtin-ON/agentTools-OFF) — explicitly not added (see Open Question 3).
- Changes to the composite-synthesis flag family (`--treat-as-tool`, `--composite-name`, etc.), providers, bash allowlist, introspection knobs, or the TUI beyond the new `/mode` command.
- Reworking the legacy group-toggle env vars / config keys / profile keys' own precedence chain (their fate is Open Question 2; the recommended default keeps them as-is).

## Requirements

### Functional
1. **FR-MODE-1** — `--mode <value>` is registered on the default command; accepted values are exactly `chat`, `basic`, `tool`, `composite`. Any other value raises UsageError (exit 2) before any agent work starts.
2. **FR-MODE-2** — The effective mode sets the three tool-group baselines per the mapping table above, feeding the same downstream consumers as today (`buildToolCatalog` in `src/agent/tools/registry.ts`, `buildAgentToolsGroup` in `src/agent/tools/agent-tools/group-builder.ts`).
3. **FR-MODE-3** — Mode resolves through the pinnable-knob chain: CLI `--mode` > layered env `CLI_AGENT_MODE` > profile `cliParams.mode` > `config.json` `mode` > default `composite`. An env/config/profile value outside the enum raises ConfigurationError (strict validation, no fallback), consistent with `parseAgentToolsBoolEnvVar` behavior.
4. **FR-MODE-4** — Default mode is `composite`: an invocation with no mode set on any surface loads all three groups exactly as today (byte-for-byte behavioral equivalence for flagless invocations).
5. **FR-MODE-5** — `--tool <name>` combined with an effective mode of `chat` or `basic` raises UsageError (exit 2) with a message directing the user to `--mode tool` or `--mode composite`.
6. **FR-MODE-6** — `--mode chat` reproduces the already-supported empty-toolset state: stderr notice, plain conversational LLM, no tools registered.
7. **FR-TOOLFLAG-1** — `--enable-tool <name>` and `--disable-tool <name>` are repeatable and accept canonical registered tool names of the agt_* pack (`agt_glob`, `agt_grep`, `agt_multiedit`, `agt_patch`, `agt_todo_read`, `agt_todo_write`, `agt_web_search`, `agt_web_fetch`, `agt_file_read`, `agt_file_list`, `agt_file_write`, `agt_file_edit`, `agt_file_append`). They occupy the same CLI-flag tier in `resolveAgentTools` (`src/config/agent-config.ts` ~1362–1451) that the per-tool flags occupy today.
8. **FR-TOOLFLAG-2** — Unknown tool name → UsageError (exit 2) listing valid names; same name in both `--enable-tool` and `--disable-tool` → UsageError (exit 2).
9. **FR-TOOLFLAG-3** — Per-tool env vars (`CLI_AGENT_AGT_*`) and `config.json` `agentTools.tools.*` keys are untouched and continue to resolve exactly as today beneath the CLI-flag tier.
10. **FR-DEPREC-1** — The three group-toggle flag pairs and the per-tool `--enable-agt-*`/`--disable-agt-*` flags are removed from the primary `--help` surface, with runtime treatment per the resolution of Open Question 1.
11. **FR-TUI-1** — A `/mode [chat|basic|tool|composite]` TUI slash command changes the session's effective mode and rebuilds the tool catalog in place, mirroring the structure, argument validation, and feedback style of `src/tui/slash/allow-mutations.ts`. `/mode` with no argument reports the current mode (mirroring the existing pattern's status behavior).
12. **FR-GATE-1** — Mutation gating is unchanged: mutation-gated tools require `--allow-mutations` regardless of mode or `--enable-tool` flags (gating stays downstream in the catalog/group builders, not in the resolver).
13. **FR-DOC-1** — All in-scope documents are updated to present `--mode` + `--allow-mutations` + `--enable-tool`/`--disable-tool` as the primary interface, with the legacy fine-grained surfaces documented per the Open Question resolutions. FRs are registered in `docs/design/project-functions.md`; the design change lands in `docs/design/project-design.md`.

### Non-functional
14. **NFR-1 (behavior preservation)** — A flagless invocation is byte-identical in behavior to the pre-change binary (same tool catalog, same system prompt sections, same stderr output).
15. **NFR-2 (help baseline)** — The help byte-stability guard (NFR-CMP-001) is preserved: `test_scripts/baselines/help-no-treat-as-tool.txt` is consciously re-recorded once to the new surface, and `src/cli-help-baseline.spec.ts` passes against it. Commander registration keeps the established quirks (defaults omitted from `.option(...)` to avoid `(default: …)` help drift; manual `-h, --help` registration preserved).
16. **NFR-3 (test suite)** — The full existing test suite passes; new behavior (mode mapping, four-surface resolution, all UsageError paths, `/mode` command) is covered by new unit tests following existing spec-file conventions.
17. **NFR-4 (fail-fast, no fallback)** — All new validation failures are UsageError exit 2 before agent startup; invalid values on any config surface throw (no silent defaulting). The `composite` default is a documented optional-knob starting value in the style of the existing group toggles' `default(true)`, not a fallback for missing required config.

## Constraints
- TypeScript throughout; follow existing module, naming, and spec-file conventions.
- Commander v12 specifics in `src/cli.ts` must be preserved (disabled auto-help, manual `-h, --help`, help-byte-stream discipline; see comments at `src/cli.ts:60–76` and `:155–160`).
- The precedence chains are load-bearing: `--mode` must use the pinnable-knob chain (tier-5 `cliParams` insertion), intentionally diverging from `resolveToolGroupToggle`'s chain — this divergence is the designed resolution of the registered [LOW] precedence-asymmetry item.
- Established design decisions listed in this spec (mode mapping, spelling `composite`, default `composite`, `--tool` conflict rule, generic flag names, unchanged mutation gating, `/mode` command) are settled — do not re-open them during planning/implementation.
- No version-control operations unless explicitly requested.
- Phase artifacts are authoritative; scope changes require re-running the producing subagent.

## Acceptance Criteria
1. `cli-agent --mode composite <prompt>` and a flagless `cli-agent <prompt>` produce the same tool catalog and behavior as the pre-change flagless invocation (verified by a catalog-composition test and/or existing registry specs).
2. `cli-agent --mode chat <prompt>` runs with zero tools, emits the empty-toolset stderr notice, and answers conversationally.
3. `cli-agent --mode basic` registers only agt_* tools; `--mode tool` registers builtin + agt_* but no composites; group membership matches the mapping table (unit tests per mode).
4. `CLI_AGENT_MODE`, profile `cliParams.mode`, and `config.json` `mode` each set the mode when higher tiers are absent, and each is outvoted by the tier above it (resolution-order unit tests, mirroring existing pinnable-knob tests in `src/config/agent-config.spec.ts`).
5. `cli-agent --mode chat --tool git` and `cli-agent --mode basic --tool git` exit with code 2 and a UsageError naming the conflict; the same happens when the chat/basic mode comes from env/profile/config.
6. `cli-agent --enable-tool agt_todo_write` turns on a default-off tool; `--disable-tool agt_grep` turns off a default-on tool; unknown names and enable+disable of the same name exit 2 with UsageError.
7. Mutation-gated tools remain absent without `--allow-mutations` even when explicitly enabled via `--enable-tool` (e.g. `--enable-tool agt_file_write` without `--allow-mutations` does not register the tool).
8. In the TUI, `/mode basic` rebuilds the catalog in place (verified by a slash-command spec mirroring the `/allow-mutations` tests); `/mode` with an invalid value reports an error without changing state.
9. `cli-agent --help` no longer lists the three group-toggle pairs nor the per-tool `--enable-agt-*`/`--disable-agt-*` flags; the re-recorded baseline test passes byte-exact.
10. The legacy flags behave per the resolved Open Question 1 (hidden-alias + stderr notice, hard removal, or fully visible), verified by a dedicated test.
11. `npm run build` succeeds and the full `vitest` suite passes with zero failures.
12. All seven in-scope documents are updated and consistent (a grep sweep finds no remaining presentation of the group toggles as the primary interface); `Issues - Pending Items.md` reflects the precedence-asymmetry item's resolution.

## Assumptions
- **Effective-mode conflict check**: the `--tool` vs chat/basic UsageError applies to the *effective resolved* mode from any surface, not only the CLI flag. Basis: fail-fast principle — a config-supplied `chat` mode is equally unable to execute wrapped CLIs; the error message tells the user to pass `--mode tool`/`--mode composite` explicitly.
- **`--enable-tool` does not override the mode's group baseline**: per-tool flags express intent *within* the agt_* pack; if the effective mode (or the advanced fine-grained layer) turns the agentTools umbrella off, `--enable-tool <agt_*>` does not resurrect the group. Basis: the raw request keeps per-tool semantics unchanged (pure flag-surface rename), and current `buildAgentToolsGroup` semantics are umbrella-off-wins.
- **Flag count discrepancy**: the raw request says "28 per-tool flags"; `src/cli.ts:118–143` currently registers 13 pairs (26 flags). The spec covers *all* per-tool `--enable-agt-*`/`--disable-agt-*` pairs present at implementation time, whatever the exact count.
- **`/mode` is session-scoped**: the TUI slash command changes the running session only and persists nothing to config/profile, mirroring `/allow-mutations`.
- **Tool-name spelling for the generic flags**: canonical registered names with underscores (`agt_web_fetch`), not the flag-style hyphens (`agt-web-fetch`). Basis: the raw request's examples.
- **Open Question defaults hold until overridden**: planning may proceed against the recommended defaults below; if the user picks a different option, only the affected requirement (FR-DEPREC-1 / documentation of the advanced layer / mode enum size) changes.

## Open Questions
1. **Question**: Deprecation severity for the subsumed flags (the 3 group-toggle pairs and the per-tool `--enable-agt-*`/`--disable-agt-*` flags)?
   **Why it matters**: determines whether existing scripts break immediately (hard removal), keep working for one release (hidden aliases + stderr deprecation notice), or the help surface stays cluttered (fully visible) — it changes FR-DEPREC-1's implementation, the baseline contents, and the migration notes in every in-scope doc.
   **Recommended default**: remove them from `--help` but keep them parsing and working for one release as hidden aliases, emitting a one-line stderr deprecation notice when used.
   *(Alternatives: (b) remove outright — UsageError on use; pre-1.0 so breaking is acceptable; (c) keep fully visible alongside the new surface.)*

2. **Question**: Do the legacy group-toggle *env vars* (`CLI_AGENT_DISABLE_BUILTIN_TOOLS` / `CLI_AGENT_DISABLE_AGENT_TOOLS` / `CLI_AGENT_DISABLE_COMPOSITES`), `config.json` keys (`builtinTools` / `composites` / `agentTools.enabled`), and profile keys (`tools.builtin` / `tools.composites` / `tools.agentTools`) also get deprecated in favor of mode equivalents, or stay indefinitely as the advanced fine-grained layer overriding the mode baseline?
   **Why it matters**: decides whether postures the four modes cannot express (e.g. shell-only = mode `tool` + agentTools off) remain reachable, and whether the resolver keeps two layers (mode baseline + fine-grained overrides) or collapses to one.
   **Recommended default**: they stay indefinitely, documented as advanced overrides applied on top of the mode baseline — this preserves postures mode alone cannot express.

3. **Question**: Does "shell-only" (builtin ON, agentTools OFF — Level 1 in `docs/guides/agent-competency-levels.md`) deserve its own fifth mode value (e.g. `shell`)?
   **Why it matters**: a fifth value changes the enum on all four surfaces, the `/mode` command, help text, docs, and the competency-ladder mapping; without it, Level 1 is reached via the advanced overrides of Open Question 2.
   **Recommended default**: no fifth value; keep exactly the four user-specified modes (`chat | basic | tool | composite`).

### Resolutions (recorded by the orchestrator at the open-questions gate, 2026-07-03; user-selected via AskUserQuestion)

1. **RESOLVED — remove outright.** The three group-toggle flag pairs and the 28 per-tool `--enable-agt-*`/`--disable-agt-*` flags are removed entirely: they no longer appear in `--help` and passing any of them raises `UsageError` (exit 2) with a migration hint pointing at `--mode` / `--enable-tool` / `--disable-tool`. FR-DEPREC-1 and AC-10 apply in their hard-removal reading. Pre-1.0 breakage accepted.
2. **RESOLVED — deprecate the legacy keys too.** The group-toggle env vars (`CLI_AGENT_DISABLE_BUILTIN_TOOLS` / `CLI_AGENT_DISABLE_AGENT_TOOLS` / `CLI_AGENT_DISABLE_COMPOSITES`), `config.json` keys (`builtinTools` / `composites` / `agentTools.enabled`), and profile keys (`tools.builtin` / `tools.composites` / `tools.agentTools`) are removed as group controls: `--mode` / `CLI_AGENT_MODE` / `mode` (config.json) / `cliParams.mode` (profile) become the ONLY tool-group control. Per the project's no-silent-fallback convention, a set legacy env var or a present legacy config/profile key raises `ConfigurationError` (profiles via the strict schema) with a migration hint — never silently ignored. Note the accepted consequence: group-level "shell-only" is no longer expressible; the nearest equivalent is `--mode tool` plus per-tool `--disable-tool agt_*` entries (the per-tool `CLI_AGENT_AGT_*` env vars and `agentTools.tools.*` config keys remain in scope-unchanged force).
3. **RESOLVED — four modes only** (`chat | basic | tool | composite`); no `shell` value.

## References
- **Key code locations**: `src/cli.ts` (option registration, ~78–181); `src/config/agent-config.ts` (`loadAgentConfig` tier-5 `cliParams` insertion ~1056–1092, `resolveAgentTools` ~1362–1451, `resolveToolGroupToggle` ~1476–1489); `src/config/profile-schema.ts` (`ProfileCliParamsSchema` / `KNOWN_CLI_PARAMS` ~82, `tools.builtin/composites/agentTools` ~44–49); `src/agent/tools/agent-tools/group-builder.ts` (`buildAgentToolsGroup`); `src/agent/tools/registry.ts` (`buildToolCatalog`); `src/tui/slash/allow-mutations.ts` (slash-command pattern to mirror); `src/cli-help-baseline.spec.ts` + `test_scripts/baselines/help-no-treat-as-tool.txt` (help baseline, NFR-CMP-001).
- **Related pending item**: `Issues - Pending Items.md` — "[LOW] Profile tier sits at different precedence positions for pinnable knobs vs tool-group toggles" (its suggested fix anticipates exactly this `--mode` design).
- **Docs in scope**: `docs/tools/cli-agent.md`, `docs/guides/agent-competency-levels.md`, `docs/guides/enabling-write-capabilities.md`, `docs/design/configuration-guide.md`, `docs/design/project-functions.md`, `docs/design/project-design.md`, `README.md`.

## Original Request
> Simplify cli-agent's CLI option surface by introducing a single `--mode` option with values `chat | basic | tool | composite`, keeping `--allow-mutations` as the orthogonal read-only/read-write axis, and collapsing the 28 per-tool `--enable-agt-*` / `--disable-agt-*` flags into one generic repeatable pair `--enable-tool <name>` / `--disable-tool <name>`. The three tool-group toggle flag pairs (`--builtin-tools/--no-builtin-tools`, `--agent-tools/--no-agent-tools`, `--composites/--no-composites`) are subsumed by `--mode` and should be deprecated/removed from the primary CLI surface.

### Established design context (agreed in the originating conversation — treated as given)
- Mode → tool-group mapping: chat = builtin OFF, agentTools OFF, composites OFF; basic = agentTools ON only; tool = builtin ON + agentTools ON, composites OFF; composite = all three ON.
- `--allow-mutations` stays unchanged as a separate flag (with `AGENT_ALLOW_MUTATIONS` env, config.json `allowMutations`, profile `cliParams.allowMutations`).
- Spelling is `composite` (not "composit").
- `--tool <name>` (wrapped CLIs) stays; it is only meaningful in `tool`/`composite` modes; using `--tool` with mode chat/basic must raise UsageError (exit 2, fail-fast) because without the builtin toolkit there is no `bash_run` to execute wrapped CLIs.
- `--mode` gets the full four-surface treatment (CLI flag, `CLI_AGENT_MODE` env, config.json `mode`, profile `cliParams.mode`), resolved like a pinnable knob (CLI > env(layered .env tiers) > profile > config.json > default), intentionally eliminating the existing precedence asymmetry between pinnable knobs and group toggles (registered as a [LOW] item in "Issues - Pending Items.md").
- Default mode = `composite` (byte-for-byte preserves today's default behavior where all three groups load). No behavior change for flagless invocations.
- Generic per-tool pair: `--enable-tool <name>` / `--disable-tool <name>`, repeatable, taking the canonical registered tool name (e.g. `agt_web_fetch`, `agt_todo_write`). Unknown names raise UsageError. Passing both enable and disable for the same name raises UsageError. The per-tool env vars (`CLI_AGENT_AGT_*`) and config.json `agentTools.tools.*` keys stay unchanged.
- Mutation gating semantics unchanged: mutation-gated tools (agt_file_write/edit/append, agt_multiedit, agt_patch) still require `--allow-mutations` regardless of enable flags.
- TUI: add a `/mode [chat|basic|tool|composite]` slash command that rebuilds the tool catalog in place, mirroring the existing `/allow-mutations` implementation (`src/tui/slash/allow-mutations.ts`).
- The help output is guarded by a byte-stability baseline test (NFR-CMP-001, `src/cli-help-baseline.spec.ts` against `test_scripts/baselines/help-no-treat-as-tool.txt`); any help change requires consciously re-recording the baseline.
- Documentation in scope: `docs/tools/cli-agent.md`, `docs/guides/agent-competency-levels.md` (present modes as the primary interface), `docs/guides/enabling-write-capabilities.md` (light touch), `docs/design/configuration-guide.md`, `docs/design/project-functions.md` (FRs), `docs/design/project-design.md`, `README.md`.
