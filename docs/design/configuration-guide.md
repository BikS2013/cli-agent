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
file tools (`agt_file_write`, `agt_file_edit`, `agt_file_append` since plan-012, plus the
agent-tools `agt_multiedit` / `agt_patch`) remain strictly off without `--allow-mutations`.

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

Since plan-012 the file tools are the agent-tools-pack members `agt_file_read` /
`agt_file_list` / `agt_file_write` / `agt_file_edit` / `agt_file_append` (they
are no longer the built-in `file_*` tools), but they REUSE the same file sandbox,
so these keys are unchanged and govern the new tools. Whether each tool is loaded
is controlled separately by the agent-tools per-tool flags (see "Agent-tools
pack" above); the keys below configure the sandbox root the loaded tools operate
within.

| Variable / Key | Purpose | Default |
|---|---|---|
| `FILE_EDIT_ROOT` / `fileEdit.root` | Working root for the `agt_file_*` tools | `process.cwd()` at launch |
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

---

## LLM I/O inspector

The LLM I/O inspector is a diagnostic switch that records the exact
provider-normalized request and response for every LLM turn to a tailable JSONL
file under `~/.tool-agents/cli-agent/io-captures/`. It is OFF by default. Full
behaviour, the capture-file format, and the in-TUI `/inspect` command are
documented in `docs/tools/cli-agent.md` (the `## LLM I/O Inspector` section of
the `<cliAgent>` block); this section documents the configuration surface.

The inspector exposes one logical switch (enable capture) plus a redaction
opt-out and an optional directory override, each settable from CLI / env /
`config.json`. The CLI flag ↔ env var ↔ `config.json` mapping is:

| Behaviour | CLI flag | Env var | `config.json` |
|---|---|---|---|
| Enable capture | `--inspect-io` | `CLI_AGENT_INSPECT_IO` | `inspectIo.enabled` |
| Disable redaction (RISK) | `--inspect-io-raw` | `CLI_AGENT_INSPECT_IO_RAW` | `inspectIo.redact: false` |
| Override capture directory | — | — | `inspectIo.dir` |

### Configuration sources and precedence

The "enable capture" switch obeys cli-agent's standard four-tier resolution
chain. A source further to the right wins:

```
shell env (CLI_AGENT_INSPECT_IO)
  > ~/.tool-agents/cli-agent/.env
  > local ./.env
  > CLI flag (--inspect-io)
```

…with one extra, lowest-priority tier below the env tiers: the `config.json`
`inspectIo.enabled` key. The effective "requested?" order is therefore
**CLI flag > any env tier > `config.json` > off (default)**, identical in shape
to the agent-tools pack and the system-prompt selector. The redaction opt-out
resolves the same way (`--inspect-io-raw` flag > `CLI_AGENT_INSPECT_IO_RAW` env
> `config.json` `inspectIo.redact: false`), and redaction stays ON unless one of
those explicitly disables it.

**No fallback.** When the inspector is explicitly requested (by any tier) but
cannot be initialised — the capture directory cannot be created or is not
writable, or `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW` holds a
non-boolean value — `loadAgentConfig` raises `ConfigurationError` (exit 3). It
never silently disables capture or substitutes a default mode. When the switch
is simply not requested, capture is off — that is the normal disabled state, not
a fallback.

**Expiration:** none of these variables is a credential and none expires, so the
project's expiry-date capture guidance is N/A here.

### `CLI_AGENT_INSPECT_IO` / `--inspect-io` / `inspectIo.enabled`

| Aspect | Value |
|---|---|
| Purpose | Master switch that turns the LLM I/O capture channel on for a session. Must be set at launch so one-shot runs and the first interactive turn are captured. |
| How to set | CLI `--inspect-io`; env `CLI_AGENT_INSPECT_IO=1` (in shell, agent `.env`, or local `.env`); `config.json` `{ "inspectIo": { "enabled": true } }`. |
| How to obtain | n/a — a boolean switch, no credentials required. |
| Type | boolean (env tri-state: `1`/`true`/`yes`/`on` → on; `0`/`false`/`no`/`off` → off; unset → defer to the next tier). |
| Options | on → capture each turn's request/response to JSONL under `io-captures/`; off → no capture, no file/dir writes, byte-identical to a build without the feature. |
| Default | off (unset). |
| Recommended storage | CLI flag for one-off diagnostic runs; `~/.tool-agents/cli-agent/.env` or `config.json` `inspectIo.enabled` for a persistent per-machine default. Not a secret. |
| Error mode | Requested but capture dir un-creatable/un-writable, or a non-boolean env value → `ConfigurationError` (exit 3). No silent fallback to disabled. |
| Expiration | n/a — not a credential. |

### `CLI_AGENT_INSPECT_IO_RAW` / `--inspect-io-raw` / `inspectIo.redact`

| Aspect | Value |
|---|---|
| Purpose | Disables redaction for the capture file ONLY, so captures contain EXACTLY what was sent (the request emphasised "exactly"). Does not affect the operational `logs/` redaction. |
| How to set | CLI `--inspect-io-raw`; env `CLI_AGENT_INSPECT_IO_RAW=1`; `config.json` `{ "inspectIo": { "redact": false } }`. Only meaningful together with the enable switch. |
| How to obtain | n/a — a boolean switch, no credentials required. |
| Type | boolean (env truthy disables redaction; `config.json` uses `redact: false` to disable). |
| Options | redaction ON (default) → message content via `redactString`, tool-call args / results via `redactObject`, so credential-shaped values are masked; redaction OFF → verbatim plaintext on disk. |
| Default | redaction ON (i.e. the opt-out is off). |
| Recommended storage | Prefer the one-off CLI flag so raw mode is a conscious, per-run choice. Avoid persisting it in `.env` / `config.json`; if you must, scope it to a throwaway machine and prune captures aggressively. |
| **RISK** | With redaction off, secrets / API keys present in the system prompt, conversation memory, or tool arguments are written to disk in PLAINTEXT under `~/.tool-agents/cli-agent/io-captures/`. cli-agent prints a prominent one-line stderr warning BEFORE the capture file is opened. Use only against scrubbed inputs; delete raw captures when done. The opt-out cannot be enabled by accident — it requires an explicit flag/env/config value and always emits the warning. |
| Expiration | n/a — not a credential. |

### `inspectIo.dir` (`config.json` only)

| Aspect | Value |
|---|---|
| Purpose | Overrides the directory the capture files are written to. When unset, captures go to `~/.tool-agents/cli-agent/io-captures/`. |
| How to set | `config.json` `{ "inspectIo": { "dir": "/abs/path/to/captures" } }`. There is no CLI flag or env var for the directory. |
| How to obtain | n/a — a path you choose. |
| Type | string (directory path). |
| Default | `~/.tool-agents/cli-agent/io-captures/`. |
| Recommended storage | `config.json`. Choose a path on a private, non-synced volume — captures can contain the full system prompt, memory, and tool arguments. |
| Error mode | If the resolved directory cannot be created or is not writable while the inspector is requested → `ConfigurationError` (exit 3). No fallback to the default directory. |
| Expiration | n/a — not a credential. |

### Capture artifacts (filesystem)

When enabled, captures are written to:

```
<inspectIo.dir, default ~/.tool-agents/cli-agent/io-captures/>   (mode 0700)
    session-<UTC>-<sessionId>.jsonl                              (mode 0600)
    latest.jsonl  → relative symlink to the most recent session file
```

JSONL, one record per line, written incrementally (tailable live). Files inherit
the same `0700` dir / `0600` file posture as `logs/` because they can carry the
full system prompt, memory, and tool arguments. Captures are **not auto-pruned**
— pruning is the user's responsibility (`rm` the session files you no longer
need), consistent with the existing checkpoint-snapshot policy. Any single
string field over 64 KiB is truncated and the record is marked `_truncated` with
an `_orig_size_bytes` map (large payloads are bounded, never dropped silently).

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

