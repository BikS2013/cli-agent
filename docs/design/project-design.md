# cli-agent — Project Design

## 1. Overview

`cli-agent` is a standalone Node.js CLI binary that runs a LangGraph ReAct agent wrapping
any set of external CLI tools declared at launch. It inverts the standard "agentify your
existing CLI" pattern: the agent IS the tool; wrapped CLIs are driven through the built-in
bash allowlist, while first-party file and web operations live in the `agt_*` agent-tools
pack.

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
    │       for each wrapped tool in cfg.tools:
    │         if <capabilitiesDir>/<tool>.md exists and refresh is not forced:
    │           trust the cached document and skip probing
    │         otherwise:
    │           getBinaryInfo (PATH lookup + mtime + version hash)
    │           runHelp (--help, -h, help <sub> fallbacks)
    │           extractSubcommands (LLM call with Zod structured output, unless small-help fast path applies)
    │           composeCapabilityDoc (YAML frontmatter + AUTO-GENERATED + USER-NOTES/RECIPES)
    │           writeCacheEntry (mode 0600)
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
    │       Built-in toolkit: bash_list_allowed, bash_which, tool_help
    │       + allowlist non-empty: bash_run (READ-ONLY-AGENT or MUTATING mode)
    │       + agent-tools pack: agt_glob/grep, agt_web_*, agt_file_*,
    │                           agt_multiedit/patch, agt_todo_*
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

## 2a. Runtime Assembly

Runtime setup is centralized in `assembleAgentRuntime(cfg, opts)` in
`src/agent/run.ts` (Plan 013). The helper owns the common construction path for
the one-shot runner, streaming one-shot runner, TUI bootstrap, and legacy
readline interactive runner:

1. create the session logger,
2. create the LLM through `createLLM(cfg)`,
3. assemble the post-scoping tool catalog through `buildToolCatalog(cfg, logger)`,
4. create the LLM I/O capture channel for the same session id,
5. run wrapped-tool capability discovery when `cfg.tools` is non-empty,
6. compose the capability and system prompt sections,
7. log `session_start` and optional `profile_active`,
8. build the LangGraph agent graph.

The public runner exports keep lifecycle-specific ownership outside the helper:
one-shot and streaming runners log their own `user_prompt` and close logger plus
capture in `finally`; the TUI receives the open runtime and controller-owned
capture; legacy interactive keeps its readline loop and mutable thread id while
using the same assembled graph/runtime.

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

### Standard cross-cutting tools

| Tool | Mutating | Description |
|---|---|---|
| `bash_list_allowed` | No | List the bash allowlist |
| `bash_which` | No | Resolve binary on PATH |
| `bash_run` | Deviation† | Execute allow-listed binary |
| `tool_help` | No | Fetch capability doc or subcommand section |

> **Current contract (plan-011/012; surfaces updated by plan-015):** web and
> file operations are no longer built-in cross-cutting tools. `web_search` /
> `web_fetch` moved to `agt_web_search` / `agt_web_fetch`; `file_read` /
> `file_list` / `file_write` / `file_edit` / `file_append` moved to
> `agt_file_read` / `agt_file_list` / `agt_file_write` / `agt_file_edit` /
> `agt_file_append`. Since plan-015 whether the `agt_*` pack loads at all is
> decided by the `--mode` knob (present in `basic` / `tool` / `composite`,
> absent in `chat`), and individual tools are toggled with
> `--enable-tool <name>` / `--disable-tool <name>` — NOT by the removed
> `--agent-tools` / `--no-builtin-tools` / `--disable-agt-*` flags.

\* `agt_file_write`, `agt_file_edit`, `agt_file_append`, `agt_multiedit`, and
  `agt_patch` are off unless `--allow-mutations`.
† `bash_run` is visible whenever the built-in toolkit is loaded (mode `tool`
  or `composite`), regardless of `--allow-mutations`. Since 2026-07-04 an
  empty allowlist no longer hides it — it means UNRESTRICTED execution
  (see the 2026-07-04 fail-open design entry).
  Without `--allow-mutations`, the description carries `[READ-ONLY-AGENT]` prefix as a warning.
  This is a documented deviation from the standard spec (see configuration-guide.md).

## 5. Capability Discovery

Files under `~/.tool-agents/cli-agent/capabilities/<tool>.md`.

Normal startup uses a doc-exists shortcut: when a schema-supported capability
document already exists and refresh is not forced, discovery treats it as cached
and returns before PATH lookup, mtime/version probing, help probing, or LLM
rediscovery. Explicit refresh remains the invalidation boundary:
`--refresh-capabilities`, `cli-agent refresh-capabilities`, and TUI
`/refresh-capabilities` bypass the cached document shortcut and rebuild the
document from the current binary.

The USER-NOTES and USER-RECIPES sections are preserved byte-for-byte across
re-introspection. USER-RECIPES (introduced in schema-2 / 0.3.0) holds user-curated
canonical invocations; the `extract-recipes` subcommand proposes recipes via the
LLM and prints them to stdout for the user to review and paste — it never writes
to disk. USER-RECIPES appears above USER-NOTES in the rendered file.

Discovery also probes `man -w <tool>` to detect a manual page. When found, the
document records `manRef: man:<section> <tool>` in YAML frontmatter and emits a
`## Manual reference` section pointing the agent at `man <section> <tool>`.
When `man -w` exits non-zero / empty / unparseable, both artifacts are omitted
entirely — no fallback, no placeholder. Schema-1 documents (pre-0.3.0) are
treated as cache miss on read and re-discovered into schema-2 with USER-NOTES
carried forward.

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

