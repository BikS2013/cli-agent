# cli-agent — Configuration Guide

## Configuration sources and precedence (Policy A — shell-wins)

cli-agent uses four configuration layers. A higher-priority source always wins:

| Priority | Source | How to set |
|---|---|---|
| 1 (highest) | CLI flags (`--provider`, `--model`, etc.) | Pass directly on the command line |
| 2 | Shell environment variables (`OPENAI_API_KEY`, etc.) | `export VAR=value` in shell profile |
| 3 | `~/.tool-agents/cli-agent/.env` | Edit the file; created on first run |
| 4 | `~/.tool-agents/cli-agent/config.json` | Edit the file; created on first run |
| — | Missing required value | `ConfigurationError` → exit 3 |

**No fallback defaults for required values.** If `OPENAI_API_KEY` is missing and the provider is
`openai`, the agent exits with code 3 and lists every source it checked.

**Recommendation for secrets:** export credentials (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)
in your shell profile (`~/.zshrc` or `~/.bash_profile`) so they are available in every session.
Use `~/.tool-agents/cli-agent/.env` for secrets that are specific to this agent and must
persist across sessions without polluting your shell profile.

---

## Provider selection variables

| Variable | Purpose | Required | Source |
|---|---|---|---|
| `AGENT_PROVIDER` | Default LLM provider | Yes | Shell env / `.env` / CLI `--provider` |
| `AGENT_MODEL` | Default model or deployment name | Depends on provider | Shell env / `.env` / CLI `--model` |
| `AGENT_ALLOW_MUTATIONS` | Enable mutating tools (`true`/`false`) | No (default: `false`) | Shell env / `.env` |

---

## Provider-specific variables

### OpenAI (`--provider openai`)

| Variable | Purpose | Required | How to obtain |
|---|---|---|---|
| `OPENAI_API_KEY` | API key | Yes | https://platform.openai.com/api-keys |
| `OPENAI_BASE_URL` | Custom base URL (proxy) | No | Your proxy URL |
| `OPENAI_ORG_ID` | Organization ID | No | OpenAI dashboard |

**Storage recommendation:** Export `OPENAI_API_KEY` in your shell profile. The key does not
have a hard expiry but should be rotated periodically.

**Expiry capture:** If you rotate keys on a schedule, add to `config.json`:
```json
{ "_openai_key_expires": "2027-01-01" }
```
A future version of cli-agent will warn when within 7 days of expiry.

---

### Anthropic (`--provider anthropic`)

| Variable | Purpose | Required | How to obtain |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | API key | Yes | https://console.anthropic.com/settings/keys |
| `ANTHROPIC_BASE_URL` | Custom base URL | No | Your proxy URL |

---

### Gemini (`--provider gemini`)

| Variable | Purpose | Required | How to obtain |
|---|---|---|---|
| `GOOGLE_API_KEY` | API key (canonical) | Yes | https://aistudio.google.com/app/apikey |
| `GEMINI_API_KEY` | Accepted alias for `GOOGLE_API_KEY` | No (alias) | Same source |

Canonical name takes precedence when both are set.

---

### Azure OpenAI (`--provider azure-openai`)

| Variable | Purpose | Required | How to obtain |
|---|---|---|---|
| `AZURE_OPENAI_API_KEY` | API key | Yes | Azure portal → Keys and Endpoint |
| `AZURE_OPENAI_ENDPOINT` | Resource endpoint URL | Yes | Azure portal → Keys and Endpoint |
| `AZURE_OPENAI_DEPLOYMENT` | Deployment name | Yes | Azure AI Studio → Deployments |
| `AZURE_OPENAI_API_VERSION` | API version string | Yes | Azure docs (e.g. `2024-02-01`) |

**Expiry:** Azure API keys expire after 90 days by default (configurable). Add to `config.json`:
```json
{ "_azure_openai_key_expires": "2026-07-26" }
```
cli-agent will warn on startup when within 7 days of expiry (planned feature).

---

### Azure Anthropic / Foundry (`--provider azure-anthropic`)

| Variable | Purpose | Required | How to obtain |
|---|---|---|---|
| `AZURE_AI_INFERENCE_KEY` | API key (canonical) | Yes | Azure AI Foundry resource → Keys |
| `AZURE_AI_INFERENCE_ENDPOINT` | Foundry endpoint (canonical) | Yes | Azure AI Foundry resource → Overview |
| `ANTHROPIC_FOUNDRY_API_KEY` | Alias for `AZURE_AI_INFERENCE_KEY` | No | Same source |
| `ANTHROPIC_FOUNDRY_ENDPOINT` | Alias for `AZURE_AI_INFERENCE_ENDPOINT` | No | Same source |

The endpoint is normalized automatically: `/models` suffix stripped, `/anthropic` appended.

---

### Ollama (`--provider ollama`)

