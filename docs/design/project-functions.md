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
all configured tools, printing a per-tool status table to stderr.

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
