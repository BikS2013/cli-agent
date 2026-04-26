# Plan 001 — cli-agent: Generic LangGraph ReAct Agent

**Status:** In Progress  
**Created:** 2026-04-26  
**Policy:** Policy A (shell-wins, default)  
**Default provider seeded into config.json:** `azure-openai`

---

## 1. Project overview

`cli-agent` is a standalone LangGraph ReAct agent binary that dynamically wraps any set of
external CLI tools declared at launch via `--tool <name>` flags or the `tools[]` array in
`config.json`. This is an inversion of the standard spec pattern: there is no pre-existing host
CLI to agentify — the agent IS the CLI.

Each declared tool binary is:
1. Auto-added to the bash allowlist.
2. Introspected via recursive `--help` calls (capability discovery).
3. Summarised into a Markdown capability document cached under
   `~/.tool-agents/cli-agent/capabilities/<tool>.md`.
4. Embedded in the system prompt so the LLM can generate correct invocations.

---

## 2. Provider set (8 providers)

| Provider id       | LangChain class             | Required env                                               |
|---|---|---|
| `openai`          | `ChatOpenAI`                | `OPENAI_API_KEY`                                           |
| `anthropic`       | `ChatAnthropic`             | `ANTHROPIC_API_KEY`                                        |
| `gemini`          | `ChatGoogleGenerativeAI`    | `GOOGLE_API_KEY` (alias: `GEMINI_API_KEY`)                 |
| `azure-openai`    | `AzureChatOpenAI`           | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` |
| `azure-anthropic` | `ChatAnthropic` w/ Foundry  | `AZURE_AI_INFERENCE_KEY`, `AZURE_AI_INFERENCE_ENDPOINT`    |
| `ollama`          | `ChatOpenAI` w/ baseURL     | `OLLAMA_HOST`                                              |
| `litellm`         | `ChatOpenAI` w/ proxy       | `LITELLM_PROXY_URL`, `LITELLM_MASTER_KEY`                  |
| `mlx`             | `ChatOpenAI` w/ baseURL     | `OPENAI_BASE_URL`                                          |

---

## 3. Configuration folder layout

```
~/.tool-agents/cli-agent/
  config.json               # non-secret defaults (provider, model, tools[], capabilities.*, etc.)
  .env                      # secrets; mode 0600
  logs/                     # JSONL session logs; dir mode 0700, files mode 0600
    session-<utc>-<id>.jsonl
    latest.jsonl            # symlink to most recent
  capabilities/             # per-tool Markdown capability docs
    <tool>.md
```

Sample `config.json`:
```json
{
  "schemaVersion": 1,
  "provider": "azure-openai",
  "model": "",
  "maxSteps": 25,
  "tools": [],
  "capabilities": {
    "depth": 2,
    "maxBytesPerTool": 10240,
    "timeoutMs": 5000,
    "totalTimeoutMs": 60000
  },
  "bash": {
    "allow": [],
    "allowedRoots": [],
    "passEnv": ["PATH", "HOME", "LANG", "TERM"],
    "timeoutMs": 30000,
    "maxOutputBytes": 1048576
  },
  "webSearch": {
    "backend": "tavily"
  },
  "fileEdit": {
    "root": "",
    "allowPaths": []
  }
}
```

---

## 4. Precedence policy: Policy A (shell-wins)

```
CLI flag  >  shell env var (standard name)  >  ~/.tool-agents/cli-agent/.env  >  ~/.tool-agents/cli-agent/config.json  >  throw ConfigurationError
```

Implementation: layered merge — shell env is Layer 1 (baseline), tool `.env` is Layer 2 (fills
gaps), local `.env` is Layer 3, CLI flags are Layer 4 (top priority).

---

## 5. Command inventory

This agent has no wrapped CLI commands in the conventional sense. The LLM-visible tool catalog is:

**Standard cross-cutting tools (read-only unless `--allow-mutations`):**
- `file_read`, `file_list` — read-only file tools
- `file_write`, `file_edit`, `file_append` — [MUTATING]; off without `--allow-mutations`
- `web_search`, `web_fetch` — read-only web tools
- `bash_list_allowed`, `bash_which` — read-only bash inspection
- `bash_run` — [MUTATING by standard; READ-ONLY-AGENT mode deviation applies] — visible when allowlist is non-empty; description warns in read-only mode

**New domain tool:**
- `tool_help` — read-only; fetch per-tool capability doc or subcommand section on demand

**Deviation from standard mutation gate for `bash_run`:**
The standard gate (`bash_run` off without `--allow-mutations`) is relaxed for cli-agent.
Rationale: the agent's entire purpose is to drive external CLI tools via bash. Without `bash_run`
being visible, the agent cannot do anything useful. When `--allow-mutations` is OFF,
`bash_run` ships in the catalog with a "[READ-ONLY-AGENT]" description prefix warning the LLM
to prefer read commands. When `--allow-mutations` is ON, the prefix is removed.
This deviation is documented in `docs/design/configuration-guide.md` and in the Issues file.

**CLI subcommands:**
- `cli-agent [prompt]` — one-shot or interactive (with `-i`)
- `cli-agent show-capabilities --tool <name>` — print cached capability doc
- `cli-agent refresh-capabilities [--tool <name>]` — re-run discovery

---

## 6. Module file layout

```
src/
  cli.ts                               # argv parser + dispatch
  errors.ts                            # ConfigurationError, UsageError, UpstreamError, etc.
  util/
    redact.ts                          # redactString utility
  config/
    agent-config.ts                    # loadAgentConfig(), bootstrapAgentDir()
  agent/
    system-prompt.ts                   # buildSystemPrompt()
    logging.ts                         # createLogger(), Logger, LogEvent types
    graph.ts                           # buildAgentGraph(), runOneShot(), streamAgent()
    run.ts                             # runOneShotAgent(), runInteractiveAgent()
    providers/
      types.ts                         # BaseChatModel re-export, ProviderFactory type
      util.ts                          # normalizeFoundryEndpoint()
      openai.ts
      anthropic.ts
      gemini.ts
      azure-openai.ts
      azure-anthropic.ts
      ollama.ts
      litellm.ts
      mlx.ts
      registry.ts                      # REGISTRY, createLLM()
    tools/
      types.ts                         # handleToolError(), truncateToolResult()
      file/
        sandbox.ts                     # path resolution + allowlist enforcement
        read-tool.ts
        list-tool.ts
        write-tool.ts
        edit-tool.ts
        append-tool.ts
      web/
        search-tool.ts
        fetch-tool.ts
        backends/
          tavily.ts
          serpapi.ts
          brave.ts
          duckduckgo.ts
          custom-http.ts
          registry.ts
      bash/
        allowlist.ts                   # allowlist parser + matcher
        exec.ts                        # execFile-only spawn wrapper
        run-tool.ts
        list-allowed-tool.ts
        which-tool.ts
      tool-help-tool.ts                # tool_help LangChain tool
      registry.ts                      # buildToolCatalog()
    capabilities/
      discover.ts                      # orchestrator
      runHelp.ts                       # --help invoker
      extractSubcommands.ts            # LLM-based subcommand extractor
      composeMarkdown.ts               # assemble YAML frontmatter + body
      cache.ts                         # read/write per-tool file
      invalidate.ts                    # cache-hit check logic
      compose-system-prompt.ts         # embed capability docs in system prompt
  commands/
    agent.ts                           # main agent subcommand
    show-capabilities.ts
    refresh-capabilities.ts

