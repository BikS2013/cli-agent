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
1. Check whether `~/.tool-agents/cli-agent/capabilities/<tool>.md` already exists
   as a schema-supported capability document.
2. If it exists and refresh is not forced, treat the document as cached and skip
   binary probing, help probing, and LLM rediscovery.
3. If it is missing, unsupported, or refresh is forced: check PATH for the binary,
   invoke `--help`, `-h`, and `help <sub>` fallbacks, use the active LLM to extract
   subcommand names from the help text unless the normal-startup small-help fast path
   applies, drill into subcommand help when `capabilities.depth >= 2`, then compose
   and cache a Markdown capability document.

## FR-AGT-006: Capability Cache Refresh

Normal startup must trust an existing schema-supported capability document until
explicit refresh is requested; it must not require automatic invalidation on
`binaryPath`, `binaryMtimeMs`, or `versionHash` changes before using that document.
`--refresh-capabilities`, `cli-agent refresh-capabilities`, and the TUI
`/refresh-capabilities` command must bypass the cached-document shortcut and perform
fresh binary probing plus rediscovery.

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

The built-in cross-cutting toolkit ships with: `bash_run`, `bash_list_allowed`, `bash_which`,
`tool_help`. (plan-011: `web_search` / `web_fetch` left this built-in toolkit and re-entered as
the first-party `agt_web_search` / `agt_web_fetch` members of the agent-tools pack — see
FR-AGT-WEB-001. plan-012: `file_read` / `file_list` / `file_write` / `file_edit` / `file_append`
likewise left this toolkit and re-entered as the first-party `agt_file_read` / `agt_file_list` /
`agt_file_write` / `agt_file_edit` / `agt_file_append` members of the agent-tools pack — see
FR-AGT-FILE-001.)

## FR-AGT-010: Mutation Gating

`file_write`, `file_edit`, and `file_append` must be excluded from the LLM-visible catalog
unless `--allow-mutations` is set. (plan-012: these are now the agent-tools-pack members
`agt_file_write` / `agt_file_edit` / `agt_file_append`, mutation-gated in `group-builder.ts`;
the gating semantics are unchanged — see FR-AGT-FILE-001.) `bash_run` must be visible when the allowlist is non-empty
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
(✓ fresh / ⚠ stale / ✗ missing) computed diagnostically from
`getBinaryInfo()` + `isCacheValid()`. This UI can warn that the cached document
differs from the current binary, but normal startup still uses the doc-exists
shortcut until the user explicitly refreshes. `/refresh-capabilities` is the TUI
twin of the existing CLI subcommand and performs full rediscovery.

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

## Agent-tools Pack (FR-NEW-* / NFR-NEW-*)

Source: `docs/design/refined-request-agent-tools-integration.md` §Requirements,
locked by user decision (see `docs/design/plan-003-agent-tools-integration.md` §0)
and grounded in `docs/reference/investigation-agent-tools-integration.md`.

### FR-NEW-001 — Upstream inventory deliverable (Status: Accepted)

A Markdown document at `docs/reference/agent-tools-inventory.md` lists, for
each tool in `BikS2013/agent-tools`: tool name, one-line purpose, full
description, runtime/language, package dependencies, transport/interface,
input/output schema, mutating-vs-read-only classification, license, and a
"bundle / skip / sidecar" recommendation with rationale.

### FR-NEW-002 — Feasibility & rationality assessment (Status: Accepted)

The feasibility verdict is captured in `docs/reference/investigation-agent-tools-integration.md`
(rather than a separate `feasibility-*.md` file). It contains the summary
verdict ("Bundling rational with curated subset; opt-out via per-tool
config-flag gating, not describe-and-suppress"), evaluation of the proposed
pattern, alternative patterns side-by-side, scoring matrix, recommendation
with explicit opt-out surface, and acknowledgement of risks and rejected
options.

### FR-NEW-003 — Phase gate before planning (Status: Accepted)

The user signed off on the investigation verdict before the plan was created.
`docs/design/plan-003-agent-tools-integration.md` references the investigation
and was created after that sign-off.

### FR-NEW-004 — Standard-tool wrapping (Status: Accepted)

Each accepted upstream tool is exposed to the LLM as a first-class LangChain
tool registered through `src/agent/tools/registry.ts`, with: a stable
snake_cased name following the `agt_<name>` pattern (`agt_glob`, `agt_grep`,
`agt_multiedit`, `agt_patch`, `agt_todo_read`, `agt_todo_write`); a typed
Zod input schema and a documented output shape; logging compliant with the
existing JSONL schema (`tool_call`, `tool_result`); honoring the bash
sandbox / file sandbox / web header rules wherever applicable.

### FR-NEW-005 — System-prompt description block (Status: Accepted)

The new tools' descriptions are assembled into the system prompt by
`buildAgentToolsPromptBlock(meta)`, called inside `buildSystemPromptForCfg`
in `src/agent/system-prompt.ts`. Composition order: `<base text>` +
`<capabilities section>` + `<agent-tools block>` + `<--system-file contents>`
+ `<--system inline text>`. The block is byte-stable across runs unless
the registered set changes (umbrella off OR per-tool flags toggled).

### FR-NEW-006 — Runtime opt-out mechanism (Status: Accepted)

The user can disable the new tools (and their description block) for a
given run via:

  - CLI flags: `--no-agent-tools` (umbrella) and `--enable-agt-<tool>` /
    `--disable-agt-<tool>` per tool.
  - Env vars: `CLI_AGENT_DISABLE_AGENT_TOOLS=1` (umbrella) and
    `CLI_AGENT_AGT_<TOOL>=1|0` per tool.
  - `config.json`: `agentTools.enabled: bool` (umbrella) and
    `agentTools.tools.<tool>: bool` per tool.

The four sources obey the project's standard four-tier precedence
(FR-AGT-011: shell env wins among env tiers; CLI flag overrides all).
Granularity is **per-tool with a pack-level umbrella**.

### FR-NEW-007 — Mutation gating compliance (Status: Accepted)

`agt_multiedit` and `agt_patch` perform writes and are excluded from the
LLM-visible catalog when `--allow-mutations` is off, mirroring FR-AGT-010
for `file_write`/`file_edit`/`file_append`. `agt_todo_write` mutates only
in-memory session state and is therefore NOT mutation-gated.

### FR-NEW-008 — No silent fallbacks (Status: Accepted)

If a configuration value related to the new tools is required and missing,
the agent raises a `ConfigurationError` (exit code 3). No defaults, no
fallbacks (per project convention). Note: the agent-tools pack has no
required config — all flags have explicit default values applied AFTER
all four tiers have been consulted; defaults for optional config are
documented as starting values, not fallbacks.

### FR-NEW-009 — Documentation registration (Status: Accepted)

The new tools and the opt-out mechanism are registered in
`docs/design/project-functions.md` (this section), `docs/design/project-design.md`
(Tool Catalog table + new §4a), `docs/design/configuration-guide.md` (full
variable description per the configuration-guide template, including the
opt-out matrix), and `docs/tools/cli-agent.md` (new `<agentToolsPack>`
subsection).

### NFR-NEW-001 — Prompt-token budget (Status: Accepted)

The new description block's token contribution is measured with `js-tiktoken`
`cl100k_base` encoding (already a transitive dependency via `@langchain/core`
and `@langchain/openai` — no new direct dependency added). Per-tool fragment
ceiling: **400 tokens**. Default-on pack (4 tools) ceiling: **2 000 tokens**.
Full pack (6 tools) ceiling: **2 800 tokens**. Asserted by a Vitest spec
(`src/agent/tools/agent-tools/agent-tools-block.spec.ts`).

### NFR-NEW-002 — Startup latency (Status: Accepted)

Adding the new tools must not increase cold-start time of `cli-agent --help`
or a one-shot run by more than 100 ms. Verified by a smoke script that
times invocation before and after the integration.

### NFR-NEW-003 — Dependency footprint (Status: Accepted)

New runtime dependencies introduced: `fast-glob` and `ignore` (used by the
6 selected tools); `@vscode/ripgrep` as `optionalDependencies` (JS fallback
covers absence). Explicitly NOT added: `@mozilla/readability`, `jsdom`,
`turndown`, `dotenv` (those are for `webfetch`/`read` upstream tools that
are NOT bundled). `js-tiktoken` is reused from existing transitive deps.

### NFR-NEW-004 — Security posture (Status: Accepted)

Each wrapped tool routes all security-sensitive operations through
`cliAgentPermissionPolicy(cfg)` — the bridge factory in
`src/agent/tools/agent-tools/permissions.ts` that delegates `checkBash` to
cli-agent's bash allowlist, `checkFsRead`/`checkFsWrite` to cli-agent's
sandbox + mutation gate, and `scrubEnv` to cli-agent's existing credential
strip. The bridge is constructed once per session and shared across all
bundled wrappers.

### FR-AGT-WEB-001 — First-party web tools in the agent-tools pack (plan-011) (Status: Accepted)

`web_search` / `web_fetch` are removed from the built-in cross-cutting toolkit
and re-homed in the agent-tools pack as the first-party tools `agt_web_search`
/ `agt_web_fetch` — the ONLY non-vendored members of the `agt_` namespace. They
REUSE the existing cli-agent web backend (`src/agent/tools/web/backends/`); the
backend is not moved or duplicated. Both are read-only (no `--allow-mutations`
gate) and default ON, and they share a single per-session request budget
(`WEB_SEARCH_MAX_REQUESTS`, default 50). The backend, credentials, custom HTTP
URL/key, and request budget must be read from the resolved `AgentConfig.webSearch`
snapshot produced by `loadAgentConfig`, not from `process.env`, so shell env,
`~/.tool-agents/cli-agent/.env`, local `.env`, and CLI/config precedence stay
centralized. Governance:

  - They appear iff the agent-tools umbrella is on (`--agent-tools` / not
    `--no-agent-tools`) AND their per-tool flag is on.
  - Per-tool flags: `--enable/--disable-agt-web-search`,
    `--enable/--disable-agt-web-fetch`; env `CLI_AGENT_AGT_WEB_SEARCH` /
    `CLI_AGENT_AGT_WEB_FETCH` (tri-state); config.json
    `agentTools.tools.webSearch` / `.webFetch` (default `true`).
  - They are NOT affected by `--no-builtin-tools` (web is no longer built-in).
  - Profile name-based scoping works unchanged (`tools.deny: [agt_web_search]`).
  - The "never fabricate URLs" guidance now rides on the `agt_web_*` tool
    descriptions in the agent-tools prompt block; the built-in prompt block no
    longer mentions web.

### FR-AGT-FILE-001 — First-party file tools in the agent-tools pack (plan-012) (Status: Accepted)

`file_read` / `file_list` / `file_write` / `file_edit` / `file_append` are removed from the
built-in cross-cutting toolkit and re-homed in the agent-tools pack as the first-party tools
`agt_file_read` / `agt_file_list` / `agt_file_write` / `agt_file_edit` / `agt_file_append`.
They REUSE the existing first-party file logic and the sandbox
(`src/agent/tools/file/sandbox.ts`); no upstream read/write/edit/list tools are vendored and
no new runtime dependency is added (the rejected `@mozilla/readability` / `jsdom` / `turndown`
/ `dotenv` deps stay out). After this change the built-in toolkit contains ONLY `bash_run`,
`bash_list_allowed`, `bash_which`, and `tool_help`. Governance:

  - They appear iff the agent-tools umbrella is on (`--agent-tools` / not `--no-agent-tools`)
    AND their per-tool flag is on.
  - `agt_file_read` / `agt_file_list` are read-only (no `--allow-mutations` gate), default ON.
  - `agt_file_write` / `agt_file_edit` / `agt_file_append` are default ON but mutation-gated:
    they register only when the per-tool flag is on AND `cfg.allowMutations === true`
    (mirroring `agt_multiedit` / `agt_patch` and the former native `mutatingFile` gating).
    This preserves today's effective behavior exactly (read+list load by default; the three
    mutators load only with `--allow-mutations`).
  - Per-tool flags: `--enable/--disable-agt-file-read` (and `-file-list`, `-file-write`,
    `-file-edit`, `-file-append`); env `CLI_AGENT_AGT_FILE_READ` / `_LIST` / `_WRITE` /
    `_EDIT` / `_APPEND` (tri-state); config.json `agentTools.tools.fileRead` / `.fileList` /
    `.fileWrite` / `.fileEdit` / `.fileAppend` (default `true`). Four-tier precedence per
    FR-AGT-011 (CLI flag > shell env > config.json > default).
  - They are NOT affected by `--no-builtin-tools` (file tools are no longer built-in);
    `--no-agent-tools` / `--disable-agt-file-*` govern them.
  - Profile name-based scoping works unchanged (`tools.deny: [agt_file_write]`).
  - The file-tool guidance now rides on the `agt_file_*` tool descriptions in the agent-tools
    prompt block; the built-in prompt block no longer mentions file tools, and the dead
    `BuiltinToolsPresence.mutatingFile` flag is removed.

