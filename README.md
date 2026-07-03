# cli-agent

> Turn any command-line tool into something an LLM can drive intelligently — without writing a single integration.

`cli-agent` is a **generic LangGraph ReAct agent** that wraps one or more
external CLI binaries you pass at launch (`--tool=git`, `--tool=kubectl`,
`--tool=zip`, …) and lets a Large Language Model use them through a
sandboxed shell tool. It works with **any CLI** that has a meaningful
`--help` output: no per-tool plugin, no schema, no glue code. The agent
auto-introspects each wrapped tool, builds a Markdown capability
document, and embeds that knowledge into the system prompt so the model
generates correct, version-aware invocations.

If you have ever wanted to type "show me the failing pods in production
and tail their logs" or "find the largest commits on this branch" or
"package these PDFs into one zip" and have a real assistant translate
that into the right `kubectl` / `git` / `zip` invocations — that is
exactly what this is for.

---

## What problem does it solve?

LLMs already know roughly how `git`, `gh`, `kubectl`, `aws`, `docker`,
`ffmpeg`, `jq`, `curl`, … are used. What they lack is:

1. **A safe execution path** — running shell commands without leaking
   credentials, allowing pipes-as-injection, or letting a hallucinated
   `rm -rf /` slip through.
2. **Up-to-date, version-specific knowledge** of *your* installation —
   which subcommands your `gh` actually has, what flags your `git
   2.45` accepts, where your `kubectl` context points.
3. **A consistent surface** across every CLI — the same allowlist,
   the same logging, the same provider configuration, the same
   confirmation envelope, regardless of which tool the model decides
   to call.

`cli-agent` provides exactly those three things, generically. You
declare which binaries the agent may invoke; everything else (probing
`--help`, building the prompt, gating mutations, redacting secrets in
logs, retry/abort, persistent history) is handled.

---

## How it works

```
┌─────────────────────┐    ┌──────────────────────┐    ┌────────────────────┐
│ You launch agent    │ →  │ Capability discovery │ →  │ ReAct loop with    │
│ with --tool=<name>… │    │  • probe binary      │    │ bash_run + others  │
│                     │    │  • read --help tree  │    │  ↻ until model     │
│                     │    │  • cache as Markdown │    │    answers         │
└─────────────────────┘    └──────────────────────┘    └────────────────────┘
                                        ↓
            ~/.tool-agents/cli-agent/capabilities/<tool>.md
                  (embedded into the system prompt)
```

1. **You declare wrapped tools** at launch (`--tool=git --tool=gh`) or
   in `~/.tool-agents/cli-agent/config.json` under `tools[]`. Each
   declared binary is auto-added to the bash allowlist.
2. **On first run**, the agent introspects each wrapped tool: probes
   the binary, runs `<tool> --help` (and `<tool> <sub> --help` up to a
   configurable depth), and asks a small LLM to extract the subcommand
   list. The result is written as a Markdown **capability document**
   under `~/.tool-agents/cli-agent/capabilities/<tool>.md`.
3. **At every subsequent run**, the cached capability documents are
   loaded as-is and embedded into the system prompt. No re-introspection
   unless you pass `--refresh-capabilities`. Discovery for tools you
   already cached is essentially free (~30-50 ms per tool).
4. **The model reasons** about your prompt with the wrapped CLIs'
   surfaces in context. When it decides to invoke one, the call goes
   through the standard `bash_run` tool — `execFile`-only (no shell),
   allowlist-enforced, environment-stripped, output-capped, redacted
   in logs. Each call requires user confirmation by default.
5. **The streaming TUI** renders tokens live, shows in-flight tool
   calls with timing, supports ESC-to-abort, multiline input editing,
   slash commands, and persistent thread history.

> **How far can it go?** The agent's competence is exactly the set of
> tools you attach — from a plain chatbot with no tools, up to a
> multi-tool operator that wraps your CLIs and composes new tools of its
> own. The
> **[competency-levels guide](docs/guides/agent-competency-levels.md)**
> walks that progression one rung at a time, with an example for each.

