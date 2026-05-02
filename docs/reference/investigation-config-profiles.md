# Investigation: Configuration Profiles for cli-agent

## Executive Summary

This investigation evaluates seven design questions that bear on adding a
first-class "configuration profiles" feature to `cli-agent`. The recommended
package is: **YAML-first storage with JSON tolerated on read** (using the
`yaml` package); **profile cliParams sit at tier 5** between local `./.env`
and `~/.tool-agents/cli-agent/config.json` (matching the refined-spec
proposal); **tool scoping uses a strict three-pass `allow → deny → order`
algorithm with hard errors on intersecting allow/deny and on duplicate order
entries**; **per-tool argument merge stays shallow** at the tool-input level,
applied via a shared dispatcher helper at the top of each tool's `.func`;
**subcommands follow the project's existing flat-hyphenated convention
(`profile-list`, `profile-show`, …) rather than a nested `profile <verb>`
group**, deviating from Assumption 5 in the refined spec; **schema validation
uses Zod** (already a project dep, also mandated by NFR-PROF-003); and
**`profile-show` / `profile-dry-run` adopt a `kubectl config view`-style
merged-and-minified report format** with explicit per-knob source attribution
similar to `aws configure list`.

The single significant deviation from the refined spec is recommendation #5
(subcommand naming style). The spec lists this as Open Question 3, so the
recommendation lands inside the explicitly negotiable surface.

## Context

The cli-agent project (TypeScript, Node 22+, ESM, LangGraph ReAct agent at
v0.2.1) needs to add a "configuration profiles" feature per the refined
request at `docs/design/refined-request-config-profiles.md`. The feature
adds a fifth tier to the existing four-tier configuration resolution chain
implemented in `src/config/agent-config.ts:644+`, plus a new family of
management subcommands, plus a tool-catalog filtering pass in
`src/agent/tools/registry.ts:47-84`, plus a per-tool argument merge step in
each tool's `.func` body.

Constraints this investigation must respect:

- The user-facing invariant that **explicit CLI flags always win** is
  non-negotiable (refined spec §FR-PROF-004).
- The project carries **zero YAML dependencies today**; adding one is a real
  cost (codebase scan §5).
- All existing tests must continue to pass byte-for-byte when no profile is
  active (refined spec acceptance criterion 21).
- Profile creation is **not** subject to the `/tool-conventions scaffold`
  rule because profile management is feature code inside the agent, not a
  reusable cross-project tool.
- Zod is already a dependency; ad-hoc parsers are forbidden by NFR-PROF-003.

Refined request file: `docs/design/refined-request-config-profiles.md`.
Codebase scan: `docs/reference/codebase-scan-config-profiles.md`.

---

## Question 1: Profile File Format (YAML vs JSON vs Both)

### Options Identified

#### Option 1A: YAML default, JSON tolerated on read (`yaml` pkg)

- **Description**: `profile-create` writes `.yaml` by default; the loader
  accepts `.yaml` / `.yml` / `.json` and dispatches by extension. Adds the
  `yaml` (eemeli) package to dependencies.
- **Strengths**: YAML is the dominant format in modern dev-tool config
  surfaces (`gh` uses `~/.config/gh/config.yml`; kubectl emits YAML by
  default; Docker Compose, GitHub Actions workflows, and pre-commit all
  ship YAML). Multi-line strings, comments, anchors, and the visual contrast
  to the existing JSON `config.json` reduce file-confusion errors. The
  `yaml` package ships its own TypeScript types and is zero-dependency.
- **Weaknesses**: Adds one new top-level dep (~110 KB packaged). YAML
  parsing has historical CVE surface (billion-laughs, untyped tag
  resolution) — mitigated by using safe parse defaults.
- **Effort/Complexity**: Low.
- **Risk**: Low — single dep, small, well-maintained, TS-native.
- **Best suited when**: Profile files are expected to be human-edited by
  hand (true here — `profile-edit` opens `$EDITOR`).

#### Option 1B: JSON only

- **Description**: Profiles stored as `<name>.json`. Reuses Node's built-in
  `JSON.parse`. No new dependencies.
- **Strengths**: Zero new deps; consistency with `config.json`; same parser
  the agent already trusts.
- **Weaknesses**: No comments (the refined spec's "three commented-out
  sections" stub for `profile-create` becomes impossible without a custom
  pre-processor). No multi-line strings. Edit ergonomics suffer when users
  want to annotate their profile choices. Visually identical to
  `config.json`, increasing the risk of users editing the wrong file.
- **Effort/Complexity**: Lowest.
- **Risk**: Low technically, but medium UX risk (poor edit ergonomics).
- **Best suited when**: Profiles are machine-generated and rarely
  hand-edited (not the case here).

#### Option 1C: Both formats with no canonical default

- **Description**: `profile-create` accepts a `--format` flag with no
  default; user must pick. Loader accepts both.
- **Strengths**: Maximum flexibility.
- **Weaknesses**: Adds a decision the user shouldn't have to make. Without
  a documented default, profile sharing across teams becomes
  inconsistent. Loader complexity is identical to Option 1A but with an
  extra interactive prompt or required flag.
- **Effort/Complexity**: Medium.
- **Risk**: Medium UX risk.

#### Option 1D: TOML

- **Description**: TOML format, à la Cargo / `pyproject.toml`.
- **Strengths**: Comments supported; less ambiguous than YAML.
- **Weaknesses**: Not idiomatic in the Node ecosystem. Adds a dep with
  smaller community footprint. Users less likely to know TOML syntax.
- **Effort/Complexity**: Low.
- **Risk**: Low technically; high "least-familiar-format" UX risk.

### Comparison Matrix