Reference: `docs/design/plan-012-file-ops-to-agt.md`,
`docs/reference/refined-request-file-ops-to-agt.md`,
`docs/reference/codebase-scan-file-ops-to-agt.md`.

## Acceptance Status — Agent-tools integration (refined-request acceptance criteria)

Snapshot taken at the end of U1–U6 implementation; final re-verification is
the integration verifier's responsibility (Phase 10). Each row maps an
acceptance criterion from
`docs/design/refined-request-agent-tools-integration.md` § Acceptance Criteria
to its current status.

| AC # | Criterion (abridged)                                                                                                                | Status |
|------|-------------------------------------------------------------------------------------------------------------------------------------|--------|
| 1    | `docs/reference/agent-tools-inventory.md` exists with all FR-NEW-001 fields                                                          | MET    |
| 2    | Feasibility verdict captured (in `investigation-agent-tools-integration.md`; user-approved in plan §0)                                | MET    |
| 3    | Plan file `docs/design/plan-003-agent-tools-integration.md` exists, references investigation, was created after sign-off              | MET    |
| 4    | Each accepted tool has TS module + Zod schema + registry entry + unit test                                                           | MET (modules under `src/agent/tools/agent-tools/agt-*.ts`; specs under same dir; registry wires them via `group-builder.ts`) |
| 5    | System-prompt block emits by default; absent under opt-out; both behaviors tested                                                    | MET (`agent-tools-block.spec.ts` + `system-prompt.spec.ts`) |
| 6    | Opt-out reachable from CLI flag, env var, `config.json` (TUI slash command not required by chosen pattern); precedence per FR-AGT-011 | MET (TUI slash command intentionally omitted — D6 selected discrete CLI flags + env + config.json; matches refined-request "if required") |
| 7    | Mutating tools (`agt_multiedit`, `agt_patch`) absent without `--allow-mutations`; verified by test                                   | MET (`group-builder.spec.ts`) |
| 8    | `project-design.md`, `project-functions.md`, `configuration-guide.md`, `docs/tools/cli-agent.md` updated coherently                   | MET    |
| 9    | `npm test` passes with new + existing specs                                                                                          | DEFERRED to Phase 10 verifier (build + test run is out-of-scope for U6 documentation unit) |
| 10   | `Issues - Pending Items.md` updated with deferrals                                                                                   | MET    |
| 11   | Token-budget assertion implemented as test, passing                                                                                  | MET (asserted in `agent-tools-block.spec.ts` per NFR-NEW-001 ceilings) |

## Tool Prompt Overlays (FR-OVR-*)

Plan reference: `docs/design/plan-004-tool-prompt-overlays.md`.
Design: `docs/design/project-design.md` §11.

### FR-OVR-001: Tool prompt overlay directory

`bootstrapAgentDir` creates `~/.tool-agents/cli-agent/tool-prompts/` (mode
`0700`) on first run if absent. The directory holds one user-editable
markdown file per registered tool. **Status: Accepted.**

### FR-OVR-002: Built-in tool prompt registry

A single registry (`src/agent/tools/tool-prompts-builtin.ts`) exports
`BUILTIN_TOOL_PROMPTS`, a frozen map from tool name to
`{ description, parameters }`. This is the authoritative source for
built-in defaults — every tool factory, the bootstrap seeder, the extract
command, and the audit command read from it. **Status: Accepted.**

### FR-OVR-003: Markdown overlay file format

Each `<tool>.md` file under `tool-prompts/` uses a fixed markdown shape:
H1 = canonical tool name; `## Description` body = tool description;
`## Parameters` with `### <param>` subsections for each parameter
description. No YAML frontmatter; no external parser dependency.
**Status: Accepted.**

### FR-OVR-004: Overlay loader

`loadOverlayRegistry(cfg)` reads every `*.md` file under the overlay dir,
validates structure (H1 matches filename; `## Description` non-empty;
no duplicate parameter names), and returns an `OverlayRegistry`. On any
parse / mismatch error: throws `ConfigurationError` naming the file. On
missing directory: returns empty registry (no overlays). **Status: Accepted.**

### FR-OVR-005: Tool factory integration

Every tool factory consults the registry via `getToolDescription` and
`getParamDescription` helpers; missing overlay = built-in default applies.
This is NOT a fallback for missing required configuration — it is the
explicit "no overlay" state and is the documented baseline. **Status: Accepted.**

### FR-OVR-006: First-run bootstrap (additive)

`bootstrapAgentDir` writes one overlay file per `BUILTIN_TOOL_PROMPTS`
entry on first run. On subsequent runs the seed is **additive only** —
existing files are never overwritten; only files for newly-added tools
(introduced in later releases) are seeded. A one-line stderr message
reports any newly-seeded files. **Status: Accepted.**

### FR-OVR-007: extract-tool-prompts subcommand

`cli-agent extract-tool-prompts [--force]` walks `BUILTIN_TOOL_PROMPTS`
and writes one overlay file per tool. Idempotent: existing files are
skipped unless `--force` is passed. Exits 0 on success; reports the
list of files written and skipped. **Status: Accepted.**

### FR-OVR-008: show-tool-prompt subcommand

`cli-agent show-tool-prompt --tool <name>` loads the overlay registry,
merges with built-in defaults, and prints the effective tool description
plus per-parameter descriptions to stdout. Used to verify overlays are
taking effect without launching the agent. Exits 1 if `<name>` is not
in `BUILTIN_TOOL_PROMPTS`. **Status: Accepted.**

### FR-OVR-009: audit-tool-prompts subcommand

`cli-agent audit-tool-prompts [--strict]` cross-checks every overlay
file against `BUILTIN_TOOL_PROMPTS`:
- overlays for tools no longer in the registry → warning
- parameters in overlay but not in built-in → warning
- parameters in built-in but missing from overlay → warning

Exits 0 unless `--strict` is set, in which case any warning yields
exit 1 (CI-gate use case). **Status: Accepted.**

### NFR-OVR-001: Subcommand --tool flag immune to parent shadowing

All three new subcommands (`extract-tool-prompts`, `show-tool-prompt`,
`audit-tool-prompts`) use the `cmd.optsWithGlobals()` + `pickFirstTool()`
recovery pattern from `src/cli.ts` to avoid the Commander.js parent-program
`--tool` shadowing bug fixed in 0.1.1. **Status: Accepted.**

