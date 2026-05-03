# Plan 006 — Composite Intelligent Tools

**Status**: Draft (awaiting Phase 5 design + Phase 6 execution)
**Author**: cli-agent maintainer + Claude (planning agent)
**Date**: 2026-05-03
**Spec**: `docs/design/refined-request-composite-tools.md`
  (22 FR-CMP-* + 7 NFR-CMP-* + 27 acceptance criteria + 23 edge cases + flag matrix)
**Investigation**: `docs/reference/investigation-composite-tools.md`
  (7 design recommendations; resolves O-1 / O-2 deferred questions)
**Codebase scan**: `docs/reference/codebase-scan-composite-tools.md`
  (11 integration points IP-1..IP-11; new-module landing sites)
**Research — provider prompt cache**: `docs/research/llm-prompt-caching-providers.md`
  (per-provider wire format; `withSynthesisCache` helper recommendation)
**Research — POSIX shim**: `docs/research/posix-wrapper-shim-design.md`
  (npm `cmd-shim` reference; `#!/bin/sh`; no `set -euo pipefail`; `exec`-based)
**Coexists with**:
  - `docs/design/plan-004-tool-prompt-overlays.md` (overlays — NOT in v1 cache key)
  - `docs/design/plan-005-config-profiles.md` (profiles — passthrough only via cliParams)
  - `docs/design/plan-005-capability-recipes-and-manref.md` (recipes/manref — composite has `manRef: null`)
  - `docs/design/plan-005-tui-exit-and-resume.md` (TUI exit/resume — orthogonal; no overlap)
**Functions doc**: appends FR-CMP-001..023 + NFR-CMP-001..007 to
  `docs/design/project-functions.md` (high-level entries, refined request remains canonical).

---

## 0. Open Questions for User

These items derive from the refined spec (§"Open Questions" O-1..O-4) and from
spec corrections surfaced during the investigation. Each carries the planner's
recommendation, rationale, and status. Where the recommendation can be locked
without user input, the answer is given inline; where the user must rule, the
question is preserved.