**Slim default + runtime built-in-tools block.** The seeded default base
prompt is slim and tool-agnostic (agent identity + a couple of universal
conduct rules). The built-in cross-cutting toolkit's instructions — the
`## Built-in tools` block (bash_run framing, CORE RULES, OUT-OF-SCOPE, the
available-tools list) — are NOT in the base; they are injected at runtime
ONLY when the built-in tools are loaded (i.e. gated on the `builtinTools`
toggle above), so the prompt stays coherent with the loaded toolset.

**Adaptive built-in-tools block.** When the umbrella is on, that block's
content describes EXACTLY the built-in tools actually registered this
session, derived from the resolved tool names — not a static superset. The
`bash_run` framing (and its two confirmation/allowlist CORE RULES) appears
ONLY with a non-empty command allowlist. (Since plan-012 the file tools
moved to the `agt_*` pack, so the built-in block no longer describes
`file_read`/`file_list` or the `--allow-mutations`-gated mutating-file clause
(`file_write`/`file_edit`/`file_append`); that guidance now rides on the
`agt_file_*` descriptions in the agent-tools block.) The general CORE RULES
and the read-only tools are always described. Because presence is derived
from the post-scoping tool list, a profile `deny` of a built-in tool is
reflected too. The prompt therefore never over-promises vs the bound tool
schemas.