### NFR-OVR-002: Registry-completeness invariant

A test asserts that every tool name returned by `buildToolCatalog(cfg)`
under default config has a matching entry in `BUILTIN_TOOL_PROMPTS`. This
catches the "added a new tool, forgot to register its prompt" regression
at CI time. **Status: Accepted.**

## Configuration Profiles (FR-PROF-*)

Plan reference: `docs/design/plan-005-config-profiles.md`.
Refined request (canonical authoritative source for the full 16 functional
requirements, 22 acceptance criteria, and 23 enumerated edge cases):
`docs/design/refined-request-config-profiles.md`.
Investigation: `docs/reference/investigation-config-profiles.md`.
Design: `docs/design/project-design.md` §12 (added in plan-005 P2).

A "configuration profile" is a named, persistent harness preset stored under
`~/.tool-agents/cli-agent/profiles/<name>.{yaml|yml|json}` (directory mode
`0700`, files mode `0600`) that bundles three orthogonal optional sections —
`cliParams`, `tools`, `toolArgs` — into one launch-time preset, activated via
`--profile <name>` or `CLI_AGENT_PROFILE=<name>`. Profiles slot into the
existing four-tier configuration resolution chain at a new tier 5, between
local `./.env` and `~/.tool-agents/cli-agent/config.json`. Explicit CLI flags
ALWAYS win (the central user-facing invariant). Profiles coexist with the
plan-004 tool-prompt overlay system orthogonally — overlays change tool
*prompt text*, profiles change *which tools are exposed* and *what default
arguments they carry*.

The entries below summarise the high-level functional capabilities; the
refined request file remains the canonical authoritative version.

### FR-PROF-001: Profile storage layout

`bootstrapAgentDir` ensures `~/.tool-agents/cli-agent/profiles/` exists at
mode `0700` on first run. Each profile file is created at mode `0600`. Both
YAML (`.yaml`/`.yml`) and JSON (`.json`) extensions are supported on read;
`profile-create` writes YAML by default. **Status: Accepted (Plan 005).**

### FR-PROF-002: Profile schema (v1)

A profile is a structured document with three independent, all-optional
top-level sections: `cliParams` (preset values for any pinnable cli-agent
knob), `tools` (broad-scope tool list scoping with sub-keys `allow`, `deny`,
`order`), and `toolArgs` (per-tool argument presets). Top-level keys are
validated by a Zod schema (`.strict()` at the top, `.passthrough()` on
`cliParams`); unknown top-level keys are hard errors, unknown `cliParams`
keys produce stderr warnings (forward-compat across cli-agent versions).
**Status: Accepted (Plan 005).**

### FR-PROF-003: Activation surface

Profiles are activated via the `--profile <name>` CLI flag (highest
priority) or the `CLI_AGENT_PROFILE` environment variable (used only when
the flag is absent). When neither is set, no profile is active and behavior
is identical to the pre-feature baseline. A missing named profile produces
a `UsageError` exit 2 with a diagnostic message listing existing profiles.
**Status: Accepted (Plan 005).**

### FR-PROF-004: Precedence (the central invariant)

Profile `cliParams` participate in the resolution chain at tier 5, between
local `./.env` (tier 4) and `~/.tool-agents/cli-agent/config.json` (tier 6).
The composed order from highest to lowest priority is:
1. CLI flag, 2. shell env, 3. agent-dir `.env`, 4. local `./.env`,
5. **profile cliParams (NEW)**, 6. config.json, 7. built-in defaults.
**Explicit CLI flags supplied at invocation ALWAYS win over profile values.**
**Status: Accepted (Plan 005).**

### FR-PROF-005: Tool list scoping semantics

The registered tool catalog (post-mutation-gating, post-agent-tools-flags)
is filtered by the profile's `tools` section in strict order:
**`allow` → `deny` → `order`**. Each sub-key is independently optional. An
`allow ∩ deny ≠ ∅` is a hard error, as is a duplicate name in `order`, as
is an empty post-scoping catalog. Unknown names in `allow`/`deny`/`order`
produce stderr warnings and are silently dropped (forward-compat).
**Status: Accepted (Plan 005).**

### FR-PROF-006: Per-tool argument merge

For every tool invocation, the effective argument object is computed as
`{ ...profile.toolArgs[toolName], ...runtimeArgs }` — a shallow per-key
merge where runtime arguments win on a per-key basis. Profile-set
arguments for keys NOT supplied at runtime continue to apply. Validation
uses each tool's input Zod schema in `.partial()` form at profile-load time
for tools with known schemas; tools with dynamic schemas defer validation
to runtime. **Status: Accepted (Plan 005).**

### FR-PROF-007: Activation telemetry

When a profile is active, the structured JSONL session log includes a
`profile_active` event near `session_start` carrying: profile name,
resolved file path, schema version, and a SHA-256 hex prefix (first 16
chars) digest of the raw file contents. Hash-only — raw contents are never
logged. **Status: Accepted (Plan 005).**

### FR-PROF-008: profile-list subcommand

`cli-agent profile-list` enumerates all profiles in
`~/.tool-agents/cli-agent/profiles/` with columns: name, description, file
size, mtime. Exits 0 even when the directory is empty. Exits 6 (IO error)
on filesystem failure. **Status: Accepted (Plan 005).**

### FR-PROF-009: profile-show subcommand

`cli-agent profile-show <name>` parses the named profile, validates it,
and prints the raw file contents, the parsed/normalized form, and a
summary block (pinned cliParams, resulting tool catalog, per-tool args).
Exits 0 / 2 / 3 per standard config validation contract. **Status: Accepted (Plan 005).**

### FR-PROF-010: profile-create subcommand

`cli-agent profile-create <name> [--from-current] [--description "..."] [--force]`
scaffolds a new profile YAML stub at mode `0600`. With `--from-current`,
captures the currently resolved configuration into `cliParams`. Exits 2 if
`<name>` exists without `--force`. **Status: Accepted (Plan 005).**

### FR-PROF-011: profile-edit subcommand

`cli-agent profile-edit <name>` opens the profile file in `$EDITOR`
(falling back to `$VISUAL`, then platform default). After the editor
exits, the file is re-validated; on validation failure the file is left
as-is and an exit-2 diagnostic is printed. The codec re-validates only;
it does not re-write the file (preserves user formatting and comments).
**Status: Accepted (Plan 005).**

### FR-PROF-012: profile-delete subcommand

`cli-agent profile-delete <name> [--yes]` deletes the profile file after
a confirmation prompt (skipped with `--yes`). Exits 2 if `<name>` does not
exist. **Status: Accepted (Plan 005).**

### FR-PROF-013: profile-dry-run subcommand

`cli-agent profile-dry-run [--profile <name>] [other flags] [--json]`
performs the full configuration resolution (env + .env + profile +
config.json + CLI flags) and the full tool-scoping pass against the
registered catalog, then prints a human-readable report (default) or JSON
(with `--json`) of the effective configuration that would be used to
launch the agent. It does NOT instantiate the LLM, run capability
discovery, or execute any tools. Per-knob source attribution
(`cli-flag` / `env:VAR` / `local-.env` / `profile:<name>` / `config.json` /
built-in default) accompanies each pinned value. **Status: Accepted (Plan 005).**

### FR-PROF-014: Documentation registration

The feature is registered in `docs/design/project-functions.md` (this
section), `docs/design/project-design.md` §12 (added in plan-005 P2),
`docs/design/configuration-guide.md` (new "Configuration Profiles"
section), and `docs/tools/cli-agent.md` (`<configurationProfiles>`
subsection). **Status: Accepted (Plan 005).**

### FR-PROF-015: No silent fallbacks

A missing required configuration value remains a `ConfigurationError`
(exit 3). Profiles never substitute a missing required value with a
default silently — they are an additional source of explicit values, not a
fallback mechanism. Per project rule: "no fallback for required values."
**Status: Accepted (Plan 005).**

### FR-PROF-016: Coexistence with tool-prompt overlays

Profiles and overlays are orthogonal: overlays
(`~/.tool-agents/cli-agent/tool-prompts/<tool>.md`) change a tool's
*prompt text*; profiles change *which tools are exposed* and *what default
arguments they carry*. When a profile excludes a tool from the catalog,
the corresponding overlay file remains on disk untouched and is simply
unused for that run. When a profile's `toolArgs` references a tool
excluded by `tools.allow`/`deny`, the reference is dead-code and produces
a stderr warning at load time (non-fatal).
**Status: Accepted (Plan 005).**

### NFR-PROF-001: Startup latency

Profile loading and validation must add no more than 50 ms to cold-start
time in the no-profile case (short-circuit when `--profile` and
`CLI_AGENT_PROFILE` are both unset) and no more than 100 ms in the
with-profile case for a typical profile (≤ 32 KB). A smoke script in
`test_scripts/` enforces the regression budget. **Status: Accepted (Plan 005).**

### NFR-PROF-002: File mode invariants

Profile files are always created at mode `0600`; the `profiles/` directory
is always at mode `0700`, matching the rest of `~/.tool-agents/cli-agent/`.
Asserted by a unit test extending the existing `bootstrapAgentDir` mode
checks. **Status: Accepted (Plan 005).**

### NFR-PROF-003: Schema validation with Zod

The profile schema is expressed as a Zod schema in TypeScript and reused
by the loader, the `profile-show` / `profile-dry-run` subcommands, and
`profile-create --from-current`. No ad-hoc parsers. **Status: Accepted (Plan 005).**

### NFR-PROF-004: Test coverage

