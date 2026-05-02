# Refined Request: Configuration Profiles for cli-agent

## Category
Development (feature addition: configuration subsystem + CLI surface + management subcommands)

## Objective
Add a first-class "configuration profile" feature to cli-agent that lets a user
create, persist, list, inspect, edit, delete, and activate named harness presets
which bundle three optional, orthogonal concerns into a single launch-time
preset: (a) preset values for the agent's existing CLI/configuration parameters,
(b) a broad-scope tool-list scoping mechanism (allowlist + denylist + ordering),
and (c) per-tool default arguments that are mergeable with runtime arguments.
Profiles must integrate cleanly with the existing four-tier configuration
resolution chain in such a way that explicit CLI flags supplied at invocation
ALWAYS win, must coexist with the existing tool-prompt overlay system without
collision, and must be discoverable and inspectable without launching the
agent.

## Scope

### In scope (v1)

- Profile **storage** under `~/.tool-agents/cli-agent/profiles/<name>.{yaml|json}`
  (directory mode `0700`, files mode `0600`, mirroring existing conventions for
  `.env`, `logs/`, `capabilities/`, `tool-prompts/`).
- A new CLI flag `--profile <name>` and a new env var `CLI_AGENT_PROFILE` that
  activate a named profile, participating in the standard four-tier resolution
  chain.
- Profile **schema** with three independent, all-optional sections:
  1. `cliParams` — preset values for any existing cli-agent CLI/config knob.
  2. `tools` — broad-scope tool list scoping with three sub-keys: `allow`,
     `deny`, and `order`.
  3. `toolArgs` — per-tool argument presets, mergeable per-argument with
     runtime arguments at tool-invocation time.
- **Layered precedence rule** (the central invariant): explicit CLI flags
  supplied alongside `--profile` ALWAYS override profile values. The exact
  insertion tier of profile values within the resolution chain is fixed by this
  spec (see "Precedence" below), but the user-facing guarantee is unconditional.
- Per-tool argument **merge semantics**: at the moment a tool is invoked, the
  effective arguments are computed as
  `{ ...profile.toolArgs[toolName], ...runtimeArgs }` — i.e. shallow,
  per-argument merge where any argument supplied at the call site overrides
  only that key. Other profile-set arguments for the same tool still apply.
- **Tool list scoping** with three operations applied in this order:
  `allow` → `deny` → `order`, each optional and independently usable. See
  "Tool list scoping semantics" below.
- New management subcommands:
  - `cli-agent profile list` — enumerate profiles.
  - `cli-agent profile show <name>` — print parsed profile contents +
    resolved/normalized form.
  - `cli-agent profile create <name>` — scaffold a new profile file
    (interactively or from flags).
  - `cli-agent profile edit <name>` — open the profile file in `$EDITOR`.
  - `cli-agent profile delete <name>` — delete a profile file (with
    confirmation unless `--yes`).
  - `cli-agent profile dry-run [--profile <name>] [other flags]` — print the
    fully resolved configuration (cliParams merged with env/config.json/CLI,
    final tool catalog after scoping, per-tool argument presets) without
    launching the agent.
- **Coexistence with tool-prompt overlays**: profiles change *which tools are
  exposed* and *what default args they get*; overlays change *what prompt text
  describes a tool*. The two systems are orthogonal and must never collide.
- **Documentation updates** to: `project-functions.md`, `project-design.md`,
  `configuration-guide.md`, `docs/tools/cli-agent.md`, and (if applicable) the
  user guides under `docs/`.

### Out of scope (deferred to v2 or later)

- "Strict profile-wins" mode for `toolArgs` (where profile arguments would
  override runtime arguments instead of the other way round). User has
  explicitly confirmed this is NOT in scope for v1.
- **Profile inheritance / composition** (one profile extending another, or
  layering multiple `--profile` flags). v1 supports exactly one active profile
  per invocation.
- **Profile activation from `config.json`** (e.g. `defaultProfile: "foo"`).
  v1 activation is via CLI flag and env var only.
