---
language: typescript
framework: langgraph
package_manager: npm
build_command: npm run build
test_command: vitest run
lint_command: tsc --noEmit -p tsconfig.json --pretty false
entry_points:
  - src/cli.ts
  - dist/cli.js
last_scanned_commit: 2b523cdce357d7c33f831b04b80bf49667795f52
scanned_for_request: cli-mode-simplification
scanned_at: 2026-07-03T19:12:38Z
---

# Codebase Scan — cli-agent (CLI Mode Simplification)

## 1. Project Overview

`cli-agent` is a TypeScript/Node (ES2022, NodeNext ESM) LangGraph ReAct agent
(`@langchain/langgraph` + `@langchain/core` + per-provider LangChain packages)
that wraps external CLI binaries and exposes a cross-cutting toolkit (bash,
file, web, todo) plus a composite-tool synthesizer and a raw-mode TUI. The
build is `tsc -p tsconfig.build.json` (strict mode, `noUncheckedIndexedAccess`)
emitting to `dist/`; tests run under Vitest (`src/**/*.spec.ts`, 70 spec
files). Entry point is `src/cli.ts` (Commander v12), compiled to the
published `dist/cli.js` binary. No monorepo — single flat `src/` tree with
`agent/`, `commands/`, `config/`, `tui/`, `util/` sub-trees.

This scan is narrowed to the **CLI Mode Simplification** refined request
(`docs/reference/refined-request-cli-mode-simplification.md`): introducing a
pinnable `--mode <chat|basic|tool|composite>` knob, collapsing 13
`--enable-agt-*`/`--disable-agt-*` flag pairs (26 flags) into a generic
`--enable-tool`/`--disable-tool` pair, and **hard-removing** the three
tool-group toggle flag pairs plus their env vars, `config.json` keys, and
profile keys (per the recorded Open-Question resolutions).

## 2. Module Map

Top-level `src/` layout (skip-list applied: `node_modules/`, `dist/`,
`coverage/` excluded per `.gitignore`):

