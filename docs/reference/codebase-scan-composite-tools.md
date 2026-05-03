---
language: typescript
framework: none
package_manager: npm
build_command: "tsc -p tsconfig.json && npm run postbuild:assets && npm run postbuild:chmod"
test_command: vitest run
lint_command: null
entry_points:
  - src/cli.ts
last_scanned_commit: 8461783c45cac88672a9d496e3e4f52bf3649c69
scanned_for_request: refined-request-composite-tools.md
scanned_at: "2026-05-02T20:00:00Z"
---

# Codebase Scan — cli-agent (composite intelligent tools)

## 1. Project Overview

cli-agent is a TypeScript/Node.js CLI binary (`dist/cli.js`) built on LangGraph and LangChain. It wraps external CLI tools into a ReAct agent loop, auto-introspecting `--help` trees to produce cached capability documents stored at `~/.tool-agents/cli-agent/`. The main entry point is `src/cli.ts` (Commander-based); agent runtime lives in `src/agent/`; configuration loading with a four-tier precedence chain lives in `src/config/agent-config.ts`. Tests use Vitest with module-level `vi.mock`.

---

## 2. Module Map

| Path | Purpose | Representative symbols |
|---|---|---|
| `src/cli.ts` | Commander program definition; all flag and subcommand declarations; `parseAsync` entrypoint | `program`, `collectTool`, `handleErrors` |
| `src/commands/` | One file per subcommand handler; bridge between Commander opts and agent internals | `runAgentCommand`, `runRefreshCapabilities`, `runExtractRecipes` |
| `src/config/agent-config.ts` | Four-tier config loader; `AgentConfig` / `AgentCliFlags` types; `bootstrapAgentDir` | `loadAgentConfig`, `bootstrapAgentDir`, `AgentCliFlags` |
| `src/config/profile-*.ts` | Profile schema, codec, and loader for plan-005 profiles | `loadProfile`, `ProfileSchema`, `serializeProfile` |
| `src/agent/run.ts` | Agent runner trio: `runOneShotAgent`, `streamOneShotAgent`, `buildTuiAgentRuntime` | `runOneShotAgent`, `streamOneShotAgent`, `buildTuiAgentRuntime` |
| `src/agent/graph.ts` | LangGraph ReAct graph builder | `buildAgentGraph`, `runOneShot`, `streamOneShot` |
| `src/agent/system-prompt.ts` | System prompt builder and on-disk loader | `buildSystemPrompt`, `buildSystemPromptForCfg`, `BUILTIN_DEFAULT_SYSTEM_PROMPT` |
| `src/agent/providers/` | One file per LLM provider + `registry.ts` | `createLLM`, `REGISTRY` |
| `src/agent/capabilities/` | Capability discovery, caching, and system-prompt composition | `discoverTool`, `composeCapabilityDoc`, `readCacheEntry`, `composeCapabilitiesSystemPrompt` |
| `src/agent/tools/registry.ts` | Tool catalog builder consumed by run.ts | `buildToolCatalog`, `ToolCatalog` |
| `src/agent/tools/` subdirs | Per-tool factories: `bash/`, `file/`, `web/`, `agent-tools/` | `createBashRunTool`, `createFileReadTool`, `createWebSearchTool` |
| `src/tui/` | Interactive TUI (ink-based) | `TuiController`, `TuiApp` |
| `src/util/` | Redaction helpers | `redactString` |
| `src/errors.ts` | Error hierarchy and exit codes | `CliAgentError`, `UsageError`, `ConfigurationError` |

---

## 3. Conventions