- **Auto-generation of profiles** from current runtime state (e.g. a
  `/save-profile` slash command in the TUI that captures the live runtime).
- **Per-profile secret storage** (API keys inside profile files). Secrets
  continue to flow through env / `.env` / `config.json` exactly as today;
  profiles MAY pin non-secret cliParams (provider, model, temperature,
  max-iterations, working dir, log level, web-search backend) but MUST NOT
  store credential-shaped values. (Validation enforces this — see edge cases.)
- **Cross-machine profile sync** or profile import/export bundles.
- **TUI slash command** for switching profiles mid-session
  (`/profile <name>`). v1 ships CLI activation only; a follow-up plan can
  add the slash command.
- **Schema migration tooling** for evolving profile files across cli-agent
  versions (v1 ships a single schema version; future work can add a
  `schemaVersion` field and migrators).

## Requirements

### FR-PROF-001 — Profile storage layout

The agent must, on first run (or first profile creation), ensure
`~/.tool-agents/cli-agent/profiles/` exists with mode `0700`. Each profile
file must be created with mode `0600`. Both YAML (`.yaml`/`.yml`) and JSON
(`.json`) extensions must be supported on read; the `profile create`
subcommand writes one canonical extension (default: `.yaml` — see Assumptions).

### FR-PROF-002 — Profile schema (v1)

A profile is a structured document with the following top-level keys, all
optional:

```yaml
# ~/.tool-agents/cli-agent/profiles/<name>.yaml
name: <string>             # MUST equal the filename stem; validated on load.
description: <string>      # Free-form, used by `profile list` / `show`.
schemaVersion: 1           # Reserved for future migrations. Default: 1.

cliParams:                 # Section 1: CLI parameter presets.
  provider: <string>
  model: <string>
  temperature: <number>
  maxIterations: <integer>
  workingDir: <string>
  logLevel: <string>
  webSearchBackend: <string>
  allowMutations: <boolean>
  # ... any cli-agent CLI/config knob the user wishes to pin.

tools:                     # Section 2: Broad-scope tool list scoping.
  allow: [<toolName>, ...]   # Optional. If present and non-empty: only these tools
                             #   (intersected with the registered catalog) survive.
  deny:  [<toolName>, ...]   # Optional. Removed AFTER allow is applied.
  order: [<toolName>, ...]   # Optional. Subset of survivors, in display order.
                             #   Survivors not listed in `order` are appended
                             #   in their original registration order.

toolArgs:                  # Section 3: Per-tool argument presets.
  <toolName>:              # e.g. "bash_run", "web_search", "agt_grep"
    <argName>: <value>     # Default values for that tool's flags/arguments.
```

All three top-level sections (`cliParams`, `tools`, `toolArgs`) must be
independently optional. An empty profile (e.g. only `name:`) is legal but
inert — see edge cases.

### FR-PROF-003 — Activation surface

A profile is activated via:

- CLI flag: `--profile <name>` (highest priority for activation).
- Env var: `CLI_AGENT_PROFILE=<name>` (acts only when the flag is absent).

When neither is set, no profile is active; behavior is identical to the
pre-feature baseline.

`<name>` must match a profile file in
`~/.tool-agents/cli-agent/profiles/<name>.{yaml|yml|json}` (case-sensitive on
case-sensitive filesystems; the loader normalizes by stem). When the named
profile does not exist, the agent must exit with a `UsageError` (exit 2) — see
edge cases.

### FR-PROF-004 — Precedence (the central invariant)

Profile values participate in the existing four-tier resolution chain at a
**single, well-defined tier between `config.json` and `~/.tool-agents/cli-agent/.env`**.
The composed resolution order, from highest priority (wins) to lowest, becomes:

```
1. CLI flag (explicit)                                     ← always wins
2. Shell environment variable
3. ~/.tool-agents/cli-agent/.env
4. Local ./.env
5. PROFILE cliParams (if --profile / CLI_AGENT_PROFILE is active)   ← NEW
6. ~/.tool-agents/cli-agent/config.json
7. Built-in defaults (where applicable; otherwise ConfigurationError)
```

