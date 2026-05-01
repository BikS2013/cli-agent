---
language: typescript
framework: langgraph
package_manager: npm
build_command: "tsc -p tsconfig.json && chmod +x dist/cli.js"
test_command: vitest run
lint_command: "tsc --noEmit -p tsconfig.json"
entry_points:
  - src/cli.ts
  - src/agent/run.ts
last_scanned_commit: 25bbfb6e05fed1135a9e39157166591f2009474d
scanned_for_request: refined-request-agent-tools-integration.md
scanned_at: "2026-04-30T22:15:00Z"
---

# Codebase Scan — cli-agent (agent-tools integration)

## 1. Project Overview

`cli-agent` (`@biks2013/cli-agent` v0.1.0) is a TypeScript LangGraph ReAct agent that wraps
external CLI binaries. It uses `@langchain/langgraph/prebuilt` `createReactAgent`, exposes a
typed standard tool catalog (`file_*`, `web_*`, `bash_*`, `tool_help`), and auto-introspects
wrapped CLI tools via `--help` scraping to inject capability documents into the system prompt.
The build system is plain `tsc` (no bundler); the test runner is Vitest. The project ships as
an npm binary (`cli-agent`) targeting Node ≥ 22.

## 2. Module Map

| Path | Purpose | Representative symbols |
|---|---|---|
| `src/cli.ts` | Commander-based CLI entry point; parses all flags and dispatches to `runAgentCommand`, `runShowCapabilities`, `runRefreshCapabilities` | `program`, `collectTool`, `handleErrors` |
| `src/errors.ts` | Typed error hierarchy with exit-code semantics; `handleToolError` routes recoverable vs fatal errors | `CliAgentError`, `ConfigurationError`, `UsageError`, `handleToolError` |
| `src/config/agent-config.ts` | Four-tier config loader (shell env → `~/.tool-agents/cli-agent/.env` → `./.env` → CLI flags); bootstraps `~/.tool-agents/cli-agent/`; resolves `systemPromptPath` | `loadAgentConfig`, `bootstrapAgentDir`, `AgentConfig`, `resolveSystemPromptPath` |
| `src/agent/system-prompt.ts` | System-prompt builder; `BUILTIN_DEFAULT_SYSTEM_PROMPT` is the bootstrap seed only (not a runtime fallback); `buildSystemPromptForCfg` composes base file + capabilities section + `--system`/`--system-file` addenda | `buildSystemPrompt`, `buildSystemPromptForCfg`, `BUILTIN_DEFAULT_SYSTEM_PROMPT` |
| `src/agent/graph.ts` | Wraps `createReactAgent`; `buildAgentGraph` binds LLM + tools + systemPrompt as `stateModifier`; `streamOneShot` is the streaming generator | `buildAgentGraph`, `streamOneShot`, `runOneShot`, `AgentStreamEvent` |
| `src/agent/run.ts` | Per-mode agent runners; orchestrates `buildToolCatalog → discoverAllTools → composeCapabilitiesSystemPrompt → buildSystemPromptForCfg → buildAgentGraph` | `runOneShotAgent`, `streamOneShotAgent`, `buildTuiAgentRuntime` |
| `src/agent/tools/registry.ts` | Single function `buildToolCatalog(cfg, logger)` assembles the LLM-visible tool array; read-only tools always included, mutating file tools gated on `cfg.allowMutations`, `bash_run` gated on non-empty allowlist | `buildToolCatalog` |
| `src/agent/tools/file/` | `file_read`, `file_list`, `file_write`, `file_edit`, `file_append` — each is a `DynamicStructuredTool` factory; sandbox enforced by `sandbox.ts` | `createFileReadTool`, `resolveSandboxPath`, `assertMaxBytes` |
| `src/agent/tools/bash/` | `bash_run`, `bash_list_allowed`, `bash_which`; allowlist enforced by `allowlist.ts`; child env stripped by `exec.ts` | `createBashRunTool`, `parseAllowlistEntries`, `exec` |
| `src/agent/tools/web/` | `web_search`, `web_fetch`; shared `requestBudget` object caps total requests per session; pluggable search backends under `web/backends/` | `createWebSearchTool`, `createWebFetchTool` |
| `src/agent/tools/tool-help-tool.ts` | `tool_help` — reads a cached capability markdown from `capabilitiesDir` | `createToolHelpTool` |
| `src/agent/tools/types.ts` | `truncateToolResult` utility (byte-budget JSON trimmer); re-exports `handleToolError` | `truncateToolResult`, `handleToolError` |
| `src/agent/capabilities/` | CLI-tool introspection pipeline: `discover.ts` drives `--help` scraping, `cache.ts` manages `<capabilitiesDir>/<tool>.md` on disk, `compose-system-prompt.ts` assembles the "Wrapped CLI Capabilities" section from the cache | `discoverAllTools`, `composeCapabilitiesSystemPrompt`, `CapabilitySection` |
| `src/agent/providers/` | One module per LLM provider; `registry.ts` dispatches on `cfg.provider` to produce a `BaseChatModel`; `util.ts` / `util.spec.ts` hold shared helpers | `createLLM`, provider factories |
| `src/agent/logging.ts` | JSONL session logger; 8 event kinds (`session_start`, `user_prompt`, `llm_chunk`, `llm_final`, `tool_call`, `tool_result`, `error`, `session_end`) | `createLogger`, `Logger`, `CLI_VERSION` |
| `src/commands/` | `agent.ts` (main run subcommand), `show-capabilities.ts`, `refresh-capabilities.ts` | `runAgentCommand`, `runShowCapabilities`, `runRefreshCapabilities` |
| `src/tui/` | Ink-style TUI: `controller.ts` ties TUI lifecycle to `streamOneShotAgent`; `slash/` handles `/`-prefixed commands; `input/`, `transcript/`, `spinner.ts`, `clipboard.ts` | `TuiController`, `SlashCommandRegistry`, `LineEditor` |
| `src/util/` | `redact.ts` — string redaction helper used before any output | `redactString` |
| `test_scripts/` | Manual smoke-test scripts (not picked up by Vitest); 3 files only | — |