- **Import style**: Named ESM imports throughout; `.js` extension on all local imports (required for Node.js ESM). Example: `import { createLLM } from './providers/registry.js'` (`src/agent/run.ts:9`).
- **Error handling**: All public entry points throw typed subclasses of `CliAgentError` (`src/errors.ts`). The CLI layer catches in `handleErrors` (`src/cli.ts:366`) and maps to exit codes (0/1/2/3/4/5/6/130). No uncaught rejections.
- **Config-no-fallback rule**: Every required setting that cannot be resolved raises `ConfigurationError` or `UsageError` — never substitutes a silent default. Applied literally in `loadAgentConfig` (`src/config/agent-config.ts:949`).
- **LLM stub pattern in tests**: `vi.spyOn(registry, 'createLLM').mockReturnValue({ invoke: async () => ({ content: '...' }) } as unknown as ReturnType<typeof registry.createLLM>)` — observed in `src/commands/extract-recipes.spec.ts:42`. No `vi.mock('@langchain/anthropic')` — stubs operate at the `createLLM` factory boundary, not the LangChain import level.
- **Filesystem mocking**: Tests stub `node:fs/promises` via `vi.mock('node:fs/promises', async (importOriginal) => { ... })` + override selected methods — observed in `src/config/agent-config.spec.ts:16`. Binary and module mocks use `vi.mock()` with `importOriginal` to preserve untouched exports.
- **File modes**: `0o700` directories, `0o600` regular files, explicit `chmod` after `mkdir`/`writeFile` to harden against umask — `bootstrapAgentDir` (`src/config/agent-config.ts:343–385`) is the canonical reference.

---

## 4. Integration Points

### IP-1 — CLI flag plumbing for `--treat-as-tool`

**File**: `src/cli.ts`

New flag group is added alongside the existing default-command block (lines 49–93). The pattern for a boolean flag with default `false`:
```
.option('--treat-as-tool', 'Declare this invocation as a composite intelligent tool', false)
```
The CLI opts object (`opts: Record<string, unknown>`) is manually destructured and forwarded to `runAgentCommand` as a field on the `AgentCliFlags`-shaped argument (line 103–133). New flags must therefore be:

1. Declared on the `AgentCliFlags` interface (`src/config/agent-config.ts:247–299`) — this is the TS type that flows through `loadAgentConfig`.
2. Extracted from `opts` in the `.action()` handler (`src/cli.ts:94–134`) and passed into `runAgentCommand` / the new composite handler.
3. The `OTHER_ENV_KEYS` array (`src/config/agent-config.ts:588–610`) must include any env-var companion (`CLI_AGENT_COMPOSITE_BUDGET`, `CLI_AGENT_VIRTUAL_DISPATCH`) so they are captured in the layered env snapshot.

**Help flag**: Commander uses its default `--help` / `-h` handling. There is NO custom `exitOverride` or `configureHelp` hook currently in `src/cli.ts`. Commander processes `--help` before `.action()` fires — so `--treat-as-tool --help` would print Commander's own help unless the implementation intercepts `--help` in the action handler. The implementation strategy is:

- Register `--help` as a regular non-hidden option (`--help` conflicts with Commander's built-in; use `program.helpOption(false)` to disable Commander's auto-help, then add `--help` as a custom flag, OR suppress Commander help via `program.exitOverride()` + `try/catch` on `parseAsync`). The simplest approach given the codebase: keep Commander's default `--help` but add `--treat-as-tool-help` or intercept inside `.action()` by checking `opts['help']` after calling `program.exitOverride()`.
- When `--treat-as-tool` AND `--help` are both present AND tools list is non-empty, the `.action()` handler short-circuits to the synthesis pipeline instead of calling `runAgentCommand`.

**Current `--refresh-capabilities` flag**: declared at line 74 as `--refresh-capabilities` (boolean, default `false`); arrives in `AgentCliFlags` as `refreshCapabilities?: boolean` (line 268). The existing subcommand `refresh-capabilities` (`src/cli.ts:155–175`) calls `runRefreshCapabilities` directly.

---

### IP-2 — `--help` interception path

**Files**: `src/cli.ts:384` (`program.parseAsync(process.argv)`); Commander v12 internals.

Commander's default behavior: when `--help` appears anywhere in `argv`, Commander calls `program.outputHelp()` and then `process.exit(0)` BEFORE the `.action()` callback fires. This means the `.action()` body never executes for `cli-agent --help`.

