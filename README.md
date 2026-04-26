# cli-agent

Generic LangGraph ReAct agent that wraps external CLI binaries, auto-introspects their
`--help` trees to build capability documents, and exposes the full bash/file/web
cross-cutting toolkit backed by all eight standard LLM providers.

## Quick start

```bash
# Install globally
npm install -g .

# Export your LLM credentials (example: Azure OpenAI)
export AZURE_OPENAI_API_KEY="..."
export AZURE_OPENAI_ENDPOINT="https://my-resource.openai.azure.com"
export AZURE_OPENAI_DEPLOYMENT="gpt-4o"
export AZURE_OPENAI_API_VERSION="2024-02-01"

# One-shot prompt wrapping the gh CLI
cli-agent --provider azure-openai --tool gh "List open PRs in the current repo"
```

On first run, cli-agent creates `~/.tool-agents/cli-agent/` with mode 0700 and seeds a
placeholder `.env` at mode 0600.

## Worked examples

### Example 1 — Azure OpenAI, one-shot

```bash
export AZURE_OPENAI_API_KEY="..."
export AZURE_OPENAI_ENDPOINT="https://my-resource.openai.azure.com"
export AZURE_OPENAI_DEPLOYMENT="gpt-4o"
export AZURE_OPENAI_API_VERSION="2024-02-01"

cli-agent --provider azure-openai --tool git --tool gh \
  "Show me all commits merged to main in the last 7 days"
```

### Example 2 — Interactive session with git and gh

```bash
cli-agent --interactive --tool git --tool gh -p azure-openai
# Enters a REPL. Type /exit to quit, /reset to start a fresh conversation.
```

### Example 3 — Local Ollama server

```bash
export OLLAMA_HOST="http://localhost:11434"

cli-agent --provider ollama --model llama3.2 --tool kubectl \
  "What pods are failing in the production namespace?"
```

## Subcommands

```
cli-agent [prompt]                 # one-shot or --interactive REPL
cli-agent show-capabilities --tool <name>    # print cached capability doc
cli-agent refresh-capabilities [--tool <name>]   # re-introspect tools
```

## Configuration

See `docs/design/configuration-guide.md` for the full reference.

Precedence (Policy A — shell-wins):
```
CLI flag > shell env var > ~/.tool-agents/cli-agent/.env > config.json > throw
```

## Security notes

- The bash allowlist is empty by default. Every binary must be explicitly permitted via
  `--tool <name>`, `--bash-allow`, or `config.json: bash.allow[]`.
- Mutating file operations (`file_write`, `file_edit`, `file_append`) require `--allow-mutations`.
- `bash_run` is visible when the allowlist is non-empty (even without `--allow-mutations`)
  because the agent's purpose is to invoke CLI tools. Without `--allow-mutations`, a
  `[READ-ONLY-AGENT]` warning is embedded in the tool description.
- All log output is redacted via `redactString` before being written to disk.

## Providers

| Provider id       | Required env vars |
|---|---|
| `openai`          | `OPENAI_API_KEY` |
| `anthropic`       | `ANTHROPIC_API_KEY` |
| `gemini`          | `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) |
| `azure-openai`    | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` |
| `azure-anthropic` | `AZURE_AI_INFERENCE_KEY`, `AZURE_AI_INFERENCE_ENDPOINT` |
| `ollama`          | `OLLAMA_HOST` |
| `litellm`         | `LITELLM_PROXY_URL`, `LITELLM_MASTER_KEY` |
| `mlx`             | `OPENAI_BASE_URL` |

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Unexpected error |
| 2 | Usage error (bad flag, missing prompt) |
| 3 | Configuration error (missing required env var) |
| 4 | Auth error |
| 5 | Upstream / provider error |
| 6 | IO error |
| 130 | SIGINT during interactive session |

## TUI

Bare `cli-agent` invocation drops into a raw-mode terminal UI with token-by-token
streaming, an animated spinner, in-flight tool-call indicators, ESC-to-abort,
multiline input editing, input history, and a 15-command slash catalogue.

```
$ cli-agent
cli-agent TUI (LangGraph)
LLM: azure-openai / gpt-5.4
Logs: ~/.tool-agents/cli-agent/logs/session-2026-04-26T20-06-37-…jsonl
Session: 7c3a502b
Commands: /help /history /memory /new /last /quit  (try /help for the full list)
Shift+Enter or Ctrl+J for newline; Enter to send; ESC during a turn aborts.

You> what is the active git branch?
⠋ Thinking...
Agent
  ↳ calling bash_run(...) ✓ (38ms)
The active git branch is `master`.

You> /quit
[system] goodbye.
```

### Slash command catalogue

| Group | Commands |
|---|---|
| Core | `/help`, `/quit` (`/exit`), `/new` (`/reset`), `/clear` |
| History & memory | `/history`, `/last` (`/raw`), `/copy`, `/memory` |
| Runtime switching | `/model [<id>]`, `/provider [<name>]`, `/tools <add\|remove\|list> [name] [--save]`, `/allow-mutations on\|off` |
| Capability inspection | `/capabilities`, `/refresh-capabilities [<tool>]`, `/tool-help <tool> [<sub>]` |

### Modes at a glance

| Invocation | Mode |
|---|---|
| `cli-agent` (no args) | Raw-mode TUI |
| `cli-agent "prompt"` | Streaming one-shot (tokens to stdout as they arrive) |
| `cli-agent --interactive` / `-i` | Legacy readline REPL (lightweight fallback for non-TTY) |
| `CLI_AGENT_NO_TUI=1 cli-agent` | Refuses to enter the TUI; user is told to add `--interactive` or pass a prompt |