Unit + integration tests cover every edge case E1–E23, the precedence
chain (CLI flag wins for at least three distinct knobs), tool-scoping
ordering (`allow → deny → order`), `toolArgs` merge semantics, and at
least one full end-to-end test that launches with `--profile` and verifies
the active tool catalog matches the profile. **Status: Accepted (Plan 005).**

## Capability Recipes & Manual Reference (FR-CAP-*)

### FR-CAP-101: Manual-reference auto-detection

`refresh-capabilities` (and the implicit discovery on first agent
startup) probe `man -w <tool>` to detect whether the wrapped binary has
a man page. When present, the capability document records `manRef:
man:<section> <tool>` and `manPagePath: <absolute path>` in the YAML
frontmatter, and emits a small `## Manual reference` section inside the
AUTO-GENERATED block telling the agent how to read it (`man <section>
<tool>`). When absent, neither artifact appears — there is no fallback,
no synthesised pointer. **Status: Accepted.**

### FR-CAP-102: User-curated recipes block

Each capability document carries a `<!-- USER-RECIPES:START --> ...
<!-- USER-RECIPES:END -->` marker pair. Content placed inside is
preserved verbatim across every refresh, identical to the existing
USER-NOTES guarantee. The block appears BEFORE the USER-NOTES block in
the rendered file because it is the more frequently-edited section.
**Status: Accepted.**

### FR-CAP-103: Schema-2 capability documents

`schemaVersion: 2` documents add the `manRef` / `manPagePath`
frontmatter fields and the USER-RECIPES marker pair. v1 documents are
treated as cache miss on read and re-discovered, with USER-NOTES carried
forward via the existing preservation path. **Status: Accepted.**

### FR-CAP-104: tool_help section dispatch

`tool_help`'s `section` argument accepts `recipes` and `manref` in
addition to the existing `full`/`frontmatter`/`synopsis` values. Both
return the corresponding section body (markers stripped, trimmed,
truncated to `cfg.perToolBudgetBytes`). Empty string is returned when
the artifact is absent. **Status: Accepted.**

### FR-CAP-105: System-prompt integration

The "Wrapped CLI Capabilities" section of the system prompt embeds the
USER-RECIPES content verbatim (when within byte budget). When the
per-tool byte budget is exceeded, the compact entry preserves the
manRef pointer and a one-line "recipes available — call `tool_help`
with `section: \"recipes\"`" hint instead. **Status: Accepted.**

### FR-CAP-106: extract-recipes subcommand

`cli-agent extract-recipes --tool <name> [--max-recipes N] [--stdout]
[--append]` reads the cached capability doc and (when `manRef` is
present) the man page, feeds them through the configured LLM, and
emits recipes in the documented `### <name>` + fenced-bash format.

Default behavior writes the proposal directly between the existing
`<!-- USER-RECIPES:START --> / <!-- USER-RECIPES:END -->` markers in
the capability document, replacing any existing inner content. The
user is the curator and prunes whatever they don't want by hand.
`--stdout` prints to stdout without touching the file (for piping /
review / CI). `--append` keeps existing recipes and appends the new
ones instead of replacing.

When the document is missing the USER-RECIPES marker pair (e.g. an
old schema-1 doc), the default-write path raises `UsageError` with a
message pointing the user at `refresh-capabilities`. Hard upper
bound: 20 recipes; default: 8. **Status: Accepted.**

### FR-CAP-107: No fallback on man-page detection failure

When `man -w <tool>` returns non-zero / empty / unparseable output, or
`man` itself is absent on the host, `manRef` is recorded as `null` and
the document omits both the frontmatter line and the inline section
entirely. There is no "no manual page available" placeholder. Per
CLAUDE.md, the absence is the explicit "no man page" state, not a
substituted default. **Status: Accepted.**

### FR-CAP-108: extract-recipes input validation

`extract-recipes` raises `UsageError` when `--tool` is omitted or
`--max-recipes` is non-positive, and `CapabilityError` when the
capability document is absent (`E_CAPABILITY_NOT_FOUND`). These error
shapes match the existing capability-tool error contract.
**Status: Accepted.**

### NFR-CAP-101: Discovery cost ceiling

Manual-reference detection adds at most one `man -w <tool>` spawn per
discovery run, bounded by `cfg.capabilities.timeoutMs` (default 5000
ms). On hosts with `man` installed the call typically completes in
under 50 ms; on hosts without `man` the spawn fails fast with
`exitCode: 1` and `manRef: null` is recorded. The detector is NOT
behind a feature flag — the cost is too small to warrant config
surface. **Status: Accepted.**


## FR-EXR — TUI exit and JSON-snapshot resume (plan-005)

### FR-EXR-001: Double Ctrl+C exit

When the TUI input prompt receives a SIGINT, the controller records the
timestamp and prints a hint that mentions the second-press exit window.
A second SIGINT received within 1500 ms of the first triggers the same
graceful shutdown path as `/quit` and Ctrl+D-on-empty (`session_end`
log entry, `persistIndex`, `logger.close`, `exit(0)`). A second SIGINT
arriving after the window only resets the hint timestamp; it does not
exit. **Status: Accepted.**

### FR-EXR-002: Per-turn checkpoint snapshot

After every `TuiController.runTurn` (success or abort), the controller
writes a JSON snapshot of `agentGraph.checkpointer` filtered to the
active threadId to
`~/.tool-agents/cli-agent/history/checkpoint-<threadId>.json` (mode
0600, atomic tmp + rename). A snapshot write failure is logged as a
dim warning to stderr and does NOT abort the session — the prior
snapshot on disk (if any) remains valid. **Status: Accepted.**

### FR-EXR-003: Snapshot schema (version 1)

Snapshots contain: `version: 1`, `threadId`, `savedAt` (ISO 8601),
`checkpointerKind: "MemorySaver"`, `storage` (mirroring
`MemorySaver.storage[threadId]` with `Uint8Array` blobs encoded as
base64 strings), and `writes` (mirroring entries of `MemorySaver.writes`
whose outer key parses to a `[threadId, ns, checkpointId]` array
matching the active thread). **Status: Accepted.**

### FR-EXR-004: --resume / -r CLI flag

`cli-agent --resume [<threadId>]` (alias `-r`) is accepted only when
the bare TUI is dispatched (no positional prompt, no `--interactive`).
Combining `--resume` with `--interactive` or with a positional prompt
exits with code 2 and a clear error message. Omitting the threadId
resolves it from `cursor.json`'s `lastThreadId`. **Status: Accepted.**

### FR-EXR-005: Resume hydration order

On a `--resume` request the agent: (a) resolves the target threadId,
(b) builds the runtime (fresh MemorySaver), (c) calls
`loadCheckpoint(threadId, checkpointer)`, (d) constructs the
`TuiController`, (e) calls `controller.applyResume(threadId,
startedAt, messages)` with messages reconstructed from the thread JSONL
transcript. Hydration MUST happen before the first turn so the LLM
sees the prior conversation as part of its checkpointed state.
**Status: Accepted.**

### FR-EXR-006: Resume failure modes

`--resume` exits with code 2 (UsageError) when:
  - The bare flag is used and `cursor.json` does not exist
    ("no prior session to resume").
  - The resolved threadId has no `checkpoint-<threadId>.json` file.
  - The snapshot file has a `version` other than 1, a non-matching
    `threadId`, or a `checkpointerKind` other than `MemorySaver`.
No silent fallback to a fresh thread. **Status: Accepted.**

### FR-EXR-007: /resume slash command

The `/resume [<threadId>]` slash command performs the same hydration
mid-session: it persists the current thread's index entry, builds a
new agent graph, calls `loadCheckpoint`, and swaps
`controller.agentGraph` plus the displayed messages. If the target
thread is the one already active, it prints a no-op notice. If no
snapshot exists for the requested thread, it prints a friendly hint
(this is mid-session — exiting with code 2 would be hostile).
**Status: Accepted.**

### FR-EXR-008: No automatic snapshot pruning

cli-agent does NOT auto-delete old `checkpoint-<threadId>.json` files,
JSONL transcripts, or index entries. Users prune manually. The
`/history` slash command surfaces the available threads.
**Status: Accepted.**

### FR-EXR-009: Banner hints

When `--resume` was used, the TUI banner appends
`Resumed thread <prefix> (<n> prior turns restored)` in green. When
the bare TUI is launched without `--resume` and `cursor.json` exists,
the existing "Last thread:" hint is enriched with
`— pass --resume to continue` if and only if a checkpoint snapshot
exists for the recorded threadId. **Status: Accepted.**


## Composite Intelligent Tools (FR-CMP-*)

Plan reference: `docs/design/plan-006-composite-tools.md`.
Refined request (canonical authoritative source for the full 22 functional
requirements, 7 NFRs, 27 acceptance criteria, 23 enumerated edge cases, and
the `--treat-as-tool` flag-interaction matrix):
`docs/design/refined-request-composite-tools.md`.
Investigation: `docs/reference/investigation-composite-tools.md`.
Research (provider prompt cache): `docs/research/llm-prompt-caching-providers.md`.
Research (POSIX shim): `docs/research/posix-wrapper-shim-design.md`.
Codebase scan: `docs/reference/codebase-scan-composite-tools.md`.
Design: `docs/design/project-design.md` §14 (added in plan-006 P2).

