# Refined Request: Externalize the Default System Prompt and Add a Selectable Prompt Flag

## Category
Development

## Objective
Move the cli-agent's hard-coded default system prompt out of the TypeScript source and into a markdown file inside the agent's capabilities folder (`~/.tool-agents/cli-agent/capabilities/`). Introduce a new CLI flag that lets the user pick which file to use as the **base** system prompt — with explicit resolution rules for absolute paths, bare file names (resolved against the capabilities folder), and the "no flag passed" default. The existing `--system` and `--system-file` flags must continue to work unchanged as **append-only** addenda layered on top of whichever base prompt is selected.

## Scope

### In scope
- Extract `BASE_SYSTEM_PROMPT` from `src/agent/system-prompt.ts` (lines 7–54) into an external markdown file shipped inside the capabilities folder.
- Bootstrap the default prompt file on first run (write the built-in default to disk if absent), so users can edit it without rebuilding.
- Add a new CLI flag `--system-prompt <path-or-name>` to select the base system prompt file.
- Implement the three-rule resolution logic (absolute path / bare filename / unset → default).
- Wire the flag through `AgentCliFlags`, `loadAgentConfig`, and `buildSystemPrompt`.
- Add a config.json key (`systemPromptFile`) and an env-var (`CLI_AGENT_SYSTEM_PROMPT`) that participate in the four-tier resolution chain documented in `docs/design/configuration-guide.md`.
- Raise a `UsageError` (exit code 2) when the resolved file does not exist — no silent fallback to the built-in default.
- Update `docs/tools/cli-agent.md`, `docs/design/project-design.md`, `docs/design/project-functions.md` (new FR for externalized prompt), and `docs/design/configuration-guide.md`.

### Out of scope
- Any changes to `--system` (inline append) and `--system-file` (file append) semantics. They remain append-only.
- TUI slash commands such as `/system-prompt` or `/refresh-system-prompt` for hot reload at runtime. Captured under "Open Questions" for a follow-up iteration.
- Per-tool prompt overrides, prompt templating (Jinja-style variables), or multi-file prompt composition.
- Editing the prompt content itself — the externalized file ships byte-identical to today's `BASE_SYSTEM_PROMPT`.

## Requirements

### R1 — External default prompt file
A file named **`system-prompt.md`** must live inside `cfg.capabilitiesDir` (resolves to `~/.tool-agents/cli-agent/capabilities/system-prompt.md` by default). On first invocation, if the file does not exist, the agent must write the built-in default to it (mode `0600`, like other seeded files), then read it back. On subsequent runs, the file on disk is the source of truth — edits made by the user must take effect.

### R2 — Built-in default as fallback for bootstrap only
The built-in `BASE_SYSTEM_PROMPT` constant must remain in source as the **bootstrap seed** for R1. It must NOT be used as a runtime fallback when the user-selected file is missing (see R6).

### R3 — New CLI flag `--system-prompt <value>`
Add `--system-prompt <path-or-name>` to the default `program` command in `src/cli.ts` (around line 43, next to the existing `--system` and `--system-file` flags). The value resolves as follows:

| Input form                                  | Resolution                                                            |
| ------------------------------------------- | --------------------------------------------------------------------- |
| Absolute path (`path.isAbsolute(v) === true`) | Use the path verbatim.                                                |
| Bare filename (no path separators)          | Resolve to `path.join(cfg.capabilitiesDir, value)`.                   |
| Relative path with separators (`./x`, `a/b`) | Resolve against `process.cwd()` (treat as a normal relative path).    |
| Flag omitted                                 | Use `path.join(cfg.capabilitiesDir, 'system-prompt.md')` (the bootstrapped default from R1). |

### R4 — Relationship to `--system` and `--system-file`
- `--system-prompt` selects the **base** prompt that replaces today's hard-coded `BASE_SYSTEM_PROMPT`.
- `--system <text>` continues to append text to the system prompt under a `## User-provided instructions` section (current behavior in `src/agent/system-prompt.ts` lines 66–68).
- `--system-file <path>` continues to load a file and append its contents the same way.
- Composition order in `buildSystemPrompt`: `<base prompt from R3>` + capability section + `--system-file` contents + `--system` text. The append-style flags MUST NOT be silently ignored when `--system-prompt` is also passed.