User-facing invariant (must hold unconditionally): **explicit CLI flags
supplied at invocation override profile values.** Equivalently: passing
`--profile foo --model gpt-5` uses `gpt-5`, regardless of what
`profiles/foo.yaml: cliParams.model` says.

Rationale for placing profiles at tier 5 (between `.env` and `config.json`):
profiles are intended as named *reusable presets* of `config.json`-like
settings. Putting them just above `config.json` (a) lets them override
`config.json` for the current invocation, (b) keeps shell env / `.env`
overrides effective (the existing "I tweaked my shell" workflow keeps
working), and (c) lets explicit CLI flags win, satisfying the user's
non-negotiable invariant. See "Assumptions" if a different tier is preferred.

### FR-PROF-005 — Tool list scoping semantics

The registered tool catalog (the same set produced by today's
`buildToolCatalog(cfg)`, after umbrella/per-tool agent-tools flags and
mutation-gating have been applied) is filtered by the profile's `tools`
section in this strict order:

1. **`allow`** — if present and non-empty, the catalog is intersected with
   `allow`. If `allow` is present and empty (`[]`), this is a hard validation
   error (see edge cases). Tools listed in `allow` that are not in the
   registered catalog produce a warning on stderr but do not abort.
2. **`deny`** — every name in `deny` is removed from the survivors. Tools
   listed in `deny` that are not in the survivor set produce a warning on
   stderr but do not abort.
3. **`order`** — survivors are reordered: tools listed in `order` come first
   in the listed order; remaining survivors keep their original registration
   order and are appended.

Each sub-key (`allow`, `deny`, `order`) is independently optional. If all three
are absent, the catalog is unchanged. The result MUST be a non-empty catalog;
a profile that disables every tool produces a `ConfigurationError` (see edge
cases).

### FR-PROF-006 — Per-tool argument merge

For every tool invocation, the effective argument object is computed as:

```
effectiveArgs = { ...profile.toolArgs[toolName] ?? {}, ...runtimeArgs }
```

I.e. a **shallow, per-key merge** where runtime arguments win on a per-key
basis. Profile-set arguments for keys NOT supplied at runtime continue to
apply. The merge happens in the tool dispatcher, after the LLM has emitted
its tool call but before the underlying handler runs.

`toolArgs` must be validated against each tool's known input schema at
profile-load time (best-effort: tools with Zod schemas in the registry are
validated; tools whose schema is dynamic — e.g. wrapped CLI tools without a
fixed Zod input — get a runtime warning instead of a load-time failure).

### FR-PROF-007 — Activation telemetry

When a profile is active, the structured log (JSONL session log) must include
a `profile_active` event near `session_start` carrying: profile name,
resolved file path, schema version, and a digest (SHA-256 hex prefix) of the
profile file contents. This makes runs reproducible and auditable.

### FR-PROF-008 — `profile list` subcommand

`cli-agent profile list` enumerates all profiles in
`~/.tool-agents/cli-agent/profiles/`. Output columns: name, description (first
line), file size, mtime. Exit 0 even when the directory is empty (printing a
hint message). Exit 6 (IO error) on filesystem failure.

### FR-PROF-009 — `profile show` subcommand

`cli-agent profile show <name>` parses the profile, validates it, and prints:

- The raw file contents (verbatim).
- The parsed/normalized form (after schema validation).
- A summary block: which CLI params would be pinned, the resulting tool
  catalog (computed against the *current* registered tool set), and the
  per-tool argument presets.

Exit 0 on success; exit 2 if `<name>` does not exist; exit 3 on schema
validation failure.

### FR-PROF-010 — `profile create` subcommand

