# Refined Request: Composite Intelligent Tools (cli-agent as a tool)

## Category

Development (feature) — adds new CLI flags, subcommand semantics, an LLM
synthesis pipeline, a new capability-document subtype, a wrapper-shim
generator, and a virtual-tool registry extension to the existing cli-agent
runtime. Touches: CLI parsing, configuration resolution, capability discovery,
capability cache, system-prompt composition, tool registry, on-disk layout
under `~/.tool-agents/cli-agent/`.

## Objective

Allow a user to package a curated cli-agent invocation
(`cli-agent --tool A --tool B …`) as a *new* "composite intelligent tool"
that can itself be attached to an outer cli-agent invocation via
`--tool <composite-id>`. The work delivers (a) a synthesised capability
document for the composite, (b) an executable wrapper shim, and (c) a
virtual-tool registration path inside cli-agent — collectively known as
"intelligent tools" v1. Every existing flag, behavior, exit code, and
capability-doc consumer must remain byte-identical when the new flags are
not used.

## Scope

### In scope (v1)

- New CLI flag `--treat-as-tool` and its interaction matrix with
  `--help`, `--regenerate-capabilities`, `--composite-name`,
  `--emit-doc`, `--emit-wrapper`, `--register-virtual`, and
  `--dry-run-synthesis`.
- A two-stage LLM synthesis pipeline (per-member distillation → composite
  composition) producing a schema-3 capability document.
- A new capability-document `schemaVersion: 3` adding the `composite`,
  `members`, `synthesizedAt`, `syntheticDigest`, and `compositeName`
  frontmatter fields, keeping `manRef`, `manPagePath`, USER-RECIPES, and
  USER-NOTES contracts from schema-2.
- Cache layout extension under
  `~/.tool-agents/cli-agent/capabilities/composite/<id>.md` keyed by
  `(sorted member tool list, each member's capability-doc digest, cli-agent
  version, capability-schema version, composite-name)`.
- Three opt-in distribution forms with the defaults below:
  - **(a) Doc emission** (`--emit-doc`, default ON when `--treat-as-tool`):
    write `~/.tool-agents/cli-agent/capabilities/composite/<id>.md` and
    print the synthesised doc on `--help`.
  - **(b) Wrapper shim** (`--emit-wrapper`, default OFF): write an
    executable POSIX shell shim under
    `~/.tool-agents/cli-agent/composites/<id>/<id>` (mode `0700` for the
    folder, `0700` for the shim file) that re-invokes
    `cli-agent --tool <member1> --tool <member2> … "$@"` and that responds
    to `--help` by printing the cached composite capability doc verbatim
    on stdout.
  - **(c) Virtual tool registration** (`--register-virtual`, default OFF):
    persist a manifest at
    `~/.tool-agents/cli-agent/composites/<id>/manifest.json` (mode `0600`)
    so the cli-agent tool registry can recognise `--tool <id>` without a
    PATH binary and dispatch in-process to a meta-tool handler that
    re-runs the cli-agent agent loop with the recorded member tool list.
- `--regenerate-capabilities` (orthogonal new flag) that forces synthesis
  even on cache hit; honored only when `--treat-as-tool` is in effect.
- Preservation of `<!-- USER-RECIPES:START -->…<!-- USER-RECIPES:END -->`
  and `<!-- USER-NOTES:START -->…<!-- USER-NOTES:END -->` blocks across
  re-synthesis (mirrors FR-CAP-102 / FR-AGT-007).
- Snapshot-based testing of the synthesis pipeline using a stub LLM that
  returns canned outputs keyed by prompt digest.
- Coexistence with existing features: profiles, prompt overlays,
  capability recipes, manRef, agent-tools pack, mutation gating, bash
  allowlist auto-seeding.
- Documentation updates to `project-design.md`, `project-functions.md`,
  `configuration-guide.md`, `docs/tools/cli-agent.md`, plus a plan file
  (`docs/design/plan-006-composite-tools.md`) created after this spec is
  approved.

### Out of scope (deferred to v1.1+)

- **Composite-of-composite recursion**: a composite whose member list
  contains another composite. v1 detects this case and exits 2 with a
  clear "composite-of-composite is not supported in v1" diagnostic.
- **Cross-machine sync** of composites (e.g., bundling them as a portable
  archive, publishing to a registry, signing).
- **Secret redaction inside synthesised recipes** beyond the existing
  JSONL log redaction. The synthesis pipeline is asked, by prompt, to
  refrain from emitting credential-shaped placeholders, but no
  programmatic post-filter is implemented in v1.
- **TUI slash commands** for composite creation / inspection
  (`/composite-create`, `/composite-show`, etc.). v1 ships CLI surface
  only.
- **Automatic regeneration on member-tool overlay change**. v1 treats
  prompt-overlay edits as non-invalidating by default; the user
  re-synthesises explicitly. (See Open Questions O-1.)
- **Profile interaction beyond passthrough**. v1 records the active
  profile name in the synthesised doc's frontmatter for traceability
  but does not change synthesis behavior based on profile content.
- **Granular budget controls per stage** of the synthesis pipeline.
  v1 exposes one combined `--synthesis-budget-tokens <n>` knob.

