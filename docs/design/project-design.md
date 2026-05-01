# cli-agent — Project Design

## 1. Overview

`cli-agent` is a standalone Node.js CLI binary that runs a LangGraph ReAct agent wrapping
any set of external CLI tools declared at launch. It inverts the standard "agentify your
existing CLI" pattern: the agent IS the tool; the LLM-visible commands are driven through
the bash allowlist, the file toolkit, and the web toolkit.

## 2. Architecture

```
cli-agent [prompt] / -i / show-capabilities / refresh-capabilities
    │
    ▼
src/cli.ts  (Commander arg parser)
    │
    ├── loadAgentConfig(flags)          src/config/agent-config.ts
    │       Policy A (shell-wins):
    │       CLI flag > shell env > ~/.tool-agents/cli-agent/.env > config.json > throw
    │
    ├── bootstrapAgentDir()             creates ~/.tool-agents/cli-agent/{.env,logs/,capabilities/}
    │
    ├── discoverAllTools()              src/agent/capabilities/discover.ts
    │       for each tool in cfg.tools:
    │         getBinaryInfo (PATH lookup + mtime + version hash)
    │         cache check (binaryPath + mtimeMs + versionHash)
    │         if miss: runHelp (--help, -h, help <sub> fallbacks)
    │                  extractSubcommands (LLM call with Zod structured output)
    │                  composeCapabilityDoc (YAML frontmatter + AUTO-GENERATED + USER-NOTES)
    │                  writeCacheEntry (mode 0600)
    │
    ├── composeCapabilitiesSystemPrompt()    src/agent/capabilities/compose-system-prompt.ts
    │       read cached *.md files, embed in system prompt
    │       per-tool budget: full body if within maxBytesPerTool; synopsis+TOC if over
    │
    ├── buildSystemPrompt()             src/agent/system-prompt.ts
    │       base rules + cross-cutting tools addendum + capabilities section
    │
    ├── createLLM(cfg)                  src/agent/providers/registry.ts
    │       dispatches to one of 8 provider factories
    │
    ├── buildToolCatalog(cfg, logger)   src/agent/tools/registry.ts
    │       Always: file_read, file_list, bash_list_allowed, bash_which,
    │               web_search, web_fetch, tool_help
    │       + allowMutations: file_write, file_edit, file_append
    │       + allowlist non-empty: bash_run (READ-ONLY-AGENT or MUTATING mode)
    │
    ├── buildAgentGraph(llm, tools, systemPrompt, maxSteps)
    │       createReactAgent from @langchain/langgraph/prebuilt
    │       MemorySaver checkpointer (interactive mode only)
    │
    └── runOneShotAgent / runInteractiveAgent
            logger.log (session_start, user_prompt, llm_chunk, llm_final,
                        tool_call, tool_result, error, session_end)
            JSONL → ~/.tool-agents/cli-agent/logs/session-<utc>-<id>.jsonl
            latest.jsonl symlink
```

## 3. Provider Registry

| Provider id       | LangChain class             | SDK package            |
|---|---|---|
| `openai`          | `ChatOpenAI`                | `@langchain/openai`    |
| `anthropic`       | `ChatAnthropic`             | `@langchain/anthropic` |
| `gemini`          | `ChatGoogleGenerativeAI`    | `@langchain/google-genai` |
| `azure-openai`    | `AzureChatOpenAI`           | `@langchain/openai`    |
| `azure-anthropic` | `ChatAnthropic` w/ Foundry  | `@langchain/anthropic` |
| `ollama`          | `ChatOpenAI` w/ `/v1` URL   | `@langchain/openai`    |
| `litellm`         | `ChatOpenAI` w/ proxy URL   | `@langchain/openai`    |
| `mlx`             | `ChatOpenAI` w/ OPENAI_BASE_URL | `@langchain/openai` |

Factories read only from `cfg.providerEnv` (frozen snapshot). Never read `process.env` directly.

## 4. Tool Catalog

### Standard cross-cutting tools (always present)

| Tool | Mutating | Description |
|---|---|---|
| `file_read` | No | Read file content inside sandbox root |
| `file_list` | No | List directory contents |
| `file_write` | Yes* | Overwrite file |
| `file_edit` | Yes* | Find-and-replace in file |
| `file_append` | Yes* | Append to file |
| `web_search` | No | Search internet via configured backend |
| `web_fetch` | No | Fetch a URL as readable text |
| `bash_list_allowed` | No | List the bash allowlist |
| `bash_which` | No | Resolve binary on PATH |
| `bash_run` | Deviation† | Execute allow-listed binary |
| `tool_help` | No | Fetch capability doc or subcommand section |

\* Off unless `--allow-mutations`
† `bash_run` is visible whenever the allowlist is non-empty, regardless of `--allow-mutations`.
  Without `--allow-mutations`, the description carries `[READ-ONLY-AGENT]` prefix as a warning.
  This is a documented deviation from the standard spec (see configuration-guide.md).

## 5. Capability Discovery

Files under `~/.tool-agents/cli-agent/capabilities/<tool>.md`.

Cache validity: `binaryPath` + `binaryMtimeMs` + `versionHash` must all match. If any changes,
the cache is invalidated. `--refresh-capabilities` bypasses the cache entirely.

The USER-NOTES section is preserved byte-for-byte across re-introspection.

The same folder also stores ONE non-tool file: `system-prompt.md` (mode 0600), which
holds the externalized BASE system prompt (see Section 5a). The capability cache
addresses files by exact tool name (`<tool>.md`), so this reserved name does not
participate in tool discovery and does not collide with any real wrapped CLI.

## 5a. External System Prompt

The base system prompt is loaded at runtime from a file on disk, not from a TypeScript
constant. Default location: `~/.tool-agents/cli-agent/capabilities/system-prompt.md`.
The agent seeds this file with the built-in default (`BUILTIN_DEFAULT_SYSTEM_PROMPT`)
on first run; thereafter, the file on disk is the source of truth — users edit it to
change the agent's behavior without rebuilding.

The user can override the base file via:

  - CLI flag `--system-prompt <path-or-name>`
  - env var `CLI_AGENT_SYSTEM_PROMPT`
  - config.json key `systemPromptFile`

Resolution rules (same for all three sources):

  1. Absolute path                → used verbatim
  2. Bare filename                → joined onto `cfg.capabilitiesDir`
  3. Relative path with separator → joined onto `process.cwd()`

`loadAgentConfig` resolves the value, then verifies the file is readable; missing or
unreadable files raise `UsageError` (exit 2). The built-in constant is the bootstrap
seed only — it is NEVER used as a runtime fallback.

`--system <text>` and `--system-file <path>` continue to APPEND on top of whichever
base prompt is selected. Composition is centralized in `buildSystemPromptForCfg()`
(`src/agent/system-prompt.ts`) so all six call sites — the four agent runners in
`src/agent/run.ts` and the five TUI slash commands that rebuild the graph
(`/new`, `/model`, `/provider`, `/tools`, `/allow-mutations`) — get identical
composition behavior.

## 6. Logging Schema

Eight mandatory event kinds: `session_start`, `user_prompt`, `llm_chunk`, `llm_final`,
`tool_call`, `tool_result`, `error`, `session_end`. Plus `cli_invoke` / `cli_result` for
capability discovery subprocess calls.

Files: `~/.tool-agents/cli-agent/logs/session-<UTC>-<sessionId>.jsonl` (mode 0600),
`latest.jsonl` symlink. Directory mode 0700. All writes redacted via `redactString`.

## 7. Security Model

- Bash allowlist: empty by default. Populated only by `--tool`, `--bash-allow`, `BASH_ALLOWED_COMMANDS`, `config.json bash.allow`.
- Child process inherits only `passEnv` vars (`PATH`, `HOME`, `LANG`, `TERM` by default).
- Credential-shaped env vars stripped from child env unconditionally.
- File tools sandboxed to `fileEdit.root` (default: `process.cwd()`).
- Web fetcher uses a clean header set; no credentials forwarded to outbound requests.
- All log writes pass through `redactString`.

## 8. Module Layout

See `docs/design/plan-001-agent-subcommand.md` §6 for the full file inventory.

## 9. TUI Subsystem

The raw-mode terminal UI lives entirely under `src/tui/` and is decoupled from
the agent core through the streaming seam introduced in this iteration.

### File map

```
src/tui/
  index.ts                  startTui(cfg) — entry; banner; main read-dispatch loop
  controller.ts             TuiController — session state, AbortController, streaming loop
  spinner.ts                Braille spinner with ANSI save/restore
  ansi.ts                   Inline ANSI color + cursor primitives
  utf8.ts                   Stateful UTF-8 decoder (StringDecoder wrapper)
  clipboard.ts              Cross-platform copy via the bash/exec.ts helper
  input/
    line-editor.ts          Raw-mode multiline reader (escape framing + UTF-8)
    keybindings.ts          Documented key→action map (rendered by /help)
  transcript/
    types.ts                TurnRecord / ThreadIndexEntry / CursorState
    persist.ts              ~/.tool-agents/cli-agent/history/* CRUD
  slash/
    registry.ts             SlashCommand + dispatcher
    help.ts quit.ts new.ts clear.ts
    history.ts last.ts copy.ts memory.ts
    model.ts provider.ts tools.ts allow-mutations.ts
    capabilities.ts refresh-capabilities.ts tool-help.ts
```

### Streaming seam

`src/agent/graph.ts` now exports `streamOneShot()` — an async generator over
`agentGraph.graph.streamEvents(input, { version: 'v2' })`. Translation table:

```
on_chat_model_stream   → AgentStreamEvent { kind: 'token', text: chunk.content }
                          + emits llm_chunk JSONL log line (sessionId+turnId scoped)
on_chat_model_end      → emits llm_final JSONL log line (sessionId+turnId scoped)
on_tool_start          → AgentStreamEvent { kind: 'tool_call_start', toolName, args }
on_tool_end            → AgentStreamEvent { kind: 'tool_call_end', toolName, durationMs }
```

`src/agent/run.ts` wraps the generator in `streamOneShotAgent(cfg, prompt)`,
which mirrors the existing `runOneShotAgent` setup (logger, session_start,
user_prompt, session_end) and is consumed by both the TUI controller and the
one-shot CLI dispatch in `src/commands/agent.ts`.

### Event flow (per turn)

```
user types → readInput()                   src/tui/input/line-editor.ts
   │
   ├─ if "/…" → dispatchSlash()             src/tui/slash/registry.ts → command modules
   │
   └─ else  → controller.runTurn()          src/tui/controller.ts
              │
              ├─ persistTurn('user', …)     src/tui/transcript/persist.ts
              ├─ spinner.start("Thinking…")
              └─ for await event of streamOneShot(...):
                   token            → write to stdout, accumulate
                   tool_call_start  → "↳ calling <name>(...)" + spinner.setLabel("Processing…")
                   tool_call_end    → " ✓ (Nms)" + spinner.start()
              ├─ persistTurn('assistant', …)
              └─ persistIndex()
```

### Persistence (independent of the existing logs/)

```
~/.tool-agents/cli-agent/history/      mode 0700
  thread-<UTC-iso>-<threadId>.jsonl   mode 0600 — one line per turn
  index.jsonl                          mode 0600 — atomic upsert per thread
  cursor.json                          mode 0600 — last active thread for "resume?"
```

Per-turn JSONL records the user prompt and assistant final text only. Chunk-
level fragments stay in `~/.tool-agents/cli-agent/logs/` (the standard logger).

---

## 10. Agent-Tools Pack (curated subset of `BikS2013/agent-tools`)

This section captures the technical design for embedding a curated 6-tool
subset of the upstream `BikS2013/agent-tools` library into cli-agent as
additional standard tools. It is the source of truth for parallel
implementation in Phase 6.

Sources:

- Refined request: `docs/design/refined-request-agent-tools-integration.md`
- Plan: `docs/design/plan-003-agent-tools-integration.md`
- Investigation (verdict + axis analysis): `docs/reference/investigation-agent-tools-integration.md`
- Tool inventory: `docs/reference/agent-tools-inventory.md`
- Token-budget research: `docs/reference/research-token-budget-methodology.md`
- ToolContext-injection research: `docs/reference/research-toolcontext-injection.md`
- Codebase scan: `docs/reference/codebase-scan-agent-tools-integration.md`

### 10.A Architecture component diagram

The diagram below shows where the new components plug into the existing
catalog/prompt/graph flow. New components are tagged `[NEW]`. Arrows are data/
control flow per cli-agent run.

```
┌───────────────────────────────────────────────────────────────────────────┐
│ src/cli.ts  (Commander)                                                    │
│   13 new options:                                                          │
│     --no-agent-tools / --agent-tools                                       │
│     --enable-agt-<tool> / --disable-agt-<tool>   (× 6 pairs)         [NEW] │
└───────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼   AgentCliFlags { ..., agentTools? }
┌───────────────────────────────────────────────────────────────────────────┐
│ src/config/agent-config.ts  loadAgentConfig                                │
│   layered four-tier merge (shell env > agent .env > local .env > config)   │
│   resolveAgentTools(layered, configFile, cliFlags) → frozen view     [NEW] │
│     ConflictDetector: enable+disable for same tool → UsageError      [NEW] │
└───────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼   AgentConfig { ..., agentTools }
┌───────────────────────────────────────────────────────────────────────────┐
│ src/agent/run.ts                                                           │
│   const { tools, agentToolsMeta } = buildToolCatalog(cfg, logger)    [MOD] │
│   const block = buildAgentToolsPromptBlock(agentToolsMeta)           [NEW] │
│   const sysPrompt = await buildSystemPromptForCfg(cfg, capSec, block)[MOD] │
│   const graph    = buildAgentGraph(llm, tools, sysPrompt, max, cfg)  [MOD] │
└───────────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌───────────────────────────────────────────────────────────────────────────┐
│ src/agent/tools/registry.ts  buildToolCatalog                        [MOD] │
│   policy = cliAgentPermissionPolicy(cfg)            ← built ONCE     [NEW] │
│   sessionStore = (todoRead || todoWrite) ? { todos: null } : undef   [NEW] │
│   group  = buildAgentToolsGroup(cfg, policy, sessionStore)           [NEW] │
│   return { tools: [...readOnly, ...mutFile, ...bashRun, ...group.tools],   │
│            agentToolsMeta: group.metadata }                                │
└───────────────────────────────────────────────────────────────────────────┘
                              │                          │
              ┌───────────────┴────────┐                 ▼
              ▼                        ▼   ┌────────────────────────────────┐
┌──────────────────────┐  ┌──────────────────┐ │ buildAgentToolsPromptBlock │
│ permissions.ts [NEW] │  │ agent-tools/      │ │  (meta) → string     [NEW] │
│ cliAgentPermission   │  │   agt-glob.ts     │ └────────────────────────────┘
│   Policy(cfg)        │  │   agt-grep.ts     │              │
│  → PermissionPolicy  │  │   agt-multiedit   │              │ injected
└──────────────────────┘  │   agt-patch       │              ▼
              ▲           │   agt-todo-read   │ ┌────────────────────────────┐
              │ shared    │   agt-todo-write  │ │ buildSystemPromptForCfg    │
              │ instance  │     [NEW × 6]     │ │  (cfg, capSec, block?)[MOD]│
              └───────────┤                   │ └────────────────────────────┘
                          │ each wrapper:     │              │
                          │  DynamicStructured│              ▼
                          │  Tool(name,desc,  │   "## Optional standard
                          │  schema, func)    │   tools (agent-tools pack)"
                          │                   │
                          │  func(input,_,    │
                          │   cfg?: Runnable  │
                          │   Config) reads:  │
                          │   workingDirectory│
                          │   agentToolsSession
                          │   from configurable│
                          └─────────┬─────────┘
                                    ▼ delegates execute()
                          ┌──────────────────────────────────┐
                          │ src/agent/tools/agent-tools-     │
                          │   vendored/                [NEW] │
                          │   tools/{glob,grep,multiedit,    │
                          │     patch,todoread,todowrite}    │
                          │   types.ts (PermissionPolicy,    │
                          │             ToolContext, ...)    │
                          │   prompts/                       │
                          │   PROVENANCE.md, LICENSE         │
                          └──────────────────────────────────┘

           ── RunnableConfig.configurable injection path ──

┌──────────────────────────────────────────────────────────────────┐
│ src/agent/graph.ts  runOneShot / streamOneShot              [MOD]│
│   invokeOptions.configurable = {                                  │
│     thread_id,                                                    │
│     workingDirectory: cfg.fileEdit.root,                  [NEW]   │
│     agentToolsSession: agentGraph.todoSession (if set)    [NEW]   │
│   }                                                               │
└──────────────────────────────────────────────────────────────────┘
                              │
                              ▼ ToolNode forwards config
                   ┌───────────────────────────────┐
                   │ DynamicStructuredTool.func    │
                   │   (input, _runManager, config?│
                   │ {                             │
                   │   const cwd = config?.        │
                   │     configurable?.            │
                   │     workingDirectory          │
                   │     ?? staticCwd              │
                   │   const session = config?.    │
                   │     configurable?.            │
                   │     agentToolsSession         │
                   │ })                            │
                   └───────────────────────────────┘
```

### 10.B Module layout

All new modules under `src/agent/tools/` and `scripts/`:

```
src/agent/tools/
  agent-tools-vendored/                       NEW - Phase 1 (U1)
    PROVENANCE.md                             pinned upstream SHA + chain
    LICENSE                                   verbatim upstream MIT
    types.ts                                  re-vendored: PermissionPolicy,
                                              ToolContext, SessionStore,
                                              ToolResult, TodoItem, ...
    categories.ts                             re-vendored constants
    prompts/
      index.ts                                buildSystemPromptBlock helper
                                              (vendored but NOT used directly
                                              by cli-agent — cli-agent has its
                                              own block builder)
    tools/
      glob/{index.ts, glob.prompt.md, ...}    upstream files, copied verbatim
      grep/{index.ts, grep.prompt.md, ...}
      multiedit/{index.ts, multiedit.prompt.md, ...}
      patch/{index.ts, patch.prompt.md, ...}
      todoread/{index.ts, todoread.prompt.md, ...}
      todowrite/{index.ts, todowrite.prompt.md, ...}

  agent-tools/                                NEW - Phases 2-6 (U2, U3, U5)
    permissions.ts                            cliAgentPermissionPolicy(cfg)
                                              factory  (U2)
    permissions.spec.ts                       (Phase 9, B-B)
    types.ts                                  re-exports vendored types for
                                              ergonomic import (U3)
    index.ts                                  barrel: createAgt*Tool +
                                              cliAgentPermissionPolicy +
                                              buildAgentToolsGroup +
                                              buildAgentToolsPromptBlock (U3)
    agt-glob.ts                               wrapper (U3)
    agt-grep.ts                               wrapper (U3)
    agt-multiedit.ts                          wrapper (U3)
    agt-patch.ts                              wrapper (U3)
    agt-todo-read.ts                          wrapper (U3)
    agt-todo-write.ts                         wrapper (U3)
    agt-glob.spec.ts                          (Phase 9, B-A)
    agt-grep.spec.ts                          (Phase 9, B-A)
    agt-multiedit.spec.ts                     (Phase 9, B-A)
    agt-patch.spec.ts                         (Phase 9, B-A)
    agt-todo-read.spec.ts                     (Phase 9, B-A)
    agt-todo-write.spec.ts                    (Phase 9, B-A)
    group-builder.ts                          buildAgentToolsGroup(cfg,
                                              policy, sessionStore) (U5)
    group-builder.spec.ts                     (Phase 9, B-C)
    agent-tools-block.ts                      buildAgentToolsPromptBlock(meta)
                                              (U5)
    agent-tools-block.spec.ts                 (Phase 9, B-E + token budget)

  registry.ts                                 MODIFIED (U5) — return shape
                                              + agent-tools group + policy
                                              built once

src/agent/integration/                        NEW - Phase 9 (B-F)
  agent-tools-end-to-end.spec.ts              ReAct stub-LLM integration

scripts/
  sync-agent-tools.sh                         NEW - Phase 1 (U1)
                                              vendor sync at pinned SHA
```