| Path | Purpose | Key symbols |
|---|---|---|
| `src/cli.ts` | Commander entry point; default-command flag registration, subcommand wiring, composite-flag/help interception | `program`, `enforceCompositeFlagMatrix`, `mapAgentToolFlags` (re-export) |
| `src/cli-agent-tools-flags.ts` | CLI-tier gatekeeper mapping the 13 `--enable/--disable-agt-*` pairs → `AgentCliFlags['agentTools']`, with conflict detection | `mapAgentToolFlags` |
| `src/cli-composite-flags.ts` | Composite-tool flag matrix parser/enforcer (pattern to mirror for `--mode` validation) | `parseCompositeFlags`, `enforceCompositeFlagMatrix` |
| `src/errors.ts` | Typed error hierarchy + exit-code mapping | `UsageError` (exit 2), `ConfigurationError` (exit 3), `CliAgentError` |
| `src/config/agent-config.ts` | Four/five-tier config loader; **the** precedence-chain module | `loadAgentConfig`, `resolveAgentTools`, `resolveToolGroupToggle`, `AgentCliFlags`, `AgentConfig`, `AgentConfigFile` |
| `src/config/profile-schema.ts` | Zod schemas for profile YAML/JSON | `ProfileCliParamsSchema`, `ProfileToolsSchema`, `KNOWN_CLI_PARAMS` |
| `src/config/profile-loader.ts` | Profile file resolution + validation (E1-E20 errors) | `loadProfile`, `listProfiles` |
| `src/config/profile-codec.ts` | YAML/JSON parse + Zod validation wrapper | `parseProfile`, `stringifyProfile` |
| `src/agent/tools/registry.ts` | `buildToolCatalog` — the catalog-assembly gate consuming `cfg.builtinTools`/`cfg.composites`/`cfg.agentTools` | `buildToolCatalog`, `ToolCatalog` |
| `src/agent/tools/agent-tools/group-builder.ts` | Assembles the agt_* wrapper subset from `cfg.agentTools.tools.*` + mutation gate | `buildAgentToolsGroup` |
| `src/agent/tools/agent-tools/*.ts` (13 files) | Individual agt_* tool wrappers (glob, grep, multiedit, patch, todo_read/write, web_search/fetch, file_read/list/write/edit/append) | `AGT_*_NAME`, `build*Tool` |
| `src/agent/tools/agent-tools-vendored/` | Vendored upstream agent-tools pack sources | (third-party, do not modify) |
| `src/agent/tools/bash/` | `bash_run`/`bash_list_allowed`/`bash_which` + allowlist | `parseAllowlistEntries` |
| `src/agent/tools/profile-scoping.ts`, `profile-tool-args.ts` | Post-catalog profile allow/deny/order + toolArgs merge | `applyProfileToolScoping` |
| `src/agent/tools/web/backends/` | Web-search backend registry | — |
| `src/agent/composite/` (14 files) | Composite-tool synthesis pipeline (stage1/2, dispatcher, virtual-registry, shim-writer) — orthogonal to this request | — |
| `src/agent/capabilities/` | `--help`-tree introspection + capability-doc caching | — |
| `src/agent/providers/` | Per-provider LangChain LLM factories (8 providers) | `createLLM` (registry.ts) |
| `src/agent/system-prompt.ts` | System-prompt assembly; builtin/agt_* conditional blocks + toolless-session notice | `buildSystemPrompt`, `buildSystemPromptForCfg`, `buildBuiltinToolsPromptBlock` |
| `src/agent/run.ts`, `graph.ts`, `checkpoint-store.ts`, `io-capture.ts`, `logging.ts` | Agent runtime (one-shot / interactive / TUI streaming) | `buildTuiAgentRuntime`, `streamOneShotAgent` |
| `src/commands/` | CLI subcommand handlers (profile-*, composite-*, capabilities, tool-prompts) | `runAgentCommand` (agent.ts) |
| `src/commands/profile/dry-run.ts` | Prints resolved value + source per pinnable knob (`buildKnobResolvers`) | `buildKnobResolvers` |
| `src/tui/` | Raw-mode TUI (controller, line editor, transcript persistence) | `TuiController`, `startTui` |
| `src/tui/slash/` (17 files) | Slash-command registry + one file per command | `registerCommand`, `dispatchSlash`, `/allow-mutations` (pattern to mirror for `/mode`) |
| `src/util/redact.ts` | Secret redaction for stderr/error output | `redactString` |
| `test_scripts/` | Smoke scripts + `baselines/` (help byte-stability fixtures) | `help-no-treat-as-tool.txt`, `.sha256` |

## 3. Conventions

- **Typed error hierarchy with fixed exit codes.** All resolvers throw
  `UsageError` (exit 2, CLI-tier/flag conflicts) or `ConfigurationError`
  (exit 3, env/config/profile value present-but-invalid) — never a generic
  `Error`. See `src/errors.ts:84-103` and every call site in
  `src/config/agent-config.ts` (e.g. `resolveProvider`,
  `parseAgentToolsBoolEnvVar` at `src/config/agent-config.ts:1336-1345`).
- **Tri-state resolver idiom, one function per knob-family.** Precedence
  chains are hand-written `??`/early-return chains, not a generic merge
  utility — e.g. `resolveToolGroupToggle` (`src/config/agent-config.ts:1476-1489`)
  and `resolveAgentTools`'s `resolveOne` closure
  (`src/config/agent-config.ts:1400-1424`). New pinnable knobs (like `mode`)
  are expected to follow the **tier-5 `cliParams` insertion** pattern
  demonstrated for `provider` at `src/config/agent-config.ts:1058-1063`
  (`flags.X ?? layered['ENV_X'] ?? activeProfileData?.cliParams?.X ?? configFile?.X ?? default`).