**Required change to preserve existing behavior and add composite branch**:

```typescript
// Recommended pattern: disable Commander's auto-help, register --help manually
program.helpOption(false);  // disables Commander's -h / --help built-in
program.option('--help', 'Show help (composite-aware)', false);
// In .action():
if (opts['help']) {
  if (opts['treatAsTool'] && tools.length > 0) {
    // composite synthesis branch
  } else if (opts['treatAsTool'] && tools.length === 0) {
    throw new UsageError('composite synthesis requires at least one --tool argument');
  } else {
    program.outputHelp();  // original behavior
    process.exit(0);
  }
}
```

This is the ONLY safe path that avoids behavior drift for non-composite invocations (NFR-CMP-001).

---

### IP-3 — Capability discovery / cache layer

**Files**:

- `src/agent/capabilities/cache.ts` — `readCacheEntry` / `writeCacheEntry` / `toolCapabilityPath`
- `src/agent/capabilities/composeMarkdown.ts` — `composeCapabilityDoc` / `CAPABILITY_SCHEMA_VERSION`
- `src/agent/capabilities/compose-system-prompt.ts` — `composeCapabilitiesSystemPrompt`
- `src/agent/capabilities/discover.ts` — `discoverTool` / `discoverAllTools`

**Schema constraints the composite synthesizer MUST satisfy** (so the doc passes existing readers):

1. YAML frontmatter delimited by `---` on its own line, at document start (`cache.ts:39–68`)
2. Frontmatter key `schemaVersion: <n>` present and parseable as `Number` (`cache.ts:64`, `cache.ts:77`)
3. For existing `readCacheEntry` to return a hit: `fm.schemaVersion === SUPPORTED_SCHEMA_VERSION` (`cache.ts:77`). Currently `SUPPORTED_SCHEMA_VERSION === CAPABILITY_SCHEMA_VERSION === 2`. Schema 3 composite docs will fail this check — **intentional**: `readCacheEntry` is the discovery-doc reader; composite docs live under a different subdirectory (`capabilities/composite/`) and will be read by a new composite-specific reader. The `composeCapabilitiesSystemPrompt` reader (`compose-system-prompt.ts:99`) does NOT call `readCacheEntry` — it reads raw file content directly. So composite docs under `capabilities/composite/<id>.md` will load transparently in the system prompt composer as long as they have:
   - `<!-- AUTO-GENERATED:START hash=<hex> -->` marker (`compose-system-prompt.ts:19–35`)
   - `<!-- AUTO-GENERATED:END -->` marker
   - `<!-- USER-RECIPES:START -->` / `<!-- USER-RECIPES:END -->` markers
   - `<!-- USER-NOTES:START -->` / `<!-- USER-NOTES:END -->` markers
   - H1 heading: `# <tool-name> — capability document` (expected by the compact-entry fallback)
4. `extractUserRecipes` / `extractUserNotes` (`composeMarkdown.ts:50–67`) look for marker strings verbatim — composite doc must include these pairs even if initially empty.
5. The frontmatter `manRef` field: composite docs should set `manRef: null` or omit entirely (matching A-10 in the request). The `extractManRef` inline parser in `compose-system-prompt.ts:62–69` returns null if absent.

**New composite cache path**: `~/.tool-agents/cli-agent/capabilities/composite/<id>.md`. The `composeCapabilitiesSystemPrompt` function currently builds paths as `path.join(capabilitiesDir, `${tool}.md`)` (`compose-system-prompt.ts:99`). For virtual-tool composite consumption, the outer agent must receive `capabilitiesDir` pointing to a directory where `<composite-id>.md` exists. The simplest path: symlink or copy the composite doc into `capabilities/<id>.md`, OR extend `composeCapabilitiesSystemPrompt` to also check `capabilities/composite/<id>.md` as a fallback.

---

