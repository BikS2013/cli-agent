# Enabling write & mutation capabilities

> A user-focused walkthrough. By default, `cli-agent` is **read-only** —
> it cannot modify any file, run any "destructive" command, or do anything
> beyond reading and reporting. This guide shows you how to grant write
> capability when you actually want it, and how to keep that capability
> tightly scoped so the agent only touches what you intend.

## Quick recipes

If you just want the answer for a common case, copy one of these:

```bash
# 1. Let the agent edit files in your project (no external tools)
cli-agent --allow-mutations "rename every occurrence of FooBar to FooBaz under src/"

# 2. Let the agent run a wrapped CLI that writes (e.g. git, kubectl)
cli-agent --tool git \
          --allow-mutations \
          --bash-allow git \
          "create a commit with the current staged changes"

# 3. Let it use a CLI that needs a credential
cli-agent --tool gh \
          --allow-mutations \
          --bash-allow gh \
          --bash-pass-secret GH_TOKEN \
          "open a draft PR for the current branch"

# 4. Fine-grained: allow git commit but not git push --force
cli-agent --tool git \
          --allow-mutations \
          --bash-allow 'argv-regex:^git (status|diff|add|commit|log)\b' \
          "commit the staged work with a sensible message"
```

If those examples cover your case you can stop reading here. The rest of
the document explains the mental model and lets you compose your own
launches.

---

## The mental model

`cli-agent` exposes **two families of writing capability**, each with its
own switch:

1. **Native file tools** — agent-tools-pack tools called `agt_file_write`,
   `agt_file_edit`, `agt_file_append`, plus `agt_multiedit` and `agt_patch`.
   They write directly to the file system. The agent uses these when you ask
   it to "edit X" or "create a file Y". Read-only file access is handled by
   `agt_file_read` and `agt_file_list`.
2. **Wrapped external CLI tools** — anything you attach with `--tool foo`
   (e.g. `git`, `kubectl`, `aws`, your custom `telegram-cli`). The agent
   calls these through `bash_run`. Many of them have write-y subcommands
   (`git commit`, `kubectl apply`, `aws s3 cp …`).

Both are **off by default**. You unlock each of them with a separate
switch:

| Capability you want | What you turn on | Why |
|---|---|---|
| Native file writes (`agt_file_write`, `agt_file_edit`, `agt_multiedit`, etc.) | `--allow-mutations` | This is the global "I'm OK with the agent modifying things" switch. |
| Wrapped CLI writes (`git commit`, etc.) | `--allow-mutations` PLUS the binary on the bash allowlist | The mutation switch tells the agent it may issue write subcommands. The allowlist tells `bash_run` which binaries it may execute at all. Both are needed. |
| Wrapped CLI writes that need a token | All of the above PLUS `--bash-pass-secret <ENV_VAR>` | By default, environment variables that look like credentials are scrubbed before the binary runs. You re-allow specific ones explicitly. |

These three switches are independent. You can have any combination
(though "mutations on, allowlist empty" gives you nothing useful — the
agent still cannot run any external binary).

---

## Switch 1 — `--allow-mutations` (the global mutation gate)

This is the master switch for "the agent may make changes".

**With `--allow-mutations` ON:**
- The native write tools (`agt_file_write`, `agt_file_edit`, `agt_file_append`,
  `agt_multiedit`, `agt_patch`) are **registered** and visible to the
  LLM. It will use them when appropriate.
- `bash_run`'s description tells the LLM it is in **MUTATING** mode,
  which means it may issue write-y subcommands of any allow-listed
  binary.

**With `--allow-mutations` OFF (the default):**
- The native write tools are **never registered**. The LLM literally
  doesn't know they exist; it cannot invoke them at all.
- `bash_run` (if registered) operates in **READ-ONLY-AGENT** mode and
  the LLM is told to prefer non-modifying subcommands.

You can turn it on three ways, in order of precedence (CLI flag wins):

| Method | Example |
|---|---|
| CLI flag | `cli-agent --allow-mutations …` |
| Environment variable | `AGENT_ALLOW_MUTATIONS=true cli-agent …` |
| Persisted in `~/.tool-agents/cli-agent/config.json` | `{ "allowMutations": true }` |

**Inside the TUI**, you can toggle it without restarting:

```
/allow-mutations on
/allow-mutations off
/allow-mutations           ← shows the current state
```

The slash command rebuilds the tool catalog on the fly — the next message
you send sees the new posture.

### When to use which

- **Per-run flag** (`--allow-mutations`): the safest choice. You opt in
  for the specific session, and the next session is read-only again.
  Recommended default.
- **Env var**: convenient when you have a wrapper script or alias that
  should always run with mutations on.
- **`config.json`**: only if you genuinely want every invocation of
  `cli-agent` (from any directory, any context) to default to mutating.
  Reconsider whether you really want that.

---