---

## Quick start

```bash
# 1. Install (from the project root)
npm install && npm install -g .

# 2. Export credentials for one of the 8 supported providers
export AZURE_OPENAI_API_KEY="..."
export AZURE_OPENAI_ENDPOINT="https://my-resource.openai.azure.com"
export AZURE_OPENAI_DEPLOYMENT="gpt-4o"
export AZURE_OPENAI_API_VERSION="2024-02-01"

# 3. Pin the default provider so you don't repeat --provider every time
echo 'AGENT_PROVIDER=azure-openai' >> ~/.tool-agents/cli-agent/.env

# 4. Drop into the TUI with a couple of CLIs wrapped
cli-agent --tool git --tool gh

# Or one-shot
cli-agent --tool gh "list my open pull requests"
```

On first run the agent creates `~/.tool-agents/cli-agent/` with mode
`0700`, seeds a `.env` template with mode `0600`, and creates `logs/`
and `capabilities/` subdirectories.

> **Don't have an Azure deployment?** The Quick start above happens to
> use Azure OpenAI — substitute any of the other 7 providers
> (OpenAI, Anthropic, Gemini, Azure Foundry, Ollama, MLX, LiteLLM) by
> following the recipe for your case in
> **[`docs/guides/configuring-cli-agent.md`](docs/guides/configuring-cli-agent.md)**.
> That guide also covers credential storage, switching providers per-
> session, CI scripting, and cost tuning.

---

## Use cases

`cli-agent` shines anywhere a human currently strings together
short shell sessions. The pattern is always: **declare the CLIs the
task needs, then describe the task in natural language**.

### Git / GitHub assistant

```bash
cli-agent --tool git --tool gh
```

Then ask things like:
- "What changed in the last 3 commits to this branch?"
- "Show me the PRs that mention 'capability discovery'."
- "Which files are uncommitted and which are staged?"
- "Squash my last 4 commits into one and write a sensible message" *(needs `--allow-mutations`)*

### Kubernetes operator

```bash
cli-agent --tool kubectl --tool helm
```

- "What pods are failing in the `production` namespace and what was
  their last termination reason?"
- "Tell me which Helm releases are out of date relative to their chart
  index."
- "Drain node `worker-7` safely, list what would move first." *(read-only — does NOT actually drain without `--allow-mutations` + an explicit `kubectl drain` confirmation)*

### Cloud / infra ops

```bash
cli-agent --tool aws --tool terraform
```

- "Which S3 buckets in this account are public and roughly how big?"
- "Compare the planned Terraform changes against what's currently in
  the staging workspace."
- "Find any IAM users without MFA."

### Data wrangling

```bash
cli-agent --tool jq --tool curl --tool csvkit --allow-mutations
```

- "Fetch `https://api.example.com/users`, pull the email + signup
  date, and write a CSV sorted by signup date to `users.csv`."

### Local utilities

```bash
cli-agent --tool zip --tool ffmpeg --tool magick
```

- "Compress all `.png` files in this directory into a single zip
  preserving structure."
- "Re-encode `talk.mov` as a 1080p H.264 mp4 capped at 5 MB/s."

### Developer triage

```bash
cli-agent --tool docker --tool kubectl --tool gh
```

- "A user reported error code 503 on the checkout service at 14:30 UTC.
  Pull the relevant container logs, check the related GitHub issue, and
  give me a five-line summary."

The same agent, one binary, eight providers, no per-tool integration
work.

---

## Adding a new CLI tool

There is **no plugin to write**. Adding a tool is two steps:

1. **Make sure the binary is on your `PATH`.** Anything that responds
   to `<tool> --help` works (most CLIs do). For tools that use
   `<tool> help <sub>` or man pages, the agent's discovery falls back
   gracefully but you may want to add a small note (see the
   USER-NOTES section below).