`cli-agent profile create <name> [--from-current] [--description "..."]`
scaffolds a new profile file. Default scaffold: minimal stub with `name`,
`description`, `schemaVersion: 1`, and three commented-out sections. With
`--from-current`, the scaffold captures the currently resolved configuration
(provider, model, etc.) into `cliParams`. Exit 2 if `<name>` already exists
(use `--force` to overwrite). The resulting file MUST be created with mode
`0600`.

### FR-PROF-011 — `profile edit` subcommand

`cli-agent profile edit <name>` opens
`~/.tool-agents/cli-agent/profiles/<name>.{yaml|json}` in `$EDITOR` (falling
back to `$VISUAL`, then `vi`/`notepad` per platform). After the editor
exits, the file is re-validated and an exit-2 message is printed if the new
contents fail validation (the file is left as-is so the user can fix it).

### FR-PROF-012 — `profile delete` subcommand

`cli-agent profile delete <name> [--yes]` deletes the profile file after a
confirmation prompt (skipped with `--yes`). Exit 2 if `<name>` does not exist.

### FR-PROF-013 — `profile dry-run` subcommand

`cli-agent profile dry-run [--profile <name>] [other flags]` performs the full
configuration resolution (including merging shell env, `.env`, profile,
`config.json`, and any explicit CLI flags supplied alongside) and the full
tool-scoping pass against the registered catalog, then prints a human-readable
report of the effective configuration that *would* be used to launch the
agent. It does NOT instantiate the LLM, does NOT run capability discovery, and
does NOT execute any tools. Exit codes mirror normal config validation
(0 / 2 / 3).

### FR-PROF-014 — Documentation registration

The feature must be registered in:

- `docs/design/project-functions.md` — new `FR-PROF-*` section mirroring the
  ones above.
- `docs/design/project-design.md` — new "Profiles" subsection in §2/§3 that
  shows where profile loading sits in the bootstrap pipeline; updated
  precedence diagram.
- `docs/design/configuration-guide.md` — new "Configuration Profiles" section
  per the configuration-guide template (purpose, options, defaults,
  recommended storage, no-fallback rule, expiration n/a).
- `docs/tools/cli-agent.md` — `<configurationProfiles>` subsection inside the
  `<cliAgent>` block.

### FR-PROF-015 — No silent fallbacks

A missing required configuration value remains a `ConfigurationError` (exit
3). Profiles **never substitute** a missing required value with a default
silently; they are an additional source of explicit values, not a fallback
mechanism. (Per project rule: "no fallback for required values.")

### FR-PROF-016 — Coexistence with tool-prompt overlays

Profiles and overlays are orthogonal:

- Overlays (`~/.tool-agents/cli-agent/tool-prompts/<tool>.md`) change a
  tool's *prompt text* (description and parameter docstrings).
- Profiles change *which tools are exposed* and *what default arguments they
  carry*.

When a profile's `tools.allow`/`deny`/`order` removes a tool from the
catalog, the corresponding overlay file is simply unused for that run — it
remains on disk untouched. There is no migration, deletion, or rewriting of
overlay files driven by profile activation.

When a profile's `toolArgs` references a tool that is excluded by
`tools.deny` (or by `tools.allow` not listing it), the references for the
excluded tool are dead-code and produce a warning on stderr at load time
(non-fatal).

### NFR-PROF-001 — Startup latency

Profile loading and validation must add no more than 50 ms to cold-start time
in the no-profile case (must short-circuit when `--profile` and
`CLI_AGENT_PROFILE` are both unset) and no more than 100 ms in the
with-profile case for a typical profile (≤ 32 KB).

### NFR-PROF-002 — File mode invariants

Profile files must always be created with mode `0600` and the directory with
mode `0700`, matching the rest of `~/.tool-agents/cli-agent/`. Asserted by a
unit test on `bootstrapAgentDir`.

### NFR-PROF-003 — Schema validation with Zod

The profile schema must be expressed as a Zod schema in TypeScript and reused
by the loader, the `profile show`/`dry-run` subcommands, and the `profile
create --from-current` writer. No ad-hoc parsers.

### NFR-PROF-004 — Test coverage