| # | Question | Recommendation | Rationale | Status |
|---|---|---|---|---|
| OQ-1 | Should member-tool prompt-overlay edits invalidate the composite cache? (refined-spec O-1) | **No — overlays are NOT part of the v1 cache key.** Instrument JSONL with the current effective overlay digest (per member) at every `composite_synthesis_start` event so v1.1 has data to revisit. | Investigation Q5 / Recommendation #5: capability docs (synthesis input) are built from `--help` introspection, not overlays. Overlays change *prompt-time* tool description; synthesis consumes the *capability-time* artifact. Including overlays would force re-synthesis on cosmetic edits and defeat the cache. Documented contract; users force a fresh run via `--regenerate-capabilities`. | **Locked** unless user objects. |
| OQ-2 | Should `in-process` virtual-tool dispatch share the parent's conversation memory or always start fresh? (refined-spec O-2) | **Always start fresh — stateless per call.** The "tool-mental-model" principle (a tool call is observably stateless to its caller) is naturally enforced. `composite.virtualDispatch` defaults to `child-process` (hermetic isolation); `in-process` is opt-in and explicitly experimental. | Investigation Q3 / Recommendation #3 cites LangGraph Issue #3020 (subgraph re-entry state pollution) and parallel-tool-call hazards. Subprocess dispatch is the tested production path. | **Locked.** |
| OQ-3 | Should the synthesis pipeline expose per-stage token budgets (`--synthesis-budget-stage1`, `--synthesis-budget-stage2`)? (refined-spec O-3) | **No — one combined `--synthesis-budget-tokens` knob in v1.** Re-evaluate after measuring real pipeline cost distributions via JSONL telemetry. | Research-prompt-caching Finding 1: Stage-1 outputs (~500 tokens each) sit below every provider's 1024-token cache threshold, so on-disk Stage-1 cache is the only effective Stage-1 mechanism. Splitting the budget creates a UX surface that v1 cannot calibrate. The combined cap (default 32 768) is sufficient for the 2–5 member surface. | **Locked.** |
| OQ-4 | What should the cache do when the recorded `cliAgentVersion` is OLDER than the running cli-agent? (refined-spec O-4) | **Strict mismatch = cache miss, with a one-line stderr notice "[cli-agent] composite '<id>' cached against cli-agent <oldver>; resynthesising for <newver>" and a JSONL `composite_cache_version_mismatch` event.** No semver tolerance in v1. | The cache key already contains `cli-agent-version` (FR-CMP-009#3). Strict mismatch is the no-fallback rule applied to data; minor-version tolerance is invisible policy that drifts in production. The notice + telemetry preserves user awareness without prompting. Re-synthesis cost is bounded by the on-disk Stage-1 cache (member docs unchanged → Stage-1 hit → only Stage-2 re-runs). | **Locked** unless user objects. |
| OQ-5 | Should `--composite-name` collisions consult the manifest's `cliAgentVersion` strictly, or treat any version as "same composite, possibly stale"? | **Strict per FR-CMP-017** — different cli-agent version (or different member set) requires `--force-overwrite`. Idempotent only when both match exactly. | Refined spec FR-CMP-017 already specifies this. Listed here so the user can override. | **Locked** unless user objects. |
| OQ-6 | Should the wrapper shim embed the absolute resolved `cli-agent` path or rely on PATH lookup at runtime? | **Embed absolute resolved path** at synthesis time; emit a stderr warning when the resolved path lives under `~/.nvm/`, `~/.volta/`, or `~/.asdf/` (the path may move when the user switches Node versions). | Research-shim §6: PATH lookup at execution time is unreliable (the composites directory may not be on PATH; user PATH may differ at synthesis vs. invocation time). Cross-machine sync is already deferred (refined-spec Out-of-scope §2). | **Locked** unless user objects. |
| OQ-7 | Should `--regenerate-capabilities` be aliased onto `--refresh-capabilities` (per refined-spec FR-CMP-010 wording) or kept as a distinct flag? | **Distinct flags.** `--refresh-capabilities` continues to mean "re-introspect a member tool's `--help` and rewrite its discovery doc"; `--regenerate-capabilities` strictly means "re-synthesise a composite". A user supplying `--regenerate-capabilities` *without* `--treat-as-tool` gets a `UsageError` (exit 2) with message: `--regenerate-capabilities requires --treat-as-tool; use --refresh-capabilities for member-tool discovery refresh`. | Investigation Q7 / Recommendation #7: silently aliasing them creates a maintenance landmine and hides the intent difference (introspection vs LLM synthesis). This is **a deviation from refined-spec FR-CMP-010** captured as ADR-CMP-3. | **Recommended (deviation)** — user should confirm or override. |

If the user answers any OQ differently, only the noted module is affected; the
plan's structural shape is unchanged. The spec corrections (OQ-6, OQ-7) are
documented as ADR deviations in §6.

---

## 1. Problem Statement, Goals, Non-goals

### 1.1 Problem

cli-agent today wraps external CLI binaries by introspecting their `--help`
trees into per-tool capability documents at
`~/.tool-agents/cli-agent/capabilities/<tool>.md`. A user can already invoke
`cli-agent --tool A --tool B …` and have the agent orchestrate the assembly as
a single intelligent assistant. What the user **cannot** do is package that
curated assembly as a *new* `--tool <composite-id>` argument that another
cli-agent can wrap recursively. The first ingredient an outer cli-agent needs
is the composite's capability document — but a composite has no real binary
`--help` to introspect; the document must be **synthesised** from the
constituent docs + cli-agent's own knowledge.

### 1.2 Goal

Add the **composite intelligent tools** feature (v1) covering:

1. A `--treat-as-tool` flag (and a sibling `composite synthesize` subcommand)
   that reroutes `--help` to a synthesised capability document instead of
   cli-agent's own help text, while leaving every existing `--help` /
   `--tool` / capability path byte-identical when the new flags are absent
   (NFR-CMP-001).
2. A two-stage LLM synthesis pipeline (per-member distill → compose) producing
   a schema-3 capability document under
   `~/.tool-agents/cli-agent/capabilities/composite/<id>.md`, with a Stage-1
   per-member on-disk cache (`capabilities/composite/_distill/<member>@<digest>.json`)
   plus provider-side prompt caching at Stage-2.
3. Three opt-in distribution forms (default mix per FR-CMP-012/013/014):
   - **(a) Doc emission** (default ON): write the cached composite doc.
   - **(b) Wrapper shim** (default OFF): write a POSIX `/bin/sh` shim under
     `composites/<id>/<id>` that `cat`s the doc on `--help` and `exec`s
     `<absolute cli-agent path> --tool m1 --tool m2 "$@"` otherwise.
   - **(c) Virtual tool registration** (default OFF): write a manifest under
     `composites/<id>/manifest.json` so the cli-agent registry recognises
     `--tool <id>` without a PATH binary; runtime dispatch defaults to
     `child-process`, with `in-process` opt-in and experimental.
4. New cache layout, schema-3 frontmatter (composite/members/synthesizedAt/
   syntheticDigest/compositeName), `--regenerate-capabilities` flag,
   `--composite-name` validation/derivation, `--dry-run-synthesis`,
   `--synthesis-budget-tokens`, `--emit-doc` / `--emit-wrapper` /
   `--emit-wrapper-on-path` / `--register-virtual` / `--force-overwrite`,
   and the `composite synthesize | regenerate | list | show | delete`
   subcommand surface.
5. Recursion guard, file-mode invariants (`0700` dirs, `0600` doc/manifest,
   `0700` shim), and JSONL logging extensions (`composite_synthesis_start /
   _stage / _end`, `composite_emit`, `composite_dispatch`,
   `composite_cache_version_mismatch`).

### 1.3 Non-goals (deferred)

Per refined-spec §"Out of scope":

- **Composite-of-composite recursion** — explicitly rejected at registration
  AND dispatch time with `UsageError` exit 2 (FR-CMP-016).
- **Cross-machine sync** — composites stay on the synthesis machine; the shim
  embeds an absolute path that does not roam.
- **Programmatic secret redaction inside synthesised recipes** — synthesis
  prompts ask the LLM to refrain from emitting credential-shaped placeholders;
  the existing JSONL redaction policy applies to logs.
- **TUI slash commands** for composites (`/composite-create`, `/composite-show`,
  …). v1 ships CLI surface only.
- **Automatic regeneration on member-tool overlay change** (OQ-1).
- **Profile content shaping synthesis** beyond `cliParams` model selection.
  Profile `tools.allow/deny/order` is IGNORED for member selection
  (FR-CMP-019); active profile name is recorded as `activeProfile` for
  traceability only.
- **Per-stage token budgets** (OQ-3).
- **`extract-recipes` extension to composites**. Composite USER-RECIPES are
  populated by Stage-2 once at synthesis time; further user-driven recipe
  curation is a v1.1 follow-up.

### 1.4 Coexistence with plan-005 family

| Concern | Profiles (plan-005-config-profiles) | Overlays (plan-004) | Capability recipes / manRef (plan-005-capability-recipes-and-manref) | TUI exit/resume (plan-005-tui-exit-and-resume) | This plan (plan-006) |
|---|---|---|---|---|---|
| Affects | Which tools exposed; cliParam presets; toolArgs | Tool prompt text + param descriptions | USER-RECIPES + manRef in member doc | TUI Ctrl+C exit + JSON snapshot | Composite synthesis + 3 distribution forms |
| Bootstraps | `profiles/` dir | `tool-prompts/` dir | none (additive frontmatter) | snapshot dir | `capabilities/composite/`, `capabilities/composite/_distill/`, `composites/` |
| Read by composite synthesis? | Yes — `cliParams` selects model; record `activeProfile` only | **No** — overlays not in cache key (OQ-1) | Yes — member-doc bytes (excluding USER-* blocks) feed Stage-1 | No — TUI orthogonal |
| Synthesis schema fields | `activeProfile: <name\|null>` | (none) | composite has `manRef: null` always (per spec A-10) | (none) |
| Test coexistence (NFR-CMP-007) | Profile activates → synthesis uses profile model | Overlay applied to a member at member-discovery time | Member doc has USER-RECIPES → synthesis preserves | (no overlap; not asserted) | This plan owns the integration smoke |

The composite plan does **not** touch the overlay loader, the profile loader,
the recipe extractor, or the TUI exit/resume snapshot store. It calls
`createLLM(cfg)` with the `cfg` that has already been resolved by the existing
4-tier chain (with the plan-005 tier-5 profile insertion applied).

---

## 2. Architecture Snapshot (text)

```
                              ┌─────────────────────────────────────────────┐
                              │ User invokes:                                │
                              │   cli-agent --tool A --tool B \              │
                              │             --treat-as-tool --help           │
                              │ OR                                            │
                              │   cli-agent composite synthesize \            │
                              │             --tool A --tool B [--regenerate] │
                              └────────────────────┬────────────────────────┘
                                                   │
                                                   ▼
                              ┌─────────────────────────────────────────────┐
                              │ src/cli.ts                                   │
                              │   program.helpOption(false)                  │
                              │   .option('--treat-as-tool', …)              │
                              │   .option('--composite-name <id>', …)        │
                              │   .option('--emit-doc / --no-emit-doc', …)   │
                              │   .option('--emit-wrapper', …)               │
                              │   .option('--emit-wrapper-on-path', …)       │
                              │   .option('--register-virtual', …)           │
                              │   .option('--regenerate-capabilities', …)    │
                              │   .option('--dry-run-synthesis', …)          │
                              │   .option('--synthesis-budget-tokens <n>',…) │
                              │   .option('--force-overwrite', …)            │
                              │   .action(): branch on opts['help'] +        │
                              │             opts['treatAsTool']              │
                              └────────────────────┬────────────────────────┘
                                                   │
              ┌────────────────────────────────────┼────────────────────────────────────────┐
              ▼                                    ▼                                        ▼
     ┌────────────────────┐         ┌──────────────────────────┐         ┌───────────────────────────┐
     │ runAgentCommand    │         │ runComposite (NEW)        │         │ runCompositeSynth (NEW)    │
     │  (no composite     │         │ src/commands/composite/   │         │ src/commands/composite/    │
     │   path; existing   │         │   default-flag-driven.ts  │         │   synthesize.ts            │
     │   behavior)        │         │ for --treat-as-tool path  │         │ for subcommand path        │
     └────────────────────┘         └──────────────┬───────────┘         └───────────────┬───────────┘
                                                   │                                      │
                                                   └──────────────────┬───────────────────┘
                                                                      │
                                                                      ▼
                              ┌─────────────────────────────────────────────────────────────┐
                              │ Synthesizer  (src/agent/composite/synthesizer.ts)            │
                              │                                                              │
                              │  ┌──────────────────────────────────────────────────────┐    │
                              │  │ Stage-1 (per-member, embarrassingly parallel)         │    │
                              │  │   for each member m:                                  │    │
                              │  │     digest = sha256(member-doc-canonical-bytes        │    │
                              │  │                     ‖ distill-template-version        │    │
                              │  │                     ‖ synthesis-model-id)             │    │
                              │  │     if cache hit → load JSON                          │    │
                              │  │     else → llm.invoke(stage1Prompt(m)) ; write cache  │    │
                              │  │   path: capabilities/composite/_distill/<m>@<dig>.json│    │
                              │  └──────────────────────────────────────────────────────┘    │
                              │                       ▼                                       │
                              │  ┌──────────────────────────────────────────────────────┐    │
                              │  │ Stage-2 (single LLM call)                              │    │
                              │  │   messages = [SystemMessage(STATIC_SYNTH_PROMPT),      │    │
                              │  │               HumanMessage(distillBlock + COMPOSE_INST)│    │
                              │  │   messages = withSynthesisCache(messages,              │    │
                              │  │              { providerFamily, prefixEndIndex: 1,      │    │
                              │  │                anthropicTtl: '1h' })                   │    │
                              │  │   response = llm.invoke(messages)                      │    │
                              │  │   doc = composeCompositeDoc({ frontmatter, body,       │    │
                              │  │                               recipes, notes='' })     │    │
                              │  └──────────────────────────────────────────────────────┘    │
                              └────────────────────────────┬────────────────────────────────┘
                                                           │
                                                           ▼
                              ┌─────────────────────────────────────────────────────────────┐
                              │ Cache reader/writer  (src/agent/composite/cache.ts)          │
                              │   COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3 (new constant)     │
                              │   key = sha256(sortedMembers ‖ memberDigests ‖ cliVer        │
                              │                ‖ schemaVer ‖ compositeName ‖ modelId)        │
                              │   USER-RECIPES + USER-NOTES preserved across rewrite        │
                              │   atomic temp+rename                                          │
                              └────────────────────────────┬────────────────────────────────┘
                                                           │
        ┌──────────────────────────────────────────────────┼──────────────────────────────────────────────────┐
        ▼                                                  ▼                                                  ▼
┌────────────────────────┐        ┌──────────────────────────────────┐        ┌──────────────────────────────────────────┐
│ FORM (a) Doc           │        │ FORM (b) Wrapper shim             │        │ FORM (c) Virtual tool                     │
│ default ON              │        │ default OFF — opt-in              │        │ default OFF — opt-in                       │
│ writes:                 │        │ writes:                           │        │ writes:                                    │
│  capabilities/          │        │  composites/<id>/<id> (mode 0755) │        │  composites/<id>/manifest.json (mode 0600) │
│   composite/<id>.md     │        │  + optional symlink               │        │ scanned by loadVirtualTools at startup     │
│   (mode 0600)           │        │   ~/.local/bin/<id>               │        │ dispatched by dispatcher.ts:               │
│  + mirror/copy          │        │ #!/bin/sh; exec abs-path-cli      │        │   child-process (default)                  │
│   capabilities/<id>.md  │        │   --tool m1 --tool m2 "$@"        │        │   in-process (experimental)                │
│   for                   │        │ (research §5 template)            │        │ recursion guard at register + dispatch     │
│   composeCapabilities-  │        │                                   │        │                                            │
│   SystemPrompt          │        │                                   │        │                                            │
└────────────────────────┘        └──────────────────────────────────┘        └──────────────────────────────────────────┘
        │                                          │                                                    │
        └──────────────────────────────────────────┼────────────────────────────────────────────────────┘
                                                   ▼
                              ┌─────────────────────────────────────────────────────────────┐
                              │ Outer cli-agent runs `cli-agent --tool <id>`:                │
                              │  resolution order:                                           │
                              │   1. built-in tool name                                      │
                              │   2. virtual tool manifest match → meta-tool dispatch        │
                              │   3. PATH binary (the shim, if --emit-wrapper-on-path used)  │
                              │  composeCapabilitiesSystemPrompt reads <id>.md transparently │
                              │  → outer system prompt embeds composite USER-RECIPES         │
                              └─────────────────────────────────────────────────────────────┘
```

The `withSynthesisCache(messages, prefixEndIndex)` helper from the
prompt-caching research is the single provider-agnostic adapter that annotates
Stage-2 messages with `cache_control` markers on Anthropic / LiteLLM-Anthropic
and returns the messages unmodified on every other provider (where prefix
stability handles caching automatically or where caching is unavailable).

JSONL events emitted by every synthesis run:

```
composite_synthesis_start  { compositeName, members[], cacheHit, dryRun, providerFamily,
                             stage1OnDiskHits, currentEffectiveOverlayDigests }
composite_synthesis_stage  { stage: 1|2, promptDigest16, tokensInput, tokensOutput, latencyMs,
                             providerCacheCreation, providerCacheRead }
composite_synthesis_end    { status, totalTokens, outputDigest16, cacheFilePath }
composite_emit             { artifact: 'doc'|'wrapper'|'manifest'|'symlink',
                             absolutePath, mode }
composite_dispatch         { compositeName, mode: 'child-process'|'in-process', members[] }
composite_cache_version_mismatch { compositeName, recordedVersion, runningVersion }
```

---

## 3. Phasing Overview

| Phase | Name | Deliverable | Depends on | Parallelizable inside? |
|---|---|---|---|---|
| **P1** | Plan + functions doc | This file + FR-CMP-* / NFR-CMP-* entries appended to `project-functions.md` | — | No |
| **P2** | Design write-up | `project-design.md` §14 (Composite Tools) | P1 | No |
| **P3** | Foundation (paths, schema constant, bootstrap) | `agentCompositeCapabilitiesDir` / `agentCompositesDir` helpers; `bootstrapAgentDir` extension; `COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3` constant; type definitions; `AgentConfig` field additions | P2 | Yes (helpers ‖ schema constant) |
| **P4** | NFR-CMP-001 baseline + Commander helpOption(false) migration | Pinned `--help` golden snapshot + Commander `helpOption(false)` switch + intercept logic in `.action()` for non-composite path | P3 | No |
| **P5** | Cache reader/writer + composite-doc composer (no LLM yet) | `src/agent/composite/cache.ts`, `src/agent/composite/composeCompositeDoc.ts`, USER-RECIPES/USER-NOTES preservation, atomic temp+rename, 0o600 mode, schema-3 frontmatter writer | P4 | No |
| **P6** | Implementation (parallel) | Seven implementation units (see §5) | P5 | **YES — 7 parallel coders** |
| **P7** | Logging + telemetry | All `composite_*` events; integration of `extractCacheUsage()` per-stage; current-effective-overlay digest capture for v1.1 instrumentation (OQ-1) | P6 | No |
| **P8** | Tests + verification | All AC-1..27 + E1..23 + NFR-CMP-001..007; coexistence smoke (NFR-CMP-007); cache-hit cost smoke (NFR-CMP-004); synthesis latency smoke (NFR-CMP-003) | P7 | No |
| **P9** | Documentation | `configuration-guide.md`; `docs/tools/cli-agent.md` `<compositeTools>` block; user guide entry; cross-refs from `project-functions.md` | P8 | Yes (3 docs in parallel) |

Phases P1–P5 are sequential. Phase P6 fans out to **7 parallel implementation
units** (§5). Phases P7–P9 are post-implementation.

Phase 5 (project-design.md §14 update) is **NOT** this plan's responsibility
— that work is the design phase's task. This plan covers Phase 4 (planning)
plus an explicit handoff brief for Phase 5.

---

## 4. Phase Details

### P1 — Plan + functions doc

**Inputs**: refined spec, investigation, prompt-caching research, shim
research, codebase scan, plan-005 family, project-design.md §11 / §12 / §13.

**Outputs**:
- This file (`docs/design/plan-006-composite-tools.md`).
- Append "Composite Intelligent Tools (FR-CMP-*)" section to
  `docs/design/project-functions.md` with high-level entries for
  FR-CMP-001..023 + NFR-CMP-001..007 cross-referencing the canonical refined
  spec. Mirrors how plan-005 added FR-PROF-* and FR-CAP-*.

**Acceptance**: plan file exists; `grep -c '^### FR-CMP-' docs/design/project-functions.md` → 23; `grep -c '^### NFR-CMP-' docs/design/project-functions.md` → 7.

**Verification**: `ls docs/design/plan-006-composite-tools.md && grep -c '^### FR-CMP-' docs/design/project-functions.md`.

**Risks**: none (planning artefact).

---

### P2 — Design write-up (§14)

**Inputs**: This plan.

**Outputs**: New `## §14. Composite Intelligent Tools (plan-006)` section in
`docs/design/project-design.md` (after §13), modelled on §11 and §12.
Contents:

- Architecture diagram (text) — the §2 ASCII tree, refined.
- Module layout table (synthesizer, cache reader/writer, manifest,
  virtual-registry, dispatcher, shim writer, composite subcommands, prompt
  cache helper).
- Schema-3 frontmatter format (canonical ordering, validators).
- On-disk layout (the 3 new dirs + the `_distill/` cache).
- Bootstrap behaviour (additive, mode 0700).
- Architectural decisions (ADR-CMP-1 .. ADR-CMP-12 — see §6).
- Updates to §6 logging schema (six new event kinds).
- Updates to §2 architecture diagram footnoting `--treat-as-tool`.

**Acceptance**:
- `project-design.md` has a `## §14. Composite Intelligent Tools` heading.
- §6 logging mentions `composite_synthesis_*`, `composite_emit`,
  `composite_dispatch`, `composite_cache_version_mismatch`.
- §2 architecture diagram references the synthesis pipeline branch.

**Verification**: `grep -n '§14. Composite Intelligent Tools' docs/design/project-design.md`.

**Risks**: drift between this plan and the §14 write-up. Mitigation: this plan
owns the ADR decisions; §14 quotes them.

**Out of scope for THIS plan**: P2 is the design phase's responsibility; this
phase entry exists as a clean handoff.

---

### P3 — Foundation (paths, schema constant, bootstrap)

**Inputs**: P2.

**Outputs**:

1. `src/config/agent-config.ts`:
   - Add helpers (mirror IP-7 pattern):
     ```typescript
     export function agentCompositeCapabilitiesDir(): string {
       return path.join(agentCapabilitiesDir(), 'composite');
     }
     export function agentCompositeDistillDir(): string {
       return path.join(agentCompositeCapabilitiesDir(), '_distill');
     }
     export function agentCompositesDir(): string {
       return path.join(agentToolAgentsDir(), 'composites');
     }
     ```
   - Extend `bootstrapAgentDir` (line 343–385) to additively create
     `capabilities/composite/`, `capabilities/composite/_distill/`, and
     `composites/` at mode `0o700`.
   - Extend `AgentConfig` interface (line 154+): `compositeCapabilitiesDir`,
     `compositeDistillDir`, `compositesDir` populated by `loadAgentConfig`.
   - Extend `AgentCliFlags` (line 247–299): `treatAsTool`, `compositeName`,
     `emitDoc`, `emitWrapper`, `emitWrapperOnPath`, `registerVirtual`,
     `regenerateCapabilities`, `dryRunSynthesis`, `synthesisBudgetTokens`,
     `forceOverwrite`, `help` (the manual `--help` flag created by
     `helpOption(false)` in P4).
   - Extend `OTHER_ENV_KEYS` (line 588–610): `CLI_AGENT_COMPOSITE_BUDGET`,
     `CLI_AGENT_VIRTUAL_DISPATCH`.

2. `src/agent/composite/cache.ts` (new file, stub for P3):
   ```typescript
   export const COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3;
   export const SUPPORTED_COMPOSITE_SCHEMA_VERSIONS: ReadonlySet<number> =
     new Set([COMPOSITE_CAPABILITY_SCHEMA_VERSION]);
   ```
   Full body deferred to P5.

3. Type module `src/agent/composite/types.ts`:
   ```typescript
   export interface CompositeFrontmatter {
     readonly schemaVersion: 3;
     readonly composite: true;
     readonly compositeName: string;
     readonly members: readonly string[];
     readonly memberDigests: Readonly<Record<string, string>>;
     readonly synthesizedAt: string;
     readonly syntheticDigest: string;
     readonly cliAgentVersion: string;
     readonly synthesisModel: string;
     readonly activeProfile: string | null;
     readonly manRef: null;
     readonly manPagePath: null;
   }
   export interface CompositeManifest {
     readonly schemaVersion: 1;
     readonly compositeName: string;
     readonly members: readonly string[];
     readonly memberDigests: Readonly<Record<string, string>>;
     readonly createdAt: string;
     readonly cliAgentVersion: string;
     readonly capabilityDocPath: string;
   }
   export type DispatchMode = 'child-process' | 'in-process';
   ```

**Acceptance**:
- `npm run build` clean.
- `npx tsc --noEmit -p tsconfig.json` clean.
- `bootstrapAgentDir` creates the three new directories at `0o700` on a clean
  agent dir (asserted by `agent-config.spec.ts`).
- The existing `CAPABILITY_SCHEMA_VERSION = 2` is **not** modified.
- `grep -n 'CAPABILITY_SCHEMA_VERSION = 2' src/agent/capabilities/composeMarkdown.ts` still shows the unchanged line.

**Verification**:
```
npm run build
npx tsc --noEmit -p tsconfig.json
npx vitest run src/config/agent-config.spec.ts
```

**Risks**:
| Risk | Mitigation |
|---|---|
| Bootstrap mode-0700 assertion breaks existing spec | Extend the existing assertion array; do not replace; one entry per new directory. |
| The type module imports trigger cycles | The types module is leaf-level; only consumers import from it. |
| `OTHER_ENV_KEYS` ordering matters for snapshot tests | Append at the end; pin the env-snapshot test if needed. |

---

### P4 — NFR-CMP-001 baseline + Commander `helpOption(false)` migration

**Inputs**: P3.

**Outputs**:

1. `test_scripts/baseline-help-snapshot.ts`: captures the current
   `cli-agent --help` byte-stream (full output, expected hash) BEFORE the
   `helpOption(false)` change. The captured snapshot is checked in as
   `test_scripts/baselines/help-no-treat-as-tool.txt` together with its
   sha-256.

2. `src/cli.ts`:
   - Add `program.helpOption(false)` near top.
   - Add `program.option('--help', 'Show help (composite-aware when --treat-as-tool)', false)`.
   - In the default command's `.action()` (line 94–134), branch:
     ```typescript
     if (opts['help']) {
       const tools: string[] = opts['tool'] ?? [];
       if (opts['treatAsTool']) {
         if (tools.length === 0) {
           throw new UsageError(
             'composite synthesis requires at least one --tool argument',
           );
         }
         return runComposite({ ...opts, tools, mode: 'help-synthesis' });
       }
       program.outputHelp();
       process.exit(0);
     }
     ```
   - Same `helpOption(false)` strategy for each subcommand (so
     `cli-agent composite synthesize --help` works as expected for the
     subcommand, not as a passthrough).

3. Pinned regression test `src/cli.spec.ts` (or a new
   `test_scripts/help-baseline.spec.ts` colocated under
   `src/__tests__/`) that asserts `cli-agent --help` (no `--treat-as-tool`)
   matches the captured baseline byte-for-byte.

**Acceptance**:
- AC-1 (NFR-CMP-001): `cli-agent --help` byte-stream unchanged.
- `cli-agent --tool foo` (no `--treat-as-tool`) catalogue / system prompt
  unchanged (asserted by an existing `runAgentCommand` integration test
  that's already in the suite).

**Verification**:
```
node dist/cli.js --help > /tmp/help.actual
diff /tmp/help.actual test_scripts/baselines/help-no-treat-as-tool.txt
npx vitest run src/cli.spec.ts
```

**Risks**:
| Risk | Mitigation |
|---|---|
| Commander v12 behavior drift on subcommands | Re-pin baseline for each subcommand's `--help` (additive snapshot files). |
| `helpOption(false)` removes Commander's auto-recognition of `-h`; users may rely on `-h` | Re-register `-h` as alias on the manual `--help` option. |
| `program.outputHelp()` prints to stdout but `process.exit(0)` may be unreachable in tests | Use `program.exitOverride()` only if necessary; otherwise allow process.exit; tests can use `child_process.execFileSync` to capture. |

---

### P5 — Composite cache reader/writer + composer (no LLM yet)

**Inputs**: P4.

**Outputs**:

1. `src/agent/composite/cache.ts` (full body):
   - `computeCompositeCacheKey(input: CacheKeyInput): string` — sha256 of the
     deterministic concatenation per FR-CMP-009 (sorted members, member
     digests, cliAgentVersion, COMPOSITE_CAPABILITY_SCHEMA_VERSION,
     compositeName, synthesisModel).
   - `computeMemberDocDigest(memberDocPath: string): Promise<string>` — sha256
     of canonical member-doc bytes, **excluding** the USER-RECIPES and
     USER-NOTES blocks (per FR-CMP-009 #2). First 16 hex chars; mirrors the
     existing capability-doc digest pattern from plan-005-recipes.
   - `readCompositeCacheEntry(path: string): Promise<{ frontmatter, body, userRecipes, userNotes } | null>` — separate reader from `cache.ts:readCacheEntry`; checks `fm.schemaVersion ∈ SUPPORTED_COMPOSITE_SCHEMA_VERSIONS`; **does NOT call** `cache.ts:readCacheEntry`.
   - `writeCompositeCacheEntry(path: string, doc: string): Promise<void>` —
     atomic temp+rename; sets mode `0o600`; preserves any existing
     `<!-- USER-RECIPES:START -->…<!-- USER-RECIPES:END -->` and
     `<!-- USER-NOTES:START -->…<!-- USER-NOTES:END -->` blocks per
     FR-CMP-010 (and re-injects them into `doc` before write).
   - `mirrorCompositeDocToCapabilities(compositeName, fromPath, capabilitiesDir): Promise<void>` — copy (NOT symlink — investigation §"Pitfalls watched for" note) from `capabilities/composite/<id>.md` to `capabilities/<id>.md` so the existing `composeCapabilitiesSystemPrompt` reader picks it up unchanged.

2. `src/agent/composite/composeCompositeDoc.ts`:
   - `composeCompositeDoc(input: ComposeInput): string` — builds the full
     markdown body: frontmatter (canonical YAML key order), H1
     `# <compositeName> — capability document`, AUTO-GENERATED block from
     Stage-2 output, USER-RECIPES (pre-filled by Stage-2), USER-NOTES
     (empty stub).
   - Validates that Stage-2 output contains all required AUTO-GENERATED
     markers; raises `ConfigurationError` if not (no fallback per CLAUDE.md).

3. `src/commands/composite/derive-name.ts`:
   - `validateCompositeName(name: string): string` — regex
     `^[a-z][a-z0-9_-]{0,62}$`, throws `UsageError` exit 2 on violation
     (FR-CMP-011).
   - `deriveCompositeName(members: string[], cliAgentVersion: string, schemaVersion: number): string` — `<sorted-members-joined-by-+>@<hash8>` per FR-CMP-011.

4. Co-located `*.spec.ts` for each module:
   - `cache.spec.ts`: cache key determinism; member-doc digest excludes USER-* blocks; round-trip read+write preserves USER-* blocks; unsupported schema → null; v2 doc → null.
   - `composeCompositeDoc.spec.ts`: schema-3 frontmatter ordering; AUTO-GENERATED markers present; missing markers → throw.
   - `derive-name.spec.ts`: regex acceptance/rejection (per FR-CMP-011);
     derivation example matches `^file-cli\+outlook-cli@[0-9a-f]{8}$`.

**Acceptance**:
- AC-9 (auto-derived name regex) — covered by `derive-name.spec.ts`.
- AC-8 (composite name validation) — covered.
- FR-CMP-009 cache-key determinism: same input → same key bytes.
- USER-RECIPES / USER-NOTES preservation across `writeCompositeCacheEntry`.

**Verification**:
```
npx vitest run src/agent/composite/cache.spec.ts \
                src/agent/composite/composeCompositeDoc.spec.ts \
                src/commands/composite/derive-name.spec.ts
```

**Risks**:
| Risk | Mitigation |
|---|---|
| Member-doc digest computation differs from `cache.ts:readCacheEntry`'s implicit digest | Centralise canonicalisation: one helper `canonicaliseMemberDoc(text)` strips frontmatter trailing whitespace and the USER-* blocks; reused in both directions. Spec tests pin byte-for-byte. |
| Atomic write race on shared NFS | Use `fs.promises.writeFile(tmp, …, { mode: 0o600 })` + `rename`; same pattern as research §10. |
| Mirror copy stale after delete | `composite delete` (P6 / U-CMD) removes both `capabilities/composite/<id>.md` AND `capabilities/<id>.md`. |

---

### P6 — Implementation (parallel, 7 units)

The workhorse phase. Structured for **seven parallel coders**. See §5.

---

### P7 — Logging + telemetry

**Inputs**: P6.

**Outputs**:

- `src/agent/logging.ts`: extend `LogEvent` union with the six new event
  shapes from §2.
- `src/agent/composite/synthesizer.ts`: emit `composite_synthesis_start` /
  `_stage` / `_end` at each milestone; capture
  `currentEffectiveOverlayDigests` (forward-looking instrumentation per
  OQ-1); capture `providerCacheCreation` / `providerCacheRead` from
  `extractCacheUsage(response.response_metadata)`.
- `src/agent/composite/dispatcher.ts`: emit `composite_dispatch` per call.
- `src/agent/composite/cache.ts`: emit `composite_cache_version_mismatch`
  when `recordedCliAgentVersion !== runningCliAgentVersion` (OQ-4).
- `src/commands/composite/synthesize.ts`: emit `composite_emit` per artifact.

**Acceptance**:
- AC-23 (logging events present with documented payloads).
- All events redact bodies per existing JSONL redaction policy (digest only,
  per FR-CMP-021 / A-12). The redaction harness is already in
  `src/agent/logging.ts`; the new event shapes feed through it unchanged.

**Verification**: `npx vitest run src/agent/logging.spec.ts src/agent/composite/synthesizer.spec.ts src/agent/composite/dispatcher.spec.ts`.

**Risks**:
| Risk | Mitigation |
|---|---|
| Body content leaks via prompt-digest mis-implementation | sha-256 the JSON.stringify(messages) string with stable key order; record only the first 16 hex chars. Unit-tested. |
| `extractCacheUsage` returns `unknown` on Ollama / local-compat | Helper returns `{ provider: 'unknown', cachedTokens: 0, cacheCreationTokens: 0 }`. Logger records as zero — accurate. |

---

### P8 — Tests + verification

**Inputs**: P6 + P7.

**Outputs**:

- Full coverage matrix (§7) green: AC-1..27, E1..23, NFR-CMP-001..007.
- `test_scripts/fixtures/synthesis/<scenario>/` folders per investigation
  Recommendation #6:
  - `two-cli-tools-happy-path/` — covers AC-2 (synthesis), AC-4 (cache
    hit), AC-5 (cache miss on member doc change), AC-9 (derived name),
    AC-10 (`--no-emit-doc`).
  - `empty-recipes-edge-case/` — covers an LLM-output that yields empty
    USER-RECIPES; ensures markers still present.
  - `three-members-large-budget/` — covers `--synthesis-budget-tokens`
    enforcement.
  - `with-overlay-applied/` — covers NFR-CMP-007 coexistence (member has
    overlay; synthesis ignores overlay; OQ-1 instrumentation captures
    overlay digest).
  - `regenerate-preserves-user-blocks/` — covers AC-6.
- `test_scripts/lib/synthesisFixture.ts`: harness module per investigation
  §"Q6 Recommendation":
  ```typescript
  export async function loadScenario(name: string):
    Promise<{ stubLLM, inputs, expectedDoc, expectedTranscript }>
  export async function recordScenario(name: string, realLLM): Promise<void>
    // gated on process.env['RECORD'] === '1'
  ```
- `test_scripts/smoke-cache-hit-cost.ts`: NFR-CMP-004 — measures process boot
  → stdout flushed → exit 0 on a cache hit; assert ≤ 500 ms.
- `test_scripts/smoke-synthesis-latency.ts`: NFR-CMP-003 — synthesis under
  stub LLM ≤ 30 s for a 2-member ≤32 KB composite.
- `test_scripts/smoke-coexistence-end-to-end.ts`: NFR-CMP-007 — profile
  active + tool-prompt overlay applied to member + member has USER-RECIPES
  + synthesis + outer cli-agent attaching the composite via `--tool <id>`
  produces a coherent system prompt embedding the composite USER-RECIPES.

**Acceptance**: `npm run build && npx tsc --noEmit && npx vitest run` clean;
all smokes pass; baseline pinned snapshot still byte-identical.

**Verification**:
```
npm run build
npx tsc --noEmit -p tsconfig.json
npx vitest run
node test_scripts/smoke-cache-hit-cost.ts
node test_scripts/smoke-synthesis-latency.ts
node test_scripts/smoke-coexistence-end-to-end.ts
```

**Risks**:
| Risk | Mitigation |
|---|---|
| Recorded transcripts go stale when prompt template changes | Single batch re-record via `RECORD=1 npx vitest run --include "synthesis"` documented in test README. |
| Cache-hit-cost smoke blows 500 ms on slower machines | Capture machine spec in script header; allow `CLI_AGENT_TEST_PERFORMANCE_BUDGET_MULTIPLIER=2` env override for CI hosts. |

---

### P9 — Documentation

**Inputs**: P8.

**Outputs** (parallel, three docs):

- `docs/design/configuration-guide.md`: new "Composite Tools" section
  documenting `composite.synthesisBudgetTokens` /
  `CLI_AGENT_COMPOSITE_BUDGET`, `composite.virtualDispatch` /
  `CLI_AGENT_VIRTUAL_DISPATCH`. Explains the contract that overlays do NOT
  invalidate the composite cache (OQ-1); users must run
  `--regenerate-capabilities` for fresh synthesis. Notes the
  `--regenerate-capabilities` vs `--refresh-capabilities` distinction (OQ-7).
- `docs/tools/cli-agent.md`: new `<compositeTools>` subsection inside
  `<cliAgent>` block, listing the 10 new flags + 4 new subcommands.
- `docs/` user-guide entry for composite creation (mirrors plan-005's
  user-guide pattern).
- Cross-refs from `docs/design/project-functions.md` (already added in P1)
  and from `project-design.md` §14 (added in P2).

**Acceptance**: `grep -l 'FR-CMP' docs/` shows all four files; configuration
guide explains every new env var / config key; `<compositeTools>` block in
`docs/tools/cli-agent.md` validates with the existing tool-doc audit.

---

## 5. Phase 6 — Parallel Implementation Units

Phase 6 fans out into **seven implementation units**. Each unit consumes only
the modules delivered by P3–P5 and the type definitions in
`src/agent/composite/types.ts`. Integration happens at module boundaries
locked by P3–P5.

### Unit U-FLAGS — CLI flag plumbing (`--treat-as-tool` and friends)

**Files to create**:
- `src/cli-composite-flags.ts` — maps raw Commander opts to the
  `CompositeCliFlags` shape (parallel to `cli-agent-tools-flags.ts`).
- `src/cli-composite-flags.spec.ts`.

**Files to modify**:
- `src/cli.ts` — register the 10 new options on the default command (lines
  49–93 area), and ensure each subcommand inherits them via
  `cmd.optsWithGlobals()` where applicable (mirrors plan-005 NFR-OVR-001
  pattern).
- `src/config/agent-config.ts` — `AgentCliFlags` extension already done in
  P3; this unit ensures every flag maps cleanly into the config layer.

**New flag set** (all default `false` unless noted; default values shown
where the spec specifies them):

| Flag | Type | Default | FR | Notes |
|---|---|---|---|---|
| `--treat-as-tool` | boolean | false | FR-CMP-001 | Metadata when alone; modifies `--help` and emit/register flags. |
| `--composite-name <id>` | string | (derived) | FR-CMP-011 | Regex `^[a-z][a-z0-9_-]{0,62}$`. |
| `--emit-doc` / `--no-emit-doc` | boolean | true (when `--treat-as-tool`) | FR-CMP-012 | `--no-emit-doc` opts out. |
| `--emit-wrapper` | boolean | false | FR-CMP-013 | Writes shim. |
| `--emit-wrapper-on-path` | boolean | false | FR-CMP-013 | Adds `~/.local/bin/<id>` symlink. |
| `--register-virtual` | boolean | false | FR-CMP-014 | Writes manifest. |
| `--regenerate-capabilities` | boolean | false | FR-CMP-010 + ADR-CMP-3 | Distinct from `--refresh-capabilities` (OQ-7). |
| `--dry-run-synthesis` | boolean | false | FR-CMP-007 | No LLM, no cache write. |
| `--synthesis-budget-tokens <n>` | int | 32768 | FR-CMP-008 | Exit 2 on overrun mid-pipeline. |
| `--force-overwrite` | boolean | false | FR-CMP-017 | Resolves collision. |

**Flag-conflict enforcement** (per the spec's flag matrix):
- `--composite-name`, `--emit-doc`/`--no-emit-doc`, `--emit-wrapper`,
  `--emit-wrapper-on-path`, `--register-virtual`, `--dry-run-synthesis`,
  `--force-overwrite` without `--treat-as-tool` → `UsageError` exit 2 with
  message `<flag> requires --treat-as-tool`.
- `--regenerate-capabilities` without `--treat-as-tool` → per OQ-7 / ADR-CMP-3
  exit 2 with message
  `--regenerate-capabilities requires --treat-as-tool; use --refresh-capabilities for member-tool discovery refresh`.
- `--synthesis-budget-tokens` is permitted without `--treat-as-tool` (no-op,
  recorded for future synthesis runs in the same session) per the matrix
  row "OK (no-op; ignored without synth)".

**Help-interception logic** (lifted from P4, refined here): `.action()` on the
default command branches as in §P4; on `cli-agent composite synthesize` the
flag set is the same plus `--regenerate` (alias for
`--regenerate-capabilities`).

**Acceptance criteria (this unit)**:
- AC-3 (`--treat-as-tool --help` empty member list → exit 2).
- AC-8 (composite-name validation).
- AC-14 (`--dry-run-synthesis` prints stage prompts + digests, no LLM, no
  cache).
- Edge cases E-1..E-3, E-7..E-12 from §7 covered by `cli-composite-flags.spec.ts`.

**Verification**:
```
npx vitest run src/cli-composite-flags.spec.ts
node dist/cli.js --treat-as-tool --help               # E-1: exit 2
node dist/cli.js --composite-name foo                  # E-7: exit 2 (no --treat-as-tool)
node dist/cli.js --regenerate-capabilities             # E-12: exit 2 with OQ-7 message
```

---

### Unit U-SYNTH — Synthesis pipeline (Stage-1 + Stage-2)

**Files to create**:
- `src/agent/composite/synthesizer.ts`
- `src/agent/composite/stage1.ts` (per-member distillation + on-disk cache)
- `src/agent/composite/stage2.ts` (compose + provider-cache integration)
- `src/agent/composite/prompts.ts` (Stage-1 + Stage-2 prompt templates with
  embedded version constants `STAGE1_TEMPLATE_VERSION`,
  `STAGE2_TEMPLATE_VERSION`)
- `src/agent/composite/synthesizer.spec.ts`
- `src/agent/composite/stage1.spec.ts`
- `src/agent/composite/stage2.spec.ts`

**Files to modify**:
- `src/agent/composite/cache.ts` — extend with the Stage-1 cache helpers
  (`readDistillCacheEntry`, `writeDistillCacheEntry`).

**Public API**:
```typescript
// synthesizer.ts
export interface SynthesisInput {
  cfg: AgentConfig;
  llm: BaseChatModel;                 // already createLLM(cfg)'d
  members: readonly string[];          // sorted canonical names
  compositeName: string;
  dryRun: boolean;
  budgetTokens: number;
  logger: Logger;
}
export interface SynthesisResult {
  doc: string;                         // full schema-3 markdown
  frontmatter: CompositeFrontmatter;
  totalTokens: number;
  cacheHit: boolean;
}
export async function synthesizeComposite(input: SynthesisInput): Promise<SynthesisResult>;
```

**Stage-1 algorithm**:
1. For each member m:
   - Read `<capabilitiesDir>/<m>.md`; if absent and binary not on PATH →
     throw `ConfigurationError` exit 3 (FR-CMP-018, no silent
     fallback). If binary on PATH, run `discoverTool(m, cfg, llm, …,
     forceRefresh=false, …)` to populate first.
   - Compute `memberDocDigest = computeMemberDocDigest(<m>.md)`.
   - Compute `distillCacheKey = sha256(memberDocCanonicalBytes ‖ STAGE1_TEMPLATE_VERSION ‖ cfg.model)` first 16 hex.
   - Path: `agentCompositeDistillDir() + '/' + m + '@' + distillCacheKey + '.json'`.
   - If file exists → load JSON `{ memberName, content, modelId, templateVersion, createdAt }` → use as Stage-1 result for m.
   - Else → assemble Stage-1 prompt; call `llm.invoke(messages)`;
     accumulate tokens; write JSON to cache (mode `0o600`); use as result.
2. On `dryRun: true`: emit the stage prompts to stdout (with sha256 digest)
   for every uncached member; do NOT call the LLM; do NOT write cache.

**Stage-2 algorithm**:
1. Build `messages = buildStage2Messages(STATIC_SYNTH_PROMPT, distillResults, COMPOSE_INSTRUCTION, cfg)`.
2. `messages = withSynthesisCache(messages, { providerFamily: resolveProviderFamily(cfg), prefixEndIndex: 1, anthropicTtl: '1h' })` — from research §"Provider-Agnostic Helper Sketch" (this is U-CACHE's deliverable; consumed here).
3. On `dryRun: true`: emit the assembled prompt + sha256 digest to stdout;
   do NOT call the LLM.
4. Else: `response = await llm.invoke(messages)`; check token total against
   `budgetTokens` BEFORE and AFTER; on overrun → `UsageError` exit 2 naming
   consumed/cap (FR-CMP-008).
5. Validate Stage-2 output structure (must contain AUTO-GENERATED markers
   and a USER-RECIPES block); else `ConfigurationError`.
6. Return `composeCompositeDoc({ frontmatter: …, body: stage2Output, … })`.

**Acceptance criteria (this unit)**:
- AC-2 (`--treat-as-tool --help` produces schema-3 doc).
- AC-4 (cache hit; same bytes; no LLM call asserted by stub).
- AC-5 (member-doc bytes mutate → cache miss).
- AC-14 (dry-run prints prompts).
- AC-17 (missing constituent → exit 3).
- AC-18 (profile passthrough — model honoured; `tools.allow/deny/order` not
  consulted; `activeProfile` recorded).

**Verification**: `npx vitest run src/agent/composite/synthesizer.spec.ts src/agent/composite/stage1.spec.ts src/agent/composite/stage2.spec.ts` plus the fixture-folder driven scenarios.

---

### Unit U-CACHE — Provider-agnostic prompt-cache helper

**Files to create**:
- `src/agent/composite/llm-cache.ts` — implements `withSynthesisCache` and
  `extractCacheUsage` per research §"Provider-Agnostic Helper Sketch".
- `src/agent/composite/llm-cache.spec.ts`.

**Files to modify**: none directly (consumed by `stage2.ts`).

**Public API**:
```typescript
export type ProviderFamily =
  | 'anthropic' | 'openai' | 'azure-openai' | 'azure-inference'
  | 'google-gemini' | 'litellm-anthropic' | 'litellm-openai'
  | 'ollama' | 'local-compat';

export interface SynthesisCacheOptions {
  providerFamily: ProviderFamily;
  prefixEndIndex: number;
  anthropicTtl?: '5m' | '1h';
}

export function withSynthesisCache(messages: BaseMessage[], options: SynthesisCacheOptions): BaseMessage[];
export function extractCacheUsage(responseMetadata: Record<string, unknown>): { cachedTokens: number; cacheCreationTokens: number; provider: 'anthropic' | 'openai-compat' | 'unknown' };
export function resolveProviderFamily(cfg: AgentConfig): ProviderFamily;
```

**Per-provider behaviour** (research §"Decision Table"):
- `anthropic` / `litellm-anthropic`: annotate up to two `cache_control` blocks
  (system + members), TTL per `anthropicTtl`.
- `openai` / `azure-openai` / `azure-inference` / `litellm-openai`: return
  messages unmodified; document the prefix-stability discipline.
- `google-gemini`: return messages unmodified (rely on implicit caching on
  Gemini 2.5+).
- `ollama` / `local-compat`: return messages unmodified.

**Acceptance criteria (this unit)**:
- Round-trip: feeding the same messages with the same options is
  deterministic byte-for-byte.
- Anthropic path produces two `cache_control` annotations on the system
  block and the members block; the compose-instruction block is not
  annotated.
- `extractCacheUsage` reads Anthropic's `cache_read_input_tokens` and OpenAI's
  `prompt_tokens_details.cached_tokens` correctly; returns zeros on unknown
  providers.

**Verification**: `npx vitest run src/agent/composite/llm-cache.spec.ts`.

---

### Unit U-DOC — Schema-3 doc writer/reader + USER-* preservation

**Files to create**: (most already in P5)
- `src/agent/composite/composeCompositeDoc.spec.ts` (extended scenarios)

**Files to modify**:
- `src/agent/composite/cache.ts` — final body (P5 lays the foundations; this
  unit closes the contract).
- `src/agent/capabilities/compose-system-prompt.ts` — extend
  `composeCapabilitiesSystemPrompt(capabilitiesDir, tools, maxBytesPerTool)`
  to also check `<capabilitiesDir>/composite/<tool>.md` as a fallback if
  `<capabilitiesDir>/<tool>.md` is absent. (Mirror copy from P5 means the
  outer agent finds the doc transparently in 99 % of cases; the fallback
  handles the case where the mirror is missing.)

**Acceptance criteria (this unit)**:
- AC-6 (`--regenerate-capabilities` preserves USER-RECIPES + USER-NOTES
  byte-for-byte across rewrite).
- Schema migration NFR-CMP-006 (a hypothetical schema-2 composite cache file
  is treated as cache miss and re-synthesised) — exercised by
  `cache.spec.ts` injecting a doc with `schemaVersion: 2` into the composite
  reader and asserting `null` return.
- E-13 (composite doc with corrupt frontmatter → cache miss + re-synth).
- E-14 (composite doc missing AUTO-GENERATED markers → cache miss).

**Verification**: `npx vitest run src/agent/composite/cache.spec.ts src/agent/composite/composeCompositeDoc.spec.ts src/agent/capabilities/compose-system-prompt.spec.ts`.

---

### Unit U-WRAPPER — POSIX shim generator

**Files to create**:
- `src/agent/composite/shim-writer.ts` — implements
  `generateCompositeWrapperShim` per research-shim §8.
- `src/agent/composite/shim-writer.spec.ts` — unit tests via snapshot
  (research-shim §11.2) and end-to-end execution (research-shim §11.1).
- `test_scripts/shim-e2e.ts` — integration test (research-shim §11.1).

**Files to modify**:
- `src/commands/composite/synthesize.ts` (created by U-CMD) — calls
  `generateCompositeWrapperShim` when `--emit-wrapper` is set.

**Public API**:
```typescript
export interface CompositeShimOptions {
  compositeName: string;
  members: readonly string[];
  cliAgentBinPath: string;       // absolute, resolved at synthesis time
  capabilityDocPath: string;      // absolute
  shimDir: string;                // composites/<id>/
  synthesizedAt: string;          // ISO 8601
}
export interface GeneratedShim {
  shimPath: string;
  mode: number;                   // 0o755
}
export async function generateCompositeWrapperShim(opts: CompositeShimOptions): Promise<GeneratedShim>;
export async function generatePathSymlink(shimPath: string, symlinkDir: string, compositeName: string): Promise<{ symlinkPath: string }>;
```

**Shim template** (per research §5, lifted verbatim):
```sh
#!/bin/sh
# cli-agent composite wrapper — <compositeName>
# Generated: <synthesizedAt>
# DO NOT HAND-EDIT — regenerate with:
#   cli-agent --treat-as-tool --regenerate-capabilities --composite-name <compositeName>
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
DOC='<absoluteDocPath>'
case "${1:-}" in
  --help|-h)
    if [ ! -r "$DOC" ]; then
      echo "composite cache stale; re-run: cli-agent --treat-as-tool --regenerate-capabilities --composite-name <compositeName>" >&2
      exit 6
    fi
    exec cat "$DOC"
    ;;
esac
exec '<absoluteCLIAgentPath>' --tool <m1> --tool <m2> "$@"
```

Key design decisions (research §13):
- `#!/bin/sh` (not `#!/usr/bin/env bash`) — eliminates Alpine/no-bash failure
  mode (deviation from refined-spec FR-CMP-013 #shebang; locked as ADR-CMP-2).
- No `set -euo pipefail` — `pipefail` is non-POSIX-portable; `exec` makes
  most of `set -e` redundant; `set -u` interacts badly with `${1:-}`.
- `exec` for both `cat` and the cli-agent invocation — signal forwarding
  and exit-code propagation are automatic.
- Atomic write: `writeFile(tmp, …, { mode: 0o755 })` then `rename(tmp, dst)`.
- Absolute path for `cli-agent` binary (per OQ-6 / research §6).
- nvm/volta/asdf detection: emit a stderr warning at synthesis time when
  `cliAgentBinPath` includes `/.nvm/`, `/.volta/`, or `/.asdf/`.

**Acceptance criteria (this unit)**:
- AC-11 (`--emit-wrapper` produces an executable shim that prints doc on
  `--help` and execs cli-agent on arbitrary args; refuses with exit 6 when
  cache missing).
- AC-12 (`--emit-wrapper-on-path` creates the symlink only when explicit).
- AC-26 (no PATH pollution by default — `~/.local/bin/` untouched without
  the explicit flag).
- E-15 (composite name collides with an existing PATH binary →
  `--emit-wrapper-on-path` warns; non-fatal).
- File-mode invariants (NFR-CMP-005): shim `0o755` (executable);
  `composites/<id>/` `0o700`.

**Verification**: `npx vitest run src/agent/composite/shim-writer.spec.ts && node test_scripts/shim-e2e.ts`.

---

### Unit U-VIRTUAL — Virtual tool registry + dispatcher

**Files to create**:
- `src/agent/composite/manifest.ts` — manifest reader/writer; mode `0o600`;
  collision detection per FR-CMP-017.
- `src/agent/composite/virtual-registry.ts` — `loadVirtualTools(cfg, logger)`
  scans `composites/*/manifest.json` and returns
  `DynamicStructuredTool[]`. Recursion guard at register time
  (FR-CMP-016).
- `src/agent/composite/dispatcher.ts` —
  `dispatchComposite(manifest, args, mode, cfg)` dispatches in subprocess
  (default) or in-process (experimental). Recursion guard at dispatch time;
  child receives `CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1` env var so its
  `loadVirtualTools` returns `[]`.
- `src/agent/composite/manifest.spec.ts`
- `src/agent/composite/virtual-registry.spec.ts`
- `src/agent/composite/dispatcher.spec.ts`

**Files to modify**:
- `src/agent/tools/registry.ts` (line 84–96 area, between
  `buildAgentToolsGroup` and `applyProfileToolScoping`) — call
  `loadVirtualTools(cfg, logger)` and inject the resulting tools into the
  `assembled` array. Virtual tools are subject to plan-005 profile scoping
  exactly like native tools.

**Public API**:
```typescript
// manifest.ts
export async function readManifest(path: string): Promise<CompositeManifest | null>;
export async function writeManifest(path: string, manifest: CompositeManifest, opts: { force: boolean }): Promise<void>;

// virtual-registry.ts
export async function loadVirtualTools(cfg: AgentConfig, logger: Logger): Promise<DynamicStructuredTool[]>;

// dispatcher.ts
export interface DispatchInput {
  manifest: CompositeManifest;
  invocationArgs: readonly string[];
  mode: DispatchMode;
  cfg: AgentConfig;
  logger: Logger;
}
export interface DispatchResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
export async function dispatchComposite(input: DispatchInput): Promise<DispatchResult>;
```

**Recursion guard**:
- At registration (`writeManifest` and `register-virtual` action): if any
  member name is already registered as a virtual tool → `UsageError` exit 2
  with the FR-CMP-016 message.
- At dispatch (`dispatchComposite`): re-check membership against the live
  registry; the same `UsageError` if violation.
- The child-process child receives env
  `CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1`; the child's
  `loadVirtualTools` returns `[]` when this env is set, structurally
  preventing nested composites.

**Acceptance criteria (this unit)**:
- AC-13 (`--register-virtual` writes manifest; outer agent recognises
  composite via `--tool <id>`).
- AC-15 (recursion guard at register time).
- AC-16 (composite-name collision → exit 2; `--force-overwrite` succeeds;
  identical re-register is idempotent).
- AC-19 (outer-agent consumption via wrapper shim, virtual-registry path,
  and doc-only path produces three coherent system prompts that embed
  USER-RECIPES).
- FR-CMP-015 dispatch-mode integration test: same input produces identical
  observable output across `child-process` and `in-process`.

**Verification**: `npx vitest run src/agent/composite/manifest.spec.ts src/agent/composite/virtual-registry.spec.ts src/agent/composite/dispatcher.spec.ts src/agent/tools/registry.spec.ts`.

---

### Unit U-CMD — `composite synthesize | regenerate | list | show | delete` subcommands

**Files to create**:
- `src/commands/composite/synthesize.ts` — the workhorse: drives the
  flag-driven AND subcommand-driven entry; calls `synthesizeComposite`,
  `writeCompositeCacheEntry`, `mirrorCompositeDocToCapabilities`,
  `generateCompositeWrapperShim`, `writeManifest`.
- `src/commands/composite/regenerate.ts` — alias for `synthesize --regenerate`.
- `src/commands/composite/list.ts` — table listing of registered virtuals
  (manifest scan).
- `src/commands/composite/show.ts` — print cached composite doc.
- `src/commands/composite/delete.ts` — remove manifest, wrapper folder,
  cached doc, mirror copy, optional symlink; confirmation prompt with `--yes`
  to skip.
- `src/commands/composite/shared.ts` — common helpers (resolveCompositePath,
  formatTable, etc.).
- One co-located `*.spec.ts` per handler.

**Files to modify**:
- `src/cli.ts` — register four new subcommands:
  ```typescript
  program.command('composite synthesize') /* etc */
  // subcommand styles: investigation Recommendation #7 favours a sibling
  // subcommand, NOT a nested group. We register flat hyphenated subcommands
  // for cli-agent codebase consistency:
  //   composite-synthesize
  //   composite-list
  //   composite-show <id>
  //   composite-delete <id>
  // (The subcommand wording in the refined spec uses 'composite synthesize'
  // as a logical grouping; per ADR-CMP-4, we render this with hyphens to
  // match the existing 5 flat-hyphenated subcommands.)
  ```

**ADR-CMP-4 deviation note**: the refined spec writes `cli-agent composite
synthesize` as if it were a nested group. Per investigation Recommendation #7
(a sibling subcommand) AND plan-005's ADR-PROF-5 (codebase has zero nested
groups; five existing flat-hyphenated subcommands), this plan registers them
flat. **If the user prefers nested groups for plan-006**, the change is
mechanical and contained to `src/cli.ts` + `src/commands/composite/index.ts`.

**Subcommand surface**:

| Subcommand | Effect | FR | AC |
|---|---|---|---|
| `composite-synthesize --tool A --tool B [--composite-name id] [--regenerate] [--emit-wrapper] [--register-virtual] [--dry-run] [--force-overwrite]` | Same artifacts as the flag-driven `--treat-as-tool --help` form. | FR-CMP-022 | AC-21 |
| `composite-list` | Tabular listing of registered virtuals (manifest scan). | FR-CMP-022 | AC-22 |
| `composite-show <id>` | Print the cached composite doc. | FR-CMP-022 | AC-22 |
| `composite-delete <id> [--yes]` | Remove manifest + wrapper folder + cached doc + mirror copy + symlink (if any). Confirmation prompt unless `--yes`. | FR-CMP-022 | AC-22 |

**Acceptance criteria (this unit)**:
- AC-21 (subcommand parity with the flag-driven path).
- AC-22 (`composite-list/show/delete` produce expected output and side
  effects).

**Verification**:
```
npx vitest run src/commands/composite/
node dist/cli.js composite-synthesize --tool foo --tool bar --composite-name demo
node dist/cli.js composite-list
node dist/cli.js composite-show demo
node dist/cli.js composite-delete demo --yes
```

---

### Phase 6 unit summary (7 parallel coders)

1. **U-FLAGS** — CLI flag plumbing (`--treat-as-tool` and 9 siblings),
   Commander `helpOption(false)` interception (continued from P4),
   flag-conflict enforcement.
2. **U-SYNTH** — Two-stage synthesis pipeline; on-disk Stage-1 cache;
   token-budget enforcement; dry-run.
3. **U-CACHE** — Provider-agnostic `withSynthesisCache` helper; per-provider
   adapters; `extractCacheUsage` consumer for telemetry.
4. **U-DOC** — Schema-3 doc reader/writer; USER-RECIPES/USER-NOTES
   preservation; mirror to `capabilities/<id>.md`; system-prompt composer
   fallback path.
5. **U-WRAPPER** — POSIX `/bin/sh` shim generator; absolute-path embedding;
   atomic temp+rename; nvm/volta/asdf warning; optional `~/.local/bin`
   symlink.
6. **U-VIRTUAL** — Manifest reader/writer; virtual-tool registry scan;
   dispatcher (child-process default, in-process experimental); recursion
   guard at register + dispatch time.
7. **U-CMD** — Four subcommands (`composite-synthesize`, `composite-list`,
   `composite-show`, `composite-delete`); shared helpers; CLI registration.

If seven parallel coders are not available, the natural pair-up is:
- `(U-FLAGS + U-CMD)` (both touch `src/cli.ts` and the command surface).
- `(U-SYNTH + U-CACHE)` (synthesizer consumes the cache helper directly).
- `(U-DOC)` standalone.
- `(U-WRAPPER + U-VIRTUAL)` (both write under `composites/<id>/`).

This contracts to four effective workstreams.

---

## 6. Decisions Locked at Plan Time (ADRs)

These decisions are made by the planner based on the refined spec, the
investigation, the prompt-caching research, and the shim research. Each has
a rationale and is open to user override. Twelve ADRs are listed; ADR-CMP-1
through ADR-CMP-7 are the spec-locking decisions; ADR-CMP-8 through
ADR-CMP-12 are spec deviations or corrections.

- **ADR-CMP-1 — Pipeline shape**: two-stage (Stage-1 distill + Stage-2
  compose) with Stage-1 outputs cached as addressable per-member artifacts at
  `capabilities/composite/_distill/<member>@<digest>.json`. **Source**:
  refined-spec FR-CMP-006 + investigation Recommendation #1.
- **ADR-CMP-2 — Wrapper shim shebang**: `#!/bin/sh` (NOT `#!/usr/bin/env bash`),
  no `set -euo pipefail`, `exec` for both cat and cli-agent. **Source**:
  shim research §13. **Deviation** from refined-spec FR-CMP-013 wording
  (`#!/usr/bin/env bash`). Rationale: matches npm's battle-tested
  `cmd-shim` reference; eliminates Alpine/no-bash failure mode; the shim
  body uses only POSIX sh constructs.
- **ADR-CMP-3 — `--regenerate-capabilities` is distinct from
  `--refresh-capabilities`**: the two flags are NOT aliases. Without
  `--treat-as-tool`, `--regenerate-capabilities` exits 2 with a guidance
  message pointing to `--refresh-capabilities`. **Source**: investigation
  Q7 / Recommendation #7 (OQ-7). **Deviation** from refined-spec FR-CMP-010
  which implies aliasing. Rationale: silent aliasing is a maintenance
  landmine; the verbs signal intent (introspection vs LLM synthesis).
- **ADR-CMP-4 — Subcommand surface is flat hyphenated**:
  `composite-synthesize`, `composite-list`, `composite-show`,
  `composite-delete`. **Source**: codebase convention (5 existing
  flat-hyphenated subcommands; zero nested groups) + plan-005 ADR-PROF-5
  precedent. **Deviation** from refined-spec FR-CMP-022 wording
  (`cli-agent composite synthesize` reads as nested). Mechanically
  reversible if user prefers nested.
- **ADR-CMP-5 — Virtual-tool dispatch default**: `child-process`;
  `in-process` is opt-in via `composite.virtualDispatch=in-process` AND
  explicitly experimental in v1. **Source**: investigation
  Recommendation #3 (closes OQ-2).
- **ADR-CMP-6 — Schema versioning**: a separate constant
  `COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3` lives in
  `src/agent/composite/cache.ts`. The existing
  `CAPABILITY_SCHEMA_VERSION = 2` in
  `src/agent/capabilities/composeMarkdown.ts` is **NOT** modified. The
  composite reader is a separate function; member-tool docs continue to be
  loaded by the existing reader. The frontmatter value `3` matches the
  spec's external contract (FR-CMP-004) while the constant is module-local.
  **Source**: investigation Recommendation #4; codebase scan §IP-4.
- **ADR-CMP-7 — Cache key composition (overlay digest)**: the cache key is
  exactly the spec's FR-CMP-009 set: `(sortedMembers, memberDigests,
  cliAgentVersion, COMPOSITE_CAPABILITY_SCHEMA_VERSION, compositeName,
  synthesisModel)`. **Overlay digest is NOT included.** The current
  effective overlay digest is recorded in
  `composite_synthesis_start.currentEffectiveOverlayDigests` for v1.1
  instrumentation only. **Source**: investigation Recommendation #5
  (closes OQ-1).
- **ADR-CMP-8 — Older cli-agent version cache policy**: strict mismatch =
  cache miss with stderr notice and `composite_cache_version_mismatch`
  JSONL event. No semver tolerance. **Source**: closes OQ-4.
- **ADR-CMP-9 — Wrapper shim binary path**: absolute path resolved at
  synthesis time. nvm/volta/asdf detection produces a stderr warning
  (non-fatal) at synthesis time. **Source**: shim research §6 (closes OQ-6).
- **ADR-CMP-10 — Synthesis budget knob**: one combined
  `--synthesis-budget-tokens` (default 32 768). No per-stage budgets in v1.
  **Source**: research-prompt-caching Finding 1 (closes OQ-3).
- **ADR-CMP-11 — Test fixture pattern**: folder per scenario under
  `test_scripts/fixtures/synthesis/<name>/` with `inputs.json`,
  `members/*.md`, `transcript.json`, `expected.md`. Recordable via
  `RECORD=1` env var. **Source**: investigation Recommendation #6.
- **ADR-CMP-12 — Composite-doc co-location**: write the canonical doc to
  `capabilities/composite/<id>.md` AND mirror (file copy, NOT symlink) to
  `capabilities/<id>.md` so the existing
  `composeCapabilitiesSystemPrompt` (`compose-system-prompt.ts:99`) finds
  it without code changes. The `composeCapabilitiesSystemPrompt` is also
  extended (U-DOC) to fall back to the `composite/` subdirectory if the
  mirror is absent. **Source**: codebase scan §IP-3 / §Notes.

ADR deviations summary (from refined spec):
- ADR-CMP-2: shim shebang is `#!/bin/sh` not `#!/usr/bin/env bash`.
- ADR-CMP-3: `--regenerate-capabilities` and `--refresh-capabilities` are
  distinct, not aliases.
- ADR-CMP-4: subcommands are flat hyphenated (codebase consistency).

All three deviations are flagged for user confirmation in §0 (OQ-7 covers
ADR-CMP-3 explicitly; OQ-6 covers ADR-CMP-9; the others are stated as
locked planner decisions but reversible).

---

## 7. Edge Case Coverage Matrix (E1..E23)

The refined spec enumerates 23 edge cases. Each is mapped to a phase + unit
and a disposition (test / error / out-of-scope-with-rationale).

| # | Edge case | Phase / Unit | Disposition | Notes |
|---|---|---|---|---|
| E-1 | `--treat-as-tool --help` with empty `--tool` list | P4 + U-FLAGS | Test → `UsageError` exit 2 with FR-CMP-003 message | Asserted in `cli-composite-flags.spec.ts`. |
| E-2 | `--treat-as-tool` alone (no `--help`, no emit/register) | U-FLAGS | Test → byte-identical to normal one-shot run | FR-CMP-001. Asserts `runAgentCommand` is called with same opts (minus the metadata flag). |
| E-3 | `--help` alone (no `--treat-as-tool`) | P4 | Test → snapshot match against pinned baseline | NFR-CMP-001 / AC-1. |
| E-4 | Member binary present but no cached doc | U-SYNTH | Test → discovery runs first, then synthesis | FR-CMP-018 (success path). |
| E-5 | Member binary absent AND no cached doc | U-SYNTH | Test → `ConfigurationError` exit 3 | FR-CMP-018. No silent fallback. |
| E-6 | Cache hit with stub LLM | U-SYNTH | Test → no LLM call; same bytes; exit 0 | AC-4 + NFR-CMP-004. |
| E-7 | `--composite-name` violates regex | U-FLAGS + U-DOC | Test → `UsageError` exit 2 | AC-8. |
| E-8 | `--composite-name` omitted | U-DOC (`derive-name.ts`) | Test → derived `<members>@<hash8>` | AC-9. |
| E-9 | `--composite-name` collision (different member set) | U-VIRTUAL (manifest) | Test → exit 2 unless `--force-overwrite`; idempotent on exact match | AC-16 / FR-CMP-017. |
| E-10 | Composite-of-composite recursion at registration | U-VIRTUAL | Test → exit 2 with FR-CMP-016 message | AC-15. |
| E-11 | Composite-of-composite recursion at dispatch | U-VIRTUAL (`dispatcher.ts`) | Test → exit 2 same message | FR-CMP-016. Child env `CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1` prevents nested. |
| E-12 | `--regenerate-capabilities` without `--treat-as-tool` | U-FLAGS | Test → exit 2 with OQ-7 message | ADR-CMP-3. |
| E-13 | Cache file with corrupt frontmatter | U-DOC | Test → cache miss → re-synth | NFR-CMP-006. |
| E-14 | Cache file missing AUTO-GENERATED markers | U-DOC | Test → cache miss → re-synth | Schema migration path. |
| E-15 | Composite name collides with PATH binary | U-WRAPPER (`--emit-wrapper-on-path`) | Test → stderr warning (non-fatal); shim still emitted | Per shim research §12.2. |
| E-16 | Profile active (model pinned, `tools.allow` non-empty) during `--treat-as-tool --help` | U-SYNTH | Test → uses profile model; ignores `tools.allow/deny/order` for member selection; records `activeProfile` | AC-18 / FR-CMP-019. |
| E-17 | nvm/volta path detected | U-WRAPPER | Test → stderr warning at synthesis time; shim still emitted | OQ-6 / shim research §13. |
| E-18 | Older cli-agent version recorded in cache | U-DOC + P7 | Test → cache miss + stderr notice + `composite_cache_version_mismatch` event | OQ-4 / ADR-CMP-8. |
| E-19 | `--synthesis-budget-tokens` exceeded mid-pipeline | U-SYNTH | Test → exit 2 with consumed/cap | FR-CMP-008. |
| E-20 | `--dry-run-synthesis` writes nothing, calls no LLM | U-SYNTH | Test → stdout has prompts + digests; no fs writes; no LLM stub invocation | AC-14 / FR-CMP-007. |
| E-21 | `--no-emit-doc` with `--treat-as-tool` | U-FLAGS + U-CMD | Test → synthesis runs; doc on stdout only; no file at the cached path | AC-10. |
| E-22 | `composite-delete` removes all artifacts | U-CMD | Test → manifest + wrapper folder + cached doc + mirror copy + symlink (if any) all gone; idempotent on missing | AC-22. |
| E-23 | `in-process` dispatch produces same output as `child-process` | U-VIRTUAL (`dispatcher.spec.ts`) | Test → integration assertion (FR-CMP-015) | Pin both modes; flag in-process as experimental. |

**Acceptance-criterion → phase / unit mapping** (AC-1..AC-27):

| AC | Description | Phase / Unit |
|---|---|---|
| AC-1 | Pinned baseline (cli-agent --help byte-stream unchanged) | P4 |
| AC-2 | `--treat-as-tool --help` synthesis | U-SYNTH + U-DOC |
| AC-3 | Empty member list → exit 2 | P4 + U-FLAGS |
| AC-4 | Cache hit | U-SYNTH + U-DOC |
| AC-5 | Cache miss on member-doc change | U-SYNTH + U-DOC |
| AC-6 | `--regenerate-capabilities` preserves USER blocks | U-DOC |
| AC-7 | `--regenerate-capabilities` without `--treat-as-tool` (= today's `refresh`) | U-FLAGS (per OQ-7 / ADR-CMP-3 — exit 2 with message; AC-7 wording in spec presumes alias; deviation captured) |
| AC-8 | `--composite-name` validation | P5 (`derive-name.ts`) + U-FLAGS |
| AC-9 | Auto-derived composite name | P5 + U-DOC |
| AC-10 | `--emit-doc` default ON; `--no-emit-doc` works | U-FLAGS + U-CMD |
| AC-11 | `--emit-wrapper` produces executable shim | U-WRAPPER |
| AC-12 | `--emit-wrapper-on-path` symlink only on opt-in | U-WRAPPER |
| AC-13 | `--register-virtual` writes manifest; outer agent recognises | U-VIRTUAL |
| AC-14 | `--dry-run-synthesis` no LLM, no cache | U-SYNTH |
| AC-15 | Recursion guard at register | U-VIRTUAL |
| AC-16 | Collision policy (`--force-overwrite`) | U-VIRTUAL |
| AC-17 | Missing constituent → exit 3 | U-SYNTH |
| AC-18 | Profile passthrough | U-SYNTH |
| AC-19 | Outer-agent consumption (3 paths produce coherent prompts) | U-VIRTUAL + U-DOC |
| AC-20 | NFR-CMP-007 coexistence smoke | P8 |
| AC-21 | Subcommand parity | U-CMD |
| AC-22 | `composite-list/show/delete` | U-CMD |
| AC-23 | Logging events present | P7 |
| AC-24 | File modes | U-WRAPPER + U-VIRTUAL + U-DOC |
| AC-25 | Schema migration | U-DOC |
| AC-26 | No PATH pollution by default | U-WRAPPER |
| AC-27 | Documentation registration | P9 |

NFR-CMP-001..007 mapping: NFR-001 → P4; NFR-002 → P8 (deterministic stub
fixtures); NFR-003 → P8 smoke; NFR-004 → P8 smoke; NFR-005 → all
artifact-emitting units (U-WRAPPER, U-VIRTUAL, U-DOC); NFR-006 → U-DOC;
NFR-007 → P8 coexistence smoke.

---

## 8. Risks & Mitigations (cross-phase)

| # | Risk | Mitigation |
|---|---|---|
| R-1 | Commander `helpOption(false)` migration drifts `--help` byte stream | P4 pins the baseline BEFORE the change; the regression test diffs against the pinned snapshot on every CI run. AC-1 / NFR-CMP-001. |
| R-2 | `composeCapabilitiesSystemPrompt` does not find composite docs | ADR-CMP-12: write to `capabilities/composite/<id>.md` AND mirror-copy to `capabilities/<id>.md`. Fallback in U-DOC reader catches the non-mirrored case. |
| R-3 | LangGraph subgraph re-entry corrupts state in `in-process` dispatch | Default is `child-process` (ADR-CMP-5). `in-process` is explicitly experimental; FR-CMP-015 integration test pins observable equivalence. |
| R-4 | Stage-1 cache pollution across model changes | Cache key includes `cfg.model` + `STAGE1_TEMPLATE_VERSION`. Switching model invalidates Stage-1 cache automatically. |
| R-5 | Token budget overrun produces partial cache writes | Stage-1 cache writes happen per-member as soon as the call completes; Stage-2 budget enforcement happens after Stage-1 (so Stage-1 cache writes are durable). Stage-2 overrun causes synthesis abort with no Stage-2 doc written, but Stage-1 cache writes are kept (they will be reused on the next attempt). Unit-tested. |
| R-6 | Prompt-cache annotations cause errors on non-supporting providers | `withSynthesisCache` is a no-op for non-Anthropic providers; the `litellm-anthropic` path injects markers that LiteLLM translates. The Vertex AI bug (research §"LiteLLM Pitfalls") is documented; v1 does not target Vertex AI. |
| R-7 | nvm/volta path captured as cliAgentBinPath becomes stale | OQ-6 / ADR-CMP-9: warn at synthesis time. Cross-machine portability is already deferred. |
| R-8 | `composite-name` collision races between two parallel `--register-virtual` runs | Manifest write is atomic temp+rename; the **read-then-write** sequence is wrapped in a lock-via-O_EXCL on `composites/<id>/.lock` (advisory). On contention, exit 1 with a "concurrent registration in progress" message. Out of v1 scope to fully solve; documented as a known limitation. |
| R-9 | Recursion guard bypass via direct `cli-agent --tool <virtual-id>` from a non-cli-agent caller | The child-process child receives `CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1` so its `loadVirtualTools` returns `[]`. Direct invocation by a third-party tool is out of v1 scope (only cli-agent consumes the registry). |
| R-10 | Mirror-copy in `capabilities/<id>.md` becomes stale after manual edits | The mirror-copy is documented as derived; users should not edit it. `composite-delete` removes both. A future v1.1 audit could check mtime parity. |
| R-11 | Provider-side prompt caching disabled silently when prefix < 1024 tokens | `extractCacheUsage` returns `0` for `cacheCreationTokens`; `composite_synthesis_stage` event records the zero, so JSONL surfaces the issue in production logs. Static synthesis system prompt is sized ≥ 1024 tokens at template-design time. |
| R-12 | Seven parallel coders create merge conflicts on `src/cli.ts` | P5 lands the entry-point scaffolding; P6 unit U-FLAGS owns lines 49–93 (default-command options); U-CMD owns the new `program.command(…)` registrations (different file region). Pre-decided line ownership reduces conflict to zero. The same applies to `src/agent/tools/registry.ts:84` — only U-VIRTUAL touches it. |
| R-13 | Schema-3 frontmatter parser drift between writer and reader | Both routes go through one canonicalisation function in `composeCompositeDoc.ts`; spec test asserts round-trip stability. |
| R-14 | `--treat-as-tool` interaction with `--resume` (TUI exit/resume) | The two flags are mutually orthogonal (TUI-only vs CLI-only). `--treat-as-tool --resume` produces a `UsageError` exit 2 with message `--treat-as-tool is incompatible with --resume`. Asserted in U-FLAGS. |

---

## 9. Coexistence with plan-005 (profiles, overlays, recipes, TUI exit/resume)

Spelled out explicitly to satisfy FR-CMP-019 + FR-CMP-020 + the v1 coexistence
smoke (NFR-CMP-007 / AC-20).

| Concern | Profiles (plan-005-config-profiles) | Overlays (plan-004) | Capability recipes / manRef (plan-005-capability-recipes-and-manref) | TUI exit/resume (plan-005-tui-exit-and-resume) |
|---|---|---|---|---|
| Composite synthesis input | `cliParams.{provider,model,...}` flow through `loadAgentConfig` → `cfg`; `createLLM(cfg)` honours profile model. `tools.allow/deny/order` is **NOT** consulted for member selection. `toolArgs` is **NOT** embedded in the synthesised doc. | Member-tool overlays NOT in cache key (OQ-1). Overlay digest is captured in JSONL telemetry only. | Member doc bytes (excluding USER-* blocks) feed Stage-1. Composite doc has `manRef: null` always (per spec A-10). | No interaction. |
| Composite synthesis output | `frontmatter.activeProfile = <name \| null>` for traceability. | Not affected. | Composite USER-RECIPES pre-filled by Stage-2; preserved across `--regenerate-capabilities` (FR-CMP-010). | No interaction. |
| Outer-agent consumption | Profile scoping applies to virtual tools (loaded by `loadVirtualTools` → injected into `assembled` BEFORE `applyProfileToolScoping`). | Composite doc is NOT subject to overlays (composites have no overlay file). The composite's USER-RECIPES section is the only user-editable surface. | `composeCapabilitiesSystemPrompt` reads the mirror copy at `capabilities/<id>.md` like any other capability doc; USER-RECIPES embeds within per-tool byte budget; synopsis falls back when over budget (FR-CMP-020). | No interaction. |
| Bootstraps | `profiles/` dir | `tool-prompts/` dir | (additive frontmatter — no new bootstrap) | snapshot dir |
| New bootstrap dirs | (none — composite plan owns) | (none) | (none) | (none) |
| Test smoke (NFR-CMP-007) | Profile active during synthesis → confirms `cfg.model` honoured | Tool-prompt overlay applied to a member → confirms overlay does NOT affect synthesis | Member has USER-RECIPES → confirms member doc digest excludes the block | NOT covered (orthogonal) |

The composite plan does **not** modify the overlay loader, the profile loader,
the recipe extractor, or the TUI exit/resume snapshot store. The only existing
read site touched is `compose-system-prompt.ts:99` (extended with a
`composite/` fallback in U-DOC).

---

## 10. Verification Commands (executable)

After each phase, run:

```bash
# All phases
npm run build
npx tsc --noEmit -p tsconfig.json
npx vitest run

# Phase-specific
npx vitest run src/config/agent-config.spec.ts                       # P3 + P5 bootstrap + tier-aware
npx vitest run src/cli.spec.ts                                       # P4 helpOption(false) regression
diff <(node dist/cli.js --help) test_scripts/baselines/help-no-treat-as-tool.txt   # P4 baseline pin
npx vitest run src/agent/composite/cache.spec.ts                     # P5 / U-DOC
npx vitest run src/agent/composite/composeCompositeDoc.spec.ts       # P5 / U-DOC
npx vitest run src/commands/composite/derive-name.spec.ts            # P5
npx vitest run src/cli-composite-flags.spec.ts                       # P6 / U-FLAGS
npx vitest run src/agent/composite/synthesizer.spec.ts               # P6 / U-SYNTH
npx vitest run src/agent/composite/stage1.spec.ts                    # P6 / U-SYNTH
npx vitest run src/agent/composite/stage2.spec.ts                    # P6 / U-SYNTH
npx vitest run src/agent/composite/llm-cache.spec.ts                 # P6 / U-CACHE
npx vitest run src/agent/composite/shim-writer.spec.ts               # P6 / U-WRAPPER
npx vitest run src/agent/composite/manifest.spec.ts                  # P6 / U-VIRTUAL
npx vitest run src/agent/composite/virtual-registry.spec.ts          # P6 / U-VIRTUAL
npx vitest run src/agent/composite/dispatcher.spec.ts                # P6 / U-VIRTUAL
npx vitest run src/agent/tools/registry.spec.ts                      # U-VIRTUAL integration
npx vitest run src/commands/composite/                               # P6 / U-CMD
npx vitest run src/agent/logging.spec.ts                             # P7

# Smoke / e2e
node test_scripts/shim-e2e.ts                                        # U-WRAPPER
node test_scripts/smoke-cache-hit-cost.ts                            # NFR-CMP-004 (≤ 500 ms)
node test_scripts/smoke-synthesis-latency.ts                         # NFR-CMP-003 (≤ 30 s, stub)
node test_scripts/smoke-coexistence-end-to-end.ts                    # NFR-CMP-007 / AC-20

# Live CLI smoke (requires real binaries on PATH or stub LLM env)
CLI_AGENT_STUB_LLM=1 node dist/cli.js --tool foo --tool bar --treat-as-tool --help
CLI_AGENT_STUB_LLM=1 node dist/cli.js composite-synthesize --tool foo --tool bar --composite-name demo --emit-wrapper --register-virtual
node dist/cli.js composite-list
node dist/cli.js composite-show demo
node dist/cli.js composite-delete demo --yes

# Fixture re-record (developer-only; manual)
RECORD=1 npx vitest run --include "test_scripts/fixtures/synthesis"
```

A passing run: zero `tsc` errors, zero `vitest` failures, all smokes within
their performance budgets, baseline `--help` snapshot byte-identical, and the
coexistence smoke produces the expected three system prompts.

---

## 11. Issues Pending Tracker (for `Issues - Pending Items.md`)

The planner does NOT modify `Issues - Pending Items.md` directly. Items below
are surfaced for the user/maintainer to add. They are listed in priority
order:

1. **OQ-7 confirmation**: keep `--regenerate-capabilities` distinct from
   `--refresh-capabilities`? Recommendation: yes (ADR-CMP-3). **Awaiting
   user ack** — this is the largest user-visible deviation from the refined
   spec.
2. **OQ-6 confirmation**: embed absolute resolved cli-agent path in the
   shim (with nvm/volta/asdf warning)? Recommendation: yes (ADR-CMP-9).
3. **NFR-CMP-001 baseline measurement**: capture
   `cli-agent --help` byte-stream snapshot BEFORE the
   `helpOption(false)` migration in P4 so AC-1 has a concrete reference.
   Required pre-merge for the P4 PR.
4. **NFR-CMP-004 baseline**: measure cache-hit cost on the standard test
   machine (process boot → stdout flushed → exit 0). Required to calibrate
   the smoke script's pass threshold.
5. **OQ-1 instrumentation review**: review the
   `composite_synthesis_start.currentEffectiveOverlayDigests` JSONL field
   after 30 days of production telemetry. If users frequently run
   `--regenerate-capabilities` after overlay edits, propose a v1.1 plan to
   include overlay digest in the cache key.
6. **OQ-3 instrumentation review**: review per-stage token-cost
   distributions (Stage-1 vs Stage-2) after 30 days. If Stage-1 dominates
   on small composites or Stage-2 dominates on large composites, propose
   per-stage budget knobs in v1.1.
7. **Optional follow-up plan-007**: composite-of-composite recursion
   (FR-CMP-016 explicitly rejects in v1). Capture as plan-007 if user
   confirms demand.
8. **Optional follow-up plan-008**: cross-machine sync of composites
   (portable archive, registry publishing, signing). Out of v1 scope per
   refined-spec §"Out of scope" §2.
9. **Optional follow-up plan-009**: TUI slash commands
   (`/composite-create`, `/composite-show`, `/composite-list`,
   `/composite-delete`). Out of v1 scope per refined-spec §"Out of scope".
10. **Optional follow-up plan-010**: programmatic secret-redaction filter
    on synthesised recipes (post-LLM regex pass). Out of v1 scope.
11. **`--emit-wrapper-on-path` collision check**: a more robust
    reserved-binary-name check (against `which <name>` + curated
    blocklist). v1 emits a warning only; v1.1 may upgrade to a hard
    error.
12. **Audit hook**: extend `audit-tool-prompts` (or a new
    `audit-composites`) to detect stale composites whose
    `cliAgentVersion` is older than the running cli-agent. Tracked but
    not in v1.

---

## 12. Sign-off

This plan replaces no prior plan. It coexists with plan-004 (overlays),
plan-005-config-profiles (profiles), plan-005-capability-recipes-and-manref
(USER-RECIPES contract on member docs — re-used by composite docs),
plan-005-tui-exit-and-resume (orthogonal). Implementation may proceed once
OQ-1..7 are acknowledged or overridden by the user. Phase 6's parallel split
(7 units) is the recommended dispatch for parallel coders; the natural
4-workstream pair-up is documented in §5 for smaller teams.

The architectural deviations from the refined spec — ADR-CMP-2 (shim
shebang), ADR-CMP-3 (regenerate vs refresh distinct), ADR-CMP-4 (flat
hyphenated subcommands) — are grounded in observable codebase convention,
external prior art (npm `cmd-shim`), and investigation evidence. All three
are mechanically reversible if the user prefers the original spec wording.