## 3. Conventions

- **Tool factory pattern** (`src/agent/tools/file/read-tool.ts:15`): every standard tool is a
  named factory function `createXxxTool(cfg: AgentConfig, ...): DynamicStructuredTool` that
  captures `cfg` in closure. Tools carry a Zod schema, a stable `name` string, and a
  `description` string. No class inheritance — plain `DynamicStructuredTool` instantiation.

- **Error handling contract** (`src/errors.ts:159`): `handleToolError` converts all
  `CliAgentError` subclasses to a JSON string `{ error: { code, message, details } }` for
  recoverable errors; `ConfigurationError` and `AuthError` are re-thrown (fatal). All tool
  `func` implementations use `try/catch → handleToolError(err)` at the bottom.

- **No-fallback config rule** (`src/config/agent-config.ts:686`): `resolveProvider` throws
  `ConfigurationError` if the provider is not set. The same pattern applies throughout — no
  `?? default` for required settings. The `BUILTIN_DEFAULT_SYSTEM_PROMPT` constant is a
  bootstrap seed, not a runtime fallback; if the file is missing, `UsageError` is thrown.

- **Four-tier env layering** (`src/config/agent-config.ts:511`): shell env (wins) →
  `~/.tool-agents/cli-agent/.env` → `./.env` → `config.json`. CLI flags are applied on top.
  Each tier only fills gaps (`layered[k] === undefined`), so shell always wins. The `ALL_ENV_KEYS`
  whitelist prevents env-pollution leakage into the agent.

- **Vitest + `src/**/*.spec.ts` glob** (`vitest.config.ts:7`): specs co-located with their
  modules, not in a separate `__tests__/` directory. `environment: 'node'`. Coverage via
  `@vitest/coverage-v8`. 130 test cases across 18 spec files. `test_scripts/` contains only
  manual smoke scripts and is excluded from automated test runs.