| Criterion | 1A (YAML+JSON) | 1B (JSON only) | 1C (Both, no default) | 1D (TOML) |
|---|---|---|---|---|
| Edit ergonomics | High | Low | High | Medium |
| Comments support | Yes | No | Yes (YAML side) | Yes |
| New dependency | yaml (~110KB) | None | yaml | smol-toml |
| Idiomatic for TS CLI tools | High | Medium | High | Low |
| Visual contrast with `config.json` | High | None | High | High |
| Spec alignment (Assumption 1) | Matches | Deviates | Deviates | Deviates |
| Implementation complexity | Low | Lowest | Medium | Low |

### Recommendation: Option 1A (YAML default, JSON tolerated on read)

Choose YAML as the canonical write format with JSON readable for
forward/backward compatibility. Use the `yaml` package (eemeli/yaml) rather
than `js-yaml` for these reasons:

- `yaml` ships first-party TypeScript types — `js-yaml` requires the
  separately-versioned `@types/js-yaml` (currently 2 years stale per npm).
  This matters for a TS-first project.
- Both packages are zero-dependency, ~similar size; adoption of `yaml` is
  rising and the API exposes Document/AST access if profile-comment
  preservation is needed for `profile-edit`'s round-trip later.
- Per the refined spec §FR-PROF-002 the "three commented-out sections"
  stub is part of the create scaffold — only YAML supports inline comments
  natively.

This matches refined-spec Assumption 1 and aligns with idiomatic TS CLI
conventions (`gh`, `pnpm`, `vitest.config.ts`-style YAML siblings, `pulumi`,
`semantic-release`, etc.). The codebase scan §5 explicitly flags that "no
YAML library is in dependencies today" — the cost is acknowledged and the
benefit (edit ergonomics for a hand-edited preset file) clears the bar.

**Concrete actions for planning**:
- Add `"yaml": "^2.x"` to `package.json` dependencies.
- New file `src/config/profile-codec.ts` exposes `parseProfile(text, ext)`
  and `stringifyProfile(profile)` so the parser choice is encapsulated.
- Edge case E18 (both `.yaml` and `.json` exist for the same stem) becomes
  a hard `ConfigurationError` — the codec rejects ambiguity rather than
  silently preferring one.

---

## Question 2: Precedence Tier for Profile Values

### Options Identified

#### Option 2A: Below shell env (lowest priority — would sit under `config.json`)
- **Description**: Profile is the lowest priority tier; everything,
  including `config.json`, beats it.
- **Strengths**: Profiles can never accidentally surprise; `config.json`
  always wins.
- **Weaknesses**: Defeats the purpose. A "named preset" that loses to the
  default `config.json` cannot actually preset anything — the user would
  have to manually clear `config.json` first.
- **Risk**: High (feature is functionally broken).

#### Option 2B: Between agent-dir `.env` (tier 2) and local `.env` (tier 3)
- **Description**: Profile sits at tier 3, pushing local `.env` to tier 4.
- **Strengths**: Personal profile beats per-project `.env`.
- **Weaknesses**: Counter-intuitive. Per-project `.env` is conventionally
  the most-specific scope (project beats user beats system). Inverting that
  to make a personal profile beat a per-repo override surprises users.

#### Option 2C: Between local `.env` (tier 3) and `config.json` — refined-spec proposal
- **Description**: The composed chain becomes:
  CLI flag (1) > shell env (2) > agent-dir `.env` (3) > local `./.env` (4)
  > **profile cliParams (5)** > `config.json` (6) > built-in defaults (7).
- **Strengths**: Profiles act as named replacements for `config.json` —
  exactly what users intuitively expect from a "preset". All explicit
  override channels (shell env, project `.env`, CLI flag) keep working
  unchanged. Matches mental model "profile = my saved config.json variant".
- **Weaknesses**: A user accidentally setting an env var in their shell
  will silently override their profile's pinned value. This is *desirable*
  (it preserves the "I tweaked my shell" workflow) but can surprise users
  the first time they encounter it — must be documented.