- **CLI-tier conflict detection via raw `argv` inspection.** Because
  Commander collapses `--flag`/`--no-flag` pairs to "last one wins," both
  `mapAgentToolFlags` (`src/cli-agent-tools-flags.ts:49-57`) and
  `enforceCompositeFlagMatrix`'s `detectPresence`
  (`src/cli-composite-flags.ts:96-122`) re-scan `process.argv.slice(2)` to
  detect "both flags supplied" before falling back to the parsed `opts`
  object.
- **Commander help-byte-stability discipline.** Defaults are deliberately
  omitted from `.option(...)` calls to avoid `(default: …)` help drift
  (`src/cli.ts:155-160`); `-h, --help` is manually re-registered
  (`helpOption(false)` at `src/cli.ts:76`) so the composite `--treat-as-tool
  --help` branch can intercept before Commander's auto-help. Any surface
  change requires consciously re-recording
  `test_scripts/baselines/help-no-treat-as-tool.txt`, asserted byte-exact by
  `src/cli-help-baseline.spec.ts`.
- **Per-spec-file local fixture builders, no shared helper.** 23+ spec files
  each define their own local `makeCfg`/`baseCfg`/`makeConfig` function that
  constructs a full or `Partial<AgentConfig>` literal (confirmed via
  `grep -rl "function makeCfg\|function makeConfig"` across `src/`); there is
  **no** central `AgentConfig` test-fixture factory (see Notes §5).
- **NodeNext ESM with explicit `.js` import specifiers** throughout `src/`
  (e.g. `src/config/agent-config.ts:19-32`), `strict: true` +
  `noUncheckedIndexedAccess: true` (`tsconfig.json:9,12`) — new code must
  keep both.
- **Doc-comments cross-reference plan/design sections** (e.g. "plan-008",
  "§14.H", "FR-TLT-001") — new work should register FRs in
  `docs/design/project-functions.md` and land an "as-built surface" entry in
  `docs/design/project-design.md` (the existing plan-008 section, `§16`
  at `docs/design/project-design.md:3554`, is the direct predecessor this
  request supersedes).

## 4. Integration Points

### In-Scope

**CLI surface**
- `src/cli.ts:109-143` — the three group-toggle pairs (`--composites`/`--no-composites`,
  `--builtin-tools`/`--no-builtin-tools`, `--agent-tools`/`--no-agent-tools`)
  and all 13 `--enable-agt-*`/`--disable-agt-*` pairs (26 flags). All 29
  `.option(...)` calls are removed; a new `--mode <chat|basic|tool|composite>`
  option and a repeatable `--enable-tool <name>`/`--disable-tool <name>` pair
  land here instead. Per Resolution 1 (hard removal), passing any removed
  flag must raise `UsageError` (exit 2) with a migration hint — since
  Commander no longer recognizes an unregistered long flag it will already
  error, but an explicit, friendlier message likely needs an `argv`
  pre-scan (mirroring `detectPresence` in `src/cli-composite-flags.ts:96-122`)
  run before Commander's own parse.
- `src/cli.ts:182-269` (action handler) — `enforceCompositeFlagMatrix` call
  (~192-197) needs no change, but the opts-to-`AgentCliFlags` mapping
  (~224-267) drops `composites`/`builtinTools` (~264-265) and adds `mode`
  and the new generic tool-flag arrays.
- `src/cli-agent-tools-flags.ts:45-128` (`mapAgentToolFlags`) — the
  13-pair table (`pairs`, lines 74-94) and per-pair conflict loop
  (98-114) are replaced by a generic, name-keyed resolver over
  `--enable-tool`/`--disable-tool` repeatable arrays (FR-TOOLFLAG-1/2),
  validating names against the canonical `agt_*` registry.