## Requirements

### FR-CMP-001 — `--treat-as-tool` is metadata only when used alone

When `--treat-as-tool` is supplied without `--help` and without an
emit/register flag, cli-agent's runtime behavior must be byte-identical
to a normal one-shot or TUI run. The flag exists to gate the
help-synthesis path and to mark the run as a composite candidate.

### FR-CMP-002 — `--help` re-routing under `--treat-as-tool`

When BOTH `--treat-as-tool` AND `--help` are supplied AND at least one
`--tool <name>` is declared, cli-agent must NOT print its own help text.
Instead it must run the synthesis pipeline (or load from cache) and
print the resulting capability document on stdout, then exit 0.

When `--treat-as-tool` is absent, `--help` must print cli-agent's own
help text exactly as today (no behavior drift).

### FR-CMP-003 — Empty member list under `--treat-as-tool --help`

`cli-agent --treat-as-tool --help` with no `--tool` arguments and no
profile-supplied member list must exit 2 (UsageError) with the message
`composite synthesis requires at least one --tool argument`. There is
no degenerate doc; this is an explicit error.

### FR-CMP-004 — Schema-3 capability document

The synthesised document must extend schema-2 with these additional
frontmatter keys:
- `schemaVersion: 3`
- `composite: true`
- `compositeName: <id>`
- `members: [<sorted member tool names>]`
- `memberDigests: { <name>: <sha256-hex-prefix-16>, ... }`
- `synthesizedAt: <ISO 8601>`
- `syntheticDigest: <sha256-hex-prefix-16 of canonicalised inputs>`
- `cliAgentVersion: <semver>`
- `synthesisModel: <provider>:<model-id>`
- `activeProfile: <name | null>` (traceability only — not used as input)

The document must contain the same body sections expected of a
discovery-produced doc (synopsis, AUTO-GENERATED block, USER-RECIPES,
USER-NOTES) so that an outer cli-agent's existing capability consumer
loads it transparently.

### FR-CMP-005 — Schema validator parity

The schema-3 document must pass the same structural validators that
schema-2 docs pass (presence of frontmatter, AUTO-GENERATED markers,
USER-RECIPES markers, USER-NOTES markers, H1 = canonical tool name).
The capability loader must accept `schemaVersion` ∈ {2, 3}; v1 docs
remain a cache miss as before.

### FR-CMP-006 — Two-stage synthesis pipeline

Stage 1: per-member distillation. For each member tool, call the LLM
with its capability doc and produce a structured "intent surface"
extract (top-level intents, parameter glossary, illustrative examples).

Stage 2: composition. Feed the array of stage-1 outputs into a single
LLM call that emits the AUTO-GENERATED body of the composite doc plus
a curated set of cross-tool recipes pre-filled into the USER-RECIPES
block. The pipeline must use the LLM provider, model, and API
configuration already resolved for the cli-agent run (via the standard
4-tier precedence chain). No alternate provider / no alternate auth.

### FR-CMP-007 — `--dry-run-synthesis`

`cli-agent --treat-as-tool --tool A --tool B --dry-run-synthesis` must
print, to stdout, the exact prompts that WOULD be sent to the LLM
(both stages, in order) along with the model identifier and a SHA-256
digest of each prompt, then exit 0 without contacting the LLM and
without writing any cache. The flag is allowed alongside `--help`; in
that combination the dry-run output replaces the synthesised doc on
stdout.

### FR-CMP-008 — Synthesis token budget

A new knob `--synthesis-budget-tokens <n>` (config key
`composite.synthesisBudgetTokens`, env `CLI_AGENT_COMPOSITE_BUDGET`)
caps the combined input+output token count of the two-stage pipeline.
Default: `32768`. When the budget is exceeded mid-pipeline the
synthesis must abort with `UsageError` exit 2 naming the consumed
token count and the configured cap. There is no automatic fallback
to a smaller pipeline.

### FR-CMP-009 — Cache key + hit semantics

The cache file path is
`~/.tool-agents/cli-agent/capabilities/composite/<id>.md`. The cache
key includes:
1. the sorted list of member tool canonical names,
2. each member's capability-doc `syntheticDigest`-equivalent (sha256
   of the canonical bytes excluding the USER-RECIPES + USER-NOTES
   blocks),
3. the cli-agent semver,
4. the capability-schema major version,
5. the composite name (explicit or derived).

A hit serves the cached doc verbatim. The cache is invalidated when
ANY of the inputs above change. The cache is NOT invalidated by
member-tool overlay edits in v1 (see O-1 in Open Questions).

### FR-CMP-010 — `--regenerate-capabilities`

When supplied alongside `--treat-as-tool`, this flag forces a fresh
synthesis even on cache hit, atomically replacing the cached file
(tmp + rename). USER-RECIPES and USER-NOTES blocks from the existing
file (if any) are preserved byte-for-byte across the rewrite.

When supplied without `--treat-as-tool`, the flag is the existing
member-tool capability refresh and behaves exactly as today
(`refresh-capabilities` semantics).

### FR-CMP-011 — `--composite-name <id>` and derivation

When supplied, `<id>` is used verbatim as the composite name. It must
match `^[a-z][a-z0-9_-]{0,62}$`; violation is exit 2.