- **Import style** (`src/agent/run.ts:9`): named imports everywhere; `.js` extensions on all
  local imports (ESM, `"type": "module"`); no default exports from internal modules; provider
  env read only through the frozen `ProviderEnvSnapshot` struct, never from `process.env`
  directly at tool call time.

## 4. Integration Points

### 4.1 Standard tool registration — In Scope

**How existing tools are registered, exported, and bound:**

- `src/agent/tools/registry.ts` — `buildToolCatalog(cfg, logger)` (line 23): the single
  authoritative assembly point. Returns `AnyTool[]`. Read-only tools always present; mutating
  file tools conditionally appended when `cfg.allowMutations === true` (line 40);
  `bash_run` conditionally appended when the allowlist is non-empty (line 49). **New `agent-tools`
  entries must be added here**, following the same three-group pattern (always-on / mutation-gated /
  conditionally-on).

- Each tool group lives under `src/agent/tools/<group>/` as one or more factory files.
  `registry.ts` imports from those factories. The new group should be placed at
  `src/agent/tools/agent-tools/` with a barrel import in `registry.ts`.

- `src/agent/run.ts` — `buildToolCatalog` called at lines 29, 127, 226, 265. The result is
  passed directly into `buildAgentGraph` (line 71, 164, 250, 289). No secondary registration
  step: adding a tool to `buildToolCatalog`'s return value makes it immediately LLM-visible.

- `src/agent/graph.ts:44` — `createReactAgent({ llm, tools, stateModifier: systemPrompt, ... })`:
  the tool array from `buildToolCatalog` is passed as `tools`; the system prompt string is
  passed as `stateModifier`. There is no per-graph tool filter — all tools returned by the
  catalog are bound.

**Mutation gating hook** (`registry.ts:40-47`): pattern to replicate for any mutating
`agent-tools` entry:
```typescript
const mutatingAgentTools: AnyTool[] = cfg.allowMutations
  ? [ createAgtMutateTool(cfg) ]
  : [];
```

### 4.2 System-prompt assembly — factual reconciliation

**Verdict: the `system-prompt-blocks/` directory does NOT exist** and was never implemented.
The request's description of "named capability blocks" reflects a planned but unrealized future
state. The authoritative architecture is:

1. **Base file** — `~/.tool-agents/cli-agent/capabilities/system-prompt.md` (path in
   `cfg.systemPromptPath`). Seeded once from `BUILTIN_DEFAULT_SYSTEM_PROMPT`; user-editable.
   Selected via `--system-prompt <path|name>` → `CLI_AGENT_SYSTEM_PROMPT` env var →
   `config.json systemPromptFile` → bootstrapped default.

2. **Capabilities section** — `src/agent/capabilities/compose-system-prompt.ts:56`,
   `composeCapabilitiesSystemPrompt(capabilitiesDir, tools, maxBytesPerTool)`:
   reads `<capabilitiesDir>/<toolname>.md` cache files for each CLI tool in `cfg.tools`
   and builds the `## Wrapped CLI Capabilities` block. This is for *wrapped CLI tools only*
   (the ones passed with `--tool`), not for standard cross-cutting tools.

3. **Standard tool descriptions** live inside the base file (`system-prompt.md`) as free-form
   prose (lines 48-65 of `BUILTIN_DEFAULT_SYSTEM_PROMPT`). They are **not** assembled from
   separate block files at runtime — they are static text in the base prompt.

4. **User addenda** — `--system <text>` → `cfg.systemAppendText`; `--system-file <path>` →
   `cfg.systemAppendFile`. Both appended under `## User-provided instructions` header by
   `buildSystemPromptForCfg` (`src/agent/system-prompt.ts:106`).

**Assembly call chain** (same in all three run modes):
```
composeCapabilitiesSystemPrompt(...)       → capSection: string
buildSystemPromptForCfg(cfg, capSection)   → systemPrompt: string
buildAgentGraph(llm, tools, systemPrompt)  → graph bound with stateModifier
```