### IP-4 — Schema versioning: current state and schema-3 migration

**Current schema version**: `CAPABILITY_SCHEMA_VERSION = 2` (`src/agent/capabilities/composeMarkdown.ts:16`).

**All read sites that check `schemaVersion`**:

| Site | File:Line | Check | Impact of schema 3 |
|---|---|---|---|
| `SUPPORTED_SCHEMA_VERSION` constant | `cache.ts:30` | `=== CAPABILITY_SCHEMA_VERSION` (= 2) | Schema-3 composite docs returned as cache miss by `readCacheEntry` — correct, composite docs are NOT member-tool docs |
| `readCacheEntry` equality check | `cache.ts:77` | `fm.schemaVersion !== SUPPORTED_SCHEMA_VERSION` → return null | Same as above — miss for schema 3 |
| `parseFrontmatter` | `cache.ts:64` | `Number(obj['schemaVersion'] ?? 0)` — coerces to number | Parses `3` fine |
| Discovery placeholder | `discover.ts:199` | Hard-codes `schemaVersion: 1` in the not-found placeholder | Not affected by schema 3 |
| `composeCapabilityDoc` | `composeMarkdown.ts:94` | `opts.schemaVersion ?? CAPABILITY_SCHEMA_VERSION` — accepts override | Composite composer can pass `schemaVersion: 3` |
| `compose-system-prompt.ts` | entire file | No schema version check at all | Transparent to schema 3 |
| `agent-config.ts:558–564` | config.json schema | Checks `CONFIG_SCHEMA_VERSION = 1` for config.json only | Unrelated to capability schema |

**Conclusion**: The only code that needs updating for schema-3 acceptance is `cache.ts:77` if the composite reader reuses `readCacheEntry`. If the composite reader is a separate function (recommended), `cache.ts` is untouched and schema-2 member docs continue to be loaded by the existing reader without modification.

---

### IP-5 — LLM provider wiring

**Files**: `src/agent/providers/registry.ts`, `src/config/agent-config.ts`

`createLLM(cfg: AgentConfig): BaseChatModel` (`providers/registry.ts:24–30`) — this is the single factory. It dispatches on `cfg.provider` through a `REGISTRY` map to the per-provider factory. Each factory receives the full `AgentConfig` (which carries `providerEnv` — the frozen credential snapshot).

**Provider resolution in `loadAgentConfig`** (`agent-config.ts:773–784`):
```
provider = resolveProvider(
  flags.provider              // CLI flag (tier 4)
  ?? layered['AGENT_PROVIDER']  // env var (tier 1–3)
  ?? activeProfileData?.cliParams?.provider  // profile (tier 5 equiv)
  ?? configFile?.provider     // config.json (tier 1 equiv in file)
)
model = flags.model ?? layered['AGENT_MODEL'] ?? activeProfileData?.cliParams?.model ?? configFile?.model ?? defaultModelForProvider(provider)
```

**For the composite synthesis pipeline**: call `createLLM(cfg)` where `cfg` is the AgentConfig already resolved by `loadAgentConfig`. No additional resolution is needed — the same `cfg` that would have been passed to `runAgentCommand` is available in the composite handler. The `cfg.model` and `cfg.provider` fields carry the user's resolved model choice (including profile overrides per FR-CMP-019).

**BaseChatModel interface** (`providers/types.ts`): the synthesis pipeline calls `.invoke(messages)` on the model, returning `{ content: string }`. Same API used by `extract-recipes.ts`.

---

### IP-6 — Tool registration path (`buildToolCatalog`)

**File**: `src/agent/tools/registry.ts:48–137`

`buildToolCatalog(cfg: AgentConfig, logger: Logger): ToolCatalog` assembles native tools (file, bash, web, agent-tools pack), applies profile scoping, and returns `{ tools, agentToolsMeta }`. The function does NOT consult `cfg.tools` (the list of wrapped CLI binaries) — those appear only in the system prompt via `composeCapabilitiesSystemPrompt`. The bash_run tool executes any allow-listed binary; the "wrapped tool" pattern is prompt-only, not a distinct LangChain tool type.