### 10.C Data models / types

#### 10.C.1 `AgentConfigFile` extension (config.json shape)

Added to `AgentConfigFile` at `src/config/agent-config.ts:82`. All fields
optional; defaults applied last by `resolveAgentTools` (NOT a fallback for a
required value — these fields are optional with documented starting values).

```typescript
export interface AgentConfigFile {
  // ... existing fields ...
  readonly agentTools?: AgentToolsConfigFile;
}

export interface AgentToolsConfigFile {
  /** Pack umbrella. Default true (pack on). */
  readonly enabled?: boolean;
  /** Per-tool flags. Each defaults per `AGENT_TOOLS_DEFAULTS`. */
  readonly tools?: {
    readonly glob?: boolean;       // default true
    readonly grep?: boolean;       // default true
    readonly multiedit?: boolean;  // default true (still gated by allowMutations)
    readonly patch?: boolean;      // default true (still gated by allowMutations)
    readonly todoRead?: boolean;   // default false
    readonly todoWrite?: boolean;  // default false
  };
}
```

#### 10.C.2 Resolved `AgentConfig.agentTools`

Added to `AgentConfig` at `src/config/agent-config.ts:125`. Frozen, fully
populated (no `undefined` after resolution).

```typescript
export interface AgentConfig {
  // ... existing fields ...
  readonly agentTools: ResolvedAgentToolsConfig;
}

export interface ResolvedAgentToolsConfig {
  readonly enabled: boolean;
  readonly tools: {
    readonly glob: boolean;
    readonly grep: boolean;
    readonly multiedit: boolean;
    readonly patch: boolean;
    readonly todoRead: boolean;
    readonly todoWrite: boolean;
  };
}

/** Defaults are applied AFTER all four config tiers; documented as
 *  starting values, not runtime fallbacks. */
export const AGENT_TOOLS_DEFAULTS: ResolvedAgentToolsConfig = Object.freeze({
  enabled: true,
  tools: Object.freeze({
    glob: true,
    grep: true,
    multiedit: true,
    patch: true,
    todoRead: false,
    todoWrite: false,
  }),
});
```

#### 10.C.3 `AgentCliFlags.agentTools` (CLI ingest shape)

Each per-tool flag is *tri-state* (`true` → enable, `false` → disable,
`undefined` → defer to lower tier). The mapping from raw CLI options to this
shape lives in `src/cli.ts`'s `mapAgentToolFlags` helper.

```typescript
export interface AgentCliFlags {
  // ... existing fields ...
  readonly agentTools?: AgentToolsCliFlags;
}

export interface AgentToolsCliFlags {
  readonly enabled?: boolean;
  readonly tools?: {
    readonly glob?: boolean;
    readonly grep?: boolean;
    readonly multiedit?: boolean;
    readonly patch?: boolean;
    readonly todoRead?: boolean;
    readonly todoWrite?: boolean;
  };
}
```

#### 10.C.4 `AgentToolsCatalogMeta` — returned alongside the tool list

Added to `src/agent/tools/registry.ts`. The single source of truth for
"what is registered = what is described in the prompt".

```typescript
export interface AgentToolMetadata {
  /** Stable cli-agent name (e.g. 'agt_grep'). */
  readonly name: string;
  /** Upstream prompt fragment (markdown) used as both the
   *  DynamicStructuredTool description AND the prompt block fragment. */
  readonly promptFragment: string;
  /** True if the tool mutates host state (excluded when allowMutations is off). */
  readonly mutating: boolean;
}

/** New return shape of buildToolCatalog. Existing call sites updated to
 *  destructure. */
export interface ToolCatalog {
  readonly tools: ReadonlyArray<DynamicStructuredTool>;
  readonly agentToolsMeta: ReadonlyArray<AgentToolMetadata>;
}
```

#### 10.C.5 `AgentToolsSession` — in-memory todo store

Mirrors the upstream `SessionStore` shape; held in process heap, passed by
reference via `RunnableConfig.configurable.agentToolsSession` on every
`graph.invoke` / `graph.streamEvents`.

```typescript
// Re-exported from agent-tools/types.ts (vendored)
export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
  readonly priority?: 'low' | 'medium' | 'high';
}

export interface AgentToolsSession {
  todos: TodoItem[] | null;   // mutable by design
}
```

Lifetime: created in `buildToolCatalog` exactly when at least one of
`agt_todo_read` / `agt_todo_write` is registered; attached to `AgentGraph`
as `todoSession?: AgentToolsSession`; passed via configurable on every call.
Lost on process restart — documented in the configuration guide.

#### 10.C.6 `ToolContext` (vendored)

The shape the wrappers construct per-call and pass to upstream
`*.execute(input, ctx)`. Re-vendored verbatim from upstream `types.ts`; the
wrappers do NOT use `toLangChainTool` — they call `*.execute` directly.

```typescript
// Re-exported from agent-tools/types.ts (vendored upstream)
export interface ToolContext {
  readonly cwd: string;                    // from configurable.workingDirectory
  readonly permissions: PermissionPolicy;  // from cliAgentPermissionPolicy(cfg)
  readonly signal?: AbortSignal;           // from RunnableConfig.signal
  readonly session?: AgentToolsSession;    // from configurable.agentToolsSession
  readonly limits?: { readonly maxOutputBytes?: number }; // from cfg.perToolBudgetBytes
}

export interface PermissionPolicy {
  checkBash(command: string, args: ReadonlyArray<string>):
    Promise<{ allowed: true } | { allowed: false; reason: string }>;
  checkFsRead(absPath: string):
    Promise<{ allowed: true } | { allowed: false; reason: string }>;
  checkFsWrite(absPath: string):
    Promise<{ allowed: true } | { allowed: false; reason: string }>;
  scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
}
```

(Exact method names are confirmed at vendor time from the pinned SHA's
`types.ts`; if upstream renames any method, the wrapper bridge in
`permissions.ts` is the only place that needs updating.)

#### 10.C.7 Per-wrapper input schema field summary

Field-level Zod composition lives in the vendored module; cli-agent re-exports
the schema. Authoritative shape per tool (field names + types only — full Zod
schemas are imported, not re-declared):

| Tool | Required | Optional | Notes |
|---|---|---|---|
| `agt_glob` | `pattern: string` | `path?: string`, `limit?: number` | Returns mtime-sorted matches |
| `agt_grep` | `pattern: string` (regex) | `path?: string`, `include?: string` (glob), `output_mode?: 'content'\|'files_with_matches'\|'count'`, `-i`/`-n`/`-A`/`-B`/`-C` flags | Ripgrep-style |
| `agt_multiedit` | `file_path: string`, `edits: Array<{old_string: string, new_string: string, replace_all?: boolean}>` | — | Atomic — all-or-none |
| `agt_patch` | `patch: string` (opencode envelope) | — | Multi-file Add/Update/Delete/Move |
| `agt_todo_read` | (none) | — | Returns current `session.todos` |
| `agt_todo_write` | `todos: TodoItem[]` | — | Replaces `session.todos` |

### 10.D API contracts / interfaces

#### 10.D.1 The 6 wrapper modules

Every wrapper follows an identical shape. Each exports a `createAgt<X>Tool`
factory that returns a `DynamicStructuredTool`. The factory takes
`(cfg, policy, sessionStore?)` — `sessionStore` is required for the todo pair
only.

**Common contract (all wrappers):**

- `name`: stable string `agt_<tool>`. Never changes after compile.
- `description`: the upstream `<tool>.prompt.md` content as imported from
  `agent-tools-vendored/tools/<tool>/<tool>.prompt.md`. Trimmed to drop the
  upstream `${var}` placeholders that don't apply (cli-agent pre-substitutes
  these to fixed strings via the prompt-block builder, NOT via the upstream
  helper). The unmodified upstream text is used verbatim where possible —
  any trim is recorded as a comment in the wrapper file referencing the
  source path.