2. **Pass `--tool=<name>` at launch**, or add it once to `tools[]` in
   `~/.tool-agents/cli-agent/config.json`:

   ```json
   {
     "schemaVersion": 1,
     "tools": ["git", "gh", "kubectl", "helm", "jq"]
   }
   ```

That's it. The first time the agent sees a new tool it runs discovery
(probe → `--help` → LLM extraction → write `<tool>.md`); every
subsequent invocation reuses the cached document.

### Adding org-specific knowledge to a tool

Each cached document at
`~/.tool-agents/cli-agent/capabilities/<tool>.md` has a
`USER-NOTES` block that the agent **preserves verbatim across
regenerations**. Use it for org policy, common workflows, "do" /
"don't" rules, links to runbooks, etc.

```markdown
<!-- USER-NOTES:START -->
- Always use `git switch` / `git restore`; never `git checkout`.
- Mutations require `--force-with-lease`, never plain `--force`.
- Our team only merges via squash; rebase merges are rejected by CI.
- Internal runbook: https://wiki.internal/git-workflows
<!-- USER-NOTES:END -->
```

The next time you launch `cli-agent`, those notes are embedded into the
system prompt and become first-class guidance for the model — without
re-running discovery, without writing code, without leaving the
`USER-NOTES` block.

### Forcing re-discovery

When you upgrade a binary (e.g. `brew upgrade git`) or want the agent
to re-read its current `--help`:

```bash
# Refresh one tool
cli-agent refresh-capabilities --tool git

# Refresh every configured tool
cli-agent refresh-capabilities

# Or, on a single ad-hoc invocation:
cli-agent --tool git --refresh-capabilities "..."
```

You can also do this from inside the TUI: `/refresh-capabilities git`.

---

## Subcommands

```
cli-agent [prompt]                            # one-shot or TUI when no prompt
cli-agent --interactive                       # legacy readline REPL fallback
cli-agent show-capabilities --tool <name>     # print cached capability doc
cli-agent refresh-capabilities [--tool <name>]   # re-introspect one or all
cli-agent composite-show <name>               # print the synthesised composite doc
cli-agent composite-show <name> --command [args...]   # print the resolved underlying command
                                              # (cli-agent + --tool flags + trailing args) WITHOUT executing it
```

| Invocation | Mode |
|---|---|
| `cli-agent` (no args) | Raw-mode TUI |
| `cli-agent "<prompt>"` | Streaming one-shot (tokens to stdout as they arrive) |
| `cli-agent --interactive` / `-i` | Legacy readline REPL (lightweight fallback for non-TTY) |
| `CLI_AGENT_NO_TUI=1 cli-agent` | Refuses to enter the TUI; user is told to add `--interactive` or pass a prompt |

---

## TUI

Bare `cli-agent` invocation drops into a raw-mode terminal UI with
token-by-token streaming, an animated spinner, in-flight tool-call
indicators, ESC-to-abort, multiline input editing, input history, and
a 15-command slash catalogue.

```
$ cli-agent --tool git --tool gh
cli-agent TUI (LangGraph)
LLM: azure-openai / gpt-4o
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

`/tools add gh --save` discovers the `gh` capability *inline* (with a
spinner showing the per-phase progress) and persists it to
`config.json` so the next launch has it pre-wired.

`/model` and `/provider` swap the LLM mid-session without restarting —
useful for trying a cheaper model on simple tasks then switching back.

---

## LLM providers (8 supported out of the box)

| Provider id       | Required env vars | Notes |
|---|---|---|
| `openai`          | `OPENAI_API_KEY` | `OPENAI_BASE_URL` / `OPENAI_ORG_ID` optional |
| `anthropic`       | `ANTHROPIC_API_KEY` | `ANTHROPIC_BASE_URL` optional |
| `gemini`          | `GOOGLE_API_KEY` (or `GEMINI_API_KEY`) | — |
| `azure-openai`    | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` | — |
| `azure-anthropic` | `AZURE_AI_INFERENCE_KEY`, `AZURE_AI_INFERENCE_ENDPOINT` | Also accepts `ANTHROPIC_FOUNDRY_API_KEY` / `ANTHROPIC_FOUNDRY_ENDPOINT` as aliases |
| `ollama`          | `OLLAMA_HOST` | e.g. `http://localhost:11434` |
| `litellm`         | `LITELLM_PROXY_URL`, `LITELLM_MASTER_KEY` | Also accepts `LITELLM_API_BASE` / `LITELLM_API_KEY` as aliases |
| `mlx`             | `OPENAI_BASE_URL` | Point at an MLX-LM OpenAI-compatible server |