#### Option 2D: Above CLI flags (would violate the user invariant)
- **Description**: Profile beats explicit CLI flags.
- **Strengths**: None for this project.
- **Weaknesses**: Directly contradicts refined spec §FR-PROF-004's
  user-facing invariant ("explicit CLI flags supplied at invocation
  override profile values"). **Reject.**

### Comparison Matrix

| Criterion | 2A (lowest) | 2B (above local .env) | 2C (refined-spec) | 2D (above CLI) |
|---|---|---|---|---|
| Preserves "CLI flag wins" invariant | Yes | Yes | Yes | **No (rejected)** |
| Profile actually overrides config.json | No | Yes | Yes | Yes |
| Local `.env` (per-project) keeps winning | Yes | No | Yes | No |
| Shell env keeps winning | Yes | Yes | Yes | No |
| Matches "named preset" mental model | No | Mixed | Yes | No |
| Implementation impact on existing knob sites | Trivial | Trivial | Trivial | Forbidden |

### Recommendation: Option 2C (refined-spec proposal)

Profile `cliParams` insert at **tier 5**, between local `./.env` (tier 4)
and `config.json` (tier 6). Concrete implementation pattern, applied at
each per-knob site in `src/config/agent-config.ts` (the codebase scan §4.1
notes the current shape is `flags.X ?? layered['AGENT_X'] ?? configFile?.X`):

```
flags.X ?? layered['AGENT_X'] ?? profileCliParams?.X ?? configFile?.X
```

That insertion is mechanical (one new clause per knob), preserves the
"first non-undefined wins" semantics already in place, and threads the
profile through without changing the shape of the existing layered env
snapshot.

**Why this tier rather than the alternatives:**
- **vs. 2A (lowest)**: profiles must override `config.json` to be useful
  as named presets. A profile that loses to a stale `config.json` from
  three months ago provides no value. The whole point of saving a profile
  is to override your defaults for one invocation.
- **vs. 2B (above local `.env`)**: project-scoped configuration (per-repo
  `.env`) conventionally beats user-scoped configuration (a personal
  profile). Following the `tools/.env > profile > config.json` ordering
  preserves the "more-specific scope beats less-specific scope" invariant
  the rest of the chain already obeys.
- **vs. 2D (above CLI flags)**: would directly violate the central
  user-facing invariant. Reject by spec.

**Documented user expectation** (must appear in `configuration-guide.md`):
> A profile pins `cliParams` for the duration of one invocation. CLI flags
> you pass on the command line, environment variables already set in your
> shell, and any per-project `.env` file all continue to override the
> profile. The profile only kicks in when none of those higher-priority
> sources mentions the knob — at which point it overrides the value in
> `~/.tool-agents/cli-agent/config.json`.

**Comparable prior art**: AWS CLI's "Settings Precedence" places named
profiles below shell env and above the config file in spirit — the AWS
chain reads CLI flag > shell env (AWS_REGION etc.) > credentials/config
file (resolved per-profile) > IAM role metadata. Our tier-5 placement
mirrors the same intent — explicit > shell > preset > built-in default.

---

## Question 3: Tool Scoping Algorithm (allow + deny + order)

### Options Identified

#### Option 3A: Strict three-pass `allow → deny → order` (refined-spec proposal)

- **Description**: Apply `allow` first (intersection if non-empty),
  then `deny` (set difference), then `order` (reorder survivors).
- **Strengths**: Predictable. Each operation has a single, documented
  effect. Mirrors `kubectl --field-selector` and Linux package-manager
  allowlist/denylist conventions where allow runs before deny.
- **Weaknesses**: The intersection of `allow` and `deny` is ambiguous
  unless explicitly handled — addressed below.

#### Option 3B: Single combined predicate with priority rules

- **Description**: Compute `included = (toolName ∈ allow) ∧ (toolName ∉ deny)`
  in one pass; reorder afterwards.
- **Strengths**: Equivalent to 3A on result, slightly less code.
- **Weaknesses**: Loses the explicit "first allow, then deny" semantics
  in the implementation, which makes test names and error messages less
  intuitive ("which set is this name in?"). Functionally identical, so
  pick 3A for clarity.

#### Option 3C: `deny → allow → order` (deny first)

- **Description**: Apply `deny` to the catalog first; then keep only those
  in `allow`.
- **Strengths**: Allows users to write `deny: [a, b]` then `allow: [a]`
  meaning "explicitly re-enable a despite the deny" — but this is the
  opposite of usual allow/deny semantics.
- **Weaknesses**: Counter-intuitive. ESLint, AWS IAM, Linux PAM, and
  package managers all run allow before deny (with deny winning on
  conflict).

### Edge Cases the Algorithm Must Handle (codified as hard errors or warnings)

| # | Case | Recommendation | Justification |
|---|---|---|---|
| EC-1 | `allow: []` (explicitly empty) | **Hard error** (E6 in spec) | Disabling everything via empty allow is almost never intentional; if user wants this, they can list one no-op tool. |
| EC-2 | Same name in both `allow` and `deny` | **Hard error** (E23 in spec) | Intent is ambiguous; the user could have meant either. Force them to clarify. |
| EC-3 | `order` lists a tool not in survivor set | Warn on stderr, drop name (E21) | Forward-compatible — profile may have been written against a future tool list. |
| EC-4 | `order` lists same tool twice | **Hard error** (E22 in spec) | Cannot reorder to "first AND third" position. |
| EC-5 | Result set is empty after allow+deny | **Hard error** (E7 in spec) | A tool-less catalog cannot be useful for the LLM. |
| EC-6 | `allow`/`deny`/`order` references a name not in registered catalog | Warn on stderr, drop silently (E8) | Forward-compat: profile outlives a tool's removal. |
| EC-7 | All three sub-keys absent | No-op (catalog unchanged) | Spec says all three are independently optional. |
| EC-8 | `allow` present but key omits a tool the registered set has | Tool is filtered out (intentional) | This is the whole point of allow. |

### Comparison Matrix

| Criterion | 3A (strict 3-pass) | 3B (combined predicate) | 3C (deny first) |
|---|---|---|---|
| Predictability for users | High | High | Low |
| Industry-standard ordering | Yes | Yes | No |
| Match to spec FR-PROF-005 wording | Exact | Equivalent | Inverts |
| Implementation simplicity | Low overhead | Lowest overhead | Low overhead |
| Diagnostic message clarity | High | Medium | Medium |

### Recommendation: Option 3A (strict three-pass)

Implement `applyProfileToolScoping(tools, profile.tools)` as three
explicitly-named passes in `src/agent/tools/profile-scoping.ts`:

```
1. validateNoIntersection(allow, deny)  // EC-2 guard
2. validateNoDuplicates(order)           // EC-4 guard
3. afterAllow  = allow ? tools.filter(t => allow.includes(t.name)) : tools
4. afterDeny   = deny  ? afterAllow.filter(t => !deny.includes(t.name)) : afterAllow
5. validateNonEmpty(afterDeny)           // EC-5 guard
6. afterOrder  = applyOrder(afterDeny, order)
```

The validation guards (EC-2, EC-4, EC-5) run **before** any name dropping
so error messages can quote the user's exact `allow`/`deny`/`order` values
back at them, making the failure self-explanatory. Warnings (EC-3, EC-6)
are emitted via `process.stderr.write()` only, never logged as errors,
because forward-compat (a profile written for a newer agent version
referencing a not-yet-registered tool) is a feature not a bug.

**Prior art that supports this design**:
- ESLint flat config "last config wins per file" model where rules are
  filtered by `files`/`ignores` patterns: filter first (allow-equivalent),
  filter again (deny-equivalent / `ignores`), no reorder.
- kubectl `--field-selector`: name-set intersections, no reorder.
- VSCode extension `recommendations` + `unwantedRecommendations`: allow +
  deny pair, deny wins on conflict — VSCode lets the conflict pass with
  a precedence rule. We choose stricter behavior (hard error) because
  cli-agent profiles are personal, hand-authored, and ambiguity is more
  likely a typo than an intentional override.

---

## Question 4: Per-Tool Argument Merge Strategy

### Options Identified

#### Option 4A: Shallow merge at tool input level (refined-spec proposal)

- **Description**: At each tool's `.func` entry,
  `effectiveInput = { ...profileToolArgs[toolName], ...input }`. Runtime
  argument wins per-key; profile arguments for keys absent at runtime
  still apply.
- **Strengths**: Predictable. Trivially implementable as a one-line helper.
  Matches every cli-agent tool's actual input schema today (the codebase
  scan reviewed: `bash_run`, `web_search`, `web_fetch`, `file_*`, `agt_*`
  — all have flat-object Zod inputs with primitive or array values, no
  nested objects).