**Virtual-tool registration (form c)** must therefore hook in at one of two points:

1. **Registry extension** (preferred by the request): scan `~/.tool-agents/cli-agent/composites/*/manifest.json` at startup and inject a new `DynamicStructuredTool` (a "meta-tool") into the `assembled` array at `registry.ts:84–89`. This meta-tool's `invoke` re-enters the agent loop (child-process or in-process mode). The tool's `name` is the composite id; its description is loaded from the `capabilityDocPath` in the manifest.
2. **System-prompt only** (form a / form b): composite docs appearing in `capabilitiesDir` are already consumed transparently by `composeCapabilitiesSystemPrompt` — no registry change needed. The LLM addresses the composite via `bash_run` (which calls the wrapper shim).

**Landing site for virtual-tool scan**: a new function `loadVirtualTools(cfg, logger)` called between `buildAgentToolsGroup` (line 82) and `applyProfileToolScoping` (line 96), so virtual tools are subject to profile scoping just like native tools.

---

### IP-7 — PATH / wrapper-script artifacts and `bootstrapAgentDir`

**File**: `src/config/agent-config.ts:332–459`

`bootstrapAgentDir(dir?, opts)` creates:
```
~/.tool-agents/cli-agent/           (mode 0700)
~/.tool-agents/cli-agent/.env       (mode 0600, seeded with placeholders)
~/.tool-agents/cli-agent/logs/      (mode 0700)
~/.tool-agents/cli-agent/capabilities/  (mode 0700)
~/.tool-agents/cli-agent/profiles/  (mode 0700)
~/.tool-agents/cli-agent/tool-prompts/  (mode 0700, seeded with builtin overlays)
```

**Closest analogue for composite artifacts**: `bootstrapAgentDir` should grow two new directory creations (or a helper `bootstrapCompositeDirs` can be called at startup):
```
~/.tool-agents/cli-agent/capabilities/composite/  (mode 0700)
~/.tool-agents/cli-agent/composites/              (mode 0700)
```

The `agentCapabilitiesDir()` helper (`agent-config.ts:312–314`) returns `path.join(agentToolAgentsDir(), 'capabilities')`. A new helper:
```typescript
export function agentCompositeCapabilitiesDir(): string {
  return path.join(agentCapabilitiesDir(), 'composite');
}
export function agentCompositesDir(): string {
  return path.join(agentToolAgentsDir(), 'composites');
}
```

The `AgentConfig` interface needs `compositeCapabilitiesDir` and `compositesDir` fields (parallel to `capabilitiesDir` and `logsDir`) populated by `loadAgentConfig` (line 915–917 pattern).

---

### IP-8 — System-prompt assembly

**Files**: `src/agent/system-prompt.ts`, `src/agent/capabilities/compose-system-prompt.ts`

System prompt assembly order (`system-prompt.ts:85–111`):
```
baseText (loaded from cfg.systemPromptPath)
  + capabilitiesSection (output of composeCapabilitiesSystemPrompt)
  + agentToolsBlock (from buildAgentToolsPromptBlock)
  + customSystemText (--system / --system-file addendum)
```

`composeCapabilitiesSystemPrompt(capabilitiesDir, tools, maxBytesPerTool)` (`compose-system-prompt.ts:89–158`) iterates `tools`, reads `<capabilitiesDir>/<tool>.md`, and assembles an AUTO-GENERATED + USER-RECIPES + USER-NOTES section per tool.

**For the synthesis Stage-2 system prompt** (composing the composite capability doc itself): the synthesizer does NOT use the normal agent system prompt. It builds its own two-stage prompt using the constituent capability docs as context, then calls `createLLM(cfg).invoke(messages)` directly (same pattern as `extract-recipes.ts`). The shape of the composite output must look like what `composeCapabilityDoc` normally produces so that `composeCapabilitiesSystemPrompt` can consume it unchanged on the outer agent's side.