- `schema`: re-exported from the vendored `tools/<tool>/index.ts` Zod export.
- `func(input, _runManager, config?: RunnableConfig)`:
  1. Resolve `cwd` from `config.configurable.workingDirectory ?? staticCwd`
     where `staticCwd = cfg.fileEdit.root`.
  2. Resolve `signal` from `config?.signal`.
  3. For todo wrappers ONLY: resolve `session` from
     `config.configurable.agentToolsSession` — if `undefined` while either
     todo wrapper is registered, throw (contract violation: registry should
     have constructed and injected one).
  4. Build `ctx: ToolContext = { cwd, permissions: policy, signal,
     session, limits: { maxOutputBytes: cfg.perToolBudgetBytes } }`.
  5. Call `await <tool>.execute(input, ctx)`.
  6. On `result.ok === true`: return `result.output` (string).
  7. On `result.ok === false`: return
     `[agt_<tool> error] ${result.error.name}: ${result.error.message}`.
  8. On unexpected throw: `return handleToolError(err)` (matches cli-agent's
     existing tool error contract — recoverable errors flow as JSON-string
     return; `ConfigurationError`/`AuthError` re-thrown by `handleToolError`).

**Per-tool description text source (verbatim from upstream files):**

The exact text used as `description` is the file contents at
`src/agent/tools/agent-tools-vendored/tools/<tool>/<tool>.prompt.md`,
imported at module load time. The wrappers re-export this text without
modification, so it is also used as the per-fragment input to
`buildAgentToolsPromptBlock`. (See ADR-1 / ADR-5 below.)

**Permission checks fired per tool:**

| Tool | `checkBash` | `checkFsRead` | `checkFsWrite` | `scrubEnv` |
|---|---|---|---|---|
| `agt_glob` | — | per match (sandbox enforcement) | — | — |
| `agt_grep` | — | per match | — | — |
| `agt_multiedit` | — | once (target file) | once (target file) — gated by `allowMutations` | — |
| `agt_patch` | — | per file in envelope | per write/move/delete in envelope — gated by `allowMutations` | — |
| `agt_todo_read` | — | — | — | — (in-memory only) |
| `agt_todo_write` | — | — | — | — (in-memory only) |

**Output string format:** the upstream tool returns `{ ok: true, output:
string }` or `{ ok: false, error: { name: string, message: string, ... }}`.
The wrapper passes `output` through unchanged on success, and constructs
`[agt_<tool> error] <name>: <message>` on failure. Both forms become the
LangChain `ToolMessage.content` and are logged in the existing JSONL
`tool_result.output` field — no logging schema change.

#### 10.D.2 `cliAgentPermissionPolicy(cfg)` — the bridge

```typescript
// src/agent/tools/agent-tools/permissions.ts

import type { AgentConfig } from '../../../config/agent-config.js';
import type { PermissionPolicy } from '../agent-tools-vendored/types.js';

/**
 * Build a stateless PermissionPolicy that delegates each upstream check
 * to cli-agent's existing security primitives. Constructed ONCE per
 * session in buildToolCatalog (see ADR-3; D7 in plan-003) and shared
 * across every wrapper.
 *
 * @throws never — pure factory; routes failures into the policy method
 *                 returns ({ allowed: false, reason }) per upstream contract.
 */
export function cliAgentPermissionPolicy(cfg: AgentConfig): PermissionPolicy;
```

Method-by-method mapping:

| Upstream method | cli-agent primitive | Source module | Notes |
|---|---|---|---|
| `checkBash(cmd, args)` | `parseAllowlistEntries(cfg.bash.allow)` + match check | `src/agent/tools/bash/allowlist.ts` | Returns `{ allowed: false, reason: 'binary not allow-listed' }` if no entry matches; else `{ allowed: true }`. Does NOT execute — execution still goes through cli-agent's own `bash_run` if invoked. (None of the 6 bundled tools use `checkBash`; included for completeness if upstream adds it later.) |
| `checkFsRead(absPath)` | `resolveSandboxPath(absPath, sandboxCfg)` | `src/agent/tools/file/sandbox.ts` | Returns `{ allowed: true }` if path resolves inside `cfg.fileEdit.root` (or any `cfg.fileEdit.allowPaths`); else `{ allowed: false, reason: 'outside sandbox' }`. |
| `checkFsWrite(absPath)` | First assert `cfg.allowMutations === true` → if false return `{ allowed: false, reason: 'mutations disabled' }`; then route through `resolveSandboxPath`. | `src/config/agent-config.ts` + `src/agent/tools/file/sandbox.ts` | Mutating tools are also gated at the registry level (not registered when `allowMutations` is off), so `checkFsWrite` is a defense-in-depth check. |
| `scrubEnv(env)` | Strip credential-shaped keys per cli-agent's `bashEnvAllow` / `passEnv` rules. | `src/agent/tools/bash/exec.ts` (existing helper extracted/exported) | Returns a fresh `NodeJS.ProcessEnv` with only the explicitly allow-listed names. None of the 6 bundled tools spawn subprocesses, so unused for this scope; defined for upstream compatibility. |

Permission-bridge failures (e.g., the underlying `resolveSandboxPath` throwing
on a malformed path) propagate as exceptions — the wrapper's outer `try/catch
→ handleToolError` converts them. No silent fallback.

#### 10.D.3 `buildAgentToolsGroup(cfg, policy, sessionStore?)`

```typescript
// src/agent/tools/agent-tools/group-builder.ts

export interface AgentToolsGroup {
  readonly tools: ReadonlyArray<DynamicStructuredTool>;
  readonly metadata: ReadonlyArray<AgentToolMetadata>;
}

/**
 * Conditionally assemble the agent-tools group + parallel metadata.
 *
 * Gating rules (in order):
 *   1. If cfg.agentTools.enabled === false → return empty group (no tools,
 *      no metadata). Umbrella OFF wins over per-tool flags.
 *   2. For each of the six wrappers, register iff its per-tool flag is true.
 *   3. Mutating tools (multiedit, patch) additionally require
 *      cfg.allowMutations === true.
 *   4. Todo wrappers additionally require sessionStore !== undefined; the
 *      caller (buildToolCatalog) constructs sessionStore exactly when at
 *      least one todo flag is true.
 *
 * Invariant: tools.length === metadata.length, and the i-th metadata entry
 * describes the i-th tool. The prompt block builder relies on this.
 */
export function buildAgentToolsGroup(
  cfg: AgentConfig,
  policy: PermissionPolicy,
  sessionStore?: AgentToolsSession,
): AgentToolsGroup;
```

Per-tool gating decision table:

| Wrapper | Default-on | Mutation-gated | Session-gated | Combined registration condition |
|---|---|---|---|---|
| `agt_glob` | yes | no | no | `enabled && tools.glob` |
| `agt_grep` | yes | no | no | `enabled && tools.grep` |
| `agt_multiedit` | yes (gated) | yes | no | `enabled && tools.multiedit && cfg.allowMutations` |
| `agt_patch` | yes (gated) | yes | no | `enabled && tools.patch && cfg.allowMutations` |
| `agt_todo_read` | no | no | yes | `enabled && tools.todoRead` (and `sessionStore` injected) |
| `agt_todo_write` | no | no | yes | `enabled && tools.todoWrite` (and `sessionStore` injected) |

#### 10.D.4 `buildAgentToolsPromptBlock(meta)`

```typescript
// src/agent/tools/agent-tools/agent-tools-block.ts

/**
 * Derive the agent-tools system-prompt block from the registered set.
 *
 * Returns:
 *   - '' (empty string) when meta.length === 0  — caller skips the section
 *     entirely; assembled prompt is byte-stable with the umbrella-off case.
 *   - Otherwise: a markdown block of the shape:
 *
 *       ## Optional standard tools (agent-tools pack)
 *
 *       The following tools are provided by the agent-tools pack. Each is
 *       described by its upstream prompt fragment.
 *
 *       ---
 *
 *       <meta[0].promptFragment>
 *
 *       ---
 *
 *       <meta[1].promptFragment>
 *
 *       ...
 *
 * Separator `\n\n---\n\n` matches the upstream buildSystemPromptBlock
 * convention (see investigation §References, source 5).
 */
