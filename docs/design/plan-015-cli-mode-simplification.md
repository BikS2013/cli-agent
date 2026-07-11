---
status: complete
plan_number: 015
slug: cli-mode-simplification
request_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/refined-request-cli-mode-simplification.md
investigation_file: null
research_files: []
codebase_scan_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/codebase-scan-cli-mode-simplification.md
based_on_commit: 2b523cdce357d7c33f831b04b80bf49667795f52
scan_commit_match: true
steps: 21
open_questions: 0
files_to_create:
  - src/config/mode.ts
  - src/cli-removed-flags.ts
  - src/config/agent-config-mode.spec.ts
  - src/cli-agent-tools-flags.spec.ts
  - src/cli-removed-flags.spec.ts
  - src/tui/slash/mode.ts
  - src/tui/slash/mode.spec.ts
files_to_modify:
  - src/config/agent-config.ts
  - src/config/profile-schema.ts
  - src/config/profile-codec.ts
  - src/cli-agent-tools-flags.ts
  - src/cli.ts
  - src/config/agent-config.spec.ts
  - src/config/profile-schema.spec.ts
  - src/config/profile-codec.spec.ts
  - src/cli.spec.ts
  - src/tui/index.ts
  - src/commands/profile/dry-run.ts
  - src/commands/profile/dry-run.spec.ts
  - src/agent/system-prompt.ts
  - src/agent/system-prompt.spec.ts
  - test_scripts/verify-no-tools-notice.ts
  - test_scripts/baselines/help-no-treat-as-tool.txt
  - test_scripts/baselines/help-no-treat-as-tool.sha256
  - docs/tools/cli-agent.md
  - docs/design/configuration-guide.md
  - docs/guides/agent-competency-levels.md
  - docs/guides/enabling-write-capabilities.md
  - README.md
  - docs/design/project-functions.md
  - docs/design/project-design.md
  - Issues - Pending Items.md
implementation_units:
  - name: U1-core-config-cli
    steps: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]
    files:
      - src/config/mode.ts
      - src/config/profile-schema.ts
      - src/config/agent-config.ts
      - src/cli-agent-tools-flags.ts
      - src/cli-removed-flags.ts
      - src/cli.ts
      - src/config/profile-codec.ts
      - src/config/agent-config.spec.ts
      - src/config/agent-config-mode.spec.ts
      - src/cli-agent-tools-flags.spec.ts
      - src/cli-removed-flags.spec.ts
      - src/config/profile-schema.spec.ts
      - src/config/profile-codec.spec.ts
      - src/cli.spec.ts
  - name: U2-tui-mode-command
    steps: [12, 13]
    files:
      - src/tui/slash/mode.ts
      - src/tui/index.ts
      - src/tui/slash/mode.spec.ts
  - name: U3-profile-dry-run-knob
    steps: [14]
    files:
      - src/commands/profile/dry-run.ts
      - src/commands/profile/dry-run.spec.ts
  - name: U4-no-tools-messaging
    steps: [15]
    files:
      - src/agent/system-prompt.ts
      - src/agent/system-prompt.spec.ts
      - test_scripts/verify-no-tools-notice.ts
  - name: U5-help-baseline
    steps: [16]
    files:
      - test_scripts/baselines/help-no-treat-as-tool.txt
      - test_scripts/baselines/help-no-treat-as-tool.sha256
  - name: U6-docs
    steps: [17, 18, 19, 20]
    files:
      - docs/tools/cli-agent.md
      - docs/design/configuration-guide.md
      - docs/guides/agent-competency-levels.md
      - docs/guides/enabling-write-capabilities.md
      - README.md
      - docs/design/project-functions.md
      - docs/design/project-design.md
      - Issues - Pending Items.md
  - name: U7-integration-verify
    steps: [21]
    files: []
build_command: npm run build
test_command: vitest run
created_at: 2026-07-03T00:00:00Z
---

# Plan 015 — CLI Mode Simplification (`--mode` + generic `--enable-tool`/`--disable-tool`)

## Objective

Replace the three tool-group toggle flag pairs and the 13 per-tool `--enable-agt-*`/`--disable-agt-*` pairs (32 flags total, `src/cli.ts:110-143`) with a single pinnable `--mode <chat|basic|tool|composite>` knob plus one generic repeatable pair `--enable-tool <name>`/`--disable-tool <name>`. Per the RESOLVED Open Questions, the legacy flags AND the legacy env vars / `config.json` keys / profile keys are hard-removed: using any of them fails fast (`UsageError` exit 2 for flags, `ConfigurationError` for env/config/profile) with a migration hint. Default mode is `composite`, so a flagless invocation is byte-identical in behavior to today.

## Context