| Variable | Purpose | Required | How to obtain |
|---|---|---|---|
| `OLLAMA_HOST` | Ollama server base URL | Yes | Your local Ollama server (e.g. `http://localhost:11434`) |

Model must be specified via `--model` or `config.json: model`. No API key required.

---

### LiteLLM proxy (`--provider litellm`)

| Variable | Purpose | Required | How to obtain |
|---|---|---|---|
| `LITELLM_PROXY_URL` | Proxy base URL (canonical) | Yes | Your LiteLLM server |
| `LITELLM_MASTER_KEY` | Master key (canonical) | Yes | LiteLLM config |
| `LITELLM_API_BASE` | Alias for `LITELLM_PROXY_URL` | No | Same source |
| `LITELLM_API_KEY` | Alias for `LITELLM_MASTER_KEY` | No | Same source |

---

### MLX-LM (`--provider mlx`)

| Variable | Purpose | Required | How to obtain |
|---|---|---|---|
| `OPENAI_BASE_URL` | URL of the MLX-LM server | Yes | Your local MLX-LM server (e.g. `http://localhost:8080/v1`) |
| `OPENAI_API_KEY` | Optional (many MLX servers accept any value) | No | `not-needed` used as default |

---

## Web search backends

| Variable | Purpose | Required | Default |
|---|---|---|---|
| `WEB_SEARCH_BACKEND` | Backend id | No | `tavily` |
| `TAVILY_API_KEY` | Tavily key (required if backend=tavily) | Depends | — |
| `SERPAPI_API_KEY` | SerpAPI key | Depends | — |
| `BRAVE_API_KEY` | Brave Search key | Depends | — |
| `WEB_SEARCH_URL` | Custom HTTP backend endpoint | Depends | — |
| `WEB_SEARCH_API_KEY` | Optional auth for custom backend | No | — |
| `WEB_SEARCH_MAX_REQUESTS` | Per-session request budget | No | `50` |

**Note:** If `WEB_SEARCH_BACKEND` is set to a non-`duckduckgo` backend and the required key
is missing, cli-agent raises `E_SEARCH_API_KEY_MISSING` immediately. It does NOT fall back
to duckduckgo — that would mask misconfiguration.

---

## Bash allowlist configuration

The bash allowlist is empty by default. No binary can be executed until explicitly permitted.

### Configuration sources (additive — all merge)

| Source | Form | Priority |
|---|---|---|
| CLI `--bash-allow <csv>` | Comma-separated binary names or `argv-regex:<pattern>` | Highest |
| CLI `--bash-allow-file <path>` | File with one entry per line | High |
| `BASH_ALLOWED_COMMANDS` env var | CSV of binary names | Medium |
| `config.json: bash.allow[]` | Array of entries | Low |
| `--tool <name>` (and `config.json: tools[]`) | Auto-added as binary names | Merged |

### Entry kinds

- **Binary name** (e.g. `git`) — permits any invocation of that binary with any arguments.
- **`argv-regex:<pattern>`** — permits only invocations whose `command + args` string matches the regex.
  Patterns are never echoed in error messages (to prevent token leakage).

### Worked example: permit a single binary

```bash
cli-agent --tool git "What changed in the last 3 commits?"
```

This auto-adds `git` to the allowlist. Alternatively, add to `config.json`:
```json
{ "bash": { "allow": ["git"] } }
```

### Worked example: permit a specific argv pattern only

```bash
cli-agent --bash-allow "argv-regex:^git (status|diff|log)( .*)?$" "Summarize recent changes"
```

This permits only `git status`, `git diff`, and `git log` invocations. `git push` would be blocked.

### Deviation from standard spec

**cli-agent ships `bash_run` in the LLM-visible catalog whenever the allowlist is non-empty,
even without `--allow-mutations`.** This is a deliberate deviation because the entire purpose
of the agent is to drive external CLIs via bash, and almost every useful CLI invocation has
side effects. Without this deviation, the agent would be unable to help at all in the default
(no `--allow-mutations`) mode.

Without `--allow-mutations`, `bash_run`'s LangChain tool description carries a
`[READ-ONLY-AGENT]` prefix warning the LLM to prefer read-only invocations. The mutating
file tools (`file_write`, `file_edit`, `file_append`) remain strictly off without `--allow-mutations`.

---

## Capability discovery configuration

| Variable / Key | Purpose | Default |
|---|---|---|
| `capabilities.depth` / `--introspect-depth` | Recursion depth for `--help` tree | `2` |
| `capabilities.maxBytesPerTool` / `--introspect-max-bytes` | Per-tool byte budget in system prompt | `10240` |
| `capabilities.timeoutMs` / `--introspect-timeout-ms` | Per `--help` call timeout (ms) | `5000` |
| `capabilities.totalTimeoutMs` / `--introspect-total-budget-ms` | Total discovery budget (ms) | `60000` |
| `capabilities.subcommandExtractor` | Provider/model to use for subcommand extraction | active provider/model |

---

## File tool configuration

