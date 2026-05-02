---
language: typescript
framework: langgraph
package_manager: npm
build_command: "npm run build"
test_command: "vitest run"
lint_command: "tsc --noEmit -p tsconfig.json"
entry_points:
  - src/cli.ts
last_scanned_commit: 5144a73f999abff6d9bdc731de1c0b2d36308bef
scanned_for_request: refined-request-config-profiles.md
scanned_at: "2026-05-02T09:30:00Z"
---

# Codebase Scan — cli-agent (Configuration Profiles)

## 1. Project Overview

`cli-agent` is a TypeScript LangGraph ReAct agent (Node 22+, ESM) that wraps
external CLI binaries via auto-introspected capability documents. The CLI entry
point is `src/cli.ts`, which declares all subcommands using Commander.js. All
configuration flows through a four-tier precedence chain implemented in a single
1035-line loader (`src/config/agent-config.ts`). The project is built with `tsc`,
tested with Vitest (co-located `*.spec.ts` files), and publishes a single binary
`dist/cli.js` (chmod +x). Version 0.2.1 at the scanned commit.

---

## 2. Module Map

| Path | Purpose | Representative symbols |
|---|---|---|
| `src/cli.ts` | Commander.js program setup; declares all subcommands and top-level flags; wires `opts` into `runAgentCommand` | `program`, `handleErrors`, `collectTool` |
| `src/cli-agent-tools-flags.ts` | CLI-tier gatekeeper that maps `--enable-agt-*` / `--disable-agt-*` / `--agent-tools` flags to `AgentCliFlags.agentTools`; conflict detection | `mapAgentToolFlags` |
| `src/commands/agent.ts` | Primary agent subcommand handler; calls `loadAgentConfig`, then routes to TUI / streaming one-shot / interactive | `runAgentCommand`, `AgentCommandOptions` |
| `src/commands/` | Thin handlers for all other subcommands: `show-capabilities`, `refresh-capabilities`, `extract-tool-prompts`, `show-tool-prompt`, `audit-tool-prompts` | `runShowCapabilities`, `runExtractToolPrompts`, `runAuditToolPrompts` |
| `src/config/agent-config.ts` | **The configuration loading pipeline** — four-tier resolution chain, bootstrap, `.env` parser, `config.json` reader, `AgentConfig` builder | `loadAgentConfig`, `bootstrapAgentDir`, `AgentCliFlags`, `AgentConfig` |
| `src/agent/run.ts` | Agent runners (one-shot, streaming, interactive, TUI-bootstrap); calls `buildToolCatalog` and `buildAgentGraph` | `runOneShotAgent`, `streamOneShotAgent`, `buildTuiAgentRuntime` |
| `src/agent/graph.ts` | LangGraph `createReactAgent` wrapper; per-graph `AgentToolsSession` and `workingDirectory` pinned via `RunnableConfig.configurable` | `buildAgentGraph`, `runOneShot`, `streamOneShot` |
| `src/agent/tools/registry.ts` | **Tool catalog builder** — assembles the LLM-visible tool array from config; returns `{ tools, agentToolsMeta }` | `buildToolCatalog`, `ToolCatalog` |
| `src/agent/tools/agent-tools/group-builder.ts` | **Agent-tools pack catalog assembly** — applies umbrella + per-tool + mutation gating; produces `AgentToolsGroup + AgentToolsCatalogMeta` | `buildAgentToolsGroup`, `AgentToolsCatalogMeta` |
| `src/agent/tools/agent-tools/index.ts` | Barrel for agent-tools wrappers (`agt_glob`, `agt_grep`, `agt_multiedit`, `agt_patch`, `agt_todo_read`, `agt_todo_write`); permission bridge | `buildAgtGlobTool`, `cliAgentPermissionPolicy` |
| `src/agent/tools/tool-prompt-overlay.ts` | **plan-004 overlay loader/parser** — reads `~/.tool-agents/cli-agent/tool-prompts/*.md`; provides `getToolDescription` / `getParamDescription` | `loadOverlayRegistry`, `parseOverlayFile`, `OverlayRegistry` |
| `src/agent/tools/tool-prompts-builtin.ts` | Compile-time built-in prompt text for every native tool; consumed by overlay helpers and bootstrap seeding | `BUILTIN_TOOL_PROMPTS` |
| `src/agent/tools/bash/` | `bash_run`, `bash_list_allowed`, `bash_which` tool factories; `allowlist.ts` / `exec.ts` helpers | `createBashRunTool`, `parseAllowlistEntries` |
| `src/agent/tools/file/` | `file_read`, `file_list`, `file_write`, `file_edit`, `file_append` tool factories | `createFileReadTool`, `createFileEditTool` |
| `src/agent/tools/web/` | `web_search`, `web_fetch` tool factories; `backends/` subdirectory holds provider adapters | `createWebSearchTool`, `createWebFetchTool` |
| `src/agent/tools/types.ts` | Shared `DynamicStructuredTool` type alias | `AnyTool` |
| `src/agent/providers/` | One file per LLM provider (openai, anthropic, gemini, azure-openai, azure-anthropic, ollama, litellm, mlx); `registry.ts` dispatches | `createLLM` |
| `src/agent/capabilities/` | Capability discovery pipeline (run `--help`, LLM extraction, Markdown cache) | `discoverAllTools`, `composeCapabilitiesSystemPrompt` |
| `src/agent/system-prompt.ts` | Reads base system-prompt file, appends `--system` / `--system-file` text | `buildSystemPromptForCfg` |
| `src/agent/logging.ts` | JSONL structured logger; writes `~/.tool-agents/cli-agent/logs/`; `CLI_AGENT_LOG=off` disables | `createLogger`, `LogEvent` |
| `src/tui/` | Raw-mode TUI (index, controller, input, slash, transcript, clipboard, spinner) | `startTui`, `TuiController` |
| `src/errors.ts` | Typed error hierarchy with exit codes; `ConfigurationError` (exit 3), `UsageError` (exit 2), `FileError` (exit 6) | `CliAgentError`, `ConfigurationError`, `UsageError` |
| `src/util/redact.ts` | Credential-scrubbing helper applied to all stderr output | `redactString` |
| `test_scripts/` | Manual smoke scripts (non-Vitest): `smoke-streaming-llm-events.ts`, `smoke-tui-banner-and-quit.ts` | — |
| `scripts/` | Build-time helper: `copy-vendored-assets.mjs` | — |