When omitted, the composite name is derived as
`<sorted-member-list-joined-by-+>@<hash8>` where `<hash8>` is the
first 8 hex chars of the sha256 of the canonical input set defined in
FR-CMP-009 keys 1–4. Example: `file-cli+outlook-cli@a1b2c3d4`.

### FR-CMP-012 — `--emit-doc` (distribution form a)

Default ON whenever `--treat-as-tool` is in effect. Writes the
synthesised doc to the cache path defined in FR-CMP-009. Explicit
`--no-emit-doc` opts out (synthesis still runs, output goes to
stdout only). The doc file is created at mode `0600`; the
`composite/` directory at mode `0700`.

### FR-CMP-013 — `--emit-wrapper` (distribution form b)

Default OFF. When supplied, after successful synthesis the agent
writes:
- `~/.tool-agents/cli-agent/composites/<id>/<id>` — POSIX shell
  shim, executable bit set, beginning with `#!/usr/bin/env bash`.
- `~/.tool-agents/cli-agent/composites/<id>/manifest.json` (also
  written by `--register-virtual`; the two flags share this file).

The shim's body must:
1. On `--help` (and `-h`), `cat` the cached composite capability doc
   to stdout and exit 0.
2. On any other invocation, exec `cli-agent --tool <m1> --tool <m2>
   … "$@"` preserving the original positional and flag arguments.