**Config resolution (`src/config/agent-config.ts`, 1618 lines)**
- `AgentConfigFile` interface (`105-172`): remove `builtinTools?`/`composites?`
  (156-157); `agentTools.enabled?` (128) is removed as a *user-facing group
  control* (its sub-tree `agentTools.tools.*`, 129-146, stays unchanged);
  add `mode?: 'chat'|'basic'|'tool'|'composite'`.
- `AgentConfig` interface: `composites`/`builtinTools` (`275-285`) **stay** —
  they are the internal representation the mode resolver writes into. Add a
  new `mode: 'chat'|'basic'|'tool'|'composite'` field (always resolved,
  consumed by the new `--tool` + chat/basic conflict check and by
  `profile-dry-run`/`/mode`).
- `AgentCliFlags` interface: remove `composites?`/`builtinTools?` (`384-393`,
  the CLI-tier inputs for the removed flags); the `agentTools` shape
  (`365-383`) needs its per-tool sub-keys re-derived from the generic
  `--enable-tool`/`--disable-tool` mapper output (same shape, different
  producer); add `mode?: string` (raw, pre-validation).
- `OTHER_ENV_KEYS` (`842-895`): remove `CLI_AGENT_DISABLE_COMPOSITES`
  (854), `CLI_AGENT_DISABLE_BUILTIN_TOOLS` (855), `CLI_AGENT_DISABLE_AGENT_TOOLS`
  (859) as **resolvable** keys — per Resolution 2 a *set* value must raise
  `ConfigurationError` (fail-fast), so the loader still needs to check for
  their presence (just to reject it), not silently ignore them. Add
  `CLI_AGENT_MODE`. The 12 per-tool `CLI_AGENT_AGT_*` keys (862-876) stay
  unchanged (FR-TOOLFLAG-3).