A "composite intelligent tool" packages a curated cli-agent invocation
(`cli-agent --tool A --tool B …`) as a *new* tool that another cli-agent can
attach with a single `--tool <composite-id>`. v1 ships three opt-in
distribution forms: (a) a synthesised schema-3 capability document at
`~/.tool-agents/cli-agent/capabilities/composite/<id>.md`; (b) a POSIX
`/bin/sh` wrapper shim at `~/.tool-agents/cli-agent/composites/<id>/<id>`;
(c) a virtual-tool manifest at
`~/.tool-agents/cli-agent/composites/<id>/manifest.json` consumed by the
cli-agent tool registry at startup. A two-stage LLM synthesis pipeline
(per-member distill → compose) runs against the same provider/model the
outer cli-agent run resolved through the standard 4-tier chain. The pipeline
caches Stage-1 outputs per-member at
`capabilities/composite/_distill/<member>@<digest>.json` and applies
provider-side prompt caching at Stage-2 via a provider-agnostic
`withSynthesisCache(messages, prefixEndIndex)` helper. Composite docs and
artifacts are subject to the existing file-mode invariants (`0700` dirs,
`0600` doc/manifest, `0755` shim).

The entries below summarise the high-level functional capabilities; the
refined request file remains the canonical authoritative version.

### FR-CMP-001: `--treat-as-tool` is metadata when used alone

Supplying `--treat-as-tool` without `--help`, `--emit-*`, or
`--register-virtual` produces byte-identical runtime behavior to the
equivalent invocation without the flag. The flag exists to gate the
help-synthesis path and to mark the run as a composite candidate.
**Status: Accepted (Plan 006).**

### FR-CMP-002: `--help` re-routing under `--treat-as-tool`

When BOTH `--treat-as-tool` AND `--help` are supplied AND at least one
`--tool` is declared, cli-agent runs the synthesis pipeline (or loads from
the cache) and prints the resulting capability document on stdout, then
exits 0. Without `--treat-as-tool`, `--help` prints cli-agent's own help
exactly as today (NFR-CMP-001 / AC-1 — pinned by a baseline snapshot test).
**Status: Accepted (Plan 006).**

### FR-CMP-003: Empty member list under `--treat-as-tool --help`

`cli-agent --treat-as-tool --help` with no `--tool` arguments and no
profile-supplied member list exits 2 (`UsageError`) with the message
`composite synthesis requires at least one --tool argument`. There is no
degenerate doc; this is an explicit error per the no-fallback rule.
**Status: Accepted (Plan 006).**

### FR-CMP-004: Schema-3 capability document

The synthesised composite document carries frontmatter:
`schemaVersion: 3`, `composite: true`, `compositeName: <id>`,
`members: [<sorted>]`, `memberDigests: { <name>: <sha256-hex-prefix-16> }`,
`synthesizedAt`, `syntheticDigest`, `cliAgentVersion`,
`synthesisModel: <provider>:<model-id>`, `activeProfile: <name | null>`,
`manRef: null`, `manPagePath: null`. The body section sequence
(synopsis, AUTO-GENERATED block, USER-RECIPES, USER-NOTES) matches the
discovery-doc shape so that an outer cli-agent's existing capability
consumer loads it transparently. **Status: Accepted (Plan 006).**

### FR-CMP-005: Schema validator parity

The schema-3 doc passes the same structural validators that schema-2 docs
pass (frontmatter delimiters, AUTO-GENERATED markers, USER-RECIPES markers,
USER-NOTES markers, H1 = canonical tool name). The capability loader
accepts `schemaVersion ∈ {2, 3}`; v1 docs remain a cache miss.
**Status: Accepted (Plan 006).**

### FR-CMP-006: Two-stage synthesis pipeline

Stage 1 distills each member tool's capability doc into a structured
"intent surface" (top intents, parameter glossary, illustrative examples)
at ≈500 tokens per member. Stage 2 composes the array of Stage-1 outputs
into the AUTO-GENERATED body plus a curated USER-RECIPES block. The
pipeline uses the LLM provider/model already resolved for the cli-agent
run; no alternate auth path. Stage-1 outputs are cached on-disk, keyed by
`(member-doc-digest, distill-template-version, model-id)`. Stage-2
applies provider-side prompt caching via the `withSynthesisCache` helper.
**Status: Accepted (Plan 006).**

### FR-CMP-007: `--dry-run-synthesis`

`cli-agent --treat-as-tool --tool A --tool B --dry-run-synthesis` prints
both stage prompts (with sha256 digests) to stdout, contacts no LLM,
writes no cache, and exits 0. Allowed alongside `--help`; in that
combination the dry-run output replaces the synthesised doc on stdout.
**Status: Accepted (Plan 006).**

### FR-CMP-008: Synthesis token budget

`--synthesis-budget-tokens <n>` (config key `composite.synthesisBudgetTokens`,
env `CLI_AGENT_COMPOSITE_BUDGET`) caps the combined input+output token
count of the two-stage pipeline. Default `32 768`. Mid-pipeline overrun
aborts synthesis with `UsageError` exit 2 naming consumed/cap. No
automatic fallback to a smaller pipeline. **Status: Accepted (Plan 006).**

### FR-CMP-009: Cache key + hit semantics

Cache file path: `~/.tool-agents/cli-agent/capabilities/composite/<id>.md`.
Cache key: `sha256(sortedMembers ‖ memberDigests ‖ cliAgentVersion ‖
COMPOSITE_CAPABILITY_SCHEMA_VERSION ‖ compositeName ‖ synthesisModel)`.
A hit serves the cached doc verbatim. Member-tool overlay edits do NOT
invalidate the cache in v1 (Open Question O-1 / ADR-CMP-7); the user
forces a fresh synthesis with `--regenerate-capabilities`. The current
effective overlay digest is recorded in the
`composite_synthesis_start.currentEffectiveOverlayDigests` JSONL field
for v1.1 instrumentation. **Status: Accepted (Plan 006).**

### FR-CMP-010: `--regenerate-capabilities`

When supplied alongside `--treat-as-tool`, this flag forces a fresh
synthesis even on cache hit, atomically replacing the cached file. The
existing `<!-- USER-RECIPES:START -->…` and `<!-- USER-NOTES:START -->…`
blocks are preserved byte-for-byte across the rewrite. **Deviation from
spec wording**: per ADR-CMP-3, `--regenerate-capabilities` and the existing
`--refresh-capabilities` are NOT aliases; supplying
`--regenerate-capabilities` *without* `--treat-as-tool` produces a
`UsageError` exit 2 with a guidance message pointing to
`--refresh-capabilities`. **Status: Accepted (Plan 006).**

### FR-CMP-011: `--composite-name <id>` and derivation

When supplied, `<id>` is used verbatim and must match
`^[a-z][a-z0-9_-]{0,62}$` (violation → exit 2). When omitted, the name is
derived as `<sorted-members-joined-by-+>@<hash8>` where `<hash8>` is the
first 8 hex chars of sha256 over the canonical input set defined in
FR-CMP-009 keys 1–4. Example: `file-cli+outlook-cli@a1b2c3d4`.
**Status: Accepted (Plan 006).**

### FR-CMP-012: `--emit-doc` (distribution form a)

Default ON whenever `--treat-as-tool` is in effect. Writes the synthesised
doc to the cache path defined in FR-CMP-009 at mode `0o600`; the
`composite/` directory at mode `0o700`. `--no-emit-doc` opts out
(synthesis still runs; output goes to stdout only).
**Status: Accepted (Plan 006).**

### FR-CMP-013: `--emit-wrapper` (distribution form b)

Default OFF. When supplied, after successful synthesis cli-agent writes a
POSIX `/bin/sh` shim at `~/.tool-agents/cli-agent/composites/<id>/<id>`
(mode `0o755`) plus the manifest. The shim's body, on `--help`, `cat`s the
cached composite doc to stdout and exits 0; on any other invocation, it
`exec`s the absolute-resolved cli-agent path with the recorded
`--tool <m1> --tool <m2> …` list and the user's positional args; on
missing cache, exit 6 with the documented message. `--emit-wrapper-on-path`
adds a symlink from `~/.local/bin/<id>` (default OFF). **Deviation from
spec wording**: shebang is `#!/bin/sh` (not `#!/usr/bin/env bash`) and no
`set -euo pipefail` (per ADR-CMP-2, matching npm `cmd-shim`).
**Status: Accepted (Plan 006).**

### FR-CMP-014: `--register-virtual` (distribution form c)

Default OFF. Writes `composites/<id>/manifest.json` (mode `0o600`) with the
schema documented in the refined spec. The cli-agent tool registry, on
every startup, scans `composites/*/manifest.json` and registers each as a
virtual tool recognised by `--tool <id>`. Resolution order on `--tool <id>`:
(1) built-in tool name → registered tool; (2) virtual tool manifest match
→ meta-tool dispatch; (3) PATH binary lookup → wrapped CLI tool.
**Status: Accepted (Plan 006).**

### FR-CMP-015: Virtual-tool dispatch mode

Two modes are supported, controlled by `composite.virtualDispatch` (env
`CLI_AGENT_VIRTUAL_DISPATCH`): `child-process` (DEFAULT — fork a child
cli-agent with the recorded `--tool` list; hermetic isolation) and
`in-process` (re-enter the agent-graph builder; lower latency; flagged
experimental in v1). An integration test pins observable equivalence
between modes on a stable test prompt. **Status: Accepted (Plan 006).**

### FR-CMP-016: Recursion guard

A composite whose member list contains another registered virtual-tool name
is rejected with `UsageError` exit 2 at BOTH registration time
(`--register-virtual`) and dispatch time. The child process spawned in
`child-process` mode receives `CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1`;
the child's `loadVirtualTools` returns `[]` so structural recursion is
impossible. **Status: Accepted (Plan 006).**

### FR-CMP-017: Composite-name collision policy