- Refined request (authoritative scope, FRs, ACs, resolved OQs): @docs/reference/refined-request-cli-mode-simplification.md
- Codebase scan (module map, In-Scope/Out-of-Scope classification, build/test commands): @docs/reference/codebase-scan-cli-mode-simplification.md
- No investigation or research files exist for this request (approach fully settled in the refined request's "Established design context" and OQ resolutions).

Approach: `--mode` resolves through the pinnable-knob chain (CLI `--mode` > layered env `CLI_AGENT_MODE` > profile `cliParams.mode` > `config.json` `mode` > default `composite`), following the tier-5 `cliParams` insertion pattern demonstrated for `provider` at `src/config/agent-config.ts:1058-1063`. The resolved mode expands into the three internal group booleans (`cfg.builtinTools`, `cfg.composites`, `cfg.agentTools.enabled`), which REMAIN the internal `AgentConfig` representation consumed by `buildToolCatalog` (`src/agent/tools/registry.ts`) and `buildAgentToolsGroup` (`src/agent/tools/agent-tools/group-builder.ts`) — both Out-of-Scope, untouched. Mapping: chat = none; basic = agentTools only; tool = builtin + agentTools; composite = all three.

**Settled design decisions this plan encodes (do not re-open):**

1. **No new `mode` field on `AgentConfig`.** The scan (Notes §5) warns that a required `AgentConfig.mode` field ripples through 23+ spec files with local `makeCfg`/`baseCfg` fixture builders. It is avoidable: (a) the `--tool` × chat/basic conflict check runs inside `loadAgentConfig` where the resolved mode is a local variable; (b) `/mode` display derives the mode from the three group booleans — after this change the mode mapping is the ONLY producer of that triple, so exactly the four mode combinations are reachable and the derivation is exact; (c) `profile-dry-run` re-resolves knobs from the raw surfaces itself (`buildKnobResolvers`), not from `AgentConfig`. A pure `deriveModeFromGroups` helper (Step 1) serves consumers (b). The fixture ripple is therefore zero.
2. **Removed-flag rejection needs an explicit argv pre-scan.** Verified: with the 32 options unregistered, Commander errors with "unknown option" — but the top-level `program.parseAsync(...).catch(...)` handler (`src/cli.ts`, bottom) writes `Fatal: ...` and exits **1**, and carries no migration hint. That violates FR-DEPREC-1 (UsageError, exit 2, migration hint). So an explicit pre-scan over `process.argv.slice(2)` (mirroring `detectPresence`, `src/cli-composite-flags.ts:96-122`) runs BEFORE `program.parseAsync`, throwing `UsageError` with the hint (Steps 5-6).
3. **TUI `/mode` applies the same `--tool` conflict rule**: switching to `chat`/`basic` while wrapped tools (`c.cfg.tools`) are loaded is rejected with an error message and no state change. This extends the refined request's recorded assumption ("the conflict check applies to the *effective resolved* mode from any surface") to the TUI surface.
4. **Profile legacy-key rejection gets a friendly message via a raw-object pre-check in `parseProfile`** (`src/config/profile-codec.ts:79-97`), because `.strict()` alone would reject the removed `tools.*` keys with a generic Zod "unrecognized key" message lacking the migration hint.
5. **Flag count correction:** the scan says "29 `.option(...)` calls"; the verified count at `src/cli.ts:110-143` is 32 (6 group-toggle flags + 26 per-tool flags). The plan uses 32.

## Open Questions

none — all three Open Questions in the refined request are RESOLVED (hard removal of flags; hard removal of legacy env/config/profile group keys; four modes only). Decisions 1-4 above are planner defaults fully derivable from the artifacts and the caller's directives.

## Steps

### Step 1 — Create the mode module `src/config/mode.ts`

- **depends_on:** —
- **files:** `src/config/mode.ts` (create)
- **action:** Create a small dependency-free module (may import only `src/errors.ts`) exporting: `AGENT_MODES` (readonly tuple `['chat','basic','tool','composite']`), type `AgentMode`, `isAgentMode(v: unknown): v is AgentMode`, `modeToGroups(mode: AgentMode): { builtinTools: boolean; composites: boolean; agentToolsEnabled: boolean }` implementing the mapping table (chat=F/F/F, basic=F/F/T, tool=T/F/T, composite=T/T/T in builtin/composites/agentTools order), `deriveModeFromGroups(groups): AgentMode` (inverse mapping; throws a plain `Error` with an "internal invariant violation" message for the four unreachable combinations — unreachable by construction since only the mode mapping produces the triple), `parseModeFlag(raw: unknown): AgentMode | undefined` (undefined passthrough; invalid value throws `UsageError` listing the four valid values), and a `MODE_MIGRATION_HINT` string constant used by every legacy-rejection error site (pointing at `--mode` / `CLI_AGENT_MODE` / config `mode` / profile `cliParams.mode` and `--enable-tool`/`--disable-tool`). NodeNext ESM: import specifiers end in `.js`. Doc-comment referencing plan-015.
- **verify:** `npx tsc --noEmit -p tsconfig.build.json`
- **done:** File exists, exports listed symbols, build typecheck clean.

### Step 2 — Additive profile-schema changes (`cliParams.mode`, `KNOWN_CLI_PARAMS`)

- **depends_on:** —
- **files:** `src/config/profile-schema.ts` (modify)
- **action:** In `ProfileCliParamsSchema` (`src/config/profile-schema.ts:21-32`) add `mode: z.enum(['chat','basic','tool','composite']).optional()`. Add `'mode'` to `KNOWN_CLI_PARAMS` (`:82-91`). Do NOT touch `ProfileToolsSchema` yet (Step 7 — keeps `src/config/agent-config.ts` compiling until Step 3 removes its references). `emitUnknownCliParamWarnings` (`src/config/profile-loader.ts:242-259`) needs no change.
- **verify:** `npx tsc --noEmit -p tsconfig.json && vitest run src/config/profile-schema.spec.ts` (existing tests still green — nothing removed yet).
- **done:** A profile with `cliParams.mode: tool` parses; `mode` is a known cliParams key.

### Step 3 — Rewire `src/config/agent-config.ts`: `resolveMode`, mode→groups, legacy-surface rejection, `--tool` conflict

- **depends_on:** 1, 2
- **files:** `src/config/agent-config.ts` (modify)
- **action:** The core change, all in one file (WHAT, not code):
  1. **`AgentConfigFile`** (`:105-172`): remove `builtinTools?`/`composites?` (`:156-157`) and `agentTools.enabled?` (`:128`; keep the whole `agentTools.tools` sub-tree `:129-146` unchanged); add `mode?: string`.
  2. **`AgentCliFlags`** (`:328-393`): remove `composites?`/`builtinTools?` (`:392-393`) and the `agentTools.enabled?` member (`:366`); add `mode?: string` (raw, pre-validated by `parseModeFlag` in `src/cli.ts`).
  3. **Env keys:** add `CLI_AGENT_MODE` to `OTHER_ENV_KEYS` (`:842-895`). KEEP `CLI_AGENT_DISABLE_COMPOSITES`/`CLI_AGENT_DISABLE_BUILTIN_TOOLS`/`CLI_AGENT_DISABLE_AGENT_TOOLS` in the list (re-comment as "legacy — presence rejected") so the layered snapshot still surfaces them for the rejection check.
  4. **`resolveMode`** (new function, tier-5 pinnable pattern per `provider` at `:1058-1063`): `flags.mode ?? layered['CLI_AGENT_MODE'] ?? activeProfileData?.cliParams?.mode ?? configFile?.mode ?? 'composite'`; validate the winning env/config value with `isAgentMode`, throwing `ConfigurationError` naming the surface and valid values (profile tier is already Zod-validated by Step 2; CLI tier already validated in `src/cli.ts`). The `'composite'` default is a documented optional-knob starting value (NFR-4), not a fallback for missing required config.
  5. **Legacy rejection** in `loadAgentConfig` (`:970-1280`), after the layered env and final `configFile` are available: (a) if any of the three `CLI_AGENT_DISABLE_*` env vars is set (any value) → `ConfigurationError` with `MODE_MIGRATION_HINT`; (b) re-read the raw config object (cast `configFile` to `Record<string, unknown>` or check inside `readConfigFile`, `:807`) — presence of `builtinTools`, `composites`, or `agentTools.enabled` → `ConfigurationError` with the hint. Never silently ignore (project no-fallback convention).
  6. **Mode→groups:** replace the two `resolveToolGroupToggle` calls (`:1263-1276`) with values from `modeToGroups(mode)`; delete `resolveToolGroupToggle` (`:1476-1489`) entirely. In `resolveAgentTools` (`:1362-1451`): delete the umbrella branch (`:1377-1394`) and the `profileEnabled` parameter; `enabled` becomes a new parameter fed from `modeToGroups(mode).agentToolsEnabled`; the per-tool `resolveOne` closure (`:1400-1424`) and the `CLI_AGENT_AGT_*` / `agentTools.tools.*` tiers stay byte-identical (FR-TOOLFLAG-3). Update the call site (`:1253-1258`).
  7. **`--tool` conflict (FR-MODE-5):** after mode resolution and the tools merge (`:1096-1097`), if effective mode is `chat` or `basic` AND the merged wrapped-tools list is non-empty → `UsageError` directing to `--mode tool` or `--mode composite`. This placement catches env/profile/config-supplied modes, not just the CLI flag.
- **verify:** `npx tsc --noEmit -p tsconfig.build.json` (spec files intentionally break until Step 8; the build config excludes them).
- **done:** `resolveToolGroupToggle` gone; `resolveMode` present; build-config typecheck clean; grep confirms no remaining reference to `flags.composites`/`flags.builtinTools` in `src/` non-spec files.

### Step 4 — Rewrite `mapAgentToolFlags` as the generic `--enable-tool`/`--disable-tool` mapper

- **depends_on:** 3
- **files:** `src/cli-agent-tools-flags.ts` (modify)
- **action:** Replace the 13-pair table (`:74-94`) and per-pair argv-scan conflict loop (`:98-114`) in `mapAgentToolFlags` (`:45-128`). New behavior: read `opts['enableTool']` and `opts['disableTool']` (string arrays from Commander's repeatable collector); validate every name against the canonical 13-name map `agt_glob→glob, agt_grep→grep, agt_multiedit→multiedit, agt_patch→patch, agt_todo_read→todoRead, agt_todo_write→todoWrite, agt_web_search→webSearch, agt_web_fetch→webFetch, agt_file_read→fileRead, agt_file_list→fileList, agt_file_write→fileWrite, agt_file_edit→fileEdit, agt_file_append→fileAppend` (export the map for spec cross-checking against the `AGT_*_NAME` constants in `src/agent/tools/agent-tools/*.ts`); unknown name → `UsageError` listing all valid names; same name in both arrays → `UsageError` (mirrors the removed enable/disable conflict precedent); duplicates within one array are harmless. Output keeps the return type `AgentCliFlags['agentTools'] | undefined` (now without `enabled`): `{ tools: { <camelKey>: true|false, ... } }`, `undefined` when both arrays are empty. No argv re-scan needed anymore — the two options are distinct, so Commander does not collapse them.
- **verify:** `npx tsc --noEmit -p tsconfig.build.json`
- **done:** Mapper compiles against the new `AgentCliFlags` shape; exported name map covers exactly the 13 canonical names.

### Step 5 — Create `src/cli-removed-flags.ts` (legacy-flag argv pre-scan)

- **depends_on:** 1
- **files:** `src/cli-removed-flags.ts` (create)
- **action:** New module (convention mirror of `src/cli-composite-flags.ts`) exporting `rejectRemovedLegacyFlags(argv: readonly string[]): void`. It scans exact tokens for the 32 removed flags — `--composites`, `--no-composites`, `--builtin-tools`, `--no-builtin-tools`, `--agent-tools`, `--no-agent-tools`, and `--enable-agt-X`/`--disable-agt-X` for X ∈ {glob, grep, multiedit, patch, todo-read, todo-write, web-search, web-fetch, file-read, file-list, file-write, file-edit, file-append} — and throws `UsageError` naming the offending flag with `MODE_MIGRATION_HINT` (group flags → `--mode`; per-tool flags → `--enable-tool <name>`/`--disable-tool <name>`). Exact-token matching (the flags are boolean, no `=value` form); accepted precedent for value-position false positives per `detectPresence` (`src/cli-composite-flags.ts:96-122`).
- **verify:** `npx tsc --noEmit -p tsconfig.build.json`
- **done:** Function exists, covers all 32 flags, throws `UsageError` (exit-code-2 class per `src/errors.ts:99`).

### Step 6 — Update `src/cli.ts`: remove 32 options, register `--mode` + generic pair, wire pre-scan and action handler

- **depends_on:** 3, 4, 5
- **files:** `src/cli.ts` (modify)
- **action:**
  1. Delete the 32 legacy `.option(...)` calls (`:109-143`, including the two section comments).
  2. Register `--mode <mode>` (description mentions the four values and env `CLI_AGENT_MODE`; per NFR-2, do NOT pass a Commander default value — state "default: composite" inside the description text only) and `--enable-tool <name>` / `--disable-tool <name>` using the existing `collectTool` collector with `[] as string[]` default (proven baseline-safe by `--tool` at `:83`).
  3. Call `rejectRemovedLegacyFlags(process.argv.slice(2))` BEFORE `program.parseAsync(process.argv)` at the bottom of the file, wrapped in a try/catch replicating `handleErrors`' `CliAgentError` branch (write `Error [<code>]: <message>` via `redactString` to stderr, `process.exit(e.exitCode)`) — the existing `.catch` on `parseAsync` exits 1 and must not be the path for this error.
  4. Action handler (`:182-269`): validate `opts['mode']` via `parseModeFlag` (UsageError on bad value, FR-MODE-1); keep `mapAgentToolFlags(opts)` call (`:228`, now reading the new arrays); in the `runAgentCommand` payload drop `composites`/`builtinTools` (`:264-265`) and add `mode`. Preserve the Commander v12 quirks verbatim: `helpOption(false)` (`:76`), manual `-h, --help` (`:181`), no defaults in `.option(...)` for help-visible flags.
- **verify:** `npx tsc --noEmit -p tsconfig.build.json && npm run build && node dist/cli.js --no-composites; test $? -eq 2` and `node dist/cli.js --enable-agt-glob; test $? -eq 2` (both print a migration hint mentioning `--mode` / `--enable-tool`), and `node dist/cli.js --mode bogus x 2>&1 | grep -qi 'chat'` with exit 2.
- **done:** `node dist/cli.js --help` shows `--mode`, `--enable-tool`, `--disable-tool` and none of the 32 removed flags; removed flags exit 2 with hint.

### Step 7 — Remove profile group keys; add codec migration pre-check

- **depends_on:** 3
- **files:** `src/config/profile-schema.ts` (modify), `src/config/profile-codec.ts` (modify)
- **action:** Remove `composites`/`builtin`/`agentTools` from `ProfileToolsSchema` (`src/config/profile-schema.ts:47-49`), keeping `.strict()` (`:51`) so they are rejected. In `parseProfile` (`src/config/profile-codec.ts:79-97`), before `ProfileSchema.safeParse`, scan the raw object: if `raw.tools` contains any of the three removed keys, throw `ConfigurationError` with an actionable message naming the key and `MODE_MIGRATION_HINT` (→ `cliParams.mode`), instead of letting the generic Zod "unrecognized key" message surface.
- **verify:** `npx tsc --noEmit -p tsconfig.build.json` (profile-schema.spec.ts breaks intentionally until Step 10).
- **done:** A profile containing `tools: { builtin: false }` fails to parse with a `ConfigurationError` whose message mentions `cliParams.mode`.

### Step 8 — Rewrite `src/config/agent-config.spec.ts`; create `src/config/agent-config-mode.spec.ts`

- **depends_on:** 3, 4, 6, 7
- **files:** `src/config/agent-config.spec.ts` (modify), `src/config/agent-config-mode.spec.ts` (create)
- **action:** In `agent-config.spec.ts` (heaviest rewrite, ~60 legacy hits per the scan): delete/replace tests of the umbrella CLI/env/config/profile paths of `resolveAgentTools`, the full `resolveToolGroupToggle` chain, and all `AgentCliFlags.composites`/`builtinTools` fixture usages; keep the per-tool tier tests (`CLI_AGENT_AGT_*`, `agentTools.tools.*`) feeding the flag tier via the new `{ tools: {...} }` shape. In the new `agent-config-mode.spec.ts` (dedicated file per the scan's New Integration Points recommendation; vitest, mirroring the existing pinnable-knob test conventions in `agent-config.spec.ts`): (a) five-tier resolution order for mode — CLI beats env beats profile `cliParams.mode` beats config `mode` beats default `composite` (AC-4); (b) mode→groups mapping for all four modes (AC-1/AC-3) including flagless default = composite = all three groups on; (c) invalid `CLI_AGENT_MODE`/config `mode` value → `ConfigurationError` (FR-MODE-3); (d) `--tool` × effective chat/basic → `UsageError`, covering mode sourced from flag, env, profile, and config (AC-5); (e) legacy env vars set → `ConfigurationError` with migration hint; legacy config keys present (`builtinTools`, `composites`, `agentTools.enabled`) → `ConfigurationError` with migration hint (Resolution 2).
- **verify:** `vitest run src/config/agent-config.spec.ts src/config/agent-config-mode.spec.ts && npx tsc --noEmit -p tsconfig.json`
- **done:** Both spec files green; full-project typecheck (including specs) clean.

### Step 9 — Create specs for the generic mapper and the removed-flag pre-scan

- **depends_on:** 4, 5
- **files:** `src/cli-agent-tools-flags.spec.ts` (create), `src/cli-removed-flags.spec.ts` (create)
- **action:** `cli-agent-tools-flags.spec.ts`: valid enable/disable names map to the correct camelCase keys; unknown name → `UsageError` whose message lists all 13 valid names (AC-6); same name in both → `UsageError`; empty arrays → `undefined`; cross-check the exported name map against the `AGT_*_NAME` constants imported from `src/agent/tools/agent-tools/*.ts` so canonical-name drift is impossible. `cli-removed-flags.spec.ts`: each of the 32 removed flags throws `UsageError` with a hint mentioning `--mode` (group flags) or `--enable-tool` (per-tool flags); a clean argv (including `--mode tool --enable-tool agt_glob`) does not throw (AC-10).
- **verify:** `vitest run src/cli-agent-tools-flags.spec.ts src/cli-removed-flags.spec.ts`
- **done:** Both new spec files green.

### Step 10 — Update profile schema/codec specs

- **depends_on:** 2, 7
- **files:** `src/config/profile-schema.spec.ts` (modify), `src/config/profile-codec.spec.ts` (modify)
- **action:** In `profile-schema.spec.ts:108-150`: flip the acceptance tests for `tools.composites`/`tools.builtin`/`tools.agentTools` to rejection assertions (schema failure), and add acceptance tests for `cliParams.mode` with each of the four values plus rejection of an invalid enum value. In `profile-codec.spec.ts`: add tests that `parseProfile` on a profile containing each legacy `tools.*` key throws `ConfigurationError` whose message includes the migration hint (mentions `cliParams.mode`), and that a profile with `cliParams: { mode: 'basic' }` round-trips.
- **verify:** `vitest run src/config/profile-schema.spec.ts src/config/profile-codec.spec.ts`
- **done:** Both spec files green with flipped/new assertions.

### Step 11 — Update `src/cli.spec.ts`

- **depends_on:** 2, 6
- **files:** `src/cli.spec.ts` (modify)
- **action:** Add `'mode'` to the `required` array in the "KNOWN_CLI_PARAMS contains the required plan-005 keys" test (`src/cli.spec.ts:89-106`). Update the smoke-import assertions around `mapAgentToolFlags` (`:33-38`) if they reference the old per-pair surface.
- **verify:** `vitest run src/cli.spec.ts`
- **done:** Spec green; `mode` asserted as a known cliParams key.

### Step 12 — Create the TUI `/mode` slash command

- **depends_on:** 1, 3
- **files:** `src/tui/slash/mode.ts` (create), `src/tui/index.ts` (modify)
- **action:** New `SlashCommand` mirroring `src/tui/slash/allow-mutations.ts` (read its full 42 lines as the template). Behavior: `/mode` with no arg → `printSystem` the current mode via `deriveModeFromGroups({ builtinTools: c.cfg.builtinTools, composites: c.cfg.composites, agentToolsEnabled: c.cfg.agentTools.enabled })` plus usage text; invalid arg → error message, no state change (AC-8); target `chat`/`basic` while `c.cfg.tools.length > 0` → error message directing to `/mode tool` or `/mode composite`, no state change (Decision 3, FR-MODE-5 parity); valid arg → clone `cfg` with `modeToGroups(arg)` applied to `composites`/`builtinTools` and `agentTools: { ...c.cfg.agentTools, enabled: ... }`, then rebuild `llm`/`tools`/`systemPrompt`/`agentGraph` exactly as `allow-mutations.ts:24-36` does (`createLLM`, `buildToolCatalog`, `composeCapabilitiesSystemPrompt`, `buildSystemPromptForCfg`, `buildAgentGraph`), assign `c.cfg`, print confirmation. Register via `registerCommand`; add `import './slash/mode.js';` in `src/tui/index.ts` alongside `:34` (`allow-mutations.js`). `/allow-mutations` itself is orthogonal and unchanged.
- **verify:** `npx tsc --noEmit -p tsconfig.build.json && npm run build`
- **done:** Command registered; typecheck clean.

### Step 13 — Create `src/tui/slash/mode.spec.ts`

- **depends_on:** 12
- **files:** `src/tui/slash/mode.spec.ts` (create)
- **action:** Vitest spec following the existing slash-spec harness conventions (`src/tui/slash/registry.spec.ts`, `resume.spec.ts` — note: no `allow-mutations.spec.ts` exists, so those two are the structural precedent). Cover: no-arg reports current mode; `/mode basic` swaps the group booleans and rebuilds the catalog in place (assert `c.cfg` changed and `agentGraph`/`tools` rebuilt — mock the heavy builders as the harness precedent does); invalid value → error, state unchanged (AC-8); `chat`/`basic` with wrapped tools present → rejected, state unchanged.
- **verify:** `vitest run src/tui/slash/mode.spec.ts`
- **done:** Spec green.

### Step 14 — Add the `mode` knob to `profile-dry-run`

- **depends_on:** 1, 3
- **files:** `src/commands/profile/dry-run.ts` (modify), `src/commands/profile/dry-run.spec.ts` (modify)
- **action:** In `buildKnobResolvers` (`src/commands/profile/dry-run.ts:137-267`) add a `mode` resolver mirroring the `provider`/`allowMutations` entries' candidate structure: `cliFlags['mode']` (cli-flag; always undefined today since the subcommand takes no knob flags — same as every other knob) > `shellEnv`/`agentDotEnv`/`localDotEnv` `CLI_AGENT_MODE` > `profile.cliParams.mode` > `configFile.mode` > `{ value: 'composite', source: 'built-in-default' }`. Extend `dry-run.spec.ts` with source-attribution cases (env-set, profile-set, config-set, default). This closes the scan's New Integration Point (dry-run silently omitting the one knob this request adds).
- **verify:** `vitest run src/commands/profile/dry-run.spec.ts`
- **done:** `profile-dry-run` output includes a `mode` row with correct source attribution; spec green.

### Step 15 — Update no-tools messaging (`NO_TOOLS_BLOCK`, smoke-script comment)

- **depends_on:** —
- **files:** `src/agent/system-prompt.ts` (modify), `src/agent/system-prompt.spec.ts` (modify), `test_scripts/verify-no-tools-notice.ts` (modify)
- **action:** Reword the `NO_TOOLS_BLOCK` string (`src/agent/system-prompt.ts:220-226`) — it currently instructs "re-run cli-agent without --no-builtin-tools / --no-agent-tools / --no-composites…", flags that no longer exist — to reference `--mode composite` (or `--mode tool`). Add a regression assertion in `src/agent/system-prompt.spec.ts` pinning the new wording (the scan confirms no existing assertion pins the old string; only a comment near `:265` mentions it — update that comment too). Reword the header comment of `test_scripts/verify-no-tools-notice.ts` (line 4) from the removed flag combination to `--mode chat`; the object literal inside (internal `builtinTools:false, composites:false` representation) needs NO change. Nothing else in `system-prompt.spec.ts` is in scope (the `BuiltinToolsPresence` fixtures test the internal representation — Out-of-Scope).
- **verify:** `vitest run src/agent/system-prompt.spec.ts && npx tsx test_scripts/verify-no-tools-notice.ts`
- **done:** New wording asserted; smoke script still passes; no source file mentions the removed flag names outside historical docs.

### Step 16 — Re-record the help byte-stability baseline (NFR-CMP-001)

- **depends_on:** 6, 7, 12, 14, 15 (all source-changing steps — the recorded bytes must come from the final binary)
- **files:** `test_scripts/baselines/help-no-treat-as-tool.txt` (modify), `test_scripts/baselines/help-no-treat-as-tool.sha256` (modify)
- **action:** Conscious re-record per the NFR-CMP-001 flow: read `src/cli-help-baseline.spec.ts` first to confirm exactly what it asserts (baseline text and/or the sha file format — the sha file currently holds a bare hex digest); then `npm run build`; then `NO_COLOR=1 FORCE_COLOR=0 node dist/cli.js --help > test_scripts/baselines/help-no-treat-as-tool.txt`; regenerate the `.sha256` companion to match (`shasum -a 256` digest of the new baseline). Eyeball the diff: 32 flag rows gone, 3 new rows (`--mode`, `--enable-tool`, `--disable-tool`), no `(default: …)` drift on the new rows.
- **verify:** `vitest run src/cli-help-baseline.spec.ts` (byte-exact green, AC-9) and `grep -c 'enable-agt' test_scripts/baselines/help-no-treat-as-tool.txt` returns 0.
- **done:** Baseline reflects the new surface; baseline spec green.

### Step 17 — Docs: `docs/tools/cli-agent.md` + `docs/design/configuration-guide.md`

- **depends_on:** 3, 4, 6, 7
- **files:** `docs/tools/cli-agent.md` (modify), `docs/design/configuration-guide.md` (modify)
- **action:** Rewrite the tool-loading sections (62 and 34 legacy mentions respectively per the scan): present `--mode` + `--allow-mutations` + `--enable-tool`/`--disable-tool` as the primary interface; document the mode mapping table, the pinnable precedence chain (CLI > `CLI_AGENT_MODE` (shell > agent-dir `.env` > local `.env`) > profile `cliParams.mode` > config `mode` > default `composite`), the `--tool` × chat/basic rule, and the hard-removal migration (removed flags/env vars/config keys/profile keys each fail fast with the hint; nearest "shell-only" equivalent is `--mode tool` plus `--disable-tool agt_*` entries). Per the configuration-guide convention, state the default (`composite`) and that per-tool `CLI_AGENT_AGT_*` env vars and `agentTools.tools.*` config keys are unchanged.
- **verify:** `grep -n 'no-builtin-tools\|no-agent-tools\|no-composites\|enable-agt-\|disable-agt-\|CLI_AGENT_DISABLE' docs/tools/cli-agent.md docs/design/configuration-guide.md` — remaining hits only inside explicitly-labeled migration/changelog passages.
- **done:** Both docs present the new surface as primary; grep sweep clean of un-flagged legacy presentation (AC-12).

### Step 18 — Docs: competency levels, write-capabilities guide, README

- **depends_on:** 3, 4, 6, 7
- **files:** `docs/guides/agent-competency-levels.md` (modify), `docs/guides/enabling-write-capabilities.md` (modify), `README.md` (modify)
- **action:** `agent-competency-levels.md` (13 legacy mentions): make the four modes the primary interface for the competency ladder; note that group-level "shell-only" (Level 1, builtin ON / agentTools OFF) is no longer expressible as a group toggle — nearest equivalent is `--mode tool` plus per-tool `--disable-tool agt_*` flags (accepted consequence of Resolution 2). `enabling-write-capabilities.md`: light touch per scope (0 legacy hits — verify examples still hold; `--allow-mutations` is unchanged). `README.md`: add a `--mode` usage example (0 legacy hits; addition only, not a rewrite).
- **verify:** Same grep sweep as Step 17 over these three files; remaining hits only in labeled migration notes.
- **done:** Modes are the documented primary interface; README shows `--mode`.

### Step 19 — Design docs: register FRs, land the design-change entry

- **depends_on:** 3, 4, 6, 7
- **files:** `docs/design/project-functions.md` (modify), `docs/design/project-design.md` (modify)
- **action:** In `project-functions.md`: register FR-MODE-1..6, FR-TOOLFLAG-1..3, FR-DEPREC-1, FR-TUI-1, FR-GATE-1, FR-DOC-1 (verbatim intent from the refined request, marked "Implemented (Plan 015)"), and mark the plan-008 group-toggle FRs as superseded by plan-015 (retired, with pointer). Replace/absorb the "Plan 015 (planned)" stub section appended at planning time. In `project-design.md`: add a new dated design-change section (successor to §16/plan-008 at `:3554`, which it explicitly supersedes) describing the as-built surface: pinnable mode chain, mode→groups expansion feeding the unchanged internal representation, generic per-tool pair, hard-removal + fail-fast rejections, TUI `/mode`, and the provenance chain (refined-request → scan → plan-015). Cite both artifact paths.
- **verify:** `grep -n 'plan-015\|FR-MODE-1' docs/design/project-functions.md docs/design/project-design.md` shows the new entries; the plan-008 FR entries carry a superseded marker.
- **done:** Provenance chain permanent; FRs registered and retired per FR-DOC-1.

### Step 20 — Resolve the precedence-asymmetry pending item

- **depends_on:** 3
- **files:** `Issues - Pending Items.md` (modify)
- **action:** Move the "[LOW] Profile tier sits at different precedence positions for pinnable knobs vs tool-group toggles" item (`Issues - Pending Items.md:42-46`) from Pending to the Completed section (file convention: pending on top, completed after), with resolution notes: plan-015 made `--mode` the single pinnable group knob resolved through the uniform tier-5 chain and hard-removed the group-toggle chain (`resolveToolGroupToggle` deleted), eliminating the asymmetry — exactly the fix the item's own "Suggested fix" anticipated. Date the note 2026-07-03 and reference plan-015.
- **verify:** `grep -n 'Profile tier sits at different precedence' 'Issues - Pending Items.md'` — the item appears only in the Completed section.
- **done:** Item moved with resolution notes.

### Step 21 — Final integration verification

- **depends_on:** 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 20
- **files:** none (verification only)
- **action:** Run the full gate and the behavioral acceptance checks that need the built binary. If any check fails, fix within deviation rules or stop per the architectural rule.
- **verify:**
  1. `npm run build` (scan frontmatter build command) — clean.
  2. `npx tsc --noEmit -p tsconfig.json --pretty false` (scan lint command) — clean, specs included.
  3. `vitest run` (scan test command) — full suite zero failures (AC-11, NFR-3).
  4. `node dist/cli.js --help` lists `--mode`/`--enable-tool`/`--disable-tool`, none of the 32 removed flags (AC-9).
  5. `node dist/cli.js --no-agent-tools; test $? -eq 2` and `CLI_AGENT_DISABLE_COMPOSITES=1 node dist/cli.js --help >/dev/null` — flag path exits 2 with hint; env path raises `ConfigurationError` (exit 3) with hint on any config-loading invocation (AC-10, Resolution 2). (Note: `--help` short-circuits before config load — use a prompt-bearing invocation with a dummy provider env for the env-var check if needed.)
  6. `node dist/cli.js --mode chat --tool git x; test $? -eq 2` (AC-5).
  7. Flagless-equivalence proxy (AC-1/AC-2): the Step 8 mapping tests assert flagless ⇒ composite ⇒ all three groups on, and the untouched Out-of-Scope catalog tests (`src/agent/tools/registry-toggles.spec.ts`, `registry.spec.ts`) prove the internal representation still drives the same catalog; the chat empty-toolset stderr notice path is covered by `npx tsx test_scripts/verify-no-tools-notice.ts` (Step 15).
- **done:** All seven checks pass; every acceptance criterion in the mapping table below is covered by a green verification.

## Implementation Units

- **U1-core-config-cli** (steps 1-11) — the mode module, config resolver rewiring, generic flag mapper, removed-flag pre-scan, CLI surface, profile schema/codec, and every spec file type-coupled to those changes. Sequential within the unit; it is the trunk everything else depends on. **Interface contract for other units:** `src/config/mode.ts` exports `AGENT_MODES`, `AgentMode`, `modeToGroups`, `deriveModeFromGroups`, `MODE_MIGRATION_HINT`, `parseModeFlag`; `AgentConfig`'s shape is otherwise unchanged (`builtinTools`, `composites`, `agentTools.enabled` remain; NO new `mode` field); `AgentConfigFile` gains optional `mode`.
- **U2-tui-mode-command** (steps 12-13) — depends on U1 steps 1 and 3. Disjoint files.
- **U3-profile-dry-run-knob** (step 14) — depends on U1 steps 1 and 3. Disjoint files.
- **U4-no-tools-messaging** (step 15) — no dependency; can run in parallel with U1.
- **U5-help-baseline** (step 16) — depends on all source-changing steps (6, 7, 12, 14, 15); must run after U1-U4 land.
- **U6-docs** (steps 17-20) — depends on U1's semantics being final (steps 3, 4, 6, 7); parallel with U2/U3/U5.
- **U7-integration-verify** (step 21) — last; no files.

Parallel fan-out after U1 completes: U2, U3, U6 concurrently (U4 even earlier); then U5; then U7.

## Risks & Mitigations

- **Uncommitted working-tree diff on three in-scope files.** The scan (Notes §5) confirms `src/cli.ts`, `src/tui/slash/allow-mutations.ts`, and `test_scripts/baselines/help-no-treat-as-tool.txt` carry uncommitted cosmetic edits from the separate docs-sync task. → Executors implement ON TOP of the current working tree; do NOT revert those edits; the Step 16 baseline re-record naturally absorbs the pending help-text drift. Surface in the final report that the two changesets are now intertwined in the working tree.
- **Scan staleness:** none — `last_scanned_commit` (2b523cd) equals current `HEAD`, verified at planning time. If commits land before execution, re-check per the staleness rule before starting U1.
- **Commander pre-parse error path exits 1, not 2.** Verified: the `parseAsync(...).catch` handler ignores `exitCode`. → Step 6 wires the pre-scan BEFORE `parseAsync` with its own `CliAgentError`-aware catch; Step 9's spec and Step 21 check 5 assert exit 2.
- **Help-baseline drift from Commander defaults.** A Commander default value on a new option appends `(default: …)` to help. → Step 6 forbids defaults on `--mode` (description text carries "default: composite" instead) and reuses the `--tool`-proven `collectTool, []` pattern for the repeatable pair; Step 16 eyeballs the diff.
- **Legacy env vars must be readable to be rejectable.** Dropping the three `CLI_AGENT_DISABLE_*` keys from `OTHER_ENV_KEYS` would make the layered snapshot blind to them, silently ignoring set values — violating Resolution 2. → Step 3.3 explicitly keeps them listed with a "presence rejected" comment; Step 8(e) tests it.
- **Zod strict-rejection message lacks the migration hint.** → Step 7's raw-object pre-check in `parseProfile` throws first with the actionable message; Step 10 asserts the message content.
- **Out-of-Scope drift temptation.** `buildToolCatalog`, `buildAgentToolsGroup`, `registry-toggles.spec.ts`, the `BuiltinToolsPresence` fixtures, and everything under `src/agent/composite/` are classified Out-of-Scope by the scan and appear in no step's file list. → Deviation rule: touching them is architectural — STOP and surface.
- **Scan flag-count discrepancy (29 vs 32).** Verified against `src/cli.ts:109-143`: 32 option calls. Plan and specs use 32; no impact.

## Acceptance Criteria Mapping

| # | Acceptance criterion (refined request) | Step(s) |
|---|---|---|
| 1 | `--mode composite` ≡ flagless ≡ pre-change catalog/behavior | 3, 8 (mapping + default tests), 21.7 |
| 2 | `--mode chat`: zero tools, stderr notice, conversational | 3, 8, 15, 21.7 |
| 3 | `basic` = agt_* only; `tool` = builtin + agt_*, no composites | 3, 8 |
| 4 | Four-surface resolution order for mode | 3, 8(a), 14 |
| 5 | `--tool` × chat/basic → exit 2, incl. env/profile/config-sourced modes | 3.7, 8(d), 21.6 |
| 6 | `--enable-tool`/`--disable-tool` semantics + UsageError paths | 4, 6, 9 |
| 7 | Mutation gating unchanged despite `--enable-tool` | 3.6 (per-tool tiers untouched), existing Out-of-Scope gate tests, 21.3 |
| 8 | TUI `/mode` rebuilds in place; invalid value → error, no state change | 12, 13 |
| 9 | `--help` free of the 32 removed flags; baseline byte-exact | 6, 16 |
| 10 | Removed flags fail per Resolution 1 (UsageError exit 2 + hint) | 5, 6, 9, 21.5 |
| 11 | `npm run build` + full vitest suite green | 21.1-21.3 |
| 12 | Seven docs consistent; pending item resolved | 17, 18, 19, 20 |

Legacy env/config/profile-key rejection (Resolution 2, implicit in AC-10/AC-12's hard-removal reading): steps 3.5, 7, 8(e), 10, 21.5.

## Deviation Rules for Executors

1. **Auto-fix bugs and blockers** discovered mid-step (broken imports, failing unrelated tests you caused, type errors) and document each fix in your report.
2. **Add missing security/correctness essentials** (input validation, error handling) even when unlisted, and document them.
3. **STOP and surface anything architectural**: changing `buildToolCatalog`/`buildAgentToolsGroup` behavior, adding an `AgentConfig.mode` field, altering the mode mapping or precedence order, reintroducing any legacy surface, or touching Out-of-Scope files. Do not improvise.
4. **Log nice-to-haves instead of doing them** — when running solo, append them directly to `Issues - Pending Items.md`; when running as one of several parallel agents, list them in your final report instead (parallel executors must never edit that shared file directly; the orchestrator appends the entries after the phase). Step 20 is the one sanctioned edit to that file, and it belongs to U6 only.
5. **No fallbacks for configuration**: every missing/invalid config surface raises the typed exception specified in the step (`UsageError` exit 2 for CLI-tier, `ConfigurationError` for env/config/profile). The `composite` default is the documented optional-knob starting value sanctioned by NFR-4 — do not extend that pattern to any other setting.

## Verification

Overall gate (commands from the codebase scan frontmatter — do not re-detect):

1. Build: `npm run build`
2. Typecheck/lint: `npx tsc --noEmit -p tsconfig.json --pretty false`
3. Full test suite: `vitest run` — zero failures
4. Help baseline: `vitest run src/cli-help-baseline.spec.ts` — byte-exact against the re-recorded baseline
5. Behavioral spot checks: Step 21 checks 4-7 (removed-flag exit 2 + hint, `--mode bogus` exit 2, `--tool` conflict exit 2, no-tools notice smoke script)
6. Docs sweep: Step 17/18 grep — no un-flagged presentation of the legacy surface as primary