export function buildAgentToolsPromptBlock(
  meta: ReadonlyArray<AgentToolMetadata>,
): string;
```

Empty-input behavior is critical: the umbrella-off case (and the case where
*every* per-tool flag is false) produces zero metadata entries, yields the
empty string, and the caller short-circuits the `'\n\n' + block` append in
`buildSystemPromptForCfg` so the assembled prompt is byte-identical to the
pre-integration prompt.

### 10.E File structure / module organization

Per-file responsibilities, exports, and imports:

| File | Owns | Exports | Imports |
|---|---|---|---|
| `agent-tools-vendored/types.ts` | upstream type definitions | `PermissionPolicy`, `ToolContext`, `SessionStore` (alias of `AgentToolsSession`), `TodoItem`, `ToolResult<T>`, `ToolError` | (vendored — no cli-agent imports) |
| `agent-tools-vendored/tools/<tool>/index.ts` | upstream tool impl | named export e.g. `globTool: { name, prompt, schema, execute }` | upstream peers + `zod` |
| `agent-tools/permissions.ts` | bridge factory | `cliAgentPermissionPolicy(cfg) → PermissionPolicy` | `AgentConfig`, `parseAllowlistEntries`, `resolveSandboxPath`, vendored `PermissionPolicy` type |
| `agent-tools/types.ts` | re-export ergonomic aliases | `PermissionPolicy`, `ToolContext`, `AgentToolsSession`, `TodoItem`, `AgentToolMetadata` | vendored types |
| `agent-tools/agt-glob.ts` | one wrapper | `createAgtGlobTool(cfg, policy)` | `globTool` (vendored), `DynamicStructuredTool`, `RunnableConfig`, `handleToolError` |
| `agent-tools/agt-grep.ts` | one wrapper | `createAgtGrepTool(cfg, policy)` | `grepTool` (vendored), ditto |
| `agent-tools/agt-multiedit.ts` | one wrapper | `createAgtMultieditTool(cfg, policy)` | `multieditTool` (vendored), ditto |
| `agent-tools/agt-patch.ts` | one wrapper | `createAgtPatchTool(cfg, policy)` | `patchTool` (vendored), ditto |
| `agent-tools/agt-todo-read.ts` | one wrapper | `createAgtTodoReadTool(cfg, policy, sessionStore)` | `todoreadTool` (vendored), ditto |
| `agent-tools/agt-todo-write.ts` | one wrapper | `createAgtTodoWriteTool(cfg, policy, sessionStore)` | `todowriteTool` (vendored), ditto |
| `agent-tools/group-builder.ts` | catalog assembly | `buildAgentToolsGroup(cfg, policy, sessionStore?) → AgentToolsGroup`, `AgentToolsGroup` interface | All 6 `createAgt*Tool` factories, `AgentToolMetadata`, `AgentConfig` |
| `agent-tools/agent-tools-block.ts` | prompt fragment composer | `buildAgentToolsPromptBlock(meta) → string` | `AgentToolMetadata` |
| `agent-tools/index.ts` | barrel | re-exports above + `cliAgentPermissionPolicy` | local files |
| `tools/registry.ts` (MOD) | catalog assembly entrypoint | `buildToolCatalog(cfg, logger) → ToolCatalog`, `ToolCatalog`, `AgentToolMetadata` | + agent-tools barrel + `cliAgentPermissionPolicy` |

### 10.F Key algorithms / business logic

#### 10.F.1 Catalog-assembly logic (umbrella + per-tool + mutation gate)

```text
buildToolCatalog(cfg, logger):
    readOnly       = [file_read, file_list, bash_list_allowed, bash_which,
                      web_search, web_fetch, tool_help]              // unchanged
    mutatingFile   = cfg.allowMutations
                       ? [file_write, file_edit, file_append] : []   // unchanged
    bashRunTools   = allowlist.length > 0 ? [bash_run] : []          // unchanged

    policy         = cliAgentPermissionPolicy(cfg)                   // NEW, once
    needsSession   = cfg.agentTools.enabled
                       && (cfg.agentTools.tools.todoRead
                           || cfg.agentTools.tools.todoWrite)
    sessionStore   = needsSession ? { todos: null } : undefined      // NEW

    group          = buildAgentToolsGroup(cfg, policy, sessionStore) // NEW

    return {
      tools:           [...readOnly, ...mutatingFile, ...bashRunTools, ...group.tools],
      agentToolsMeta:  group.metadata,
    }

buildAgentToolsGroup(cfg, policy, sessionStore?):
    if !cfg.agentTools.enabled:         return { tools: [], metadata: [] }

    out = []
    push(out, cfg.agentTools.tools.glob,
         () => createAgtGlobTool(cfg, policy),
         { name: 'agt_glob', promptFragment: GLOB_PROMPT, mutating: false })
    push(out, cfg.agentTools.tools.grep,
         () => createAgtGrepTool(cfg, policy),
         { name: 'agt_grep', promptFragment: GREP_PROMPT, mutating: false })
    push(out, cfg.agentTools.tools.multiedit && cfg.allowMutations,
         () => createAgtMultieditTool(cfg, policy),
         { name: 'agt_multiedit', promptFragment: MULTIEDIT_PROMPT, mutating: true })
    push(out, cfg.agentTools.tools.patch && cfg.allowMutations,
         () => createAgtPatchTool(cfg, policy),
         { name: 'agt_patch', promptFragment: PATCH_PROMPT, mutating: true })
    push(out, cfg.agentTools.tools.todoRead,
         () => createAgtTodoReadTool(cfg, policy, sessionStore!),
         { name: 'agt_todo_read', promptFragment: TODOREAD_PROMPT, mutating: false })
    push(out, cfg.agentTools.tools.todoWrite,
         () => createAgtTodoWriteTool(cfg, policy, sessionStore!),
         { name: 'agt_todo_write', promptFragment: TODOWRITE_PROMPT, mutating: false })

    return { tools: out.map(o => o.tool), metadata: out.map(o => o.meta) }
```

#### 10.F.2 Prompt-block-from-catalog derivation

Single source of truth: `agentToolsMeta` is generated by the catalog; the
prompt block is a pure function of that array. Unregistered tools cannot
appear in the block.

```text
buildAgentToolsPromptBlock(meta):
    if meta.length === 0: return ''
    parts = []
    parts.push('## Optional standard tools (agent-tools pack)')
    parts.push('')
    parts.push('The following tools are provided by the agent-tools pack. ' +
               'Each is described by its upstream prompt fragment.')
    parts.push('')
    parts.push('---')
    for entry in meta:
        parts.push('')
        parts.push(entry.promptFragment.trimEnd())
        parts.push('')
        parts.push('---')
    parts.pop()  // drop trailing separator
    return parts.join('\n')
```

#### 10.F.3 Four-tier precedence merge for `agentTools.*`

`resolveAgentTools(layered, configFile, cliFlags) → ResolvedAgentToolsConfig`
walks each field through the chain; CLI flag wins over shell env wins over
agent-dir `.env` wins over local `.env` wins over `config.json` wins over
default. Per-field tri-state semantics: a `true` or `false` value at a higher
tier overrides; `undefined` falls through.

Pseudocode for one field (`tools.grep`); applied symmetrically to all six
flags + `enabled`:

```text
resolveOne(field, default):
    cli       = cliFlags?.tools?.grep                       // tri-state
    shellEnv  = parseTriState(layered['CLI_AGENT_AGT_GREP'])// from baseline merge
    cfgFile   = configFile?.agentTools?.tools?.grep         // tri-state
    return cli ?? shellEnv ?? cfgFile ?? default

parseTriState(raw):
    if raw is undefined: return undefined
    if raw in ['1','true','TRUE','yes']:  return true
    if raw in ['0','false','FALSE','no']: return false
    throw ConfigurationError('CLI_AGENT_AGT_*: expected 1/0/true/false')
```

The umbrella `enabled` follows the same pattern with env-var
`CLI_AGENT_DISABLE_AGENT_TOOLS` flipped (set → `enabled = false`). The
inversion is documented in `configuration-guide.md`'s opt-out matrix.

#### 10.F.4 Conflict detection: `--enable-agt-X --disable-agt-X` → `UsageError`

In `src/cli.ts`'s `mapAgentToolFlags(opts) → AgentToolsCliFlags`:

```text
mapAgentToolFlags(opts):
    out = { tools: {} }
    if opts.noAgentTools && opts.agentTools:
        throw new UsageError('--no-agent-tools and --agent-tools are mutually exclusive')
    if opts.noAgentTools: out.enabled = false
    else if opts.agentTools: out.enabled = true

    for tool in [glob, grep, multiedit, patch, todoRead, todoWrite]:
        en  = opts['enableAgt<Tool>']
        dis = opts['disableAgt<Tool>']
        if en && dis:
            throw new UsageError(
                `--enable-agt-${kebab(tool)} and --disable-agt-${kebab(tool)} ` +
                `are mutually exclusive`)
        if en:  out.tools[tool] = true
        if dis: out.tools[tool] = false
    return out
```

`UsageError` exits with code 2 (matches `src/cli.ts:6`'s exit-code table).
There is no silent precedence; the user is told explicitly. This is the
"no fallback for required configuration" rule applied to ambiguity (the user
*required* a deterministic value and supplied two contradictory ones).

#### 10.F.5 SessionStore lifecycle for the todo pair

```text
process start
   ├── loadAgentConfig(...)              → cfg.agentTools resolved
   ├── buildToolCatalog(cfg, logger)
   │     └── if cfg.agentTools.enabled
   │           && (tools.todoRead || tools.todoWrite):
   │           sessionStore = { todos: null }                   ← created
   │           AgentGraph.todoSession = sessionStore (held by ref)
   ├── buildAgentGraph(... cfg)          → graph compiled once
   │
   ├── per turn: graph.invoke(msgs, { configurable: {
   │                  thread_id, workingDirectory,
   │                  agentToolsSession: agentGraph.todoSession ← passed by ref
   │              }})
   │     │
   │     └── ToolNode → tool.func(input, _, config) reads
   │                    config.configurable.agentToolsSession
   │                    and mutates session.todos in place
   │
   └── process exit → sessionStore garbage-collected (no persistence)