Re-registering the same `<id>` with a different member set or a different
cli-agent version exits 2 unless `--force-overwrite` is supplied (which
atomically replaces both manifest and cached doc, preserving USER-* blocks
per FR-CMP-010). Identical re-registration is idempotent.
**Status: Accepted (Plan 006).**

### FR-CMP-018: Missing constituent at synthesis time

A declared `--tool <name>` with no cached capability document AND no PATH
binary aborts synthesis with `ConfigurationError` exit 3. If the binary IS
on PATH, the existing discovery flow runs first to populate the
constituent's capability doc, then synthesis proceeds. No silent
degradation. **Status: Accepted (Plan 006).**

### FR-CMP-019: Profile passthrough during synthesis

When a profile is active during a `--treat-as-tool --help` run, its
`cliParams` flow through normally so synthesis uses the profile's chosen
provider/model. Its `tools.allow/deny/order` is IGNORED for member
selection — only explicit `--tool` flags constitute the member set. Its
`toolArgs` is NOT embedded in the synthesised doc. The active profile name
is recorded as `activeProfile` in the schema-3 frontmatter for traceability
only. **Status: Accepted (Plan 006).**

### FR-CMP-020: System-prompt integration when consuming a composite

When an outer cli-agent loads a composite capability doc, the existing
system-prompt composition path (FR-AGT-008, FR-CAP-105) applies unchanged.
The composite's USER-RECIPES block embeds verbatim within the per-tool
byte budget; the synopsis falls back when the budget is exceeded. No new
prompt section is added — composites are opaque to the prompt builder.
**Status: Accepted (Plan 006).**

### FR-CMP-021: Logging

Synthesis runs emit the following JSONL events under
`~/.tool-agents/cli-agent/logs/`:
- `composite_synthesis_start` (composite name, members, cacheHit, dryRun,
  providerFamily, currentEffectiveOverlayDigests)
- `composite_synthesis_stage` (stage index, prompt-digest-16, token I/O,
  latency, providerCacheCreation, providerCacheRead)
- `composite_synthesis_end` (status, totalTokens, output digest-16, cache
  file path)
- `composite_emit` (per artifact: doc / wrapper / manifest / symlink, with
  absolute path and mode)
- `composite_dispatch` (composite name, dispatch mode, members)
- `composite_cache_version_mismatch` (composite name, recorded vs running
  cli-agent version)

Existing redaction policy applies; bodies are NOT logged (digest only).
**Status: Accepted (Plan 006).**

### FR-CMP-022: Subcommand surface (alternative to flag combo)