---

## 3. Conventions

- **Import style**: named ESM imports throughout (`import { foo } from './bar.js'`);
  `.js` extensions required on all relative imports (ESM-strict). Default imports
  only for Node built-ins (`import fs from 'node:fs'`). Observed in
  `src/config/agent-config.ts:15-27` and `src/agent/tools/registry.ts:13-31`.

- **Error handling**: every CLI-facing function is wrapped by `handleErrors`
  in `src/cli.ts:238-250`; tool `.func` bodies use `handleToolError` from
  `src/errors.ts:159-183` to convert `CliAgentError` subclasses into
  `{ error: { code, message } }` JSON strings (recoverable path) or rethrow
  `ConfigurationError` / `AuthError` (fatal path). Exit codes are hard-wired
  per error class.

- **Config loading — strict no-fallback rule**: `resolveProvider`
  (`src/config/agent-config.ts:865-878`) throws `ConfigurationError` when `raw`
  is undefined; `requireProviderEnv` (`src/config/agent-config.ts:1012-1026`)
  does the same for credential env vars. No silent defaults for required values.

- **Layered env precedence** (as implemented at `src/config/agent-config.ts:676-700`):
  Layer 1 shell env → Layer 2 agent-dir `.env` (fill-gaps) → Layer 3 local `.env`
  (fill-gaps) → CLI flags win at assignment time. `config.json` values are merged
  at individual knob sites (e.g. `flags.model ?? layered['AGENT_MODEL'] ?? configFile?.model`).

- **Test pattern**: Vitest with `vi.mock('node:fs/promises', ...)` to provide a
  hermetic in-memory filesystem; the mock exposes both `default` and named
  exports to catch both import styles. Observed in
  `src/config/agent-config.spec.ts:16-53`. Test files live co-located with
  their source (`*.spec.ts`); Vitest `include: ['src/**/*.spec.ts']`.

- **Tool factories**: each tool factory (`create*Tool` / `build*Tool`) accepts
  `cfg: AgentConfig` (and optionally `logger`) and returns a
  `DynamicStructuredTool`. The LLM-visible `description` and per-param
  `.describe(...)` strings are always routed through `getToolDescription` /
  `getParamDescription` from `tool-prompt-overlay.ts`, so overlays are
  universally honored. Observed in `src/agent/tools/bash/run-tool.ts:36-55`.

---

## 4. Integration Points