- **Weaknesses**: If a future tool has a nested-object input (e.g.
  `{ retry: { count: 3, delayMs: 100 } }`), shallow merge would replace
  the whole `retry` object instead of merging members. Mitigated by
  policy: the convention "tools take flat inputs" is already implicit in
  the codebase.

#### Option 4B: Deep merge at tool input level

- **Description**: Use a deep-merge utility (Lodash, deepmerge,
  ts-deepmerge). Nested objects merge member-by-member.
- **Strengths**: More expressive for tools with nested inputs.
- **Weaknesses**: Deep merge has well-known surprises (array merging:
  concat? replace? union?). Each surprise becomes a documented edge case
  the user must remember. Deep merge requires picking a strategy for arrays
  and `Date`/`RegExp` etc. Adds a dep or hand-rolled deep-merge code with
  its own bug surface. **No current tool benefits.**

#### Option 4C: Merge at tool's *internal* config level (rather than input)

- **Description**: Profile values flow into the tool factory's `cfg`
  parameter rather than into the `.func` arguments.
- **Strengths**: Pre-bakes the args at factory time; runtime path is
  unchanged.
- **Weaknesses**: Defeats the per-call override semantics. Per refined
  spec §FR-PROF-006 the merge MUST happen at invocation time so a single
  call can override a profile-set arg without disturbing other calls. This
  pattern can only express factory-time defaults, not per-call presets.
  **Reject.**

#### Option 4D: Hybrid — shallow merge at input level + escape hatch for "profile-wins" mode

- **Description**: Shallow merge as in 4A, but with a future per-tool flag
  in the profile (`toolArgsOverride: true`) that flips the priority so the
  profile wins.
- **Strengths**: Future-proof.
- **Weaknesses**: Refined spec explicitly puts "strict profile-wins mode"
  out of v1 scope. Adding a hook now would lock in semantics prematurely.

### Comparison Matrix

| Criterion | 4A (shallow input) | 4B (deep input) | 4C (factory cfg) | 4D (hybrid) |
|---|---|---|---|---|
| Matches FR-PROF-006 | Exact | Stricter | **Violates** | Compatible |
| Works for all current tools | Yes | Yes | Yes | Yes |
| New dependency | None | deepmerge | None | None |
| Predictability | High | Medium | High (but wrong) | Medium |
| Per-call override semantics | Yes | Yes | **No** | Yes |
| YAGNI | Yes | No | N/A | No |

### Recommendation: Option 4A (shallow merge at tool input level)

Implement a shared helper in `src/agent/tools/profile-tool-args.ts`:

```ts
export function mergeProfileToolArgs<I extends Record<string, unknown>>(
  input: I,
  configurable: { profileToolArgs?: Record<string, Record<string, unknown>> } | undefined,
  toolName: string,
): I {
  const presets = configurable?.profileToolArgs?.[toolName];
  if (!presets) return input;
  return { ...presets, ...input };  // runtime input wins per-key
}
```

Each tool factory's `.func` body calls this helper as the first line:

```ts
async func(input, runConfig) {
  const merged = mergeProfileToolArgs(input, runConfig?.configurable, TOOL_NAME);
  // ... rest of the function uses `merged` instead of `input`
}
```

The `profileToolArgs` itself is injected once per `runOneShot` /
`streamOneShot` call via `configurable: { ..., profileToolArgs }` (codebase
scan §4.1 IP-4) — no per-tool plumbing.

**Why shallow at input level**:
- Every cli-agent tool today takes a flat input. A spot-check of the
  factories called out in the codebase scan (`bash/run-tool.ts:36-55`,
  `web/web-search-tool.ts`, `file/file-read-tool.ts`, every `agt_*` factory)
  confirms no nested object inputs exist.
- If a future tool needs nested merging, **its own factory** can call a
  deep-merge helper internally before invoking shared logic — making deep
  merge an opt-in per-tool concern rather than a global policy.
- Matches refined-spec §FR-PROF-006 exactly: `{ ...profile, ...runtime }`.
- The validation step against each tool's Zod schema (FR-PROF-006 last
  paragraph) runs at profile-load time on the **merged** shape would not
  add information, so validate `profile.toolArgs[toolName]` against the
  tool's input schema in **partial** form (Zod's `.partial()` modifier),
  which is the correct shape for "default values" rather than "complete
  call args".