## Switch 2 — the bash allowlist (which binaries `bash_run` may run)

`bash_run` is the only path through which the agent can spawn a child
process. It will execute **only** binaries that are explicitly on the
allowlist. Binaries you attach with `--tool foo` are **not**
automatically added; the allowlist is a separate concern.

There are three ways to add to the allowlist:

### Option A — `--bash-allow <csv>` (inline)

```bash
cli-agent --tool git --bash-allow git,gh,jq …
```

Comma-separated list. Each entry is the bare binary name; the agent
will accept any subcommand of that binary as long as the mutation
gate also allows it.

### Option B — `--bash-allow-file <path>` (from a file)

```bash
cli-agent --tool git --bash-allow-file ~/.tool-agents/cli-agent/bash-allow.txt …
```

One entry per line. Lines starting with `#` are comments. Same syntax
as the inline form, plus the `argv-regex:` prefix described below.

### Option C — `~/.tool-agents/cli-agent/config.json`

```json
{
  "bash": {
    "allow": [
      "git",
      "gh",
      "argv-regex:^kubectl (get|describe|logs)\\b"
    ]
  }
}
```

The persisted form. Automatically applied to every invocation.

### Fine-grained — `argv-regex:` entries

A bare entry like `git` allows **any** invocation of `git` (subject to
the mutation gate). If that's too coarse, prefix with `argv-regex:` and
provide a regex that matches the **full argv** (binary + arguments
joined by spaces):

```
argv-regex:^git (status|diff|log|add|commit)\b
argv-regex:^kubectl (get|describe|logs|top|explain) \b
argv-regex:^aws s3 (ls|cp|sync) \b
```

The regex is anchored at the start; the agent's exact argv must match
or `bash_run` rejects the call. This lets you allow `git commit` but
forbid `git push --force` even with `--allow-mutations` on.

### Why two switches instead of one?

The mutation gate (Switch 1) is about **intent** — "I'm OK with the
agent making changes". The allowlist (Switch 2) is about
**perimeter** — "these are the binaries the agent may invoke at all".

Decoupling them gives you flexible combinations:
- Mutation **off**, allowlist **populated** → agent can run read-only
  commands of allow-listed binaries (`git status`, `kubectl get`,
  `aws s3 ls`).
- Mutation **on**, allowlist **empty** → agent has the native file
  tools (`agt_file_write` etc.) but no `bash_run` at all. Useful when
  you only want code edits, no shell invocations.
- Mutation **on**, allowlist **populated with `argv-regex:` entries**
  → fully unlocked but each binary is constrained to specific
  subcommands.

---

## Switch 3 — `--bash-pass-secret <NAME>` (when the binary needs a token)

By default, `bash_run` strips most environment variables before
spawning the child process — credentials don't leak to allow-listed
binaries unless you explicitly allow it.

If your wrapped CLI needs a token (a `GH_TOKEN`, `OPENAI_API_KEY`,
database password, …), opt that variable in:

```bash
cli-agent --tool gh \
          --allow-mutations \
          --bash-allow gh \
          --bash-pass-secret GH_TOKEN \
          --bash-pass-secret GH_HOST \
          …
```

The flag is repeatable. Each `<NAME>` is a literal env var name read
from the launching shell's environment. The agent never sees the
value; it only forwards it to the child process.

**Persistent form** in `config.json`:

```json
{
  "bash": {
    "passSecret": ["GH_TOKEN", "AWS_PROFILE", "TELEGRAM_BOT_TOKEN"]
  }
}
```

If the binary tries to run without the credential, you'll see an
authentication error from the binary — that's your signal that the
secret needs a `--bash-pass-secret` entry.

---

## Putting it together — three worked examples

### Example A — "let the agent edit my project's code"

You want the agent to make code changes directly, no external CLI.

```bash
cli-agent --allow-mutations \
          "rename FooBar to FooBaz across src/ and tests/"
```

- `--allow-mutations` registers `agt_file_write` / `agt_file_edit` /
  `agt_file_append` / `agt_multiedit` / `agt_patch`.
- No `--bash-allow` is needed — you're not running any binary.
- All writes are confined to the configured file root. By default,
  that's the directory you launched `cli-agent` from. Set
  `AGENT_FILE_ROOT=…` or the `fileEdit.root` config key to point
  somewhere else.

### Example B — "let the agent run git for me"

You want the agent to issue git commands including writes (`commit`,
`merge`, `rebase`).

```bash
cli-agent --tool git \
          --allow-mutations \
          --bash-allow git \
          "review the staged changes and create a commit with a sensible message"
```

- `--tool git` introspects `git --help` and embeds git's subcommand
  surface into the system prompt, so the LLM knows *your* git's
  capabilities.
- `--allow-mutations` flips the mutation posture. Without it, the
  LLM is told to prefer read-only git subcommands.