### 4.1 In Scope — Direct Touch Points

#### IP-1: Configuration loading pipeline
**File**: `src/config/agent-config.ts`

- **`loadAgentConfig` function** (line 644): the four-tier resolution chain.
  Profile loading inserts at a new **tier between Layer 3 (local `.env`) and
  the per-knob `configFile?.X` reads**. The profile is loaded after Layer 3
  and before any individual knob resolution (line ~706 onwards). Concretely,
  each knob assignment like `flags.model ?? layered['AGENT_MODEL'] ??
  configFile?.model` would expand to `flags.model ?? layered['AGENT_MODEL'] ??
  profileCliParams?.model ?? configFile?.model`.

- **`bootstrapAgentDir` function** (line 300): creates `agentDir`, `logs/`,
  `capabilities/`, `tool-prompts/` with `0700`/`0600` modes. A new
  `profiles/` subdirectory must be bootstrapped here with the same
  pattern (`0700` dir, files at `0600`).

- **`AgentCliFlags` interface** (line 220): add `readonly profile?: string`
  to carry the `--profile <name>` value through the flags pipeline.

- **`AgentConfig` interface** (line 154): add optional
  `readonly activeProfile?: { name: string; path: string; schemaVersion: number; digest: string }`
  so downstream (logging, TUI status) can inspect the active profile.

- **`OTHER_ENV_KEYS` array** (line 551): add `'CLI_AGENT_PROFILE'` so the env
  var participates in the layered env snapshot.

- **`resolveAgentTools` function** (line 928): model for how to write the
  analogous `resolveFromProfile` helper that merges profile `cliParams` at
  tier 5.

#### IP-2: CLI flag parsing
**File**: `src/cli.ts`

- **Default command flag declarations** (lines 40-83): `--profile <name>` is
  added here with `.option('--profile <name>', 'Activate a named configuration profile')`.
  Pattern: identical to `--provider` at line 45.

- **`runAgentCommand` invocation** (lines 93-121): `profile: opts['profile'] as string | undefined`
  is added to the options object passed to `runAgentCommand`, which passes it
  to `loadAgentConfig` via the updated `AgentCliFlags`.

- **`AgentCommandOptions` interface** (`src/commands/agent.ts:15`): inherits
  from `AgentCliFlags`, so adding `profile` to `AgentCliFlags` automatically
  propagates here.

- **New `profile` subcommand group** (after line 223 in `src/cli.ts`): registers
  `cli-agent profile list|show|create|edit|delete|dry-run` as a Commander
  subcommand group. Pattern: exactly like `show-capabilities` at line 126.
  Each verb is a nested subcommand on a new `program.command('profile')` parent.

#### IP-3: Tool registry / tool exposure to the LLM
**File**: `src/agent/tools/registry.ts`

- **`buildToolCatalog` function** (line 47): the assembled `tools` array at
  line 84 is where profile `tools.allow`/`deny`/`order` filtering applies.
  A new `applyProfileToolScoping(tools, profile)` call wraps the final array
  before it is returned. The `cfg` parameter already carries everything needed;
  the profile data arrives via `cfg` (added field `activeProfileData`).

- **Return type `ToolCatalog`** (line 42): no structural change needed; the
  `tools` field is already `AnyTool[]` (mutable before freeze at return).

- **`agentToolsMeta`** (line 84): built from `agentToolsGroup.meta`, which
  reflects only what was registered. After profile scoping, the `meta` must
  also be filtered to stay in lockstep (invariant stated at
  `group-builder.ts:186`). Simplest approach: apply scoping at the combined
  `[...readOnly, ...mutatingFile, ...bashRunTools, ...agentToolsGroup.tools]`
  level and then re-derive the agt subset meta.

- **`buildAgentToolsGroup`** (`src/agent/tools/agent-tools/group-builder.ts:116`):
  profile `tools.allow`/`deny`/`order` is a catalog-level concern applied
  **after** `buildAgentToolsGroup` returns — no change needed inside this
  function. The profile scoping sees the already-assembled flat array.

#### IP-4: Per-tool argument handling (tool invocation merge point)
**Files**: `src/agent/graph.ts`, individual tool factories

