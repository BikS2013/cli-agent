# cli-agent — Functional Requirements

## FR-AGT-001: Agent CLI Binary

The system must provide a standalone CLI binary `cli-agent` that accepts a one-shot prompt
or enters an interactive REPL mode.

## FR-AGT-002: Multi-Provider LLM Support

The system must support eight LLM providers out of the box:
`openai`, `anthropic`, `gemini`, `azure-openai`, `azure-anthropic`, `ollama`, `litellm`, `mlx`.

## FR-AGT-003: Tool Declaration

The user must be able to declare wrapped CLI tools via `--tool <name>` (repeatable) and/or
`config.json: tools[]`. CLI tools are additive to the config array (deduped).

## FR-AGT-004: Bash Allowlist Auto-Seeding

Each declared tool binary must be automatically added to the bash allowlist at startup.
Additional entries can be added via `--bash-allow`, `--bash-allow-file`, and `BASH_ALLOWED_COMMANDS`.

## FR-AGT-005: Capability Discovery

At startup, for each declared tool, the system must:
1. Check PATH for the binary.
2. Validate the cache (binaryPath + mtime + versionHash).
3. On cache miss: invoke `--help`, `-h`, and `help <sub>` fallbacks.
4. Use the active LLM to extract subcommand names from the help text.
5. Drill into each subcommand's help (if `capabilities.depth >= 2`).
6. Compose and cache a Markdown capability document.

## FR-AGT-006: Capability Cache Invalidation

The capability cache must be invalidated when any of: binaryPath, binaryMtimeMs, or
versionHash changes. `--refresh-capabilities` must bypass the cache entirely.

## FR-AGT-007: USER-NOTES Preservation

The `<!-- USER-NOTES:START -->…<!-- USER-NOTES:END -->` block in a capability document
must be preserved byte-for-byte across any regeneration.

## FR-AGT-008: System Prompt Composition

The system prompt must include the base rules, the standard cross-cutting tools addendum,
and the compiled capability sections. Documents exceeding `maxBytesPerTool` must be
embedded as synopsis + TOC only, with the full body available on demand via `tool_help`.

The base rules text must be loaded from disk at runtime (not from a TypeScript constant).
Composition order: `<base text from cfg.systemPromptPath>` + `<capabilities section>` +
`<--system-file contents>` + `<--system inline text>`. The `--system` and `--system-file`
flags MUST NOT silently disappear when a custom base prompt is selected; they always
append on top of whichever base is in effect.

## FR-AGT-008a: External Default System Prompt with Selectable Override

The default system prompt must live on disk as a regular file the user can edit, not as
a hard-coded string in the binary. On first run the agent must seed
`~/.tool-agents/cli-agent/capabilities/system-prompt.md` with the built-in default
(mode `0600`); on subsequent runs the file on disk is the source of truth.

A new CLI flag `--system-prompt <path-or-name>` must select the BASE system prompt
according to these resolution rules:

| Input form                   | Resolution                                      |
|------------------------------|-------------------------------------------------|
| Absolute path                | Used verbatim.                                  |
| Bare filename (no separator) | Joined onto `cfg.capabilitiesDir`.              |
| Relative path with separator | Joined onto `process.cwd()`.                    |
| Flag omitted                 | `<capabilitiesDir>/system-prompt.md` (default). |

The selection must also be configurable via the env var `CLI_AGENT_SYSTEM_PROMPT` and
the `config.json` key `systemPromptFile`, participating in the standard four-tier
precedence chain (CLI flag > env (any tier) > config.json > default file path).

If the resolved path is missing or unreadable, the agent must raise a `UsageError`
(exit code 2) with a message naming the raw input value, the fully resolved absolute
path, and the resolution rules. There must be NO silent fallback to the built-in
default — the built-in is used only as the bootstrap seed for the default file.

## FR-AGT-009: Standard Cross-Cutting Tools

The agent must ship with: `file_read`, `file_list`, `file_write`, `file_edit`, `file_append`,
`web_search`, `web_fetch`, `bash_list_allowed`, `bash_which`, `bash_run`, `tool_help`.

## FR-AGT-010: Mutation Gating

`file_write`, `file_edit`, and `file_append` must be excluded from the LLM-visible catalog
unless `--allow-mutations` is set. `bash_run` must be visible when the allowlist is non-empty
(regardless of `--allow-mutations`), but with a `[READ-ONLY-AGENT]` prefix warning when
`--allow-mutations` is off.

## FR-AGT-011: Configuration Precedence (Policy A — shell-wins)

```
CLI flag > shell env var > ~/.tool-agents/cli-agent/.env > config.json > throw ConfigurationError
```
No fallback defaults for required values. Missing required value → exit 3.

## FR-AGT-012: Structured Logging

All runs must produce JSONL logs at `~/.tool-agents/cli-agent/logs/`. Logs must include at
least eight mandatory event kinds. All writes must be redacted. Logging must be default-on
and disableable via `CLI_AGENT_LOG=off`.

## FR-AGT-013: Exit Code Contract

| Code | Condition |
|---|---|
| 0 | Success |
| 1 | Unexpected error |
| 2 | Usage error |
| 3 | Configuration error |
| 4 | Auth error |
| 5 | Upstream / provider error |
| 6 | IO error |
| 130 | SIGINT during interactive session |

## FR-AGT-014: show-capabilities Subcommand

`cli-agent show-capabilities --tool <name>` must print the cached capability document to
stdout or exit 2 if the tool is not cached.

## FR-AGT-015: refresh-capabilities Subcommand