**In-place upgrade of an unmodified default.** Because the default was
restructured (tool prose moved out of the base into the runtime block),
bootstrap upgrades `system-prompt.md` in place IF its bytes exactly equal a
prior shipped default — overwriting it with the new slim default. A file you
customized (or one already at the new slim default) is left BYTE-UNCHANGED.
This is a bootstrap convenience, not a runtime fallback: a missing/unreadable
SELECTED prompt still exits with code 2 (UsageError).

**Customized-base caveat.** The `## Built-in tools` block is injected on top
of whatever base is on disk. For the slim default there is no duplication, but
a CUSTOMIZED base that still hard-codes tool prose owns that prose — the
`builtinTools` toggle cannot strip it from your custom text, and it may then
appear twice when the built-in tools are loaded. Drop the tool prose from your
custom base and let the runtime block supply it.

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

---

## Agent-tools pack

cli-agent ships a curated 6-tool subset of the upstream
[`BikS2013/agent-tools`](https://github.com/BikS2013/agent-tools) library as
additional standard tools (`agt_*`). The pack is governed by an umbrella flag
plus one boolean per wrapped tool. Detailed per-tool descriptions and the full
opt-out matrix live in `docs/tools/cli-agent.md` (the `<agentToolsPack>`
subsection of the `<cliAgent>` block); this section documents the
configuration surface itself.

### Configuration sources and precedence

The agent-tools pack obeys cli-agent's standard four-tier resolution chain:

```
CLI flag > shell env var > ~/.tool-agents/cli-agent/.env > local ./.env > config.json > default
```

Defaults are applied AFTER all four tiers have been consulted. They are
explicit starting values, NOT runtime fallbacks for missing required config —
the project's "no fallback for required values" rule still holds; the pack
simply has no required values.

Conflicting CLI flags on the same tool (e.g. `--enable-agt-grep
--disable-agt-grep`) raise a `UsageError` (exit 2). There is no silent winner.

### Variables

The pack introduces fourteen configuration variables: one umbrella plus
thirteen per-tool (the six vendored tools, the two first-party web tools from
plan-011, and the five first-party file tools from plan-012). Each can be set
from CLI / env / config.json. The per-flag mapping table (CLI flag ↔ env var ↔
config.json key) is in `docs/tools/cli-agent.md` to avoid duplication; the
per-variable description table below documents purpose, options, defaults, and
recommended storage.

#### `agentTools.enabled` (umbrella)

| Aspect | Value |
|---|---|
| Purpose | Master switch for the entire agent-tools pack. When false, none of the six `agt_*` tools are registered, regardless of per-tool flags. |
| How to obtain | n/a — boolean flag, no credentials required |
| Type | boolean (CLI: `--agent-tools` / `--no-agent-tools`; env: `CLI_AGENT_DISABLE_AGENT_TOOLS=1` to disable; config.json: `agentTools.enabled`) |
| Options | `true` (umbrella on; per-tool flags decide individual tools) / `false` (umbrella off; whole pack absent) |
| Default | `true` |
| Recommended storage | Shell env / CLI flag for one-off runs; `config.json` for a persistent default. Not appropriate for `.env` (it is a UX preference, not a secret). |
| Expiration | n/a — booleans do not expire. |

#### `agentTools.tools.glob` / `.grep` / `.multiedit` / `.patch` / `.todoRead` / `.todoWrite` / `.fileRead` / `.fileList` / `.fileWrite` / `.fileEdit` / `.fileAppend` / `.webSearch` / `.webFetch`

| Aspect | Value |
|---|---|
| Purpose | Per-tool opt-in / opt-out. Lets the user remove a single wrapped tool from the LLM-visible catalog (and from the system-prompt block) while keeping the rest of the pack active. `webSearch` / `webFetch` are the first-party `agt_web_search` / `agt_web_fetch` tools (plan-011) — read-only, default ON, reusing the cli-agent web backend. `fileRead` / `fileList` / `fileWrite` / `fileEdit` / `fileAppend` are the first-party `agt_file_read` / `agt_file_list` / `agt_file_write` / `agt_file_edit` / `agt_file_append` tools (plan-012) — reusing the cli-agent file sandbox; `fileRead` / `fileList` are read-only and default ON, while `fileWrite` / `fileEdit` / `fileAppend` are default ON but mutation-gated (see "Interaction with `--allow-mutations`" below). None of these first-party tools are affected by `--no-builtin-tools`. |
| How to obtain | n/a — boolean flag, no credentials required |
| Type | boolean (CLI: `--enable-agt-<tool>` / `--disable-agt-<tool>`; env: `CLI_AGENT_AGT_<TOOL>` tri-state `1`/`true`/`yes`/`on` enable, `0`/`false`/`no`/`off` disable, missing → defer; config.json: `agentTools.tools.<tool>`) |
| Options | `true` (registered, subject to umbrella + mutation-gating) / `false` (excluded entirely) |
| Defaults | `glob`, `grep`, `multiedit`, `patch`, `fileRead`, `fileList`, `fileWrite`, `fileEdit`, `fileAppend`, `webSearch`, `webFetch` → `true`; `todoRead`, `todoWrite` → `false` |
| Recommended storage | CLI flag for per-invocation overrides; `config.json` for a persistent per-machine baseline. Use shell env for short-lived experiments. |
| Expiration | n/a — booleans do not expire. |

### Interaction with `--allow-mutations`

`agt_file_write`, `agt_file_edit`, `agt_file_append` (plan-012), `agt_multiedit`,
and `agt_patch` are mutation-gated: even when their per-tool flag is on AND the
umbrella is on, they are excluded from the LLM-visible catalog when
`--allow-mutations` is off (FR-AGT-010 / FR-AGT-FILE-001). The three
`agt_file_*` mutators inherit the exact gating of the former native `file_write`
/ `file_edit` / `file_append` tools, so today's effective behavior is unchanged:
`agt_file_read` / `agt_file_list` load by default; the three mutators load only
with `--allow-mutations`. `agt_todo_write` mutates only in-memory session state
and is therefore NOT mutation-gated.

### Failure mode for unreadable / corrupt config

If `agentTools` is present in `config.json` but is not a JSON object (or has
non-boolean values where booleans are expected), `loadAgentConfig` raises a
`ConfigurationError` (exit 3). There is no silent coercion — the user must
fix the file or omit the section to fall back to defaults.

### Opt-out matrix (consolidated)

| Behavior                                     | CLI flag                                               | Env var                                              | `config.json`                                          |
|----------------------------------------------|--------------------------------------------------------|------------------------------------------------------|--------------------------------------------------------|
| Disable the whole pack                       | `--no-agent-tools`                                     | `CLI_AGENT_DISABLE_AGENT_TOOLS=1`                    | `agentTools.enabled: false`                            |
| Re-enable the whole pack (defaults to on)    | `--agent-tools`                                        | `CLI_AGENT_DISABLE_AGENT_TOOLS=0` (or unset)         | `agentTools.enabled: true` (or omit)                   |
| Disable a default-on tool (e.g. `agt_grep`)  | `--disable-agt-grep`                                   | `CLI_AGENT_AGT_GREP=0`                               | `agentTools.tools.grep: false`                         |
| Re-enable a default-on tool                  | `--enable-agt-grep`                                    | `CLI_AGENT_AGT_GREP=1`                               | `agentTools.tools.grep: true` (or omit)                |
| Enable the default-off todo pair             | `--enable-agt-todo-read --enable-agt-todo-write`       | `CLI_AGENT_AGT_TODO_READ=1`, `CLI_AGENT_AGT_TODO_WRITE=1` | `agentTools.tools.todoRead: true`, `agentTools.tools.todoWrite: true` |
| Disable a default-on web tool (plan-011)     | `--disable-agt-web-search` / `--disable-agt-web-fetch` | `CLI_AGENT_AGT_WEB_SEARCH=0`, `CLI_AGENT_AGT_WEB_FETCH=0` | `agentTools.tools.webSearch: false`, `agentTools.tools.webFetch: false` |
| Disable a default-on read file tool (plan-012) | `--disable-agt-file-read` / `--disable-agt-file-list` | `CLI_AGENT_AGT_FILE_READ=0`, `CLI_AGENT_AGT_FILE_LIST=0` | `agentTools.tools.fileRead: false`, `agentTools.tools.fileList: false` |
| Disable a default-on mutating file tool (plan-012) | `--disable-agt-file-write` / `--disable-agt-file-edit` / `--disable-agt-file-append` | `CLI_AGENT_AGT_FILE_WRITE=0`, `CLI_AGENT_AGT_FILE_EDIT=0`, `CLI_AGENT_AGT_FILE_APPEND=0` | `agentTools.tools.fileWrite: false`, `agentTools.tools.fileEdit: false`, `agentTools.tools.fileAppend: false` |
| Allow mutating wrappers (`agt_file_write`, `agt_file_edit`, `agt_file_append`, `agt_multiedit`, `agt_patch`) to register | `--allow-mutations` (in addition to per-tool flags) | `AGENT_ALLOW_MUTATIONS=true`                       | `allowMutations: true`                                 |

For the canonical per-flag list (one row per tool, plus the umbrella), see
`docs/tools/cli-agent.md` → `<agentToolsPack>` → "Opt-out flags (CLI)" and
"Opt-out env vars".

---

## Tool-loading toggles (three independent group switches)

cli-agent groups its tools into three independently-loadable families, each of
which can be suppressed at session-build time. They share a single uniform
precedence chain and all default to **load** (today's behaviour is unchanged
when no toggle is set). The full member lists, the `bash_run` caveat, and the
empty-toolset behaviour are documented in `docs/tools/cli-agent.md` (the
`<toolLoadingToggles>` subsection); this section documents the configuration
surface.

The three families:

| Family | Members (summary) | CLI | Env (truthy = OFF) | `config.json` | profile |
|---|---|---|---|---|---|
| Built-in tools (cross-cutting toolkit) | `bash_*`, `tool_help` (web moved to the `agt_*` pack — plan-011; file tools moved to the `agt_*` pack — plan-012) | `--builtin-tools` / `--no-builtin-tools` | `CLI_AGENT_DISABLE_BUILTIN_TOOLS` | `builtinTools` | `tools.builtin` |
| Composites | every virtual/composite tool | `--composites` / `--no-composites` | `CLI_AGENT_DISABLE_COMPOSITES` | `composites` | `tools.composites` |
| Agent-tools pack (`agt_*`) | the six vendored `agt_*` tools + first-party `agt_file_read` / `agt_file_list` / `agt_file_write` / `agt_file_edit` / `agt_file_append` + first-party `agt_web_search` / `agt_web_fetch` (see "Agent-tools pack" above) | `--agent-tools` / `--no-agent-tools` | `CLI_AGENT_DISABLE_AGENT_TOOLS` | `agentTools.enabled` | `tools.agentTools` |

### Configuration sources and precedence

These toggles add a **profile tier** below `config.json`, so the chain is:

```
CLI flag > shell env var (CLI_AGENT_DISABLE_*) > ~/.tool-agents/cli-agent/.env > local ./.env > config.json > profile (tools.*) > default (load)
```

The `--no-*` CLI form disables the group; the positive `--<group>` form forces
it on even if a lower tier disabled it. The `CLI_AGENT_DISABLE_*` env vars use
the inverted-disable convention shared with `CLI_AGENT_DISABLE_AGENT_TOOLS`: a
truthy value (`1`/`true`/`yes`/`on`) turns the group OFF; an invalid
(non-boolean) value raises `ConfigurationError` (exit 3) — no fallback.

Defaults (load) are applied AFTER every tier has been consulted. They are
explicit starting values, NOT runtime fallbacks for missing required config —
the "no fallback for required values" rule still holds; these toggles simply
have no required values.

### Variables

#### `composites` (`config.json`) / `tools.composites` (profile) / `--composites` (CLI) / `CLI_AGENT_DISABLE_COMPOSITES` (env)

| Aspect | Value |
|---|---|
| Purpose | Load (default) or suppress every composite/virtual tool registered under `~/.tool-agents/cli-agent/composites/`. |
| How to obtain | n/a — boolean toggle, no credentials required |
| Type | boolean (CLI: `--composites` / `--no-composites`; env: `CLI_AGENT_DISABLE_COMPOSITES=1` to disable; config.json: `composites`; profile: `tools.composites`) |
| Options | `true` (load all composites) / `false` (no composite tools loaded) |
| Default | `true` (load) |
| Precedence | CLI flag > env > config.json > profile > default(load) |
| Recommended storage | CLI flag / shell env for one-off runs; `config.json` for a persistent per-machine default; a profile for a named reproducible preset. Not appropriate for `.env` (it is a UX preference, not a secret). |
| Expiration | n/a — booleans do not expire. |

#### `builtinTools` (`config.json`) / `tools.builtin` (profile) / `--builtin-tools` (CLI) / `CLI_AGENT_DISABLE_BUILTIN_TOOLS` (env)

| Aspect | Value |
|---|---|
| Purpose | Load (default) or suppress the built-in cross-cutting toolkit (`bash_*`, `tool_help`). NOTE (plan-011): web search/fetch are NO LONGER part of this toolkit — they moved to the agent-tools pack as `agt_web_search` / `agt_web_fetch`, governed by `--agent-tools`, so `--no-builtin-tools` does NOT remove web. NOTE (plan-012): the file tools are NO LONGER part of this toolkit either — they moved to the agent-tools pack as `agt_file_read` / `agt_file_list` / `agt_file_write` / `agt_file_edit` / `agt_file_append`, governed by `--agent-tools` (and per-tool `--disable-agt-file-*`), so `--no-builtin-tools` does NOT remove file ops. NOTE: suppressing this toolkit also removes `bash_run`, the path used to run *wrapped* CLIs — see the caveat in `docs/tools/cli-agent.md`. Suppressing it ALSO removes the built-in tool INSTRUCTIONS from the system prompt: the entire `## Built-in tools` block (bash_run framing, CORE RULES, OUT-OF-SCOPE, the available-tools list) is gated on the same toggle, so the model is not told about tools it cannot call. When the umbrella is ON, that block adapts to the actually-registered tools (the `bash_run` framing only with a non-empty allowlist; profile deny respected). |
| How to obtain | n/a — boolean toggle, no credentials required |
| Type | boolean (CLI: `--builtin-tools` / `--no-builtin-tools`; env: `CLI_AGENT_DISABLE_BUILTIN_TOOLS=1` to disable; config.json: `builtinTools`; profile: `tools.builtin`) |
| Options | `true` (load the toolkit + inject its system-prompt block) / `false` (none of `bash_*`/`tool_help` loaded — including `bash_run` — and no built-in-tools system-prompt block; web and file ops are unaffected — they live in the `agt_*` pack) |
| Default | `true` (load) |
| Precedence | CLI flag > env > config.json > profile > default(load) |
| Recommended storage | CLI flag / shell env for one-off runs; `config.json` for a persistent default; a profile for a named preset. Not appropriate for `.env`. |
| Expiration | n/a — booleans do not expire. |

#### `agentTools.enabled` profile tier — `tools.agentTools`

The agent-tools pack umbrella (`agentTools.enabled`) gains a profile tier
(`tools.agentTools`) so it participates in the same uniform chain as the other
two families. Its CLI / env / config.json surfaces are unchanged (documented in
"Agent-tools pack" above); the profile key sits just above the default:

```
--agent-tools / --no-agent-tools  >  CLI_AGENT_DISABLE_AGENT_TOOLS  >  config.json agentTools.enabled  >  profile tools.agentTools  >  default(load)
```

### Empty toolset is permitted

Disabling every family (and wrapping no CLI) produces an empty catalog; the
agent runs as a plain conversational LLM. This is a supported state, NOT an
error — cli-agent emits one stderr notice and proceeds (it does not throw).

### Opt-out matrix (consolidated)

| Behavior | CLI flag | Env var | `config.json` | profile |
|---|---|---|---|---|
| Suppress composites | `--no-composites` | `CLI_AGENT_DISABLE_COMPOSITES=1` | `composites: false` | `tools.composites: false` |
| Suppress built-in toolkit (incl. `bash_run`) | `--no-builtin-tools` | `CLI_AGENT_DISABLE_BUILTIN_TOOLS=1` | `builtinTools: false` | `tools.builtin: false` |
| Suppress agent-tools pack | `--no-agent-tools` | `CLI_AGENT_DISABLE_AGENT_TOOLS=1` | `agentTools.enabled: false` | `tools.agentTools: false` |
| Re-enable any family (defaults to on) | positive form (`--composites` / `--builtin-tools` / `--agent-tools`) | `CLI_AGENT_DISABLE_*=0` (or unset) | key `: true` (or omit) | key `: true` (or omit) |