**Integration landing point for new tool descriptions:** The new `agent-tools` standard block
must either (a) be appended to the static base file text (simplest, but not runtime-toggleable)
or (b) be injected as a programmatic extension to `buildSystemPromptForCfg` / inserted between
the capabilities section and the `--system` addenda. Option (b) requires adding a new parameter
or a block-composition step in `src/agent/system-prompt.ts` — this is the file to modify.

### 4.3 Capability/block model

The current "block" model has only two runtime-assembled segments:

| Segment | Source | Toggled by |
|---|---|---|
| Base text | `cfg.systemPromptPath` file | `--system-prompt` / `CLI_AGENT_SYSTEM_PROMPT` / `config.json systemPromptFile` |
| Capabilities section | `compose-system-prompt.ts` reading `<tool>.md` cache files | `cfg.tools` list (only populated when `--tool` flags are passed) |
| User addendum (inline) | `cfg.systemAppendText` | `--system <text>` |
| User addendum (file) | `cfg.systemAppendFile` | `--system-file <path>` |

There is no named-block registry, no `system-prompt-blocks/` directory, and no per-block
opt-out mechanism today. The integration must introduce this concept or rely on a simpler
programmatic approach.

### 4.4 Configuration loading chain — In Scope

**File:** `src/config/agent-config.ts:500` — `loadAgentConfig(flags, opts)`

**Four-tier precedence (Policy A — shell-wins):**

| Tier | Source | Wins over |
|---|---|---|
| 1 (baseline) | `process.env` (shell) | everything below |
| 2 | `~/.tool-agents/cli-agent/.env` | tiers 3 & 4 only |
| 3 | `./.env` (local project) | tier 4 only |
| 4 (top) | CLI flags | nothing (overrides all) |

`config.json` at `~/.tool-agents/cli-agent/config.json` is read in parallel and fills in
structural settings (`provider`, `model`, `tools`, `bash`, etc.). CLI flags override
`config.json` values.

**`AgentConfigFile` interface** (`agent-config.ts:82`): new opt-out keys for `agent-tools`
must be added here. Suggested new field: `readonly disableAgentTools?: boolean`.

**`OTHER_ENV_KEYS` whitelist** (`agent-config.ts:419`): any new env var (e.g.,
`CLI_AGENT_DISABLE_AGENT_TOOLS`) must be added to this array to be recognized during env
merging.

**`AgentConfig` interface** (`agent-config.ts:124`): the resolved, frozen runtime config.
A new field (e.g., `readonly disableAgentTools: boolean`) must be added here and populated
in `loadAgentConfig`'s return object.

### 4.5 Test framework and current test coverage

**Framework:** Vitest (`vitest run`), co-located `*.spec.ts` files, `src/**/*.spec.ts` glob.
**130 test cases** across 18 spec files. No `test_scripts/` integration with Vitest.

Key spec files relevant to the integration:

| Spec file | What it tests | New tests needed here |
|---|---|---|
| `src/agent/tools/file/sandbox.spec.ts` | Sandbox path resolution | No — model for new tool unit tests |
| `src/agent/tools/types.spec.ts` | `truncateToolResult` | No |
| `src/agent/tools/bash/allowlist.spec.ts` | Allowlist parsing | No |
| `src/agent/system-prompt.spec.ts` | `buildSystemPrompt`, `buildSystemPromptForCfg` | Yes — add opt-out block presence/absence tests |
| `src/config/agent-config.spec.ts` | `loadAgentConfig` (largest spec, ~10 KB) | Yes — add new flag/env/config.json key tests |
| `src/commands/agent.spec.ts` | End-to-end command wiring | Possibly — verify tools absent from catalog when opt-out engaged |

New unit tests for each wrapped `agent-tools` tool should be placed as:
`src/agent/tools/agent-tools/<tool-name>.spec.ts` (co-located, consistent with convention).