Unit + integration tests must cover: every edge case enumerated below, the
precedence chain (assertion that explicit CLI flags beat profile values for
each pinnable knob), the tool-scoping ordering (`allow` then `deny` then
`order`), the merge semantics for `toolArgs`, and at least one full
end-to-end test that launches with `--profile` and verifies the active tool
catalog matches the profile.

## Constraints

- **Language / runtime**: TypeScript, Node.js 20+, Vitest for tests
  (matches existing project tooling).
- **Configuration rule**: No fallback defaults for required values. Missing
  required value → `ConfigurationError` (exit 3). Profiles cannot weaken this
  rule.
- **Filesystem layout convention**: `~/.tool-agents/cli-agent/profiles/`,
  directory mode `0700`, files mode `0600`. Matches `.env`, `logs/`,
  `capabilities/`, `tool-prompts/`.
- **No version-control side effects**: profile create/edit/delete touch only
  the user's home directory; never the repo.
- **Tool-creation rule**: any new code that scaffolds, validates, or edits
  profile files outside the agent itself must be considered for the toolset
  (see CLAUDE.md). v1 likely keeps profile management *inside* the cli-agent
  subcommands, so no new generic tool is needed; if a generic
  "structured-config-file editor" pattern emerges, it should be lifted into a
  dedicated tool per project conventions.
- **Existing code paths must not change defaults**: when no `--profile` /
  `CLI_AGENT_PROFILE` is set, every existing test must keep passing
  byte-for-byte (regression invariant).

## Acceptance Criteria

Each criterion is testable.

1. **Storage scaffolded correctly.** First run (without `--profile`) creates
   `~/.tool-agents/cli-agent/profiles/` with mode `0700`. Asserted by a unit
   test on `bootstrapAgentDir`.
2. **Profile activation via CLI flag.** A profile file `foo.yaml` containing
   `cliParams: { temperature: 0.7 }` is loaded by
   `cli-agent --profile foo "..."`, and the LLM is constructed with
   `temperature: 0.7`. Asserted by an integration test.
3. **Profile activation via env var.** `CLI_AGENT_PROFILE=foo cli-agent "..."`
   produces the same result as criterion 2. Asserted by an integration test.
4. **CLI flag beats profile.** Running
   `cli-agent --profile foo --temperature 0.1 "..."` results in
   `temperature: 0.1`, not `0.7`. Asserted by an integration test for at
   least three distinct knobs (provider, model, temperature).
5. **Shell env beats profile.** Setting an env var that maps to a `cliParam`
   while a conflicting profile value is set results in the env value winning.
   Asserted by a unit test.
6. **Profile beats `config.json`.** A profile-set `cliParam` overrides the
   value in `config.json` for the same knob. Asserted by a unit test.
7. **Allowlist scoping.** A profile with `tools.allow: [bash_run, web_search]`
   produces a tool catalog containing only those two tools (intersected with
   the registered set). Asserted by a unit test on `applyProfileToCatalog`.
8. **Denylist scoping.** A profile with `tools.deny: [agt_grep]` produces a
   catalog identical to the unscoped one minus `agt_grep`. Asserted by a unit
   test.
9. **Reordering.** A profile with `tools.order: [web_search, bash_run]`
   places those two tools first in the catalog (in that order); other tools
   follow in their original order. Asserted by a unit test.
10. **Combined scoping.** A profile with all three sub-keys applies them in
    the documented order (`allow` → `deny` → `order`). Asserted by a unit
    test.
11. **Per-tool args merge.** A profile with
    `toolArgs: { web_search: { maxResults: 10 } }` and a runtime tool call
    that does NOT supply `maxResults` results in `maxResults: 10` reaching
    the tool handler; a runtime tool call that DOES supply
    `maxResults: 3` results in `maxResults: 3` reaching the handler.
    Asserted by a dispatcher unit test.
12. **Other profile args still apply when one is overridden.** A profile with
    `toolArgs: { web_search: { maxResults: 10, includeRaw: true } }` and a
    runtime call supplying `maxResults: 3` results in
    `{ maxResults: 3, includeRaw: true }` reaching the handler. Asserted by
    a dispatcher unit test.