---

### IP-9 — Existing `discover-capabilities` / `refresh-capabilities` subcommands

**CLI registration** (`src/cli.ts`):
- `show-capabilities` subcommand: lines 137–151 — prints cached doc for one tool via `runShowCapabilities`.
- `refresh-capabilities` subcommand: lines 153–175 — calls `runRefreshCapabilities(toolName, opts)` which calls `discoverTool(..., forceRefresh=true)`.
- `--refresh-capabilities` flag on the default command: line 74 — boolean flag; passed to `runAgentCommand` → `discoverAllTools(..., forceRefresh)`.

**`runRefreshCapabilities`** (`src/commands/refresh-capabilities.ts:13–68`): pattern to mirror for `composite synthesize`:
1. `loadAgentConfig(opts)` — resolves full config from flags.
2. `createLogger(...)` — standard JSONL logger.
3. `createLLM(cfg)` — LLM factory.
4. Loop over tools, call `discoverTool(..., forceRefresh=true, ...)`.

**`discoverTool`** (`src/agent/capabilities/discover.ts`): signature:
```typescript
discoverTool(
  tool: string,
  cfg: AgentConfig,
  llm: BaseChatModel,
  logger: Logger,
  forceRefresh: boolean,
  deadline: number,
  onPhase?: DiscoveryProgress,
  forceFullInvestigation?: boolean,
): Promise<DiscoveryResult>
```

**New `composite synthesize` subcommand** (FR-CMP-022) should mirror this pattern. The `--regenerate-capabilities` flag without `--treat-as-tool` should call `runRefreshCapabilities` unchanged (existing path).

---

### IP-10 — Test conventions / LLM stub pattern

**Primary pattern** (`src/commands/extract-recipes.spec.ts:41–44`):
```typescript
vi.spyOn(registry, 'createLLM').mockReturnValue({
  invoke: async () => ({ content: '<canned LLM output string>' }),
} as unknown as ReturnType<typeof registry.createLLM>);
```
This intercepts at the `createLLM` boundary in `src/agent/providers/registry.ts`, so the synthesis pipeline's `createLLM(cfg)` call is fully stubbed without touching any LangChain imports.

**For snapshot-based synthesis testing** (NFR-CMP-002): extend the pattern to a keyed dispatcher:
```typescript
const TRANSCRIPT: Record<string, string> = {
  '<sha256-of-stage1-prompt>': '<canned-stage1-output>',
  '<sha256-of-stage2-prompt>': '<canned-stage2-output>',
};
vi.spyOn(registry, 'createLLM').mockReturnValue({
  invoke: async (messages) => {
    const key = sha256(JSON.stringify(messages)).slice(0, 16);
    const content = TRANSCRIPT[key];
    if (!content) throw new Error(`No canned response for prompt digest ${key}`);
    return { content };
  },
} as unknown as ReturnType<typeof registry.createLLM>);
```
Transcript JSON files should live in `test_scripts/fixtures/synthesis-transcripts/` (per project conventions — all test scripts in `test_scripts/`).

**Other mock patterns used**:
- `vi.mock('node:fs/promises', async (importOriginal) => {...})` — for tests that need hermetic file I/O without real disk.
- `vi.mock('./invalidate.js', async (importOriginal) => {...})` — for discover tests that stub `getBinaryInfo`.
- `vi.mock('./manref.js', () => ({ detectManRef: vi.fn().mockResolvedValue(...) }))` — for man-page tests.

---

### IP-11 — Lint, build, test commands (frontmatter confirmed)

| Command | Value |
|---|---|
| **Build** | `npm run build` → `tsc -p tsconfig.json && node scripts/copy-vendored-assets.mjs && chmod +x dist/cli.js` |
| **Test** | `npm test` → `vitest run` |
| **Test watch** | `npm run test:watch` → `vitest` |
| **Test coverage** | `npm run test:coverage` → `vitest run --coverage` |
| **Type-check only** | `npm run typecheck` → `tsc --noEmit -p tsconfig.json` |
| **Lint** | No ESLint / Prettier script defined in `package.json` |
| **Dev run** | `npm run dev` → `tsx src/cli.ts` |