**Edge cases this creates**:
- E10 (profile-set arg fails the tool's schema): validate
  `partialSchema.parse(profile.toolArgs[toolName])` at load time. For tools
  whose schema is dynamic (none today, but future CLI-wrapped tools may
  qualify), defer to runtime warning.
- An arg of value `undefined` in `profileToolArgs[toolName]` would be
  overridden by the spread; this is correct behavior.

---

## Question 5: Profile Management CLI Surface

### Existing Subcommand Pattern in This Codebase

Reading `src/cli.ts` lines 124-223 reveals an unambiguous convention: every
existing subcommand is a **flat hyphenated single-segment name** registered
via `program.command('verb-noun')`:

| Existing subcommand | File reference |
|---|---|
| `show-capabilities` | `src/cli.ts:126` |
| `refresh-capabilities` | `src/cli.ts:143` |
| `extract-tool-prompts` | `src/cli.ts:166` |
| `show-tool-prompt` | `src/cli.ts:188` |
| `audit-tool-prompts` | `src/cli.ts:209` |

There is **no `program.command('foo').command('bar')` nesting** anywhere in
the project today.

### Options Identified

#### Option 5A: Flat hyphenated (matches existing convention)
- `cli-agent profile-list`
- `cli-agent profile-show <name>`
- `cli-agent profile-create <name>`
- `cli-agent profile-edit <name>`
- `cli-agent profile-delete <name>`
- `cli-agent profile-dry-run [...]`

#### Option 5B: Nested subcommand group (refined-spec Assumption 5)
- `cli-agent profile list`
- `cli-agent profile show <name>`
- `cli-agent profile create <name>`
- etc.

#### Option 5C: Mixed (some flat, group only for management)
- Reject — internally inconsistent.

### Comparison Matrix

| Criterion | 5A (flat hyphenated) | 5B (nested group) |
|---|---|---|
| Consistency with existing 5 subcommands | **Match** | **Deviation** |
| Discoverability (`cli-agent --help` lists each) | Yes (each verb visible) | Less (only `profile` parent visible) |
| Help: `cli-agent profile --help` | N/A (not a command) | Available |
| Tab-completion friendliness | Slightly worse | Slightly better |
| Implementation complexity | Low (one new file per verb) | Medium (parent + verbs, `enablePositionalOptions`) |
| Future expansion | Add another `profile-X` | Add `.command(verb)` on parent |
| Mirror of `gh` / `kubectl` UX | No | Yes |

### Recommendation: Option 5A (flat hyphenated)

This is a deviation from refined-spec Assumption 5 — but the spec marks
that decision as Open Question 3 and explicitly says "If the project
prefers hyphenated single-segment subcommands, this is purely cosmetic."
The project already has a clear convention; introducing the *first* nested
subcommand group as part of the profile feature would set a one-off
precedent.

**Recommended verb set** (with the documented short aliases via
Commander's `.alias()`):

| Subcommand | Alias | Effect |
|---|---|---|
| `profile-list` | `profiles` | List all profile files |
| `profile-show <name>` | — | Print parsed + normalized + summary |
| `profile-create <name>` | — | Scaffold a new profile file |
| `profile-edit <name>` | — | Open in `$EDITOR` |
| `profile-delete <name>` | `profile-rm` | Delete with confirmation |
| `profile-dry-run` | — | Print effective merged config |

**Implementation pattern** (matching the codebase scan §4.1 IP-6
recommendation but flattened):

```
src/commands/profile/
  list.ts
  show.ts
  create.ts
  edit.ts
  delete.ts
  dry-run.ts
  shared.ts          // common helpers: resolveProfilePath, etc.
src/cli.ts           // adds program.command('profile-list').action(...) etc.
```

The shared helper file mirrors the existing `src/commands/` style; each
entry-point file exports a single async function consumed by `src/cli.ts`,
identical to how `runShowCapabilities` is wired today.

**If the user prefers the nested style instead** (Option 5B), the change
is mechanical: replace six top-level `program.command(...)` calls with one
`program.command('profile')` parent + six `.command(verb)` children, and
move `resolveProfilePath` calls into a shared helper. Both implementations
share ~95% of the code; only the Commander wiring differs. Recording this
as a one-line decision the user can flip during planning.

---

## Question 6: Schema Validation (Zod / Ajv / Hand-rolled)

### Existing Project State

`package.json` already declares `"zod": "^3.25.76"` as a top-level
dependency. The codebase uses Zod throughout the tool factories
(`DynamicStructuredTool` requires Zod input schemas). The refined-spec
NFR-PROF-003 explicitly mandates Zod.

### Options Identified

#### Option 6A: Zod (existing dep)
- **Strengths**: Zero new deps. Existing engineering familiarity in the
  codebase. Native TS type inference (`z.infer<typeof ProfileSchema>`).
  Same library that validates tool inputs — so `toolArgs` validation can
  reuse the existing per-tool Zod schemas via `.partial()`.
- **Weaknesses**: Slightly slower than ajv on hot paths (immaterial here —
  a profile parses once per cold start).
- **Risk**: None.

#### Option 6B: Ajv (JSON Schema validator)
- **Strengths**: Fastest validator on Node. Standard JSON Schema is a more
  portable artifact for documentation.
- **Weaknesses**: New dep. Type inference requires a separate codegen step.
  Cannot easily share schemas with the existing tool input schemas
  (which are in Zod).
- **Risk**: Medium — adds dep + new validation idiom.

#### Option 6C: Hand-rolled
- **Strengths**: No deps.
- **Weaknesses**: Re-invents Zod poorly. Loses type inference. Violates
  NFR-PROF-003 ("No ad-hoc parsers"). **Reject by spec.**

### Recommendation: Option 6A (Zod)

Mandatory by NFR-PROF-003 and naturally aligned with the codebase. The
profile schema lives in `src/config/profile-schema.ts` (codebase scan
§4.3); the loader, `profile-show`, `profile-dry-run`, and the
`profile-create --from-current` writer all consume the same `ProfileSchema`
export.

**Implementation notes**:
- Use `z.object({...}).strict()` at the top level so unknown top-level
  keys are caught (E3 — schema validation failure).
- Use `z.object({...}).passthrough()` on `cliParams` — per refined-spec E20,
  unknown cliParams (forward-compat with future cli-agent versions) emit a
  warning rather than aborting.
- Define a separate `KnownCliParamKeys` set in TypeScript whose union of
  string literals is matched against the parsed `cliParams` keys; warn for
  any not in the set.
- Credential-shape detection (E11) uses a regex on `cliParams` keys
  evaluated after `.passthrough()` parsing:
  `/^.*(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i`.
- For `toolArgs.<toolName>` — fetch the tool's input Zod schema from a
  registry export, call `.partial().safeParse(args)`, raise
  `ConfigurationError` on failure for tools with known schemas.

---

## Question 7: Discovery / Show / Dry-Run Output Format

### Prior Art Reviewed

| Tool | Command | What it shows |
|---|---|---|
| `kubectl config view` | Default: merged YAML of all `KUBECONFIG` files | Config merged across files; supports `--minify` (only current context) and `--raw` (include certs). Output format is YAML by default, JSON via `-o json`. |
| `aws configure list` | Tabular: each setting with its value, type (env vs config-file vs default), and source location | Source attribution per knob (`Name`, `Value`, `Type`, `Location`). |
| `terraform show` (post-`plan -out`) | Human-readable text or JSON of the saved plan including effective configuration | Read-only describe; no LLM/cloud calls; supports `-json` for machine consumption. |
| `gh config list` | Flat key/value listing | No source attribution. |

### Options Identified

#### Option 7A: kubectl-style merged YAML (single output)
- Print the merged effective profile + cliParams as one YAML document.
  No source attribution.
- **Pros**: Minimal output. Re-parseable.
- **Cons**: User cannot tell which knob came from which source — defeats
  the troubleshooting value of `dry-run`.

#### Option 7B: aws-configure-list-style table with source attribution
- Print each effective knob as a row: `name | value | source` where source
  is `cli-flag` / `env:VAR_NAME` / `local-.env` / `profile:foo` /
  `config.json` / `built-in-default`.
- **Pros**: Directly answers "why does my run use this value?". Familiar
  to AWS users.
- **Cons**: More verbose. Slightly more work to compute.

#### Option 7C: Hybrid (default human-readable; `--json` flag for machine)
- Default: aws-style table with source attribution + an "effective tool
  catalog" section + an "effective per-tool args" section.
- `--json`: emits a structured object for piping into jq / scripts.
- **Pros**: Best of both — human users see attribution, automation users
  get a stable schema.
- **Cons**: Two output paths to test.

### Recommendation: Option 7C (hybrid with source attribution)

Adopt the kubectl/aws-style human readout as default with a `--json` opt-in.

**`profile-show <name>` output structure** (default human form):

```
Profile: foo
Path:    /Users/x/.tool-agents/cli-agent/profiles/foo.yaml
Schema:  v1                Digest: a1b2c3d4...

— Raw file ———————————————————————————————————————————————
[verbatim file contents]

— Parsed (normalized) ————————————————————————————————————
[YAML re-emit of the validated, normalized profile object]

— Summary —————————————————————————————————————————————————
cliParams pinned (5):
  provider           openai
  model              gpt-5
  temperature        0.7
  maxIterations      40
  webSearchBackend   tavily

tools (after scoping against current registered catalog of N=21):
  Final catalog (in order, 7 tools):
    1. web_search           [profile-ordered]
    2. bash_run             [profile-allowed]
    3. file_read            [profile-allowed]
    ...

  Excluded by allow:        [agt_grep, agt_glob, ...]
  Excluded by deny:         [bash_list_allowed]
  Reordered:                yes (2 tools moved to front)

toolArgs presets:
  web_search: { maxResults: 10, includeRaw: true }
  bash_run:   { timeoutSec: 120 }

Notes:
  warning: profile.tools.allow lists "old_tool" which is not in the
           current registered catalog (forward-compat; ignoring).
```

**`profile-dry-run [--profile foo] [other flags]` output structure**: same
shape as `profile-show` summary section, but with two key differences:

1. Each pinned knob row carries a **source attribution** column:

```
— Effective configuration —————————————————————————————————
  knob                value      source
  ────────────────    ────       ─────────────────────────
  provider            openai     CLI flag
  model              gpt-5       env: AGENT_MODEL
  temperature        0.7         profile: foo
  maxIterations      40          profile: foo
  workingDir          /tmp        local .env (./.env)
  logLevel            info        config.json
```

2. The "tools" and "toolArgs" sections show the **final state after merging
   all of profile + CLI flags + env**, not the profile in isolation.

**Machine-readable `--json` output**:

```json
{
  "profile": {
    "name": "foo",
    "path": "/Users/x/.tool-agents/cli-agent/profiles/foo.yaml",
    "schemaVersion": 1,
    "digest": "a1b2c3d4e5f6..."
  },
  "effective": {
    "cliParams": [
      { "key": "provider", "value": "openai", "source": "cli-flag" },
      { "key": "model", "value": "gpt-5", "source": "env:AGENT_MODEL" },
      { "key": "temperature", "value": 0.7, "source": "profile:foo" }
    ],
    "tools": {
      "registeredCount": 21,
      "finalCount": 7,
      "ordered": ["web_search", "bash_run", "file_read", ...],
      "excludedByAllow": ["agt_grep", ...],
      "excludedByDeny": ["bash_list_allowed"],
      "reordered": true
    },
    "toolArgs": {
      "web_search": { "maxResults": 10, "includeRaw": true },
      "bash_run": { "timeoutSec": 120 }
    }
  },
  "warnings": [
    "profile.tools.allow lists 'old_tool' which is not in the current registered catalog"
  ]
}
```

**Why this format**:
- Source attribution per knob is the single most-requested debugging
  feature for layered configuration systems (`aws configure list`,
  `pulumi config get --show-secrets`, etc.). Without it, "why is my run
  using this value?" becomes a code-archaeology exercise.
- The "Excluded by allow / Excluded by deny / Reordered" breakdown directly
  exercises the `allow → deny → order` algorithm from Q3, making the
  scoping result self-documenting.
- The two-mode output (human / JSON) follows `terraform show` and
  `kubectl config view -o json` conventions.

---

## Combined Recommendations (Quick Reference)

| # | Question | Recommendation |
|---|---|---|
| 1 | File format | YAML default (`yaml` package), JSON tolerated on read |
| 2 | Precedence tier | Tier 5: between local `./.env` and `config.json` (matches refined spec) |
| 3 | Tool scoping algorithm | Strict three-pass `allow → deny → order` with hard-error guards on intersection (allow∩deny) and duplicate-order |
| 4 | toolArgs merge | Shallow merge at input level via shared `mergeProfileToolArgs` helper, validated as Zod `.partial()` at load time |
| 5 | CLI surface | **Flat hyphenated subcommands** (`profile-list`, `profile-show`, …) matching existing `show-capabilities` convention — deviates from refined-spec Assumption 5 but resolves Open Question 3 |
| 6 | Schema validation | Zod (already a dep, mandated by NFR-PROF-003) with `.strict()` top-level + `.passthrough()` on `cliParams` |
| 7 | Show / dry-run | Hybrid: aws-style human table with per-knob source attribution by default, `--json` for machine consumption |

---

## Technical Research Guidance

**Research needed**: Yes (one focused topic).

### Topic 1: `yaml` package — comment-preserving round-trip and security defaults

- **Why**: The `profile-create` scaffold writes a YAML stub with three
  commented-out sections. The `profile-edit` flow round-trips through
  `$EDITOR` and re-validates — but does **not** re-write — so
  comment-preservation in the parser isn't strictly required. However,
  `profile-create --from-current` (FR-PROF-010) emits a freshly serialized
  YAML, and we want the comments and section ordering to read naturally.
  The eemeli/yaml package supports both `parse()` (data-only) and
  `parseDocument()` (Document/AST including comments) — the planner
  should confirm which mode is needed where, plus the safe-parse defaults
  to defang YAML billion-laughs / unsafe-tag CVEs.
- **Focus**: 
  1. `yaml.parse()` vs `yaml.parseDocument()` API surface and the cost of
     each on a 1-32 KB profile file.
  2. Default tag resolution (does it follow the YAML 1.2 "core schema",
     and are JS-native tags off by default?).
  3. The `LineCounter` + `parseDocument` pattern for surfacing
     line/column in E2 ("malformed YAML" error message).
  4. Does `yaml.stringify` preserve comments when the input came from
     `parseDocument` and was not mutated? (Relevant for `profile-edit`
     idempotency tests.)
- **Depth**: Intermediate.
- **Relevance**: Drives the implementation of `src/config/profile-codec.ts`
  and the diagnostic-message surface for E2.

No deeper research is needed for the other six recommendations:

- Zod (Q6), Commander.js (Q5), shallow merge (Q4), and the precedence-tier
  insertion (Q2) are all idioms the codebase already uses extensively, with
  exemplary patterns in `src/config/agent-config.ts:644+`,
  `src/cli.ts:125+`, and `src/agent/tools/registry.ts:47-84`.
- The tool-scoping algorithm (Q3) is a 30-line filter pipeline; no
  prior-art uncertainty remains after the comparison above.
- The output format (Q7) requires no library research — it's plain
  string-formatting using `console.log` and the existing logging
  infrastructure.

---

## Implementation Considerations

**Decisions still to confirm with the user during planning**:

1. **Subcommand naming style** (Open Question 3): The recommendation here
   is flat (`profile-list`) for consistency. If the user prefers the
   nested form (`profile list`), it's a one-off precedent in the codebase
   but a minor implementation cost.
2. **Default file format** (Open Question 2): The recommendation here is
   YAML. If the user prefers JSON-by-default, the codec change is a
   one-line flip and the `yaml` dependency can stay (still useful for
   tolerated reads of YAML profiles authored elsewhere).
3. **TUI status-line readout** (Open Question 4): orthogonal to this
   investigation; the planner can carry it as an explicit yes/no.

**Dependencies / prerequisites**:
- Add `"yaml": "^2.x"` to `package.json` dependencies.
- No other new top-level dependencies. (The `inquirer`-style interactive
  prompt for `profile-create` is **not** required — the spec says
  "interactively or from flags", and a minimal stub-write with a
  printed "edit me" hint is sufficient for v1.)

**Potential pitfalls**:
- The hard-error vs. warning lines (E1–E23) must be enforced at exactly
  one place. If the YAML codec eagerly trims unknown keys it will mask
  E3 (unknown key error) — verify the codec does **not** silently strip
  extras, then let `.strict()` Zod parsing do the rejecting.
- The per-knob source attribution in `profile-dry-run` (Q7) must be
  computed by re-running the resolution chain in a "track sources" mode
  rather than re-creating the logic. Refactor `loadAgentConfig` to
  optionally accept a `trace: true` flag that returns
  `{ config, traces: Map<knob, source> }`. This keeps the canonical
  resolution logic in one place.
- The `profile_active` log event (FR-PROF-007) must be emitted before
  any tool runs — codebase scan §4.1 IP-8 places it after `session_start`
  and before `user_prompt`. Ensure the digest computation is hash-only,
  never the raw contents (privacy).
- `bootstrapAgentDir` already creates four subdirs at mode 0700. Adding
  `profiles/` is one line plus one new spec assertion.

**Suggested first steps for the implementation plan**:
1. Add `yaml` to deps, write `src/config/profile-codec.ts` with parse +
   stringify + ambiguity-detection (E18).
2. Write `src/config/profile-schema.ts` with the Zod schema + the
   `.partial()` validator helper for `toolArgs`.
3. Write `src/config/profile-loader.ts` consuming both — including
   `bootstrapProfilesDir` extension to `bootstrapAgentDir`.
4. Wire `--profile <name>` flag into `src/cli.ts:40-83` and the env var
   `CLI_AGENT_PROFILE` into `OTHER_ENV_KEYS` at
   `src/config/agent-config.ts:551`.
5. Refactor each per-knob site in `loadAgentConfig` to insert
   `?? profileCliParams?.X` before `?? configFile?.X`.
6. Write `src/agent/tools/profile-scoping.ts` (Q3 algorithm) and integrate
   at `src/agent/tools/registry.ts:84`.
7. Write `src/agent/tools/profile-tool-args.ts` (Q4 helper) and call from
   each tool factory's `.func` body.
8. Write the six `src/commands/profile/*.ts` handlers and register them
   in `src/cli.ts`.
9. Add the `profile_active` LogEvent member and emit point in
   `src/agent/run.ts`.
10. Write the test plan against acceptance criteria 1–22 + edge cases
    E1–E23.

---

## References

| # | Source | URL | What was learned |
|---|---|---|---|
| 1 | AWS CLI configuration files docs | https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-files.html | Profiles are INI sections, but precedence chain (CLI > env > credentials > config) and `aws configure list` source-attribution model directly informed Q2 and Q7. |
| 2 | AWS CLI `configure list` reference | https://docs.aws.amazon.com/cli/latest/reference/configure/list.html | Source-attribution table format adopted in Q7. |
| 3 | kubectl config view docs | https://kubernetes.io/docs/reference/kubectl/generated/kubectl_config/kubectl_config_view/ | Default merged-YAML output, `--minify` and `--raw` toggles, `-o json` machine readout — informed Q7 hybrid approach. |
| 4 | Organizing kubeconfig files | https://kubernetes.io/docs/concepts/configuration/organize-cluster-access-kubeconfig/ | Context resolution order (flag → current-context → empty) parallels our profile activation-source chain (CLI flag → env var → none). |
| 5 | gh CLI multi-account discussion | https://github.com/cli/cli/discussions/12237 | YAML config under `~/.config/gh/config.yml`; native multi-account model; reinforces YAML-by-default for hand-edited tool configs. |
| 6 | Terraform plan command | https://developer.hashicorp.com/terraform/cli/commands/plan | Dry-run as read-only operation with `-out=FILE` + `terraform show` two-step reveals effective config; informed Q7's `--json` opt-in. |
| 7 | Terraform show command | https://developer.hashicorp.com/terraform/cli/commands/show | Text vs JSON output format precedent. |
| 8 | js-yaml vs yaml comparison | https://npm-compare.com/js-yaml,yaml,yamljs | `yaml` package ships first-party TS types; `js-yaml` requires stale `@types/js-yaml`. Both zero-dep. Drove Q1 package choice. |
| 9 | yaml package on npm | https://www.npmjs.com/package/yaml | API surface (parse / parseDocument / LineCounter); confirmed comment-preservation capability. |
| 10 | ESLint flat-config rule precedence | https://eslint.org/blog/2022/08/new-config-system-part-2/ | "Last config wins" + filter-by-files+ignores model — analogue for our allow→deny pipeline (Q3). |
| 11 | ESLint extends evolution | https://eslint.org/blog/2025/03/flat-config-extends-define-config-global-ignores/ | Reinforces that allow/deny filter ordering matters and global ignores must come first. |
| 12 | Commander.js README | https://github.com/tj/commander.js/ | Subcommand patterns; `.command()` + `.action()` vs nested `.addCommand()` — informed Q5. |
| 13 | Deeply nested subcommands in Node CLIs (Schmitt) | https://maxschmitt.me/posts/nested-subcommands-commander-node-js | Pattern walkthrough for `cli noun verb` style — used to evaluate Option 5B. |
| 14 | Zod docs (project dep) | https://zod.dev/ | `.strict()`, `.passthrough()`, `.partial()` helpers used in Q6 + Q4 recommendations. |

---

## Original Request

This investigation was conducted in response to the request:
"Investigate available approaches and solutions for adding a 'configuration
profiles' feature to the cli-agent project."

Refined request specification:
`docs/design/refined-request-config-profiles.md` (22 acceptance criteria,
edge cases E1–E23, three optional sections — `cliParams`, `tools`,
`toolArgs` — under `~/.tool-agents/cli-agent/profiles/<name>.{yaml|json}`).

Codebase scan:
`docs/reference/codebase-scan-config-profiles.md` (integration points
IP-1 through IP-8 in the existing four-tier resolution chain at
`src/config/agent-config.ts:644+`, the tool registry at
`src/agent/tools/registry.ts:47-84`, the CLI surface at
`src/cli.ts:40-83`, and the overlay subsystem from plan-004).