### 4.6 Build / test / lint commands

| Command | Invocation |
|---|---|
| Build | `npm run build` → `tsc -p tsconfig.json && chmod +x dist/cli.js` |
| Dev run (no build) | `npm run dev` → `tsx src/cli.ts` |
| Type-check only | `npm run typecheck` → `tsc --noEmit -p tsconfig.json` |
| Test | `npm test` → `vitest run` |
| Test watch | `npm run test:watch` → `vitest` |
| Test coverage | `npm run test:coverage` → `vitest run --coverage` |
| Clean | `npm run clean` → `rm -rf dist` |
| Publish prep | `npm run prepublishOnly` → clean + build + test |

There is no separate lint script (no ESLint config file detected). Type-checking (`tsc --noEmit`)
is the primary static analysis tool.

### 4.7 Out of scope (modules not implicated by the request)

- `src/agent/capabilities/` — the CLI-tool introspection pipeline (`discoverAllTools`,
  `cache.ts`, `composeMarkdown.ts`, etc.). The request explicitly excludes re-architecting
  this pipeline.
- `src/agent/providers/` — LLM provider registry and all eight provider modules. No changes
  needed.
- `src/tui/` — TUI subsystem, except possibly a minimal slash-command addition if the chosen
  opt-out pattern requires a `/tools` toggle command.
- `src/agent/logging.ts` — JSONL logging schema. No new event kinds required.
- `src/util/redact.ts` — credential redaction. Used as-is by new tools via `handleToolError`.
- `src/commands/show-capabilities.ts`, `src/commands/refresh-capabilities.ts` — capability
  discovery commands. Out of scope.

### 4.8 New integration points (absent today)

| Gap | Recommended landing location |
|---|---|
| `src/agent/tools/agent-tools/` directory | Create new, one module per wrapped tool (e.g., `<name>-tool.ts`) + `index.ts` barrel |
| `disableAgentTools` in `AgentConfigFile` | `src/config/agent-config.ts` — `AgentConfigFile` interface + `AgentConfig` interface + `loadAgentConfig` resolution logic |
| `CLI_AGENT_DISABLE_AGENT_TOOLS` env var | `src/config/agent-config.ts` — `OTHER_ENV_KEYS` array |
| `--no-agent-tools` CLI flag | `src/cli.ts` — new `.option()` entry mapped to `AgentCliFlags.disableAgentTools` |
| Standard-tool description block assembly | `src/agent/system-prompt.ts` — new parameter in `buildSystemPromptForCfg` or a new exported function `buildStandardToolsBlock(cfg)` injected into `run.ts` |
| System-prompt block opt-out test | `src/agent/system-prompt.spec.ts` — new `describe` block |
| Per-tool unit tests | `src/agent/tools/agent-tools/<name>.spec.ts` |

## 5. Notes

- **No `system-prompt-blocks/` directory exists** (confirmed by full directory traversal).
  The request's description of a "block-based assembly system" is aspirational, not current
  reality. Any downstream plan must either implement the block system first or build on the
  simpler single-file-plus-programmatic-injection approach. This is the highest-priority
  factual clarification for the feasibility assessment.

- **Standard tool descriptions are embedded in the static base file**, not assembled at
  runtime. The `compose-system-prompt.ts` module is used exclusively for *wrapped CLI tools*
  (those in `cfg.tools` from `--tool` flags). Adding new standard tools therefore requires
  either editing the static base file text or injecting a runtime-composed block in
  `buildSystemPromptForCfg` — there is no existing hook for the latter.

- **130 tests currently pass** (up from the "104+" mentioned in the request — the codebase has
  grown). Any new work must keep this baseline green.

- **No ESLint or Prettier config is present** — the only linting surface is `tsc --noEmit`.
  New code should follow the existing conventions (named imports, `.js` extensions, Zod schemas,
  `DynamicStructuredTool` factories) to stay consistent, but there is no automated style
  enforcer beyond TypeScript's type system.
