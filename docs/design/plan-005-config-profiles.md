# Plan 005 — Configuration Profiles

**Status**: Draft (awaiting Phase 5 design + Phase 6 execution)
**Author**: cli-agent maintainer + Claude (planning agent)
**Date**: 2026-05-02
**Spec**: `docs/design/refined-request-config-profiles.md`
  (16 functional requirements, 22 acceptance criteria, 23 edge cases)
**Investigation**: `docs/reference/investigation-config-profiles.md`
  (7 design recommendations)
**Codebase scan**: `docs/reference/codebase-scan-config-profiles.md`
  (8 integration points, 19 touch points)
**Research**: `docs/research/yaml-package-usage.md`
  (eemeli/yaml — `parseDocument` + `linePos` + alias rejection)
**Coexists with**: `docs/design/plan-004-tool-prompt-overlays.md`
  (overlays change *tool prompt text*; profiles change *which tools are exposed*
  and *what default args they carry* — orthogonal)
**Functions doc**: appends FR-PROF-001 … FR-PROF-016 +
  NFR-PROF-001 … NFR-PROF-004 to `docs/design/project-functions.md`.

---

## 0. Open Questions for User

These four items are flagged as "Open Questions" in the refined spec
(§"Open Questions") and as "decisions still to confirm" in the investigation
(§"Implementation Considerations"). Each carries the recommendation made by
the investigator and the rationale. Where the recommendation can be locked in
without user input, the answer is given inline; where the user must rule, the
question is preserved.

