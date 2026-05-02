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