| Variable / Key | Purpose | Default |
|---|---|---|
| `FILE_EDIT_ROOT` / `fileEdit.root` | Working root for `file_*` tools | `process.cwd()` at launch |
| `fileEdit.allowPaths[]` | Explicit allowlist of paths outside root | `[]` |

Paths outside the root (including symlinks resolved outside) are rejected with
`E_FILE_PATH_OUTSIDE_ROOT`.

---

## Logging

| Variable | Purpose | Default |
|---|---|---|
| `CLI_AGENT_LOG` | Disable logging: `off`, `0`, `false`, `no` | (logging ON) |

Log files are stored at `~/.tool-agents/cli-agent/logs/session-<UTC>-<id>.jsonl`
with mode 0600. The directory is created with mode 0700.

## System prompt selection

Three sources, all routed through the same resolver and the same precedence
chain (CLI > env > config.json > default file path):

| Source | How to set |
|---|---|
| CLI flag | `--system-prompt <path-or-name>` |
| Env var  | `CLI_AGENT_SYSTEM_PROMPT=<path-or-name>` (in shell, agent `.env`, or local `.env`) |
| config.json | `{ "systemPromptFile": "<path-or-name>" }` |
| Default | seeded file at `~/.tool-agents/cli-agent/capabilities/system-prompt.md` |

### `CLI_AGENT_SYSTEM_PROMPT`

| Aspect | Value |
|---|---|
| Purpose | Selects the BASE system prompt file. Replaces the seeded default for the whole invocation. `--system` and `--system-file` continue to APPEND on top. |
| Type | string (path or bare filename) |
| Default | unset → use the seeded `system-prompt.md` |
| Resolution | Absolute path → verbatim. Bare filename (no `/` or `\`) → joined onto `~/.tool-agents/cli-agent/capabilities/`. Relative path with separators → joined onto `process.cwd()`. |
| How to obtain | Edit your own copy of the prompt, save it, then point this variable at it. The seeded default at `~/.tool-agents/cli-agent/capabilities/system-prompt.md` is a good starting point. |
| Recommended storage | For per-machine defaults: `~/.tool-agents/cli-agent/.env`. For per-project overrides: a local `.env`. For one-off tests: the `--system-prompt` flag. |
| Error mode | If the resolved path does not exist or is not readable, the agent exits with code 2 (UsageError). There is NO silent fallback to the built-in default — the built-in is only used to seed the default file on first run. |

The seeded default file is written at mode `0600` and lives alongside the
per-tool capability documents in the `capabilities/` folder. The agent will
never enumerate that folder for tool discovery (it reads files by exact
name), so the reserved filename `system-prompt.md` cannot collide with any
wrapped CLI.

---

## TUI configuration

The raw-mode TUI (entered when bare `cli-agent` is invoked) reads its own
small set of configuration knobs. None of them are required; defaults are
documented.

### `CLI_AGENT_NO_TUI`

| Aspect | Value |
|---|---|
| Purpose | Force the bare `cli-agent` invocation to refuse the TUI. Useful when running inside a TTY-capable terminal that nevertheless cannot host the raw-mode UI (e.g. specific tmux configurations, broken terminfo, pair-programming over SSH multiplexers, etc.). |
| Type | string (boolean-ish — only `1` is interpreted as on) |
| Default | unset (TUI enabled when stdout is a TTY) |
| How to obtain | The user sets it in their shell, e.g. `export CLI_AGENT_NO_TUI=1` in `.zshrc` / `.bashrc`. |
| Recommended storage | Shell rc file, NOT `.env` (it is purely a UX preference, not a secret). |
| Effect when set to `1` | Bare invocation prints `cli-agent: CLI_AGENT_NO_TUI=1 is set — refusing to enter the TUI. Re-run with --interactive for the readline REPL or pass a positional prompt for one-shot mode.` and exits with code 2. |

The TUI also refuses (without this env var) when `process.stdout.isTTY !== true`
or `TERM === 'dumb'`. Those refusals print a slightly different message that
points at the underlying TTY problem.

### Internal clipboard allowlist

The `/copy` slash command dispatches to a hard-coded TUI-internal allowlist:

```
pbcopy                                     (macOS)
xclip -selection clipboard                 (Linux)
xsel --clipboard --input                   (Linux fallback if xclip is missing)
clip.exe                                   (Windows, also used under WSL)
/mnt/c/Windows/System32/clip.exe           (WSL absolute-path fallback)
```

This allowlist is **not user-extensible**. It is independent of `bash.allow`
(the user-controlled allowlist that governs `bash_run`). If none of the above
binaries is present on the host, `/copy` surfaces a `clipboard not available
on this platform` message — never silent-fail.

### History layout (no env vars; documented for completeness)

The TUI persists per-thread JSONL files plus an `index.jsonl` and a
`cursor.json` under `~/.tool-agents/cli-agent/history/` (directory mode 0700,
files mode 0600). The location is fixed; there is no env-var override.
