# The cli-agent competency ladder

> A guided tour of everything `cli-agent` can *become* — from a plain
> chatbot with no tools at all, up to a multi-tool operator that drives
> your shell, your installed CLIs, and bundles of commands it composes
> itself. **The agent's competence is exactly the set of tools you attach
> to it.** This guide walks that progression one rung at a time: what each
> rung adds, how to switch it on, a worked example you can copy, and the
> safety posture that comes with it.
>
> New here? Read top to bottom once. Coming back? Jump to a level from the
> [ladder table](#the-ladder-at-a-glance).
>
> Companion docs: the exhaustive flag / env / config reference lives in
> [`docs/tools/cli-agent.md`](../tools/cli-agent.md); provider setup is in
> [configuring-cli-agent](configuring-cli-agent.md); the write switches are
> in [enabling-write-capabilities](enabling-write-capabilities.md).

---

## Mental model: capability comes from the tools you attach

`cli-agent` is a **reasoning engine (the LLM) plus a toolbox**. The LLM
supplies language, planning, and judgement; the toolbox is what lets it
*act* on your machine. Take the tools away and you have a clever
conversationalist that can't touch anything. Add tools and it gains hands.

Everything the model can call comes from four sources. Which of them load
is decided by one dial — `--mode <chat|basic|tool|composite>` — plus what
you attach on top:

```
                 ┌──────────────────────────────────────────────┐
                 │                  The LLM                       │
                 │   (8 providers; reasoning + planning loop)     │
                 └───────────────────────┬──────────────────────-┘
                                         │  can call ▼
   ┌──────────────────┬─────────────────┼──────────────────┬──────────────────┐
   ▼                  ▼                 ▼                  ▼                  ▼
┌────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────────┐  (nothing —
│ Built-in   │  │ Agent-tools  │  │ Wrapped CLIs │  │ Composite      │   Level 0)
│ toolkit    │  │ pack (agt_*) │  │ (--tool …)   │  │ tools          │
│ bash_run,  │  │ files,search,│  │ git, gh,     │  │ bundles of the │
│ tool_help  │  │ web, todos   │  │ kubectl, …   │  │ above, packaged│
└────────────┘  └──────────────┘  └──────────────┘  └────────────────┘
   Level 1          Level 2          Level 3            Level 4
   ─────────────────────────────────────────────────────────────────►
                        Level 5 = all of them, orchestrated together
```

The **mode** decides which groups load: `chat` loads nothing, `basic`
loads only the agent-tools pack, `tool` adds the built-in toolkit, and
`composite` (the default) loads everything, composite/virtual tools
included. On top of the mode, wrapped CLIs are **opt-in per launch**
(`--tool`) and composites are **something you build**. The whole resolved
set is called the **catalog**, and the catalog is what gets described to
the model in its system prompt.

> **Important:** the levels below are *classes of capability*, not a
> strict staircase you must climb in order. A fresh install already sits
> at **Level 2** (it can read and search files out of the box). You go
> *up* by attaching more (wrapped CLIs, composites, write access); you go
> *down* by picking a lower `--mode`. Level 0 and Level 1 are mostly
> interesting as *deliberately stripped-down* configurations.

---

## The ladder at a glance

| Level | Name | The agent can… | What you turn on | Tools it gains |
|------:|------|----------------|------------------|----------------|
| **0** | [Pure conversation](#level-0--pure-conversation-no-tools) | Only talk: explain, draft, brainstorm, reason over text you paste in | `--mode chat` (and no `--tool`) | *none* |
| **1** | [Run local commands](#level-1--run-local-commands-the-built-in-toolkit) | Execute allow-listed shell commands and inspect what's allowed | `--mode tool` + a non-empty allowlist (`--bash-allow` / `--tool`); add `--disable-tool agt_*` entries for a strictly shell-only posture | `bash_run`, `bash_list_allowed`, `bash_which`, `tool_help` |
| **2** | [Portable file / search / web skills](#level-2--portable-file-search--web-skills-the-agent-tools-pack) | Read & search files, fetch & search the web, keep a todo list — **with no external binary installed** | `--mode basic` (or nothing — the default mode includes the pack); `--allow-mutations` to also write files | `agt_glob`, `agt_grep`, `agt_file_*`, `agt_web_*`, `agt_todo_*`, `agt_multiedit`, `agt_patch` |
| **3** | [Wrap an external command](#level-3--wrap-an-external-command---tool) | Drive any CLI on your `PATH` intelligently (`git`, `gh`, `kubectl`, `aws`, `ffmpeg`, …) — version-aware, from auto-discovered `--help` | `--tool <name>` (repeatable) | the wrapped CLIs, run through `bash_run`, with per-tool capability docs |
| **4** | [Compose commands into a new tool](#level-4--compose-commands-into-a-new-tool-composites) | Package a curated multi-CLI assistant as a *single new tool* another agent can attach with one flag | `--treat-as-tool` + `--register-virtual` / `--emit-wrapper` (or the `composite-synthesize` subcommand) | a `--tool <composite-id>` that fronts several CLIs |
| **5** | [Orchestrate complex OS operations](#level-5--orchestrate-complex-operations-over-the-os) | Combine wrapped CLIs + file/web skills + write access + composites to carry out multi-step jobs across your system, repeatably | everything above + `--allow-mutations` + `--profile` for presets | the full catalog, pinned and auditable |

---

## What you always get (every level, even Level 0)

These are **harness features, not tools** — they're present even when the
catalog is empty, so they aren't part of the ladder:

- **8 LLM providers** — OpenAI, Anthropic, Gemini, Azure OpenAI, Azure
  Foundry (Anthropic), Ollama, LiteLLM, MLX. Pick with `--provider` /
  `AGENT_PROVIDER`. See [configuring-cli-agent](configuring-cli-agent.md).
- **The streaming TUI** — bare `cli-agent` drops into a raw-mode terminal
  UI with token-by-token output, an animated spinner, in-flight tool-call
  indicators, ESC-to-abort, multiline editing, and a slash-command
  catalogue.
- **Conversation memory, history & resume** — per-thread JSONL transcripts
  under `~/.tool-agents/cli-agent/history/`, plus `--resume` / `/resume`.
- **A customizable system prompt** — `~/.tool-agents/cli-agent/capabilities/system-prompt.md`,
  editable on disk, with `--system` / `--system-file` to append extra
  instructions.
- **Structured JSONL logging** and the optional
  [LLM I/O inspector](#auditing-what-the-agent-actually-did) (`--inspect-io`).
- **Strict configuration precedence** with no silent fallbacks:
  `CLI flag > shell env > ~/.tool-agents/cli-agent/.env > local ./.env > profile > config.json`
  for the pinnable knobs (provider, model, temperature, mutations, mode, …).
  See [the reference](../tools/cli-agent.md).

---

## Level 0 — Pure conversation (no tools)

**What it is.** The agent with an *empty catalog*: no shell, no
filesystem, no web, no wrapped CLIs. It is a plain conversational LLM
behind cli-agent's TUI, history, and provider plumbing.

**What you can ask it.** Anything that lives entirely in the conversation:

- "Explain the difference between a rebase and a merge."
- "Draft a commit message for this diff:" *(paste the diff)*
- "Rewrite this paragraph to be more concise."
- "Walk me through how I'd design a rate limiter."

**What it cannot do.** Read a file, list a directory, run a command,
search the web — anything that requires touching the world. If you ask it
to "summarise README.md", it can only tell you it has no way to read the
file.

**How to turn it on.** One flag — `--mode chat` — and wrap no CLI:

```bash
cli-agent --mode chat \
  "Explain what a LangGraph ReAct loop is, in three sentences."
```

cli-agent confirms the stripped-down state with one stderr notice — this
is a **supported configuration, not an error**:

```
[cli-agent] note: no tools are loaded for this session (all tool groups disabled); the agent will run as a plain conversational LLM with no tools.
```

**Why you'd use it.** A pure-reasoning sandbox: drafting, explaining,
brainstorming, or rubber-ducking with zero risk that the model does
anything to your machine. It's also the cleanest way to evaluate a
provider/model's raw quality without tool noise.

---

## Level 1 — Run local commands (the built-in toolkit)

**What it is.** The cross-cutting toolkit that ships *on by default*:

| Tool | Purpose |
|------|---------|
| `bash_run` | Execute a single allow-listed command (`execFile`-style — **no** pipes, redirects, `&&`, globbing, or env-expansion) |
| `bash_list_allowed` | Report which commands the agent is currently allowed to run |
| `bash_which` | Resolve where an allowed binary lives on `PATH` |
| `tool_help` | Look up the full `--help` / capability text of a wrapped CLI |

**The one thing to know:** `bash_run` is only handed to the model **when
the allowlist is non-empty.** The allowlist starts empty, so to make
Level 1 meaningful on its own you add commands with `--bash-allow` (or you
wrap a CLI, which is Level 3 — wrapping a tool auto-adds it to the
allowlist). With an empty allowlist the agent is told, truthfully, that no
local commands are available to it.

**How to turn it on.** `--mode tool` loads the built-in toolkit; then
allow a few read-only commands explicitly:

```bash
# Level 1 focus: built-in shell + a tiny allowlist
cli-agent --mode tool --bash-allow "uname,sw_vers,ls,wc" \
  "What OS am I on, and how many files are in the current directory?"
```

> **Shell-only caveat.** Since the mode simplification (plan-015) there is
> no single switch that loads the shell toolkit *without* the agent-tools
> pack — `--mode tool` brings both, and that is an accepted consequence of
> the four-mode design. For a *strictly* shell-only posture, disable the
> pack's default-on read tools individually:
>
> ```bash
> cli-agent --mode tool \
>   --disable-tool agt_glob --disable-tool agt_grep \
>   --disable-tool agt_file_read --disable-tool agt_file_list \
>   --disable-tool agt_web_search --disable-tool agt_web_fetch \
>   --bash-allow "uname,sw_vers,ls,wc" "…"
> ```
>
> (or set the matching `agentTools.tools.*` keys to `false` once in
> `config.json` instead of repeating the flags; the write tools and the
> todo tools are already off without `--allow-mutations` /
> `--enable-tool`).

A one-shot transcript:

```
You> What OS am I on, and how many files are in the current directory?
Agent
  ↳ calling bash_run(uname -srm) ✓ (21ms)
  ↳ calling bash_run(ls -1) ✓ (18ms)
You're on Darwin 25.5.0 (arm64). The current directory has 14 entries.
```

**Safety posture.** Read-only by default. The allowlist is the gate — the
agent can run *only* what you listed, and `execFile` semantics mean it
can't smuggle in a pipeline or `rm -rf /` through string tricks. Side
effects (anything that writes) stay blocked until you add
`--allow-mutations`. See the [security model](../../README.md#security-model)
and [enabling-write-capabilities](enabling-write-capabilities.md).

> **Allowlist syntax tip.** `--bash-allow` accepts bare binary names
> (`git`) *and* `argv-regex:<pattern>` rules for fine-grained control
> (e.g. allow `git log …` but not `git push …`). Entries are OR'd: a
> bare-name entry — including the one `--tool` auto-adds — allows every
> invocation of that binary and overrides any `argv-regex:` restriction
> for it, so to restrict a binary list it *only* via `argv-regex:` (and
> don't wrap it). The write-capabilities guide has worked examples.

---

## Level 2 — Portable file, search & web skills (the agent-tools pack)

**What it is.** The `agt_*` pack — a curated set of first-class skills the
agent carries **without needing any external binary installed.** This pack
is *on by default*, which is why a fresh `cli-agent` can already read and
search your files; `--mode basic` gives you *only* this pack (no shell, no
composites).

| Tool | Default | Writes? | Purpose |
|------|---------|---------|---------|
| `agt_glob` | on | no | Find files by glob pattern |
| `agt_grep` | on | no | Regex content search (ripgrep if present, JS fallback otherwise) |
| `agt_file_read` | on | no | Read a file inside the sandbox |
| `agt_file_list` | on | no | List a directory inside the sandbox |
| `agt_web_search` | on | no | Search the web (via the configured backend) |
| `agt_web_fetch` | on | no | Fetch a URL → readable text |
| `agt_file_write` | on\* | **yes** | Create / overwrite a file |
| `agt_file_edit` | on\* | **yes** | In-place edit of a file |
| `agt_file_append` | on\* | **yes** | Append to a file |
| `agt_multiedit` | on\* | **yes** | Atomic multi-edit of one file |
| `agt_patch` | on\* | **yes** | Apply a unified-diff / patch envelope |
| `agt_todo_read` | off | no | Read the session todo list |
| `agt_todo_write` | off | no | Maintain a session todo list (in-memory only) |

\* *Mutation-gated: registered only when you pass `--allow-mutations`.* So
out of the box you get the read-only half (search + read + web); the write
half lights up the moment you opt into mutations.

**What you can ask it (read-only, the default).**

```bash
# No --tool, no allowlist needed — these skills are built in
cli-agent "Find every TODO/FIXME comment under src/ and group them by file."
```

```
You> Find every TODO/FIXME comment under src/ and group them by file.
Agent
  ↳ calling agt_grep(pattern="TODO|FIXME", path="src") ✓ (34ms)
  ↳ calling agt_file_read(path="src/agent/run.ts") ✓ (8ms)
17 markers across 6 files:
  src/agent/run.ts        — 4  (3 TODO, 1 FIXME)
  src/tui/controller.ts   — 5  …
```

**What you can ask it (with writes enabled).**

```bash
cli-agent --allow-mutations \
  "Add the SPDX license header '// SPDX-License-Identifier: MIT' to the top of every .ts file under src/ that lacks one."
```

Here the agent uses `agt_glob` + `agt_file_read` to find the gaps and
`agt_file_edit` / `agt_multiedit` to apply them — all jailed to the file
sandbox root (`fileEdit.root`, default = your launch directory).

**Two things to configure.**

- **File sandbox root.** Reads and writes are confined to `fileEdit.root`
  (defaults to the directory you launched from). Widen it with
  `fileEdit.allowPaths` / `FILE_EDIT_ROOT` if you need to.
- **Web backend.** `agt_web_search` / `agt_web_fetch` need a backend and
  key (`WEB_SEARCH_BACKEND=tavily` + `TAVILY_API_KEY`, or `serpapi` /
  `brave` / `duckduckgo` / `custom-http`). Without one configured they
  raise a configuration error rather than guessing — by design. The two
  share a per-session budget (`WEB_SEARCH_MAX_REQUESTS`, default 50).

**Turning individual tools on/off.** Every tool has a per-tool override
via the repeatable `--enable-tool <name>` / `--disable-tool <name>` flags
(canonical names, e.g. `--disable-tool agt_grep`), plus a matching env var
(`CLI_AGENT_AGT_GREP=false`) and `config.json` key (`agentTools.tools.*`).
Enable the todo tools when you want the agent to track its own multi-step
plan:

```bash
cli-agent --enable-tool agt_todo_read --enable-tool agt_todo_write \
  "Plan and carry out a refactor of the config loader; keep a running todo list."
```

---

## Level 3 — Wrap an external command (`--tool`)

**What it is.** This is cli-agent's headline trick. Point it at *any* CLI
on your `PATH` with `--tool <name>` and, on first run, it:

1. probes the binary,
2. reads its `--help` tree (recursively, to a configurable depth),
3. asks a small LLM to extract the subcommand surface,
4. writes a Markdown **capability document** to
   `~/.tool-agents/cli-agent/capabilities/<tool>.md`, and
5. embeds that document into the system prompt.

The model now knows *your* installed version's exact subcommands and flags,
and runs them through `bash_run` (which is why **wrapped CLIs need
`--mode tool` or `--mode composite`** — the two modes that load
`bash_run`; combining `--tool` with `--mode chat` or `--mode basic` is
rejected as a usage error). The default mode is `composite`, so plain
`cli-agent --tool git` just works. Each `--tool` you declare is auto-added
to the bash allowlist.

**How to turn it on.**

```bash
# Drop into the TUI as a Git + GitHub assistant
cli-agent --tool git --tool gh

# …or one-shot
cli-agent --tool kubectl --tool helm \
  "Which pods are failing in the production namespace, and why?"
```

```
$ cli-agent --tool git --tool gh
cli-agent TUI (LangGraph)
LLM: azure-openai / gpt-4o

You> What changed in the last 3 commits, and is there an open PR that touches the TUI?
Agent
  ↳ calling bash_run(git log -n 3 --stat) ✓ (41ms)
  ↳ calling bash_run(gh pr list --search "tui") ✓ (380ms)
The last 3 commits … . There's one open PR (#5) touching src/tui/controller.ts.
```

**Make a wrapped tool smarter (no code).** Each capability doc has two
user-editable blocks that survive every refresh:

- **`USER-NOTES`** — org policy, conventions, runbook links. *"Always use
  `git switch`, never `git checkout`. Merges are squash-only."*
- **`USER-RECIPES`** — canonical invocations. Seed them automatically with
  `cli-agent extract-recipes --tool git`, then prune by hand.

Both get embedded into the system prompt, turning generic CLI knowledge
into *your* house style. Inspect and refresh with:

```bash
cli-agent show-capabilities --tool git        # print the cached doc
cli-agent refresh-capabilities --tool git     # re-introspect (after an upgrade)
```

**Why it's powerful.** No plugin, no schema, no glue code — any of the
hundreds of CLIs you already have becomes an LLM-drivable surface. See the
[README use cases](../../README.md#use-cases) for git/gh, kubectl/helm,
aws/terraform, jq/curl/csvkit, zip/ffmpeg/magick, and cross-tool triage
recipes.

---

## Level 4 — Compose commands into a new tool (composites)

**What it is.** Once `cli-agent --tool git --tool gh` is a great release
assistant, Level 4 lets you **package that curated assembly as a single new
tool** — call it `release-helper` — that another cli-agent can attach with
one `--tool release-helper`. This is the "compose commands and bundle them
to the agent" rung.

A composite has no real binary to introspect, so cli-agent **synthesises**
its capability document from the member tools' docs via a two-stage LLM
pipeline (distill each member → compose the bundle), caching aggressively.

**Three ways to ship a composite** (mix and match):

| Form | Flag | What it produces |
|------|------|------------------|
| (a) Capability doc | `--emit-doc` *(default on with `--treat-as-tool`)* | `capabilities/composite/<id>.md` — the synthesised doc |
| (b) Wrapper shim | `--emit-wrapper` (`--emit-wrapper-on-path` adds `~/.local/bin/<id>`) | a POSIX `/bin/sh` shim that `exec`s the real `cli-agent --tool …` |
| (c) Virtual tool | `--register-virtual` | a `manifest.json` so `--tool <id>` is recognised with no PATH binary |

**How to turn it on.** Synthesise and register a composite:

```bash
# Bundle git + gh into a virtual tool called "release-helper"
cli-agent --tool git --tool gh \
  --treat-as-tool --composite-name release-helper \
  --register-virtual --help
```

…or use the dedicated subcommand (equivalent, clearer intent):

```bash
cli-agent composite-synthesize --tool git --tool gh \
  --composite-name release-helper --register-virtual
```

Then **attach the bundle to any agent with one flag**:

```bash
cli-agent --tool release-helper \
  "Cut a release: tag the current commit, push it, and open the GitHub release notes."
```

**Inspect, preview, and manage composites:**

```bash
cli-agent composite-list                       # all composites you've built
cli-agent composite-show release-helper        # the synthesised capability doc
cli-agent composite-show release-helper --command "tag v1.2.0"
                                               # show the EXACT command it would run, WITHOUT executing
cli-agent composite-delete release-helper      # remove it

# Preview the synthesis prompts without spending a single LLM token:
cli-agent --tool git --tool gh --treat-as-tool --dry-run-synthesis --help
```

**Good to know.**

- Synthesis honours your active provider/model and a token budget
  (`--synthesis-budget-tokens`, default 32768). Re-synthesise after editing
  members with `--regenerate-capabilities` (distinct from
  `--refresh-capabilities`, which re-introspects a *member's* `--help`).
- **Composite-of-composite is rejected** (no recursion), and the wrapper
  shim embeds an absolute path, so composites don't roam across machines —
  rebuild them where you use them.

---

## Level 5 — Orchestrate complex operations over the OS

**What it is.** Not a new switch — it's **all the rungs working together**:
several wrapped CLIs, the file/search/web skills, write access, and your
composites, driven by the model across a multi-step job. This is where the
agent stops answering questions and starts *doing work*.

**How to turn it on.** Attach what the task needs and unlock writes:

```bash
cli-agent \
  --tool docker --tool kubectl --tool gh \
  --allow-mutations \
  --bash-pass-secret GH_TOKEN
```

Then describe the job in plain language:

```
You> A user reported HTTP 503 on the checkout service at 14:30 UTC.
     Pull the relevant container logs, check the related GitHub issue,
     write a 5-line incident summary to incident-503.md, and open a PR
     with it.
Agent
  ↳ calling bash_run(kubectl get pods -n prod -l app=checkout) ✓
  ↳ calling bash_run(kubectl logs … --since=2h) ✓
  ↳ calling bash_run(gh issue list --search "503 checkout") ✓
  ↳ calling agt_file_write(path="incident-503.md", …) ✓
  ↳ calling bash_run(gh pr create --fill) ✓
Done. Incident summary written and PR #214 opened. Root cause looks like …
```

In one turn the agent moved across **three wrapped CLIs**, a **first-party
file-write skill**, and the **shell** — exactly the cross-tool orchestration
the ladder builds toward.

**Make a Level-5 setup repeatable with a profile.** Profiles pin a whole
preset (provider/model, the mode via `cliParams.mode`, which tools are
exposed, default tool arguments) under a name:

```bash
# Capture your current working setup as a named profile
cli-agent profile-create incident-response --from-current \
  --description "docker+kubectl+gh, mutations on, prod context"

# Reuse it any time
cli-agent --profile incident-response "Triage the latest PagerDuty alert."

# See exactly what a profile would resolve to (no LLM, no tools run):
cli-agent profile-dry-run --profile incident-response
```

Profiles slot into the precedence chain *below* explicit CLI flags, so a
flag you pass at launch always wins over the profile.

### Auditing what the agent actually did

At Level 5 you're giving the agent real reach, so verify its work:

- **`--inspect-io`** records the exact request/response (assembled system
  prompt, full memory, bound tool schemas, every tool call + result) to a
  tailable JSONL file. Watch it live with
  `tail -f ~/.tool-agents/cli-agent/io-captures/latest.jsonl`, or inside
  the TUI use `/inspect show` to read a turn.
- **Structured logs** at `~/.tool-agents/cli-agent/logs/session-*.jsonl`
  capture every `tool_call` / `tool_result` with secrets redacted.
- **History & resume** (`--resume`) let you pick a long job back up with
  full conversational context.

---

## Turning the dials: landing on exactly the level you want

Four independent dials decide where on the ladder a session sits:

| Dial | Effect | Default |
|------|--------|---------|
| `--mode <chat\|basic\|tool\|composite>` | which tool groups load — `chat` = no tools at all; `basic` = the `agt_*` pack only (no shell); `tool` = built-in toolkit (`bash_*`, `tool_help`) + `agt_*` pack; `composite` = everything, incl. composite/virtual tools | `composite` |
| `--tool <name>` (repeatable) | wrap an external CLI (adds it to the allowlist + introspects it) — requires mode `tool` or `composite` | none |
| `--allow-mutations` | unlock every write-capable tool and side-effecting command | off (read-only) |
| `--enable-tool <name>` / `--disable-tool <name>` (repeatable) | switch a single `agt_*` tool on or off by its canonical name (e.g. `--disable-tool agt_grep`, `--enable-tool agt_todo_write`) | pack defaults |

`--mode` is a pinnable knob like `provider` or `model`: besides the flag it
has an env var (`CLI_AGENT_MODE`), a profile key (`cliParams.mode`), and a
`config.json` key (`mode`), resolved by the single uniform chain:

```
CLI --mode  >  CLI_AGENT_MODE (shell > ~/.tool-agents/cli-agent/.env > local ./.env)  >  profile cliParams.mode  >  config.json mode  >  default: composite
```

> **Removed (plan-015):** the old tool-group toggles —
> `--builtin-tools`/`--no-builtin-tools`, `--agent-tools`/`--no-agent-tools`,
> `--composites`/`--no-composites`, the 26 `--enable-agt-*`/`--disable-agt-*`
> per-tool flags, the `CLI_AGENT_DISABLE_*` env vars, and the matching
> `config.json`/profile group keys. Using any of them now fails fast with a
> migration hint pointing at `--mode` and `--enable-tool`/`--disable-tool`.
> The per-tool `CLI_AGENT_AGT_*` env vars and `agentTools.tools.*` config
> keys are unchanged.

**Recipes for each rung:**

```bash
# Level 0 — pure chat
cli-agent --mode chat "…"

# Level 1 — shell-focused, read-only (see the shell-only caveat at Level 1)
cli-agent --mode tool --bash-allow "git,ls,cat" "…"

# Level 2 — built-in file/search/web skills, read-only
cli-agent --mode basic "…"   # exactly the agt_* pack, nothing else
cli-agent "…"                # the default (composite) includes it too
#   …add write access:
cli-agent --allow-mutations "…"

# Level 3 — wrap external CLIs (the default mode, composite, is fine)
cli-agent --tool git --tool gh "…"

# Level 4 — build a composite, then attach it
cli-agent composite-synthesize --tool git --tool gh --composite-name rel --register-virtual
cli-agent --tool rel "…"

# Level 5 — everything, pinned in a profile (incl. cliParams.mode)
cli-agent --profile incident-response "…"
```

**How to verify what's actually loaded** before trusting a run:

- The startup notice (and `--verbose`) tells you when the catalog is empty.
- In the TUI, `/mode` prints the current mode (and `/mode <value>` switches
  it, rebuilding the catalog on the fly — switching to `chat` or `basic` is
  rejected while wrapped CLIs are loaded), `/tools list` shows the wrapped
  CLIs and `/capabilities` their freshness.
- `cli-agent profile-dry-run [--profile <name>]` prints the fully resolved
  config and the resulting tool catalog **without** launching the LLM.
- `--inspect-io` then `/inspect show` reveals the exact `boundTools` the
  model was given.

---

## Read-only vs read-write across the ladder

Safety scales with the rung, and the **mutation gate is the master
switch**. Without `--allow-mutations` the agent is read-only everywhere:

| Level | Read-only (default) | With `--allow-mutations` |
|------:|---------------------|--------------------------|
| 0 | nothing | nothing |
| 1 | run allow-listed, non-mutating commands | run side-effecting commands too |
| 2 | `agt_glob/grep/file_read/file_list/web_*` | also `agt_file_write/edit/append`, `agt_multiedit`, `agt_patch` |
| 3 | drive wrapped CLIs for inspection (e.g. `git log`, `kubectl get`) | drive write subcommands (e.g. `git push`, `kubectl apply`) |
| 4 | synthesise & inspect composites | composites that themselves perform writes |
| 5 | full-system *investigation* | full-system *operation* |

Other guardrails apply at every rung: the bash allowlist (empty by
default), `execFile`-only spawning (no shell injection), child-process env
stripping (`--bash-pass-secret` to opt a credential back in), the file
sandbox root, and redaction on every log write. Full detail in the
[security model](../../README.md#security-model) and
[enabling-write-capabilities](enabling-write-capabilities.md).

---

## Putting it all together: a realistic session

A single launch that exercises Levels 2 → 5 at once — wrapped CLIs, the
file skills, write access, and auditing — to take a feature branch from
"messy" to "PR opened":

```bash
cli-agent --tool git --tool gh \
  --allow-mutations \
  --bash-pass-secret GH_TOKEN \
  --inspect-io
```

```
You> Clean up this branch and open a PR:
     1) summarise what changed vs main,
     2) write a CHANGELOG.md entry for it,
     3) commit the changelog,
     4) push and open a PR titled after the summary.

Agent
  ↳ calling bash_run(git diff --stat main...HEAD) ✓        # L3, read
  ↳ calling bash_run(git log main..HEAD --oneline) ✓       # L3, read
  ↳ calling agt_file_read(path="CHANGELOG.md") ✓           # L2, read
  ↳ calling agt_file_edit(path="CHANGELOG.md", …) ✓        # L2, write (gated)
  ↳ calling bash_run(git add CHANGELOG.md) ✓               # L3, write (gated)
  ↳ calling bash_run(git commit -m "docs: changelog for …") ✓
  ↳ calling bash_run(git push -u origin HEAD) ✓
  ↳ calling bash_run(gh pr create --fill) ✓
Opened PR #218 "Add capability-levels guide and link from README".
Summary of changes: …
```

Everything it did is in
`~/.tool-agents/cli-agent/io-captures/latest.jsonl` and the session log —
inspect, replay your reasoning about it, and resume later if needed.

---

## Where to go next

- **[`docs/tools/cli-agent.md`](../tools/cli-agent.md)** — the complete
  reference: every flag, env var, config key, slash command, the
  agent-tools pack, the `--mode` knob, and composite tools.
- **[configuring-cli-agent](configuring-cli-agent.md)** — get a provider
  wired up (decision tree + recipes for all 8).
- **[enabling-write-capabilities](enabling-write-capabilities.md)** — the
  three write switches (`--allow-mutations`, the allowlist,
  `--bash-pass-secret`) with worked examples.
- **[`docs/design/configuration-guide.md`](../design/configuration-guide.md)**
  — per-variable how-to-obtain, storage, defaults, expiry tracking.
- **[`docs/design/project-functions.md`](../design/project-functions.md)** /
  **[`project-design.md`](../design/project-design.md)** — the functional
  requirements and architecture behind each rung.