- **`runOneShot`** (`src/agent/graph.ts:78`) and **`streamOneShot`** (line 143):
  both pass `configurable: { thread_id, workingDirectory, agentToolsSession }` to
  LangGraph (lines 86-95, 160-174). This is the hook for injecting
  `profileToolArgs` into the configurable bag:
  ```
  configurable: { ..., profileToolArgs: cfg.activeProfileData?.toolArgs ?? {} }
  ```
  The tool `.func` bodies then apply
  `{ ...profileToolArgs[TOOL_NAME], ...runtimeArgs }` at execution time.

- **Per-tool `func` bodies** (e.g. `src/agent/tools/bash/run-tool.ts:60+`):
  each `DynamicStructuredTool` receives the Zod-parsed `input` object in its
  `.func`. The merge `{ ...profileDefaults, ...input }` applies at the top of
  `.func` before any logic runs. Because `createReactAgent` calls `.func` with
  the validated args directly, there is no single dispatcher to patch — each
  tool factory must apply the merge. A shared helper
  `mergeProfileToolArgs(input, configurable, toolName)` should be extracted.

- **Note on `buildTuiAgentRuntime`** (`src/agent/run.ts:217`): identical setup
  to `streamOneShotAgent` — must be updated in tandem when adding
  `profileToolArgs` to the configurable.

#### IP-5: Existing per-tool prompt overlays (plan-004)
**File**: `src/agent/tools/tool-prompt-overlay.ts`

- **`loadOverlayRegistry`** (line 246): called once per `loadAgentConfig`
  invocation (at `src/config/agent-config.ts:826`) from `earlyToolPromptsDir`.
  The result is stored in `cfg.toolPromptOverlays`.

- **Integration with profiles**: overlays change tool *descriptions*; profiles
  change *which tools are exposed* and *what args they default to*. These are
  orthogonal. The correct sequencing is:
  1. `loadOverlayRegistry` (overlays, unchanged).
  2. Profile tool scoping — applied at `buildToolCatalog` output level, after
     overlay-aware tool factories have already run.
  Overlay files for excluded tools are never read at runtime (the factories
  for those tools are simply not called), so no collision can occur.

- **Bootstrap** (`bootstrapToolPromptsDir`, line 434 of `agent-config.ts`):
  unchanged. Profile bootstrap is an independent step.

#### IP-6: Subcommands / CLI entry points
**File**: `src/cli.ts`

Existing subcommands (all attached via `program.command(...)`):
| Subcommand | Handler | Line in `src/cli.ts` |
|---|---|---|
| `(default)` | `runAgentCommand` | 84 |
| `show-capabilities` | `runShowCapabilities` | 126 |
| `refresh-capabilities` | `runRefreshCapabilities` | 143 |
| `extract-tool-prompts` | `runExtractToolPrompts` | 166 |
| `show-tool-prompt` | `runShowToolPrompt` | 188 |
| `audit-tool-prompts` | `runAuditToolPrompts` | 209 |

New `profile` subcommand group attaches at line ~224 (after the last existing
subcommand). Implementation pattern: create `src/commands/profile/` directory
with `list.ts`, `show.ts`, `create.ts`, `edit.ts`, `delete.ts`, `dry-run.ts`
handlers, and a `src/commands/profile/index.ts` registrar consumed by
`src/cli.ts`. The outer `program.command('profile')` acts as a Commander
subcommand parent; each verb is registered on it via `.command(verb)`.

#### IP-7: Test conventions
**Files**: `src/**/*.spec.ts` (co-located), `test_scripts/` (manual smoke)

- **Framework**: Vitest (`vitest run` for CI; `vitest` for watch). Config at
  `vitest.config.ts` — `include: ['src/**/*.spec.ts']`.

- **Mock pattern**: `vi.mock('node:fs/promises', async (importOriginal) => {...})`
  with an in-memory `writtenPaths: Set<string>` tracks writes so `access()`
  can observe them. Both `default` and named exports are mocked to catch both
  import styles. Observed in `src/config/agent-config.spec.ts:16-53`.

- **Null logger**: `const nullLogger: Logger = { log: () => undefined, ... }`.
  Reusable fixture pattern in `src/agent/tools/registry.spec.ts:44-50`.

- **Fixture shape**: partial `AgentConfig`-like objects built inline per test;
  no shared factory — test files cast with `as AgentConfig`. Pattern
  in `src/agent/tools/registry.spec.ts:52+`.

- **Profile-specific tests** should live in:
  - `src/config/agent-config.spec.ts` — precedence chain, profile tier
  - `src/agent/tools/registry.spec.ts` — `applyProfileToolScoping` unit tests
  - `src/commands/profile/` — one `*.spec.ts` per subcommand handler
  - A new `src/agent/tools/profile-tool-args-merge.spec.ts` for per-tool arg merge