13. **`profile list` works.** With three profiles on disk, `cli-agent profile
    list` prints a three-row table, exit 0. With zero profiles, prints a
    hint, exit 0.
14. **`profile show <name>` works.** Prints raw + normalized + summary; exit
    2 on missing; exit 3 on malformed.
15. **`profile create <name>` scaffolds correctly.** Produces a file with
    mode `0600` containing the expected stub; exit 2 if name exists without
    `--force`.
16. **`profile dry-run --profile foo` reports correctly.** Prints the
    effective config without launching the LLM; exit 0 on success.
17. **Edge cases handled per the table below** (profile not found, malformed
    file, missing tool reference, empty profile, profile that disables every
    tool, etc.).
18. **Coexistence with overlays.** A run with `--profile` active uses
    overlays for the tools that survive scoping; overlays for excluded tools
    are silently unused (asserted by a test that loads both subsystems and
    inspects the resulting tool descriptions).
19. **Logging.** A `profile_active` JSONL event appears in the session log,
    carrying name, path, schemaVersion, and contents-digest. Asserted by a
    log-stream test.
20. **Documentation updated.** `project-functions.md`,
    `project-design.md`, `configuration-guide.md`, and
    `docs/tools/cli-agent.md` each contain the documented sections;
    cross-references are intact.
21. **No regression.** The full existing test suite passes with the feature
    OFF (no `--profile` / `CLI_AGENT_PROFILE` / `profile` subcommand
    invoked).
22. **Cold-start budget.** Measured cold-start of `cli-agent --help` with the
    feature compiled in but no profile active is within 50 ms of the
    pre-feature baseline (measured by an existing or new smoke script).

## Edge Cases

The following table enumerates every edge case and the required behavior. Each
row maps to an explicit test in the acceptance criteria.