### R5 — Four-tier configuration resolution
The new setting must participate in the existing precedence chain defined in `docs/design/configuration-guide.md`:

1. Shell env: `CLI_AGENT_SYSTEM_PROMPT` (lowest precedence baseline).
2. `~/.tool-agents/cli-agent/.env` `CLI_AGENT_SYSTEM_PROMPT=...`.
3. Local `./.env` `CLI_AGENT_SYSTEM_PROMPT=...`.
4. CLI flag `--system-prompt <value>` (highest precedence).

In addition, `config.json` may carry a `systemPromptFile` string (top-level key, schema v1, no version bump needed since this is a new optional field). The relative precedence inside the layered loader is: CLI flag > env (any tier) > `config.json` > built-in default file path. Add `CLI_AGENT_SYSTEM_PROMPT` to the `OTHER_ENV_KEYS` array in `src/config/agent-config.ts` (line 367) and seed a commented placeholder in the `.env` template in `bootstrapAgentDir` (around line 270).

### R6 — Strict error handling (no fallbacks)
If the resolved path (after R3) does not exist or is not readable, the agent MUST throw a `UsageError` with exit code `2` and a message indicating:
- The raw value the user passed.
- The fully resolved absolute path that was attempted.
- The other resolution forms (so the user can see whether they meant a bare filename vs. a relative path).

The error must NOT trigger silent reversion to `BASE_SYSTEM_PROMPT`. This aligns with the global CLAUDE.md rule: *"You must never create fallback solutions for configuration settings."* The bootstrap behavior in R1 is not a fallback — it only runs when the user has NOT specified an alternative path, before resolution.

### R7 — Integration with `loadAgentConfig`
- Extend the `AgentCliFlags` interface (`src/config/agent-config.ts` lines 146–170) with `readonly systemPromptFile?: string;`.
- Extend `AgentConfigFile` (lines 81–94) with `readonly systemPromptFile?: string;`.
- Extend the `AgentConfig` return shape (lines 121–143) with `readonly systemPromptPath: string;` (the fully resolved absolute path, after applying R3 + R5 + R6 readability check).
- Path resolution and the existence check must happen inside `loadAgentConfig` so any caller of the agent gets a validated path.

### R8 — Updates to `buildSystemPrompt`
Refactor `src/agent/system-prompt.ts`:
- Remove the hard-coded `BASE_SYSTEM_PROMPT` from being the runtime source. Keep the constant exported as `BUILTIN_DEFAULT_SYSTEM_PROMPT` for use by the bootstrap routine in R1 only.
- Change `buildSystemPrompt` signature to accept the base prompt text (already loaded from disk by the caller), not to assemble it from the constant. Suggested new signature:
  `buildSystemPrompt(baseText: string, capabilitiesSection: string, customSystemText?: string): Promise<string>`.
- The caller (currently the agent assembly path that consumes `loadSystemPromptFile`) must read the file at `cfg.systemPromptPath` and pass its contents in.

### R9 — Documentation updates
- `docs/tools/cli-agent.md`: add `--system-prompt` to the flag table; document the three resolution rules; mention the bootstrap behavior; clarify that `--system` and `--system-file` remain append-only.
- `docs/design/project-functions.md`: add a new functional requirement (next free FR-AGT number after the current highest) titled "External Default System Prompt with Selectable Override".
- `docs/design/project-design.md`: update the capability cache layout section to mention that `system-prompt.md` lives alongside per-tool capability files.
- `docs/design/configuration-guide.md`: register `CLI_AGENT_SYSTEM_PROMPT` and `config.json: systemPromptFile`.

### R10 — Backward compatibility
Users who do not pass `--system-prompt`, do not set `CLI_AGENT_SYSTEM_PROMPT`, and do not have `systemPromptFile` in `config.json` must observe **no behavior change** other than the file `~/.tool-agents/cli-agent/capabilities/system-prompt.md` appearing on disk after the first run.