`cli-agent refresh-capabilities [--tool <name>]` must re-run discovery for the named tool or
all configured tools, printing a per-tool status table to stderr. The refresh path must
perform the COMPLETE capability investigation, including the LLM extractor invocation,
regardless of the size of the top-level `--help` output. The
`capabilities.skipLlmBelowBytes` small-tool fast path that fires during normal startup
discovery must be bypassed here so that an explicit user-driven refresh always produces a
fully LLM-analyzed capability document. The TUI `/refresh-capabilities` slash command shares
this contract.

## FR-AGT-016: Interactive Mode

`cli-agent --interactive` must start a readline REPL with in-process conversation memory.
`/exit`, `/quit`, and `/reset` slash-commands must be handled. SIGINT must exit with code 130.

## FR-AGT-017: Bash Security Invariants

- Allowlist enforcement before every spawn.
- `execFile`-equivalent semantics (no shell string, no pipes/redirects/globbing).
- Working directory sandbox enforced against `bash.allowedRoots`.
- Child env stripped to `passEnv` list; credential-shaped vars stripped unconditionally.
- Per-call timeout (max 300s); SIGTERM then SIGKILL after 2s.
- Per-stream output cap; truncation with `_truncated: true` marker.

## TUI Subsystem (FR-TUI-*)

### FR-TUI-001 — Bare invocation drops into the TUI
`cli-agent` with no positional prompt and no `-i`/`--interactive` enters the
raw-mode TUI. The legacy readline REPL remains accessible via `--interactive`
for non-TTY environments.

### FR-TUI-002 — TTY-incompatibility refusal
The TUI checks `process.stdout.isTTY`, `TERM != dumb`, and the explicit
`CLI_AGENT_NO_TUI=1` opt-out. On any failing condition the bare invocation
prints a friendly message pointing at `--interactive` and exits with code 2.

### FR-TUI-003 — Token-by-token streaming
The agent's response renders one chunk at a time via the new
`streamOneShot()` async generator over LangChain's `streamEvents v2`. Each
chunk is written directly to stdout — no buffering of the full response.

### FR-TUI-004 — Tool-call indicators
On `on_tool_start` the TUI prints `↳ calling <toolName>(...)`. On
`on_tool_end` it appends ` ✓ (Nms)`. The spinner switches its label to
"Processing tool result…" between events.

### FR-TUI-005 — ESC and Ctrl+C abort
Pressing ESC or Ctrl+C during a turn aborts the in-flight LLM call via an
`AbortController` whose `signal` is passed through `streamOneShot` into
LangChain. The TUI renders `[aborted]` and remains alive for the next turn.

### FR-TUI-006 — Multiline editing with universal Ctrl+J fallback
The line-editor implements byte-level escape framing per spec §5.1 and routes
printable bytes through a stateful UTF-8 decoder per spec §5.2. Shift+Enter is
accepted in every known encoding; Ctrl+J (0x0A) is the universal newline
fallback for terminals that send plain CR for both Enter and Shift+Enter.

### FR-TUI-007 — Slash command dispatcher
Names + aliases are case-sensitive. The 15 in-scope commands cover four
groups: core (/help /quit /new /clear), history+memory (/history /last /copy
/memory), runtime switching (/model /provider /tools /allow-mutations), and
capability inspection (/capabilities /refresh-capabilities /tool-help).

### FR-TUI-008 — Mid-session model swap
`/model <id>` rebuilds the LLM via the existing provider factory and re-creates
the agent graph in place. The thread persists; on construction error the
previous graph stays active.

### FR-TUI-009 — Mid-session provider swap
`/provider <name>` validates against `SUPPORTED_PROVIDERS` and reconstructs the
graph. On `ConfigurationError` (missing required env vars), the swap is
refused and the original error message is surfaced to the user.

### FR-TUI-010 — Runtime tool catalogue manipulation
`/tools add|remove|list [--save]` mutates the active wrapped-CLI list. `add`
triggers in-line capability discovery for the new tool. `--save` persists the
change to `~/.tool-agents/cli-agent/config.json`.

### FR-TUI-011 — Mutation gate toggle
`/allow-mutations on|off` flips the `cfg.allowMutations` flag and rebuilds the
tool catalog before the next user prompt.

### FR-TUI-012 — Capability freshness UI
`/capabilities` lists every active wrapped tool with a freshness column
(✓ fresh / ⚠ stale / ✗ missing) computed from the same `isCacheValid()` the
agent uses internally. `/refresh-capabilities` is the TUI twin of the existing
CLI subcommand.

### FR-TUI-013 — Cross-platform clipboard
`/copy` dispatches to `pbcopy` / `xclip` (with `xsel` fallback) / `clip.exe`
(WSL: `/mnt/c/Windows/System32/clip.exe`) via the `bash/exec.ts` spawner. The
internal allowlist is hard-coded and independent of `bash.allow`.

### FR-TUI-014 — History persistence
Per-thread JSONL files plus an atomic `index.jsonl` plus a `cursor.json`
stored under `~/.tool-agents/cli-agent/history/` (dir 0700, files 0600). Per-
turn records carry user prompt + assistant final text only; chunks remain in
`~/.tool-agents/cli-agent/logs/`.

### FR-TUI-015 — `llm_chunk` / `llm_final` log events wired
The streaming seam emits `llm_chunk` for every `on_chat_model_stream` event
and `llm_final` on `on_chat_model_end`. Both carry `sessionId` + `turnId` so
post-hoc analysis can group by turn. Closes the deferred logging item that
`runOneShotAgent`'s non-streaming path could not satisfy.