`cli-agent composite-synthesize --tool A --tool B [--composite-name <id>]
[--regenerate] [--emit-wrapper] [--register-virtual] [--dry-run]
[--force-overwrite]` is the scriptable equivalent of the
`--treat-as-tool --help` flag-driven path. Companion subcommands:
`composite-list` (table of registered virtuals), `composite-show <id>`
(print cached doc), `composite-delete <id> [--yes]` (remove manifest +
wrapper folder + cached doc + mirror copy + symlink). **Deviation from
spec wording**: subcommands are flat hyphenated (per ADR-CMP-4, matching
the codebase's existing 5 flat-hyphenated subcommands) rather than nested
under a `composite` group. **Status: Accepted (Plan 006).**

### FR-CMP-023: Documentation registration

The feature is documented in:
- `docs/design/project-functions.md` — this section.
- `docs/design/project-design.md` — §14 (added in P2).
- `docs/design/configuration-guide.md` — composite knobs
  (`composite.synthesisBudgetTokens`, `composite.virtualDispatch`).
- `docs/tools/cli-agent.md` — `<compositeTools>` subsection.
- `docs/design/plan-006-composite-tools.md` — implementation plan.
**Status: Accepted (Plan 006).**

### NFR-CMP-001: No drift on flag absence

A regression test pins `cli-agent --help` and tool-registration behaviour
when `--treat-as-tool` is absent. Diff against the baseline snapshot
captured before the Commander `helpOption(false)` migration (P4) must be
empty. **Status: Accepted (Plan 006).**

### NFR-CMP-002: Deterministic test harness

Synthesis tests are deterministic via a stub LLM that returns canned
outputs keyed by `sha256(prompt)`. The harness lives in
`test_scripts/lib/synthesisFixture.ts`; fixtures are folder-per-scenario
under `test_scripts/fixtures/synthesis/<name>/` with `inputs.json`,
`members/*.md`, `transcript.json`, `expected.md`. Recordable from a real
LLM via `RECORD=1`. **Status: Accepted (Plan 006).**

### NFR-CMP-003: Synthesis latency ceiling (smoke)

A synthesis run for a 2-member composite where each member doc is ≤ 32 KB
completes in under 30 s under the stub LLM (network elided) on the
standard test machine. Real-LLM smoke is documented but not gated in CI.
**Status: Accepted (Plan 006).**

### NFR-CMP-004: Cache hit cost

A `--treat-as-tool --help` cache hit completes (process boot → stdout
flushed → exit 0) in under 500 ms on the standard test machine. Asserted
by `test_scripts/smoke-cache-hit-cost.ts`. **Status: Accepted (Plan 006).**

### NFR-CMP-005: File-mode invariants

`composite/` and `composites/` directories at mode `0o700`; cached doc and
manifest at mode `0o600`; wrapper shim at mode `0o755` (executable).
Asserted by unit tests extending `bootstrapAgentDir` mode checks.
**Status: Accepted (Plan 006).**

### NFR-CMP-006: Schema migration test

A schema-2 composite cache file (synthesised in a hypothetical intermediate
state) is treated as cache miss and re-synthesised. Pinned by
`cache.spec.ts`. **Status: Accepted (Plan 006).**

### NFR-CMP-007: Coexistence smoke

An end-to-end test demonstrates, in a single run: (1) profile activation;
(2) tool-prompt overlay applied to a member; (3) member capability doc
with USER-RECIPES; (4) synthesis of a composite from the two members;
(5) outer cli-agent attaching the composite via `--tool <id>` and
producing a coherent system prompt that embeds the composite's
USER-RECIPES content. Lives at
`test_scripts/smoke-coexistence-end-to-end.ts`. **Status: Accepted (Plan 006).**

---

## LLM I/O Inspector Subsystem (FR-IOI-* / NFR-IOI-*)

The LLM I/O Inspector is a diagnostic/observability switch that captures the
exact provider-normalized request and response for every LLM turn of the main
interactive (TUI), one-shot, and legacy-REPL agent conversations, writing them
to a tailable JSONL file under the per-user agent directory and rendering any
completed turn on demand via an in-TUI `/inspect show [turn]` command. It is a
parallel, additive channel: when the switch is off, provider payloads, streamed
output, the operational `logs/` JSONL, transcript files, and `--help` output are
byte-identical to the prior state. Specified by
`docs/reference/refined-request-llm-io-inspector.md`; implemented per
`docs/design/plan-007-llm-io-inspector.md`. (Requirement IDs below correspond to
FR-1..FR-12 / NFR-1..NFR-6 of the refined request.)

### FR-IOI-001 (FR-1) — Switch to enable capture

A launch-time CLI flag (`--inspect-io`, plus `--inspect-io-raw`) on the default
`agent` command AND an in-session TUI slash toggle (`/inspect on|off`,
`/inspect show [turn]`, `/inspect status`) enable the inspector for a session.
When the switch is off, no capture work is performed and the agent's outward
behaviour and provider payloads are byte-identical. **Status: Implemented (Plan 007).**

### FR-IOI-002 (FR-2) — Separate presentation surface

When enabled, the captured conversation is presented in a surface separate from
the primary chat stream: a structured, human-readable JSONL capture file
tailable in a second terminal, complemented by an in-TUI `/inspect show [turn]`
command that renders a chosen turn's full request+response in a clearly
delimited block. The surface must not corrupt or race the raw-mode TUI render
loop or the spinner. **Status: Implemented (Plan 007).**

### FR-IOI-003 (FR-3) — Exact request capture

For each LLM turn, capture the exact request payload handed to the model:
(3a) the complete assembled system prompt string (post-composition), (3b) the
complete ordered in-thread conversation memory, (3c) the current turn's
user/human content, and (3d) the tool-use instruction surface — the effective
per-tool prompt overlays / built-in tool prompts, the agent-tools prompt block
(all embedded in the captured SystemMessage), and the tool/function JSON schemas
bound to the model. The authoritative request source is the
`on_chat_model_start.data.input` message array (which already contains the
SystemMessage = full assembled prompt); bound tool schemas are serialized once
per session with `convertToOpenAITool`. **Status: Implemented (Plan 007).**

### FR-IOI-004 (FR-4) — Exact response capture

For each LLM turn, capture the exact response received: (4a) the assistant
message content (final assembled text), (4b) every tool-call the model emitted
(name + parsed args object), in order, and (4c) the tool results fed back into
the loop (tool name + result + duration + ok/error), so the
request→response→tool-result chain is inspectable end to end. Tool-calls are
read from the aggregated `on_chat_model_end.data.output` message, not from
partial streamed chunks. **Status: Implemented (Plan 007).**

### FR-IOI-005 (FR-5) — Turn correlation

Each captured record is correlated by `sessionId`, `threadId`, and `turnId`
(the same identifiers used by the logger and graph), with a `stepIndex`
distinguishing the multiple model calls a single ReAct turn can produce, so
request, response, tool calls, and tool results for one turn render as one
coherent unit. **Status: Implemented (Plan 007).**

### FR-IOI-006 (FR-6) — Clear, descriptive rendering

The presented view clearly labels and visually separates the turn
number/timestamp, the request block (system prompt, memory, user content, tool
schemas) and the response block (assistant text, tool calls, tool results).
Long blocks are individually identifiable/inspectable with visible truncation
markers rather than dumped as one undifferentiated wall of text.
**Status: Implemented (Plan 007).**

### FR-IOI-007 (FR-7) — Live vs replay

The capture store is written incrementally as the conversation proceeds
(append-per-event), so it is usable live (a second-terminal `tail -f` updates).
The in-TUI inspector renders any completed turn on demand. Full live-refresh of
an in-app pane is deferred. **Status: Implemented (Plan 007).**

### FR-IOI-008 (FR-8) — Persistence + retrieval

Captures are persisted under the per-user agent directory at
`~/.tool-agents/cli-agent/io-captures/session-<UTC>-<sessionId>.jsonl` with a
`latest.jsonl` convenience pointer, directory mode `0700` / files mode `0600`,
mirroring the operational logger. Not auto-pruned (user's responsibility,
documented). **Status: Implemented (Plan 007).**

### FR-IOI-009 (FR-9) — Redaction policy

By default, captured payloads written to disk and shown in the separate surface
pass through the existing redaction helper (`src/util/redact.ts`) — both message
content and tool-call args. An explicit, clearly-named opt-out
(`--inspect-io-raw` / `CLI_AGENT_INSPECT_IO_RAW=1`) disables redaction for the
capture surface only, gated behind an explicit user choice and a prominent
stderr warning. Default = redaction ON. **Status: Implemented (Plan 007).**

### FR-IOI-010 (FR-10) — No-fallback configuration

When the inspector is explicitly requested but cannot be initialised (capture
directory uncreatable, invalid mode value), the agent raises the appropriate
typed error (`ConfigurationError` / `UsageError` with the correct exit code) —
never silently disabling capture or substituting a default mode.
**Status: Implemented (Plan 007).**

### FR-IOI-011 (FR-11) — Reuse, do not duplicate

Capture is implemented as a dedicated parallel channel (`src/agent/io-capture.ts`)
that REUSES the existing redaction helper, filesystem conventions, 64 KiB
field-cap discipline, and turn-correlation IDs from the operational logger, while
writing to its own `io-captures/` store. The hook points are the graph
invocation boundary (`on_chat_model_start` / `on_chat_model_end` in
`streamOneShot`, and `result['messages']` in `runOneShot`). The existing logger
and transcript formats are not modified. **Status: Implemented (Plan 007).**

### FR-IOI-012 (FR-12) — Provider neutrality

Capture works uniformly across all eight supported providers at the normalized
message layer, since it hooks above the provider SDK. No provider-specific
capture code paths exist at the default fidelity level. **Status: Implemented (Plan 007).**

### NFR-IOI-001 (NFR-1) — Off-state byte-stability & zero overhead

With the switch off, the system prompt, the provider request, the streamed
output, the existing log lines, and the existing transcript files are
byte-identical to the prior state; the off path uses a `NullIoCapture` no-op. A
regression test asserts the no-op behaviour; the `--help` baseline is
deliberately regenerated for the two new flags. **Status: Implemented (Plan 007).**

### NFR-IOI-002 (NFR-2) — TUI safety

The inspector never corrupts the raw-mode TUI: no interleaving of capture output
into the live token stream, no spinner/stdout column races (capture is a
post-event side-effect inside `streamOneShot`, and `/inspect` output uses the
same stdout path as all other commands), and graceful no-op on
non-TTY / `CLI_AGENT_NO_TUI=1` contexts. **Status: Implemented (Plan 007).**

### NFR-IOI-003 (NFR-3) — Performance

Capture does not materially slow a turn. Large payloads (system prompt, memory)
are size-bounded with explicit `_truncated` markers consistent with the existing
64 KiB field-cap behaviour, rather than dropped silently. Bound tool schemas are
serialized once per session, not per turn. **Status: Implemented (Plan 007).**

### NFR-IOI-004 (NFR-4) — Security & permissions

All capture artifacts inherit the existing secret-handling posture: `0700` dir /
`0600` files, redaction on by default, and the redaction opt-out is impossible
to enable by accident (explicit flag/env + prominent warning).
**Status: Implemented (Plan 007).**

### NFR-IOI-005 (NFR-5) — TypeScript / ESM consistency

All new code is TypeScript ESM consistent with the existing `src/` layout,
conventions, and lint rules; persisted records are typed; new config keys are
camelCase in `config.json` (`inspectIo`) and `SCREAMING_SNAKE_CASE` for env vars
(`CLI_AGENT_INSPECT_IO`, `CLI_AGENT_INSPECT_IO_RAW`). No new runtime dependency
is introduced (`convertToOpenAITool` from `@langchain/core` is used;
`zod-to-json-schema` is not). **Status: Implemented (Plan 007).**

### NFR-IOI-006 (NFR-6) — Documentation completeness

The feature is documented in `docs/tools/cli-agent.md`,
`docs/design/project-functions.md`, `docs/design/project-design.md`, and
`docs/design/configuration-guide.md`, including the configuration-guide treatment
of the new variables (purpose, how to set, precedence, default value) and the
redaction opt-out's risk and the no-auto-prune note. **Status: Implemented (Plan 007).**

---

## Tool-Loading Toggles Subsystem (FR-TLT-*)

Three independent, group-level tool-loading switches let the user suppress
whole families of tools at session-build time, through CLI flags, environment
variables, `config.json`, and configuration profiles. Implemented per
`docs/design/plan-008-tool-loading-toggles.md`.

### FR-TLT-001 — Composites group toggle

cli-agent SHALL provide a toggle that loads (default) or suppresses every
composite/virtual tool (`loadVirtualToolsSync`). Surfaces: CLI
`--composites` / `--no-composites`; env `CLI_AGENT_DISABLE_COMPOSITES`
(truthy = OFF); `config.json` `composites: boolean`; profile
`tools.composites: boolean`. When suppressed, `loadVirtualToolsSync` is not
invoked and no virtual handles are added to the catalog. **Status: Implemented (Plan 008).**

### FR-TLT-002 — Built-in tools group toggle

cli-agent SHALL provide a toggle that loads (default) or suppresses the
built-in cross-cutting toolkit — `bash_list_allowed`, `bash_which`, `tool_help`,
and `bash_run` when the bash allowlist is non-empty. Surfaces: CLI
`--builtin-tools` / `--no-builtin-tools`; env `CLI_AGENT_DISABLE_BUILTIN_TOOLS`
(truthy = OFF); `config.json` `builtinTools: boolean`; profile
`tools.builtin: boolean`. When suppressed, none of those built-in tools are
constructed. File and web tools are no longer part of this group after
plan-011/012; they are governed by the agent-tools pack. **Status: Implemented
(Plan 008; current membership amended by Plans 011/012).**

### FR-TLT-003 — Agent-tools pack profile tier

The existing agent-tools pack umbrella (`agentTools.enabled`; CLI
`--no-agent-tools`; env `CLI_AGENT_DISABLE_AGENT_TOOLS`; `config.json`
`agentTools.enabled`) SHALL gain a profile tier `tools.agentTools: boolean`,
inserted just above the default in the umbrella resolution. The governed pack
includes the vendored `agt_*` tools plus first-party `agt_web_search`,
`agt_web_fetch`, `agt_file_read`, `agt_file_list`, `agt_file_write`,
`agt_file_edit`, and `agt_file_append`; file/web tools are not affected by
`--no-builtin-tools`. **Status: Implemented (Plan 008; current membership
amended by Plans 011/012).**

### FR-TLT-004 — Uniform precedence

All three toggles SHALL resolve through one uniform chain:
`CLI flag > env (CLI_AGENT_DISABLE_*) > config.json > profile > default(load)`.
The `CLI_AGENT_DISABLE_*` env vars follow the inverted-disable convention
(truthy = OFF); an invalid (non-boolean) value raises `ConfigurationError`
(exit 3) — no fallback. The default (load) is an explicit starting value, not
a runtime fallback for missing required config; no new required config is
introduced. **Status: Implemented (Plan 008).**

### FR-TLT-005 — `--no-builtin-tools` removes `bash_run` (wrapped-CLI caveat)

Because `bash_run` is part of the built-in toolkit, suppressing the built-in
group SHALL also remove `bash_run` — the path used to execute wrapped CLIs.
This is documented so users who wrap CLIs keep the built-in group on. **Status: Implemented (Plan 008).**

### FR-TLT-006 — Empty toolset is permitted

Disabling every group (with no wrapped CLI) SHALL produce an empty catalog and
degrade the agent to a plain conversational LLM, WITHOUT raising an error. The
catalog builder SHALL emit exactly one stderr notice and proceed. This is
distinct from profile tool-scoping's empty-survivor error (E7), which still
applies to `allow`/`deny`. **Status: Implemented (Plan 008).**

### FR-TLT-007 — Profile `tools.*` schema additions

`ProfileToolsSchema` SHALL accept optional booleans `composites`, `builtin`,
and `agentTools` under the `tools` sub-tree, while remaining `.strict()`
(unknown keys under `tools` still rejected). **Status: Implemented (Plan 008).**

### NFR-TLT-001 — Off-state byte-stability

When all three groups are at their defaults (load), the assembled tool catalog
SHALL be byte-identical to the pre-plan-008 behaviour. The gate evaluates
`cfg.builtinTools !== false` and `cfg.composites !== false`, so an unset/`true`
value reproduces the prior construction exactly. Verified by the existing
`registry.spec.ts` suite remaining green. **Status: Implemented (Plan 008).**

### NFR-TLT-002 — TypeScript / ESM consistency, no new dependency

All new code is TypeScript ESM consistent with `src/`; new `config.json` keys
are camelCase (`composites`, `builtinTools`) and new env vars are
`SCREAMING_SNAKE_CASE` (`CLI_AGENT_DISABLE_COMPOSITES`,
`CLI_AGENT_DISABLE_BUILTIN_TOOLS`). No new runtime dependency is introduced. **Status: Implemented (Plan 008).**

### NFR-TLT-003 — Documentation completeness

The feature is documented in `docs/tools/cli-agent.md` (the
`<toolLoadingToggles>` subsection), `docs/design/configuration-guide.md`
(per-variable treatment + precedence + opt-out matrix),
`docs/design/project-functions.md` (this section), and
`docs/design/project-design.md` (dated section). **Status: Implemented (Plan 008).**

### FR-TLT-008 — File and web tools are governed by agent-tools toggles

First-party web tools (`agt_web_search`, `agt_web_fetch`) and first-party file
tools (`agt_file_read`, `agt_file_list`, `agt_file_write`, `agt_file_edit`,
`agt_file_append`) SHALL be controlled by `agentTools.enabled`, their per-tool
`--enable/--disable-agt-*` flags, and name-based profile scoping. They SHALL NOT
be disabled by `--no-builtin-tools`. The three file mutators remain additionally
gated by `allowMutations`. **Status: Implemented (Plans 011/012).**

---

## Tool-Loading-Aware System Prompt (FR-SPT-*)

The base system prompt is made coherent with the built-in-tools toggle: the
built-in tool INSTRUCTIONS become a runtime-injected conditional block gated on
`cfg.builtinTools`, exactly like the existing `agt_*` block. This closes the
gap left by plan-008, where `--no-builtin-tools` dropped the built-in tool
SCHEMAS but the base prompt still hard-coded the built-in tool prose.
Implemented per `docs/design/plan-009-systemprompt-toggle-aware.md`.

### FR-SPT-001 — Slim, tool-agnostic default base prompt

The seeded default base prompt (`BUILTIN_DEFAULT_SYSTEM_PROMPT`) SHALL contain
only the generic agent identity and truly-generic conduct (keep responses
concise; never echo raw credentials / bearer tokens / long base64). It SHALL
contain NO tool-specific prose (`bash_run`, `file_*`, `web_*`, `tool_help`,
`--allow-mutations`). **Status: Implemented (Plan 009).**

### FR-SPT-002 — Built-in-tools system-prompt block, gated on the toggle

The built-in cross-cutting toolkit's instructions SHALL be carried in a
self-framed `## Built-in tools` block assembled by
`buildBuiltinToolsPromptBlock` — the `bash_run` framing, the CORE RULES, the
OUT-OF-SCOPE bullets, and the available-tools list. The function SHALL return
`''` when the umbrella toggle is off (`builtinTools === false`). The block is
injected into the assembled prompt ONLY when the built-in tools are loaded, so
the model is not told about tools it cannot call. **Status: Implemented (Plan
009; block content made adaptive in Plan 010 and narrowed after Plan 012 — see
FR-SPT-006).**

### FR-SPT-003 — Composition order

`buildSystemPrompt` SHALL inject the built-in-tools block AFTER the base prompt
and BEFORE the wrapped-CLI capabilities section. Full order: base →
built-in-tools block (if loaded) → capabilities → agent-tools block (if loaded)
→ user-provided instructions. `buildSystemPrompt`'s built-in-presence parameter
SHALL default to `{ builtinTools: true, bashRun: true }` for the current built-in
toolkit; `buildSystemPromptForCfg` SHALL derive that presence from
`cfg.builtinTools` plus the registered tool names (see FR-SPT-006). **Status:
Implemented (Plan 009; presence object in Plan 010; file presence removed in
Plan 012).**

### FR-SPT-004 — In-place upgrade of an unmodified default

`bootstrapAgentDir` SHALL upgrade an existing `system-prompt.md` in place IFF
its bytes are EXACTLY equal to a prior shipped default (an entry in
`LEGACY_DEFAULT_SYSTEM_PROMPTS`) — overwriting it with the new slim default at
mode `0600`. A file that differs in any way (user-customized, or already the
new slim default) SHALL be left BYTE-UNCHANGED. The upgrade SHALL never throw.
This is a bootstrap convenience, NOT a runtime fallback: a missing/unreadable
SELECTED prompt still raises `UsageError` at load time. **Status: Implemented (Plan 009).**

### FR-SPT-005 — Customized-base caveat (documented)

The `## Built-in tools` block is injected on top of whatever base is on disk.
For the slim default there is no duplication; a CUSTOMIZED base that still
hard-codes tool prose owns that prose (the toggle cannot strip it), so it may
appear twice when the built-in tools are loaded. This is documented in
`docs/tools/cli-agent.md` and `docs/design/configuration-guide.md`. **Status: Implemented (Plan 009).**

### FR-SPT-006 — Adaptive built-in-tools block (describes exactly the registered tools)

When the umbrella toggle is on, the `## Built-in tools` block SHALL describe
EXACTLY the built-in tools actually registered for the session, not a static
superset. `buildBuiltinToolsPromptBlock` SHALL take a presence object
`{ builtinTools, bashRun }` and assemble the block from composable, gated
sections:

- The `bash_run` command-execution framing and its two confirmation/allowlist
  CORE RULES SHALL be included ONLY when `bashRun` is true (i.e. the command
  allowlist is non-empty so `bash_run` is bound). When `bashRun` is false the
  block SHALL instead state that no local commands are allow-listed and command
  execution is unavailable, and SHALL omit those two rules.
- The general CORE RULES (capability docs / `tool_help`, read-only evidence,
  error-JSON handling, `__truncated` handling) and the read-only built-in tools
  (`bash_list_allowed`/`bash_which`, `tool_help`) SHALL always be described when
  the built-in group is enabled.

File and web guidance SHALL NOT live in this built-in block after Plans 011/012;
it rides on the `agt_web_*` and `agt_file_*` descriptions in the agent-tools
prompt block. The old `mutatingFile` presence flag and its
`file_write`/`file_edit`/`file_append` name derivation are removed.

`buildSystemPromptForCfg` SHALL take a 4th parameter `registeredTools`
(`ReadonlyArray<{ name: string }>` — the post-scoping tool array from
`buildToolCatalog`) and SHALL derive presence as `builtinTools = cfg.builtinTools
!== false`, `bashRun = names.has('bash_run')`.
Deriving from the registered names ensures the prompt prose matches the bound
tool schemas across every built-in gate (umbrella toggle, allowlist, profile
deny), so the inspector's "Bound tool schemas" and the system-prompt tool prose
agree for the built-in toolkit. All production call sites SHALL pass the
in-scope `tools` array. Implemented per `docs/design/plan-010-builtin-block-adaptive.md`
and amended by Plan 012. **Status: Implemented (Plan 010; amended by Plan 012).**

### NFR-SPT-001 — TypeScript / ESM consistency, no new dependency

All new code is TypeScript ESM consistent with `src/`; no new runtime
dependency is introduced. The default-prompt restructuring is a deliberate
baseline re-record covered by updated `system-prompt.spec.ts` and new migration
tests in `agent-config.spec.ts`. **Status: Implemented (Plan 009).**

### Known minor follow-up — wrapped-CLI "via bash_run" framing under `--no-builtin-tools`

`--no-builtin-tools` removes `bash_run`, so the wrapped-CLI capabilities
section's "available via bash_run" framing is moot in that (self-defeating)
combination. Left as-is for this change; tracked as a minor follow-up. **Status: Deferred.**

## Runner Runtime Assembly

### FR-RUN-001 — Centralized runtime assembly

The one-shot runner, streaming one-shot runner, TUI bootstrap path, and legacy
readline interactive runner SHALL construct their common runtime through
`assembleAgentRuntime(cfg, opts)` rather than repeating logger, LLM, tool
catalog, capability discovery, system prompt, session/profile logging, I/O
capture, and graph setup inline. Path-specific lifecycle behavior remains in
the runner functions: prompt logging, streaming iteration, readline event
handling, and logger/capture close ownership. **Status: Implemented (Plan
013).**

## Release / CI Hardening

### FR-REL-001 — Local release gate

The npm package SHALL expose a `prepublishOnly` release gate that fails before
publish when any required local release check fails. The gate SHALL run lint,
typecheck, a clean release build, tests, high-or-higher dependency audit, and
package payload validation in sequence. The build step runs before tests because
the CLI help baseline tests execute `dist/cli.js`. **Status: Implemented (Plan
014).**

### FR-REL-002 — Lint script

The npm package SHALL expose `npm run lint`. In the current dependency-free
implementation, lint is strict TypeScript static validation through
`tsc --noEmit -p tsconfig.json --pretty false`; a future dedicated linter can
replace this script without changing the release-gate contract. **Status:
Implemented (Plan 014).**

### FR-REL-003 — Release build excludes test artifacts

The release build SHALL use a build-specific TypeScript configuration that
emits runtime/library files into `dist/` and excludes `*.spec.ts`,
`*.test.ts`, and source JSON that is not required at runtime. `npm run build`
SHALL start from a clean `dist/` directory so stale files cannot leak into the
publish payload. **Status: Implemented (Plan 014).**

### FR-REL-004 — Package payload validation

The package content check SHALL inspect the actual `npm pack --dry-run --json`
payload. It SHALL require `package.json`, `README.md`, `LICENSE`, executable
`dist/cli.js`, and all vendored `*.prompt.md` runtime assets. It SHALL reject
source, docs, test scripts, compiled spec/test/integration artifacts,
TypeScript source files, fixture/test directories, lockfiles, and vendored
upstream package metadata. **Status: Implemented (Plan 014).**