Pin a default with `AGENT_PROVIDER=<name>` in
`~/.tool-agents/cli-agent/.env` (or in your shell). Override per
invocation with `--provider <name>`.

---

## Configuration

Resolution chain (Policy A — shell-wins):

```
CLI flag  >  shell env var  >  ~/.tool-agents/cli-agent/.env  >  ~/.tool-agents/cli-agent/config.json  >  throw
```

Required values that fall through every layer raise `ConfigurationError`
and the agent exits 3 — the agent **never substitutes defaults** for
required secrets.

See [`docs/design/configuration-guide.md`](docs/design/configuration-guide.md)
for every variable, its purpose, how to obtain it, recommended
storage, and expiration-tracking guidance for keys that can expire.

---

## Performance & capability cache

The first time the agent sees a new tool, discovery runs and the LLM
extractor is the dominant cost (~500-3000 ms per tool). Subsequent
invocations are essentially free thanks to the on-disk cache:

| Phase | Cold cache | Warm cache (default behavior) |
|---|---|---|
| Module load (Node + LangChain) | ~170 ms | ~170 ms |
| Per-tool discovery (large tool, e.g. `git`) | ~3-8 s | ~30-50 ms (cache hit, no probe) |
| Per-tool discovery (small tool, e.g. `zip`) | ~6 ms (LLM skipped automatically) | ~30-50 ms (cache hit) |

The agent is **smart about small tools**: when a tool's top-level
`--help` is below 4 KiB (configurable via
`--introspect-skip-llm-below-bytes` or
`config.json: capabilities.skipLlmBelowBytes`), it skips the LLM
extractor entirely and embeds the raw help verbatim — saving the
500-3000 ms round-trip for flag-only tools like `zip`, `head`, `jq`,
`cut`, `wc`, etc. Set the threshold to `0` to always run the LLM.

The cache is invalidated **only on explicit refresh**. Upgrade your
`git`? The agent will keep using the old capability doc until you run
`cli-agent refresh-capabilities --tool git`.

Watch what discovery is doing live:

```
[cli-agent] Discovering capabilities for 'gh'...
             probed binary (12ms)
             read top-level --help (124ms, 9847 bytes)
             asking LLM to extract subcommands... done (1842ms, 16 subcommands)
             fetched 16 subcommand --helps (823ms, 5421 bytes)
             ✓ 'gh' ready (2801ms, 11231 bytes)
```

Suppress with `CLI_AGENT_QUIET_DISCOVERY=1`.

---

## Security model

- **Bash allowlist defaults to empty.** Every wrapped binary is
  declared explicitly via `--tool=<name>` (which adds it as a binary
  rule), `--bash-allow=<csv>`, `BASH_ALLOWED_COMMANDS`, or
  `config.json: bash.allow[]`. There is no global "allow everything"
  flag.
- **`execFile`-only spawn.** The agent never calls `child_process.exec`
  or passes a single command string to a shell. Pipes, redirections,
  `&&`, backticks, glob expansion, and env-var expansion **do not
  work** inside `bash_run` — that is a deliberate property, not a
  limitation. If you want pipelines, write a wrapper script and
  allow-list the wrapper binary.