test_scripts/                          # integration test scripts (placeholder)
  README.md

docs/
  design/
    plan-001-agent-subcommand.md       # this file
    project-design.md
    project-functions.md
    configuration-guide.md
  reference/
    .env.example
    config.json.example
  tools/
    cli-agent.md                       # already authored
```

---

## 7. Phased build plan

### Unit 1 — Scaffolding (serial, first)
- `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- `src/errors.ts`, `src/util/redact.ts`
- Gate: `tsc --noEmit` passes

### Units 2–5 (parallel after Unit 1)

**Unit 2 — Config loader**
- `src/config/agent-config.ts`
- Bootstrap agent dir + capabilities dir on first run
- Policy A: shell wins; dotenv fills gaps with `override: false` semantics
- Merges `tools[]` from CLI flags additive with `config.json` tools array

**Unit 3 — Provider registry**
- 8 factories + `registry.ts` + `util.ts`

**Unit 4 — Tool adapters + Capability Discovery**
- Standard cross-cutting tools (file, web, bash)
- `tool_help` tool
- Capability discovery unit under `src/agent/capabilities/`
- `bash_run` in READ-ONLY-AGENT mode when allowlist non-empty but `!allowMutations`

**Unit 5 — Agent core**
- `system-prompt.ts`, `logging.ts`, `graph.ts`, `run.ts`

### Unit 6 — CLI wiring + docs (serial, last)
- `src/cli.ts`, `src/commands/agent.ts`, `src/commands/show-capabilities.ts`, `src/commands/refresh-capabilities.ts`
- Documentation files

---

## 8. Test file list

- `src/config/agent-config.spec.ts`
- `src/agent/providers/registry.spec.ts`
- `src/agent/providers/util.spec.ts`
- `src/agent/tools/types.spec.ts` (truncateToolResult, handleToolError)
- `src/agent/tools/file/sandbox.spec.ts`
- `src/agent/tools/bash/allowlist.spec.ts`
- `src/agent/logging.spec.ts`
- `src/agent/graph.spec.ts`
- `src/agent/capabilities/cache.spec.ts`
- `src/agent/capabilities/extract.spec.ts`
- `src/commands/agent.spec.ts`
- `src/commands/show-capabilities.spec.ts`

---

## 9. Documentation checklist

- [x] `docs/design/plan-001-agent-subcommand.md` — this file
- [x] `docs/design/project-design.md`
- [x] `docs/design/project-functions.md`
- [x] `docs/design/configuration-guide.md`
- [x] `docs/reference/.env.example`
- [x] `docs/reference/config.json.example`
- [x] `README.md`
- [x] `Issues - Pending Items.md`