---

### Out of Scope (modules not implicated by this request)

- `src/tui/` — TUI/ink layer. No composite-related changes in v1 (FR-CMP-* explicitly defers TUI slash commands).
- `src/agent/tools/bash/`, `src/agent/tools/file/`, `src/agent/tools/web/` — individual tool factories. Unchanged.
- `src/agent/tools/agent-tools/` — agent-tools pack (glob, grep, multiedit, patch, todo). Unchanged.
- `src/agent/checkpoint-store.ts` — LangGraph checkpoint persistence. Unchanged.
- `src/agent/logging.ts` — existing JSONL logger (new event kinds are additive, but the Logger class and `createLogger` are reused as-is).
- `src/commands/profile/` — profile CRUD commands. Profile passthrough (FR-CMP-019) is read-only on the existing profile loader.

### New Integration Points (not yet in the codebase)

| New module | Recommended landing location | Purpose |
|---|---|---|
| Composite synthesizer | `src/agent/composite/synthesizer.ts` | Two-stage LLM pipeline; imports `createLLM`, `readCacheEntry` |
| Composite cache reader | `src/agent/composite/cache.ts` | Reads/writes `capabilities/composite/<id>.md`; schema-3 frontmatter parser |
| Composite manifest | `src/agent/composite/manifest.ts` | Reads/writes `composites/<id>/manifest.json`; manifest schema |
| Virtual-tool registry | `src/agent/composite/virtual-registry.ts` | Scans `composites/*/manifest.json`; returns `DynamicStructuredTool[]` |
| Virtual-tool dispatcher | `src/agent/composite/dispatcher.ts` | `child-process` / `in-process` dispatch; recursion guard |
| Composite subcommands | `src/commands/composite/` | `synthesize`, `list`, `show`, `delete` handlers |
| Wrapper shim writer | `src/agent/composite/shim-writer.ts` | Generates POSIX shell script; sets mode `0700` |
| CLI flag group | `src/cli-composite-flags.ts` (new, parallel to `cli-agent-tools-flags.ts`) | Maps raw Commander opts to a `CompositeCliFlags` shape |

---

## 5. Notes

- **Commander `--help` conflict is the critical blocker**: Commander v12 intercepts `--help` before `.action()` fires. The implementation MUST call `program.helpOption(false)` and register `--help` as a regular option to allow the composite help branch. This is a non-trivial behavioral change to the CLI entry point — NFR-CMP-001 regression tests must be pinned before the change is made.
- **`CAPABILITY_SCHEMA_VERSION = 2` is a module-level constant imported by `cache.ts`** (`composeMarkdown.ts:16`, `cache.ts:8,30`). Schema 3 should be declared as `COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3` in a new module (not by bumping the existing constant) to avoid invalidating all existing member-tool cache entries.
- **`composeCapabilitiesSystemPrompt` reads files by bare `<tool>.md` name** (`compose-system-prompt.ts:99`). Composite docs stored under `capabilities/composite/<id>.md` will NOT be found unless the outer agent either puts the composite in `capabilitiesDir` directly (as `<id>.md`) or the function is extended. The cleanest v1 approach is to write the composite doc to BOTH `capabilities/composite/<id>.md` (canonical) and `capabilities/<id>.md` (symlink or copy) so that the outer agent's `composeCapabilitiesSystemPrompt` picks it up unchanged.
- **No `discover-capabilities` subcommand exists** — the subcommand is `show-capabilities` (print) and `refresh-capabilities` (re-run). The new `composite synthesize` subcommand (FR-CMP-022) is the composite analogue of `refresh-capabilities`, not of a non-existent `discover-capabilities`.