- **Confirmation envelope on every `bash_run` call.** No "remember for
  this session" optimization — every shell-out is a manual yes/no.
- **Mutating tools** (`agt_file_write`, `agt_file_edit`,
  `agt_file_append`, `agt_multiedit`, `agt_patch`) require
  `--allow-mutations`. Without it, only the read-only file tools
  (`agt_file_read`, `agt_file_list`) and the other read-only `agt_*`
  skills are available. (File and web tools live in the agent-tools
  pack; the built-in toolkit is now just `bash_*` + `tool_help`. See
  [`docs/guides/agent-competency-levels.md`](docs/guides/agent-competency-levels.md).)
- **Environment stripping for child processes.** Spawned children
  inherit only `PATH`, `HOME`, `LANG`, `TERM` by default; credential-
  shaped vars are explicitly stripped unless the user opts each one in
  with `--bash-pass-secret <NAME>`.
- **Working-directory sandbox.** `bash_run`'s `cwd` must resolve
  inside `bash.allowedRoots` (default: `process.cwd()` at launch).
- **Redaction on every log write.** Bearer tokens, JWTs, API-key
  shapes, and long base64-URL runs are masked before reaching disk.
  No `--verbose` exception.
- **Structured JSONL audit trail** at
  `~/.tool-agents/cli-agent/logs/session-<utc>-<id>.jsonl` (mode
  `0600`). Eight mandatory event kinds (`session_start`, `user_prompt`,
  `llm_chunk`, `llm_final`, `tool_call`, `tool_result`, `error`,
  `session_end`) plus `cli_invoke`/`cli_result` for capability
  discovery.

`bash_run` is visible to the model when the allowlist is non-empty
even without `--allow-mutations`, because driving the wrapped CLIs is
the whole point of the agent. Without `--allow-mutations`, a
`[READ-ONLY-AGENT]` warning is embedded in the tool's description so
the model self-restricts to read-only commands.

> **Want to enable writing?** See
> **[`docs/guides/enabling-write-capabilities.md`](docs/guides/enabling-write-capabilities.md)**
> for a step-by-step user guide covering `--allow-mutations`, the bash
> allowlist, `--bash-pass-secret`, fine-grained `argv-regex:` entries,
> and worked examples for the common cases (editing files, running
> `git`, posting to GitHub, etc.).

---

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

---

## Project layout

```
cli-agent/
├── src/
│   ├── cli.ts                       # commander entrypoint
│   ├── commands/{agent,show-capabilities,refresh-capabilities}.ts
│   ├── config/agent-config.ts       # 4-tier resolution chain
│   ├── agent/
│   │   ├── providers/               # 8 LLM provider factories
│   │   ├── tools/bash/              # built-in cross-cutting shell toolkit (bash_*)
│   │   ├── tools/tool-help-tool.ts  # tool_help (built-in capability lookup)
│   │   ├── tools/agent-tools/       # the agt_* pack (file, web, search, grep, glob, todos, patch)
│   │   ├── tools/{file,web}/        # file sandbox + web backends, reused by the agt_* pack
│   │   ├── capabilities/            # discovery + cache + system-prompt composition
│   │   ├── graph.ts                 # LangGraph ReAct + streamEvents wrapper
│   │   ├── run.ts                   # one-shot, streaming, REPL, TUI runtimes
│   │   ├── system-prompt.ts
│   │   └── logging.ts               # structured JSONL
│   ├── tui/                         # raw-mode TUI + 15 slash commands
│   ├── errors.ts
│   └── util/redact.ts
├── docs/
│   ├── tools/cli-agent.md           # canonical tool reference
│   └── design/                      # design + configuration + plans
└── ~/.tool-agents/cli-agent/        # per-user, runtime-managed
    ├── .env                         # secrets (mode 0600)
    ├── config.json                  # non-secret defaults
    ├── capabilities/<tool>.md       # discovery cache (per wrapped tool)
    ├── logs/session-*.jsonl         # structured audit trail
    └── history/thread-*.jsonl       # TUI conversation history
```