| # | Question | Recommendation | Rationale | Status |
|---|---|---|---|---|
| OQ-1 | Exact precedence tier — between local `./.env` and `config.json`, or between `~/.tool-agents/cli-agent/.env` and `./.env`? | **Tier 5: between local `./.env` (tier 4) and `config.json` (tier 6)** per refined-spec §FR-PROF-004 + investigation Recommendation #2. | Profiles are "named replacements for `config.json`". Per-project `./.env` (more specific scope) keeps winning over a personal profile (less specific scope). | **Locked** unless user objects. |
| OQ-2 | Default file format for `profile-create` writes — YAML or JSON? | **YAML** (per refined-spec Assumption 1 + investigation Recommendation #1). | Stub uses three commented-out sections — only YAML supports inline comments. JSON is still tolerated on read. | **Locked** unless user objects. |
| OQ-3 | Subcommand naming style — flat `profile-list` or nested `profile list`? | **Flat hyphenated** (`profile-list`, `profile-show`, …) per investigation Recommendation #5. | The codebase has 5 existing flat-hyphenated subcommands (`show-capabilities`, `refresh-capabilities`, `extract-tool-prompts`, `show-tool-prompt`, `audit-tool-prompts`) and **zero nested subcommand groups**. Adopting a nested group as a one-off introduces a precedent inconsistent with the rest of the CLI. **This deviates from refined-spec Assumption 5**, but the spec itself flags this as Open Question 3 and explicitly says "If the project prefers hyphenated single-segment subcommands, this is purely cosmetic." | **Recommended (deviation)** — user should confirm or override. |
| OQ-4 | Ship a v1 TUI status-line readout of the active profile? | **Defer to v2** (out of scope). | Spec lists "TUI integration deferred" (Assumption 10). A read-only banner could be added in a one-line follow-up; not blocking for v1. | **Locked deferred** unless user requests inclusion. |

If the user prefers nested subcommands (Option 5B), the entire delta is mechanical: replace six top-level `program.command(...)` calls with one `program.command('profile')` parent + six `.command(verb)` children. Roughly ~95% of the implementation code is shared (codec, schema, loader, scoping, merge, dry-run). Phase 6 unit U-CLI is the only one affected, and the change is contained to `src/cli.ts` + `src/commands/profile/index.ts`.

Other research-document follow-up questions (`docs/research/yaml-package-usage.md` §"Clarifying Questions for Follow-up") are answered in §6 ("Decisions Locked at Plan Time").

---

## 1. Problem Statement and Goals

### 1.1 Problem

The cli-agent today supports a four-tier configuration resolution chain (CLI flag → shell env → agent-dir `.env` → local `./.env`, with `config.json` consulted at each per-knob site as a final source) and 17 built-in tools whose visibility is controlled by `--allow-mutations` and the `--enable-agt-*` / `--disable-agt-*` flags. Users who switch between three workflows (e.g. "code-review session with read-only tools and gpt-5", "experimental scratch with claude-opus-4 and shell access", "docs run with web search backend `tavily`") have no way to save those bundles. They must remember and re-type all relevant flags every time, edit `config.json` between runs, or maintain shell scripts that paper over the gap.

### 1.2 Goal

Add a first-class **configuration profile** feature: a named YAML/JSON file under `~/.tool-agents/cli-agent/profiles/<name>.{yaml|yml|json}` that bundles three orthogonal sections — `cliParams`, `tools`, `toolArgs` — into one preset, activated via `--profile <name>` or `CLI_AGENT_PROFILE=<name>`, slotting into the existing precedence chain at tier 5 (between local `./.env` and `config.json`), with explicit CLI flags ALWAYS winning. Provide management subcommands (`profile-list`, `profile-show`, `profile-create`, `profile-edit`, `profile-delete`, `profile-dry-run`) that work without launching the agent.

### 1.3 Non-goals (deferred)

Per refined-spec §"Out of scope":
- Strict "profile-wins" mode for `toolArgs` (v2).
- Profile inheritance / composition (v2).
- `defaultProfile` key in `config.json` (v2).
- Auto-generation from runtime state (v2).
- Per-profile secret storage (never; rejected by E11 validation).
- Cross-machine sync / import-export bundles (v2).
- TUI `/profile <name>` slash command (v2; OQ-4).
- Schema migration tooling (v2).

### 1.4 Coexistence with plan-004 overlays

Plan-004 adds `~/.tool-agents/cli-agent/tool-prompts/<tool>.md` overlays that change a tool's **prompt text**. This plan adds `~/.tool-agents/cli-agent/profiles/<name>.yaml` profiles that change **which tools are exposed** and **what default arguments they carry**. The two systems are orthogonal and CANNOT collide:

- The overlay subsystem runs first (`loadOverlayRegistry` at `src/config/agent-config.ts:826`); each tool factory consumes the registry at construction time.
- Profile tool scoping runs **after** the catalog is fully built (immediately before `buildToolCatalog` returns at `src/agent/tools/registry.ts:84`). Overlays for tools that profile scoping excludes are simply unused for that run; the overlay file on disk is untouched.
- Profile `toolArgs` references for tools excluded by `tools.allow`/`deny` are dead-code (warned, non-fatal, see E9).

---

## 2. Architecture Snapshot (text)

```
                  ┌──────────────────────────────────────────────┐
                  │ ~/.tool-agents/cli-agent/                     │
                  │   profiles/                                   │
                  │     review.yaml                               │
                  │     scratch.yaml                              │
                  │     docs.json   (tolerated on read)           │
                  └──────────────────────┬───────────────────────┘
                                         │  read on every cli-agent run
                                         │  IF --profile or CLI_AGENT_PROFILE
                                         ▼
                       ┌────────────────────────────────┐
                       │ profile-codec.ts               │
                       │  parseProfile / stringify /    │
                       │  detectAmbiguity (E18)         │
                       └────────────────┬───────────────┘
                                        │ unknown → Zod
                                        ▼
                       ┌────────────────────────────────┐
                       │ profile-schema.ts              │
                       │  ProfileSchema (.strict() top, │
                       │  .passthrough() on cliParams)  │
                       │  + secret-shape regex (E11)    │
                       └────────────────┬───────────────┘
                                        │ Profile (typed)
                                        ▼
                       ┌────────────────────────────────┐
                       │ profile-loader.ts              │
                       │  loadProfile(name, agentDir)   │
                       │  + name/stem cross-check (E4)  │
                       │  + digest (sha256 first 16)    │
                       └────────────────┬───────────────┘
                                        │ ActiveProfile
       ┌────────────────────────────────┼─────────────────────────────────┐
       ▼                                ▼                                 ▼
┌──────────────────┐    ┌────────────────────────────┐    ┌───────────────────────────┐
│ agent-config.ts  │    │ tools/profile-scoping.ts   │    │ tools/profile-tool-args.ts│
│ tier-5 insertion │    │ allow → deny → order       │    │ shallow merge per .func    │
│ at each knob:    │    │ (strict 3-pass; hard       │    │ helper called via          │
│ flags.X ?? layer │    │ errors on intersection,    │    │ runConfig.configurable     │
│ ?? PROFILE.X ?? │    │ duplicate-order, empty)    │    │                           │
│ configFile?.X   │    └──────────────┬─────────────┘    └─────────────┬─────────────┘
└──────────────────┘                   │                                │
       │                                │                                │
       ▼                                ▼                                ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  AgentConfig (cfg.activeProfile + cfg.activeProfileData carry profile facts) │
└──────────────────────────────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────┐    ┌──────────────────────────┐    ┌─────────────────────────┐
│ buildToolCatalog (apply  │ →  │ runOneShot / streamOneShot│ →  │ logger.log(             │
│  scoping at line 84)     │    │ inject profileToolArgs    │    │   kind: 'profile_active')│
│                          │    │ into configurable bag     │    │                         │
└──────────────────────────┘    └──────────────────────────┘    └─────────────────────────┘
```

Six new CLI subcommand handlers (`profile-list`, `profile-show`, `profile-create`, `profile-edit`, `profile-delete`, `profile-dry-run`) consume the same loader + codec + schema modules. `profile-dry-run` additionally calls a new "trace mode" of `loadAgentConfig` that records per-knob source attribution for the kubectl-/aws-style output.

---

## 3. Phasing Overview

| Phase | Name | Deliverable | Depends on | Parallelizable inside? |
|---|---|---|---|---|
| **P1** | Plan + functions doc | This file + FR-PROF-* entries | — | No |
| **P2** | Design write-up | `project-design.md` §12 (Profiles) | P1 | No |
| **P3** | Foundation modules | `yaml` dep + `profile-codec.ts` + `profile-schema.ts` + their specs | P2 | Yes (codec || schema) |
| **P4** | Loader + bootstrap | `profile-loader.ts` + `bootstrapProfilesDir` extension | P3 | No |
| **P5** | Config integration | tier-5 insertion in `agent-config.ts`; `--profile` flag; `CLI_AGENT_PROFILE` env | P4 | No |
| **P6** | Implementation (parallel) | 5 implementation units (see §5) | P5 | **YES — 5 parallel coders** |
| **P7** | Logging + trace | `profile_active` log event; `loadAgentConfig` trace mode for dry-run | P6 | No |
| **P8** | Tests + verification | All AC-1..22 + E1..23; smoke; cold-start budget | P7 | No |
| **P9** | Documentation | `configuration-guide.md`; `docs/tools/cli-agent.md`; user guides | P8 | Yes (3 docs in parallel) |

Phases P1–P5 are sequential. Phase P6 fans out into 5 parallel implementation units (§5). Phases P7–P9 are post-implementation.

Phase 5 (Design) is **NOT** this plan's responsibility — that updates `project-design.md`. This plan covers Phase 4 (planning) only.

---

## 4. Phase Details

### P1 — Plan + functions doc

**Inputs**: refined spec, investigation, codebase scan, yaml research, plan-004.
**Outputs**:
- This file (`docs/design/plan-005-config-profiles.md`).
- Append "Configuration Profiles (FR-PROF-*)" section to `docs/design/project-functions.md`.

**Acceptance**: plan file exists; project-functions.md contains FR-PROF-001..016 + NFR-PROF-001..004 entries cross-referencing the refined spec.

**Verification**: `ls docs/design/plan-005-config-profiles.md` and `grep -c "^### FR-PROF-" docs/design/project-functions.md` → 16.

**Risks**: none.

---

### P2 — Design write-up

**Inputs**: This plan.
**Outputs**: New `## §12. Configuration Profiles` section in `docs/design/project-design.md`, modeled on §11 (overlays). Includes:
- Architecture diagram (text) — copy of §2 above.
- Module layout table (codec, schema, loader, scoping, tool-args helper, six commands).
- Profile YAML format (mirrors refined-spec §FR-PROF-002).
- Bootstrap behavior (additive, mode 0700/0600).
- Architectural decisions (ADR-PROF-1 through ADR-PROF-7 — see §6).
- Update §2 architecture diagram and §6 logging schema to mention the new tier and event.

**Acceptance**:
- `project-design.md` has a `## §12. Configuration Profiles` heading.
- Architecture text in §2 mentions tier 5.
- §6 logging mentions `profile_active` event.

**Verification**: `grep -n "§12. Configuration Profiles" docs/design/project-design.md`; manual read.

**Risks**: drift from this plan if the design write-up disagrees on tier ordering. Mitigation: this plan is the source of truth for ADR decisions.

**Out of scope for THIS plan**: P2 is the design phase's responsibility, not the planner's. This phase entry is included so the planner can hand off cleanly.

---

### P3 — Foundation modules

**Inputs**: P2.
**Outputs**:
- Add `"yaml": "^2.6.0"` (or latest 2.x) to `package.json` dependencies. Run `npm install`.
- New file `src/config/profile-codec.ts` — encapsulates ALL `yaml`-package interaction.
  - `parseProfile(text: string, filePath: string): Profile` — uses `parseDocument()` + `linePos` for E2 diagnostics; rejects aliases (Position A from research §6); always `logLevel: 'error'`.
  - `stringifyProfile(profile: Profile): string` — `indent: 2`, `lineWidth: 100`.
  - `createProfileStub(name: string): string` — emits the YAML stub from research §"Complete Profile Codec Skeleton".
  - `detectAmbiguity(agentDir: string, name: string): { yaml?: string; json?: string }` — for E18.
- New file `src/config/profile-schema.ts` — Zod schema:
  - `z.object({ name?, description?, schemaVersion: z.literal(1).default(1), cliParams?, tools?, toolArgs? }).strict()` (top level strict — E3).
  - `cliParams: z.object({ provider, model, temperature, maxIterations, workingDir, logLevel, webSearchBackend, allowMutations, ... }).passthrough().optional()` (E20 forward-compat).
  - `tools.allow: z.array(z.string()).min(1).optional()` (E6 — empty array rejected by `.min(1)` semantic OR by a custom refine; see §6 ADR-PROF-3).
  - `tools.deny / tools.order: z.array(z.string()).optional()`.
  - `toolArgs: z.record(z.string(), z.record(z.string(), z.unknown())).optional()`.
  - `KNOWN_CLI_PARAMS: ReadonlySet<string>` exported for E20 warn-pass.
  - `CREDENTIAL_KEY_PATTERN: RegExp = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i` for E11.
  - `validateNoSecrets(cliParams: object): void` — throws ConfigurationError on match.
  - `validateToolArgsAgainstTool(name, args, schema?)` — calls `schema?.partial().safeParse(args)` (E10).
  - `Profile = z.infer<typeof ProfileSchema>` exported.
- Co-located `profile-codec.spec.ts` and `profile-schema.spec.ts` with hermetic in-memory fs mocks per the existing convention.

**Acceptance**:
- `npm run build` clean.
- `npx tsc --noEmit -p tsconfig.json` clean.
- `vitest run src/config/profile-codec.spec.ts src/config/profile-schema.spec.ts` green.
- All edge cases E2 (malformed YAML), E3 (unknown top-level key), E4 (filename mismatch via loader, deferred to P4 spec), E6 (empty allow), E10 (toolArgs schema fail for known tool), E11 (credential-shape key), E18 (yaml+json ambiguity), E20 (unknown cliParams key warn), E22 (duplicate order), E23 (allow∩deny non-empty) covered by spec tests in this phase OR P4/P6 as noted in §7.

**Verification**:
```
npm install
npm run build
npx tsc --noEmit -p tsconfig.json
npx vitest run src/config/profile-codec.spec.ts src/config/profile-schema.spec.ts
```

**Risks**:
| Risk | Mitigation |
|---|---|
| `yaml` dep introduces CVE surface | Use defaults + `logLevel: 'error'` + alias rejection. Document threat model: profile files are local-user-authored. |
| Bundle size grows ~110 KB | Acknowledged; see investigation §"Trade-off acknowledged". |
| Zod `.strict()` fights `.passthrough()` on nested object | They are layered explicitly: top is strict, `cliParams` only is passthrough. Verified pattern. |

---

### P4 — Loader + bootstrap

**Inputs**: P3.
**Outputs**:
- New file `src/config/profile-loader.ts`:
  - `loadProfile(name: string, agentDir: string): Promise<ActiveProfile>` — resolves path, calls codec, validates name/stem (E4), validates secrets, computes SHA-256 digest (first 16 hex), assembles `ActiveProfile { name, path, schemaVersion, digest, cliParams, tools, toolArgs }`.
  - `resolveProfilePath(name, agentDir): { yaml?, json? }` — checks both extensions; calls `detectAmbiguity` (E18); rejects illegal characters per E16 with `UsageError`.
  - `listProfiles(agentDir): Promise<ProfileFileEntry[]>` — for `profile-list`. Returns `[{name, description, size, mtime}]`.
- Extend `bootstrapAgentDir` in `src/config/agent-config.ts` (line 300):
  - Add `profiles/` subdirectory creation at mode `0700` (NFR-PROF-002 / AC-1).
  - **Additive**: never overwrite existing files; bootstrap creates only the directory, not any seed file (profiles are user-authored, not seeded).
- Co-located `profile-loader.spec.ts`.

**Acceptance**:
- AC-1: bootstrap creates `profiles/` at mode 0700.
- E1: `loadProfile('does-not-exist')` throws `UsageError` exit 2 with diagnostic (path searched + list of existing profiles).
- E4: `name:` field disagreeing with stem → `ConfigurationError` exit 3.
- E5: empty profile (just `name:`) → loads inert; stderr notice "profile <name> is empty".
- E16: name with `/`, `\`, leading `.` → `UsageError` exit 2.
- E17: profiles dir unreadable → `IOError` exit 6.
- E18: both `<name>.yaml` and `<name>.json` exist → `ConfigurationError` exit 3.

**Verification**:
```
npx vitest run src/config/profile-loader.spec.ts
npx vitest run src/config/agent-config.spec.ts  # bootstrap assertion
```

**Risks**:
| Risk | Mitigation |
|---|---|
| Digest leaks contents into logs | Digest is hash-only (SHA-256 hex first 16 chars); raw contents never logged (per FR-PROF-007 + investigation §"Potential pitfalls"). |
| `bootstrapAgentDir` mode-0700 assertion in existing spec breaks | Extend existing assertion array, do not replace; add one entry for `profiles/`. |

---

### P5 — Config integration

**Inputs**: P4.
**Outputs**:
- `src/config/agent-config.ts`:
  - Extend `AgentCliFlags` (line 220): `readonly profile?: string`.
  - Extend `AgentConfig` (line 154): `readonly activeProfile?: { name; path; schemaVersion; digest }`; `readonly activeProfileData?: { cliParams?; tools?; toolArgs? }` (the typed sub-trees).
  - `OTHER_ENV_KEYS` (line 551): add `'CLI_AGENT_PROFILE'`.
  - `loadAgentConfig` (line 644+): activate profile if `flags.profile ?? layered['CLI_AGENT_PROFILE']` is set; call `loadProfile`; thread `cliParams` into per-knob expressions:
    `flags.X ?? layered['AGENT_X'] ?? activeProfileData?.cliParams?.X ?? configFile?.X`
    for every pinnable knob (provider, model, temperature, maxIterations, workingDir, logLevel, webSearchBackend, allowMutations).
  - `loadAgentConfig` carries an optional `trace?: boolean` parameter that, when true, returns `{ config, traces: Map<knob, source> }` for `profile-dry-run` (delivered in P7 — stub here).
  - On profile activation, log a deferred event token (consumed in P7).
- `src/cli.ts`:
  - Lines 40-83: add `.option('--profile <name>', 'Activate a named configuration profile')`.
  - Line 93-121: pass `profile: opts['profile']` into `runAgentCommand` options.
  - Line 223+: register six new top-level subcommands `profile-list`, `profile-show`, `profile-create`, `profile-edit`, `profile-delete`, `profile-dry-run` (handlers stubbed to throw "not implemented" — filled in by P6 unit U-CLI).

**Acceptance**:
- AC-2: `--profile foo` with `cliParams: { temperature: 0.7 }` → LLM constructed at 0.7. (test in this phase or P6, see §7 mapping.)
- AC-3: `CLI_AGENT_PROFILE=foo` → identical behaviour.
- AC-4: `--profile foo --temperature 0.1` → 0.1 wins (3 distinct knobs tested).
- AC-5: shell env > profile.
- AC-6: profile > `config.json`.
- AC-21 invariant: `vitest run` with no profile active is byte-identical to baseline.
- E12: both `--profile` and `CLI_AGENT_PROFILE` set with different values → CLI wins.
- E13: `--profile foo` repeated → last-wins (Commander default).
- E14: `--profile` with no argument → Commander usage error.
- E19: profile sets `allowMutations: true`, no `--allow-mutations` flag → profile value wins (mutation tools become visible). Documented intentional behavior.

**Verification**:
```
npm run build
npx tsc --noEmit -p tsconfig.json
npx vitest run src/config/agent-config.spec.ts
```

**Risks**:
| Risk | Mitigation |
|---|---|
| Inserting tier 5 at one knob site but missing another (silent regression) | Audit every line in `loadAgentConfig` between line 706 and 928 that uses the `flags.X ?? layered['...'] ?? configFile?.X` triplet; replace each. Add a unit test per knob. Use grep to verify no `?? configFile?.` remains without `?? activeProfileData?.cliParams?.` immediately before it. |
| Breaking the no-profile path (regression invariant AC-21) | All new code is gated `if (activeProfileData)`; the no-profile codepath is unchanged. Run full test suite before merging. |
| Profile activation silently when `CLI_AGENT_PROFILE` is set in user shell | Documented in `configuration-guide.md`. Stderr "active profile: <name>" notice on startup (controlled by existing log-level rules). |

---

### P6 — Implementation (parallel)

This phase is the workhorse and is **structured for 5 parallel coders**. See §5 for the unit breakdown. Each unit is independent and consumes only the modules delivered by P3–P5.

---

### P7 — Logging + trace

**Inputs**: P6.
**Outputs**:
- `src/agent/logging.ts`: extend `LogEvent` union with `{ kind: 'profile_active'; ts; sessionId; profileName; profilePath; schemaVersion; digest }`.
- `src/agent/run.ts`: emit `profile_active` after `session_start` and before `user_prompt` (lines 46-63). Gate on `cfg.activeProfile`.
- `src/config/agent-config.ts`: complete the `trace?: true` mode of `loadAgentConfig` so each knob assignment records its source (`'cli-flag' | 'env:VAR' | 'agent-dir-.env' | 'local-.env' | 'profile:<name>' | 'config.json' | 'built-in-default'`). Used by `profile-dry-run`.

**Acceptance**:
- AC-19: `profile_active` JSONL event present in `~/.tool-agents/cli-agent/logs/<id>.jsonl` after a `--profile` run.
- `profile-dry-run --profile foo` produces correct source attribution (every knob row labelled with one of the 7 source enum values).

**Verification**:
```
npx vitest run src/agent/logging.spec.ts
npx vitest run src/commands/profile/dry-run.spec.ts
node dist/cli.js --profile foo "noop"  # smoke; inspect latest.jsonl
```

**Risks**:
| Risk | Mitigation |
|---|---|
| Trace mode duplicating resolution logic | Single canonical resolver — trace mode wraps the existing per-knob expressions in a `recordSource(knob, value, source)` helper. |
| Digest computation order (file contents vs serialized form) | Digest the raw file bytes, NOT the parsed object — guarantees byte-for-byte reproducibility audit (FR-PROF-007). |

---

### P8 — Tests + verification

**Inputs**: P6 + P7.
**Outputs**:
- Full coverage matrix (§7) green.
- `test_scripts/smoke-profile-cold-start.ts` — measures `--help` cold-start with feature compiled in but no profile (NFR-PROF-001 + AC-22, ≤ 50 ms regression budget).
- End-to-end test that launches `--profile <name>` and asserts the active tool catalog matches the profile (NFR-PROF-004).

**Acceptance**:
- `npm run build` clean.
- `npx tsc --noEmit -p tsconfig.json` clean.
- `npx vitest run` — all tests green; baseline + new tests.
- AC-22: cold-start delta ≤ 50 ms vs pre-feature baseline.

**Verification**:
```
npm run build
npx tsc --noEmit -p tsconfig.json
npx vitest run
node test_scripts/smoke-profile-cold-start.ts
```

---

### P9 — Documentation

**Inputs**: P8.
**Outputs** (parallel, three files):
- `docs/design/configuration-guide.md`: new "Configuration Profiles" section per the configuration-guide template (purpose, options, defaults, recommended storage, no-fallback rule, expiration n/a). Updates the precedence diagram to show tier 5.
- `docs/tools/cli-agent.md`: new `<configurationProfiles>` subsection inside `<cliAgent>` block.
- `docs/` user guides: add a profiles user-guide entry (or section in existing config guide).

**Acceptance** (FR-PROF-014):
- All 4 docs updated; cross-refs intact (`grep -l "FR-PROF" docs/`).

---

## 5. Phase 6 — Parallel Implementation Units

Phase 6 fans out into **5 implementation units**. Each unit is independently coded; integration happens at module boundaries already locked by P3–P5. Coders consume only public types/functions exported by foundation modules.

### Unit U-SCOPE — Tool list scoping algorithm

**Files to create**:
- `src/agent/tools/profile-scoping.ts`
- `src/agent/tools/profile-scoping.spec.ts`

**Files to modify**:
- `src/agent/tools/registry.ts:84` — wrap the assembled `tools` array with `applyProfileToolScoping(tools, cfg.activeProfileData?.tools)`.
- `src/agent/tools/registry.ts` (return path) — re-derive `agentToolsMeta` after scoping (codebase scan IP-3 invariant).

**Public API**:
```ts
export function applyProfileToolScoping(
  tools: AnyTool[],
  scoping: { allow?: string[]; deny?: string[]; order?: string[] } | undefined,
): { tools: AnyTool[]; warnings: string[] };
```

**Algorithm** (investigation Recommendation #3):
1. `validateNoIntersection(allow, deny)` — hard error E23 if any name appears in both.
2. `validateNoDuplicates(order)` — hard error E22 on duplicate.
3. If `allow` present: `tools.filter(t => allow.includes(t.name))`.
4. If `deny` present: `tools.filter(t => !deny.includes(t.name))`.
5. `validateNonEmpty(survivors)` — hard error E7 with suggestion.
6. If `order` present: stable reorder; survivors not in `order` keep original position appended.
7. Warnings (non-fatal, return as `string[]`): E8 (unknown name dropped), E21 (order references non-survivor).

**Acceptance criteria**:
- AC-7 (allow), AC-8 (deny), AC-9 (order), AC-10 (combined).
- E6, E7, E8, E21, E22, E23 covered by unit tests.

**Verification**: `npx vitest run src/agent/tools/profile-scoping.spec.ts src/agent/tools/registry.spec.ts`.

---

### Unit U-ARGS — Per-tool argument merge helper

**Files to create**:
- `src/agent/tools/profile-tool-args.ts`
- `src/agent/tools/profile-tool-args.spec.ts`

**Files to modify**:
- `src/agent/graph.ts:86-95` and `:160-174` — extend `configurable` with `profileToolArgs: cfg.activeProfileData?.toolArgs ?? {}`.
- `src/agent/run.ts:217` (`buildTuiAgentRuntime`) — same.
- 17 tool factories (one line each at the top of `.func`):
  - `src/agent/tools/bash/{run,list-allowed,which}-tool.ts`
  - `src/agent/tools/file/{read,list,write,edit,append}-tool.ts`
  - `src/agent/tools/web/{search,fetch}-tool.ts`
  - `src/agent/tools/tool-help-tool.ts`
  - `src/agent/tools/agent-tools/agt-{glob,grep,multiedit,patch,todo-read,todo-write}.ts`

**Public API**:
```ts
export function mergeProfileToolArgs<I extends Record<string, unknown>>(
  input: I,
  configurable: { profileToolArgs?: Record<string, Record<string, unknown>> } | undefined,
  toolName: string,
): I;  // returns { ...presets, ...input } (runtime input wins per-key)
```

**Per-factory pattern**:
```ts
async func(input, runConfig) {
  const merged = mergeProfileToolArgs(input, runConfig?.configurable, TOOL);
  // ... rest uses `merged` instead of `input`
}
```

**Acceptance criteria**:
- AC-11 (single arg merge).
- AC-12 (other args still apply when one overridden).
- E9: `toolArgs` references excluded tool → load-time warning.
- E10: arg fails Zod schema for known tool → `ConfigurationError` (handled by P3 schema validator + this unit's wiring).

**Verification**: `npx vitest run src/agent/tools/profile-tool-args.spec.ts`. Plus regression tests on each modified tool factory's existing `*.spec.ts`.

---

### Unit U-CLI — Six profile management subcommands

**Files to create**:
- `src/commands/profile/list.ts`
- `src/commands/profile/show.ts`
- `src/commands/profile/create.ts`
- `src/commands/profile/edit.ts`
- `src/commands/profile/delete.ts`
- `src/commands/profile/dry-run.ts`
- `src/commands/profile/shared.ts` — common helpers (resolveProfilePath, formatTable, etc.)
- One co-located `*.spec.ts` per handler.

**Files to modify**:
- `src/cli.ts` — replace the six stub registrations from P5 with real handlers (each subcommand uses `cmd.optsWithGlobals()` per NFR-OVR-001 pattern from plan-004).

**Subcommand surface** (flat hyphenated — investigation Recommendation #5; user-confirmable per OQ-3):

| Subcommand | Alias | Effect | FR | AC |
|---|---|---|---|---|
| `profile-list` | `profiles` | Enumerate profiles in tabular format (name, description, size, mtime) | FR-PROF-008 | AC-13 |
| `profile-show <name>` | — | Print raw + parsed/normalized + summary | FR-PROF-009 | AC-14 |
| `profile-create <name> [--from-current] [--description "..."] [--force]` | — | Scaffold YAML stub at mode 0600; `--from-current` captures resolved config; `--force` to overwrite | FR-PROF-010 | AC-15 |
| `profile-edit <name>` | — | Open in `$EDITOR` ($VISUAL fallback, then vi/notepad); re-validate after exit | FR-PROF-011 | — |
| `profile-delete <name> [--yes]` | `profile-rm` | Delete with confirmation (skipped with `--yes`) | FR-PROF-012 | — |
| `profile-dry-run [--profile <name>] [other flags] [--json]` | — | Run config resolution + tool scoping; print effective config WITHOUT launching LLM. Default human format with source attribution; `--json` machine output (investigation Recommendation #7). | FR-PROF-013 | AC-16 |

**Output format for `profile-show` and `profile-dry-run`** — see investigation §"Q7 Recommendation": kubectl/aws-style human report by default, `--json` opt-in (no need for default JSON; user must explicitly request).

**Acceptance criteria**:
- AC-13 (`profile-list` with 0 / 3 profiles).
- AC-14 (`profile-show`: exit 0 success / exit 2 missing / exit 3 malformed).
- AC-15 (`profile-create`: stub mode 0600; exit 2 if exists without `--force`).
- AC-16 (`profile-dry-run` reports effective config without launching).
- E1, E2, E3 surfaced via these subcommands too.

**Verification**:
```
npx vitest run src/commands/profile/
node dist/cli.js profile-list
node dist/cli.js profile-create test --description 'demo'
node dist/cli.js profile-show test
node dist/cli.js profile-dry-run --profile test
node dist/cli.js profile-delete test --yes
```

---

### Unit U-AGENTCFG — Agent-config integration polish

**Files to modify** (light follow-on from P5):
- `src/config/agent-config.ts` — finish per-knob threading; make `activeProfileData` immutable after assembly; export `KNOWN_CLI_PARAMS` for use by `profile-create --from-current`.
- `src/commands/agent.ts` — propagate `profile` flag through `AgentCommandOptions` (auto-inherited from `AgentCliFlags` per codebase scan IP-2; verify).
- Spec coverage for AC-2 through AC-6, E12, E13, E14, E19 in `src/config/agent-config.spec.ts`.

**Acceptance criteria**:
- All P5 acceptance items finalised.
- Cold-start no-profile path byte-identical (AC-21).

**Verification**:
```
npx vitest run src/config/agent-config.spec.ts
npm run build
```

---

### Unit U-DOCS — Documentation registration (deferred to P9)

NOT a P6 parallel unit; recorded here as the P9 deliverable. Listed for completeness so the parallel-coder dispatcher does not assume it should run alongside U-SCOPE/U-ARGS/U-CLI/U-AGENTCFG.

---

### Phase 6 unit summary (5 parallel coders)

1. **U-SCOPE** — Tool list scoping algorithm (`profile-scoping.ts`); strict 3-pass allow→deny→order.
2. **U-ARGS** — Per-tool argument shallow-merge helper + 17 factory updates injecting `mergeProfileToolArgs` at the top of each `.func`.
3. **U-CLI** — Six profile management subcommands (`profile-list/show/create/edit/delete/dry-run`) under `src/commands/profile/`.
4. **U-AGENTCFG** — Agent-config tier-5 polish + `AgentCommandOptions` propagation + acceptance specs for AC-2..6 / E12 / E13 / E14 / E19.
5. **U-FOUNDATION-FOLLOWUP** — Reserved unit for any P3 follow-up surfaced during integration (e.g., `validateProfileToolArgs.ts` if dispersed across multiple call sites). May be subsumed by U-AGENTCFG if no slippage occurs.

If five parallel coders are not available, the natural pair-up is `(U-SCOPE + U-ARGS)` (both touch the tool subsystem), `(U-CLI)` standalone, and `(U-AGENTCFG + U-FOUNDATION-FOLLOWUP)` (both touch config). This contracts to 3 effective workstreams.

---

## 6. Decisions Locked at Plan Time (ADRs)

These decisions are made by the planner based on the investigation, the codebase scan, and the yaml research. Each has a rationale and is open to user override.

- **ADR-PROF-1 — File format**: YAML default, JSON tolerated on read. Use `yaml` (eemeli) `^2.6.0`. Rationale: refined-spec Assumption 1 + investigation Recommendation #1. Comments matter for the `profile-create` stub; `yaml` ships first-party TS types.
- **ADR-PROF-2 — Precedence tier**: tier 5, between local `./.env` (tier 4) and `config.json` (tier 6). Rationale: refined-spec §FR-PROF-004 + investigation Recommendation #2.
- **ADR-PROF-3 — Tool scoping**: strict three-pass `allow → deny → order` with hard errors on `allow ∩ deny ≠ ∅` (E23) and duplicate `order` entries (E22), and on empty post-scoping catalog (E7) or explicitly-empty `allow` (E6). Rationale: investigation Recommendation #3. Note on E6: `z.array(z.string()).min(1).optional()` makes `allow: []` a Zod validation error — equivalent in effect to the spec's "explicitly empty" rejection; chosen over a custom refine for clarity.
- **ADR-PROF-4 — toolArgs merge depth**: shallow per-key merge at tool input level via shared `mergeProfileToolArgs` helper. Rationale: investigation Recommendation #4. All 17 current tools have flat-object inputs.
- **ADR-PROF-5 — CLI surface naming style**: flat hyphenated (`profile-list`, …). Rationale: investigation Recommendation #5; codebase has 5 existing flat subcommands and zero nested groups. **DEVIATION** from refined-spec Assumption 5 — captured as OQ-3 in §0; mechanically reversible if user prefers nested.
- **ADR-PROF-6 — Schema validation library**: Zod, with `.strict()` top-level + `.passthrough()` on `cliParams`. Rationale: NFR-PROF-003 mandates Zod; existing codebase dep; per-tool `toolArgs` validation reuses each tool's input Zod schema via `.partial()`.
- **ADR-PROF-7 — `profile-show` / `profile-dry-run` output**: hybrid — aws-style human table with per-knob source attribution by default; `--json` opt-in for machine consumption. Rationale: investigation Recommendation #7.
- **ADR-PROF-8 — YAML alias policy**: reject all aliases (research §6 Position A). Rationale: profile files are small and hand-written; aliases provide no legitimate value and add a confusion vector ("why didn't my anchor expand?"). Strict rejection produces the clearest error message.
- **ADR-PROF-9 — Digest scope**: SHA-256 hex first 16 chars, computed over **raw file bytes** (not the parsed object), recorded in `profile_active` log event. Rationale: byte-level reproducibility audit (FR-PROF-007); contents never leak (only hash).
- **ADR-PROF-10 — `profile-edit` round-trip**: re-validate only; do NOT re-write to disk after `$EDITOR` exit. Rationale: research Pitfall 4 — re-stringifying would silently normalize formatting and erase user style. Validation failure leaves the file as-is per FR-PROF-011.
- **ADR-PROF-11 — Resolution of yaml-research clarifying questions**:
  - Q1 (preserve original stub comments on `--from-current`)? **No.** `--from-current` regenerates the file fresh; comments are auto-emitted by the new stub template. Document the trade-off; users who want to preserve their own annotations should edit, not re-generate.
  - Q2 (re-validate vs re-validate+re-format)? **Re-validate only.** See ADR-PROF-10.
  - Q3 (surface all Zod issues at once)? **Yes**, single ConfigurationError listing all issues. Matches investigation §7 expected UX.
  - Q4 (per-key warning vs summary for unknown `cliParams`)? **Per-key warnings**, one stderr line per unknown key. Investigation Recommendation #1 + research §5 typing. Cap at 10 warnings per profile load to avoid log spam; show "(N more suppressed)" footer.

---

## 7. Edge Case Coverage Matrix (E1–E23)

Every edge case enumerated in the refined spec is explicitly handled. The phase that owns the test, and the disposition (test / error / out-of-scope), are recorded below.

| # | Edge Case | Phase / Unit | Disposition | Notes |
|---|---|---|---|---|
| E1 | `--profile foo` but no profiles/foo.* | P4 (loader) | Test → `UsageError` exit 2 | Error names the resolved path searched + lists existing profiles. |
| E2 | Malformed YAML/JSON | P3 (codec) | Test → `ConfigurationError` exit 3 | Uses `parseDocument()` + `linePos` for line/col; YAML message wrapped in friendly `"line N, col M: <msg>"`. JSON malformed via `JSON.parse` try/catch with same wrapper. |
| E3 | Schema validation fails | P3 (schema `.strict()`) | Test → `ConfigurationError` exit 3 | Names offending key + expected type. |
| E4 | `name:` ≠ filename stem | P4 (loader) | Test → `ConfigurationError` exit 3 | — |
| E5 | Empty profile (just `name:`) | P4 (loader) | Test → loads inert + stderr notice | One-line "[cli-agent] profile <name> is empty" notice. |
| E6 | `tools.allow: []` | P3 (schema `.min(1)`) | Test → `ConfigurationError` exit 3 | Caught at schema layer. |
| E7 | Profile disables every tool | U-SCOPE (`validateNonEmpty`) | Test → `ConfigurationError` exit 3 | Suggests offending entry. |
| E8 | Unknown tool in allow/deny/order | U-SCOPE | Test → stderr warning, drop silently | Forward-compat. |
| E9 | `toolArgs` references excluded tool | U-ARGS (load-time check) | Test → stderr warning, drop reference | Non-fatal. |
| E10 | `toolArgs` arg fails Zod | P3 (`validateToolArgsAgainstTool`) + U-ARGS | Test → `ConfigurationError` for known schemas; runtime warning for dynamic schemas | Uses `.partial()`. |
| E11 | Credential-shape key in `cliParams` | P3 (`validateNoSecrets`) | Test → `ConfigurationError` exit 3 | Regex `/(_API_KEY\|_TOKEN\|_SECRET\|_PASSWORD)$/i`. |
| E12 | Both `--profile` and `CLI_AGENT_PROFILE` set, different values | P5 (config) | Test → CLI wins, env silently ignored | Standard precedence. |
| E13 | `--profile foo` repeated | P5 (Commander default) | Test → last-wins | No special handling. |
| E14 | `--profile` with no argument | P5 (Commander default) | Test → usage error exit 2 | Built-in. |
| E15 | Profile excludes tool that has overlay | P6 / U-SCOPE | Test → overlay silently unused; file untouched | Asserted by integration test loading both subsystems (AC-18). |
| E16 | Profile filename contains illegal chars | P4 (`resolveProfilePath`) + U-CLI (`profile-create`) | Test → `UsageError` exit 2 (load); `profile-create` rejects proactively | Validate against POSIX/Win unsafe chars. |
| E17 | profiles/ unreadable | P4 (loader) | Test → `IOError` exit 6 | Caught from `readdir` EACCES. |
| E18 | Both `<name>.yaml` and `<name>.json` exist | P3 (codec `detectAmbiguity`) + P4 | Test → `ConfigurationError` exit 3 | No silent preference. |
| E19 | Profile sets `allowMutations: true` without flag | P5 (config integration) | Test → profile value applies | Documented intentional; mutating tools become visible. |
| E20 | Unknown `cliParams` key | P3 (schema `.passthrough()` + warn-pass) | Test → stderr warning, ignore | Forward-compat across cli-agent versions. |
| E21 | `tools.order` lists non-survivor | U-SCOPE | Test → stderr warning, drop | Non-fatal. |
| E22 | `tools.order` lists tool twice | U-SCOPE (`validateNoDuplicates`) | Test → `ConfigurationError` exit 3 | — |
| E23 | `tools.allow` ∩ `tools.deny` non-empty | U-SCOPE (`validateNoIntersection`) | Test → `ConfigurationError` exit 3 | — |

**Acceptance-criterion → phase mapping** (for traceability, AC-1..22):

| AC | Phase / Unit |
|---|---|
| AC-1 storage scaffolded | P4 |
| AC-2 activation via flag | P5 / U-AGENTCFG |
| AC-3 activation via env | P5 / U-AGENTCFG |
| AC-4 CLI flag beats profile | P5 / U-AGENTCFG |
| AC-5 shell env beats profile | P5 / U-AGENTCFG |
| AC-6 profile beats config.json | P5 / U-AGENTCFG |
| AC-7 allowlist | U-SCOPE |
| AC-8 denylist | U-SCOPE |
| AC-9 reordering | U-SCOPE |
| AC-10 combined scoping | U-SCOPE |
| AC-11 per-tool merge | U-ARGS |
| AC-12 other args still apply | U-ARGS |
| AC-13 profile-list | U-CLI |
| AC-14 profile-show | U-CLI |
| AC-15 profile-create | U-CLI |
| AC-16 profile-dry-run | U-CLI + P7 trace |
| AC-17 edge cases | matrix above |
| AC-18 overlay coexistence | U-SCOPE integration test |
| AC-19 logging event | P7 |
| AC-20 documentation | P9 |
| AC-21 no regression | P5 + P8 |
| AC-22 cold-start budget | P8 smoke |

---

## 8. Risks & Mitigations (cross-phase)

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Adding `yaml` dep increases install size + CVE surface | Acknowledged trade-off (investigation §1). `yaml` is zero-dep, well-maintained, ships TS types. Apply ADR-PROF-8 (alias rejection). |
| R-2 | Tier-5 insertion missed at one knob site, silent precedence bug | Audit script: grep for `?? configFile?\.` and verify each line has a preceding `?? activeProfileData?\.cliParams?\.`. Per-knob unit tests. |
| R-3 | Breaks the no-profile path (regression invariant AC-21) | All new code gated `if (cfg.activeProfileData)`. Pre-merge: full vitest run + diff against baseline. |
| R-4 | Overlay/profile collision when a tool is excluded but has overlay | Sequencing rule (overlay loads first, profile scoping filters last). Integration test AC-18. Overlay file on disk untouched by profile. |
| R-5 | YAML malformed user file produces opaque error | Use `parseDocument()` + `linePos`; wrap in "line:col: msg" message; common error codes mapped to user-friendly prefixes (research §4). |
| R-6 | `profile-edit` re-stringify destroys user formatting | ADR-PROF-10: re-validate only; never re-write. |
| R-7 | Trace mode duplicates resolution logic | Single canonical resolver wraps each per-knob expression in `recordSource()` helper instead of forking the function. |
| R-8 | Cold-start budget regression > 50 ms (NFR-PROF-001) | Short-circuit profile loader when `flags.profile && layered['CLI_AGENT_PROFILE']` are BOTH undefined (no fs access). Smoke script in P8 verifies. |
| R-9 | Unknown tool name in allow/deny dropping silently masks typo | ADR-PROF-3: warn on stderr; user sees "[cli-agent] warning: profile.tools.allow lists 'foo_run' which is not registered (forward-compat; ignoring)". |
| R-10 | `toolArgs` typo for known tool produces hard load failure (not warning) | This is the documented behavior (E10). For tools with dynamic schemas, fall back to runtime warning. |
| R-11 | Five parallel coders create merge conflicts on `src/cli.ts` and `src/agent/graph.ts` | P5 lands ALL flag/env/subcommand-stub changes; P6 units U-CLI and U-ARGS edit different sections (`profile-*` registrations vs. `configurable` literal). Pre-decided line ownership reduces conflict risk to zero. |
| R-12 | Bootstrap creating `profiles/` mode-0700 fails on Windows | Existing bootstrap already handles this via `fs.mkdir({ recursive: true, mode: 0o700 })`; Windows ignores mode silently. No additional handling needed. |

---

## 9. Coexistence with plan-004 (Tool Prompt Overlays)

Spelled out explicitly to satisfy FR-PROF-016:

| Concern | Overlays (plan-004) | Profiles (this plan) |
|---|---|---|
| File location | `~/.tool-agents/cli-agent/tool-prompts/<tool>.md` | `~/.tool-agents/cli-agent/profiles/<name>.{yaml\|json}` |
| Affects | Tool description text + parameter docstrings | Which tools are exposed; their default args; CLI param presets |
| Loaded by | `loadOverlayRegistry` → `cfg.toolPromptOverlays` | `loadProfile` → `cfg.activeProfile{,Data}` |
| Consumed by | Each tool factory (description / param `.describe`) | `buildToolCatalog` (scoping); per-tool `.func` (arg merge); per-knob expressions (cliParams) |
| Bootstrap | Additive seed of all 17 overlays on each cold start | Directory created; **NO file seeding** (profiles are user-authored) |
| Activation | Always active when overlay file exists | Opt-in via `--profile` or `CLI_AGENT_PROFILE` |
| Sequencing | Loaded BEFORE catalog assembly | Applied AFTER catalog assembly; tier-5 cliParams inserted at each knob |

**Collision scenarios handled**:
- Profile excludes tool X → overlay file `tool-prompts/X.md` is on disk but never read at runtime (the factory for X is not called). ADR-PROF clarifies overlay file is untouched.
- Profile's `toolArgs.X.foo = bar` for excluded tool X → load-time stderr warning (E9); reference dropped from runtime configurable bag.
- Profile scoping reorders X first; overlay for X applies to its description. No conflict — orthogonal axes.

---

## 10. Verification Commands (executable)

After each phase, run:

```bash
# P3 / P4 / P5 / P6 / P7 / P8
npm install                                                # P3 only (yaml dep)
npm run build                                              # all phases
npx tsc --noEmit -p tsconfig.json                          # all phases
npx vitest run                                             # all phases (full suite)

# Phase-specific
npx vitest run src/config/profile-codec.spec.ts            # P3
npx vitest run src/config/profile-schema.spec.ts           # P3
npx vitest run src/config/profile-loader.spec.ts           # P4
npx vitest run src/config/agent-config.spec.ts             # P4 + P5 + U-AGENTCFG
npx vitest run src/agent/tools/profile-scoping.spec.ts     # U-SCOPE
npx vitest run src/agent/tools/profile-tool-args.spec.ts   # U-ARGS
npx vitest run src/agent/tools/registry.spec.ts            # U-SCOPE integration
npx vitest run src/commands/profile/                       # U-CLI
npx vitest run src/agent/logging.spec.ts                   # P7

# Smoke / e2e
node test_scripts/smoke-profile-cold-start.ts              # P8 (NFR-PROF-001 / AC-22)
node dist/cli.js profile-list                              # P6 / U-CLI
node dist/cli.js profile-create demo --description 'plan-005 smoke'
node dist/cli.js profile-show demo
node dist/cli.js profile-dry-run --profile demo
node dist/cli.js --profile demo "noop"                     # AC-19 (logging event)
node dist/cli.js profile-delete demo --yes
```

A passing run: zero `tsc` errors, zero `vitest` failures, cold-start smoke script reports delta ≤ 50 ms vs baseline.

---

## 11. Issues Pending Tracker (for `Issues - Pending Items.md`)

The planner should NOT modify `Issues - Pending Items.md` directly — items below are surfaced for the user/maintainer to add:

1. **OQ-3 confirmation**: subcommand naming style (flat `profile-list` vs nested `profile list`). Recommendation: flat. Awaiting user ack.
2. **OQ-4 confirmation**: ship a v1 TUI status-line readout of active profile? Recommendation: defer. Awaiting user ack.
3. **NFR-PROF-001 baseline measurement**: capture current `cli-agent --help` cold-start before P3 dep addition so AC-22 has a concrete reference.
4. **Optional follow-up plan-006**: a `/profile <name>` slash command for the TUI (refined-spec out-of-scope item). Capture as plan-006 if user confirms.
5. **Optional follow-up plan-007**: profile inheritance / composition + `defaultProfile` in `config.json` (refined-spec out-of-scope items).
6. **Audit hook**: extend `audit-tool-prompts` (or a new `audit-profiles`) to detect stale `toolArgs` references after a future tool removal/rename. Tracked but not in v1.

---

## 12. Sign-off

This plan replaces no prior plan. Companion plan-004 (overlays) is unaffected. Implementation may proceed once OQ-1..4 are acknowledged or overridden by the user. Phase 6's parallel split (5 units) is the recommended dispatch for parallel coders; sequential execution is also feasible at modest cost (no architectural difference).

The sole architectural deviation from the refined spec (subcommand naming style — ADR-PROF-5 / OQ-3) is grounded in observable codebase convention; if the user prefers nested groups, the change is mechanical and contained to two files.
