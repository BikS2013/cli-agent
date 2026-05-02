# Configuring cli-agent

> A user-focused walkthrough for getting `cli-agent` running with the LLM
> provider you have access to, and tuning it to your workflow. If you
> already know which provider you'll use, jump to its
> [recipe](#provider-recipes); otherwise start with the
> [decision tree](#which-provider-do-i-pick).
>
> For the full encyclopaedia of every variable cli-agent reads, see
> [`docs/design/configuration-guide.md`](../design/configuration-guide.md).
> This document is a guide; that one is a reference.

## What you need to provide

cli-agent has **one mandatory decision**: which LLM provider it should
talk to. Every provider needs at minimum a credential and a model name.
That's it for the bare minimum. Everything else (file sandbox, bash
allowlist, capability cache, system prompt, …) has working defaults.

Optional, depending on your workflow:

- **Wrapped CLIs** — what binaries the agent may drive (`git`, `kubectl`, …).
- **Bash allowlist** — which subset of those binaries `bash_run` may execute.
- **Mutation gate** — whether the agent may modify files (off by default).
  See the dedicated [enabling-write-capabilities](enabling-write-capabilities.md) guide.

The rest of this document focuses on the LLM-provider side.

---

## Quick path to your first run (3 minutes)

```bash
# 1. Install (if you haven't already)
npm install -g @biks2013/cli-agent

# 2. Pick your provider, set its credential, set the model
#    (this example assumes OpenAI — substitute for your case)
export OPENAI_API_KEY="sk-…"
export AGENT_PROVIDER="openai"
export AGENT_MODEL="gpt-4o"

# 3. Run
cli-agent "summarise the README.md in this directory"
```

That's it. The first run creates `~/.tool-agents/cli-agent/` with seeded
defaults you can edit later.

If you don't have an OpenAI key, jump to the
[provider recipes](#provider-recipes) for your case.

---

## Which provider do I pick?

```
Do you have access to … ?

├── A hosted commercial API key (you paid for one, or your employer did)
│   ├── OpenAI key ............................ → see [OpenAI](#openai)
│   ├── Anthropic key (claude.ai/console) ..... → see [Anthropic](#anthropic-claude)
│   └── Google AI Studio key (Gemini) ......... → see [Google Gemini](#google-gemini)
│
├── An Azure tenant your org provides
│   ├── Azure OpenAI deployment ............... → see [Azure OpenAI](#azure-openai)
│   └── Azure AI Foundry (Anthropic) .......... → see [Azure Anthropic / Foundry](#azure-anthropic--foundry)
│
├── Local hardware you want to run on (privacy / offline / cost)
│   ├── macOS Apple Silicon ................... → see [MLX-LM](#mlx-lm-apple-silicon)
│   └── Linux / WSL / any platform ............ → see [Ollama](#ollama-local)
│
└── A corporate proxy / model gateway
    └── Any LiteLLM-fronted endpoint ........... → see [LiteLLM proxy](#litellm-proxy)
```

If you have access to **more than one**, pick the cheapest/fastest for
day-to-day work and use the [Switching providers per session](#switching-providers-per-session)
recipe below to switch when needed.

---

## Provider recipes

Each recipe gives you the minimum copy-pasteable setup. For the
exhaustive variable list (proxies, custom endpoints, expiry tracking,
aliases), see [`docs/design/configuration-guide.md`](../design/configuration-guide.md).

### OpenAI

**Get a key**: <https://platform.openai.com/api-keys>

```bash
# In your shell profile (~/.zshrc, ~/.bash_profile)
export OPENAI_API_KEY="sk-…"
export AGENT_PROVIDER="openai"
export AGENT_MODEL="gpt-4o"          # or gpt-4o-mini for cheaper / faster
```

Verify:

```bash
cli-agent "say hello"
```

**Models worth trying:**
- `gpt-4o` — balanced; the default-recommended general model
- `gpt-4o-mini` — much cheaper, surprisingly capable; fine for most CLI driving
- `gpt-4-turbo` — older but stable

### Anthropic (Claude)

**Get a key**: <https://console.anthropic.com/settings/keys>

```bash
export ANTHROPIC_API_KEY="sk-ant-…"
export AGENT_PROVIDER="anthropic"
export AGENT_MODEL="claude-sonnet-4-6"     # current Sonnet
# or "claude-opus-4-7" for the strongest tier
# or "claude-haiku-4-5-20251001" for the cheapest tier
```

**Models worth trying:**
- `claude-sonnet-4-6` — best workhorse; balanced on quality / cost / speed
- `claude-opus-4-7` — strongest reasoning; expensive
- `claude-haiku-4-5-20251001` — fastest, cheapest; great for "drive this tool" tasks

### Google Gemini

**Get a key**: <https://aistudio.google.com/app/apikey>

```bash
export GOOGLE_API_KEY="AIza…"            # canonical name
export AGENT_PROVIDER="gemini"
export AGENT_MODEL="gemini-2.0-flash"
```

`GEMINI_API_KEY` is also accepted as an alias.

**Models worth trying:**
- `gemini-2.0-flash` — fast, cheap, generous free tier; great default
- `gemini-2.0-pro` — stronger reasoning when you need it

### Azure OpenAI

You'll need four values from your Azure tenant. They're all in the
**Keys and Endpoint** + **Deployments** panes of your Azure OpenAI
resource (or Azure AI Studio).

```bash
export AZURE_OPENAI_API_KEY="…"
export AZURE_OPENAI_ENDPOINT="https://<your-resource>.openai.azure.com"
export AZURE_OPENAI_DEPLOYMENT="<your-deployment-name>"     # NOT the model id
export AZURE_OPENAI_API_VERSION="2024-02-01"                # check Azure docs for current
export AGENT_PROVIDER="azure-openai"
# AGENT_MODEL is auto-inferred from AZURE_OPENAI_DEPLOYMENT; setting it
# explicitly is allowed but not required.
```

**Common confusion**: in Azure, `model` and `deployment` are different
things. `gpt-4o` is the *model*; `prod-gpt4o-eastus` is the *deployment
name* you'd configure on top of it. The agent talks to the deployment.

**Key rotation**: Azure keys can be regenerated; if you rotate them,
update the env var. To get a startup warning before they expire, add to
`config.json`:
```json
{ "_azure_openai_key_expires": "2026-08-01" }
```

### Azure Anthropic / Foundry

For Anthropic models hosted on Azure AI Foundry.

```bash
export AZURE_AI_INFERENCE_KEY="…"
export AZURE_AI_INFERENCE_ENDPOINT="https://<your-foundry-resource>.services.ai.azure.com/models"
export AGENT_PROVIDER="azure-anthropic"
export AGENT_MODEL="claude-sonnet-4-6"
```

The aliases `ANTHROPIC_FOUNDRY_API_KEY` and `ANTHROPIC_FOUNDRY_ENDPOINT`
are also accepted if your tenant uses those naming conventions.

### Ollama (local)

Run open-source models on your own machine. No credentials; just
ensure Ollama is running.

```bash
# Install + start Ollama: https://ollama.com/
ollama pull llama3.2:3b      # or any model you want
ollama serve                  # runs in background

export AGENT_PROVIDER="ollama"
export AGENT_MODEL="llama3.2:3b"
# OLLAMA_HOST defaults to http://127.0.0.1:11434 — set if non-default
# export OLLAMA_HOST="http://my-ollama-box:11434"
```

**Caveat**: small local models (under 8B params) are noticeably weaker
at tool-driving than commercial APIs. Start with `llama3.2:8b` or
`qwen2.5:14b-instruct` for the best balance of speed and competence
on consumer hardware.

### MLX-LM (Apple Silicon)

For local inference on M-series Macs using Apple's MLX framework.

```bash
# Run an MLX-LM HTTP server: https://github.com/ml-explore/mlx-lm
# (typically `python -m mlx_lm.server --model <path-or-id> --port 8080`)

export AGENT_PROVIDER="mlx"
export AGENT_MODEL="mlx-community/Llama-3.2-3B-Instruct-4bit"
# MLX_BASE_URL defaults to http://127.0.0.1:8080
# export MLX_BASE_URL="http://localhost:8080"
```

Same caveat as Ollama: model size matters a lot for tool driving.

### LiteLLM proxy

If your org runs a [LiteLLM](https://github.com/BerriAI/litellm) proxy
(common for unified billing / model routing across multiple backends),
point cli-agent at it:

```bash
export LITELLM_API_KEY="<proxy-key>"
export LITELLM_BASE_URL="https://litellm.your-org.example/v1"
export AGENT_PROVIDER="litellm"
export AGENT_MODEL="<whatever model name your proxy exposes>"
```

This is also the right choice for any custom OpenAI-compatible endpoint
that isn't covered above (corporate proxies, model gateways, custom
inference servers).

---

## Where configuration lives

cli-agent reads configuration from four places. Higher rows win:

| # | Source | Lifetime | Best for |
|---|---|---|---|
| 1 | `--flag value` on the command line | This invocation only | One-off overrides ("just for this one run, use a different model") |
| 2 | Shell env vars (`export VAR=…`) | Per-shell, until logout | Personal credentials and defaults you want everywhere |
| 3 | `~/.tool-agents/cli-agent/.env` | Persistent, agent-specific | Settings that should apply to cli-agent but not pollute your shell |
| 4 | `~/.tool-agents/cli-agent/config.json` | Persistent, structured | Non-secret defaults (provider name, allowlists, file root) |

If a required value is missing from all four, cli-agent exits with code
3 (`ConfigurationError`) and tells you which sources it checked. There
are **no silent fallbacks** for required values.

### What goes where (recommendation)

- **Secrets**: shell profile (`~/.zshrc`) **or** `.env` in the agent
  directory. Choose one of the two; setting the same value in both is
  fine but pointless.
- **Provider name + model**: shell profile if you only use one set;
  `config.json` if you want it to survive a `unset AGENT_PROVIDER`.
- **Bash allowlist, file root, agent-tools opt-out**: `config.json`.
  These are non-secret, structured, and benefit from being version-
  controlled separately if your team shares cli-agent setups.
- **Per-task overrides** (different model for one prompt, different
  allowlist for one session, etc.): CLI flags only.

### The agent directory layout

After your first run, `~/.tool-agents/cli-agent/` looks like:

```
~/.tool-agents/cli-agent/
├── .env                       ← edit credentials & overrides here
├── config.json                ← edit non-secret defaults here
├── system-prompt.md           ← edit the base system prompt
├── capabilities/              ← cached <tool>.md per wrapped CLI
├── tool-prompts/              ← edit per-tool descriptions (see show-tool-prompt)
├── history/                   ← persisted thread history
└── logs/                      ← per-session JSONL audit trail
```

Permissions are `0700` for the directory and `0600` for files containing
secrets — cli-agent enforces these on creation. Don't loosen them.

---

## Common scenarios

### Scenario — "I just got an OpenAI key"

```bash
# One-time:
echo 'export OPENAI_API_KEY="sk-…"' >> ~/.zshrc
echo 'export AGENT_PROVIDER="openai"' >> ~/.zshrc
echo 'export AGENT_MODEL="gpt-4o"' >> ~/.zshrc
source ~/.zshrc

# Run:
cli-agent "what is in this directory?"
```

### Scenario — "I'm on a corporate Azure tenant"

Your IT admin probably gave you four values:
endpoint, deployment name, API version, and a key. Put the non-secret
ones in `config.json` (so they survive an env var unset) and the key in
your shell:

```bash
# In ~/.zshrc:
export AZURE_OPENAI_API_KEY="<your-key>"
```

```jsonc
// ~/.tool-agents/cli-agent/config.json
{
  "provider": "azure-openai",
  "_comment": "endpoint/deployment/api-version below mirror env vars; either source works",
  "azure": {
    "openaiEndpoint": "https://<resource>.openai.azure.com",
    "openaiDeployment": "prod-gpt4o-eastus",
    "openaiApiVersion": "2024-02-01"
  }
}
```

(Or set `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`,
`AZURE_OPENAI_API_VERSION` env vars — same result.)

### Scenario — "I want privacy / offline operation"

Use Ollama or MLX. Both run entirely on your machine; no requests
leave your network.

Trade-off: tool-driving quality drops sharply below 8B params. If your
hardware can run a 14B+ instruction-tuned model comfortably, you'll
get a good experience; below that, expect more retries and weaker
reasoning about which subcommand to call.

### Scenario — "I want to switch providers per-session"

Set persistent defaults in your shell, then override per invocation:

```bash
# Default (in ~/.zshrc): cheap+fast model
export AGENT_PROVIDER="openai"
export AGENT_MODEL="gpt-4o-mini"

# When you need stronger reasoning:
cli-agent --provider anthropic --model claude-opus-4-7 \
          "design a migration strategy for …"

# When you need to stay private:
cli-agent --provider ollama --model llama3.2:8b \
          "summarise this internal document"
```

CLI flags win over env vars, so the per-invocation form does what you
expect.

### Scenario — "I'm scripting in CI"

Don't rely on a `.env` file in CI; use the CI's secret store:

```yaml
# Example: GitHub Actions
env:
  AGENT_PROVIDER: openai
  AGENT_MODEL: gpt-4o-mini
  OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
steps:
  - run: npx -y @biks2013/cli-agent --tool gh "summarise the open PRs"
```

The `--tool` flag is needed because the agent dir doesn't persist
between CI runs and `tools[]` from `config.json` won't be there.

For non-interactive CI usage, also consider:

```bash
cli-agent --no-tui            # fall back to plain stdout (TUI is meant for terminals)
cli-agent --max-steps 10      # cap reasoning depth so a wedge doesn't burn budget
```

### Scenario — "I have multiple Azure deployments (e.g. eastus + westus)"

Pick one as the cli-agent default and keep the others as per-invocation
overrides:

```bash
# Default (your most-used deployment) in ~/.zshrc
export AZURE_OPENAI_API_KEY="…"
export AZURE_OPENAI_ENDPOINT="https://prod-east.openai.azure.com"
export AZURE_OPENAI_DEPLOYMENT="prod-gpt4o-eastus"
export AGENT_PROVIDER="azure-openai"

# Override at the prompt:
cli-agent --provider azure-openai \
          --base-url "https://prod-west.openai.azure.com" \
          --model "prod-gpt4o-westus" \
          …
```

### Scenario — "I'm worried about cost"

- Prefer the cheaper tier (`gpt-4o-mini`, `claude-haiku-4-5-20251001`,
  `gemini-2.0-flash`) for routine work.
- Lower `--max-steps` (default 25) for prompts you expect to need just
  a couple of tool calls.
- Use `--tool` to attach only the binaries the prompt actually needs;
  every wrapped CLI's capability doc is embedded in the prompt and adds
  tokens.
- Run `cli-agent show-tool-prompt --tool <name>` to inspect prompt size
  and consider editing the overlay (`tool-prompts/<name>.md`) to trim
  guidance you don't need.

### Scenario — "I want a custom system prompt"

The system prompt the agent uses is a file you can edit:

```bash
$EDITOR ~/.tool-agents/cli-agent/system-prompt.md
```

Or pass `--system-prompt <path>` for a per-run alternative, or
`--system "extra instructions"` to append text without replacing the
base.

---

## Picking a model

Rough guidance — your mileage varies with prompt complexity:

| Use case | Recommended model | Why |
|---|---|---|
| Routine "drive this CLI for me" | `gpt-4o-mini` / `claude-haiku-4-5-20251001` / `gemini-2.0-flash` | Cheap, fast, plenty smart for known-tool driving |
| Multi-step reasoning, planning | `gpt-4o` / `claude-sonnet-4-6` / `gemini-2.0-pro` | Balanced; the workhorse tier |
| Hardest cases (architectural design, security review, complex refactors) | `claude-opus-4-7` / `gpt-4-turbo` | Strongest reasoning; expensive |
| Local / private / offline | Ollama `llama3.2:8b+` or `qwen2.5:14b+` | Quality drops below 8B; pick the largest you can run |

When in doubt, start with the **routine** tier and upgrade only when
you observe quality issues. Most CLI-driving prompts don't need the
top tier.

---

## Tuning the agent

These are all optional. Defaults are sensible for most workflows.

| Knob | What it does | Default | When to change |
|---|---|---|---|
| `--max-steps <n>` | Cap on reasoning iterations per turn | 25 | Lower for cost control; raise for very multi-step tasks |
| `--temperature <t>` | Sampling temperature | provider default | Lower (0–0.3) for deterministic / parseable output; higher (0.7+) for creative |
| `--per-tool-budget <bytes>` | Max bytes returned per tool call | 16 KB | Raise when the agent keeps hitting `__truncated: true` on legitimate output |
| `--introspect-depth <n>` | Capability discovery depth for `--tool foo` | 2 | Lower (0–1) for slow `--help` trees; higher rarely useful |
| `--system-prompt <path>` | Pick a different base system prompt | `~/.tool-agents/cli-agent/system-prompt.md` | When you want a domain-specific persona |
| `--system <text>` | Append text to the system prompt | (none) | Quick per-run tweaks |
| `--verbose` | Emit structured debug logs to stderr | off | Debugging tool calls / prompt assembly |

For tool-by-tool description tweaks (e.g. "remind the LLM to always
prefer `agt_grep` over `bash_run grep`"), edit the corresponding
file under `~/.tool-agents/cli-agent/tool-prompts/<tool>.md`. See
`cli-agent show-tool-prompt --help` for the audit + extract subcommands.

---

## Verifying your setup

### Smoke test the provider

```bash
cli-agent "say 'configuration works' and nothing else"
```

If this returns `configuration works`, the provider, credential, and
model are all wired correctly.

### Inspect what's loaded

```bash
cli-agent --verbose 2>&1 | head -30
```

The first ~20 stderr lines on a verbose run print the resolved provider,
model, and config sources. If the credential isn't there, it'll fail
fast with `ConfigurationError [E_CONFIG_MISSING]: …` naming the variable.

### Inside the TUI

```
/provider                  ← prints current provider
/model                     ← prints current model
/provider <name>           ← switches provider mid-session
/model <id>                ← switches model mid-session
/tools list                ← shows registered tools
```

### Common errors and what they mean

| Error | Cause | Fix |
|---|---|---|
| `ConfigurationError [E_CONFIG_MISSING]: AGENT_PROVIDER not set` | No `AGENT_PROVIDER` in any source | Set the env var or pass `--provider` |
| `ConfigurationError [E_CONFIG_MISSING]: OPENAI_API_KEY not set` (or similar) | Credential missing for the chosen provider | Export the credential, or check for typos in the var name |
| `Error [E_AUTH]: 401 Unauthorized` | Credential present but invalid/expired | Verify the key in your provider's dashboard; rotate if expired |
| `Error [E_PROVIDER]: model 'foo' not found` | `AGENT_MODEL` doesn't match any model the provider exposes | Check the provider's model list; for Azure check the deployment name (not model id) |
| `Error [E_PROVIDER]: 429 rate limited` | You hit the provider's rate limit | Wait, lower `--max-steps`, or use a different provider for now |

---

## See also

- **[`enabling-write-capabilities.md`](enabling-write-capabilities.md)**
  — how to let the agent edit files and run mutating CLI subcommands.
- **[`docs/design/configuration-guide.md`](../design/configuration-guide.md)**
  — exhaustive reference: every variable, every alias, every default.
- **[`docs/tools/cli-agent.md`](../tools/cli-agent.md)** — full CLI flag,
  env var, slash command, and capability-cache reference.
- **[`docs/reference/.env.example`](../reference/.env.example)**
  — complete annotated `.env` template you can copy and trim.
- **[`docs/reference/config.json.example`](../reference/config.json.example)**
  — annotated `config.json` template.