- `loadAgentConfig` body (`970-1280`): the `resolveAgentTools(...)` call
  (1253-1258) and the two `resolveToolGroupToggle(...)` calls
  (1263-1276, composites/builtinTools) are replaced by: (a) a new
  `resolveMode(...)` following the tier-5 pattern demonstrated for
  `provider` (1058-1063), validating the enum and raising
  `ConfigurationError` for a bad env/config/profile value (mirroring
  `parseAgentToolsBoolEnvVar`'s strictness, 1336-1345); (b) a mode→group
  mapping function producing the `{composites, builtinTools, agentTools.enabled}`
  baseline per the request's table; (c) explicit presence-checks for the
  three legacy env/config/profile keys that throw `ConfigurationError` with
  a migration hint if set (Resolution 2).
- `resolveAgentTools` (`1362-1451`): the umbrella `enabled` resolution
  branch (1377-1394, which today consults `flags?.enabled`,
  `CLI_AGENT_DISABLE_AGENT_TOOLS`, `cfgPack?.enabled`, `profileEnabled`) is
  removed and replaced by the mode-derived boolean; the per-tool
  `resolveOne` closure (1400-1424) and its env-var union type
  (`CLI_AGENT_AGT_*`, 1402-1415) are unchanged (FR-TOOLFLAG-3) but now fed
  by the new generic-flag mapper instead of 13 discrete Commander options.
- `resolveToolGroupToggle` (`1476-1489`): entire function removed (its
  three call-sites are replaced by the mode-mapping step above).

**Profile schema/loader**
- `src/config/profile-schema.ts`: `ProfileCliParamsSchema` (`21-32`) gains
  `mode: z.enum(['chat','basic','tool','composite']).optional()`;
  `KNOWN_CLI_PARAMS` (`82-91`) gains `'mode'`. `ProfileToolsSchema`
  (`34-51`) **removes** `composites`/`builtin`/`agentTools` (47-49) — since
  the schema stays `.strict()` (51), Zod already rejects the removed keys
  as "unrecognized key(s)" and `profile-codec.ts:parseProfile` (`79-97`)
  already wraps any Zod failure into `ConfigurationError` — this
  structurally satisfies Resolution 2's fail-fast requirement, but the
  default Zod message will not mention `--mode`; the design should decide
  whether a friendlier migration hint needs a manual pre-check (e.g. a
  `.superRefine` or a raw-object scan before `ProfileSchema.safeParse`) so
  the error text points at the mode equivalents.
- `src/config/profile-loader.ts:242-259` (`emitUnknownCliParamWarnings`) —
  no code change needed once `mode` is in `KNOWN_CLI_PARAMS`; behavior is
  automatic.

**TUI**
- `src/tui/slash/allow-mutations.ts` (42 lines) — direct pattern to mirror
  for a new `src/tui/slash/mode.ts`: read `c.cfg.mode`/print current value
  when no arg; on a valid arg, clone `cfg` with the new mode mapped into
  `composites`/`builtinTools`/`agentTools.enabled`, rebuild `llm`/`tools`/
  `systemPrompt`/`agentGraph` exactly as lines 24-36 do.
- `src/tui/index.ts:22-38` — new `import './slash/mode.js';` line alongside
  the existing 16 slash-module imports (34: `allow-mutations.js`).
- `src/tui/slash/registry.ts` — no change; generic dispatcher already
  supports an arbitrary new `SlashCommand`.

**Help-baseline & tests**
- `src/cli-help-baseline.spec.ts` (69 lines) + `test_scripts/baselines/help-no-treat-as-tool.txt`
  (+ `.sha256`) — must be consciously re-recorded once the flag surface
  shrinks by 29 flags and grows by 3 (`--mode`, `--enable-tool`,
  `--disable-tool`). **Caveat:** the working tree already carries an
  *uncommitted, unrelated* diff on this exact baseline file and on
  `src/cli.ts`/`src/tui/slash/allow-mutations.ts` from a prior docs-text-sync
  pass — see Notes §5.
- `src/config/agent-config.spec.ts` — heaviest rewrite (60 legacy-surface
  hits): tests of `resolveAgentTools`'s umbrella CLI/env/config paths,
  `resolveToolGroupToggle`'s full chain, `AgentCliFlags.composites`/`builtinTools`
  fixtures, and the tier-5 `cliParams` precedence tests this request's
  `mode` chain must mirror.
- `src/config/profile-schema.spec.ts:108-150` — directly asserts
  `ProfileToolsSchema` **accepts** `tools.composites`/`tools.builtin`/`tools.agentTools`
  (line 108-128) and warns on an unknown tools-key (150); must flip to
  asserting **rejection** (`ConfigurationError`/schema failure) for the
  three removed keys, plus new acceptance tests for `cliParams.mode`.
- `src/cli.spec.ts:89-106` — `KNOWN_CLI_PARAMS contains the required
  plan-005 keys` test enumerates a `required` array (93-100); recommend
  adding `'mode'` for completeness (not required to pass, since the
  assertion is per-key, but a coverage gap otherwise).
- `test_scripts/verify-no-tools-notice.ts:31-32` — smoke script that
  constructs an `AgentConfig`-shaped object with
  `builtinTools: false, composites: false` directly (internal
  representation, not via CLI) to reproduce the empty-toolset notice; its
  header comment (line 4) narrates the now-removed flag combination and
  should be reworded to `--mode chat`, but the object literal itself needs
  no change (internal fields persist).
- `src/agent/system-prompt.ts:210-226` (`NO_TOOLS_BLOCK`) — the string
  shown to the LLM literally says *"re-run cli-agent without
  --no-builtin-tools / --no-agent-tools / --no-composites … to enable
  them"* (line 226). This user/LLM-facing text must be updated to reference
  `--mode` (e.g. `--mode composite` or `--mode tool`) since the named flags
  will no longer exist. `system-prompt.spec.ts` does not assert this exact
  string today (only a comment references the old combination at line
  265), so no test currently breaks, but the new wording should get
  regression coverage.

**Documentation (7 files, legacy-mention counts from a targeted grep)**
`docs/tools/cli-agent.md` (62 hits), `docs/design/project-design.md` (45,
includes the `§16` plan-008 section to supersede), `docs/design/project-functions.md`
(39), `docs/design/configuration-guide.md` (34), `docs/guides/agent-competency-levels.md`
(13), `docs/guides/enabling-write-capabilities.md` (0 — "light touch" per
scope), `README.md` (0 — likely only needs a new-surface example, not a
rewrite).

**Pending-items log**
- `Issues - Pending Items.md:42-46` — the `[LOW] Profile tier sits at
  different precedence positions…` item is the direct motivating precedent
  for this request; per the refined request's scope it must be
  moved/annotated as addressed once `--mode` ships.

### Out-of-Scope (must remain untouched)

- `src/agent/tools/registry.ts:42-162` (`buildToolCatalog`) — consumes
  `cfg.builtinTools`/`cfg.composites`/`cfg.agentTools.enabled` exactly as
  today; these are the internal representation the mode resolver feeds.
  **No functional change required** (only stale doc-comments referencing
  "plan-008 toggle" at lines 46, 88-93 could optionally be refreshed).
- `src/agent/tools/agent-tools/group-builder.ts:137-275` (`buildAgentToolsGroup`)
  — same; consumes `cfg.agentTools.tools.*` + `cfg.allowMutations` unchanged.
- `src/agent/tools/registry-toggles.spec.ts` (436 lines) — constructs
  `AgentConfig` fixtures directly with `builtinTools`/`composites`/
  `agentTools.enabled` (confirmed by reading lines 1-60, 204-421); tests
  the catalog **gate**, not CLI/env/config resolution. No change required
  (internal representation is unaffected by the hard removal).
- `src/agent/system-prompt.spec.ts` (bulk of its 34 legacy-token hits) —
  tests `BuiltinToolsPresence`/`builtinTools` as an internal presence flag
  (`FULL_PRESENCE`/`OFF_PRESENCE` fixtures); only the `NO_TOOLS_BLOCK`
  string change above is in-scope, the rest of the file is not.
- `src/agent/tools/registry.spec.ts:603-633` — "AC4"/"AC5" tests construct
  `cfg.builtinTools = false` / `agentToolsEnabled: false` directly on a
  local `makeCfg` fixture; the test *names* reference the legacy flags
  descriptively but exercise the internal representation only — cosmetic
  rename optional, no functional change required.
- `src/agent/run.spec.ts`, `src/agent/providers/registry.spec.ts`,
  `src/agent/tools/tool-prompts-builtin.spec.ts`,
  `src/agent/tools/integration-profile-overlay-coexistence.spec.ts`,
  `src/agent/tools/agent-tools/permissions.spec.ts`,
  `src/agent/tools/agent-tools/group-builder.spec.ts`,
  `src/agent/tools/agent-tools/agent-tools-e2e.spec.ts` — all build a local
  `AgentConfig` fixture with `agentTools: {...}` inline; unaffected by the
  CLI/env/profile/config removal, **but see the ripple-effect note below**
  if `mode` becomes a non-optional `AgentConfig` field.
- `src/agent/composite/shim-writer.ts` / `shim-writer.spec.ts:110-121` —
  `composites`/`composite` tokens here refer to the composite-tool
  directory naming (`<agentDir>/composites/<id>/`), an unrelated feature;
  the one `--no-agent-tools` mention (line 113) is an arbitrary example
  string in a shim-escaping test, not a functional dependency — optional
  cosmetic swap to a still-valid example flag.
- Everything under `src/agent/composite/` (14 source + 9 spec files),
  `src/agent/capabilities/`, `src/agent/providers/` (except test fixtures),
  `src/agent/tools/agent-tools-vendored/`, `src/agent/tools/bash/`,
  `src/agent/tools/web/` — no legacy-surface touchpoints found.
- `src/commands/composite/*`, `src/commands/profile/create.ts`,
  `edit.ts`, `list.ts`, `show.ts`, `delete.ts` — no legacy-surface
  touchpoints found (`profile/dry-run.ts` is the one exception, see New
  Integration Points).

### New Integration Points (implied but not explicitly named in the FRs)

- `src/commands/profile/dry-run.ts:137-267` (`buildKnobResolvers`) —
  enumerates one resolver per pinnable knob (`provider`, `model`,
  `temperature`, `maxIterations`, `allowMutations`, `webSearchBackend`,
  `logLevel`, `workingDir`) with per-tier source attribution. `mode` is a
  new pinnable knob (per FR-MODE-3) but is **not** in this list and not
  mentioned in the refined request's scope. Recommend the design add a
  `mode` resolver here for consistency — otherwise `cli-agent profile-dry-run`
  will silently omit the one knob this request adds, which would surprise
  users debugging precedence.
- A landing spot for `mode`-specific unit tests: no `src/config/agent-config-mode.spec.ts`
  or similar exists yet; given `agent-config.spec.ts` is already large
  (60 legacy hits before this change), the design may want a dedicated new
  spec file for the `resolveMode`/mode-mapping logic rather than growing
  the existing file further — a naming decision for the coder, following
  the project's one-file-per-concern spec convention.
- A landing spot for the new generic-flag mapper's own tests: `mapAgentToolFlags`
  currently has no dedicated spec file (only smoke-imported from
  `src/cli.spec.ts:33-38` and exercised indirectly via `src/config/agent-config.spec.ts`);
  the rewritten generic mapper (arbitrary tool names, not 13 fixed pairs)
  likely warrants its own `src/cli-agent-tools-flags.spec.ts`.

## 5. Notes

- **Test-fixture ripple risk.** If `AgentConfig` gains a new **required**
  `mode` field, every one of the 23+ spec files with a local `makeCfg`/
  `baseCfg`/`makeConfig` builder (confirmed via
  `grep -rl "function makeCfg\|function makeConfig"` across `src/`) will
  fail to typecheck until that literal gains a `mode: '...'` line — there
  is no shared fixture factory to patch in one place. The design should
  either (a) make `mode` a field with a safe default so `Partial<AgentConfig>`-style
  fixtures keep compiling, or (b) accept the ~23-file mechanical ripple and
  budget for it explicitly in the plan.
- **Working tree already has an uncommitted, unrelated diff touching three
  of this request's exact files**: `src/cli.ts` (two description-string
  edits), `src/tui/slash/allow-mutations.ts` (one summary-string edit), and
  `test_scripts/baselines/help-no-treat-as-tool.txt` (matching help-text
  drift) — all cosmetic wording fixes from an in-flight, separate
  docs-sync task (`docs/reference/refined-request-docs-sync-file-tools-capability-invalidation.md`),
  not yet committed. The mode-simplification implementation will conflict
  textually (not semantically) with this diff on the same lines; recommend
  landing/committing the docs-sync change first, or rebasing the
  mode-simplification diff on top of it, before re-recording the help
  baseline.
- **`git rev-parse HEAD`** at scan time is `2b523cd` ("feat: implement
  runtime assembly deduplication…"), one commit ahead of the `f8bf6b4`
  snapshot in the session's initial git-status context — confirms the
  repo has moved since the conversation started; re-verify `HEAD` before
  planning if more time elapses.
- **No functional implementation of `--mode` exists yet anywhere in the
  tree** (grep for `CLI_AGENT_MODE`, `--mode`, `cliParams.mode`,
  `AgentConfig['mode']` returns zero hits outside the refined-request file
  itself) — this is a clean-slate feature addition, not a partial
  duplicate; the "already (partially) implemented?" duplication check
  resolves to **no duplication found**.