- `--bash-allow git` puts `git` on the bash allowlist. Without it,
  `bash_run` rejects every git invocation.

If you want git but **only** safe subcommands, keep the mutation gate
on but tighten the allowlist:

```bash
cli-agent --tool git \
          --allow-mutations \
          --bash-allow 'argv-regex:^git (status|diff|add|commit|log|branch)\b' \
          …
```

That allows committing and branching but rejects `git push --force`,
`git reset --hard`, etc.

### Example C — "let the agent post to GitHub"

```bash
export GH_TOKEN="ghp_…"
cli-agent --tool gh \
          --allow-mutations \
          --bash-allow gh \
          --bash-pass-secret GH_TOKEN \
          "open a PR for the current branch with the description from CHANGELOG.md"
```

All three switches are needed:

- **Mutation gate**: `gh pr create` is a write operation.
- **Allowlist**: `gh` must be allow-listed for `bash_run` to run it.
- **Secret pass-through**: `GH_TOKEN` is normally scrubbed; you have
  to opt it in by name.

---

## Verifying your setup

### Check what the LLM actually sees

The new `show-tool-prompt` subcommand renders the effective tool
description the LLM will receive:

```bash
cli-agent show-tool-prompt --tool bash_run
```

Look at the description prefix:
- Starts with **`[MUTATING]`** → mutation gate is on.
- Starts with **`[READ-ONLY-AGENT]`** → mutation gate is off.

If you expected `[MUTATING]` and you see `[READ-ONLY-AGENT]`, your
flag isn't reaching the agent — check spelling, env var precedence
(CLI > env > config), or whether you're launching the wrong binary.

### Watch the agent reject something

If you turn the agent loose without the right switches, the rejection
itself is informative:

- "I cannot modify files in read-only mode" → mutation gate is off.
- `bash_run`-level "command not on allowlist" → the binary isn't in
  `--bash-allow` (or the allowlist regex doesn't match the agent's
  argv).
- The wrapped binary itself returns an auth error → the credential
  isn't in `--bash-pass-secret`.

### Inside the TUI

```
/allow-mutations            ← prints current state
/tools list                 ← shows registered tools (agt_file_write, etc., are visible
                              only when mutations are on)
```

---

## Safety tips

1. **Default to per-run flags, not persisted config.** `--allow-mutations`
   on the command line gives you per-session control; setting it
   globally in `config.json` removes that natural break point. Persist
   only if you really mean "every invocation, every directory".
2. **Use `argv-regex:` entries for high-blast-radius binaries.**
   `kubectl` and `aws` are the obvious ones — wide-open `kubectl` with
   mutations on means the agent could `kubectl delete namespace prod`
   if it misreads your prompt. `argv-regex:^kubectl (get|describe|logs)\b`
   keeps it useful while preventing irreversible damage.
3. **Set `fileEdit.root` to the smallest reasonable scope.** The
   default file root is the directory `cli-agent` was launched from.
   Native file writes can NEVER escape that root, even with mutations
   on. Launching from `~` exposes more than launching from `~/projects/myrepo`.
4. **Review the agent's plan before acting.** When `bash_run` is in
   `[MUTATING]` mode, individual destructive subcommands still require
   `confirmed: true`. The agent will lay out what it intends to run
   and ask. Read the plan before agreeing.
5. **Inspect logs after destructive sessions.** Every tool call is
   logged in JSONL form under `~/.tool-agents/cli-agent/logs/`. After
   a mutating session, `tail` the log to see what actually ran and
   double-check it matches your intent.

---

## Resetting / locking down

To revert to read-only:

- Remove `--allow-mutations` from your invocation. The next session
  will be read-only.
- If `allowMutations` is set in `config.json`, edit it to `false` (or
  delete the key — the default is `false`).
- Inside an active TUI session, `/allow-mutations off`.

To narrow the bash allowlist temporarily:

- Pass an `argv-regex:` entry instead of the bare name.
- Or remove the entry from `--bash-allow` / `bash-allow.txt` for the
  next launch.

There is no "undo" for already-applied writes — the file system and
external services don't roll back. If you're nervous about a
particular run, do a dry-run first:

```bash
# Read-only first, see what the agent would do:
cli-agent --tool git --bash-allow git "show me the commits I'd produce …"
# Then re-run with mutations once the plan looks right:
cli-agent --tool git --bash-allow git --allow-mutations "do it"
```

---

## See also

- [`docs/design/configuration-guide.md`](../design/configuration-guide.md)
  — full reference for every config option and its precedence.
- [`docs/tools/cli-agent.md`](../tools/cli-agent.md) — full per-tool
  reference, including the agent-tools pack (`agt_*` write tools that
  also respect `--allow-mutations`).
- [`docs/design/project-functions.md`](../design/project-functions.md)
  — `FR-AGT-010` (mutation gating policy) and `FR-AGT-017` (bash
  security invariants).