## Constraints
- **Language**: TypeScript only (project convention).
- **No fallbacks**: per global CLAUDE.md; R6 enforces this.
- **No version-control operations** during implementation unless explicitly requested.
- **File modes**: the bootstrapped `system-prompt.md` must be created at `0600` to match the security posture of `.env` (see `bootstrapAgentDir` lines 192–282).
- **No new dependencies**: use `node:fs/promises` and `node:path` already imported in the affected files.
- **Capability cache coexistence**: the capabilities folder currently holds `<tool>.md` files. The new `system-prompt.md` is a reserved filename in that folder; capability discovery for a hypothetical tool literally named `system-prompt` would collide. This is acceptable (no real CLI uses that name); the design must not treat `system-prompt.md` as a capability document during cache scans.

## Acceptance Criteria

1. **AC-1 — Bootstrap creates the file**: Deleting `~/.tool-agents/cli-agent/capabilities/system-prompt.md`, then running `cli-agent --tool jq "echo hi"` recreates the file with content byte-identical to the built-in default and mode `0600`.
2. **AC-2 — Default behavior unchanged**: With no flag and no env-var, the assembled system prompt is byte-identical to the prompt produced before this change (capability sections + `--system` / `--system-file` appendices identical).
3. **AC-3 — Edits to the file take effect**: Modifying `system-prompt.md` (e.g. appending a sentence) and re-running the agent results in the modified text appearing in the system prompt sent to the LLM. Verifiable via `--verbose` log of the assembled prompt.
4. **AC-4 — Absolute path**: `cli-agent --system-prompt /tmp/my-prompt.md "..."` reads `/tmp/my-prompt.md` as the base prompt.
5. **AC-5 — Bare filename**: `cli-agent --system-prompt alt.md "..."` reads `~/.tool-agents/cli-agent/capabilities/alt.md`.
6. **AC-6 — Relative path with separators**: `cli-agent --system-prompt ./prompts/x.md "..."` resolves against `process.cwd()`.
7. **AC-7 — Missing file raises UsageError**: `cli-agent --system-prompt does-not-exist.md "..."` exits with code `2` and a message naming both the raw input and the fully resolved path; the agent does NOT proceed using the built-in default.
8. **AC-8 — Coexistence with `--system`**: `cli-agent --system-prompt alt.md --system "extra rule" "..."` produces a prompt whose base is `alt.md` and whose tail contains `## User-provided instructions\n\nextra rule`.
9. **AC-9 — Env-var resolution**: Setting `CLI_AGENT_SYSTEM_PROMPT=alt.md` in `~/.tool-agents/cli-agent/.env` (and not passing the flag) selects `~/.tool-agents/cli-agent/capabilities/alt.md`.
10. **AC-10 — CLI overrides env**: With both `CLI_AGENT_SYSTEM_PROMPT=a.md` in env and `--system-prompt b.md` on the CLI, `b.md` is selected.
11. **AC-11 — config.json key**: With `{"systemPromptFile":"alt.md"}` in `~/.tool-agents/cli-agent/config.json` and no flag/env, `alt.md` is selected. Env-var or CLI flag overrides this.
12. **AC-12 — Documentation in sync**: The `--system-prompt` flag appears in `docs/tools/cli-agent.md` with the resolution table; the new FR appears in `docs/design/project-functions.md`; `CLI_AGENT_SYSTEM_PROMPT` is documented in `docs/design/configuration-guide.md`.