| # | Edge case | Required behavior |
|---|-----------|-------------------|
| E1 | `--profile foo` but no `profiles/foo.{yaml|yml|json}` exists | `UsageError` (exit 2). Error message names the resolved path searched and lists available profiles. |
| E2 | Profile file is malformed YAML/JSON | `ConfigurationError` (exit 3). Error message names the file path and the parser's line/column where possible. |
| E3 | Profile schema validation fails (unknown top-level key, wrong type) | `ConfigurationError` (exit 3). Error names the offending key and the expected type. |
| E4 | Profile's `name:` field disagrees with the filename stem | `ConfigurationError` (exit 3). |
| E5 | Profile is empty (just `name:`) | Treated as inert. The agent runs with no profile-driven changes; a single-line stderr notice ("profile <name> is empty") prints to make the no-op visible. |
| E6 | `tools.allow: []` (explicitly empty array) | `ConfigurationError` (exit 3). An empty allowlist would disable every tool — almost certainly a user error. |
| E7 | Profile disables every tool (e.g. `tools.allow: [does_not_exist]` so the catalog comes out empty) | `ConfigurationError` (exit 3). Error suggests removing the offending entry. |
| E8 | Profile references a tool that no longer exists (e.g. `tools.allow: [old_tool]` where `old_tool` was removed) | Warning on stderr; the unknown name is silently dropped from the effective allowlist. Same for `deny` and `order`. Does NOT abort. |
| E9 | Profile's `toolArgs` references a tool that is not in the final catalog (excluded by `allow`/`deny`) | Warning on stderr; the dead-code reference is dropped. Does NOT abort. |
| E10 | Profile's `toolArgs` provides an argument that fails the tool's Zod schema | Validation at profile-load time: `ConfigurationError` (exit 3) for schema-known tools; runtime warning for dynamically-schema'd tools. |
| E11 | Profile contains a credential-shaped key (e.g. `cliParams.OPENAI_API_KEY` or any value matching `*_API_KEY`/`*_TOKEN`/`*_SECRET`) | `ConfigurationError` (exit 3). Profiles MUST NOT store secrets. |
| E12 | Both `--profile` (CLI) and `CLI_AGENT_PROFILE` (env) are set with different values | CLI flag wins. The env value is silently ignored. |
| E13 | Same `--profile foo` flag passed multiple times on the command line | Last-wins (Commander.js default). No error. |
| E14 | `--profile` flag passed with no argument | Commander.js usage error (exit 2). |
| E15 | Profile collides with existing tool-prompt overlay (a tool is excluded by profile but has an overlay) | No collision: overlay is silently unused for that run; overlay file is untouched. |
| E16 | Profile filename contains characters illegal on the filesystem (e.g. `/`, `\`, leading `.`) | `UsageError` (exit 2) at load time. `profile create` rejects the name proactively. |
| E17 | `~/.tool-agents/cli-agent/profiles/` is unreadable (permission denied) | `IOError` (exit 6). |
| E18 | Both `<name>.yaml` and `<name>.json` exist | `ConfigurationError` (exit 3). Ambiguity is not silently resolved. |
| E19 | Profile sets `allowMutations: true` but `--allow-mutations` is not passed and shell env is unset | The profile-supplied value applies (per the precedence chain — profile beats config.json). The mutation-gated tools become visible. This is intentional: profiles are an explicit user opt-in. Documented in the configuration guide. |
| E20 | Profile sets a value for a knob that does not exist on the current cli-agent version (forward-compatibility) | Warning on stderr; the unknown knob is ignored. Does NOT abort, to allow profiles to outlive minor version churn. (Justification: Zod `.passthrough()` on `cliParams` with a separate "known-keys" set used for validation.) |
| E21 | `tools.order` lists a tool that is not in the survivor set after `allow`+`deny` | Warning on stderr; the unknown name is dropped from the order. Does NOT abort. |
| E22 | `tools.order` lists a tool twice | `ConfigurationError` (exit 3). |
| E23 | `tools.allow` and `tools.deny` both list the same tool | `ConfigurationError` (exit 3). The intent is ambiguous. |

## Assumptions

The following decisions were made during refinement based on project context
and existing conventions. They should be reviewed before planning.

1. **Profile file format default**: `profile create` writes YAML by default
   (rationale: better human-edit ergonomics for multi-line / commented files
   than JSON; `config.json` already exists in JSON, so YAML profiles are
   visually distinct and reduce confusion). Both formats remain readable. If
   the user prefers JSON-by-default, this is a one-line change.
2. **Precedence tier**: profiles slot in **between local `.env` (tier 4) and
   `config.json` (tier 6 in the new chain)**. Justification: profiles are
   reusable named presets of `config.json`-style settings; placing them
   immediately above `config.json` lets the user override their default
   `config.json` for the current run while preserving the "explicit shell
   env / `.env` / CLI flag wins" workflow. The user-facing invariant
   (CLI flag wins) holds in any case.
3. **Activation source set**: `--profile <name>` flag and
   `CLI_AGENT_PROFILE` env var only. No `defaultProfile` key in
   `config.json` for v1.
4. **Single active profile**: exactly one profile per invocation (no
   layering, no inheritance) for v1.
5. **Subcommand naming**: `cli-agent profile <verb>` (subcommand group),
   matching the existing pattern (`show-capabilities`,
   `refresh-capabilities`). If the project prefers hyphenated single-segment
   subcommands (e.g. `profile-list`), this is purely cosmetic.
6. **Argument-merge depth**: shallow per-key merge for `toolArgs`. Deep merge
   (for nested object args) is deferred — no current cli-agent tool has a
   deeply nested input schema that would benefit, and shallow merge is
   simpler and unambiguous.
7. **Profile-file digest in logs**: SHA-256 hex prefix (first 16 chars) for
   reproducibility without bloating log lines.
8. **Credential-shape regex for E11**: case-insensitive
   `(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$` on key names. Kept conservative;
   project rule "no secrets in profiles" is the user-visible contract.
9. **`profile dry-run` does NOT spawn child processes**: it only resolves
   config and computes the effective catalog. Capability discovery and LLM
   construction are skipped to keep the command fast.
10. **TUI integration deferred**: a `/profile <name>` slash command would be
    valuable but is explicitly out of v1 scope; the TUI continues to show the
    profile that was activated at launch (visible via `/help` summary, if
    desired) but cannot switch profiles mid-session in v1.

## Open Questions

None blocking implementation; the user pre-confirmed the three high-level
semantics (precedence invariant, broad scoping, mergeable args). Items below
are implementation-time decisions the planner / designer should confirm:

1. **Exact tier choice** (Assumption 2): is "between local `.env` and
   `config.json`" the right insertion point, or should profiles sit between
   `~/.tool-agents/cli-agent/.env` and local `.env`? Either preserves the
   "CLI flag wins" invariant; the choice affects whether a project's local
   `.env` overrides a personal profile (current proposal: yes, local `.env`
   wins).
2. **Default file format** (Assumption 1): YAML or JSON for `profile create`
   default output?
3. **Subcommand naming style** (Assumption 5): `cli-agent profile <verb>`
   group vs. `cli-agent profile-<verb>` discrete subcommands?
4. **Whether to ship a v1 TUI status line** showing the active profile (a
   minimal, non-interactive readout — as opposed to the deferred `/profile`
   switcher).

## Original Request

```
Add a "configuration profiles" feature to cli-agent. A profile is a named, persistent harness preset that the user can create, save, and invoke by name to launch the agent with a pre-configured set of CLI parameter values, a curated tool list, and per-tool argument presets.

A profile contains three optional sections:

1. **CLI parameter presets** — predefined values for any of the agent's existing CLI flags (provider, model, temperature, max-iterations, working directory, log level, web-search backend, etc.). The user decides which flags to pin in a given profile.

2. **Tool list scoping** — a broader-scope mechanism (NOT just an allowlist) that supports:
   - Allowlist (only these tools are exposed to the LLM)
   - Denylist (everything except these tools)
   - Reordering (control the order tools are advertised to the LLM, since order can affect tool-use behaviour)

3. **Per-tool argument presets** — for each tool the user opts to configure, predefined default values for that tool's flags/arguments. These presets must be **mergeable with runtime arguments** — meaning if the user (or the LLM) supplies an argument at call time, it overrides the profile preset for that one call, but other profile-set arguments still apply.

User-confirmed semantics:
- **Layered precedence**: profiles slot into the project's existing four-tier env-var resolution chain (shell env → ~/.tool-agents/cli-agent/.env → local .env → CLI flags). Explicit CLI flags supplied at invocation MUST override profile values. The exact tier where profiles enter is a design decision the planner/designer will resolve, but the invariant is: explicit CLI flags win.
- **Tool list scope is broad**: must support allowlist + denylist + reordering, not just allowlist.
- **Per-tool presets are mergeable**: runtime argument supplied for a single tool call overrides only that argument; other profile-set arguments for that tool still apply. Strict "profile wins" mode is NOT in scope for v1.

Context the refiner should incorporate:
- The cli-agent is a TypeScript LangGraph ReAct agent. Configuration today flows through a four-tier resolution chain (see CLAUDE.md and docs/design/configuration-guide.md).
- The agent already supports per-tool prompt overlays under ~/.tool-agents/cli-agent/tools/ (plan-004). Profiles must coexist with overlays — they are orthogonal: overlays change a tool's *prompt*, profiles change *which tools are exposed* and *what default args they get*.
- Profile storage location should follow the existing convention — under ~/.tool-agents/cli-agent/profiles/<name>.{yaml|json}.
- Activation should be via a new --profile <name> CLI flag and a CLI_AGENT_PROFILE env var.
- Profile management commands (list / show / create / edit / delete / dry-run-merge) are expected.
- Profiles must be discoverable: cli-agent must be able to list available profiles and show what each one would do without launching.
```