3. Set `LANG=C.UTF-8` if not already set.
4. Refuse to run if the cached capability doc is missing
   (exit 6, "composite cache stale; re-run cli-agent
   --treat-as-tool --regenerate-capabilities --composite-name <id>").

A subflag `--emit-wrapper-on-path` adds a symlink from
`~/.local/bin/<id>` to the shim. Default OFF; emits only with
explicit user opt-in to avoid silent PATH pollution.

### FR-CMP-014 — `--register-virtual` (distribution form c)

Default OFF. When supplied, the agent writes/updates the manifest at
`~/.tool-agents/cli-agent/composites/<id>/manifest.json` (mode
`0600`) with this shape:

```json
{
  "schemaVersion": 1,
  "compositeName": "<id>",
  "members": ["<m1>", "<m2>", ...],
  "memberDigests": { "<m1>": "<sha-prefix-16>", ... },
  "createdAt": "<ISO 8601>",
  "cliAgentVersion": "<semver>",
  "capabilityDocPath": "<absolute path to cached composite doc>"
}
```

The cli-agent tool registry, on every startup, must scan
`~/.tool-agents/cli-agent/composites/*/manifest.json` and register
each as a "virtual tool" recognised by `--tool <id>`. Resolution
order on `--tool <id>`:
1. Built-in tool name → registered tool.
2. Virtual tool manifest match → meta-tool handler.
3. PATH binary lookup → wrapped CLI tool (existing behavior).

A virtual tool's `--help` is satisfied by reading the
`capabilityDocPath` from its manifest. A virtual tool's runtime
invocation is dispatched to the meta-tool handler that re-runs the
cli-agent agent loop, in-process when feasible (configurable; see
FR-CMP-015) or as a child process otherwise, with the recorded
member tool list and a fresh per-call agent state.

### FR-CMP-015 — Virtual-tool dispatch mode

Two dispatch modes are supported, controlled by
`composite.virtualDispatch` config key (env
`CLI_AGENT_VIRTUAL_DISPATCH`):
- `child-process` (DEFAULT): fork a child cli-agent with the recorded
  `--tool` list. Robust isolation; one extra process per call.
- `in-process`: re-enter the cli-agent agent-graph builder with the
  recorded tool list, reusing the same Node process. Lower latency;
  may surface state-pollution bugs in v1.

`in-process` is opt-in and explicitly flagged "experimental" in v1
documentation. Both modes must produce identical observable output
on a stable test prompt; this is asserted by an integration test.

### FR-CMP-016 — Recursion guard

The meta-tool handler must reject a member list that itself contains
a registered virtual-tool name with a `UsageError` (exit 2) and
message `composite-of-composite is not supported in v1; member
'<id>' is itself a composite`. The check fires both at registration
time (`--register-virtual`) and at dispatch time.

### FR-CMP-017 — Composite-name collision policy

If `--composite-name <id>` is supplied AND a manifest at
`composites/<id>/manifest.json` exists with a DIFFERENT member set
or a different cli-agent version, the agent must:
- exit 2 (UsageError) by default with message `composite '<id>'
  already exists with a different member set or version; pass
  --force-overwrite to replace it`,
- accept `--force-overwrite` as the explicit opt-in to atomically
  replace both the manifest and the cached doc (USER-RECIPES /
  USER-NOTES preserved per FR-CMP-010).

If the existing manifest's member set + version match exactly, the
operation is idempotent and exits 0 without rewriting either file
beyond updating `synthesizedAt` if `--regenerate-capabilities` was
supplied.

### FR-CMP-018 — Missing constituent at synthesis time

If a declared `--tool <name>` has no cached capability document AND
the binary cannot be discovered on PATH, synthesis must abort with
exit 3 (ConfigurationError) naming the missing tool. There is NO
silent degradation, no placeholder synthesis. (Per CLAUDE.md no-
fallback rule.)

If the binary IS on PATH, the existing discovery flow runs first to
populate the constituent's capability doc, then synthesis proceeds.

### FR-CMP-019 — Profile passthrough during synthesis

When a profile is active during a `--treat-as-tool --help` run, its
`cliParams` apply to LLM provider selection (so synthesis uses the
profile's chosen model). Its `tools` scoping section is IGNORED for
the purpose of selecting composite members — only explicit
`--tool` flags constitute the member set. Its `toolArgs` are NOT
embedded in the synthesised doc. The active profile name is
recorded in `activeProfile` frontmatter for traceability only.

### FR-CMP-020 — System-prompt integration when consuming a composite

When an outer cli-agent loads a composite capability doc as a
wrapped tool, the existing system-prompt composition path
(FR-AGT-008, FR-CAP-105) applies unchanged. The doc's USER-RECIPES
block is embedded verbatim within the per-tool byte budget, the
synopsis falls back when the budget is exceeded. No new prompt
section is added — composites are opaque to the prompt builder.

### FR-CMP-021 — Logging

Synthesis runs must emit JSONL events at
`~/.tool-agents/cli-agent/logs/`:
- `composite_synthesis_start` — composite name, member list, cache
  hit/miss, dry-run flag.
- `composite_synthesis_stage` (one per stage) — stage index, prompt
  digest, token count input/output, latency.
- `composite_synthesis_end` — final status, total tokens, output
  digest, cache file path.
- `composite_emit` — per emitted artifact (doc, wrapper, manifest)
  with absolute path and mode.
- `composite_dispatch` — emitted by virtual-tool dispatch with
  composite name, dispatch mode (`child-process` / `in-process`),
  member list.

All writes follow the existing redaction policy. No prompt body or
LLM completion body is logged (digest only) to keep log volume
bounded.

### FR-CMP-022 — Subcommand surface (alternative to flag combo)

In addition to the flag-driven path, a sibling subcommand
`cli-agent composite synthesize --tool A --tool B [--composite-name
<id>] [--regenerate] [--emit-wrapper] [--register-virtual]
[--dry-run]` must accept the same options and produce identical
artifacts. The flag-driven `--treat-as-tool --help` form remains the
primary documented path; the subcommand exists for non-interactive
use and CI scripting where `--help` semantics are awkward.

Companion subcommands:
- `composite list` — table of registered virtual composites.
- `composite show <id>` — print the cached capability doc.
- `composite delete <id>` — remove the manifest, the wrapper folder,
  and the cached doc (with confirmation prompt; `--yes` to skip).
  The PATH symlink (if any) is removed too.

### FR-CMP-023 — Documentation registration

The feature must be documented in:
- `docs/design/project-functions.md` — a new "Composite Tools
  (FR-CMP-*)" section.
- `docs/design/project-design.md` — a new section after §12 with
  data flow, on-disk layout, dispatch architecture.
- `docs/design/configuration-guide.md` — the new env vars / config
  keys (`composite.synthesisBudgetTokens`,
  `composite.virtualDispatch`).
- `docs/tools/cli-agent.md` — a new `<compositeTools>` subsection.
- `docs/design/plan-006-composite-tools.md` — the implementation
  plan, created after this spec is signed off.

### NFR-CMP-001 — No drift on flag absence

A regression test must pin cli-agent's `--help` output and tool-
registration behavior with `--treat-as-tool` ABSENT. Diff against a
baseline snapshot (golden file) checked in with the implementation
plan must be empty.

### NFR-CMP-002 — Deterministic test harness

Synthesis tests must be deterministic via a stub LLM
(`testing.stubLlm.path`) that returns canned outputs keyed by
`sha256(prompt)`. The harness must allow recording fresh transcripts
in a controlled way, then replaying them in CI.

### NFR-CMP-003 — Synthesis latency ceiling (smoke test)

A synthesis run for a 2-member composite where each member doc is
≤ 32 KB must complete in under 30 s on the standard test machine
when using a stub LLM (network elided). A real-LLM smoke is
documented but not gated in CI.

### NFR-CMP-004 — Cache hit cost

A `--treat-as-tool --help` cache hit must complete (process boot →
stdout flushed → exit 0) in under 500 ms on the standard test
machine. Asserted by a smoke script.

### NFR-CMP-005 — File-mode invariants

`composite/` and `composites/` directories at mode `0700`; cached
doc, manifest, wrapper shim at mode `0700` (shim must be
executable) or `0600` (doc, manifest). Asserted by unit tests
extending `bootstrapAgentDir` mode checks.

### NFR-CMP-006 — Schema migration test

A schema-2 composite cache file (synthesised in a hypothetical
intermediate state) must be treated as cache miss and re-
synthesised. A unit test asserts this path.

### NFR-CMP-007 — Coexistence smoke

An end-to-end test must demonstrate, in a single run:
1. Profile activation.
2. Tool-prompt overlay applied to a member.
3. Member capability doc with USER-RECIPES.
4. Synthesis of a composite from the two members.
5. Outer cli-agent attaching the composite via `--tool <id>` and
   producing a coherent system prompt.

## Constraints

- **Language / runtime**: TypeScript on the existing cli-agent codebase
  under `src/`. New modules under `src/agent/composite/` (synthesizer,
  registry, manifest, dispatcher) and `src/cli/composite/` (subcommands,
  flag parsing).
- **No silent fallbacks**: every required configuration value (LLM
  provider, model, budget) must be either resolved through the existing
  4-tier chain or raise `ConfigurationError` (exit 3). Composite-specific
  knobs (synthesis budget, dispatch mode) ship with explicit, documented
  *defaults* (FR-CMP-008, FR-CMP-015) — these are starting values
  applied AFTER all four tiers, not fallbacks for missing required
  values.
- **No version-control operations** during implementation (per project
  convention).
- **No new LLM provider**. The synthesizer uses whatever provider the
  outer cli-agent run resolved.
- **No PATH pollution by default**. The `~/.local/bin/<id>` symlink is
  opt-in via `--emit-wrapper-on-path`.
- **Backwards compatibility**: schemaVersion 1 docs continue to be
  treated as cache miss; schemaVersion 2 docs continue to be loaded as
  today; new schemaVersion 3 is additive.
- **Configuration precedence**: the composite knobs slot into the
  standard 4-tier chain (FR-AGT-011 + FR-PROF-004 if a profile is
  active). CLI flag wins.
- **File modes**: `0700` directories, `0600` files, `0700` executable
  shims. Matches existing layout under `~/.tool-agents/cli-agent/`.
- **Logging**: existing JSONL schema extended with new event kinds.
  Existing redaction rules apply.
- **No fallback for required values**: if `--composite-name` is
  supplied but invalid → exit 2 (no derivation fallback). If a member
  tool's capability doc is missing AND its binary is absent → exit 3
  (no synthesis-without-input fallback).

## Acceptance Criteria

Each criterion is testable; pass/fail must be unambiguous.

1. **Pinned baseline**: `cli-agent --help` (no `--treat-as-tool`)
   produces the same byte-stream as a recorded baseline snapshot
   captured before implementation. `cli-agent --tool foo` (with
   `foo` an existing wrapped binary) produces the same tool catalog
   and system prompt as the pre-feature baseline.
2. **`--treat-as-tool --help` synthesis**: with a stub LLM,
   `cli-agent --tool member-a --tool member-b --treat-as-tool --help`
   produces a schema-3 capability doc on stdout containing all
   required frontmatter keys (FR-CMP-004), AUTO-GENERATED block,
   USER-RECIPES (pre-filled), USER-NOTES (empty), and exits 0.
3. **Empty member list**: `cli-agent --treat-as-tool --help` with no
   `--tool` exits 2 with the documented message.
4. **Cache hit**: a second invocation of the same command in test 2
   does not invoke the stub LLM, returns the same bytes, and meets
   NFR-CMP-004.
5. **Cache miss on member-doc change**: mutating member-a's
   AUTO-GENERATED bytes and re-running invalidates the cache and
   triggers a fresh synthesis.
6. **`--regenerate-capabilities` under `--treat-as-tool`**: forces
   re-synthesis on cache hit; USER-RECIPES and USER-NOTES survive
   verbatim across the rewrite.
7. **`--regenerate-capabilities` without `--treat-as-tool`**: behaves
   exactly as today (member-tool refresh).
8. **`--composite-name` validation**: a name violating the regex
   exits 2 with a naming-policy message. A name passing the regex
   produces an artifact path containing exactly that name.
9. **Auto-derived composite name**: omitting `--composite-name` with
   sorted members `[file-cli, outlook-cli]` produces a name matching
   `^file-cli\+outlook-cli@[0-9a-f]{8}$`.
10. **`--emit-doc` default ON; `--no-emit-doc` works**: doc exists at
    the cached path by default; with `--no-emit-doc` synthesis runs
    but the file is absent.
11. **`--emit-wrapper`**: produces an executable shim that, when run
    with `--help`, prints the cached doc; when run with arbitrary
    args, execs cli-agent with the recorded `--tool` list; refuses
    when the cache is missing.
12. **`--emit-wrapper-on-path`**: creates the symlink only when
    explicitly supplied; absent otherwise.
13. **`--register-virtual`**: writes the manifest; an outer cli-agent
    invocation `cli-agent --tool <id>` recognises the composite in
    the registry and dispatches via the configured dispatch mode.
14. **`--dry-run-synthesis`**: prints both stage prompts and digests,
    contacts no LLM, writes no cache file, exits 0.
15. **Recursion guard**: registering a virtual composite whose
    member list contains another registered virtual composite exits
    2 with the documented message.
16. **Collision policy**: re-registering a different member set under
    the same `--composite-name` exits 2; `--force-overwrite`
    succeeds; identical re-registration is idempotent.
17. **Missing constituent**: a member whose binary and cached doc
    are both absent triggers exit 3.
18. **Profile passthrough**: a `--treat-as-tool --help` run with an
    active profile that pins the model uses the profile's model and
    records `activeProfile: <name>` in the doc; tool-scoping does
    NOT override `--tool` member selection.
19. **Outer-agent consumption**: an outer cli-agent run attaching a
    composite via the wrapper shim, the virtual-registry path, and
    the doc-only path produces three coherent system prompts that
    embed the composite's USER-RECIPES content (when within byte
    budget).
20. **Coexistence smoke**: NFR-CMP-007 end-to-end test passes.
21. **Subcommand parity**: `cli-agent composite synthesize …`
    produces the same artifacts as the equivalent flag-driven
    invocation.
22. **`composite list/show/delete`**: produce expected output and
    side effects; `delete` removes manifest + wrapper folder +
    cached doc + symlink (if any).
23. **Logging**: `composite_synthesis_*`, `composite_emit`,
    `composite_dispatch` events appear with the documented payloads
    and obey existing redaction.
24. **File modes**: NFR-CMP-005 invariants asserted.
25. **Schema migration**: NFR-CMP-006 path exercised.
26. **No PATH pollution by default**: a synthesis without
    `--emit-wrapper-on-path` leaves `~/.local/bin/` untouched.
27. **Documentation**: all four registration sites updated; the
    plan file `plan-006-composite-tools.md` exists.

## Assumptions

The following assumptions were made during refinement; each is open
for challenge before implementation.

- **A-1**: The user's existing 4-tier configuration precedence
  (FR-AGT-011) is the right place for the new `composite.*` knobs.
  Profile precedence (FR-PROF-004) applies the same way.
- **A-2**: `child-process` is the safer dispatch default for v1;
  `in-process` is opt-in and labelled experimental until soak time
  is logged.
- **A-3**: Synthesis is expensive enough that defaulting `--emit-doc`
  ON (and writing to cache) is the right ergonomic for the user's
  primary workflow (`--treat-as-tool --help`).
- **A-4**: Defaulting `--emit-wrapper` and `--register-virtual` OFF
  is the right ergonomic — these have visible side effects on the
  filesystem and registry, so they should be opt-in. `--emit-doc`
  is information-only and acceptable as default-ON.
- **A-5**: The two-stage pipeline (per-member distill → compose) is
  the right LLM topology for v1. A single combined prompt is not
  exposed as a configuration option in v1 (KISS); revisit in v1.1.
- **A-6**: Member-tool overlay edits do NOT invalidate the cache in
  v1. Rationale: overlays change a tool's *prompt-time description*,
  and the cli-agent capability doc itself is built from `--help`
  output and is independent of overlay text. The user can force a
  re-synthesis with `--regenerate-capabilities`. Documented as
  Open Question O-1.
- **A-7**: `--composite-name` regex `^[a-z][a-z0-9_-]{0,62}$` is
  permissive enough for memorable names while staying safe for
  filesystem paths and shell tokens. Aligned with FR-PROF-008
  profile-name conventions.
- **A-8**: The synthesised composite doc is treated as a regular
  capability document by the OUTER cli-agent's existing capability
  loader — no new consumer code is needed on the consumption side
  beyond accepting `schemaVersion: 3`.
- **A-9**: An active profile influences the synthesis only via its
  pinned LLM model (so the run respects the user's chosen provider)
  but its `tools.allow/deny/order` does NOT alter composite member
  selection. The intent is that the user explicitly picks members
  via `--tool` flags. Documented in FR-CMP-019.
- **A-10**: The plan-005 capability-recipes / manRef contract
  (FR-CAP-101..108) applies transparently to schema-3 composite
  docs: the composite's USER-RECIPES block is editable and
  preserved across re-synthesis; `manRef` for a composite is
  always `null` because composites have no man page; the synthesised
  AUTO-GENERATED block does not include a manual-reference section.
- **A-11**: `extract-recipes` is NOT extended to composites in v1.
  The synthesis pipeline pre-fills USER-RECIPES with cross-tool
  recipes; further user-driven recipe extraction for a composite
  is deferred to v1.1.
- **A-12**: Logging digests rather than prompt/response bodies
  satisfies the audit requirement while keeping log volume bounded.
  A future debug knob may opt-in to body logging; out of scope for
  v1.

## Open Questions

- **O-1**: Should member-tool prompt-overlay changes invalidate the
  composite cache? v1 says NO (Assumption A-6). If user feedback
  during plan review prefers YES, add the overlay-file content
  digest to the cache key in FR-CMP-009.
- **O-2**: Should virtual-tool dispatch in `in-process` mode share
  the parent agent's conversation memory or always start fresh?
  v1 starts fresh on each call; this matches the "tool" mental
  model (stateless from the caller's perspective). Re-evaluate if
  multi-turn delegation becomes a use case.
- **O-3**: Should the synthesis pipeline expose per-stage budgets
  (`--synthesis-budget-stage1`, `--synthesis-budget-stage2`)?
  v1 ships one combined budget. Re-evaluate after measuring real
  pipeline cost distributions.
- **O-4**: What is the right behavior when a composite's recorded
  cli-agent version is OLDER than the running cli-agent? v1 treats
  this as a cache miss and re-synthesises silently. A noisier
  policy (warn the user) may be preferable; pending plan review.

## Flag Interaction Matrix

Authoritative table of valid / invalid combinations. Rows are the
new flags; columns are the modifier flags. `OK` = valid; `ERR-2` =
exit 2 UsageError with documented message; `N/A` = combination not
applicable.

| Flag set                                                  | Without `--treat-as-tool`            | With `--treat-as-tool` (no `--help`)         | With `--treat-as-tool` AND `--help`                                  |
|-----------------------------------------------------------|--------------------------------------|----------------------------------------------|----------------------------------------------------------------------|
| (none — bare invocation)                                  | Today's behavior                     | Treated as a normal run; flag is metadata    | Synthesise composite doc; print to stdout; exit 0                    |
| `--help`                                                  | Today's `--help` output              | N/A (caught above)                           | Synthesise composite doc; print to stdout; exit 0                    |
| `--regenerate-capabilities`                               | Existing `refresh-capabilities` flow | Force re-synthesis on next help; metadata    | Force re-synthesis; print fresh doc                                  |
| `--composite-name <id>`                                   | ERR-2 (`requires --treat-as-tool`)   | OK; recorded if synthesis happens later      | OK; used as composite id                                             |
| `--emit-doc` / `--no-emit-doc`                            | ERR-2 (`requires --treat-as-tool`)   | OK; affects future synthesis                 | OK; gates writing the cached file                                    |
| `--emit-wrapper` / `--emit-wrapper-on-path`               | ERR-2 (`requires --treat-as-tool`)   | OK; deferred to next synthesis               | OK; writes shim after synthesis                                      |
| `--register-virtual`                                      | ERR-2 (`requires --treat-as-tool`)   | OK; deferred to next synthesis               | OK; writes manifest after synthesis                                  |
| `--dry-run-synthesis`                                     | ERR-2 (`requires --treat-as-tool`)   | OK; no-op (no synthesis would run)           | Print stage prompts + digests; do not call LLM; do not write cache   |
| `--synthesis-budget-tokens <n>`                           | OK (no-op; ignored without synth)    | OK (recorded for next synthesis)             | OK; enforced during synthesis                                        |
| `--composite-name <id>` + existing different manifest     | (See above)                          | (See above)                                  | ERR-2 unless `--force-overwrite` (FR-CMP-017)                        |
| `--treat-as-tool` with no `--tool` and `--help`           | N/A                                  | N/A                                          | ERR-2 (FR-CMP-003)                                                   |
| `--treat-as-tool` + member is a virtual composite         | (member resolves on PATH or fails)   | (would fail at agent startup)                | ERR-2 (recursion guard, FR-CMP-016)                                  |
| `--register-virtual` + recursion detected                 | (n/a)                                | ERR-2 at registration time                   | ERR-2 at synthesis time                                              |

## Distribution Form Summary

| Form                        | Flag                                | Default | Artifact path                                                            | Mode    | Outer-agent consumption                       |
|-----------------------------|-------------------------------------|---------|--------------------------------------------------------------------------|---------|-----------------------------------------------|
| (a) Capability doc          | `--emit-doc` (auto)                 | ON      | `~/.tool-agents/cli-agent/capabilities/composite/<id>.md`                | 0600    | Manual: user copies / shares / hand-edits     |
| (b) Wrapper shim            | `--emit-wrapper`                    | OFF     | `~/.tool-agents/cli-agent/composites/<id>/<id>` (+ optional symlink)     | 0700    | `--tool <id>` resolves via PATH               |
| (b') PATH symlink           | `--emit-wrapper-on-path`            | OFF     | `~/.local/bin/<id>` → shim                                               | symlink | `--tool <id>` resolves via PATH (user-wide)   |
| (c) Virtual registration    | `--register-virtual`                | OFF     | `~/.tool-agents/cli-agent/composites/<id>/manifest.json`                 | 0600    | `--tool <id>` resolves via cli-agent registry |

All three forms can coexist for the same `<id>`; the outer cli-agent's
resolution order (FR-CMP-014) deterministically picks one path per
invocation.

## Original Request

The original raw request from the user is preserved verbatim below.

---

**Title**: Composite "intelligent tools" — synthesize a capability document and tool registration when cli-agent is invoked with a curated tool set.

## The user-observed behavior that motivates this

When a user invokes:
```
cli-agent --no-agent-tools --allow-mutations --tool file-cli --tool outlook-cli --per-tool-budget 65536 "<prompt in Greek>"
```
…the cli-agent successfully orchestrates `file-cli` + `outlook-cli` as if they were a single intelligent assistant. The user wants to **package this assembly** as a *new* intelligent tool that can be **attached to ANOTHER cli-agent invocation as a single `--tool <composite>` argument**, recursively.

The first ingredient an outer cli-agent needs to attach a wrapped tool is its **capability document** — currently produced by `discover-capabilities` from a real binary's `--help` tree and cached at `~/.tool-agents/cli-agent/capabilities/<tool>.md`. For a composite (a curated cli-agent invocation), there is no real binary `--help` to introspect — the capability document must be **synthesized** from the constituent tools' capability docs + cli-agent's own knowledge.

## What the user wants (v1)

1. **A `--treat-as-tool` flag on cli-agent.** This flag declares "this invocation IS a composite intelligent tool". The flag is METADATA — it does not change normal-run behavior on its own. It mainly modifies how `--help` (and a few new sibling flags) behave. When `--treat-as-tool` is NOT supplied, cli-agent's existing `--help` and tool-attach behavior must be byte-identical to today.

2. **`cli-agent --tool A --tool B --treat-as-tool --help`** — instead of printing cli-agent's own help, this synthesizes a NEW capability document describing the composite tool: synopsis, top-level intents, cross-tool recipes, parameter glossary, in cli-agent's existing capability-doc schema (frontmatter + AUTO-GENERATED block + USER-RECIPES + USER-NOTES). Output goes to stdout. The synthesized doc must be cached.

3. **Synthesis pipeline**: a multi-prompt LLM pipeline. Stage 1 distills each constituent tool's capability doc; Stage 2 composes them with cross-tool recipes. The pipeline must use the same LLM provider/model that cli-agent has otherwise been configured with (so it inherits the user's provider, profile, etc.).

4. **Caching + regeneration**: cache key derived from (sorted tool list + each tool's capability-doc digest + cli-agent version + composite-name). Cache hits are instant. An explicit regeneration trigger must exist (flag, e.g., `--regenerate-capabilities`, OR a subcommand) — explicitly request regeneration even when the cache is warm.

5. **Composite naming**: `--composite-name <id>` (optional) lets the user assign a memorable id (`email-assistant`). When omitted, derive a stable id from sorted tool names + content hash (e.g., `file-cli+outlook-cli@<hash8>`).

6. **THREE distribution / consumption forms must be supported in v1**:
   - **(a) Just the doc**: synthesize the capability markdown and write it to a path (`~/.tool-agents/cli-agent/capabilities/composite/<id>.md`). The user can copy/share/edit this file by hand. No further wiring.
   - **(b) Auto-generated wrapper script**: cli-agent emits an executable shim (e.g., under `~/.tool-agents/cli-agent/composites/<id>` or onto the user's $PATH on request) that wraps `cli-agent --tool A --tool B …` with the right args. Outer cli-agent invocations of `cli-agent --tool <id>` find the shim via PATH and run it. The shim's `--help` calls the existing capability-discovery path on itself, which finds the cached capability doc.
   - **(c) Virtual tool registration inside cli-agent**: the composite is registered as a "virtual tool" inside the cli-agent registry — when an outer cli-agent runs with `--tool <composite-id>`, the composite is recognized without a separate binary on disk; calls re-enter cli-agent in-process (or as a child process) using the recorded tool-set. This option requires architectural changes to the tool registry to support meta-tools.

The user wants ALL THREE to be supported. Each may be opt-in via a flag (`--emit-doc`, `--emit-wrapper`, `--register-virtual`) or defaulted (e.g., emit-doc always, others on request).

## What the refiner should resolve / clarify

- **Flag matrix**: the exact interaction between `--treat-as-tool`, `--help`, `--regenerate-capabilities`, `--emit-doc` / `--emit-wrapper` / `--register-virtual`, and `--composite-name`. Define which combinations are valid and which produce errors.
- **Capability-doc schema fidelity**: must the synthesized doc pass the same validators as a `discover-capabilities`-produced doc? (Probably yes — outer cli-agent must be able to consume it transparently.) Specify the schema constraints inherited and any new metadata fields (e.g., `composite: true`, `members: [...]`, `synthesizedAt`, `syntheticDigest`).
- **Cache invalidation rules**: what changes invalidate? Member tool digest change → yes. Cli-agent version bump → yes. Schema version bump → yes. Member tool prompt overlay change → ??? (open question). User-edited USER-NOTES / USER-RECIPES preservation across regen → must be preserved (mirror the existing recipe-preservation pattern from plan-005-capability-recipes-and-manref).
- **LLM cost / latency**: synthesis fires a multi-prompt pipeline. Should there be a `--dry-run` that prints the prompts without calling the LLM? Should the pipeline be configurable (e.g., a single combined prompt vs the recommended two-stage)? What is the budget cap?
- **Wrapper script**: shebang line, executable bit, PATH placement, how the outer cli-agent's capability-discovery introspects it (hint: the shim must respond to `--help` by printing the cached doc verbatim).
- **Virtual tool**: where does the registry lookup happen? How does the outer cli-agent's `--tool <virtual-id>` flow recognize a virtual id and dispatch to the in-process meta-tool handler?
- **Edge cases**: composite of a composite (recursion); empty `--tool` list with `--treat-as-tool --help` (should it error or print a degenerate doc); two composites with the same `--composite-name` but different tool sets (collision); regeneration when one constituent tool's capability doc no longer exists; cli-agent profile activation while synthesizing (should the active profile influence the synthesis or be ignored?).
- **Testing**: synthesis is non-deterministic (LLM). How is it tested? (Hint: snapshot-test with a recorded LLM transcript or a stub LLM that returns canned outputs.)
- **Coexistence with plan-005**: profiles, prompt overlays, capability recipes/manref must all keep working transparently. The synthesized doc must respect overlays applied to the constituent tools.

Output the refined spec to docs/design/refined-request-composite-tools.md.

Pay particular attention to defining acceptance criteria, scope boundaries (what is in v1 vs deferred — e.g., composite-of-composite, cross-machine sync, secret-redaction in synthesized recipes), edge cases, and the precise `--treat-as-tool` flag interaction matrix.