- **Coverage threshold**: none enforced in `vitest.config.ts` (reporters only).

#### IP-8: Logging
**File**: `src/agent/logging.ts`

- **`LogEvent` union type** (line 30 area): add a new member
  `{ kind: 'profile_active'; ts: string; sessionId: string; profileName: string; profilePath: string; schemaVersion: number; digest: string }`.

- **Emission point**: `src/agent/run.ts` after `logger.log({ kind: 'session_start' })`.
  When `cfg.activeProfile` is set, emit the `profile_active` event before the
  `user_prompt` event (lines 46-63 in `run.ts`).

---

### 4.2 Out of Scope

These modules are **not implicated** by the configuration profiles feature and
should not be modified:

- `src/agent/capabilities/` — capability discovery is a provider-level concern,
  unchanged by profiles.
- `src/agent/providers/` — LLM provider factories; profiles may pin `provider`
  and `model` values but the factories themselves are unmodified.
- `src/agent/system-prompt.ts` — base prompt loading; `--system` / `--system-file`
  addenda are not profile-scoped in v1.
- `src/tui/` — the TUI itself; v1 does not add a `/profile` slash command.
  Only `src/tui/controller.ts` is a read path to verify it passes
  `profileToolArgs` through to `buildAgentGraph` via `buildTuiAgentRuntime`.
- `src/agent/tools/agent-tools-vendored/` — vendored upstream code; never modified.
- `src/util/redact.ts` — unchanged; profile files must not contain secrets
  (validated at load time), so redaction surface is unaffected.
- `scripts/`, `test_scripts/` — build and smoke scripts; no profile-related
  changes needed.

---

### 4.3 New Integration Points (Not Present Today)

| New element | Recommended landing location |
|---|---|
| `ProfileSchema` (Zod) + `Profile` TypeScript type | `src/config/profile-schema.ts` (new file) |
| `loadProfile(name, agentDir)` async function | `src/config/profile-loader.ts` (new file) |
| `applyProfileToolScoping(tools, profile)` function | `src/agent/tools/profile-scoping.ts` (new file) |
| `mergeProfileToolArgs(input, configurable, toolName)` helper | `src/agent/tools/profile-tool-args.ts` (new file) |
| `bootstrapProfilesDir(agentDir)` (mode 0700, files 0600) | Added to `bootstrapAgentDir` in `src/config/agent-config.ts` |
| `profile list / show / create / edit / delete / dry-run` handlers | `src/commands/profile/` directory (6 files + `index.ts`) |
| `profile_active` log event | `src/agent/logging.ts` `LogEvent` union (new member) |
| Profile Zod validation for `toolArgs` against tool schemas | Inside `loadProfile` or a dedicated `validateProfileToolArgs.ts` |

---

## 5. Notes

- **Four-tier chain as-documented vs. as-implemented**: the header comment in
  `src/config/agent-config.ts` (lines 3-11) labels the tiers as "1. Shell env,
  2. ~/.tool-agents/.env, 3. ./.env or --env-file, 4. CLI flags". The
  implementation uses fill-gaps semantics for tiers 2 and 3 (`layered[k] ===
  undefined` guard), meaning CLI flags win by being applied last at each knob
  site — not by being stored in `layered`. The refined request's proposed tier
  5 (profiles above `config.json`) maps exactly to inserting `profileCliParams?.X`
  in each per-knob expression between `layered['...']` and `configFile?.X`.

- **No YAML library in dependencies**: the project currently has zero YAML
  dependencies (`package.json` deps: commander, fast-glob, ignore, zod, and
  LangChain/LangGraph packages). Profile files defaulting to YAML (per the
  request) will require adding a YAML parser (e.g. `js-yaml` or `yaml`).
  This is a new dependency that must be added to `package.json`.

- **`ANY_TOOL` type alias**: `registry.ts:33` uses `type AnyTool = any` to
  avoid LangChain generic complexity. The profile scoping function will consume
  the same `AnyTool[]` array; no type surgery is needed.

- **`resolveSystemPromptPath` is exported and tested**: the path-resolution
  helper at `src/config/agent-config.ts:622` is a good model for the profile
  name-to-path resolver — three forms (absolute, bare stem, relative).
  Profile resolution is simpler (only bare stem applies), but the test fixture
  pattern is directly reusable.