## Assumptions
- **A-1 — Flag name**: `--system-prompt` is chosen over `--system-prompt-file` or `--prompt-template` because it is the user's mental model ("which prompt do I want?") and avoids implying templating, which is out of scope.
- **A-2 — Default filename**: `system-prompt.md` (lowercase, kebab) is chosen for consistency with all other markdown artifacts in `capabilities/` and the project-wide `kebab-case` filename convention.
- **A-3 — Append flags semantics unchanged**: `--system` and `--system-file` continue to append, since the raw request says nothing about removing them and they have a distinct, complementary purpose.
- **A-4 — Bootstrap on first run**: chosen over "keep default in-memory only" because (a) it makes the prompt user-editable without a rebuild, (b) it matches the project's existing bootstrap pattern for `.env`, `logs/`, and `capabilities/`, and (c) it makes the on-disk artifact discoverable for users who want to inspect what the agent is sending.
- **A-5 — Env-var name**: `CLI_AGENT_SYSTEM_PROMPT` follows the `CLI_AGENT_*` prefix already used by `CLI_AGENT_LOG`.
- **A-6 — config.json key**: `systemPromptFile` is camelCase per the existing `AgentConfigFile` interface.
- **A-7 — No schema bump**: the new `systemPromptFile` field is additive and optional; `CONFIG_SCHEMA_VERSION` (currently `1`, line 44) does not need to be incremented.
- **A-8 — UsageError class**: assumed to exist or to be a subclass of `CliAgentError` with `exitCode = 2`. The implementer should reuse the existing usage-error path that produces exit code 2 (see the exit-code legend in `src/cli.ts` lines 5–13).

## Open Questions
- **OQ-1 — TUI slash commands**: Should the TUI grow a `/system-prompt <path>` and a `/refresh-system-prompt` command for runtime swap and hot reload? The user explicitly listed this as a question. **Recommendation: defer to a follow-up iteration**, because (a) the current request mentions only startup-time selection, (b) hot reload requires re-binding the LangGraph agent's system message, which is a non-trivial change, and (c) deferral does not block any of AC-1..AC-12.
- **OQ-2 — Capability folder filtering**: the capability discovery scanner must skip `system-prompt.md` so it is never mistaken for a tool capability document. Confirm whether the existing scanner enumerates `*.md` indiscriminately, and if so, add a hard-coded exclusion list.

## Affected Code (cited locations)

| File                                                                 | Lines     | Nature of change                                                                                  |
| -------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/system-prompt.ts` | 7–54      | Rename `BASE_SYSTEM_PROMPT` → `BUILTIN_DEFAULT_SYSTEM_PROMPT` (export). Used only by bootstrap.   |
| same                                                                 | 56–71     | Change `buildSystemPrompt` signature to accept `baseText` instead of using the constant.          |
| `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/cli.ts`  | 42–43     | Add `.option('--system-prompt <value>', '...')` next to existing `--system` / `--system-file`.    |
| same                                                                 | 65–90     | Pass `systemPromptFile: opts['systemPrompt']` into `runAgentCommand`.                             |
| `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/config/agent-config.ts` | 81–94     | Add `systemPromptFile?: string` to `AgentConfigFile`.                                             |
| same                                                                 | 121–143   | Add `systemPromptPath: string` to `AgentConfig`.                                                  |
| same                                                                 | 146–170   | Add `systemPromptFile?: string` to `AgentCliFlags`.                                               |
| same                                                                 | 192–282   | In `bootstrapAgentDir`: after creating `capabilitiesDir`, write `system-prompt.md` (mode `0600`) if absent. Add `# CLI_AGENT_SYSTEM_PROMPT=` to seeded `.env` placeholder. |
| same                                                                 | 367–372   | Add `'CLI_AGENT_SYSTEM_PROMPT'` to `OTHER_ENV_KEYS`.                                              |
| same                                                                 | 420–559   | In `loadAgentConfig`: implement R3+R5 resolution, R6 existence check, populate `systemPromptPath`.|
| `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/commands/agent.ts` (caller) | n/a       | Read `cfg.systemPromptPath`, pass file contents to `buildSystemPrompt`.                           |
| `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/tools/cli-agent.md` | n/a       | Document new flag, env var, config.json key, resolution rules.                                    |
| `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/project-functions.md` | n/a       | Add new FR-AGT entry.                                                                             |
| `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/project-design.md` | n/a       | Update capability cache layout section.                                                           |
| `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/configuration-guide.md` | n/a       | Document new env var and config.json key in the four-tier chain.                                  |

## Original Request

> I want you to make the system prompt external to be read from the configuration folder under the capabilities subfolder.
>
> I want you to add a command line option to allow the user to select the system prompt to start the agent.
>
> Resolution rules for the new option:
> - If the user passes a full (absolute) path, the agent must respect that full path.
> - If the user passes a single file name, the agent must look for the file under the capabilities folder.
> - If the user does not pass anything, the default system prompt must be used.