> **Historical design record (plan-003). Flag surfaces superseded by plan-015.**
> The CLI opt-out surface described in this chapter — the `--no-agent-tools`
> umbrella and the per-tool `--enable-agt-<tool>` / `--disable-agt-<tool>`
> flags (and their `--enable-agt-X --disable-agt-X` conflict handling) — was
> REMOVED by plan-015. The pack now loads by `--mode` (`basic`/`tool`/
> `composite`; absent in `chat`) and individual tools toggle with
> `--enable-tool <name>` / `--disable-tool <name>`. The per-tool
> `CLI_AGENT_AGT_*` env vars and `agentTools.tools.*` config keys are
> unchanged. See the dated "2026-07-04 — CLI Mode Simplification" entry at
> the end of this document for the current surface. The pack's tools and
> internal representation (this chapter's substance) are otherwise current.

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
    readOnly       = [bash_list_allowed, bash_which, tool_help]
    bashRunTools   = allowlist.length > 0 ? [bash_run] : []          // unchanged
    // agent-tools group (group-builder.ts) now also registers, read-only,
    // when their per-tool flags are on: agt_web_search, agt_web_fetch,
    // agt_file_read, agt_file_list. Mutating agt_file_write/edit/append
    // register only when the per-tool flag and cfg.allowMutations are true.

    policy         = cliAgentPermissionPolicy(cfg)                   // NEW, once
    needsSession   = cfg.agentTools.enabled
                       && (cfg.agentTools.tools.todoRead
                           || cfg.agentTools.tools.todoWrite)
    sessionStore   = needsSession ? { todos: null } : undefined      // NEW

    group          = buildAgentToolsGroup(cfg, policy, sessionStore) // NEW

    return {
      tools:           [...readOnly, ...bashRunTools, ...group.tools],
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
| Upstream throws synchronously inside `execute()` | Wrapper's outer `try/catch` catches; `handleToolError(err)` is called; recoverable errors → JSON string return; `ConfigurationError`/`AuthError` → re-thrown (fatal) | Same recoverable-error convention as the first-party tools (for example `agt_file_read`). |
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
| **`DynamicStructuredTool` for wrappers (NOT `tool()` factory)** | Matches the project's authored first-party tool style (`agt_file_*`, `agt_web_*`, `bash_*`, `tool_help`); `func` receives `RunnableConfig` as the third argument (research §2.1) which is the documented LangChain pattern. Consistency with the existing catalog implementation. | `tool()` factory (config is 2nd arg, mismatched style); upstream `toLangChainTool` adapter (closes over `ToolContext` at construction time — defeats per-call injection; research §3 source 3). |
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
                │     agt_file_read.md                 │
                │     agt_file_list.md                 │
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
                │                │  (agt_file_*, agt_web_*, │
                │                │   bash_*, tool_help)     │
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

## §12. Configuration Profiles (plan-005)

**Plan reference**: `docs/design/plan-005-config-profiles.md`.
**Spec reference**: `docs/design/refined-request-config-profiles.md`
(FR-PROF-001 … FR-PROF-016 + NFR-PROF-001 … NFR-PROF-004 in
`docs/design/project-functions.md`).
**Coexists with**: §11 (tool-prompt overlays). The two subsystems are
orthogonal — overlays change a tool's *prompt text*, profiles change *which
tools are exposed* and *what default arguments they carry*. See §12.K.

A configuration profile is a named, persistent harness preset stored under
`~/.tool-agents/cli-agent/profiles/<name>.{yaml|yml|json}` that bundles three
independently-optional sections — `cliParams`, `tools`, `toolArgs` —
activated via `--profile <name>` or `CLI_AGENT_PROFILE=<name>`. Profile
`cliParams` slot into the existing four-tier resolution chain at a new
**tier 5**, between local `./.env` (tier 4) and `config.json` (tier 6),
preserving the user-facing invariant that explicit CLI flags always win.

### §12.A Architecture diagram (text)

```
                  ┌──────────────────────────────────────────────┐
                  │ ~/.tool-agents/cli-agent/                    │
                  │   profiles/                                  │
                  │     review.yaml                              │
                  │     scratch.yaml                             │
                  │     docs.json   (tolerated on read)          │
                  └──────────────────────┬───────────────────────┘
                                         │  read on every run
                                         │  IFF --profile or
                                         │       CLI_AGENT_PROFILE set
                                         ▼
                       ┌────────────────────────────────┐
                       │ profile-codec.ts               │
                       │  parseProfile / stringifyProfile│
                       │  createProfileStub             │
                       │  detectAmbiguity (E18)         │
                       │  rejectAliases (ADR-PROF-8)    │
                       └────────────────┬───────────────┘
                                        │ unknown → Zod
                                        ▼
                       ┌────────────────────────────────┐
                       │ profile-schema.ts              │
                       │  ProfileSchema (.strict() top, │
                       │   .passthrough() on cliParams) │
                       │  CREDENTIAL_KEY_PATTERN (E11)  │
                       │  validateNoSecrets             │
                       │  validateToolArgsAgainstTool   │
                       │  KNOWN_CLI_PARAMS              │
                       └────────────────┬───────────────┘
                                        │ Profile (typed)
                                        ▼
                       ┌────────────────────────────────┐
                       │ profile-loader.ts              │
                       │  loadProfile(name, agentDir)   │
                       │  resolveProfilePath (E16/E18)  │
                       │  listProfiles                  │
                       │  + name/stem cross-check (E4)  │
                       │  + SHA-256 digest (first 16)   │
                       └────────────────┬───────────────┘
                                        │ ResolvedProfile
       ┌────────────────────────────────┼──────────────────────────┐
       ▼                                ▼                          ▼
┌──────────────────┐    ┌────────────────────────┐    ┌─────────────────────────┐
│ agent-config.ts  │    │ tools/profile-scoping  │    │ tools/profile-tool-args │
│ tier-5 insertion │    │ allow → deny → order   │    │ shallow merge per .func │
│ at each knob:    │    │ strict 3-pass; hard    │    │ helper invoked from     │
│ flags.X          │    │ errors on intersection │    │ runConfig.configurable  │
│  ?? layered.X    │    │ duplicate-order, empty │    │                         │
│  ?? PROFILE.X    │    └──────────────┬─────────┘    └─────────────┬───────────┘
│  ?? configFile.X │                   │                            │
└──────────────────┘                   │                            │
       │                                │                            │
       ▼                                ▼                            ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│ AgentConfig                                                                   │
│   + activeProfile?:     { name; path; schemaVersion; digest }                 │
│   + activeProfileData?: { cliParams?; tools?; toolArgs? }                     │
└──────────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────┐    ┌──────────────────────────┐    ┌─────────────────────────┐
│ buildToolCatalog         │ →  │ runOneShot/streamOneShot │ →  │ logger.log(             │
│  applies scoping at      │    │ buildTuiAgentRuntime     │    │   kind:'profile_active')│
│  registry.ts:84          │    │ inject profileToolArgs   │    │   after session_start   │
│  (re-derives agent-tools │    │ into configurable bag    │    │   before user_prompt    │
│   meta after scoping)    │    └──────────────────────────┘    └─────────────────────────┘
└──────────────────────────┘

Six new top-level subcommands (profile-list / profile-show / profile-create /
profile-edit / profile-delete / profile-dry-run) consume the same loader +
codec + schema. profile-dry-run additionally calls a "trace mode" of
loadAgentConfig that records per-knob source attribution.
```

The architecture preserves the §2 bootstrap pipeline; the profile subsystem
is **additive** and gated by activation. When neither `--profile` nor
`CLI_AGENT_PROFILE` is set, every code path short-circuits before any
filesystem access (NFR-PROF-001 / cold-start budget).

### §12.B Module layout

| File | Role | Status |
|---|---|---|
| `src/config/profile-codec.ts` | Encapsulates ALL `yaml`-package interaction. Exports `parseProfile`, `stringifyProfile`, `createProfileStub`, `detectAmbiguity`. | NEW |
| `src/config/profile-codec.spec.ts` | Codec tests (E2 line/col, E18 ambiguity, alias rejection). | NEW |
| `src/config/profile-schema.ts` | Zod schema, `KNOWN_CLI_PARAMS`, `CREDENTIAL_KEY_PATTERN`, `validateNoSecrets`, `validateToolArgsAgainstTool`. | NEW |
| `src/config/profile-schema.spec.ts` | Schema tests (E3 strict, E6 empty allow, E10 toolArgs, E11 secrets, E20 forward-compat). | NEW |
| `src/config/profile-loader.ts` | `loadProfile`, `resolveProfilePath`, `listProfiles`, digest, name/stem check. | NEW |
| `src/config/profile-loader.spec.ts` | Loader tests (E1 missing, E4 stem mismatch, E5 empty, E16 illegal chars, E17 unreadable, E18 ambiguity). | NEW |
| `src/agent/tools/profile-scoping.ts` | `applyProfileToolScoping(tools, scoping)` strict 3-pass. | NEW |
| `src/agent/tools/profile-scoping.spec.ts` | Scoping tests (AC-7..10, E6, E7, E8, E21, E22, E23). | NEW |
| `src/agent/tools/profile-tool-args.ts` | `mergeProfileToolArgs(input, configurable, toolName)` shallow per-key merge. | NEW |
| `src/agent/tools/profile-tool-args.spec.ts` | Merge tests (AC-11, AC-12, E9). | NEW |
| `src/commands/profile/list.ts` | `profile-list` handler (FR-PROF-008 / AC-13). | NEW |
| `src/commands/profile/show.ts` | `profile-show <name>` handler (FR-PROF-009 / AC-14). | NEW |
| `src/commands/profile/create.ts` | `profile-create <name>` handler (FR-PROF-010 / AC-15). | NEW |
| `src/commands/profile/edit.ts` | `profile-edit <name>` handler (FR-PROF-011). | NEW |
| `src/commands/profile/delete.ts` | `profile-delete <name>` handler (FR-PROF-012). | NEW |
| `src/commands/profile/dry-run.ts` | `profile-dry-run` handler (FR-PROF-013 / AC-16). | NEW |
| `src/commands/profile/shared.ts` | Shared helpers: `formatTable`, `resolveProfilePathOrThrow`, `printProfileSummary`. | NEW |
| `src/commands/profile/*.spec.ts` | Per-handler co-located specs. | NEW |
| `src/config/agent-config.ts` | Tier-5 insertion at each knob; `activeProfile` / `activeProfileData` fields; `bootstrapProfilesDir`; `'CLI_AGENT_PROFILE'` in `OTHER_ENV_KEYS`; optional trace-mode. | EXTEND |
| `src/cli.ts` | `--profile <name>` flag + 6 subcommand registrations. | EXTEND |
| `src/agent/tools/registry.ts` | Apply scoping at line 84; re-derive `agentToolsMeta` after scoping. | EXTEND |
| `src/agent/graph.ts` | Inject `profileToolArgs` into `configurable` (lines 86-95, 160-174). | EXTEND |
| `src/agent/run.ts` | `buildTuiAgentRuntime` mirror; emit `profile_active` log after `session_start`. | EXTEND |
| `src/agent/logging.ts` | Extend `LogEvent` union with `profile_active`. | EXTEND |
| 17 tool factories (`bash/*`, `file/*`, `web/*`, `tool-help-tool.ts`, `agent-tools/agt-*.ts`) | One-line `mergeProfileToolArgs` call at top of each `.func`. | EXTEND |

`package.json` gains a single new dependency: `"yaml": "^2.6.0"` (eemeli/yaml,
zero-dep, first-party TS types). No other dependencies are added; Zod is
already present.

### §12.C Profile YAML format (canonical write form)

```yaml
# ~/.tool-agents/cli-agent/profiles/<name>.yaml
name: <string>             # MUST equal the filename stem (E4).
description: <string>      # Free-form, used by profile-list / profile-show.
schemaVersion: 1           # Reserved for future migrations. Default: 1.

cliParams:                 # Section 1: CLI parameter presets (passthrough).
  provider: <string>
  model: <string>
  temperature: <number>
  maxIterations: <integer>
  workingDir: <string>
  logLevel: <string>
  webSearchBackend: <string>
  allowMutations: <boolean>
  # ... any cli-agent CLI/config knob the user wishes to pin.
  # Unknown keys are forward-compat (ADR-PROF-6 + E20).

tools:                     # Section 2: Broad-scope tool list scoping.
  allow: [<toolName>, ...]   # Optional. Empty array → ConfigurationError (E6).
  deny:  [<toolName>, ...]   # Optional. Applied AFTER allow.
  order: [<toolName>, ...]   # Optional. Survivors not in `order` keep
                             #   original registration order, appended.

toolArgs:                  # Section 3: Per-tool argument presets.
  <toolName>:              # e.g. "bash_run", "agt_web_search", "agt_grep"
    <argName>: <value>     # Default values for that tool's flags/arguments.
```

`name`, `description`, `schemaVersion`, and all three top-level sections are
independently optional. An empty profile (just `name:`) is legal but inert
(E5 prints a stderr notice). JSON files using the same schema are tolerated
on read; the canonical write format is YAML (ADR-PROF-1).

### §12.D Data models

#### Zod schema

```ts
// src/config/profile-schema.ts
import { z } from 'zod'

export const KNOWN_CLI_PARAMS = new Set([
  'provider', 'model', 'temperature', 'maxIterations', 'workingDir',
  'logLevel', 'webSearchBackend', 'allowMutations',
  // ... plus every other pinnable knob in agent-config.ts
] as const)

export const CREDENTIAL_KEY_PATTERN = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i

export const ProfileCliParamsSchema = z.object({
  provider:         z.string().optional(),
  model:            z.string().optional(),
  temperature:      z.number().optional(),
  maxIterations:    z.number().int().positive().optional(),
  workingDir:       z.string().optional(),
  logLevel:         z.string().optional(),
  webSearchBackend: z.string().optional(),
  allowMutations:   z.boolean().optional(),
}).passthrough()  // E20: forward-compat for unknown cliParams keys.

export const ProfileToolsSchema = z.object({
  allow: z.array(z.string()).min(1).optional(),  // E6: empty array rejected.
  deny:  z.array(z.string()).optional(),
  order: z.array(z.string()).optional(),
}).strict()

export const ProfileToolArgsSchema = z.record(
  z.string(),                              // tool name
  z.record(z.string(), z.unknown()),       // arg key → value
)

export const ProfileSchema = z.object({
  name:          z.string().optional(),
  description:   z.string().optional(),
  schemaVersion: z.literal(1).default(1),
  cliParams:     ProfileCliParamsSchema.optional(),
  tools:         ProfileToolsSchema.optional(),
  toolArgs:      ProfileToolArgsSchema.optional(),
}).strict()  // E3: unknown top-level keys rejected.

export type Profile           = z.infer<typeof ProfileSchema>
export type ProfileCliParams  = z.infer<typeof ProfileCliParamsSchema>
export type ProfileTools      = z.infer<typeof ProfileToolsSchema>
export type ProfileToolArgs   = z.infer<typeof ProfileToolArgsSchema>
```

#### Runtime types

```ts
// Returned by loadProfile(); cached on AgentConfig for the duration of a run.
export interface ResolvedProfile {
  readonly name: string                  // canonical (filename stem)
  readonly path: string                  // absolute path of the loaded file
  readonly schemaVersion: 1
  readonly digest: string                // SHA-256 hex first 16 chars over RAW bytes
  readonly cliParams?: ProfileCliParams
  readonly tools?:     ProfileTools
  readonly toolArgs?:  ProfileToolArgs
  readonly warnings:   readonly string[] // E8/E9/E20/E21 deferred warnings
}

// Carried on AgentConfig for downstream consumers.
export interface AgentConfigProfileFields {
  readonly activeProfile?: {
    readonly name: string
    readonly path: string
    readonly schemaVersion: number
    readonly digest: string
  }
  readonly activeProfileData?: {
    readonly cliParams?: ProfileCliParams
    readonly tools?:     ProfileTools
    readonly toolArgs?:  ProfileToolArgs
  }
}
```

#### Public API of `mergeProfileToolArgs`

```ts
// src/agent/tools/profile-tool-args.ts
export function mergeProfileToolArgs<I extends Record<string, unknown>>(
  input: I,
  configurable: { profileToolArgs?: Record<string, Record<string, unknown>> } | undefined,
  toolName: string,
): I {
  const presets = configurable?.profileToolArgs?.[toolName]
  if (!presets) return input
  return { ...presets, ...input } as I  // runtime input wins per-key (FR-PROF-006).
}
```

### §12.E Subcommand surface (flat hyphenated — ADR-PROF-5 / OQ-3)

| Subcommand | Alias | Effect | Default exit codes |
|---|---|---|---|
| `profile-list` | `profiles` | Tabular: name, description (first line), size, mtime. Empty dir → hint message. | 0 (success or empty), 6 (IO error) |
| `profile-show <name>` | — | Print raw + parsed/normalized + summary (with current-catalog evaluation). `--json` opt-in. | 0 / 2 (missing) / 3 (malformed) |
| `profile-create <name> [--from-current] [--description "..."] [--force]` | — | Scaffold YAML stub at mode `0600`; `--from-current` captures resolved config. | 0 / 2 (exists w/o `--force`) |
| `profile-edit <name>` | — | Open in `$EDITOR` ($VISUAL fallback, then vi/notepad). Re-validate after exit; file left as-is on failure. | 0 / 2 (missing) / 3 (validation fail) |
| `profile-delete <name> [--yes]` | `profile-rm` | Confirm prompt (skipped with `--yes`); delete file. | 0 / 2 (missing) |
| `profile-dry-run [--profile <name>] [other flags] [--json]` | — | Resolve full config + tool scoping; print effective state with per-knob source attribution. Does NOT instantiate LLM, run capability discovery, or execute tools. | 0 / 2 / 3 |

Top-level activation flag (added to the default command and all six profile
subcommands that accept `--profile`):

```
--profile <name>    Activate a named configuration profile.
                    Equivalent env var: CLI_AGENT_PROFILE.
                    CLI flag wins over env (E12).
```

Output formats: human-readable by default (kubectl/aws-style), `--json` opt-in
for `profile-list` / `profile-show` / `profile-dry-run`. The `--json` schema
is documented in `docs/design/configuration-guide.md` and is the same shape
used by the investigation §"Q7 Recommendation".

### §12.F Filesystem layout

```
~/.tool-agents/cli-agent/
  profiles/                       (dir, mode 0700 — created by bootstrapAgentDir)
    review.yaml                   (file, mode 0600)
    scratch.yaml                  (file, mode 0600)
    docs.json                     (file, mode 0600 — tolerated on read)
```

Constraints:

- Filename stem MUST equal the in-file `name:` field if present (E4).
- Filenames MUST NOT contain `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`,
  control characters, or a leading `.` (E16). Validated by both the loader
  and `profile-create`.
- Both `<name>.yaml` and `<name>.json` for the same stem is a hard error
  (E18) — the codec rejects ambiguity rather than silently preferring one
  extension.
- `profile-create` writes YAML by default (ADR-PROF-1); the file is created
  with mode `0600` (NFR-PROF-002).
- The `profiles/` directory is **NOT** seeded with any sample/default file
  (contrast with §11 overlays, which auto-seed). Profiles are user-authored.

### §12.G Precedence integration (tier-5 insertion)

The existing per-knob expressions in `src/config/agent-config.ts` (lines
706-862) follow the pattern:

```
flags.X ?? layered['AGENT_X'] ?? configFile?.X
```

Each such expression is mechanically extended to:

```
flags.X ?? layered['AGENT_X'] ?? activeProfileData?.cliParams?.X ?? configFile?.X
```

The composed resolution chain becomes (highest priority first):

```
1. Explicit CLI flag                                     ← always wins
2. Shell environment variable
3. ~/.tool-agents/cli-agent/.env                  ┐
4. Local ./.env                                   │ flattened into "layered"
                                                  │ snapshot (fill-gaps)
5. PROFILE cliParams (if active)                  ← NEW (tier 5)
6. ~/.tool-agents/cli-agent/config.json
7. Built-in defaults (where applicable; otherwise ConfigurationError)
```

Profile activation itself is decided ONCE at the top of `loadAgentConfig`,
after the layered env snapshot is built and before any per-knob resolution:

```
const profileName = flags.profile ?? layered['CLI_AGENT_PROFILE']
if (profileName) {
  const resolved = await loadProfile(profileName, agentDir)
  // resolved.cliParams flows into activeProfileData.cliParams
  // resolved.tools / toolArgs flow through unchanged
}
```

This guarantees:

- E12 (both flag and env set) — the `??` chain naturally lets `flags.profile`
  win over `layered['CLI_AGENT_PROFILE']`.
- AC-4 (CLI flag beats profile) — the per-knob `flags.X ?? ...` ensures any
  explicit CLI flag short-circuits before profile values are consulted.
- AC-5 (shell env beats profile) — `layered['AGENT_X']` is consulted before
  `activeProfileData?.cliParams?.X`.
- AC-6 (profile beats `config.json`) — `activeProfileData?.cliParams?.X`
  precedes `configFile?.X`.
- AC-21 (no regression) — when `profileName` is undefined,
  `activeProfileData` is undefined and every `?? activeProfileData?.cliParams?.X`
  clause short-circuits to `?? configFile?.X` exactly as before.

The audit guarantee for R-2 (silent precedence bug): a grep over
`agent-config.ts` for `\?\? configFile\?\.` MUST find every match preceded
on the same expression by `\?\? activeProfileData\?\.cliParams\?\.`. A
unit test per pinnable knob asserts the chain.

### §12.H Tool-scoping algorithm

```
function applyProfileToolScoping(
  tools: AnyTool[],
  scoping: { allow?: string[]; deny?: string[]; order?: string[] } | undefined,
): { tools: AnyTool[]; warnings: string[] } {

  if (!scoping) return { tools, warnings: [] }
  const { allow, deny, order } = scoping
  const warnings: string[] = []
  const registered = new Set(tools.map(t => t.name))

  // Hard-error guards run FIRST so messages can quote user input verbatim.
  if (allow && deny) {
    const intersection = allow.filter(n => deny.includes(n))
    if (intersection.length > 0) {
      throw new ConfigurationError(                                  // E23
        `profile.tools: allow ∩ deny is non-empty: ${intersection.join(', ')}.` +
        ` Each tool must appear in at most one of allow/deny.`)
    }
  }
  if (order) {
    const seen = new Set<string>()
    const dups = order.filter(n => (seen.has(n) ? true : (seen.add(n), false)))
    if (dups.length > 0) {
      throw new ConfigurationError(                                  // E22
        `profile.tools.order has duplicate entries: ${dups.join(', ')}.`)
    }
  }

  // Pass 1: allow (intersect with registered).
  let survivors: AnyTool[]
  if (allow) {
    for (const name of allow) {
      if (!registered.has(name)) {
        warnings.push(                                               // E8
          `profile.tools.allow lists '${name}' which is not registered ` +
          `(forward-compat; ignoring)`)
      }
    }
    survivors = tools.filter(t => allow.includes(t.name))
  } else {
    survivors = tools.slice()
  }

  // Pass 2: deny.
  if (deny) {
    const survivorSet = new Set(survivors.map(t => t.name))
    for (const name of deny) {
      if (!survivorSet.has(name)) {
        warnings.push(                                               // E8
          `profile.tools.deny lists '${name}' which is not in the survivor set ` +
          `(forward-compat; ignoring)`)
      }
    }
    survivors = survivors.filter(t => !deny.includes(t.name))
  }

  // Hard-error guard: empty post-scoping catalog.
  if (survivors.length === 0) {
    throw new ConfigurationError(                                    // E7
      `profile.tools scoping disables every registered tool. ` +
      `Remove an entry from allow/deny to keep at least one tool visible.`)
  }

  // Pass 3: order (stable; non-listed survivors appended in original order).
  if (order) {
    const survivorByName = new Map(survivors.map(t => [t.name, t]))
    const ordered: AnyTool[] = []
    for (const name of order) {
      const t = survivorByName.get(name)
      if (t) {
        ordered.push(t)
        survivorByName.delete(name)
      } else {
        warnings.push(                                               // E21
          `profile.tools.order lists '${name}' which is not in the survivor set ` +
          `(after allow/deny); ignoring`)
      }
    }
    // Append remaining survivors in their original registration order.
    for (const t of survivors) {
      if (survivorByName.has(t.name)) ordered.push(t)
    }
    survivors = ordered
  }

  return { tools: survivors, warnings }
}
```

After scoping, `buildToolCatalog` re-derives `agentToolsMeta` (the per-pack
metadata produced by `buildAgentToolsGroup`) from the surviving tools so the
catalog-level invariant at `group-builder.ts:186` holds.

### §12.I Error handling strategy (E1–E23)

Every edge case maps to one of three typed errors with hard-wired exit
codes (per `src/errors.ts`):

| Edge case | Error class | Exit | Owning module |
|---|---|---|---|
| E1  profile not found | `UsageError` | 2 | profile-loader (`resolveProfilePath`) |
| E2  malformed YAML/JSON | `ConfigurationError` | 3 | profile-codec (line/col via `parseDocument().errors`) |
| E3  unknown top-level key | `ConfigurationError` | 3 | profile-schema (`.strict()`) |
| E4  `name:` ≠ stem | `ConfigurationError` | 3 | profile-loader |
| E5  empty profile | (none — stderr notice) | 0 | profile-loader |
| E6  `tools.allow: []` | `ConfigurationError` | 3 | profile-schema (`.min(1)`) |
| E7  empty post-scoping catalog | `ConfigurationError` | 3 | profile-scoping |
| E8  unknown name in allow/deny/order | (warning) | — | profile-scoping |
| E9  toolArgs references excluded tool | (warning) | — | profile-loader / profile-tool-args (load-time check) |
| E10 toolArgs arg fails Zod | `ConfigurationError` (known schema) / warning (dynamic schema) | 3 / — | profile-schema (`validateToolArgsAgainstTool`) |
| E11 credential-shape key in cliParams | `ConfigurationError` | 3 | profile-schema (`validateNoSecrets`) |
| E12 both `--profile` and env set | (CLI wins, no error) | — | agent-config |
| E13 `--profile` repeated | (last wins, no error) | — | Commander default |
| E14 `--profile` with no argument | Commander usage error | 2 | Commander default |
| E15 excluded tool has overlay | (overlay silently unused) | — | runtime sequencing |
| E16 illegal filename chars | `UsageError` | 2 | profile-loader / profile-create |
| E17 profiles/ unreadable | `IOError` | 6 | profile-loader |
| E18 both yaml + json for same stem | `ConfigurationError` | 3 | profile-codec (`detectAmbiguity`) |
| E19 profile sets `allowMutations: true` | (intentional; profile applies) | — | agent-config |
| E20 unknown cliParams key | (per-key warning) | — | profile-schema (`.passthrough()` + warn-pass) |
| E21 `order` lists non-survivor | (warning) | — | profile-scoping |
| E22 duplicate `order` entry | `ConfigurationError` | 3 | profile-scoping |
| E23 allow ∩ deny non-empty | `ConfigurationError` | 3 | profile-scoping |

Per the project's no-fallback rule (FR-PROF-015): missing required
configuration values remain `ConfigurationError` (exit 3). Profiles never
substitute a missing required value with a silent default; they are an
additional source of explicit values, not a fallback mechanism. Schema
validation surfaces ALL Zod issues at once in a single `ConfigurationError`
message (ADR-PROF-11 Q3).

### §12.J Logging schema additions

The `LogEvent` union in `src/agent/logging.ts` gains five new event kinds
that integrate cleanly with §6 (which already enumerates eight mandatory
session events):

| Event kind | Emission point | Payload |
|---|---|---|
| `profile_loaded` | After `loadProfile` resolves | `{ ts, sessionId, profileName, profilePath, schemaVersion, digest, durationMs }` |
| `profile_active` | After `session_start`, before `user_prompt` (FR-PROF-007 / AC-19) | `{ ts, sessionId, profileName, profilePath, schemaVersion, digest }` |
| `profile_validation_error` | When schema validation fails (E2/E3/E4/E6/E10/E11/E18/E22/E23) | `{ ts, sessionId, profileName, profilePath, code, message, issues? }` |
| `tool_scoping_applied` | After `applyProfileToolScoping` returns | `{ ts, sessionId, allowApplied, denyApplied, orderApplied, registeredCount, finalCount, excludedByAllow, excludedByDeny, warnings }` |
| `tool_args_merged` | At each tool dispatch, only when profile presets exist for that tool | `{ ts, sessionId, toolName, profileKeys, runtimeKeys, mergedKeys }` |

The `digest` field is SHA-256 hex first 16 chars computed over **raw file
bytes** (ADR-PROF-9), guaranteeing byte-level reproducibility audit; raw
contents are never logged. The credential-scrubbing helper (`redactString`)
applies to all payload fields per §7.

### §12.K Coexistence with §11 tool-prompt overlays

The two subsystems are orthogonal by construction:

| Concern | §11 overlays | §12 profiles |
|---|---|---|
| File location | `~/.tool-agents/cli-agent/tool-prompts/<tool>.md` | `~/.tool-agents/cli-agent/profiles/<name>.{yaml\|json}` |
| Affects | Tool description text + parameter docstrings | Which tools are exposed; their default args; CLI param presets |
| Loaded by | `loadOverlayRegistry` → `cfg.toolPromptOverlays` | `loadProfile` → `cfg.activeProfile{,Data}` |
| Consumed by | Each tool factory at construction time (description / `.describe`) | `buildToolCatalog` (scoping); per-tool `.func` (arg merge); per-knob expressions (cliParams) |
| Bootstrap | Additive seed of all 17 overlays on each cold start | Directory created at `0700`; **NO file seeding** |
| Activation | Always active when overlay file exists | Opt-in via `--profile` or `CLI_AGENT_PROFILE` |
| Sequencing | Loaded BEFORE catalog assembly | Applied AFTER catalog assembly (scoping); tier-5 cliParams inserted at each knob |

**One-paragraph orthogonality statement**: A tool first survives profile
scoping (`applyProfileToolScoping` filters the assembled catalog at
`registry.ts:84`); only then does its overlay-driven description / parameter
text apply (because the factory for an excluded tool is never called, its
overlay file on disk is read but never consulted at runtime). Profile
`toolArgs` references for excluded tools are dead-code (E9 warning, dropped
from the runtime configurable bag). This means **overlays apply to a tool
*after* it has survived scoping**, and the two subsystems can be developed,
tested, and reasoned about independently.

### §12.L Test strategy

Vitest categories follow the existing `*.spec.ts` co-location convention
(IP-7 in the codebase scan):

| Category | Files | Focus |
|---|---|---|
| Codec unit | `src/config/profile-codec.spec.ts` | E2 (line/col), E18 (ambiguity), alias rejection (ADR-PROF-8), round-trip stability |
| Schema unit | `src/config/profile-schema.spec.ts` | E3 (strict), E6 (`.min(1)`), E10 (`.partial()` validation), E11 (credential regex), E20 (passthrough + warn-pass) |
| Loader unit | `src/config/profile-loader.spec.ts` | E1, E4, E5, E16, E17, digest stability, list-profiles, bootstrap mode 0700 |
| Scoping unit | `src/agent/tools/profile-scoping.spec.ts` | AC-7, AC-8, AC-9, AC-10, E7, E8, E21, E22, E23 |
| Args-merge unit | `src/agent/tools/profile-tool-args.spec.ts` | AC-11, AC-12, no-presets short-circuit, undefined-configurable safety |
| Config integration | `src/config/agent-config.spec.ts` (extended) | AC-2, AC-3, AC-4 (3 knobs), AC-5, AC-6, AC-21 (no-regression), E12, E13, E14, E19 |
| Registry integration | `src/agent/tools/registry.spec.ts` (extended) | Catalog scoping at line 84, agent-tools meta re-derivation |
| Subcommand integration | `src/commands/profile/*.spec.ts` | AC-13 (list), AC-14 (show), AC-15 (create), AC-16 (dry-run), edit/delete happy + error paths |
| Logging integration | `src/agent/logging.spec.ts` (extended) | AC-19 (`profile_active` event); five new kinds present |
| Overlay coexistence (E2E) | `src/agent/tools/registry.spec.ts` (new test) | AC-18 — profile excludes tool that has overlay; overlay file untouched |
| Cold-start smoke | `test_scripts/smoke-profile-cold-start.ts` | NFR-PROF-001 / AC-22 (≤ 50 ms baseline regression) |
| Regression | full suite | AC-21 byte-identical no-profile path |

Hermetic fs mocking follows the existing `vi.mock('node:fs/promises', ...)`
pattern with both `default` and named exports mocked; the `writtenPaths` set
fixture pattern (used in `agent-config.spec.ts:16-53`) is reused for the
loader spec.

### §12.M Phase 6 parallel implementation units

Five units can be built independently against the interface contracts
defined in §12.B / §12.D. Foundation modules (codec, schema, loader,
config wiring, CLI flag + subcommand stubs) land in the sequential
phases P3–P5 ahead of P6 fan-out.

| Unit | Scope | Imports from foundation | Exports to other units |
|---|---|---|---|
| **U-SCOPE** | `profile-scoping.ts` + integration at `registry.ts:84` | `ProfileTools` (schema), `ConfigurationError` (errors) | `applyProfileToolScoping(tools, scoping): { tools, warnings }` (consumed by U-AGENTCFG via `buildToolCatalog`) |
| **U-ARGS** | `profile-tool-args.ts` + 17 tool-factory `.func` updates + `graph.ts` configurable injection + `run.ts:217` mirror | `ProfileToolArgs` (schema) | `mergeProfileToolArgs(input, configurable, toolName): I` (consumed by every tool factory); `configurable.profileToolArgs` shape (consumed by U-AGENTCFG) |
| **U-CLI** | Six `src/commands/profile/*.ts` handlers + `shared.ts` + `cli.ts` registrations | `ResolvedProfile` (loader), `ProfileSchema` (schema), `parseProfile`/`stringifyProfile`/`createProfileStub` (codec), `loadProfile`/`listProfiles` (loader), `loadAgentConfig` trace mode (P7) | (no exports to other P6 units) |
| **U-AGENTCFG** | Tier-5 polish in `agent-config.ts` + `AgentCommandOptions` propagation + acceptance specs for AC-2..6 / E12 / E13 / E14 / E19 | `loadProfile` (loader), `applyProfileToolScoping` (U-SCOPE), `KNOWN_CLI_PARAMS` (schema) | `cfg.activeProfile` and `cfg.activeProfileData` (consumed by every downstream user); `KNOWN_CLI_PARAMS` re-exported for U-CLI's `profile-create --from-current` |
| **U-FOUNDATION-FOLLOWUP** | Reserved for any P3 follow-up surfaced during integration (e.g., `validateProfileToolArgs.ts` extracted across multiple call sites) | — | May be subsumed by U-AGENTCFG if no slippage occurs |

**Interface contracts** (the load-bearing signatures):

```ts
// EXPORTED by profile-loader.ts; CONSUMED by U-CLI, U-AGENTCFG.
export async function loadProfile(name: string, agentDir: string): Promise<ResolvedProfile>
export async function listProfiles(agentDir: string): Promise<ProfileFileEntry[]>
export function resolveProfilePath(name: string, agentDir: string): { yaml?: string; json?: string }

// EXPORTED by profile-scoping.ts (U-SCOPE); CONSUMED by U-AGENTCFG via registry.ts.
export function applyProfileToolScoping(
  tools: AnyTool[],
  scoping: ProfileTools | undefined,
): { tools: AnyTool[]; warnings: string[] }

// EXPORTED by profile-tool-args.ts (U-ARGS); CONSUMED by every tool factory.
export function mergeProfileToolArgs<I extends Record<string, unknown>>(
  input: I,
  configurable: { profileToolArgs?: Record<string, Record<string, unknown>> } | undefined,
  toolName: string,
): I

// EXPORTED by profile-schema.ts; CONSUMED by U-CLI, U-AGENTCFG, profile-loader.
export const ProfileSchema: z.ZodObject<...>
export const KNOWN_CLI_PARAMS: ReadonlySet<string>
export const CREDENTIAL_KEY_PATTERN: RegExp
export function validateNoSecrets(cliParams: object): void
export function validateToolArgsAgainstTool(
  toolName: string,
  args: Record<string, unknown>,
  schema?: z.ZodObject<any>,
): { ok: true } | { ok: false; issues: z.ZodIssue[] }

// EXPORTED by profile-codec.ts; CONSUMED by profile-loader and U-CLI.
export function parseProfile(text: string, filePath: string): Profile
export function stringifyProfile(profile: Profile): string
export function createProfileStub(name: string): string
export function detectAmbiguity(agentDir: string, name: string): { yaml?: string; json?: string }

// EXTENDED on AgentConfig (agent-config.ts); CONSUMED by all downstream code.
interface AgentConfig {
  // ... existing fields ...
  readonly activeProfile?: { name; path; schemaVersion; digest }
  readonly activeProfileData?: { cliParams?; tools?; toolArgs? }
}
```

Merge-conflict mitigation (R-11 from plan-005): P5 lands ALL flag/env/
subcommand-stub registrations BEFORE P6 fans out. P6 unit U-CLI fills the
stubs in `src/commands/profile/*.ts`; P6 unit U-ARGS edits `configurable`
literals in `graph.ts` / `run.ts` and the 17 `.func` bodies. No two units
edit the same line.

### §12.N Architectural decisions (ADRs)

The eleven decisions locked in plan-005 §6 are restated here for
completeness; three additional decisions emerged during this design phase.

- **ADR-PROF-1**: File format — YAML default (`yaml` ^2.6.0), JSON tolerated
  on read. Rationale: refined-spec Assumption 1 + investigation Recommendation #1.
- **ADR-PROF-2**: Precedence tier 5, between local `./.env` (tier 4) and
  `config.json` (tier 6). Rationale: refined-spec §FR-PROF-004 + investigation Recommendation #2.
- **ADR-PROF-3**: Strict three-pass `allow → deny → order` with hard errors
  on `allow ∩ deny`, duplicate `order`, empty post-scoping catalog, and
  explicitly empty `allow`. Rationale: investigation Recommendation #3.
- **ADR-PROF-4**: `toolArgs` shallow per-key merge at tool input level via
  shared `mergeProfileToolArgs` helper. Rationale: investigation Recommendation #4.
- **ADR-PROF-5**: CLI surface is flat hyphenated (`profile-list`, …).
  Rationale: investigation Recommendation #5; matches existing 5 flat
  subcommands. **Deviation** from refined-spec Assumption 5 — confirmed
  via OQ-3.
- **ADR-PROF-6**: Zod schema with `.strict()` top + `.passthrough()` on
  `cliParams`. Rationale: NFR-PROF-003.
- **ADR-PROF-7**: `profile-show` / `profile-dry-run` output — aws-style
  human table with per-knob source attribution by default; `--json` opt-in.
  Rationale: investigation Recommendation #7.
- **ADR-PROF-8**: YAML alias policy — reject all aliases. Rationale:
  research §6 Position A.
- **ADR-PROF-9**: Digest is SHA-256 hex first 16 chars over raw file bytes.
  Rationale: byte-level reproducibility audit (FR-PROF-007); contents never
  leak.
- **ADR-PROF-10**: `profile-edit` re-validates only; never re-writes after
  `$EDITOR` exit. Rationale: research Pitfall 4 — re-stringifying would
  silently normalize formatting.
- **ADR-PROF-11**: Resolution of yaml-research clarifying questions — Q1
  (no comment preservation on `--from-current`), Q2 (re-validate only),
  Q3 (surface all Zod issues at once), Q4 (per-key warnings, capped at 10
  with "(N more suppressed)" footer).

New ADRs introduced during this design phase:

- **ADR-PROF-12**: `ResolvedProfile` is built ONCE per cli-agent invocation,
  during `loadAgentConfig`, and cached on `AgentConfig` as
  `activeProfileData` (typed sub-trees) plus `activeProfile` (metadata).
  No re-loading mid-run; the TUI (which can rebuild the agent graph via
  `/new` / `/model` / `/provider` / `/tools` / `/allow-mutations`) reuses
  the same `ResolvedProfile` from the original `cfg`. Rationale:
  reproducibility (digest stays stable for the run), simplicity (no
  invalidation logic), and v1 scope (no mid-session profile switching per
  OQ-4 deferred).
- **ADR-PROF-13**: Profile activation short-circuit. When neither
  `flags.profile` nor `layered['CLI_AGENT_PROFILE']` is set, `loadProfile`
  is never called — no filesystem access, no codec instantiation, no
  digest computation. This is the load-bearing optimization for
  NFR-PROF-001 (≤ 50 ms cold-start budget when feature is OFF) and the
  AC-21 byte-identical-no-profile-path invariant. Rationale: implemented
  as a single `if (profileName)` guard at the top of the activation block
  in `loadAgentConfig`.
- **ADR-PROF-14**: Five new `LogEvent` kinds (vs. one in the original spec
  FR-PROF-007). The spec mandates `profile_active`; this design adds
  `profile_loaded`, `profile_validation_error`, `tool_scoping_applied`,
  `tool_args_merged` for parity with the existing 8-kind §6 schema and to
  support `profile-dry-run`'s "trace mode" attribution (§12.J). Rationale:
  consistent observability surface; the new kinds are emitted at well-defined
  seams already required by the implementation. This is an additive
  extension; the FR-PROF-007 contract on `profile_active` is unchanged.

## §13. TUI exit and JSON-snapshot resume

Plan: `docs/design/plan-005-tui-exit-and-resume.md`. Functional
requirements: FR-EXR-001 through FR-EXR-009.

### §13.A Goal

Two ergonomic gaps in the TUI that surfaced during user testing:

1. Ctrl+C never exited the TUI — only `/quit` or Ctrl+D-on-empty did.
   That is surprising versus every other modern REPL.
2. Conversation memory was lost across restarts. The transcript was
   persisted to JSONL but the LangGraph `MemorySaver` is in-process,
   so quitting and restarting started the LLM from a blank slate.

### §13.B Architecture

- **Double Ctrl+C exit**: a debounced state machine in
  `src/tui/index.ts`'s main loop. First press emits the existing hint
  (now updated to mention the second-press window). A second press
  within 1500 ms triggers the same graceful shutdown that `/quit` and
  Ctrl+D-on-empty already use.

- **JSON-snapshot resume**: instead of pulling in `SqliteSaver` (and
  `better-sqlite3`), we persist the active thread's MemorySaver state
  to a single JSON file per thread. `MemorySaver.storage` and
  `MemorySaver.writes` are public-typed fields whose `Uint8Array`
  values are already serialised by langgraph's `JsonPlusSerializer`,
  so we only need to round-trip the bytes (base64). The new module
  `src/agent/checkpoint-store.ts` owns `saveCheckpoint(threadId, saver)`
  and `loadCheckpoint(threadId, saver)`. Snapshots live alongside the
  existing transcript files at
  `~/.tool-agents/cli-agent/history/checkpoint-<threadId>.json` (mode
  0600, atomic tmp + rename).

- **Persistence cadence**: end-of-turn (in `TuiController.runTurn`'s
  `finally`). A failed write is logged as a dim warning; the prior
  snapshot remains valid.

- **Resume entry points**: the `--resume`/`-r` CLI flag for cold start,
  and the `/resume [<threadId>]` slash for mid-session swap. Both
  follow the same hydration order: resolve threadId, build a fresh
  graph, hydrate the new saver, re-render the JSONL transcript, swap
  `controller.agentGraph`.

### §13.C Architectural decisions

- **ADR-EXR-1**: JSON snapshot, not SQLite. A single-user CLI agent
  doesn't need indexed pruning, multi-thread concurrency, or branching
  history; one file per thread is sufficient. Avoiding `better-sqlite3`
  keeps the install graph free of native bindings.
- **ADR-EXR-2**: Reach into `MemorySaver.storage` / `.writes` rather
  than wrapping the saver in our own `BaseCheckpointSaver` subclass.
  Both fields are part of the public type definition (verified in
  `node_modules/@langchain/langgraph-checkpoint/dist/memory.d.ts`), so
  this is a contract LangGraph commits to. The snapshot loader fails
  loudly if the shape ever changes.
- **ADR-EXR-3**: Per-turn write, not end-of-session-only. Cheap (low
  tens of ms IO), crash-safe, and matches what a SQLite-backed
  checkpointer would do anyway.
- **ADR-EXR-4**: Hydration before `TuiController` construction. The LLM
  sees the prior conversation only because the checkpointer it's
  attached to already carries the prior state — the rendered transcript
  is purely cosmetic. Constructing the controller first and hydrating
  afterwards would create a window during which the controller's first
  turn could fire against an empty saver.
- **ADR-EXR-5**: 1500 ms double-Ctrl+C window. Long enough to feel
  intentional, short enough that the hint can't go stale and let an
  accidental Ctrl+C minutes later exit the session.
- **ADR-EXR-6**: No silent fallbacks on resume errors. If the user
  asks to resume something that doesn't exist (no `cursor.json`, no
  `checkpoint-<id>.json`, schema mismatch), exit code 2 — same policy
  as missing config. Mid-session `/resume` reports the error inline
  rather than killing the session, since the user has live state worth
  preserving.
- **ADR-EXR-7**: No auto-pruning. Old snapshots are user-deletable
  files; auto-cleanup risks discarding state the user may still want.
  When/if a long-tail accumulation problem emerges, a dedicated
  `cli-agent prune-history --older-than <duration>` subcommand can be
  added.

## §14. Composite Intelligent Tools (plan-006)

**Plan reference**: `docs/design/plan-006-composite-tools.md`.
**Spec reference**: `docs/design/refined-request-composite-tools.md`
(FR-CMP-001 … FR-CMP-023 + NFR-CMP-001 … NFR-CMP-007 in
`docs/design/project-functions.md`; 27 acceptance criteria; 23 edge
cases; the canonical `--treat-as-tool` flag interaction matrix).
**Research references**: `docs/research/llm-prompt-caching-providers.md`
(per-provider cache wire format; `withSynthesisCache` helper sketch),
`docs/research/posix-wrapper-shim-design.md` (verbatim shim text;
atomic-write pattern; absolute-path resolution).
**Investigation reference**: `docs/reference/investigation-composite-tools.md`
(7 design recommendations; resolves O-1, O-2, O-4 deferred questions).
**Codebase scan reference**: `docs/reference/codebase-scan-composite-tools.md`
(11 integration points IP-1 … IP-11).
**Coexists with**: §11 (overlays — NOT in v1 cache key per ADR-CMP-7),
§12 (profiles — passthrough only via `cliParams`; `tools.allow/deny/order`
is NOT consulted during synthesis per FR-CMP-019), the plan-005
capability-recipes / `manRef` contract (composites carry `manRef: null`
always per A-10), and §13 TUI exit/resume (orthogonal — `--treat-as-tool`
is incompatible with `--resume`).

A *composite intelligent tool* packages a curated cli-agent invocation
(`cli-agent --tool A --tool B …`) as a *new* `--tool <composite-id>`
attachable to an outer cli-agent. Because a composite has no real binary
`--help` to introspect, its capability document is **synthesised** by a
two-stage LLM pipeline (per-member distillation → composite composition)
keyed by sorted member names + per-member doc digests + cli-agent version
+ composite schema version + composite name + synthesis model. The
synthesised schema-3 document is then distributed in three opt-in
forms: (a) a doc-only artifact, (b) an executable POSIX shim, (c) a
manifest registered as a "virtual tool" in cli-agent's runtime
registry. Every existing flag, behaviour, exit code, and capability-doc
consumer remains byte-identical when `--treat-as-tool` and its siblings
are absent (NFR-CMP-001).

### §14.A Architecture diagram (text)

```
                     ┌──────────────────────────────────────────────────────┐
                     │ User invokes one of:                                  │
                     │   cli-agent --tool A --tool B --treat-as-tool --help  │
                     │   cli-agent composite-synthesize --tool A --tool B    │
                     │   cli-agent --treat-as-tool ... [--regenerate-... ]   │
                     │                              [--emit-wrapper ...]     │
                     │                              [--register-virtual ...] │
                     └────────────────────────────┬─────────────────────────┘
                                                  │
                                                  ▼
                     ┌─────────────────────────────────────────────────────┐
                     │ src/cli.ts                                           │
                     │   program.helpOption(false)        ← P4 migration   │
                     │   .option('--help', …, false)      ← manual flag    │
                     │   .option('--treat-as-tool', …)                     │
                     │   + 9 sibling flags (§14.E / §14.H)                 │
                     │   .action(): branch on opts['help'] + treatAsTool   │
                     │     no  → existing runAgentCommand (byte-identical) │
                     │     yes → runComposite (NEW)                        │
                     └────────────────────────────┬─────────────────────────┘
                                                  │
              ┌───────────────────────────────────┼───────────────────────────────────┐
              ▼                                   ▼                                    ▼
   ┌────────────────────────┐    ┌──────────────────────────┐    ┌──────────────────────────────┐
   │ runAgentCommand        │    │ src/commands/composite/   │    │ composite-synthesize | -list │
   │   (existing path —     │    │   synthesize.ts           │    │ composite-show | -delete     │
   │    no composite logic) │    │   (--treat-as-tool path)  │    │ (subcommand entry points)    │
   └────────────────────────┘    └──────────────┬───────────┘    └──────────────┬───────────────┘
                                                │                                │
                                                └────────────────┬───────────────┘
                                                                 │
                                                                 ▼
                     ┌────────────────────────────────────────────────────────────────────┐
                     │ src/agent/composite/synthesizer.ts        synthesizeComposite()    │
                     │                                                                     │
                     │  Inputs: (cfg, llm=createLLM(cfg), members[], compositeName,        │
                     │           dryRun, budgetTokens, logger)                             │
                     │                                                                     │
                     │  ┌────────────────────────────────────────────────────────────┐    │
                     │  │ Stage-1 (per-member, embarrassingly parallel)               │    │
                     │  │   for each member m:                                        │    │
                     │  │     digest = sha256(memberDocCanonical                      │    │
                     │  │                     ‖ STAGE1_TEMPLATE_VERSION               │    │
                     │  │                     ‖ cfg.model)[:16]                       │    │
                     │  │     path: <distillDir>/<m>@<digest>.json                    │    │
                     │  │     IF cache hit  → load JSON                               │    │
                     │  │     ELSE          → llm.invoke(stage1Prompt(m))             │    │
                     │  │                      ; write JSON (mode 0600)               │    │
                     │  └────────────────────────────────────────────────────────────┘    │
                     │                       ▼                                              │
                     │  ┌────────────────────────────────────────────────────────────┐    │
                     │  │ Stage-2 (single LLM call)                                   │    │
                     │  │   messages = [SystemMessage(STATIC_SYNTH_PROMPT),           │    │
                     │  │               HumanMessage([distillBlock,                   │    │
                     │  │                             COMPOSE_INSTRUCTION])]          │    │
                     │  │   messages = withSynthesisCache(messages, {                 │    │
                     │  │              providerFamily: resolveProviderFamily(cfg),    │    │
                     │  │              prefixEndIndex: 1, anthropicTtl: '1h' })       │    │
                     │  │   response  = await llm.invoke(messages)                    │    │
                     │  │   doc       = composeCompositeDoc({frontmatter, body,       │    │
                     │  │                                    recipes, notes:''})      │    │
                     │  │   extractCacheUsage(response.response_metadata)             │    │
                     │  │     → JSONL composite_synthesis_stage event                 │    │
                     │  └────────────────────────────────────────────────────────────┘    │
                     └────────────────────────────┬───────────────────────────────────────┘
                                                  │
                                                  ▼
                     ┌──────────────────────────────────────────────────────────────────┐
                     │ src/agent/composite/cache.ts                                      │
                     │   COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3 (NEW constant)          │
                     │   key = sha256(sortedMembers ‖ memberDigests ‖ cliVer             │
                     │                ‖ schemaVer ‖ compositeName ‖ synthModel)          │
                     │   USER-RECIPES + USER-NOTES preserved across rewrite              │
                     │   atomic temp+rename; mode 0600                                   │
                     └────────────────────────────┬─────────────────────────────────────┘
                                                  │
       ┌──────────────────────────────────────────┼──────────────────────────────────────────┐
       ▼                                          ▼                                          ▼
┌─────────────────────────┐   ┌────────────────────────────────────┐   ┌──────────────────────────────────────┐
│ FORM (a) Doc            │   │ FORM (b) Wrapper shim               │   │ FORM (c) Virtual tool                 │
│ default ON (with        │   │ default OFF — opt-in --emit-wrapper │   │ default OFF — opt-in --register-virt. │
│ --treat-as-tool)        │   │                                      │   │                                        │
│ writes:                 │   │ writes:                              │   │ writes:                                │
│  capabilities/          │   │  composites/<id>/<id>  (mode 0755)   │   │  composites/<id>/manifest.json (0600)  │
│   composite/<id>.md     │   │  + optional symlink                  │   │ scanned by loadVirtualTools at startup │
│   (mode 0600)           │   │   ~/.local/bin/<id>                  │   │ dispatched by dispatcher.ts:           │
│  + mirror file copy     │   │ #!/bin/sh; exec abs-path-cli         │   │   child-process (default; ADR-CMP-5)   │
│   capabilities/<id>.md  │   │   --tool m1 --tool m2 "$@"           │   │   in-process (experimental)            │
│   so existing           │   │ (research §5 verbatim template)      │   │ recursion guard at register + dispatch │
│   composeCapabilities-  │   │                                      │   │ child env CLI_AGENT_VIRTUAL_DISPATCH_  │
│   SystemPrompt picks    │   │                                      │   │   RECURSION_GUARD=1 hard-disables     │
│   it up (ADR-CMP-12)    │   │                                      │   │   nested loadVirtualTools             │
└─────────────────────────┘   └────────────────────────────────────┘   └──────────────────────────────────────┘
       │                                          │                                          │
       └──────────────────────────────────────────┼──────────────────────────────────────────┘
                                                  ▼
                     ┌──────────────────────────────────────────────────────────────────┐
                     │ Outer cli-agent runs `cli-agent --tool <id>`:                     │
                     │  resolution order at registry seam (registry.ts:84):              │
                     │   1. built-in tool name                                           │
                     │   2. virtual tool manifest match → meta-tool dispatch             │
                     │   3. PATH binary (the shim, if --emit-wrapper-on-path used)       │
                     │  composeCapabilitiesSystemPrompt reads <id>.md transparently      │
                     │  → outer system prompt embeds composite USER-RECIPES verbatim     │
                     └──────────────────────────────────────────────────────────────────┘
```

The `withSynthesisCache(messages, options)` helper from the prompt-caching
research is the single provider-agnostic adapter that annotates Stage-2
messages with `cache_control` markers on Anthropic and LiteLLM-Anthropic
and returns the messages unmodified on every other provider (where prefix
stability handles caching automatically or where caching is unavailable).
The synthesis subsystem co-locates with the existing capability cache
(it shares `agentCapabilitiesDir()` for the schema-3 mirror copy),
the profile system (it consumes `cfg.activeProfileData?.cliParams`
through the shared `createLLM(cfg)` factory but ignores `tools.*`),
and the §11 overlay system (overlays are NOT part of the v1 cache key —
their current effective digest is captured in JSONL telemetry only,
per ADR-CMP-7 / OQ-1).

### §14.B Module layout

```
src/agent/composite/                                              [NEW package]
├── types.ts                       interfaces consumed by all units (§14.D)
├── prompts.ts                     STAGE1_TEMPLATE / STAGE2_TEMPLATE + version constants
├── cache.ts                       schema-3 reader/writer, member-doc digest,
│                                  cache-key composition, USER-* preservation,
│                                  Stage-1 distill cache helpers
├── cache.spec.ts
├── composeCompositeDoc.ts         schema-3 doc composer (frontmatter + AUTO-GEN
│                                  + USER-RECIPES + USER-NOTES)
├── composeCompositeDoc.spec.ts
├── stage1.ts                      per-member distillation + on-disk cache lookup
├── stage1.spec.ts
├── stage2.ts                      compose call + buildStage2Messages helper
├── stage2.spec.ts
├── synthesizer.ts                 synthesizeComposite() — orchestrates 1+2
├── synthesizer.spec.ts
├── llm-cache.ts                   withSynthesisCache + extractCacheUsage
│                                  + resolveProviderFamily (the 9 ProviderFamily
│                                  values). Verbatim from research §"Helper
│                                  Sketch". Adapter is the single integration
│                                  surface for all 8 supported providers.
├── llm-cache.spec.ts
├── shim-writer.ts                 generateCompositeWrapperShim (POSIX shim
│                                  emitter, atomic temp+rename, 0o755 mode,
│                                  nvm/volta/asdf detection warning)
├── shim-writer.spec.ts
├── manifest.ts                    readManifest / writeManifest; collision
│                                  detection (FR-CMP-017)
├── manifest.spec.ts
├── virtual-registry.ts            loadVirtualTools(cfg, logger) → DynamicStructuredTool[]
├── virtual-registry.spec.ts
├── dispatcher.ts                  dispatchComposite(input) — child-process
│                                  default; in-process opt-in (experimental);
│                                  recursion guard at dispatch time
└── dispatcher.spec.ts

src/commands/composite/                                          [NEW package]
├── synthesize.ts                  flag-driven AND subcommand entry
├── regenerate.ts                  alias of synthesize --regenerate
├── list.ts                        composite-list (manifest scan)
├── show.ts                        composite-show <id> (print cached doc)
├── delete.ts                      composite-delete <id> [--yes]
├── derive-name.ts                 validateCompositeName, deriveCompositeName
├── shared.ts                      resolveCompositePath, formatTable
└── *.spec.ts                      one per handler

src/cli-composite-flags.ts                                       [NEW]
                                   maps Commander opts → CompositeCliFlags
                                   (parallel to cli-agent-tools-flags.ts);
                                   flag-conflict enforcement (§14.H)

EXTENDED touch points (small, line-bounded):
  src/cli.ts                      register 10 new flags + 4 new subcommands;
                                   helpOption(false) migration (NFR-CMP-001
                                   pinned baseline)
  src/config/agent-config.ts      AgentCliFlags extension (10 fields);
                                   AgentConfig extension (compositeCapabilitiesDir,
                                   compositeDistillDir, compositesDir);
                                   bootstrapAgentDir +3 dirs (mode 0700);
                                   OTHER_ENV_KEYS += CLI_AGENT_COMPOSITE_BUDGET,
                                   CLI_AGENT_VIRTUAL_DISPATCH
  src/agent/capabilities/cache.ts                NO change
                                   (composite reader is a separate function in
                                    src/agent/composite/cache.ts; ADR-CMP-6)
  src/agent/capabilities/compose-system-prompt.ts                small extension
                                   add fallback to <capabilitiesDir>/composite/<id>.md
                                   when <capabilitiesDir>/<id>.md is absent
                                   (defensive; mirror copy from ADR-CMP-12 covers
                                   the 99% case)
  src/agent/tools/registry.ts     line ~84: call loadVirtualTools(cfg, logger)
                                   between buildAgentToolsGroup and
                                   applyProfileToolScoping; virtual tools subject
                                   to profile scoping like native tools
  src/agent/logging.ts            extend LogEvent union with 9 new event kinds
                                   (§14.M)
```

`package.json` gains NO new runtime dependency. The `withSynthesisCache`
helper uses `@langchain/core/messages` already in the dependency graph.
The shim writer uses `node:fs/promises`, `node:os`, and `node:path` —
all stdlib.

### §14.C Schema-3 capability doc format (canonical)

The synthesised composite document extends schema-2 with composite-specific
frontmatter while preserving every body marker that the existing
`composeCapabilitiesSystemPrompt` reader expects (so an outer cli-agent
finds the doc transparently — no consumer-side changes).

```markdown
---
schemaVersion: 3              # required (number; literal 3 in v1)
composite: true               # required (boolean; literal true)
compositeName: <id>           # required (string; ^[a-z][a-z0-9_-]{0,62}$)
members:                      # required (sorted array of canonical member names)
  - file-cli
  - outlook-cli
memberDigests:                # required (object; <name> → sha256 first 16 hex)
  file-cli: a1b2c3d4e5f60718
  outlook-cli: 0f1e2d3c4b5a6978
synthesizedAt: <ISO 8601>     # required (string; UTC)
syntheticDigest: <16-hex>     # required (string; sha256[:16] of canonicalised inputs)
cliAgentVersion: <semver>     # required (string; the running cli-agent version)
synthesisModel: <vendor>:<id> # required (string; e.g. "anthropic:claude-sonnet-4-6")
activeProfile: <name | null>  # required (string or null; traceability only,
                              #   per FR-CMP-019 — NOT used as input)
manRef: null                  # required (literal null; A-10 — composites have no man page)
manPagePath: null             # required (literal null; companion to manRef)
---

# <compositeName> — capability document

<!-- AUTO-GENERATED:START hash=<hex64> -->
<synthesised body: synopsis, intents, parameter glossary, cross-tool examples>
<!-- AUTO-GENERATED:END -->

<!-- USER-RECIPES:START -->
<pre-filled by Stage-2; user-editable; preserved across --regenerate-capabilities>
<!-- USER-RECIPES:END -->

<!-- USER-NOTES:START -->
<empty stub on first synthesis; user-editable; preserved across --regenerate-capabilities>
<!-- USER-NOTES:END -->
```

**Frontmatter ordering** is fixed (the writer emits keys in the order
listed above for byte-stable digests). All frontmatter keys are required
in v1; `activeProfile: null` represents "no profile active" rather than
the field being absent.

**Member-doc digest algorithm** (used both inside `memberDigests` and
inside the cache-key — §14.L): given the member's capability-doc text,

1. Strip everything between `<!-- USER-RECIPES:START -->` and
   `<!-- USER-RECIPES:END -->` (inclusive of the markers).
2. Strip everything between `<!-- USER-NOTES:START -->` and
   `<!-- USER-NOTES:END -->` (inclusive of the markers).
3. Strip trailing whitespace from each remaining line; normalise
   line endings to `\n`.
4. `sha256(canonicalisedBytes).hex().slice(0, 16)`.

The `canonicaliseMemberDoc(text)` helper is the single source of truth;
both writer (when populating `memberDigests`) and reader (when comparing
for cache invalidation) call it.

**`syntheticDigest`** = `sha256(JSON.stringify(canonicalInputs)).hex().slice(0, 16)`,
where `canonicalInputs = { schemaVersion, compositeName, members, memberDigests,
cliAgentVersion, synthesisModel }`. Stage-2 prompt content does NOT enter
the digest — the digest is keyed to inputs only, not to LLM nondeterminism.

### §14.D Data models

The following TypeScript interfaces are the contract the seven Phase-6
parallel implementation units consume (§14.P). They live in
`src/agent/composite/types.ts` (data shapes) and across the unit-owned
modules (function signatures).

```typescript
// src/agent/composite/types.ts

import type { BaseMessage } from '@langchain/core/messages'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { AgentConfig } from '../../config/agent-config.js'
import type { Logger } from '../logging.js'

// --- Frontmatter / cache models ---

export interface CompositeSchemaV3Frontmatter {
  readonly schemaVersion: 3
  readonly composite: true
  readonly compositeName: string
  readonly members: readonly string[]
  readonly memberDigests: Readonly<Record<string, string>>
  readonly synthesizedAt: string                  // ISO 8601 UTC
  readonly syntheticDigest: string                // sha256[:16]
  readonly cliAgentVersion: string                // semver
  readonly synthesisModel: string                 // "<vendor>:<modelId>"
  readonly activeProfile: string | null
  readonly manRef: null
  readonly manPagePath: null
}

export interface CompositeManifest {              // composites/<id>/manifest.json
  readonly schemaVersion: 1
  readonly compositeName: string
  readonly members: readonly string[]
  readonly memberDigests: Readonly<Record<string, string>>
  readonly createdAt: string
  readonly cliAgentVersion: string
  readonly capabilityDocPath: string              // absolute path
}

export interface CompositeMemberRef {             // logical reference, not stored
  readonly name: string                           // canonical member name
  readonly capabilityDocPath: string              // absolute resolved path
  readonly memberDocDigest: string                // sha256[:16] (canonicalised)
}

// --- The Composite as in-memory aggregate ---

export interface Composite {
  readonly frontmatter: CompositeSchemaV3Frontmatter
  readonly autoGeneratedBody: string              // between AUTO-GEN markers
  readonly userRecipes: string                    // between USER-RECIPES markers
  readonly userNotes: string                      // between USER-NOTES markers
}

// --- Synthesis pipeline I/O ---

export interface Stage1Distillation {
  readonly memberName: string
  readonly content: string                        // structured intent surface (~2 KB)
  readonly modelId: string                        // synthesis model that produced this
  readonly templateVersion: string                // STAGE1_TEMPLATE_VERSION
  readonly createdAt: string                      // ISO 8601 UTC
}

export interface SynthesisInputs {
  readonly cfg: AgentConfig
  readonly llm: BaseChatModel                     // already createLLM(cfg)'d
  readonly members: readonly string[]             // sorted canonical names (caller pre-sorts)
  readonly compositeName: string                  // validated or derived
  readonly dryRun: boolean                        // true → emit prompts, no LLM, no fs writes
  readonly budgetTokens: number                   // combined Stage-1 + Stage-2 cap
  readonly logger: Logger
}

export interface SynthesisResult {
  readonly doc: string                            // full schema-3 markdown body
  readonly frontmatter: CompositeSchemaV3Frontmatter
  readonly totalTokens: number                    // sum of Stage-1 + Stage-2 input+output
  readonly cacheHit: boolean                      // top-level cache hit (not Stage-1 distill)
}

// --- Wrapper shim (form b) ---

export interface CompositeWrapperShimSpec {
  readonly compositeName: string
  readonly members: readonly string[]
  readonly cliAgentBinPath: string                // absolute, resolved at synthesis time
  readonly capabilityDocPath: string              // absolute path to mirror copy
  readonly shimDir: string                        // composites/<id>/
  readonly synthesizedAt: string
}

// --- Virtual tool (form c) ---

export type DispatchMode = 'child-process' | 'in-process'

export interface VirtualToolHandle {
  readonly name: string                           // composite id
  readonly manifest: CompositeManifest
  readonly description: string                    // loaded from manifest.capabilityDocPath
  readonly dispatch: (args: readonly string[]) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
  }>
}

// --- Provider-agnostic prompt cache helper (U-CACHE) ---

export type ProviderFamily =
  | 'anthropic'         | 'openai'           | 'azure-openai'
  | 'azure-inference'   | 'google-gemini'    | 'litellm-anthropic'
  | 'litellm-openai'    | 'ollama'           | 'local-compat'

export interface SynthesisCacheOptions {
  readonly providerFamily: ProviderFamily
  readonly prefixEndIndex: number                 // messages 0..N marked for cache
  readonly anthropicTtl?: '5m' | '1h'             // ignored on non-Anthropic
}
```

Function-level contracts (each unit's owned exports):

```typescript
// U-FLAGS — src/cli-composite-flags.ts
export interface CompositeCliFlags {
  readonly treatAsTool: boolean
  readonly compositeName: string | null
  readonly emitDoc: boolean                       // true by default with --treat-as-tool
  readonly emitWrapper: boolean
  readonly emitWrapperOnPath: boolean
  readonly registerVirtual: boolean
  readonly regenerateCapabilities: boolean
  readonly dryRunSynthesis: boolean
  readonly synthesisBudgetTokens: number          // default 32768
  readonly forceOverwrite: boolean
}
export function parseCompositeFlags(opts: Record<string, unknown>): CompositeCliFlags
export function enforceCompositeFlagMatrix(flags: CompositeCliFlags, opts: { help: boolean; tools: readonly string[] }): void  // throws UsageError per §14.H

// U-SYNTH — src/agent/composite/synthesizer.ts
export async function synthesizeComposite(input: SynthesisInputs): Promise<SynthesisResult>

// U-CACHE — src/agent/composite/llm-cache.ts
export function withSynthesisCache(messages: BaseMessage[], options: SynthesisCacheOptions): BaseMessage[]
export function extractCacheUsage(responseMetadata: Record<string, unknown>): {
  cachedTokens: number
  cacheCreationTokens: number
  provider: 'anthropic' | 'openai-compat' | 'unknown'
}
export function resolveProviderFamily(cfg: AgentConfig): ProviderFamily

// U-DOC — src/agent/composite/cache.ts + composeCompositeDoc.ts
export const COMPOSITE_CAPABILITY_SCHEMA_VERSION: 3
export const SUPPORTED_COMPOSITE_SCHEMA_VERSIONS: ReadonlySet<number>  // = {3} in v1
export function computeCompositeCacheKey(input: {
  members: readonly string[]
  memberDigests: Readonly<Record<string, string>>
  cliAgentVersion: string
  schemaVersion: number
  compositeName: string
  synthesisModel: string
}): string
export function computeMemberDocDigest(memberDocPath: string): Promise<string>
export function canonicaliseMemberDoc(text: string): string
export function readCompositeCacheEntry(path: string): Promise<{
  frontmatter: CompositeSchemaV3Frontmatter
  body: string
  userRecipes: string
  userNotes: string
} | null>
export function writeCompositeCacheEntry(path: string, doc: string): Promise<void>
export function mirrorCompositeDocToCapabilities(compositeName: string, fromPath: string, capabilitiesDir: string): Promise<void>
export function composeCompositeDoc(input: {
  frontmatter: CompositeSchemaV3Frontmatter
  body: string                                    // AUTO-GEN body from Stage-2
  recipes: string                                 // pre-filled by Stage-2 OR preserved
  notes: string                                   // empty on first synthesis OR preserved
}): string

// U-WRAPPER — src/agent/composite/shim-writer.ts
export async function generateCompositeWrapperShim(spec: CompositeWrapperShimSpec): Promise<{ shimPath: string; mode: number }>
export async function generatePathSymlink(shimPath: string, symlinkDir: string, compositeName: string): Promise<{ symlinkPath: string }>

// U-VIRTUAL — src/agent/composite/{manifest,virtual-registry,dispatcher}.ts
export async function readManifest(path: string): Promise<CompositeManifest | null>
export async function writeManifest(path: string, manifest: CompositeManifest, opts: { force: boolean }): Promise<void>
export async function loadVirtualTools(cfg: AgentConfig, logger: Logger): Promise<readonly VirtualToolHandle[]>
export async function dispatchComposite(input: {
  manifest: CompositeManifest
  invocationArgs: readonly string[]
  mode: DispatchMode
  cfg: AgentConfig
  logger: Logger
}): Promise<{ exitCode: number; stdout: string; stderr: string }>

// U-CMD — src/commands/composite/*
export async function runCompositeSynthesize(opts: CompositeCliFlags & { tools: readonly string[]; help: boolean }): Promise<void>
export async function runCompositeList(opts: { json?: boolean }): Promise<void>
export async function runCompositeShow(name: string, opts: { json?: boolean }): Promise<void>
export async function runCompositeDelete(name: string, opts: { yes?: boolean }): Promise<void>
export function validateCompositeName(name: string): string                  // returns name on pass; throws UsageError on regex fail
export function deriveCompositeName(members: readonly string[], cliAgentVersion: string, schemaVersion: number): string
```

These interfaces are the load-bearing contract. No unit may broaden a
return shape, narrow an input, or add required parameters without
explicit cross-unit coordination.

### §14.E Subcommand surface (flat hyphenated — ADR-CMP-4)

Per the codebase convention (five existing flat-hyphenated subcommands;
zero nested groups) and plan-005's ADR-PROF-5 precedent, composite
subcommands are flat-hyphenated. The refined-spec wording
`cli-agent composite synthesize` (which reads as a nested group) is
rendered with hyphens — mechanically reversible if the user prefers
nested.

| Subcommand | Effect | Default exit codes |
|---|---|---|
| `composite-synthesize --tool <m1> --tool <m2> [--composite-name <id>] [--regenerate] [--emit-wrapper] [--emit-wrapper-on-path] [--register-virtual] [--dry-run] [--force-overwrite] [--synthesis-budget-tokens <n>] [--no-emit-doc]` | Run the synthesis pipeline; produce all artifacts opted in via flags. Same pipeline as `--treat-as-tool --help`; this entry point is for non-interactive / CI use. | 0 / 2 (UsageError) / 3 (ConfigurationError) / 6 (cache stale) |
| `composite-list [--json]` | Tabular listing of registered virtual composites (manifest scan): name, members, cli-agent version, createdAt. Empty registry → hint message. | 0 / 6 (IO error) |
| `composite-show <id> [--json]` | Print the cached composite doc (raw markdown by default). `--json` opt-in returns `{ frontmatter, body, recipes, notes }`. | 0 / 2 (missing) |
| `composite-delete <id> [--yes]` | Remove manifest + wrapper folder + cached canonical doc + mirror copy + symlink (if present). Confirmation prompt unless `--yes`. Idempotent on already-missing artifacts. | 0 / 2 (missing without `--yes`) |

Output formats follow the §12.E precedent: human-readable by default
(table style for `composite-list`, raw markdown for `composite-show`);
`--json` is opt-in for `composite-list` and `composite-show`.

The flag-driven path (`--treat-as-tool --help` on the default command)
remains the **primary documented user-facing path**; the four
subcommands above are equivalents for scripting and CI (FR-CMP-022).

### §14.F Filesystem layout

The composite subsystem owns three new directories and four file shapes.
All directories are created by `bootstrapAgentDir` at mode `0o700`
(extending the existing five-directory scaffold). All files are written
atomically (temp + rename) at the modes listed below.

```
~/.tool-agents/cli-agent/
  capabilities/                                 (existing, mode 0700)
    <member-tool>.md                            (existing, mode 0600)  schema-2 member docs
    <composite-id>.md                           (NEW, mode 0600)        ← MIRROR COPY of composite/<id>.md
                                                                         (ADR-CMP-12; consumed by composeCapabilitiesSystemPrompt)
    composite/                                  (NEW, mode 0700)
      <composite-id>.md                         (NEW, mode 0600)        ← canonical schema-3 composite doc
      _distill/                                 (NEW, mode 0700)
        <member>@<digest>.json                  (NEW, mode 0600)        ← Stage-1 per-member cache
                                                                         filename: <member>@<sha256[:16]>.json
                                                                         contents: { memberName, content,
                                                                                    modelId, templateVersion,
                                                                                    createdAt }
  composites/                                   (NEW, mode 0700)
    <composite-id>/                             (NEW, mode 0700)
      <composite-id>                            (NEW, mode 0755)        ← POSIX shim (form b; opt-in)
      manifest.json                             (NEW, mode 0600)        ← virtual-tool manifest (form c; opt-in)
      .lock                                     (advisory, transient)   ← O_EXCL race guard for parallel
                                                                         registrations (R-8 mitigation)
  ~/.local/bin/<composite-id>                   (NEW, symlink; opt-in)  ← --emit-wrapper-on-path
                                                                         points at composites/<id>/<id>
```

**Composite-name validation rules** (FR-CMP-011):

- Regex: `^[a-z][a-z0-9_-]{0,62}$` (max 63 chars; lowercase alphanumeric
  + `_` + `-`; must start with a letter).
- Violations: `UsageError` exit 2 with message
  `composite-name '<id>' violates ^[a-z][a-z0-9_-]{0,62}$`.
- Filesystem-character invariants: the regex is strictly tighter than
  the POSIX portable-filename character set, so no further filename
  validation is needed.

**Auto-derivation when `--composite-name` is omitted** (FR-CMP-011):

- `<sorted-members-joined-by-+>@<hash8>` where `<hash8>` is the first 8
  hex chars of `sha256(JSON.stringify({ members, memberDigests,
  cliAgentVersion, schemaVersion }))`.
- Example: members `[file-cli, outlook-cli]` → `file-cli+outlook-cli@a1b2c3d4`.
- The derived name MUST also pass the regex; if `+` would violate, the
  derivation falls back to all-`-` (NEVER silently — but in v1 the spec
  members are guaranteed to satisfy the regex by `--tool` validation).

**Atomic write pattern** (used by every composite-owned writer):

1. `await fs.writeFile(tmpPath, content, { mode: 0o600 })` (or 0o755 for shim).
2. `await fs.rename(tmpPath, finalPath)` — atomic on the same filesystem.
3. If the rename throws `EXDEV` (cross-device), surface `ConfigurationError`
   exit 3 with a message pointing the user to keep `~/.tool-agents/`
   on the home filesystem.

### §14.G Synthesis pipeline integration

The synthesis pipeline is owned by U-SYNTH and consumes the
provider-cache helper (U-CACHE). It calls the existing `createLLM(cfg)`
factory (`src/agent/providers/registry.ts:24–30`) — there is no new LLM
wiring, no alternate provider, no alternate auth.

**Stage-1 prompt template** (high level; verbatim text in
`src/agent/composite/prompts.ts`):

```
SYSTEM
  You are a capability-distillation pre-processor for cli-agent's composite-tool
  synthesis pipeline. Given a member tool's full capability document, emit a
  STRUCTURED INTENT SURFACE in YAML with: top-level intents (verbs the user
  might want), a parameter glossary (canonical name → 1-line purpose),
  illustrative single-tool examples (≤ 3), and any noted constraints/quirks.
  Refrain from emitting credential placeholders. Output target: ~2 KB.

USER
  ## Member tool: <memberName>
  <canonicalised member-doc bytes>
```

**Stage-2 prompt template** (high level):

```
SYSTEM (the static prefix; sized ≥1024 tokens to satisfy provider cache thresholds)
  You are the composite synthesizer for cli-agent. You compose a SINGLE
  capability document for a composite tool from per-member intent surfaces.
  The output document must contain: synopsis, top-level cross-tool intents,
  a parameter glossary that disambiguates by member, illustrative cross-tool
  recipes for the USER-RECIPES block (3–7 recipes), and any cross-tool
  constraints. Use AUTO-GENERATED:START/END markers around the synthesised
  body and USER-RECIPES:START/END / USER-NOTES:START/END markers around
  the user-editable blocks (USER-NOTES empty on first synthesis). Refrain
  from emitting credential placeholders.

USER (HumanMessage with two content blocks)
  Block 0 (the cacheable members block):
    ## file-cli
    <Stage-1 distillation>
    ---
    ## outlook-cli
    <Stage-1 distillation>

  Block 1 (the variable compose instruction):
    Compose the composite "<compositeName>" capability doc.
    Members (sorted): [file-cli, outlook-cli]. Today: <ISO date>.
    Frontmatter is provided by the host; emit only the body below the
    H1 title `# <compositeName> — capability document`.
```

**`withSynthesisCache` placement**: applied to the Stage-2 message
array AFTER assembly, with `prefixEndIndex: 1` (cache through the
HumanMessage members block). The compose-instruction block (Block 1
inside the HumanMessage) is the dynamic tail and is NOT marked. On
Anthropic, two `cache_control` markers are emitted (one on the system
message's last content block, one on the members block); on
OpenAI/Azure/Gemini, the helper returns messages unmodified and prefix
stability handles caching automatically.

**Profile interaction**: synthesis re-uses the active profile's
provider/model via `cfg.activeProfileData?.cliParams?.{provider,model}`
already resolved by `loadAgentConfig`. The active profile's `tools.allow
/deny/order` is **NOT** consulted for member selection (FR-CMP-019);
only the explicit `--tool` flags constitute the member set. The active
profile's `toolArgs` is **NOT** embedded in the synthesised doc. The
profile's `name` is recorded in `frontmatter.activeProfile` for
traceability only. This is the entire profile passthrough surface —
all other plan-005 profile machinery (scoping, tool-args injection)
is bypassed during synthesis.

**Token-budget enforcement**: `budgetTokens` (default 32 768; CLI flag
`--synthesis-budget-tokens <n>`; env `CLI_AGENT_COMPOSITE_BUDGET`;
config key `composite.synthesisBudgetTokens`) caps the *combined*
input + output tokens across Stage-1 (all members) + Stage-2. The
synthesizer accumulates a running counter across both stages and:

- Aborts Stage-1 mid-loop with `UsageError` exit 2 if the running total
  would exceed the cap on the next member (Stage-1 cache writes already
  performed are kept — they are independently durable).
- Aborts Stage-2 with `UsageError` exit 2 if the response would push
  the running total over the cap (no Stage-2 doc written).

The error message names the consumed token count and the configured cap.
There is no automatic fallback to a smaller pipeline. Per-stage budgets
are NOT exposed in v1 (ADR-CMP-10 / OQ-3).

### §14.H `--treat-as-tool` flag interaction matrix (canonical)

This is the locked, enforceable matrix from the refined spec (§"Flag
Interaction Matrix") with the OQ-7 / ADR-CMP-3 deviation applied to the
`--regenerate-capabilities` row. Enforcement lives in
`enforceCompositeFlagMatrix()` (U-FLAGS); `OK` rows pass through; `ERR-2`
rows throw `UsageError` exit 2 with the documented message.

| Flag set                                                  | Without `--treat-as-tool`                                                                                                              | With `--treat-as-tool` (no `--help`)         | With `--treat-as-tool` AND `--help`                                  |
|-----------------------------------------------------------|----------------------------------------------------------------------------------------------------------------------------------------|----------------------------------------------|----------------------------------------------------------------------|
| (none — bare invocation)                                  | Today's behaviour (byte-identical)                                                                                                     | Treated as a normal run; flag is metadata    | Synthesise composite doc; print to stdout; exit 0                    |
| `--help`                                                  | Today's `--help` (pinned baseline)                                                                                                     | N/A (caught above)                           | Synthesise composite doc; print to stdout; exit 0                    |
| `--regenerate-capabilities`                               | Existing `refresh-capabilities` flow on the default command? **NO — ERR-2 per ADR-CMP-3.** Message: `--regenerate-capabilities requires --treat-as-tool; use --refresh-capabilities for member-tool discovery refresh` | Force re-synthesis on next help; metadata    | Force re-synthesis; print fresh doc                                  |
| `--composite-name <id>`                                   | ERR-2 (`--composite-name requires --treat-as-tool`)                                                                                    | OK; recorded if synthesis happens later      | OK; used as composite id                                             |
| `--emit-doc` / `--no-emit-doc`                            | ERR-2 (`--emit-doc/--no-emit-doc requires --treat-as-tool`)                                                                            | OK; affects future synthesis                 | OK; gates writing the cached file                                    |
| `--emit-wrapper` / `--emit-wrapper-on-path`               | ERR-2 (`--emit-wrapper requires --treat-as-tool`)                                                                                      | OK; deferred to next synthesis               | OK; writes shim after synthesis                                      |
| `--register-virtual`                                      | ERR-2 (`--register-virtual requires --treat-as-tool`)                                                                                  | OK; deferred to next synthesis               | OK; writes manifest after synthesis                                  |
| `--dry-run-synthesis`                                     | ERR-2 (`--dry-run-synthesis requires --treat-as-tool`)                                                                                 | OK; no-op (no synthesis would run)           | Print stage prompts + digests; do NOT call LLM; do NOT write cache   |
| `--force-overwrite`                                       | ERR-2 (`--force-overwrite requires --treat-as-tool`)                                                                                   | OK; recorded for next synthesis              | OK; permits manifest/doc replacement on collision (FR-CMP-017)       |
| `--synthesis-budget-tokens <n>`                           | OK (no-op; ignored without synthesis)                                                                                                  | OK (recorded for next synthesis in session)  | OK; enforced during synthesis                                        |
| `--composite-name <id>` + existing different manifest     | (See above)                                                                                                                            | (See above)                                  | ERR-2 unless `--force-overwrite` (FR-CMP-017)                        |
| `--treat-as-tool` with no `--tool` and `--help`           | N/A                                                                                                                                    | N/A (no synthesis)                           | ERR-2 (`composite synthesis requires at least one --tool argument`)  |
| `--treat-as-tool` + member is a registered virtual composite | (member resolves via PATH/registry lookup as today)                                                                                  | ERR-2 at agent startup (recursion guard)     | ERR-2 (recursion guard, FR-CMP-016)                                  |
| `--register-virtual` + recursion detected                 | (n/a)                                                                                                                                  | ERR-2 at registration time                   | ERR-2 at synthesis time                                              |
| `--treat-as-tool` + `--resume`                            | (n/a)                                                                                                                                  | ERR-2 (`--treat-as-tool is incompatible with --resume`) | ERR-2 (same)                                            |

The `--regenerate-capabilities` row is the single deviation from the
refined spec's wording (which implies aliasing with
`--refresh-capabilities`). Per ADR-CMP-3 / OQ-7, the two flags are
*distinct*: silent aliasing was judged a maintenance landmine that
hides the intent difference (introspection-only refresh vs LLM-driven
synthesis). The deviation is mechanically reversible if the user
prefers the spec's original aliasing semantics.

### §14.I Three distribution forms (a / b / c)

All three forms can coexist for the same `<id>`; the outer cli-agent's
resolution order (§14.K) deterministically picks one path per
invocation.

| Form | Flag (default) | Artifact path (mode) | Lifetime | Outer-agent invocation contract |
|---|---|---|---|---|
| **(a) Doc only** | `--emit-doc` / `--no-emit-doc` (default ON whenever `--treat-as-tool` is in effect) | Canonical: `~/.tool-agents/cli-agent/capabilities/composite/<id>.md` (0600). Mirror: `~/.tool-agents/cli-agent/capabilities/<id>.md` (0600) — file copy, NOT symlink (ADR-CMP-12). | Overwritten on every successful synthesis (USER-RECIPES + USER-NOTES preserved byte-for-byte across rewrite per FR-CMP-010). Removed by `composite-delete <id>`. | The user shares / hand-edits / copies the file. The mirror is consumed automatically by `composeCapabilitiesSystemPrompt` whenever an outer cli-agent declares `--tool <id>` AND a binary exists for `<id>` (the doc-only form requires either the shim OR a third-party binary on PATH to actually invoke `--tool <id>`). |
| **(b) Wrapper shim** | `--emit-wrapper` (default OFF) | `~/.tool-agents/cli-agent/composites/<id>/<id>` (0755 — executable). Optional symlink `~/.local/bin/<id>` if `--emit-wrapper-on-path` (default OFF). | Overwritten on every regeneration. Removed by `composite-delete <id>`. The shim refuses to run with exit 6 if its cached doc is missing (cache-stale). | Outer cli-agent finds `<id>` on PATH (when the shim's directory is on PATH or `--emit-wrapper-on-path` is set). On `--help`, the shim `exec cat`s the canonical composite doc; on any other args, the shim `exec`s the synthesis-time-resolved absolute `cli-agent` binary with the recorded `--tool <m1> --tool <m2> "$@"` list. The absolute path is captured at synthesis time (ADR-CMP-9 / OQ-6) — nvm/volta/asdf paths trigger a stderr warning at synthesis. |
| **(c) Virtual tool** | `--register-virtual` (default OFF) | `~/.tool-agents/cli-agent/composites/<id>/manifest.json` (0600). | Overwritten on regeneration; manifest writes are atomic temp+rename with O_EXCL `.lock` for race protection (R-8). Removed by `composite-delete <id>`. | The cli-agent registry's `loadVirtualTools(cfg, logger)` scans `composites/*/manifest.json` at every startup and injects each as a `DynamicStructuredTool` between `buildAgentToolsGroup` and `applyProfileToolScoping` (`registry.ts:84`). When the outer cli-agent declares `--tool <id>`, the virtual-tool entry is matched (resolution order step 2 — see §14.K). The tool's runtime `invoke` calls `dispatchComposite(...)` which forks a child `cli-agent` (default; ADR-CMP-5) with the recorded member list and a fresh per-call agent state. In-process dispatch is opt-in via `composite.virtualDispatch=in-process` and explicitly experimental in v1. |

**Defaults**: form (a) is the only default-ON distribution because it is
information-only (no PATH or registry side-effects). Forms (b) and (c)
are explicit opt-ins because they have visible side-effects on the
filesystem and the tool registry — the user must consciously elect them
(refined-spec Assumption A-4).

### §14.J Help interception (Commander `helpOption(false)`)

Commander v12 intercepts `--help` *before* the `.action()` callback
fires (`src/cli.ts:384`'s `program.parseAsync(process.argv)`). To
permit the composite branch on `--treat-as-tool --help`, Phase 4
migrates the program from the auto-help mechanism to manual
interception:

```typescript
// src/cli.ts (P4 migration)
program.helpOption(false)                                                 // disable Commander's built-in --help / -h
program.option('--help', 'Show help (composite-aware when --treat-as-tool)', false)
program.option('-h, --help', …)                                           // re-register -h as alias on the manual flag

// In the default command's .action() (lines 94–134):
if (opts['help']) {
  const tools: string[] = opts['tool'] ?? []
  if (opts['treatAsTool']) {
    if (tools.length === 0) {
      throw new UsageError('composite synthesis requires at least one --tool argument')
    }
    return runComposite({ ...opts, tools, mode: 'help-synthesis' })       // composite branch
  }
  program.outputHelp()                                                     // existing behaviour, byte-identical
  process.exit(0)
}
```

The same `helpOption(false)` strategy is applied to each composite
subcommand registration (so `cli-agent composite-synthesize --help`
prints the subcommand's own usage rather than passing through to the
composite branch).

**Byte-stability guarantee for the no-`--treat-as-tool` path**
(NFR-CMP-001): a regression test `test_scripts/help-baseline.spec.ts`
diffs `node dist/cli.js --help` against a pinned baseline file
`test_scripts/baselines/help-no-treat-as-tool.txt` (captured BEFORE the
`helpOption(false)` migration). The diff must be empty for every CI
run. The same pinning applies to each subcommand's `--help` (one
baseline file per subcommand). Any future change that drifts the byte
stream is caught by the regression test; intentional drifts must
re-record the baseline as part of the same commit.

### §14.K Virtual-tool dispatch (form c)

Virtual-tool dispatch has two recursion guards and a default-subprocess
isolation policy.

**Guard at registration time** (`writeManifest` and the
`--register-virtual` action): if any element of `members` is itself a
registered virtual-tool name (i.e., another composite's manifest
exists under `composites/<member>/manifest.json`), throw `UsageError`
exit 2 with the FR-CMP-016 message
`composite-of-composite is not supported in v1; member '<id>' is itself a composite`.

**Guard at dispatch time** (`dispatchComposite`): re-check membership
against the live registry on every dispatch (the manifest may have been
updated since registration). Same `UsageError` if any member is a
virtual composite.

**Subprocess default** (ADR-CMP-5): `dispatchComposite` defaults to
`mode: 'child-process'`. The child is forked via `child_process.spawn`
on the synthesis-time-resolved absolute `cli-agent` binary path with
the recorded `--tool` list. The child inherits a *minimal* env (the
existing `passEnv` set per §7 security model) plus the recursion-guard
env var:

```
CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1
```

When the child boots, `loadVirtualTools(cfg, logger)` reads the env var
at the top of its body and returns `[]` immediately — structurally
preventing nested composites at the registry level even if a user
manually adds a virtual composite as a member. This is the
load-bearing recursion guard for the dispatch path; the manifest-time
guard is a fast-fail safety net.

**In-process opt-in** (ADR-CMP-5; experimental in v1): set
`composite.virtualDispatch=in-process` (env `CLI_AGENT_VIRTUAL_DISPATCH=in-process`)
to re-enter the cli-agent agent-graph builder with the recorded tool
list, reusing the same Node process. Each call starts a *fresh*
`MemorySaver` (per refined-spec O-2 → ADR-CMP-5: stateless from the
caller's perspective). The integration test `dispatcher.spec.ts`
asserts FR-CMP-015: same input produces identical observable output
across both modes.

**`composite_dispatched`** (JSONL event): emitted on every dispatch
with `{ compositeName, mode, members, exitCode, latencyMs }`.
**`composite_recursion_guarded`**: emitted when either guard fires.

### §14.L Cache key + invalidation (closing O-1, O-4)

The composite cache key is the deterministic concatenation of:

```
sha256(
  sortedMembers.join(',')               // 1. canonical name list, sorted
  ‖ JSON.stringify(memberDigests, sortedKeys)   // 2. per-member doc digest
                                                //    (canonicalised, USER-* stripped)
  ‖ cliAgentVersion                     // 3. running cli-agent semver
  ‖ COMPOSITE_CAPABILITY_SCHEMA_VERSION  // 4. literal 3 in v1
  ‖ compositeName                       // 5. explicit or derived name
  ‖ synthesisModel                      // 6. "<vendor>:<modelId>"
).hex().slice(0, 64)                    // full 64-char hex; truncated to 16 in
                                         // syntheticDigest only
```

**Inputs explicitly excluded from the cache key** (per ADR-CMP-7 / OQ-1):

- `tool-prompts/<member>.md` overlay digests (overlays change *prompt-time
  description*, not capability-time bytes; the synthesis input is the
  member's `--help`-derived capability doc, not its overlay).
- `~/.tool-agents/cli-agent/.env` contents (credentials must not feed
  cache keys; see §7 redaction policy).
- The active profile's `tools.*` or `toolArgs` sections (synthesis
  ignores them per FR-CMP-019).
- Stage-2 LLM response content (the cache is keyed to inputs, not
  outputs).

**Invalidation triggers** (any single change → cache miss → re-synthesis):

- A member's capability doc bytes changed (canonicalised digest differs).
- A member added to or removed from `--tool` flags (members list shape changed).
- The cli-agent binary's reported semver differs from the recorded value.
- The composite-name changed (a different name → a different cache file).
- The synthesis model changed (provider OR model id).
- The composite schema version bumped (v1.x → v2.x cache miss; documented).

**`cli-agent` version mismatch policy** (ADR-CMP-8 / OQ-4): when the
running cli-agent reads a cached doc whose recorded `cliAgentVersion` is
*older* than the running version, treat as a strict cache miss. The
cache miss triggers re-synthesis on the next pipeline run, AND emits:

- A one-line stderr notice:
  `[cli-agent] composite '<id>' cached against cli-agent <oldver>; resynthesising for <newver>`
- A JSONL event `composite_cache_version_mismatch` with payload
  `{ compositeName, recordedVersion, runningVersion }`.

There is no semver tolerance. The Stage-1 distill cache is independent
of `cliAgentVersion` (it keys to `STAGE1_TEMPLATE_VERSION` + `cfg.model`),
so member docs unchanged → Stage-1 hit → only Stage-2 re-runs on a
version bump. Cost is bounded.

**Future v1.1 instrumentation** (forward-looking only): the JSONL event
`composite_synthesis_started` includes a forward-looking field
`currentEffectiveOverlayDigests: { <member>: <digest> }` capturing the
overlay digest at synthesis time. v1 does not consult this field for
invalidation; production telemetry over a 30-day window will inform the
v1.1 decision on whether to add overlay digests to the cache key.

### §14.M Logging schema additions

Nine new event kinds extend the `LogEvent` union in `src/agent/logging.ts`.
All events are subject to the existing JSONL redaction policy
(`redactString`); prompt and response *bodies* are NEVER logged — only
their sha256[:16] digests, per FR-CMP-021 / A-12.

| Event kind | Emitted at | Payload (top-level keys) |
|---|---|---|
| `composite_synthesis_started` | `synthesizeComposite()` entry | `compositeName`, `members[]`, `cacheHit`, `dryRun`, `providerFamily`, `stage1OnDiskHits`, `currentEffectiveOverlayDigests` (forward-looking; OQ-1 instrumentation) |
| `composite_stage1_cached` | per-member, when distill cache hit | `compositeName`, `member`, `distillCacheKey`, `cacheFilePath` |
| `composite_stage1_run` | per-member, when distill cache miss | `compositeName`, `member`, `promptDigest16`, `tokensInput`, `tokensOutput`, `latencyMs` |
| `composite_stage2_run` | once per synthesis | `compositeName`, `promptDigest16`, `tokensInput`, `tokensOutput`, `latencyMs`, `providerCacheCreation`, `providerCacheRead` (the last two extracted via `extractCacheUsage` from the response — Anthropic's `cache_creation_input_tokens` / `cache_read_input_tokens` OR OpenAI-compat's `prompt_tokens_details.cached_tokens`; zeros on `unknown` providers) |
| `composite_cache_hit` | top-level cache hit (cached doc returned without LLM contact) | `compositeName`, `cacheKey16`, `cacheFilePath` |
| `composite_cache_miss` | top-level cache miss path entered | `compositeName`, `cacheKey16`, `reason` (one of `member_doc_changed`, `cli_agent_version_mismatch`, `members_changed`, `composite_name_changed`, `synthesis_model_changed`, `schema_version_changed`, `not_present`) |
| `composite_cache_version_mismatch` | reading a doc whose `cliAgentVersion` is older than running | `compositeName`, `recordedVersion`, `runningVersion` |
| `composite_dispatched` | virtual-tool dispatch invocation (form c) | `compositeName`, `mode` (`child-process`/`in-process`), `members[]`, `exitCode`, `latencyMs` |
| `composite_recursion_guarded` | recursion guard at register-time OR dispatch-time | `compositeName`, `offendingMember`, `phase` (`register`/`dispatch`) |

The `composite_emit` event from FR-CMP-021 is also retained (per
artifact: `doc`, `wrapper`, `manifest`, `symlink`) with payload
`{ artifact, absolutePath, mode }`. The five FR-CMP-021 events
(`composite_synthesis_start/_stage/_end`, `composite_emit`,
`composite_dispatch`) map onto the nine kinds above as follows:
`_start` → `composite_synthesis_started`, `_stage` → `composite_stage1_run`
+ `composite_stage2_run`, `_end` → either `composite_cache_hit` or
`composite_cache_miss` (the canonical end-of-synthesis disposition),
`_emit` and `_dispatch` retained verbatim.

### §14.N Test strategy

Tests follow the existing two-layer convention: co-located `*.spec.ts`
under `src/agent/composite/` and `src/commands/composite/` for unit-level
coverage; `test_scripts/fixtures/synthesis/<scenario>/` folders for
end-to-end pipeline scenarios.

**Fixture pattern** (ADR-CMP-11): one folder per scenario. Each folder
contains:

```
test_scripts/fixtures/synthesis/<scenario>/
  inputs.json                     compositeName, members, cfg overrides
  members/<m>.md                  fixture member capability docs
  transcript.json                 { "<sha256-of-prompt>": "<canned LLM output>" }
  expected.md                     expected composite doc bytes
  expected-transcript.jsonl       expected JSONL event sequence (subset match)
```

**Stub-LLM dispatcher** (NFR-CMP-002): the test harness provides
`test_scripts/lib/synthesisFixture.ts`:

```typescript
export async function loadScenario(name: string): Promise<{
  stubLLM: BaseChatModel
  inputs: SynthesisInputs
  expectedDoc: string
  expectedTranscript: LogEvent[]
}>
export async function recordScenario(name: string, realLLM: BaseChatModel): Promise<void>
  // gated on process.env['RECORD'] === '1'; rewrites transcript.json
```

The stub LLM keys responses by `sha256(JSON.stringify(messages))[:16]`
and throws `Error("No canned response for prompt digest <key>")` on
miss — matching the `extract-recipes.spec.ts:41-44` precedent. Stubs
operate at the `createLLM` factory boundary
(`vi.spyOn(registry, 'createLLM').mockReturnValue(...)`) — never at
the LangChain import level, preserving every other code path's real
behaviour.

**Required scenarios** (each is a folder under
`test_scripts/fixtures/synthesis/`):

- `two-cli-tools-happy-path/` — covers AC-2 (synthesis), AC-4 (cache hit),
  AC-5 (cache miss on member doc change), AC-9 (derived name), AC-10
  (`--no-emit-doc`).
- `empty-recipes-edge-case/` — LLM-output that yields empty USER-RECIPES;
  ensures markers still present.
- `three-members-large-budget/` — covers `--synthesis-budget-tokens`
  enforcement.
- `with-overlay-applied/` — NFR-CMP-007 coexistence (member has overlay;
  synthesis ignores overlay; OQ-1 instrumentation captures overlay digest
  in JSONL).
- `regenerate-preserves-user-blocks/` — covers AC-6 (USER-RECIPES + USER-NOTES
  byte-preservation across regeneration).

**Baseline-pinned regression** (NFR-CMP-001): the AC-1 invariant — that
`cli-agent --help` (no `--treat-as-tool`) produces a byte-identical
output stream pre and post the `helpOption(false)` migration — is
asserted by `test_scripts/help-baseline.spec.ts` against the pinned
file `test_scripts/baselines/help-no-treat-as-tool.txt`. The pinning
runs on every CI invocation and fails the build on any drift.

**Smoke scripts** (NFR-CMP-003 / NFR-CMP-004 / NFR-CMP-007):

- `test_scripts/smoke-cache-hit-cost.ts` — process boot → stdout flushed
  → exit 0 on a cache hit; assert ≤ 500 ms.
- `test_scripts/smoke-synthesis-latency.ts` — synthesis under stub LLM
  ≤ 30 s for a 2-member ≤32 KB composite.
- `test_scripts/smoke-coexistence-end-to-end.ts` — profile active +
  overlay applied to member + member has USER-RECIPES + synthesis +
  outer cli-agent attaching the composite via `--tool <id>` produces a
  coherent system prompt embedding the composite USER-RECIPES.

### §14.O Coexistence with §11 overlays / §12 profiles / capability recipes / §13 TUI exit-resume

The composite subsystem is orthogonal to all four pre-existing
subsystems. The orthogonality table maps every interaction explicitly.

| Concern | §11 Overlays (plan-004) | §12 Profiles (plan-005) | Capability recipes / `manRef` (plan-005-recipes) | §13 TUI exit/resume (plan-005-tui-exit) |
|---|---|---|---|---|
| Composite synthesis input | Member-tool overlays NOT in v1 cache key (ADR-CMP-7 / OQ-1). Overlay digest captured in JSONL telemetry only. | `cliParams.{provider,model,temperature,...}` flow through `loadAgentConfig` → `cfg`; `createLLM(cfg)` honours profile model. `tools.allow/deny/order` is **NOT** consulted for member selection (FR-CMP-019). `toolArgs` is **NOT** embedded in the synthesised doc. | Member doc bytes (canonicalised, USER-* blocks stripped) feed Stage-1. Composite docs always carry `manRef: null` per A-10. | No interaction (TUI is orthogonal to CLI flag plumbing). |
| Composite synthesis output | Not affected. | `frontmatter.activeProfile = <name | null>` for traceability. Read-only from the profile loader. | Composite USER-RECIPES is pre-filled by Stage-2 (3–7 cross-tool recipes). Preserved byte-for-byte across `--regenerate-capabilities` (FR-CMP-010). | No interaction. |
| Outer-agent consumption (when an outer cli-agent attaches a composite via `--tool <id>`) | Composites have no overlay file (overlay format applies to wrapped binaries; composites are virtual). The composite's USER-RECIPES section is the only user-editable surface for prompt customisation. | Profile scoping applies to virtual tools — `loadVirtualTools` injects them into `assembled` BEFORE `applyProfileToolScoping` (`registry.ts:84`); so a profile's `tools.allow/deny` can include or exclude a composite by id, exactly like a native tool. | `composeCapabilitiesSystemPrompt` reads the mirror copy at `capabilities/<id>.md` like any other capability doc; USER-RECIPES embeds within the per-tool byte budget; synopsis falls back when over budget (FR-CMP-020). The composite's `manRef: null` is honoured by the existing `extractManRef` parser. | `--treat-as-tool` is incompatible with `--resume` — `UsageError` exit 2 on the combination. |
| Bootstraps | No overlap; overlay dir owned by §11. | No overlap; profiles dir owned by §12. | No bootstrap (additive frontmatter). | No overlap; snapshot dir owned by §13. |
| New bootstrap dirs (this plan) | — | — | — | `capabilities/composite/`, `capabilities/composite/_distill/`, `composites/` (additive; mode 0700) |

The composite subsystem does NOT modify the overlay loader, the profile
loader, the recipe extractor, or the TUI exit/resume snapshot store.
The only existing read site touched is `compose-system-prompt.ts:99`
(extended with a `composite/` fallback in U-DOC); the registry seam
at `registry.ts:84` gains one new call (`loadVirtualTools`) inserted
between `buildAgentToolsGroup` and `applyProfileToolScoping`.

### §14.P Phase 6 parallel implementation units (interface contracts)

Phase 6 fans out into seven implementation units. Each unit consumes
only the foundation modules delivered by P3–P5 (paths, schema constant,
type definitions, cache reader scaffolding, derive-name helper, baseline
regression test) and the interface contracts in §14.D. Integration
happens at module boundaries locked by P3–P5; no two units edit the
same line of `src/cli.ts` or `src/agent/tools/registry.ts` (R-12
mitigation).

| Unit | Imports from foundation (P3–P5) | Exports to other units | Owned files (created or fully owned) |
|---|---|---|---|
| **U-FLAGS** | `AgentCliFlags` (P3), `UsageError` (errors.ts), `helpOption(false)` migration (P4) | `CompositeCliFlags`, `parseCompositeFlags`, `enforceCompositeFlagMatrix` (consumed by U-CMD) | `src/cli-composite-flags.ts`, `src/cli-composite-flags.spec.ts`. Edits in `src/cli.ts` lines 49–93 (default-command options block). |
| **U-SYNTH** | `CompositeSchemaV3Frontmatter`, `Stage1Distillation`, `SynthesisInputs`, `SynthesisResult` (types.ts), `computeMemberDocDigest`, `composeCompositeDoc` (P5), `createLLM` (`providers/registry.ts`), `withSynthesisCache`, `extractCacheUsage`, `resolveProviderFamily` (U-CACHE) | `synthesizeComposite(input): Promise<SynthesisResult>` (consumed by U-CMD); Stage-1 distill cache helpers `readDistillCacheEntry` / `writeDistillCacheEntry` (consumed by future v1.1 audit hooks) | `src/agent/composite/synthesizer.ts`, `stage1.ts`, `stage2.ts`, `prompts.ts`, `synthesizer.spec.ts`, `stage1.spec.ts`, `stage2.spec.ts`. |
| **U-CACHE** | `BaseMessage` (`@langchain/core/messages`), `AgentConfig` (P3) | `withSynthesisCache`, `extractCacheUsage`, `resolveProviderFamily`, `ProviderFamily`, `SynthesisCacheOptions` (consumed by U-SYNTH) | `src/agent/composite/llm-cache.ts`, `llm-cache.spec.ts`. |
| **U-DOC** | `CompositeSchemaV3Frontmatter` (types.ts), `canonicaliseMemberDoc` helper (P5), USER-* block parsers (existing `composeMarkdown.ts`) | `COMPOSITE_CAPABILITY_SCHEMA_VERSION`, `computeCompositeCacheKey`, `computeMemberDocDigest`, `readCompositeCacheEntry`, `writeCompositeCacheEntry`, `mirrorCompositeDocToCapabilities`, `composeCompositeDoc` (consumed by U-SYNTH and U-CMD) | `src/agent/composite/cache.ts` (full body; P5 stub becomes complete), `composeCompositeDoc.ts`, both specs. Small extension to `src/agent/capabilities/compose-system-prompt.ts` (composite/ fallback). |
| **U-WRAPPER** | `CompositeWrapperShimSpec` (types.ts), atomic temp+rename helper (existing in `agent-config.ts`) | `generateCompositeWrapperShim`, `generatePathSymlink` (consumed by U-CMD) | `src/agent/composite/shim-writer.ts`, `shim-writer.spec.ts`, `test_scripts/shim-e2e.ts`. |
| **U-VIRTUAL** | `CompositeManifest`, `VirtualToolHandle`, `DispatchMode` (types.ts), `AgentConfig` (P3), `Logger` (logging.ts) | `readManifest`, `writeManifest`, `loadVirtualTools`, `dispatchComposite` (consumed by U-CMD and `registry.ts:84`) | `src/agent/composite/manifest.ts`, `virtual-registry.ts`, `dispatcher.ts`, all three specs. Edit in `src/agent/tools/registry.ts:84` (single insertion site). |
| **U-CMD** | `CompositeCliFlags` (U-FLAGS), `synthesizeComposite` (U-SYNTH), `writeCompositeCacheEntry`, `mirrorCompositeDocToCapabilities` (U-DOC), `generateCompositeWrapperShim` (U-WRAPPER), `writeManifest` (U-VIRTUAL), `validateCompositeName`, `deriveCompositeName` (P5) | (no exports to other P6 units) | `src/commands/composite/synthesize.ts`, `regenerate.ts`, `list.ts`, `show.ts`, `delete.ts`, `derive-name.ts` (filled — P5 stubbed), `shared.ts`, all specs. Subcommand registrations in `src/cli.ts` (separate region from U-FLAGS' edits). |

If seven parallel coders are not available, the natural pair-up is:

- `(U-FLAGS + U-CMD)` — both touch `src/cli.ts` and the command surface
  (different line regions; no merge conflict).
- `(U-SYNTH + U-CACHE)` — synthesizer consumes the cache helper directly.
- `(U-DOC)` standalone.
- `(U-WRAPPER + U-VIRTUAL)` — both write under `composites/<id>/`.

This contracts to four effective workstreams.

**Merge-conflict mitigation** (R-12): P5 lands ALL flag/env/subcommand-stub
registrations BEFORE P6 fans out. P6 unit U-FLAGS owns `src/cli.ts`
lines 49–93 (default-command options). U-CMD owns the
`program.command(...)` registrations (different file region). U-VIRTUAL
owns `src/agent/tools/registry.ts:84` (single insertion). No two units
edit the same line.

### §14.Q Architectural decisions (ADRs)

The twelve ADRs locked in plan-006 §6 are restated here for completeness;
two additional decisions emerged during this design phase.

- **ADR-CMP-1 — Pipeline shape**. **Decision**: two-stage (Stage-1
  per-member distill + Stage-2 compose) with Stage-1 outputs cached as
  addressable per-member artifacts at `capabilities/composite/_distill/<member>@<digest>.json`.
  **Rationale**: refined-spec FR-CMP-006 + investigation Recommendation #1.
  Stage-1 outputs are ~500 tokens each — below every provider's 1 024-token
  cache threshold — so on-disk addressable cache is the only effective
  Stage-1 mechanism. Provider-side prompt caching is reserved for Stage-2.
  **Alternatives rejected**: single combined prompt (loses per-member
  reusability across composites), three-stage with intermediate review
  pass (over-engineered for v1 surface). **Status**: Locked.

- **ADR-CMP-2 — Wrapper shim shebang**. **Decision**: `#!/bin/sh`
  (NOT `#!/usr/bin/env bash`); no `set -euo pipefail`; `exec` for both
  cat and cli-agent. **Rationale**: matches npm's battle-tested `cmd-shim`
  reference (research §13); eliminates Alpine/no-bash failure mode;
  POSIX-portable (`pipefail` is non-POSIX-2017). The shim body uses only
  POSIX `sh` constructs. **Alternatives rejected**: `#!/usr/bin/env bash`
  per investigator's recommendation — defensible on macOS+mainstream Linux
  but introduces unnecessary portability risk. **Status**: Locked
  (deviation from refined-spec FR-CMP-013 wording; reversible).

- **ADR-CMP-3 — `--regenerate-capabilities` is distinct from
  `--refresh-capabilities`**. **Decision**: the two flags are NOT aliases.
  Without `--treat-as-tool`, `--regenerate-capabilities` exits 2 with a
  guidance message pointing to `--refresh-capabilities`. **Rationale**:
  silent aliasing creates a maintenance landmine and hides intent
  (introspection-only refresh vs LLM-driven synthesis). **Alternatives
  rejected**: silent aliasing per refined-spec FR-CMP-010 wording.
  **Status**: Locked (deviation; OQ-7 confirmation pending).

- **ADR-CMP-4 — Subcommand surface is flat hyphenated**. **Decision**:
  `composite-synthesize`, `composite-list`, `composite-show`,
  `composite-delete`. **Rationale**: codebase convention (5 existing
  flat-hyphenated subcommands; zero nested groups) + plan-005 ADR-PROF-5
  precedent. **Alternatives rejected**: nested `cli-agent composite synthesize`
  per refined-spec FR-CMP-022 wording. **Status**: Locked (mechanically
  reversible).

- **ADR-CMP-5 — Virtual-tool dispatch default**. **Decision**:
  `child-process` is the default; `in-process` is opt-in via
  `composite.virtualDispatch=in-process` AND explicitly experimental in v1.
  **Rationale**: investigation Recommendation #3 — LangGraph subgraph
  re-entry has known state-pollution hazards (Issue #3020); subprocess
  dispatch is the tested production path. **Alternatives rejected**:
  in-process default, in-process only (closes OQ-2). **Status**: Locked.

- **ADR-CMP-6 — Schema versioning**. **Decision**: a separate constant
  `COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3` lives in
  `src/agent/composite/cache.ts`. The existing
  `CAPABILITY_SCHEMA_VERSION = 2` in `src/agent/capabilities/composeMarkdown.ts`
  is **NOT** modified. The composite reader is a separate function;
  member-tool docs continue to be loaded by the existing reader.
  **Rationale**: investigation Recommendation #4; codebase scan §IP-4.
  Bumping the existing constant would invalidate every member-tool cache
  entry in the wild. **Alternatives rejected**: bump `CAPABILITY_SCHEMA_VERSION = 3`,
  share the reader. **Status**: Locked.

- **ADR-CMP-7 — Cache key composition (overlay digest)**. **Decision**:
  the cache key is exactly the FR-CMP-009 set: `(sortedMembers,
  memberDigests, cliAgentVersion, COMPOSITE_CAPABILITY_SCHEMA_VERSION,
  compositeName, synthesisModel)`. **Overlay digest is NOT included.**
  The current effective overlay digest is recorded in
  `composite_synthesis_started.currentEffectiveOverlayDigests` for v1.1
  instrumentation only. **Rationale**: investigation Recommendation #5
  (closes OQ-1). Synthesis input is `--help`-derived bytes, not overlay
  text. Including overlay digest would force re-synthesis on cosmetic
  edits and defeat the cache. Users force fresh synthesis explicitly
  via `--regenerate-capabilities`. **Alternatives rejected**: include
  overlay digest. **Status**: Locked.

- **ADR-CMP-8 — Older cli-agent version cache policy**. **Decision**:
  strict mismatch = cache miss with stderr notice and
  `composite_cache_version_mismatch` JSONL event. No semver tolerance.
  **Rationale**: closes OQ-4; the cache key already contains
  `cli-agent-version`; minor-version tolerance is invisible policy that
  drifts in production. The notice + telemetry preserves user awareness
  without prompting. Re-synthesis cost is bounded by the on-disk
  Stage-1 cache. **Alternatives rejected**: minor-version tolerance,
  silent re-synthesis without notice. **Status**: Locked.

- **ADR-CMP-9 — Wrapper shim binary path**. **Decision**: absolute path
  resolved at synthesis time. nvm/volta/asdf detection produces a
  stderr warning (non-fatal) at synthesis time. **Rationale**: shim
  research §6 (closes OQ-6) — PATH lookup at execution time is
  unreliable; the composites directory may not be on PATH; user PATH
  may differ at synthesis vs invocation. Cross-machine sync is
  explicitly deferred (refined-spec Out-of-scope §2). **Alternatives
  rejected**: PATH lookup at runtime, embedded relative path.
  **Status**: Locked.

- **ADR-CMP-10 — Synthesis budget knob**. **Decision**: one combined
  `--synthesis-budget-tokens` (default 32 768). No per-stage budgets in
  v1. **Rationale**: research-prompt-caching Finding 1 (closes OQ-3) —
  Stage-1 outputs (~500 tokens each) sit below every provider's
  1 024-token cache threshold. Splitting the budget creates a UX surface
  that v1 cannot calibrate. The combined cap is sufficient for the
  2–5 member surface. **Alternatives rejected**: per-stage budgets,
  no budget. **Status**: Locked.

- **ADR-CMP-11 — Test fixture pattern**. **Decision**: folder per
  scenario under `test_scripts/fixtures/synthesis/<name>/` with
  `inputs.json`, `members/*.md`, `transcript.json`, `expected.md`.
  Recordable via `RECORD=1` env var. **Rationale**: investigation
  Recommendation #6; matches the project's existing
  `test_scripts/fixtures/` precedent. **Alternatives rejected**:
  inline-string fixtures (poor diffability), single transcript per
  test file (couples scenarios). **Status**: Locked.

- **ADR-CMP-12 — Composite-doc co-location**. **Decision**: write the
  canonical doc to `capabilities/composite/<id>.md` AND mirror (file
  copy, NOT symlink) to `capabilities/<id>.md` so the existing
  `composeCapabilitiesSystemPrompt` (`compose-system-prompt.ts:99`)
  finds it without code changes. The function is also extended (U-DOC)
  to fall back to the `composite/` subdirectory if the mirror is
  absent (defensive). **Rationale**: codebase scan §IP-3 / §Notes —
  symlinks are problematic on Windows (out of scope) and on backup
  systems that don't preserve them; file copy is portable and the
  mirror's freshness is enforced by `composite-delete` removing both.
  **Alternatives rejected**: symlink, single canonical location with
  reader changes (broader blast radius). **Status**: Locked.

New ADRs introduced during this design phase:

- **ADR-CMP-13 — Manifest race protection via O_EXCL `.lock`**.
  **Decision**: `writeManifest` wraps the read-then-write sequence in
  an O_EXCL lock at `composites/<id>/.lock`. On contention, exit 1
  with `concurrent registration in progress; retry`. **Rationale**:
  R-8 from plan-006 §8 — two parallel `--register-virtual` invocations
  for the same composite name could race the manifest write. A real
  POSIX advisory lock would require a native module; the O_EXCL file
  approach is filesystem-portable, atomic on the same filesystem, and
  trivially cleaned up by the rare-contention path. v1.1 may upgrade
  to a flock-based scheme if real contention is observed.
  **Alternatives rejected**: no lock (race window observable in
  scripted CI runs), POSIX flock (native dep). **Status**: Locked.

- **ADR-CMP-14 — Stage-1 cache key omits `cli-agent` version**.
  **Decision**: the Stage-1 distill cache key is
  `sha256(memberDocCanonical ‖ STAGE1_TEMPLATE_VERSION ‖ cfg.model)[:16]`,
  intentionally NOT including `cliAgentVersion`. **Rationale**: a
  cli-agent version bump that changes synthesis prompts will already
  bump `STAGE1_TEMPLATE_VERSION` (by code change). Including
  `cliAgentVersion` would invalidate the Stage-1 cache on every
  cli-agent release, undoing the bounded-cost guarantee for the
  ADR-CMP-8 mismatch path. The Stage-2 cache key (the top-level
  composite key) DOES include `cliAgentVersion`, so version mismatches
  still trigger top-level re-synthesis — only the per-member
  distillation is preserved. **Alternatives rejected**: include
  cliAgentVersion in the Stage-1 key (breaks the bounded-cost
  guarantee), include in both keys redundantly (no value).
  **Status**: Locked.

ADR deviations summary (from refined spec, for at-a-glance scan):

- **ADR-CMP-2** — shim shebang is `#!/bin/sh`, not `#!/usr/bin/env bash`.
- **ADR-CMP-3** — `--regenerate-capabilities` and `--refresh-capabilities`
  are distinct, not aliases (OQ-7 pending user confirmation).
- **ADR-CMP-4** — subcommands are flat hyphenated (codebase consistency).

All three deviations are flagged in plan-006 §0 (OQ-6 covers ADR-CMP-9;
OQ-7 covers ADR-CMP-3) and are mechanically reversible if the user
prefers the original spec wording.

---

## §15. LLM I/O Inspector (plan-007 / design-007)

**Date:** 2026-06-13 · **Based-on commit:** `c546d3891d273d3afdcf6271f6257cba3ce9022b`

**Provenance chain:**
- Refined request: `docs/reference/refined-request-llm-io-inspector.md` (FR-1..FR-12, NFR-1..NFR-6, AC-1..AC-11; all 7 Open Questions resolved at the recommended defaults).
- Investigation: none — the approach was fully fixed by the resolved Open Questions (Phase 3a intentionally skipped).
- Technical research: `docs/research/langgraph-streamevents-io-capture.md` (the `streamEvents v2` capture seam + the `zod-to-json-schema`-absent dependency verdict).
- Codebase scan: `docs/reference/codebase-scan-llm-io-inspector.md` (integration points, conventions, in/out-of-scope; `last_scanned_commit` matches HEAD).
- Plan: `docs/design/plan-007-llm-io-inspector.md` (21 steps, 7 implementation units).
- Design: `docs/design/design-007-llm-io-inspector.md` (this section is its living-doc reflection).

**What it adds.** A diagnostic switch — `--inspect-io` / `--inspect-io-raw` CLI flags plus an in-TUI `/inspect on|off|show [turn]|status` slash command — that records the EXACT provider-normalized request (assembled system prompt + full in-thread memory + current user content + bound tool/function JSON schemas) and the EXACT response (assistant text + parsed tool-calls + tool results) for every LLM turn, to a tailable JSONL file under `~/.tool-agents/cli-agent/io-captures/`. Read-only inspection; no editing/replaying captures.

**Architecture — dedicated parallel capture channel.**
- **New module `src/agent/io-capture.ts`** mirrors the operational logger's `Logger` / `FileLogger` / `NullLogger` / `createLogger` structure (`src/agent/logging.ts`) but writes to its own `io-captures/` store. It defines the `IoCapture` interface, the typed `IoCaptureRecord` union (`request` / `response` / `tool_result`, sharing a `{ sessionId, threadId, turnId, stepIndex, ts }` envelope), the `createIoCapture(cfg, sessionId, tools)` factory, and the pure helpers `toCaptureMessage` / `extractStartMessages` / `captureBoundToolSchemas`. The `LogEvent` union and the transcript format are NOT modified — heavy prompt/memory payloads never bloat the compact `logs/` stream (off-state byte-stability, NFR-1).
- **Single provider-neutral hook seam.** Capture occurs at LangChain's `streamEvents v2` boundary in `src/agent/graph.ts`, emitted above the provider SDK so all eight providers share one code path (FR-12): the REQUEST from `on_chat_model_start.data.input` (the literal `{ messages: BaseMessage[] }`, which already contains the system prompt as a `SystemMessage` — so FR-3a/3b/3c are captured for free), the RESPONSE from `on_chat_model_end.data.output` (an `AIMessageChunk` whose aggregated `.tool_calls` are parsed objects), and the TOOL RESULT from `on_tool_end` (FR-4c end-to-end chain). The non-streaming `runOneShot` path emits no events and is captured from `result['messages']` after `graph.invoke`.
- **Tool-schema serialization (design invariant).** Bound schemas are serialized ONCE per session with `convertToOpenAITool` from `@langchain/core/utils/function_calling` (already installed; same helper the OpenAI adapter uses). `zod-to-json-schema` is verified ABSENT on disk (optional peer of `@langchain/langgraph` only) and MUST NOT be imported — no new runtime dependency is introduced.
- **`stepIndex` within `turnId`.** One user turn fires N `on_chat_model_start` events in the ReAct loop; the existing per-turn `turnId` is reused and a monotonic `stepIndex` records each model call, so `/inspect show [turn]` groups the full request→tool→request chain under one turn.
- **Off-state.** `createIoCapture` returns `NullIoCapture` when `cfg.inspectIo === null`; every graph hook is guarded by `if (ioCapture)`. When off, provider payloads, streamed output, `logs/` JSONL, transcripts, and `--help` are byte-identical to `master`.

**Reused conventions (no new parallels invented).** `src/util/redact.ts` (`redactString` on message content, `redactObject` on tool-call args/result); the 64 KiB `FIELD_TRUNCATE_BYTES` field-cap with `_truncated`/`_orig_size_bytes` markers; the `0700` dir / `0600` `O_CREAT|O_APPEND` files / UTC `session-<UTC>-<sessionId>.jsonl` filename / `latest.jsonl` relative-symlink filesystem contract; the writer-local `try/catch` error swallow (the one sanctioned exception); the typed error hierarchy; the `memory.ts` slash-command template; the byte-stable `--help` baseline discipline.

**Configuration (no fallback).** `src/config/agent-config.ts` gains `AgentCliFlags.inspectIo`/`inspectIoRaw`, `AgentConfigFile.inspectIo { enabled?, redact?, dir? }`, the resolved `AgentConfig.inspectIo: { enabled; redact; dir } | null` (null when not requested — NEVER silently defaulted), the `agentIoCapturesDir()` helper, `bootstrapAgentDir` creating `io-captures/` at `0700`, and `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW` in `ALL_ENV_KEYS`. Resolution is four-tier (shell env → `~/.tool-agents/cli-agent/.env` → local `.env` → CLI flag). An explicitly-requested-but-uninitialisable inspector raises `ConfigurationError` with no fallback.

**Redaction policy.** ON by default (reuses `redact.ts`); `--inspect-io-raw` / `CLI_AGENT_INSPECT_IO_RAW=1` disables redaction for captures only, with a prominent stderr warning emitted before the file is opened.

**Key design decisions (ADRs).**
- **ADR-IO-1 — Parallel channel, not a `LogEvent` extension.** Keeps the operational log compact and byte-stable. Rejected: extending `LogEvent`; a combined writer.
- **ADR-IO-2 — Request captured from the start-event message array, not the pre-composition prompt string.** Literal model input, zero reconstruction, robust to future middleware. Rejected: reconstructing from the assembled string + checkpointer read (the scan's original proposal, superseded by the research).
- **ADR-IO-3 — `convertToOpenAITool`, never `zod-to-json-schema`.** No undeclared dependency; same JSON Schema the provider receives. Rejected: `zod-to-json-schema` (policy violation + runtime failure).
- **ADR-IO-4 — Read `tool_calls` from the end-event aggregate, never per-stream chunks.** Avoids partial/empty args.
- **ADR-IO-5 — Off-state `null` + `NullIoCapture` + guarded hooks.** Structural NFR-1 guarantee.
- **ADR-IO-6 — No-fallback config with `null`-when-off semantics.** Distinguishes "off" from "misconfigured" without a default substitute.
- **ADR-IO-7 — Slash registration at `src/tui/index.ts`, not `slash/registry.ts`** (corrects the scan's mis-titled site).

**Deferred follow-ups (explicitly out of scope).** Literal on-the-wire per-provider HTTP-byte capture; capture inside capability-discovery / composite-synthesis LLM calls; a detached-terminal-window convenience wrapper; a live-refreshing in-TUI pane (the file is written live and `tail -f`-able; the in-TUI `/inspect show` renders a completed turn on demand).

**As-built surface (for reference; full behaviour in `docs/tools/cli-agent.md` → `## LLM I/O Inspector`).** Shipped under Plan 007: the `--inspect-io` / `--inspect-io-raw` CLI flags (`src/cli.ts`), the `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW` env vars and `config.json` `inspectIo { enabled?, redact?, dir? }` key resolved no-fallback in `src/config/agent-config.ts` (`resolveInspectIo`), the capture channel in `src/agent/io-capture.ts`, the graph/runner hooks in `src/agent/graph.ts` + `src/agent/run.ts` (`TuiAgentRuntime.ioCapture`), the `TuiController.ioCapture` field (`src/tui/controller.ts`), and the `/inspect` slash command (alias `/inspect-io`) in `src/tui/slash/inspect.ts` with sub-commands `status` (default) · `show [turn]` (1-based; latest when omitted; in-TUI blocks clipped at a render budget with a visible `… [truncated]` marker, distinct from the writer's 64 KiB on-disk field cap) · `on` / `off` (informational — capture is established at launch). The on-disk truncation marker is `_truncated: true` plus an `_orig_size_bytes` map (dotted-path → original byte size) attached at the record top level. (Phase-7 review reconciliation: design-007's "Field-cap & redaction markers" section was updated to document this object-map shape — the as-built `deepTruncate` walks every nested string field, so `_orig_size_bytes` is a per-field map rather than the single scalar the original design example sketched; the richer implementation is retained.)

---

## §16. Tool-Loading Toggles (plan-008) — SUPERSEDED

> **SUPERSEDED (2026-07-04) by "CLI Mode Simplification (plan-015)"** — see
> the dated section at the end of this document. Every surface described
> below (the three flag pairs, the `CLI_AGENT_DISABLE_*` env vars, the
> `config.json` `composites`/`builtinTools`/`agentTools.enabled` keys, and
> the profile `tools.*` group keys) was hard-removed; the single `--mode`
> knob replaces them. This section is retained for historical traceability.

**Date:** 2026-06-14 · **Based-on commit:** `c546d3891d273d3afdcf6271f6257cba3ce9022b`

**Plan reference:** `docs/design/plan-008-tool-loading-toggles.md`. (Functional requirements registered as FR-TLT-001..007 / NFR-TLT-001..003 in `docs/design/project-functions.md`; full user-facing behaviour in `docs/tools/cli-agent.md` → `<toolLoadingToggles>` and the configuration-guide "Tool-loading toggles" section.)

**What it adds.** Three independent, group-level tool-loading switches, each with four configuration surfaces (CLI flag + env var + `config.json` + profile), resolved by one uniform precedence chain. All default to **load**, so the off-state (defaults) leaves the assembled catalog byte-identical to the pre-plan-008 build.

| Group | Members | CLI | Env (truthy = OFF) | `config.json` | profile |
|---|---|---|---|---|---|
| Built-in tools (cross-cutting toolkit) | `bash_list_allowed`, `bash_which`, `tool_help`, plus `bash_run` when the bash allowlist is non-empty. *Plan-011 moved web to `agt_web_*`; plan-012 moved file operations to `agt_file_*`.* | `--builtin-tools` / `--no-builtin-tools` | `CLI_AGENT_DISABLE_BUILTIN_TOOLS` | `builtinTools` | `tools.builtin` |
| Composites | every virtual/composite tool (`loadVirtualToolsSync`) | `--composites` / `--no-composites` | `CLI_AGENT_DISABLE_COMPOSITES` | `composites` | `tools.composites` |
| Agent-tools pack (`agt_*`) | the vendored `agt_glob/grep/multiedit/patch/todo_read/todo_write` tools plus first-party `agt_web_search/agt_web_fetch` and `agt_file_read/list/write/edit/append` | `--agent-tools` / `--no-agent-tools` (pre-existing) | `CLI_AGENT_DISABLE_AGENT_TOOLS` (pre-existing) | `agentTools.enabled` (pre-existing) | `tools.agentTools` (**new tier**) |

**Precedence (uniform).** `CLI flag > env (CLI_AGENT_DISABLE_*) > config.json > profile > default(load)`. The `CLI_AGENT_DISABLE_*` env vars use the inverted-disable convention (truthy = OFF), matching `CLI_AGENT_DISABLE_AGENT_TOOLS`. Invalid (non-boolean) env values raise `ConfigurationError` (exit 3) via `parseAgentToolsBoolEnvVar` — no fallback. The defaults are explicit optional-toggle starting values, NOT runtime fallbacks for missing required config; no new required config is introduced (the no-fallback rule is not triggered).

**Where it lands (code).**
- **`src/config/agent-config.ts`** — `AgentCliFlags` gains `composites?`/`builtinTools?`; `AgentConfigFile` gains `composites?`/`builtinTools?`; the resolved `AgentConfig` gains the always-present `composites: boolean` / `builtinTools: boolean`. `OTHER_ENV_KEYS` gains `CLI_AGENT_DISABLE_COMPOSITES` and `CLI_AGENT_DISABLE_BUILTIN_TOOLS`. A new `resolveToolGroupToggle(flagVal, disableEnvKey, layered, configVal, profileVal)` helper encodes the uniform chain (mirrors the umbrella logic in `resolveAgentTools`) and resolves `composites` / `builtinTools` from the active profile's `tools.composites` / `tools.builtin`. `resolveAgentTools` is extended with a `profileEnabled` parameter, inserting `tools.agentTools` as the profile tier just above the default in the umbrella resolution.
- **`src/config/profile-schema.ts`** — `ProfileToolsSchema` gains optional booleans `composites`, `builtin`, `agentTools`, remaining `.strict()` (unknown keys under `tools` still rejected). `KNOWN_CLI_PARAMS` is unchanged — these live under `tools`, not `cliParams`.
- **`src/agent/tools/registry.ts` — `buildToolCatalog` (the gate).** Built-in toolkit: when `cfg.builtinTools === false`, the bash/tool-help group and `bashRunTools` are each `[]` (the tools are not constructed). File and web operations are outside this gate after plan-011/012; they are controlled by the agent-tools umbrella and per-tool flags. Composites: `loadVirtualToolsSync` is called only when `cfg.composites !== false`. Profile `tools.allow/deny/order` scoping runs AFTER, unchanged. When the final scoped catalog is empty, ONE stderr notice is emitted (the agent degrades to a plain conversational LLM) — no throw. The off-path invariant uses `!== false`, so unset/`true` preserves the current default construction.
- **`src/cli.ts`** — registers `--composites` / `--no-composites` and `--builtin-tools` / `--no-builtin-tools` on the default agent command (Commander maps `--no-x` ⇒ `opts.x === false`), and threads `composites` / `builtinTools` into the `AgentCliFlags` literal passed to `runAgentCommand`.

**Behaviour notes.**
- **`--no-builtin-tools` removes `bash_run`** (it is part of the built-in toolkit), which is how the agent runs *wrapped* CLIs — so with built-in tools off, the agent acts only through composites and the agent-tools pack (whichever remain on).
- **An empty toolset is permitted** (all groups off, no wrapped CLI): supported, not an error. The catalog builder emits one stderr notice and proceeds. This is distinct from profile-scoping's empty-survivor error E7, which still applies to `allow`/`deny`.

**Key design decisions.**
- **Mirror the existing `agentTools` umbrella; invent no new pattern.** The toggles reuse the same inverted-disable env convention, the same "explicit default is not a fallback" justification, and the same resolution shape — extended only by a profile tier.
- **Gate at catalog-build time, with `!== false` semantics.** Resolving once in `buildToolCatalog` (alongside every other catalog decision) and testing `!== false` guarantees byte-identical defaults (NFR-TLT-001) — an unset/`true` value cannot perturb the assembled catalog.
- **Empty catalog is a permitted degraded state, not E7.** The umbrella path is deliberately distinct from profile tool-scoping's empty-survivor error; a one-line stderr notice replaces an exception.

**As-built surface.** Shipped under Plan 008 — `src/config/agent-config.ts` (`resolveToolGroupToggle`, extended `resolveAgentTools`, `composites`/`builtinTools` on `AgentCliFlags`/`AgentConfigFile`/`AgentConfig`, the two new `CLI_AGENT_DISABLE_*` env keys), `src/config/profile-schema.ts` (`tools.composites`/`builtin`/`agentTools`), `src/agent/tools/registry.ts` (the `buildToolCatalog` gate + empty-catalog notice), `src/cli.ts` (the four new flags + flag mapping). Tests: `src/agent/tools/registry-toggles.spec.ts` (gate behaviour, independence, empty-catalog notice) plus extensions to `src/config/agent-config.spec.ts` (precedence) and `src/config/profile-schema.spec.ts` (schema). The `--help` baseline (`test_scripts/baselines/help-no-treat-as-tool.txt`) was re-recorded for exactly the four new flag rows.

---

## §17. Tool-Loading-Aware System Prompt (plan-009)

**Date:** 2026-06-14 · **Based-on commit:** `c546d3891d273d3afdcf6271f6257cba3ce9022b`

**Plan reference:** `docs/design/plan-009-systemprompt-toggle-aware.md`. (Functional requirements registered as FR-SPT-001..005 / NFR-SPT-001 in `docs/design/project-functions.md`; full user-facing behaviour in `docs/tools/cli-agent.md` → "System Prompt Selection" and the configuration-guide system-prompt + `builtinTools` sections.)

**The gap it closes.** Plan-008 gated the then-current bound tool SCHEMAS (`--no-builtin-tools` removed the built-in toolkit) but NOT the system-prompt PROSE: the built-in tool instructions were hard-coded into `BUILTIN_DEFAULT_SYSTEM_PROMPT`, which `buildSystemPrompt` loaded verbatim. So with `--no-builtin-tools` the model was still TOLD about tools it could not call. Plan-009 makes those instructions a runtime conditional block gated on `cfg.builtinTools`, exactly like the existing `agt_*` block. Plan-011/012 later moved web and file prose out of this built-in block.

**Design — mirror the existing conditional-block pattern.** The `agt_*` block and the wrapped-CLI capabilities section are already runtime-injected conditional blocks; the built-in toolkit now follows suit.

- **Slim base.** `BUILTIN_DEFAULT_SYSTEM_PROMPT` is reduced to the generic, tool-agnostic agent identity + truly-generic conduct (concise responses; never echo raw credentials). No `bash_run`/`file_*`/`web_*`/`tool_help`/`--allow-mutations` specifics.
- **`BUILTIN_TOOLS_PROMPT_BLOCK`** — a self-framed string (leading `\n\n`) carrying the moved content as a standalone `## Built-in tools` section: the `bash_run` framing, the tool-specific CORE RULES, the OUT-OF-SCOPE bullets, and the three-general-purpose-tools paragraph. `buildBuiltinToolsPromptBlock(builtinTools)` returns it when `builtinTools !== false`, else `''`.
- **Composition.** `buildSystemPrompt(baseText, capabilitiesSection, customSystemText?, agentToolsMeta?, builtinTools = true)` injects the built-in block AFTER `baseText` and BEFORE `capabilitiesSection`. New order: **base → built-in block (if on) → capabilities → agent-tools block → custom.** `buildSystemPromptForCfg` adds `builtinTools: boolean` to its `cfg` param type and forwards it (`AgentConfig.builtinTools` already exists from plan-008; the production callers in `src/agent/run.ts` and `src/tui/slash/*` pass full `AgentConfig` objects, so no call-site changes were required).

**In-place migration (`bootstrapAgentDir`).** Because the default was restructured, an unmodified seeded prompt is upgraded in place. `LEGACY_DEFAULT_SYSTEM_PROMPTS: readonly string[]` holds prior verbatim defaults (index 0 = the pre-plan-009 default; byte-identical to what earlier builds seeded). When `system-prompt.md` already exists and its bytes equal ANY entry in `LEGACY_DEFAULT_SYSTEM_PROMPTS`, bootstrap overwrites it with the new slim default (mode `0600`); if it differs at all, it is left untouched. Wrapped in try/catch — the upgrade never throws. This is NOT a runtime fallback: a missing/unreadable SELECTED prompt still raises `UsageError` at load time (the no-fallback rule is preserved).

**Customized-base behaviour (documented).** The block is injected on top of whatever base is on disk (same as the `agt_*` block). For the slim default (or a migrated default) there is no duplication; a user-customized base that still contains old tool prose owns that prose — the toggle cannot strip it, so it may appear twice when the built-in tools are loaded.

**Key design decisions.**
- **Conditional block + slim default (mirrors `agt_*`); invent no new pattern.** The built-in tool prose moves out of the base and into a runtime block gated on the same toggle that gates the schemas, so the prompt always matches the loaded toolset.
- **Deliberate baseline re-record.** The split need not be byte-identical to the old default; the slim base + block were authored to read cleanly. `system-prompt.spec.ts` was re-recorded to the new default + composition.
- **Exact-match migration only.** Upgrading solely on a byte-exact match against `LEGACY_DEFAULT_SYSTEM_PROMPTS` guarantees user edits are never clobbered; the array lets future default revisions be appended.

**Edge case (deferred).** `--no-builtin-tools` removes `bash_run`, so the wrapped-CLI capabilities section's "available via bash_run" framing is moot in that (self-defeating) combination. Left as-is; tracked as a minor follow-up (FR-SPT "Known minor follow-up").

**As-built surface.** Shipped under Plan 009 — `src/agent/system-prompt.ts` (`LEGACY_DEFAULT_SYSTEM_PROMPTS`, slim `BUILTIN_DEFAULT_SYSTEM_PROMPT`, `BUILTIN_TOOLS_PROMPT_BLOCK`, `buildBuiltinToolsPromptBlock`, extended `buildSystemPrompt`/`buildSystemPromptForCfg`), `src/config/agent-config.ts` (the in-place `bootstrapAgentDir` upgrade + `LEGACY_DEFAULT_SYSTEM_PROMPTS` import). Tests: re-recorded `src/agent/system-prompt.spec.ts` (slim default + gated block + composition order) and new migration tests in `src/config/agent-config.spec.ts` (upgrade unmodified default / leave user-modified / leave already-slim). No new dependency.

> **Superseded in part by Plan 010 (§18) and Plan 012 (§20).** The static `BUILTIN_TOOLS_PROMPT_BLOCK` constant and the `buildBuiltinToolsPromptBlock(builtinTools: boolean)` / `buildSystemPrompt(..., builtinTools = true)` signatures described above were the Plan-009 shape. Plan 010 replaced the static block with an adaptive one assembled from a presence object, removed `BUILTIN_TOOLS_PROMPT_BLOCK`, and added a 4th `registeredTools` parameter to `buildSystemPromptForCfg` (so all production call sites pass the in-scope `tools` array). Plan 012 then removed the mutating-file presence from that object when file operations moved to `agt_file_*`. The slim base prompt and the migration logic are unchanged. See §18 and §20.

## §18. Adaptive Built-in-Tools Prompt Block (plan-010)

**Date:** 2026-06-14 · **Based-on commit:** `c546d3891d273d3afdcf6271f6257cba3ce9022b`

**Plan reference:** `docs/design/plan-010-builtin-block-adaptive.md`. (Functional requirements registered as FR-SPT-006 in `docs/design/project-functions.md`, with FR-SPT-002/003 amended; full user-facing behaviour in `docs/tools/cli-agent.md` → "Slim base + runtime-injected built-in-tools block" and the configuration-guide system-prompt section.)

**The gap it closes.** Plan-009 gated the WHOLE `## Built-in tools` block on `cfg.builtinTools`, but its prose was STATIC: it always described `bash_run` and, at the time, the mutating-file tools (`file_write`/`file_edit`/`file_append`). Those groups were gated by OTHER session config, so the prompt could over-promise vs the bound schemas. Plan-010 made the block describe the registered built-in tools; plan-012 later removed file tools from the built-in toolkit entirely.

**Design — derive the block from the registered tool NAMES (drift-free).** Every `buildSystemPromptForCfg` call site already has the post-scoping `tools` array from `buildToolCatalog` in scope. It is passed in as a new 4th parameter and presence is derived from the real bound set (which also respects a profile `deny` of a built-in).

- **`BuiltinToolsPresence`** — current shape `{ builtinTools, bashRun }` after plan-012. `buildBuiltinToolsPromptBlock(p)` returns `''` when `!p.builtinTools`; otherwise it assembles the block from composable, gated section constants (`BUILTIN_BLOCK_HEADER`, the bashRun / no-bashRun intros, the bashRun-specific + general CORE RULES, the available-tools list, and the OUT-OF-SCOPE bullets). `BUILTIN_TOOLS_PROMPT_BLOCK` was removed (the block is runtime-only and is NOT seeded to disk, so there is no migration concern).
- **Adaptive content.** bashRun ON ⇒ the `bash_run` command-execution framing + its two confirmation/allowlist CORE RULES + the `bash_run` available-tools clause + the shell-features OUT-OF-SCOPE line. bashRun OFF ⇒ a "no local commands are allow-listed; command execution unavailable" note, the read-only `bash_list_allowed`/`bash_which` clause only, and no shell-features line. File guidance is not part of this block after plan-012; it rides on the `agt_file_*` entries in the agent-tools prompt block. The general CORE RULES and read-only bash/tool-help entries remain present when the built-in toolkit is enabled.
- **Composition.** `buildSystemPrompt`'s 5th parameter is `builtinPresence: BuiltinToolsPresence = { builtinTools: true, bashRun: true }` (default = full current built-in block, backward-compatible for the remaining built-ins). `buildSystemPromptForCfg` takes a 4th parameter `registeredTools: ReadonlyArray<{ name: string }> = []` and computes `{ builtinTools: cfg.builtinTools !== false, bashRun: names.has('bash_run') }`. Injection position is unchanged (after base, before capabilities).

**As-built surface.** Shipped under Plan 010 and amended by Plan 012 — `src/agent/system-prompt.ts` (new `BuiltinToolsPresence` interface, gated section constants, rewritten `buildBuiltinToolsPromptBlock`, presence-object `buildSystemPrompt`, 4th-param `buildSystemPromptForCfg`; `BUILTIN_TOOLS_PROMPT_BLOCK` removed). All production call sites pass the in-scope `tools` array. Plan-012 removed the now-dead `mutatingFile` presence, file-tool prose, and `file_write`/`file_edit`/`file_append` registered-name derivation. The slim base prompt (`BUILTIN_DEFAULT_SYSTEM_PROMPT`), `LEGACY_DEFAULT_SYSTEM_PROMPTS`, and the `bootstrapAgentDir` migration are UNCHANGED. No new dependency.

**Result.** The inspector's "Bound tool schemas" and the system-prompt tool prose now agree for the built-in toolkit across every gate — umbrella toggle, allowlist, `--allow-mutations`, and profile deny.

## §19. Web tools into the agent-tools pack — `agt_web_search` / `agt_web_fetch` (plan-011)

**Date:** 2026-06-14 · **Based-on commit:** `c546d3891d273d3afdcf6271f6257cba3ce9022b`

**Plan reference:** `docs/design/plan-011-web-into-agent-tools.md`. (Functional requirement registered as FR-AGT-WEB-001 in `docs/design/project-functions.md`, with FR-AGT-009 amended; user-facing behaviour in `docs/tools/cli-agent.md` → `<agentToolsPack>` and the configuration-guide agent-tools / tool-loading-toggle sections.)

**The change.** `web_search` / `web_fetch` are removed from the built-in cross-cutting toolkit (`registry.ts` `readOnly`) and re-homed in the agent-tools pack as the first-party tools `agt_web_search` / `agt_web_fetch` — the ONLY non-vendored members of the `agt_` namespace. The existing cli-agent web backend (`src/agent/tools/web/backends/`) is REUSED verbatim; only the two thin tool wrappers (`web/search-tool.ts` → `agent-tools/agt-web-search.ts`, `web/fetch-tool.ts` → `agent-tools/agt-web-fetch.ts`) moved and were renamed.

**Design.**
- **Wrappers.** `buildAgtWebSearchTool({cfg, requestBudget, overlays})` / `buildAgtWebFetchTool({...})` carry the former `createWebSearchTool` / `createWebFetchTool` bodies verbatim, with `name` and `BUILTIN_TOOL_PROMPTS` key changed to `agt_web_*`. They keep `getWebBackend(cfg)`, the budget decrement + `E_SEARCH_BUDGET_EXCEEDED`, `mergeProfileToolArgs`, and `handleToolError`. The canonical description/params live in `BUILTIN_TOOL_PROMPTS['agt_web_search'|'agt_web_fetch']` (copied verbatim from the old `web_*` entries, incl. the "Never fabricate URLs" guidance); the `AGT_WEB_*_DESCRIPTION` constants alias them.
- **Registration / budget.** `group-builder.ts` constructs ONE per-session `requestBudget` from the resolved `cfg.webSearch.maxRequests` value (`WEB_SEARCH_MAX_REQUESTS`, default 50) shared by both tools, and registers them (after grep) under `if (flags.webSearch)` / `if (flags.webFetch)` — read-only, NO `allowMutations` gate. The `tools[i] ↔ meta.registered[i]` lockstep invariant is preserved; the agent-tools prompt block is a pure projection of `registered`, so web documentation rides the existing pack block automatically.
- **Config.** `AgentConfig.agentTools.tools` (+ the file/CLI shapes) gain `webSearch` / `webFetch` (default `true`), resolved via the existing `resolveOne` chain with env keys `CLI_AGENT_AGT_WEB_SEARCH` / `CLI_AGENT_AGT_WEB_FETCH` (added to `OTHER_ENV_KEYS`). Flags `--enable/--disable-agt-web-search` / `-agt-web-fetch` map through `mapAgentToolFlags` and are registered on the agent command in `cli.ts`.
- **Web backend snapshot.** `loadAgentConfig` resolves `WEB_SEARCH_BACKEND`, `TAVILY_API_KEY`, `SERPAPI_API_KEY`, `BRAVE_API_KEY`, `WEB_SEARCH_URL`, `WEB_SEARCH_API_KEY`, and `WEB_SEARCH_MAX_REQUESTS` into `cfg.webSearch`. `src/agent/tools/web/backends/registry.ts`, `agt-web-search.ts`, `agt-web-fetch.ts`, and `group-builder.ts` consume only that snapshot; they must not read `process.env` directly.
- **System prompt.** `buildBuiltinToolsPromptBlock` drops ALL web references (the web available-tools bullet, the "NEVER invent URLs" CORE RULE, and the OUT-OF-SCOPE web line). At plan-011 time the bashRun / mutatingFile gating was otherwise unchanged; plan-012 later removed the file/mutatingFile branch when file operations moved to `agt_file_*`.

**Gating after this change.** `agt_web_search` / `agt_web_fetch` appear iff `cfg.agentTools.enabled` AND the per-tool flag is on; they are read-only (no `--allow-mutations`); `--no-builtin-tools` no longer affects web; profile `tools.deny: [agt_web_search]` works (name-based, no code change).

**As-built surface.** New: `src/agent/tools/agent-tools/agt-web-search.ts`, `agt-web-fetch.ts` (+ relocated specs). Modified: `agent-tools/index.ts`, `agent-tools/group-builder.ts`, `tools/tool-prompts-builtin.ts`, `tools/registry.ts`, `agent/system-prompt.ts`, `config/agent-config.ts`, `cli-agent-tools-flags.ts`, `cli.ts`, the `--help` baseline, and the four docs. Deleted: `web/search-tool.ts`, `web/fetch-tool.ts` (`web/backends/` KEPT). No new dependency.

**Result.** Web is governed uniformly with the rest of the `agt_*` pack (umbrella + per-tool flags + name-based profile scoping), decoupled from `--no-builtin-tools`.

## 2026-06-15 — File operations re-homed into the `agt_` pack (design-012 / plan-012)

**Date:** 2026-06-15 · **Based-on commit:** `c546d3891d273d3afdcf6271f6257cba3ce9022b`

**Provenance chain.** Refined request `docs/reference/refined-request-file-ops-to-agt.md` → codebase scan `docs/reference/codebase-scan-file-ops-to-agt.md` → plan `docs/design/plan-012-file-ops-to-agt.md` (22 steps, units U1–U9) → design `docs/design/design-012-file-ops-to-agt.md`. Structural precedent: `docs/design/plan-011-web-into-agent-tools.md` / `§19` above (the identical move for the web tools). Functional-requirement entry and user-facing behaviour are registered in `docs/design/project-functions.md` and `docs/tools/cli-agent.md` / `docs/design/configuration-guide.md` by plan-012 step 21.

**The decision.** The five native file tools (`file_read`, `file_list`, `file_write`, `file_edit`, `file_append`) are removed from the built-in cross-cutting toolkit (`registry.ts`) and re-homed in the agent-tools pack as first-party wrappers `agt_file_read` / `agt_file_list` / `agt_file_write` / `agt_file_edit` / `agt_file_append`. The wrappers REUSE the existing first-party file logic and the sandbox at `src/agent/tools/file/sandbox.ts` verbatim (no behaviour change to the file logic; only the LangChain-visible name and the `BUILTIN_TOOL_PROMPTS` key change). The deliberately-rejected upstream deps (`@mozilla/readability`, `jsdom`, `turndown`, `dotenv`) are NOT reintroduced; no new runtime dependency is added. This mirrors plan-011 exactly.

**End-state catalog (two independent groups).**
- **Built-in toolkit** (gated by `cfg.builtinTools !== false`): `bash_run` (only when the command allowlist is non-empty), `bash_list_allowed`, `bash_which`, `tool_help`. The `mutatingFile` array and all `createFile*Tool` imports are deleted from `registry.ts`. `tool_help` STAYS here with the bash tools.
- **`agt_` pack** (gated by `cfg.agentTools.enabled` + per-tool flags): `agt_glob`, `agt_grep`, `agt_web_search`, `agt_web_fetch`, `agt_file_read`, `agt_file_list`, `agt_multiedit`, `agt_patch`, `agt_file_write`, `agt_file_edit`, `agt_file_append`, `agt_todo_read`, `agt_todo_write`. Read-only file tools (`agt_file_read`/`agt_file_list`) register ungated; the three mutators (`agt_file_write`/`agt_file_edit`/`agt_file_append`) register only when the per-tool flag is on AND `cfg.allowMutations === true`, matching the former native `mutatingFile` gating and the existing `agt_multiedit`/`agt_patch` rule. The `tools[i] ↔ meta.registered[i]` lockstep invariant in `group-builder.ts` is preserved, so the agent-tools prompt block documents the new tools automatically (pure projection of `registered`).

**Design shape.** Five `src/agent/tools/agent-tools/agt-file-*.ts` wrappers, each exporting `AGT_FILE_<X>_NAME = 'agt_file_<x>'`, `AGT_FILE_<X>_DESCRIPTION = BUILTIN_TOOL_PROMPTS[name]!.description`, `AgtFile<X>Deps = { cfg: AgentConfig; overlays?: OverlayRegistry }`, and `buildAgtFile<X>Tool(deps): DynamicStructuredTool` (the deps bag drops the web tools' `requestBudget` — file tools have no per-session budget; the sandbox enforces per-call byte limits). The factory body is the corresponding `create<X>Tool` body verbatim, with only the tool name, the prompt key, and the `deps`-sourced sandbox/overlay config changed. `BUILTIN_TOOL_PROMPTS` swaps the five `file_*` keys for five `agt_file_*` keys (descriptions + per-param help copied verbatim, incl. `[MUTATING] … Requires confirmed: true`); total entry count stays 17. Config: `AgentConfig.agentTools.tools` (+ the file/CLI shapes) gain `fileRead`/`fileList`/`fileWrite`/`fileEdit`/`fileAppend` (default `true`), resolved via the existing `resolveOne` four-tier chain with env keys `CLI_AGENT_AGT_FILE_READ/LIST/WRITE/EDIT/APPEND` (added to the agt env-key list/`ALL_ENV_KEYS` and the `resolveOne` union). CLI: ten `--enable/--disable-agt-file-*` flags mapped through `mapAgentToolFlags` (`ToolKey` + `pairs` extended). System prompt: `BuiltinToolsPresence` drops the now-dead `mutatingFile` field and its `names.has('file_write'|'file_edit'|'file_append')` derivation in `buildSystemPromptForCfg`; the built-in block (`buildBuiltinToolsPromptBlock`) no longer mentions file tools (param type becomes `{ builtinTools, bashRun }`). `LEGACY_DEFAULT_SYSTEM_PROMPTS` is FROZEN and untouched.

**Breaking change (user-visible).** The tool RENAMES are user-visible: profiles referencing `file_read` / `file_list` / `file_write` / `file_edit` / `file_append` in `tools.allow` / `tools.deny` / `tools.order` / `toolArgs`, and any user overlay keyed on the old names, must be updated to the `agt_file_*` names — there is NO automatic migration. Additionally, `--no-builtin-tools` no longer removes file operations (it now leaves only `bash_run` + `bash_list_allowed` + `bash_which` + `tool_help`); file ops are governed by `--no-agent-tools` / `--disable-agt-file-*`. Effective default behaviour is otherwise preserved: with defaults and no `--allow-mutations`, `agt_file_read` + `agt_file_list` load and the three mutators do not; with `--allow-mutations` the mutators appear — identical net behaviour to before the move.

**As-built surface (planned).** New: `src/agent/tools/agent-tools/agt-file-read.ts`, `agt-file-list.ts`, `agt-file-write.ts`, `agt-file-edit.ts`, `agt-file-append.ts` (+ five new `agt-file-*.spec.ts` — the first unit-level coverage for the file logic). Modified: `agent-tools/index.ts`, `agent-tools/group-builder.ts`, `tools/tool-prompts-builtin.ts`, `tools/registry.ts`, `agent/system-prompt.ts`, `config/agent-config.ts`, `cli-agent-tools-flags.ts`, `cli.ts`, the `--help` baseline (`test_scripts/baselines/help-no-treat-as-tool.txt` + `.sha256`), the affected specs, and the four docs. Deleted: `src/agent/tools/file/{read,list,write,edit,append}-tool.ts` (`file/sandbox.ts` + `sandbox.spec.ts` KEPT). No new dependency.

**Result.** File operations are governed uniformly with the rest of the `agt_*` pack (umbrella + per-tool flags + name-based profile scoping), decoupled from `--no-builtin-tools`; the built-in toolkit is reduced to bash support plus `tool_help`.

## 2026-06-15 — Toolless-session fabrication guard (system-prompt)

**Date:** 2026-06-15 · **Module:** `src/agent/system-prompt.ts`

**Problem.** With every tool group disabled (`--no-builtin-tools --no-agent-tools --no-composites`, the sanctioned "plain conversational LLM" state from §16), `buildToolCatalog` returns an empty `tools` array and the built-in + agent-tools prompt blocks both render `''`. The assembled prompt collapsed to the slim base identity alone (which still says the agent "accomplishes tasks by invoking external CLI tools"), with no tools bound and no instruction telling the model it is toolless. All anti-fabrication guidance had lived inside the now-empty tool blocks. The model therefore role-played a tool-user and **fabricated tool output** (observed: a hallucinated directory listing for "list files", with zero tool calls in the captured I/O). The catalog's empty-toolset warning existed only on stderr (to the user), never in the prompt (to the model).

**Decision.** Mirror that empty-toolset signal into the prompt. `buildSystemPrompt` gains a `noToolsAvailable` flag (default `false`) that, when set, injects a self-framed `NO_TOOLS_BLOCK` immediately after the base identity: it states the agent has no way to act this session and explicitly forbids fabricating/guessing/role-playing command output, directory listings, file contents, or URLs, and points the user at the flags to re-enable tools. `buildSystemPromptForCfg` computes `noToolsAvailable = registeredTools.length === 0` (the post-scoping catalog it already receives), so the guard fires for any zero-tool session — all-groups-off OR a profile that scopes the catalog to nothing — and never when ≥1 tool is registered. No CLI/config surface changes; `LEGACY_DEFAULT_SYSTEM_PROMPTS` untouched.

**As-built.** `NO_TOOLS_BLOCK` constant + `noToolsAvailable` param in `buildSystemPrompt`; `registeredTools.length === 0` computation in `buildSystemPromptForCfg`. Coverage: 5 new `system-prompt.spec.ts` tests + `test_scripts/verify-no-tools-notice.ts` (E2E repro). Follow-up (logged in `Issues - Pending Items.md`, LOW): an always-present anti-fabrication CORE RULE to also cover *partial*-toolset gaps.

## 2026-06-15 — Release / CI hardening (plan-014)

**Provenance chain.** Refined request `docs/reference/refined-request-release-ci-hardening.md` -> plan `docs/design/plan-014-release-ci-hardening.md`. Investigation and technical research skipped because the project already uses npm, TypeScript, Vitest, and `npm audit`; no new dependency or approach choice was introduced.

**Problem.** The package release gate only ran `clean`, `build`, and `test`. There was no `lint` script, no audit gate, and no validation of the actual npm publish payload. A dry-run pack also showed stale compiled spec files could remain in `dist/` and be included by the broad `"files": ["dist", ...]` package rule.

**Decision.**
- `npm run lint` is added as strict TypeScript static validation (`tsc --noEmit -p tsconfig.json --pretty false`) without adding lint dependencies.
- `npm run build` now starts with `clean`, uses `tsconfig.build.json`, and excludes spec/test TypeScript plus source JSON that is not needed at runtime.
- `scripts/copy-vendored-assets.mjs` now copies only vendored upstream `*.prompt.md` runtime assets, instead of every `.md` / `.txt` / `.json` under `src/`.
- `npm run release:audit` runs `npm audit --audit-level=high`.
- `npm run release:package` runs `scripts/check-package-content.mjs`, which parses `npm pack --dry-run --json` and checks the actual publish payload for required files and forbidden source/test/support artifacts.
- `prepublishOnly` runs `lint`, `typecheck`, `build`, `test`, `release:audit`, and `release:package` in sequence, so any failed gate blocks publish. `build` owns the clean `dist/` step and intentionally precedes `test` because the CLI help baseline tests execute `dist/cli.js`.

**As-built surface.** Modified `package.json`, `scripts/copy-vendored-assets.mjs`, `README.md`, `docs/design/project-functions.md`, and this design file. Added `tsconfig.build.json`, `scripts/check-package-content.mjs`, and `docs/design/plan-014-release-ci-hardening.md`. No package dependency was added.

---

## 2026-07-04 — CLI Mode Simplification: the `--mode` knob (plan-015)

**Provenance chain.** Refined request `docs/reference/refined-request-cli-mode-simplification.md` (three Open Questions resolved by the user: hard removal of the legacy flags AND the legacy env/config/profile group keys; four modes only) → codebase scan `docs/reference/codebase-scan-cli-mode-simplification.md` → plan `docs/design/plan-015-cli-mode-simplification.md`. Investigation and technical research skipped: the approach was fully settled in the refined request's established design context (Commander flag surface, the existing pinnable-knob resolver pattern, the `/allow-mutations` slash-command pattern). Supersedes §16 (plan-008). FRs registered as FR-MODE-1..6 / FR-TOOLFLAG-1..3 / FR-DEPREC-1 / NFR-MODE-1..2 in `docs/design/project-functions.md`; the FR-TLT-* entries are retired with pointers.

**Problem.** Tool loading was controlled by ~15 configuration surfaces: three group-toggle flag pairs (6 flags), 26 per-tool `--enable-agt-*`/`--disable-agt-*` flags, three inverted-disable env vars, three `config.json` keys, and three profile keys — and the group-toggle chain put `config.json` ABOVE the profile while every pinnable knob put the profile above `config.json` (the precedence asymmetry recorded in "Issues - Pending Items.md").

**Decision.**
- **One mode enum, four values.** `--mode <chat|basic|tool|composite>` expands into the unchanged internal group booleans via `modeToGroups` (`src/config/mode.ts`): chat = none, basic = agt_* pack only, tool = builtin + agt_*, composite = all three. Default `composite` — a flagless invocation is behavior-identical to the pre-plan-015 all-groups-on default. `deriveModeFromGroups` is an exact inverse because the mode mapping is now the only producer of the triple; NO `mode` field was added to `AgentConfig` (avoiding the 23+ spec-fixture ripple the scan warned about).
- **Pinnable resolution.** CLI `--mode` (UsageError on bad value) > env `CLI_AGENT_MODE` > profile `cliParams.mode` (Zod enum) > `config.json` `mode` > default `composite`; invalid env/config values raise `ConfigurationError` — no fallback (`resolveMode`, `src/config/agent-config.ts`). This kills the precedence asymmetry: the profile tier now has one position for every knob.
- **Hard removal with fail-fast migration errors.** The 32 legacy flags are unregistered; an argv pre-scan (`src/cli-removed-flags.ts`) runs BEFORE `program.parseAsync` and throws `UsageError` (exit 2) with a shared `MODE_MIGRATION_HINT` — Commander's own unknown-option path exits 1 without a hint, hence the pre-scan. A SET legacy env var (any value), a PRESENT legacy `config.json` key, or a PRESENT legacy profile `tools.*` key raises `ConfigurationError` with the hint (the profile codec pre-checks the raw object so the user sees an actionable message instead of a generic Zod "unrecognized key" error). The three `CLI_AGENT_DISABLE_*` keys stay in `OTHER_ENV_KEYS` solely so the layered snapshot can SEE and reject them.
- **Generic per-tool pair.** `--enable-tool <name>` / `--disable-tool <name>` (repeatable, canonical `agt_*` names, unknown-name and both-flags conflicts fail fast) replaces the 26 per-tool flags; the `CLI_AGENT_AGT_*` env vars and `agentTools.tools.*` config keys are untouched, as is mutation gating.
- **`--tool` × chat/basic fails fast.** Wrapped CLIs execute through `bash_run`, absent below `tool` mode; the check runs in `loadAgentConfig` on the effective mode and the merged tools list, so env/profile/config-sourced modes and config-sourced tools are caught too (FR-MODE-5).
- **TUI parity.** `/mode` shows or switches the mode and rebuilds the catalog in place (`src/tui/slash/mode.ts`, mirroring `/allow-mutations`), rejecting chat/basic while wrapped CLIs are loaded.
- **Accepted consequence.** Group-level "shell-only" (builtin ON, agt_* OFF) is no longer expressible; the nearest equivalent is `--mode tool` plus per-tool `--disable-tool` entries (or persisted `agentTools.tools.*` keys).

**As-built surface.** Added `src/config/mode.ts`, `src/cli-removed-flags.ts`, `src/tui/slash/mode.ts`, and specs `src/config/agent-config-mode.spec.ts`, `src/cli-agent-tools-flags.spec.ts`, `src/cli-removed-flags.spec.ts`, `src/tui/slash/mode.spec.ts`. Modified `src/config/agent-config.ts` (resolveMode; mode→groups expansion; legacy rejection; `--tool` conflict; `resolveToolGroupToggle` deleted; `resolveAgentTools` umbrella branch replaced by a passed-in boolean), `src/cli-agent-tools-flags.ts` (generic mapper + exported canonical-name map), `src/cli.ts` (32 options removed, 3 added, pre-scan wired with a `CliAgentError`-aware catch), `src/config/profile-schema.ts` (+`cliParams.mode`, −`tools.*` group keys) and `profile-codec.ts` (legacy-key pre-check), `src/commands/profile/dry-run.ts` (mode knob row), `src/agent/system-prompt.ts` (`NO_TOOLS_BLOCK` now directs at `--mode`), `src/tui/index.ts`, plus spec updates (`agent-config.spec.ts`, `profile-schema/codec.spec.ts`, `cli.spec.ts`, `system-prompt.spec.ts`, `dry-run.spec.ts`) and `test_scripts/verify-no-tools-notice.ts` (now exercises `--mode chat`). The `--help` byte baseline + `.sha256` were consciously re-recorded (NFR-CMP-001). Out-of-scope consumers (`buildToolCatalog`, `buildAgentToolsGroup`, composite subsystem) are untouched. Docs: `docs/tools/cli-agent.md`, `docs/design/configuration-guide.md`, `docs/guides/agent-competency-levels.md`, `docs/guides/enabling-write-capabilities.md`, `README.md` present the mode surface as primary.

---

## 2026-07-04 — Bash fail-open: unconfigured allowlist is UNRESTRICTED (user-directed)

**Provenance.** Direct user instruction ("make it accept all the bash commands if the bash-allow is undefined"). No refinement/scan phase — the request was fully specified and the touchpoints were already mapped from the plan-015 work. Recorded in the project memory note `bash-allowlist-fail-open` because it reverses a documented security invariant.

**Problem / decision.** Previously an empty bash allowlist was fail-CLOSED: `bash_run` was not even registered (`registry.ts` required `allowlistEntries.length > 0`), the matcher denied everything, and the permission bridge returned `allow:false` with reason "fail-closed". The user wants the opposite: when NO allowlist is configured anywhere (no `--bash-allow`/`--bash-allow-file`/`BASH_ALLOWED_COMMANDS`/`config.json` `bash.allow`, and no wrapped `--tool`), `bash_run` accepts **every** command on `PATH`. The moment ANY entry exists, restrictive OR'd matching resumes exactly as before.

**Where it lands (code).**
- `src/agent/tools/bash/allowlist.ts` — `buildAllowlistMatcher().test()` returns `true` when `entries.length === 0` (unrestricted); `isEmpty()` still reports the unconfigured state so callers can surface it.
- `src/agent/tools/registry.ts` — `bash_run` is bound whenever the built-in group is on (dropped the `allowlistEntries.length > 0` guard); one stderr notice is emitted on the empty-allowlist case.
- `src/agent/tools/agent-tools/permissions.ts` — `evaluateBash` removed the `matcher.isEmpty()` fail-closed branch (an empty matcher now allows via `matcher.test`); empty/whitespace commands are still rejected.
- `src/agent/tools/bash/run-tool.ts` — description gains an unrestricted clause ("No allowlist is configured … ANY binary on PATH may be called — be conservative").
- `src/agent/tools/bash/list-allowed-tool.ts` — result gains `unrestricted` + a `note` when the allowlist is empty.
- `src/agent/system-prompt.ts` — `BuiltinToolsPresence` gains `bashUnrestricted`; a new UNRESTRICTED bash_run intro + CORE RULES variant (with restraint guidance) is selected when `bash_run` is bound and no allowlist is configured; `buildSystemPromptForCfg` derives the flag from `cfg.bash.allow.length === 0`.

**Unchanged guardrails (both modes).** `--allow-mutations` still independently gates mutating file tools and the `[MUTATING]`/`[READ-ONLY-AGENT]` posture; the `cwd` sandbox (`bash.allowedRoots`), `execFile` semantics, env stripping, timeout, and output caps all still apply. FR-AGT-017 amended accordingly.

**As-built surface.** The six source files above plus spec updates (`allowlist.spec.ts`, `registry.spec.ts` — `STANDARD_READONLY_NAMES` now includes `bash_run`, the gating describe flipped to binding + notice assertions, `permissions.spec.ts` — empty allowlist now asserts allow-all). Docs: `docs/design/configuration-guide.md` (bash allowlist section warning), `docs/tools/cli-agent.md` (adaptive-block + permission-bridge prose), `docs/guides/enabling-write-capabilities.md` (Switch 2 + combos), `docs/design/project-functions.md` (FR-AGT-017). Full suite green (1199 tests) and an end-to-end check confirmed `bash_run` executes an un-allowlisted binary with no allowlist configured.