```

Restart durability: explicitly none. Acceptable because the todo pair is
default-off; documented in `configuration-guide.md` as a known limitation.

### 10.G Error handling strategy

| Error class | Handling | Rationale |
|---|---|---|
| Upstream `ToolResult.ok === false` | Wrapper returns `[agt_<tool> error] <name>: <message>` string | Matches existing JSONL `tool_result.output` contract; the LangChain adapter convention is errors-as-string so the ReAct loop can recover. No exception bubbles to `createReactAgent`. |
| Upstream throws synchronously inside `execute()` | Wrapper's outer `try/catch` catches; `handleToolError(err)` is called; recoverable errors → JSON string return; `ConfigurationError`/`AuthError` → re-thrown (fatal) | Same as every existing standard tool (e.g. `file_read`). |
| Wrapper contract violation: `configurable.workingDirectory` missing AND `staticCwd` empty | Wrapper throws `ConfigurationError('cli-agent: workingDirectory not provided')` | No fallback: cli-agent always sets `workingDirectory` in `configurable` via `graph.ts`. If it's missing, that is a programming bug, not a runtime condition. Throw fast. |
| Todo wrapper called with `sessionStore === undefined` | Wrapper throws `ConfigurationError('cli-agent: agentToolsSession missing — registry should have constructed one')` | Same as above — invariant violation, not a recoverable runtime state. |
| Permission bridge failure (e.g., malformed path passed to `resolveSandboxPath`) | Throw propagates from the bridge → caught by wrapper's outer `try/catch` → `handleToolError` | The bridge does not silently substitute a default path. |
| Config validation: `--enable-agt-X --disable-agt-X` | `UsageError` (exit 2) at CLI parse time | Fail fast; no precedence rule to "pick the winner" silently. |
| Config validation: env var `CLI_AGENT_AGT_GREP=maybe` | `ConfigurationError` (exit 3) at `loadAgentConfig` time | Tri-state parser strictly rejects non-`1/0/true/false`. |
| Conflict: `--no-agent-tools --agent-tools` | `UsageError` (exit 2) | Fail fast. |
| Vendored upstream missing (e.g., dev forgot to run sync script) | TypeScript compile error at wrapper import; no runtime fallback path needed | Detected by `npm run typecheck`. |

**Crucial invariant:** wrappers MUST return strings on recoverable upstream
errors (LangChain ReAct loop survives), and MUST throw on contract
violations (programming errors are not recoverable runtime states). The
boundary is enforced by the wrapper's outer `try/catch`: only
`handleToolError`'s recoverable branch becomes a string; everything else
throws.

### 10.H Technology choices with justification

| Choice | Rationale | Rejected alternatives |
|---|---|---|
| **`js-tiktoken` (`cl100k_base`) for token-budget assertion** | Already a transitive dep of `@langchain/core` and `@langchain/openai` (research §3); pure JS, MIT, ESM, no WASM, no Vitest plugins required. Zero install footprint added. | `tiktoken` (WASM, requires Vite plugins); `gpt-tokenizer` (extra dep, no accuracy benefit); char-count proxy (20-40% drift on markdown — research §2.2.5). |
| **`DynamicStructuredTool` for wrappers (NOT `tool()` factory)** | Matches the existing 11 standard tools (`file_*`, `web_*`, `bash_*`, `tool_help`); `func` receives `RunnableConfig` as the third argument (research §2.1) which is the documented LangChain pattern. Consistency with the project's authored style. | `tool()` factory (config is 2nd arg, mismatched style); upstream `toLangChainTool` adapter (closes over `ToolContext` at construction time — defeats per-call injection; research §3 source 3). |
| **`RunnableConfig.configurable` for context injection** | The `ToolNode` passes `RunnableConfig` to every `tool.invoke()` call (research §1.2 + source 1). Argument-scoped, no shared mutable state, no checkpointer impact, no graph rebuild. | `AsyncLocalStorage` / module-level mutable holder (anti-pattern, leak risk, concurrency hazard); per-turn catalog rebuild (recompiles graph, defeats `createReactAgent`'s compile-once contract); `ToolRuntime.state` injection (JS gap vs. Python, research §3.3). |
| **cli-agent's own `DynamicStructuredTool` wrappers (NOT upstream's `toLangChainTool`)** | Upstream's adapter captures `ToolContext` at construction time; cli-agent needs per-call `cwd` / `session`. ADR-5 below. | Use upstream adapter (forces context immutability per session — incompatible with the configurable-injection design). |
| **Vendoring (`src/agent/tools/agent-tools-vendored/` + pinned SHA + `PROVENANCE.md` + `scripts/sync-agent-tools.sh`)** | Upstream is `"private": true` (not on npm); git-submodule complicates end-user `npm install`; `github:` git-dep would force `tsc` at every install (fragile). Vendoring keeps install clean and provides an auditable copy. ADR-2. | npm install (impossible); git submodule (install complexity); `github:` direct git dep (build-on-install fragility); MCP sidecar (over-engineering, IPC overhead, new failure mode). |
| **`fast-glob` + `ignore` as new direct deps; `@vscode/ripgrep` as `optionalDependencies`** | `fast-glob` and `ignore` are required by the JS fallback paths in vendored `glob` / `grep`. `@vscode/ripgrep` is a ~30 MB native binary — desirable for speed but the JS fallback covers locked-down CI; `optionalDependencies` lets `npm install` succeed even when the binary cannot be fetched. | Required dep on `@vscode/ripgrep` (breaks locked-down installs); skip `fast-glob`/`ignore` (would require re-implementing the upstream fallbacks — drift risk). |
| **`@vscode/ripgrep` deferred (optional only)** | Adds ~30 MB; the JS fallback in upstream `grep`/`glob` returns identical results. Defer to a follow-up if perf becomes an issue. Documented in configuration-guide. | Make it required (install bloat + locked-down CI failures). |

### 10.I Integration points

Existing files extended/modified — exact symbol-level targets so Phase 6
coders can address each via Serena `find_symbol`.

| File | Symbol | Change |
|---|---|---|
| `src/config/agent-config.ts:82` | `interface AgentConfigFile` | Add `readonly agentTools?: AgentToolsConfigFile;` |
| `src/config/agent-config.ts:125` | `interface AgentConfig` | Add `readonly agentTools: ResolvedAgentToolsConfig;` |
| `src/config/agent-config.ts:158` | `interface AgentCliFlags` | Add `readonly agentTools?: AgentToolsCliFlags;` |
| `src/config/agent-config.ts:419` | `const OTHER_ENV_KEYS` | Append `'CLI_AGENT_DISABLE_AGENT_TOOLS', 'CLI_AGENT_AGT_GLOB', 'CLI_AGENT_AGT_GREP', 'CLI_AGENT_AGT_MULTIEDIT', 'CLI_AGENT_AGT_PATCH', 'CLI_AGENT_AGT_TODO_READ', 'CLI_AGENT_AGT_TODO_WRITE'` (7 entries) |
| `src/config/agent-config.ts:500` | `function loadAgentConfig` | Add a new resolver call: `agentTools: resolveAgentTools(layered, configFile, flags.agentTools)` to the returned `AgentConfig` literal. Implement `resolveAgentTools` as a new top-level helper next to `resolveSystemPromptPath` (~line 479). |
| `src/cli.ts:31` | top-level `program` builder block | Insert 13 new `.option(...)` lines between line 56 (`--refresh-capabilities`) and line 57 (`--verbose`). |
| `src/cli.ts:58` | the default-command `.action(async ...)` callback body | Map raw opts to `agentTools` via a new local helper `mapAgentToolFlags(opts)` defined at module scope. Pass result into `runAgentCommand(prompt, { ..., agentTools })`. |
| `src/agent/tools/registry.ts:23` | `function buildToolCatalog` | Change return type from `AnyTool[]` to `ToolCatalog`. Insert: build `policy`, `sessionStore`, `group`. Append `group.tools` to the returned array; return `{ tools, agentToolsMeta: group.metadata }`. |
| `src/agent/run.ts:29, 127, 226, 265` | `runOneShotAgent`, `streamOneShotAgent`, `buildTuiAgentRuntime`, slash-command rebuild path | At each `buildToolCatalog(...)` call, destructure the new return shape: `const { tools, agentToolsMeta } = buildToolCatalog(cfg, logger)`. |
| `src/agent/run.ts` (same call sites) | the `buildSystemPromptForCfg(cfg, capSec)` call right after | Compute `const block = buildAgentToolsPromptBlock(agentToolsMeta)` and pass as 3rd arg: `buildSystemPromptForCfg(cfg, capSec, block)`. |
| `src/agent/run.ts` (same call sites) | the `buildAgentGraph(llm, tools, sysPrompt, maxSteps)` call | Pass cfg + sessionStore through so `graph.ts` can populate `configurable`. Either widen `buildAgentGraph` signature or attach `cfg` via a new options parameter. |
| `src/agent/system-prompt.ts:106` | `function buildSystemPromptForCfg` | Add optional 3rd parameter `agentToolsBlock?: string`. Insert `if (agentToolsBlock) prompt += '\n\n' + agentToolsBlock;` BEFORE the `customSystemText` append (composition order: base → capabilities → agent-tools block → user addendum). |
| `src/agent/graph.ts:17` | `interface AgentGraph` | Add `readonly todoSession?: AgentToolsSession;` |
| `src/agent/graph.ts:35` | `function buildAgentGraph` | Add a new parameter `sessionStore?: AgentToolsSession` (or pass via opts object). Return it on `AgentGraph.todoSession`. |
| `src/agent/graph.ts:54` | `function runOneShot` | Extend `invokeOptions.configurable` with `workingDirectory: cfg.fileEdit.root` and (if defined) `agentToolsSession: agentGraph.todoSession`. Requires `cfg` available — pass through. |
| `src/agent/graph.ts:111` | `function streamOneShot` | Same as above for `streamConfig.configurable`. |

### 10.J Parallel implementation units for Phase 6

Each unit lists the files it owns (no overlap with other units), the units it
depends on, and the public interface it publishes for downstream consumers.

#### Unit U1 — Vendoring infrastructure + first sync

- **Owns:**
  - `scripts/sync-agent-tools.sh`
  - `src/agent/tools/agent-tools-vendored/**` (whole subtree, populated by the
    sync script's first run)
  - `src/agent/tools/agent-tools-vendored/PROVENANCE.md`
  - `src/agent/tools/agent-tools-vendored/LICENSE`
  - `package.json` additions: `dependencies.fast-glob`, `dependencies.ignore`,
    `optionalDependencies['@vscode/ripgrep']`
  - `package-lock.json` (regenerated)
- **Depends on:** nothing (foundation).
- **Publishes:**
  - Vendored module surface importable as `'../agent-tools-vendored/types.js'`,
    `'../agent-tools-vendored/tools/<tool>/index.js'`,
    `'../agent-tools-vendored/tools/<tool>/<tool>.prompt.md'` (TS string import).
  - The `PermissionPolicy`, `ToolContext`, `SessionStore`, `TodoItem` type
    surface confirmed at the pinned SHA. If upstream renames any of these,
    the SHA pinning catches it (sync script aborts on `tsc --noEmit`).
- **Acceptance:** `bash scripts/sync-agent-tools.sh` completes; `tsc --noEmit`
  passes with the vendored copy present.

#### Unit U2 — Permission bridge

- **Owns:**
  - `src/agent/tools/agent-tools/permissions.ts`
  - `src/agent/tools/agent-tools/types.ts` (re-exports of vendored types)
- **Depends on:** U1 (needs vendored `PermissionPolicy` type).
- **Publishes:** `cliAgentPermissionPolicy(cfg) → PermissionPolicy`.
  Stateless, side-effect-free, safe to construct once and share across all
  wrappers (D7 in plan-003).
- **Acceptance:** unit tests in B-B (Phase 9) pass.

#### Unit U3 — Six tool wrappers

- **Owns:**
  - `src/agent/tools/agent-tools/agt-glob.ts`
  - `src/agent/tools/agent-tools/agt-grep.ts`
  - `src/agent/tools/agent-tools/agt-multiedit.ts`
  - `src/agent/tools/agent-tools/agt-patch.ts`
  - `src/agent/tools/agent-tools/agt-todo-read.ts`
  - `src/agent/tools/agent-tools/agt-todo-write.ts`
  - `src/agent/tools/agent-tools/index.ts` (barrel)
- **Depends on:** U1 (vendored), U2 (`PermissionPolicy` factory).
- **Publishes:** Six `createAgt<X>Tool(cfg, policy[, sessionStore])` factories
  with stable names, vendored prompt fragments as descriptions, vendored Zod
  schemas, and `RunnableConfig.configurable`-aware `func` implementations.
- **Sub-parallelization:** the 6 wrappers are independent; assign one per
  parallel coder if desired. They share no state at module scope.
- **Acceptance:** unit tests in B-A (Phase 9) pass; type-check passes.

#### Unit U4 — Configuration surface

- **Owns:**
  - `src/config/agent-config.ts` extension (new resolver, new fields on three
    interfaces, `OTHER_ENV_KEYS` additions)
  - `src/cli.ts` extension (13 new options + `mapAgentToolFlags` helper)
  - `src/config/agent-config.spec.ts` extension (B-D)
- **Depends on:** nothing (no overlap with U1/U2/U3 — purely on config & CLI
  surface).
- **Publishes:**
  - `AgentConfig.agentTools: ResolvedAgentToolsConfig` (frozen)
  - `AgentToolsConfigFile`, `ResolvedAgentToolsConfig`, `AgentToolsCliFlags`,
    `AGENT_TOOLS_DEFAULTS` types/constants
- **Acceptance:** spec tier-precedence + conflict-detection tests pass.

#### Unit U5 — Catalog + prompt injection

- **Owns:**
  - `src/agent/tools/agent-tools/group-builder.ts`
  - `src/agent/tools/agent-tools/agent-tools-block.ts`
  - `src/agent/tools/registry.ts` (modification)
  - `src/agent/run.ts` (4-call-site modification)
  - `src/agent/graph.ts` (modification — `AgentGraph.todoSession`,
    `configurable` extensions)
  - `src/agent/system-prompt.ts` (modification — `buildSystemPromptForCfg`
    3rd arg)
- **Depends on:** U2, U3, U4.
- **Publishes:**
  - `ToolCatalog`, `AgentToolMetadata` types
  - New `buildToolCatalog` return shape (callers updated in same unit)
  - `buildAgentToolsPromptBlock(meta) → string`
  - `AgentGraph.todoSession`
- **Acceptance:** B-C (registry), B-E (prompt block), B-F (end-to-end) tests
  pass; the umbrella-off byte-stability invariant verified.

#### Unit U6 — Documentation

- **Owns:**
  - `docs/tools/cli-agent.md` (extend with `<agentToolsPack>` subsection)
  - `docs/design/project-design.md` (this section, plus updates to §4 Tool
    Catalog and §2 Architecture cross-refs)
  - `docs/design/project-functions.md` (FR-NEW-* / NFR-NEW-* entries marked
    Accepted)
  - `docs/design/configuration-guide.md` (new section + opt-out matrix)
  - `Issues - Pending Items.md`
- **Depends on:** all of U1–U5 (descriptions, ceilings, file inventory must
  be settled).
- **Publishes:** documentation only; no code surface.

**Dependency graph (visual):**

```
U1 ──┬── U2 ── U3 ──┐
     │              ├── U5 ── U6
U4 ──┴──────────────┘
```

U1 + U4 can start immediately and in parallel. U2 starts as soon as U1's first
sync produces `agent-tools-vendored/types.ts`. U3's 6 wrappers start once U2
publishes its policy factory signature. U5 starts once U2/U3/U4 are done. U6
runs last.

### 10.K Architectural decisions (ADR-style)

#### ADR-1: Per-tool config gating; reject describe-and-suppress

- **Decision:** Use config-flag gating where the registered tool set is the
  single source of truth, and the prompt block is **derived from** the
  registered set. Reject the user's originally-stated "describe in system
  prompt + opt-out by stripping the description" pattern.
- **Context:** The user's mental model was that the LLM would always see the
  tools but the prompt could hide their descriptions. cli-agent already
  enforces the invariant *prompt-set == catalog-set* elsewhere (`bash_run`'s
  allowlist gate; mutating file tools' `--allow-mutations` gate). Breaking
  that invariant for one tool group would create a behavioral split where the
  LLM has tools it doesn't know how to use.
- **Alternatives considered:**
  - **B1 — Description-only suppression** (the user's original idea): leaves
    tools registered but invisible in the prompt; LLM still calls them based
    on schema/name introspection; quality silently degrades.
  - **B4 — Generic block registry** (`system-prompt-blocks/` directory):
    requires building a new prompt-assembly subsystem before this integration
    can ship; out of scope.
  - **B5 — Lazy/JIT registration via meta-tool**: requires `createReactAgent`
    re-binding mid-session, painful and architecturally novel.
- **Consequences:**
  - Positive: invariant maintained; existing test patterns reusable;
    behavior is predictable from the catalog alone.
  - Positive: prompt is byte-stable when umbrella is off (no fragments
    means no header).
  - Negative: 13 CLI flags is verbose; mitigated by the umbrella as the
    common-case knob.

#### ADR-2: Vendoring (rejecting npm / submodule / git-dep / MCP sidecar)

- **Decision:** Vendor the upstream subset under
  `src/agent/tools/agent-tools-vendored/` at a pinned SHA, with
  `PROVENANCE.md` recording the chain of derivation (sst/opencode →
  anomalyco → biks) and a `scripts/sync-agent-tools.sh` script that
  reproducibly re-syncs from the same SHA.
- **Context:** Upstream is `"private": true` (not on npm). Three other
  distribution paths exist; each has a specific failure mode for cli-agent's
  install footprint or build pipeline.
- **Alternatives considered:**
  - **`npm install` from registry**: impossible — package not published.
  - **Git submodule (`vendor/agent-tools/`)**: complicates `npm install` of
    cli-agent for end users (must clone with `--recursive`); harder
    provenance.
  - **`github:` direct git dep**: requires running upstream's `tsc` at every
    install of cli-agent (fragile, slow, network-dependent).
  - **MCP sidecar / HTTP service**: massive over-engineering for a TS
    library that's already LangChain-ready; adds process boundary, IPC
    latency, supervision burden. cli-agent has no MCP client today.
- **Consequences:**
  - Positive: clean install, auditable copy, deterministic builds.
  - Negative: requires periodic re-sync (mitigated by the script + SHA
    pinning).
  - Negative: cli-agent must keep `PROVENANCE.md` accurate; sync script
    enforces this.

#### ADR-3: `RunnableConfig.configurable` for context (rejecting AsyncLocalStorage / per-turn rebuild)

- **Decision:** Use `RunnableConfig.configurable` to inject per-call context
  (`workingDirectory`, `agentToolsSession`) into wrapper `func`. Construct
  `cliAgentPermissionPolicy(cfg)` once per session and share across wrappers
  (it is stateless).
- **Context:** Upstream `ToolContext` carries `cwd`, `permissions`, `signal`,
  `session`. The `ToolNode` already passes `RunnableConfig` to every
  `tool.invoke()` call (research source 1). The upstream
  `toLangChainTool` adapter closes over `ToolContext` at construction time
  (research source 3) — incompatible with per-call cwd/session.
- **Alternatives considered:**
  - **AsyncLocalStorage / module-level mutable holder**: shared mutable state,
    leak risk, concurrency hazard; no benefit when an argument-scoped
    alternative exists.
  - **Per-turn catalog rebuild**: forces graph recompile, breaks
    `createReactAgent`'s compile-once contract; loses MemorySaver continuity.
  - **`ToolRuntime.state` injection**: documented but JS behavior diverges
    from Python (research §3.3); requires a custom `StateGraph`.
- **Consequences:**
  - Positive: zero checkpointer impact; argument-scoped isolation;
    consistent with how `thread_id` is already injected.
  - Negative: requires the wrapper to read `config.configurable` correctly;
    enforced by unit tests + the wrapper contract documented in §10.D.1.

#### ADR-4: `js-tiktoken` reuse (rejecting char-count proxy / new tokenizer)

- **Decision:** Use `js-tiktoken` with the `cl100k_base` encoding for the
  NFR-NEW-001 token-budget Vitest assertion. No new direct dependency.
- **Context:** `js-tiktoken@1.0.21` is already installed as a transitive dep
  of `@langchain/core` and `@langchain/openai` (research §3); pure JS, MIT,
  ESM, no WASM, no Vitest plugins required.
- **Alternatives considered:**
  - **`tiktoken` (WASM)**: requires `vite-plugin-wasm` +
    `vite-plugin-top-level-await` for Vitest on Node 22.
  - **`gpt-tokenizer`**: not installed; adds dep for zero accuracy gain.
  - **`@dqbd/tiktoken`**: unmaintained; predecessor of `js-tiktoken`.
  - **Char-count proxy (`text.length / 4`)**: 20–40% drift on markdown
    fragments containing identifiers and code (research §2.2.5); too wide
    for a meaningful budget gate.
- **Consequences:**
  - Positive: zero install footprint added; immediate availability.
  - Positive: `cl100k_base` is the conservative encoding (counts slightly
    higher than `o200k_base` and Claude's tokenizer) — earlier warning when
    a fragment approaches the ceiling.
  - Negative: not a per-provider exact count; acceptable because the
    assertion is a sanity gate, not a billing target.

#### ADR-5: cli-agent's own `DynamicStructuredTool` wrappers (rejecting upstream's `toLangChainTool`)

- **Decision:** cli-agent writes its own `DynamicStructuredTool` wrappers,
  one per bundled tool. They call `vendoredTool.execute(input, ctx)`
  directly. They do NOT use the upstream `toLangChainTool` adapter.
- **Context:** The upstream adapter (`agent-tools/src/adapters/langchain.ts`)
  closes over `ToolContext` at construction time (research source 3) — so
  the cwd, session, and permissions become immutable for the lifetime of the
  tool object. cli-agent needs per-call values (`workingDirectory` is per
  session; `agentToolsSession` is per session and may also be per `cfg`).
- **Alternatives considered:**
  - **Use upstream `toLangChainTool`**: forces a graph rebuild every time
    the context changes (i.e., every session) — incompatible with
    `createReactAgent`'s compile-once model and with the
    `RunnableConfig.configurable` injection pattern (ADR-3).
- **Consequences:**
  - Positive: full control over the wrapper's behavior; matches cli-agent's
    11 existing standard tools; supports per-call context.
  - Negative: cli-agent owns ~70 LOC × 6 wrappers of glue. Mitigated by
    identical wrapper shape (a single template) and by the unit tests
    that catch any deviation.

#### ADR-6: 13 discrete CLI flags (rejecting composite syntax)

- **Decision:** Expose the umbrella + each per-tool gate as discrete CLI
  flags (1 + 1 umbrella, 6 enable, 6 disable = 14 total; 13 if we count the
  umbrella-on as rarely needed and only document `--no-agent-tools`). The
  composite syntax `--agent-tools=tool1,!tool3` was considered and rejected.
- **Context:** cli-agent's CLI uses Commander with one option per concern
  (`--allow-mutations`, `--tool` repeatable, `--bash-allow` csv-string).
  The discrete style is the project-canonical idiom.
- **Alternatives considered:**
  - **Composite `--agent-tools="glob,grep,!multiedit"` string**: leaks
    negation semantics into a single string; harder to compose with env vars
    and `config.json`; harder for shell completion.
  - **One flag with subcommand-style values (`--agent-tool enable=grep`)**:
    inconsistent with the rest of cli-agent's flag style.
- **Consequences:**
  - Positive: each flag is unambiguous and shell-completable.
  - Positive: env-var and config.json mappings are 1:1 with CLI flags.
  - Negative: 13 flags is verbose `--help` output. Mitigated by the
    umbrella being the common-case knob; per-tool flags only used for
    fine-tuning. Documented coherently in `configuration-guide.md`.

---


## §11. User-editable tool prompt overlays

**Plan reference**: `docs/design/plan-004-tool-prompt-overlays.md`.
**Functions**: FR-OVR-001 … FR-OVR-009 + NFR-OVR-001 / NFR-OVR-002 in
`docs/design/project-functions.md`.

### §11.A Architecture diagram (text)

```
                ┌──────────────────────────────────────┐
                │ ~/.tool-agents/cli-agent/            │
                │   tool-prompts/                      │
                │     file_read.md                     │
                │     file_list.md                     │
                │     ...   (one MD file per tool)     │
                └──────────────┬───────────────────────┘
                               │  read on every cli-agent run
                               ▼
                    ┌──────────────────────┐
                    │ loadOverlayRegistry  │     (parses + validates)
                    └──────────┬───────────┘
                               │ ParsedOverlay map
                               ▼
                    cfg.toolPromptOverlays  (carried on AgentConfig)
                               │
                ┌──────────────┴────────────────┐
                ▼                               ▼
   ┌────────────────────────┐      ┌──────────────────────────┐
   │ BUILTIN_TOOL_PROMPTS   │      │ getToolDescription/      │
   │ (in-binary defaults)   │      │ getParamDescription      │
   └────────────────────────┘      │ (overlay-or-default)     │
                ▲                  └──────────┬───────────────┘
                │                             │
                │                             ▼
                │                ┌──────────────────────────┐
                │                │ Each tool factory        │
                │                │  (file_*, web_*, bash_*, │
                │                │   tool_help, agt_*)      │
                │                └──────────┬───────────────┘
                │                           │
                │                           ▼
                │                ┌──────────────────────────┐
                │                │ DynamicStructuredTool    │
                │                │  .description / .schema  │
                │                └──────────┬───────────────┘
                │                           │
                ▼                           ▼
        ┌───────────────────────────────────────────┐
        │ buildToolCatalog → bindTools to LLM       │
        └───────────────────────────────────────────┘
```

### §11.B Module layout

| File | Role |
|---|---|
| `src/agent/tools/tool-prompts-builtin.ts` | Single source of truth for built-in defaults: `BUILTIN_TOOL_PROMPTS` map keyed by tool name |
| `src/agent/tools/tool-prompt-overlay.ts` | Parser + loader + helpers (`parseOverlayFile`, `loadOverlayRegistry`, `getToolDescription`, `getParamDescription`, `serializeOverlay`) |
| `src/agent/tools/tool-prompt-overlay.spec.ts` | Parser + loader + helper tests |
| `src/config/agent-config.ts` | Adds `AgentConfig.toolPromptOverlays` field; bootstrap auto-seed |
| `src/commands/extract-tool-prompts.ts` | `extract-tool-prompts` subcommand |
| `src/commands/show-tool-prompt.ts` | `show-tool-prompt` subcommand |
| `src/commands/audit-tool-prompts.ts` | `audit-tool-prompts` subcommand |
| `src/cli.ts` | 3 new subcommands wired through `optsWithGlobals` + `pickFirstTool` |
| `src/agent/tools/<group>/<name>-tool.ts` | Each factory consults the overlay registry for its description + parameters |

### §11.C Markdown overlay format

```markdown
# <tool name>

## Description

<free-form prose, multi-paragraph allowed>

## Parameters

### <param-name-1>

<param description>

### <param-name-2>

<param description>
```

Validation rules:
1. Exactly one H1 line at the top; its content (after `# `) MUST equal the
   filename without the `.md` suffix. Mismatch → `ConfigurationError`.
2. `## Description` section is mandatory; body must be non-empty.
3. `## Parameters` section is optional. If present, contains zero or more
   `### <param>` subsections. Duplicate parameter names → `ConfigurationError`.
4. Body of each section is verbatim markdown (preserved on extract/show/audit).
   Trailing whitespace is trimmed; internal whitespace is preserved.

### §11.D Bootstrap behavior

`bootstrapAgentDir` extension:

```
1. Ensure ~/.tool-agents/cli-agent/tool-prompts/ exists (mode 0700).
2. For each (toolName, builtin) in BUILTIN_TOOL_PROMPTS:
     filename = <toolName>.md
     if not exists at <toolPromptsDir>/<filename>:
       write serializeOverlay(toolName, builtin) (mode 0600)
       record in seeded[]
3. If seeded.length > 0: stderr "[cli-agent] seeded N new tool-prompt overlays: <names>"
```

Additive-only: existing files are never modified, never overwritten. The user
remains in full control of their edits across upgrades.

### §11.E Architectural decisions

- **ADR-OVR-1**: Pure markdown format (no YAML frontmatter). Rejecting
  `js-yaml` dependency keeps install size unchanged. The H1 → filename
  cross-check provides the "tool: name" sanity check that frontmatter would
  otherwise carry.
- **ADR-OVR-2**: Single registry file (`BUILTIN_TOOL_PROMPTS`) instead of
  one constants file per tool. Easier to scan, easier to audit, and the
  type system catches missing-tool regressions at compile time.
- **ADR-OVR-3**: Full overwrite, no templating (no `{{default}}` substitution
  in v1). Keeps the format simple; users who want partial override can copy
  the built-in description and edit. If demand emerges, templating can be
  added later without breaking existing files.
- **ADR-OVR-4**: Stale parameter overlays log a one-time warning at startup
  but do not abort. Hard fail would lock the user out after a parameter
  rename in a later release. Hard fail is reserved for malformed-format
  errors (genuine corruption, not version drift).
- **ADR-OVR-5**: Bootstrap is additive-only and runs on every cold start
  (not just first run). Catches new tools introduced in later releases
  without forcing the user to re-run `extract-tool-prompts`.
