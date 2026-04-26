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