---

## Documentation

### User guides

- **[`docs/guides/agent-competency-levels.md`](docs/guides/agent-competency-levels.md)**
  — the competency ladder: how the agent grows from a plain chatbot (no
  tools) up to a multi-tool operator that drives your shell, wraps your
  installed CLIs, and bundles commands into new composite tools. One rung
  at a time, with copy-pasteable examples for each. **Start here to
  understand what cli-agent can do and how to dial in exactly the
  capability level you want.**
- **[`docs/guides/configuring-cli-agent.md`](docs/guides/configuring-cli-agent.md)**
  — how to wire cli-agent up to the LLM provider you have access to.
  Decision tree, copy-pasteable recipes for all 8 supported providers
  (OpenAI, Anthropic, Gemini, Azure OpenAI, Azure Foundry, Ollama, MLX,
  LiteLLM), where to put credentials vs non-secret defaults, and
  scenario-by-scenario walkthroughs (corporate Azure, CI scripting,
  switching providers per-session, privacy/offline, cost tuning).
- **[`docs/guides/enabling-write-capabilities.md`](docs/guides/enabling-write-capabilities.md)**
  — how to let the agent edit files, run write-y subcommands of wrapped
  CLIs, and pass through credentials. Covers the three switches
  (`--allow-mutations`, the bash allowlist, `--bash-pass-secret`) with
  worked examples and safety tips.

### Reference & design

- **[`docs/tools/cli-agent.md`](docs/tools/cli-agent.md)** — full
  reference for every CLI flag, env var, config key, slash command,
  and capability cache convention.
- **[`docs/design/configuration-guide.md`](docs/design/configuration-guide.md)** —
  per-variable how-to-obtain, storage recommendation, defaults,
  expiration-tracking guidance.
- **[`docs/design/project-design.md`](docs/design/project-design.md)** —
  architecture, module map, design decisions.
- **[`docs/design/project-functions.md`](docs/design/project-functions.md)** —
  functional requirements (`FR-AGT-*`, `FR-TUI-*`, `FR-NEW-*`,
  `FR-OVR-*`).
- **[`docs/design/plan-001-agent-subcommand.md`](docs/design/plan-001-agent-subcommand.md)** —
  the original build plan.
- **[`docs/design/plan-002-tui.md`](docs/design/plan-002-tui.md)** —
  the TUI build plan.
- **[`docs/design/plan-003-agent-tools-integration.md`](docs/design/plan-003-agent-tools-integration.md)** —
  the agent-tools pack integration plan.
- **[`docs/design/plan-004-tool-prompt-overlays.md`](docs/design/plan-004-tool-prompt-overlays.md)** —
  the user-editable tool-prompt overlay system.
- **[`Issues - Pending Items.md`](Issues%20-%20Pending%20Items.md)** —
  open follow-ups and recently-closed issues.

---

## Development

```bash
npm install
npm run lint            # strict TypeScript static validation
npm run typecheck       # tsc --noEmit
npm run test            # vitest run (111 tests across 17 files at last count)
npm run build           # clean dist/, tsc release build, copy prompt assets, chmod dist/cli.js
npm run release:package # verify the npm publish payload with npm pack --dry-run
npm run dev -- --tool git "smoke test"   # tsx src/cli.ts directly
```

Test isolation note: the spec suite mocks `node:fs/promises` so it
does **not** read your real `~/.tool-agents/cli-agent/.env` — but if
you see one specific spec fail with "expected `E_CONFIG_MISSING`,
got resolved `provider: '<your-provider>'`", you've hit a stale mock
that omits a `default` export. The codebase has the right shape
already; it's worth knowing that any future spec interacting with
`fsp.readFile` must mock both the named exports AND the `default`
object.

---

## License

This project is internal — no external license declared. See your
organization's policies before redistributing.
