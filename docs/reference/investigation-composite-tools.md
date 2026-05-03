---
investigation: composite-intelligent-tools
related_request: docs/design/refined-request-composite-tools.md
related_scan: docs/reference/codebase-scan-composite-tools.md
created_at: "2026-05-02"
---

# Investigation: Composite Intelligent Tools — Design Decisions

## Executive Summary

This investigation resolves seven open design questions for the composite-intelligent-tools feature ahead of the planning phase. The recommendations are:

1. **Synthesis pipeline** — adopt the **two-stage** topology (per-member distill → compose) the spec already hints at, but make Stage 1 outputs *individually addressable cache entries* keyed by `(member-doc-digest, distill-prompt-template-version, model-id)`. This delivers the cross-tool recipe quality of single-prompt composition while permitting fine-grained re-use when one member changes. Three stages add cost without measurable quality gain on a 2–5 member surface.
2. **Wrapper script format** — emit a **POSIX shell shim** (no Node.js shim, no `node $(which cli-agent)` form). Mirrors how `npm`/`pnpm` already ship POSIX shims via `cmd-shim`; portable across macOS/Linux; zero startup overhead; `--help` is trivially handled with a `case` statement that `cat`s the cached doc.
3. **Virtual-tool dispatch (FR-CMP-015 / O-2)** — keep the spec's defaulted **`child-process`** for v1 with **`in-process` opt-in and explicitly experimental**. LangGraph subgraph re-entry has documented state-pollution and parallel-call failure modes (Issue #3020) that disqualify in-process as the safe default. The Hybrid `--isolate` flag is unnecessary — `composite.virtualDispatch` already provides the toggle.
4. **Schema-3 versioning** — introduce a **separate constant `COMPOSITE_CAPABILITY_SCHEMA_VERSION = 1`** in the new `src/agent/composite/` module and **leave `CAPABILITY_SCHEMA_VERSION = 2` untouched**. Discovery-doc cache stays valid; the composite reader is a separate function, so dual-read is automatic. (Codebase scan finding §IP-4 explicitly supports this.)
5. **Cache key composition (O-1)** — **do NOT include overlay digest in v1**. Rationale: overlays modify the *prompt-time* tool description, not the underlying capability doc that synthesis consumes. Including overlays would force re-synthesis on cosmetic prompt edits. Document this as the v1 contract, expose `--regenerate-capabilities` for manual control, and revisit in v1.1 with a measured user-pain signal.
6. **Stub-LLM testing pattern** — adopt the keyed-dispatcher fixture pattern the codebase scan already prototyped. Fixtures live under **`test_scripts/fixtures/synthesis/<scenario>/`**, one folder per scenario, containing `inputs.json` (member docs + cli-agent-version + composite-name), `transcript.json` (`{ promptDigest: cannedResponse }`), and `expected.md` (golden composite doc).
7. **`--regenerate-capabilities` UX** — keep the **flag overload** the spec already proposes (passes when `--treat-as-tool` is in effect → composite re-synthesis; otherwise → existing member-tool refresh path). Add the **`composite synthesize --regenerate`** subcommand sibling for CI scripts. Do **not** add a separate `composite regenerate` subcommand — it duplicates `synthesize --regenerate`.

The full justifications, comparison matrices, and implementation guidance follow. The Technical Research Guidance section flags two topics that warrant deeper research before plan-006 implementation can begin: (a) provider-side prompt-caching wire format for the chosen LLM provider stack, and (b) reference implementation of POSIX bin shims (`cmd-shim` source).

## Context

**Feature**: "Composite Intelligent Tools" — package a curated `cli-agent --tool A --tool B …` invocation as a new tool that another cli-agent can wrap with a single `--tool <composite-id>`.

**Inputs**:
- `docs/design/refined-request-composite-tools.md` — 22 functional requirements (FR-CMP-001..023), 7 NFRs, 27 acceptance criteria, the `--treat-as-tool` flag matrix, three distribution forms (a) doc, (b) wrapper shim, (c) virtual registry.
- `docs/reference/codebase-scan-composite-tools.md` — 11 integration points, the Commander `helpOption(false)` requirement, schema-version bump strategy, LLM stub pattern at the `createLLM` factory boundary, composite doc co-location options.

**Constraints driving evaluation**:
- **No silent fallbacks** (CLAUDE.md rule, restated in FR-CMP constraints).
- **Backwards compatibility** — schema-2 docs and the existing `--help` byte stream must remain unchanged when `--treat-as-tool` is absent (NFR-CMP-001).
- **TypeScript / ESM** with `.js` extensions on local imports.
- **One LLM provider** — synthesizer reuses the resolved `cfg`. No alternate auth path.
- **File-mode invariants** — `0700` dirs, `0600` docs/manifests, `0700` shims.
- **JSONL logging** with existing redaction.

## Question 1 — Synthesis Prompt Pipeline (1 vs 2 vs 3 stages)

### Options Identified

#### Option 1A — Single-Stage Combined Prompt
- **Description**: One LLM call with a meta-prompt that interleaves all member capability docs and asks for the composite doc + recipes in one shot.
- **Strengths**: Simplest; one prompt template; lowest latency on cold runs; richest cross-tool reasoning context inside a single attention pass.
- **Weaknesses**: Token blow-up on 3+ member docs (a 32 KB doc × 3 ≈ 24K tokens just for context); no intermediate caching — adding/removing one member forces full re-run; no failure isolation — a transient model error wastes the whole call; large prompts are *prefix-unstable* with respect to per-member changes, so provider-side prompt caching can't be exploited well past the static system block.
- **Effort/Complexity**: Low.
- **Risk**: Medium-High (cost scales linearly with member count × per-member doc size).
- **Best suited when**: ≤ 2 members, all docs ≤ 8 KB, latency-critical.

#### Option 1B — Two-Stage Distill-Then-Compose (RECOMMENDED)
- **Description**: Stage 1 (parallelisable): per-member distillation — for each member, an LLM call produces a structured "intent surface" (top intents, parameter glossary, illustrative examples) at ≤ ~2 KB. Stage 2: compose the array of stage-1 outputs + a curated cross-tool-recipes prompt into the final composite doc.
- **Strengths**: Stage-1 outputs are stable per-member artifacts ⇒ cache them by `(member-doc-digest, distill-template-version, model-id)`; adding/removing one member only re-runs Stage 2 + one Stage-1; Stage-1 is embarrassingly parallel; failure isolation — a Stage-2 retry can reuse Stage-1 results; smaller per-call token footprint helps stay inside the `--synthesis-budget-tokens` cap; Stage-1 can use a smaller/cheaper model in v1.1 without breaking Stage-2 contract; matches LangGraph's "distill early, compose late" guidance for production multi-stage pipelines (see Sources §1).
- **Weaknesses**: Two prompt templates to maintain instead of one; Stage-2 sees compressed intent surfaces, not raw docs — quality of cross-tool recipes depends on Stage-1 prompt quality; small overhead on a fully-cold 2-member run (2 round-trips vs 1).
- **Effort/Complexity**: Medium.
- **Risk**: Low (failure modes are bounded to one stage).
- **Best suited when**: 2–10 members, member docs of varying sizes, repeated synthesis across tweaks.

#### Option 1C — Three-Stage (Distill + Recipes-Extract + Compose)
- **Description**: Stage 1 distill per member; Stage 2 generates a candidate cross-tool-recipes set from the stage-1 outputs alone (no body); Stage 3 composes the AUTO-GENERATED body and embeds the recipes.
- **Strengths**: Recipes become a separately addressable artifact (testable, swappable); aligns with the existing `extract-recipes` mental model.
- **Weaknesses**: 50% more LLM calls than 1B with no measurable quality lift on 2–5 member surfaces (the recipe-extraction step's input is *already* the distilled intent surfaces — splitting the composition adds latency without new information); higher chance of inter-stage drift (Stage-3 may produce recipes that contradict Stage-2's set unless we enforce one as authoritative); harder cache-key story (three artifact classes).
- **Effort/Complexity**: High.
- **Risk**: Medium (drift between Stage-2 and Stage-3 is real; mitigations add complexity).
- **Best suited when**: > 10 members, or when recipe generation needs human-in-the-loop review separately from body composition (out of scope for v1).

### Comparison Matrix

| Criterion                                  | 1A One-shot       | 1B Two-stage       | 1C Three-stage   |
|--------------------------------------------|-------------------|--------------------|------------------|
| Cross-tool recipe quality (2–5 members)    | High              | High               | High             |
| Token cost (cold, 2 members)               | Low               | Low-Medium         | Medium           |
| Token cost (cold, 5 members)               | High              | Medium             | Medium-High      |
| Cost on add/remove one member              | Full re-run       | 1 distill + compose| 1 distill + 2 stages |
| Failure isolation                          | None              | Per-stage retry    | Per-stage retry  |
| Caching granularity (intermediate)         | Provider KV only  | Per-member distill | Per-member + recipes |
| Implementation complexity                  | Low               | Medium             | High             |
| Prompt-template count                      | 1                 | 2                  | 3                |
| Spec alignment (FR-CMP-006 says two-stage) | Drift             | Match              | Drift            |

### Recommendation: Option 1B (Two-Stage), spec-aligned, with intermediate caching

The spec already mandates two stages (FR-CMP-006). The investigation question was whether to *deviate*. The evidence does not justify deviation:

- One-stage (1A) sacrifices the caching granularity that is the strongest cost-reduction lever for an iterative workflow (the user is expected to tweak member sets and re-synthesize). The "Distill early, compose late — turn raw inputs into small, stable intermediate artifacts that themselves become cacheable prefixes for downstream stages" guidance from production LLM-pipeline reports (Sources §1) explicitly favours 1B for iterative use.
- Three-stage (1C) splits work that the LLM does well in a single pass once distillation has compressed the inputs. The recipe-extraction step has no input that the compose step doesn't also have — it's a layer of indirection without information gain.

**Concrete addition to the spec**: cache Stage-1 outputs at `~/.tool-agents/cli-agent/capabilities/composite/_distill/<member-name>@<doc-digest>.json` with mode `0600`. Cache key: `sha256(member-doc-canonical-bytes || distill-template-version || synthesis-model-id)`. This is a *new* artifact class on disk; document it in plan-006 §on-disk-layout.

Prior art: LangChain's documented best practice for multi-stage pipelines is to make intermediate artifacts addressable for traceability and reuse (Sources §1, §3). The provider-side prompt-cache layer (Anthropic, OpenAI) is *prefix-only* and orthogonal to this on-disk cache — both should coexist (Sources §1).

## Question 2 — Wrapper Script Format

### Options Identified

#### Option 2A — POSIX Shell Shim (RECOMMENDED)
- **Description**: `#!/usr/bin/env bash` script that on `--help` `cat`s the cached doc, otherwise `exec`s `cli-agent --tool m1 --tool m2 … "$@"`.
- **Strengths**: Zero startup latency (no Node boot before the real `cli-agent`); portable across macOS / Linux / WSL (the same pattern `npm` and `pnpm` ship to Windows alongside `.cmd`/`.ps1` for cross-shell compatibility — Sources §2); a 20-line script is auditable; trivial `--help` interception via `case "$1" in --help|-h) cat "$DOC"; exit 0 ;; esac`; no dependency on Node being on PATH at shim-emit time (only at run time, which is required regardless because the shim execs `cli-agent`).
- **Weaknesses**: Bash only (not POSIX-strict-`sh`); on systems without `/usr/bin/env bash` (rare on macOS/Linux but possible on Alpine without `bash` installed), the shim fails. Mitigation: document a fallback to `#!/bin/sh` + a portable subset if a future user reports it. Out of v1 scope.
- **Effort/Complexity**: Low.
- **Risk**: Low.

#### Option 2B — Node.js Shim with Shebang
- **Description**: `#!/usr/bin/env node` script that imports cli-agent and re-enters its main.
- **Strengths**: Cross-platform (works on Windows out of the box if `node` is installed); identical handling of arg parsing.
- **Weaknesses**: 100–300 ms Node startup penalty per invocation just to re-fork into Node; defeats NFR-CMP-004's "cache hit < 500 ms" budget margin; depends on resolving cli-agent as a require'able module (not just a CLI on PATH) — couples shim to install layout; a `--help` interception path needs a real Node program, not a one-liner — adds maintenance surface.
- **Effort/Complexity**: Medium.
- **Risk**: Medium (startup latency erodes NFR margin; install-layout coupling is fragile).

#### Option 2C — `node $(which cli-agent) --tool A …` Form
- **Description**: A trivial wrapper that explicitly invokes Node on the cli-agent script.
- **Strengths**: No reliance on the shebang of `cli-agent` being executable.
- **Weaknesses**: Pays the Node startup penalty *twice* (once for the shim's Node process, once because `cli-agent`'s shebang already runs Node). Uses `which`, which is non-portable (some systems use `command -v`). If the shim is itself a shell script, this collapses into 2A; if Node, into 2B — there is no genuine third option here.
- **Effort/Complexity**: Low.
- **Risk**: High (startup cost compounds; non-portable).

### Comparison Matrix

| Criterion                                | 2A POSIX shell    | 2B Node shim      | 2C `node which`  |
|------------------------------------------|-------------------|-------------------|------------------|
| Startup latency                          | ~5 ms             | ~150 ms           | ~250 ms (2× boot)|
| Portability (macOS / Linux)              | High              | High              | Medium           |
| `--help` flow simplicity                 | One-liner         | Real program      | Real program     |
| Coupling to install layout               | None              | Requires require()| None             |
| Mirrors npm/pnpm prior art               | Yes               | No                | No               |
| File size                                | ~30 lines         | ~50 lines         | ~30 lines        |
| Audit / read-time clarity                | High              | Medium            | Medium           |
| NFR-CMP-004 (< 500 ms) margin            | Comfortable       | Tight             | Risk of breach   |

### Recommendation: Option 2A (POSIX shell shim)

This is exactly the form the spec's FR-CMP-013 already prescribes ("`#!/usr/bin/env bash`"); the question was whether to deviate. Evidence is strongly in favour of staying with the shell form:

- **Prior art is unambiguous**: `npm`'s `cmd-shim` writes a POSIX `sh` wrapper for non-Windows targets that does exactly this pattern — locate self, normalize path, `exec` the real binary (Sources §2).
- **NFR-CMP-004 budget**: a 500 ms cold cache-hit budget evaporates if we add a Node boot to the shim. POSIX shell adds ~5 ms; Node adds ~150 ms.
- **Auditability matters**: the shim is written into `~/.tool-agents/cli-agent/composites/<id>/<id>` at mode `0700`. Users will inspect it — a 20-line bash script is reviewable; a Node program is not.

Concrete shim template (to include verbatim in plan-006):

```bash
#!/usr/bin/env bash
# cli-agent composite wrapper for "<id>"
# Generated at <synthesizedAt>; do not hand-edit (re-run cli-agent --treat-as-tool --regenerate-capabilities --composite-name <id>).
set -euo pipefail
: "${LANG:=C.UTF-8}"
export LANG
DOC="<absolute path to capabilities/composite/<id>.md>"
case "${1:-}" in
  --help|-h)
    if [ ! -r "$DOC" ]; then
      echo "composite cache stale; re-run cli-agent --treat-as-tool --regenerate-capabilities --composite-name <id>" >&2
      exit 6
    fi
    exec cat "$DOC"
    ;;
esac
exec cli-agent --tool <m1> --tool <m2> "$@"
```

Note: the spec already specifies exit 6 for the cache-missing case (FR-CMP-013 #4) — keep that.

## Question 3 — Virtual-Tool Dispatch Mode (Open Question O-2)

### Options Identified

#### Option 3A — In-Process Re-Entry (default)
- **Description**: Outer cli-agent's meta-tool handler re-enters its own `runAgentCommand`/`runOneShotAgent` with the recorded member tool list. Same Node process; fresh per-call agent state.
- **Strengths**: Sub-millisecond dispatch overhead; no process boot cost; shared LLM connection pool / token cache; in-memory provider client warm.
- **Weaknesses**:
  - **State pollution risk**: LangGraph's documented behavior is that subgraph re-entry can flush state unexpectedly (Issue #3020 — "subgraph forgets its state of the first run when it is invoked the second time in a parent graph"). The cli-agent codebase uses `buildAgentGraph` per run; re-entering it inside an existing run would put two graph instances in the same process, sharing module-level state where it exists.
  - **Parallel-call hazard**: if the outer LLM does parallel tool calls (a common optimization in 2025+ tool-calling models), in-process re-entry would race on shared state (logger handles, provider clients, capability cache). LangGraph documentation explicitly notes "per-thread subgraphs do not support parallel tool calls" without explicit guards (Sources §3).
  - **Memory bleed**: a misbehaving inner agent (infinite loop, memory leak) can crash the outer process.
  - **Recursion guard at runtime**: catching composite-of-composite at dispatch needs an in-process registry consultation; one extra hop.
- **Effort/Complexity**: Medium-High (state isolation needs explicit attention).
- **Risk**: High in v1 (untested code path; race conditions hard to reproduce in CI).

#### Option 3B — Subprocess Dispatch (RECOMMENDED, spec default)
- **Description**: Outer cli-agent spawns a child cli-agent (`child_process.spawn` or `execa`) with the recorded `--tool` list and forwards stdin/stdout/stderr. The child is a fresh Node process with hermetic state.
- **Strengths**:
  - **Hermetic isolation** by OS-level boundary; no shared process state.
  - **Crash isolation** — child process death does not affect outer agent.
  - **Concurrency-safe** — N parallel calls from the outer LLM = N independent child processes.
  - **Trivial recursion guard** — pass `--no-virtual-recursion` to child; child sees no virtual tools when it builds its registry.
  - **Same code path as the wrapper-shim form (b)** — production-tested by the (b) path; reduces total surface area to test.
- **Weaknesses**:
  - **Per-call process boot**: ~150–300 ms Node startup + cli-agent bootstrap. Acceptable for tool-call latency; users will run a composite at most a few times per outer-agent turn.
  - **Cost on chatty interactions**: not an issue for the v1 use case where composites are *high-fan-in tools* invoked sparingly per outer turn.
- **Effort/Complexity**: Low (uses existing CLI surface — the child is just `cli-agent --tool m1 --tool m2 …`).
- **Risk**: Low.

#### Option 3C — Hybrid (in-process by default; subprocess on `--isolate`)
- **Description**: Default to in-process for speed; user opts into subprocess via flag.
- **Strengths**: Theoretical best of both.
- **Weaknesses**:
  - **Two code paths to maintain** in v1, both with their own bugs.
  - **Default is the risky one** — users hit failure modes before they discover the flag.
  - **The spec's `composite.virtualDispatch` knob already provides this toggle** with the *opposite* default (subprocess default, in-process opt-in) — adding a CLI flag at the call site duplicates the mechanism.
- **Effort/Complexity**: High.
- **Risk**: High (default risky path; duplicate toggle).

### Comparison Matrix

| Criterion                              | 3A In-process | 3B Subprocess | 3C Hybrid (in-default) |
|----------------------------------------|---------------|---------------|------------------------|
| Dispatch overhead                      | < 1 ms        | 150–300 ms    | < 1 ms (default)       |
| State isolation                        | None (manual) | OS boundary   | None (default)         |
| Parallel-call safety                   | Risky         | Safe          | Risky (default)        |
| Crash isolation                        | None          | Full          | None (default)         |
| Recursion-guard simplicity             | Medium        | Trivial       | Medium                 |
| Implementation complexity              | High          | Low           | High (two paths)       |
| LangGraph-known-issue exposure (#3020) | Yes           | No            | Yes (default)          |
| v1 risk profile                        | High          | Low           | High                   |

### Recommendation: Option 3B (Subprocess) as default, in-process opt-in (matches spec FR-CMP-015)

This is the spec's currently-stated default; the investigation question (O-2) was whether to revisit. Evidence reinforces the spec:

- LangGraph's own documentation and a tracked issue (#3020) call out re-entry/state-pollution problems in subgraph nesting (Sources §3). The cli-agent agent-graph builder is not battle-tested for nested re-entry.
- The "tool-mental-model" principle (the spec's O-2 resolution rationale) — that a tool call is observably stateless to the caller — is naturally enforced by an OS process boundary.
- The cost of subprocess dispatch is bounded (a single Node boot per call). The cost of in-process bugs is unbounded (silent state corruption, parallel-call races).

**Concrete plan-006 implications**:
- `src/agent/composite/dispatcher.ts` exposes `dispatchComposite(manifest, args, mode)` returning a `Promise<DispatchResult>`. `mode === 'child-process'` is the production path; `mode === 'in-process'` is gated behind a runtime warning and an integration test that pins both modes' output equivalence (FR-CMP-015 already requires this).
- Pass an explicit env var `CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1` to the child process so the child's `loadVirtualTools` returns `[]` and recursion is structurally impossible.

## Question 4 — Schema-3 Versioning Strategy

### Options Identified

#### Option 4A — Bump `CAPABILITY_SCHEMA_VERSION = 3` Globally
- **Description**: Increment the existing constant; all member-tool capability docs would also need to be migrated to 3 (or `SUPPORTED_SCHEMA_VERSION` would have to accept ∈ {2, 3}).
- **Strengths**: Single source of truth for "the current capability schema".
- **Weaknesses**:
  - **Mass cache miss**: bumping the global constant invalidates every existing member-tool cache entry. Users would be forced to re-discover all wrapped tools. This is a regression on first install of the new version.
  - **Conceptual mismatch**: schema-3 fields (`composite`, `members`, `synthesizedAt`, `syntheticDigest`, `compositeName`) are *only* meaningful for composite docs; bumping the version on member-tool docs is a lie about the data shape.
  - Codebase scan §IP-4 explicitly warns against this: "Schema 3 should be declared as `COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3` in a new module (not by bumping the existing constant) to avoid invalidating all existing member-tool cache entries."

#### Option 4B — Separate Constant for Composite Docs Only (RECOMMENDED)
- **Description**: Introduce `COMPOSITE_CAPABILITY_SCHEMA_VERSION = 1` (yes, *1* — it's a new schema lineage for composite docs, not a continuation) in `src/agent/composite/cache.ts`. Member-tool docs stay on `CAPABILITY_SCHEMA_VERSION = 2` (no change). The composite reader is a new function that knows about its own schema; the existing reader is untouched.
- **Strengths**:
  - **Zero impact on existing caches**.
  - **Conceptually clean**: two document types, two schema lineages. Aligns with industry pattern of "per-document-type version constants in a schema registry" (Sources §4).
  - **Forward compatibility**: if member-tool schema bumps to 3 later, composite schema can independently bump to 2.
  - **Codebase scan §IP-4 confirms** the existing `composeCapabilitiesSystemPrompt` has *no schema-version check at all* — it reads markers, not frontmatter — so an outer agent consuming a composite doc with `schemaVersion: 1` (composite-lineage) inside `capabilities/composite/<id>.md` works transparently.
- **Weaknesses**: Two constants to track; a future contributor must understand the lineage split. Mitigation: docstring on each constant pointing at the other.

#### Option 4C — `schemaVersion` Stays Numeric, Frontmatter Adds `docType: composite | member`
- **Description**: Use the same version number space, distinguish by a sibling field.
- **Strengths**: Single namespace.
- **Weaknesses**: Adds a new required-to-read field to *member* docs; existing schema-2 docs lack `docType`, so the reader needs default-value logic, which violates the project's no-fallback config rule when applied to data structures. Re-introduces the "mass cache miss on existing docs" if `docType` is required.
- **Risk**: Medium-High (adds a coupled field across both lineages).

### Comparison Matrix

| Criterion                              | 4A Bump global | 4B Separate constant | 4C docType field |
|----------------------------------------|----------------|---------------------|------------------|
| Existing cache impact                  | All invalidated| None                | All need migration|
| Conceptual clarity                     | Low            | High                | Medium           |
| Future schema-evolution flexibility    | Low (coupled)  | High (independent)  | Medium           |
| Codebase-scan §IP-4 alignment          | No             | Yes                 | No               |
| Reader-code change footprint           | One file       | New file only       | Two files        |
| No-fallback-rule compliance            | OK             | OK                  | Risk             |

### Recommendation: Option 4B (separate constant, composite docs start at `schemaVersion: 1` of the composite lineage)

There is one terminology choice to settle: should the composite frontmatter carry `schemaVersion: 1` (composite lineage starts fresh) or `schemaVersion: 3` (continue the same numeric space the spec uses)? **Recommendation: keep `schemaVersion: 3`** in the composite document's frontmatter (matches spec FR-CMP-004 exactly) but back it with a *separate constant* `COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3` declared in the composite module. The constant exists to give the composite reader its own validation invariant; the value `3` is chosen for *external observability* (it's monotonic across the project's capability-doc history, useful in support diagnostics) without forcing a global bump.

This dual-property — separate constant, monotonic value — preserves both: (a) the codebase-scan recommendation (don't bump the global constant); (b) the spec's external contract (`schemaVersion: 3` in the document body).

**Concrete code shape** (for plan-006):

```typescript
// src/agent/composite/cache.ts
export const COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3;
const SUPPORTED_COMPOSITE_SCHEMA_VERSIONS: ReadonlySet<number> =
  new Set([COMPOSITE_CAPABILITY_SCHEMA_VERSION]);

export function readCompositeCacheEntry(path: string): CompositeCacheEntry | null {
  // own parser; does NOT call cache.ts:readCacheEntry
  // checks fm.schemaVersion ∈ SUPPORTED_COMPOSITE_SCHEMA_VERSIONS
}
```

The existing `cache.ts:SUPPORTED_SCHEMA_VERSION === 2` is **not** touched.

## Question 5 — Cache Key Composition (Open Question O-1: overlay digest?)

### Options Identified

#### Option 5A — Spec's Stated Key (no overlay digest) (RECOMMENDED)
- **Description**: `sha256(sorted-tools || each-member-doc-canonical-bytes-excluding-USER-blocks || cli-agent-version || schema-version || composite-name || synthesis-model-id)`.
- **Strengths**:
  - **Capability docs are themselves built from `--help` introspection, which is independent of overlays** (prompts are post-discovery formatting). Overlays are a *prompt-time* description; synthesis consumes the *capability-time* artifact. So the input to synthesis genuinely doesn't depend on overlays.
  - **User mental model**: "I edited a tool's overlay; do I expect my composite to re-synthesise?" Most users would say *no* — they edited prompt text, not the tool's behavior. The composite recipes are about cross-tool *intent*, not the wording of either tool's prompt.
  - **Cost-control**: synthesis is the most expensive operation in the system; over-eager invalidation defeats the cache.
- **Weaknesses**: A user who *does* expect "edit overlay → see fresh synthesis" must know about `--regenerate-capabilities`. Mitigation: document this clearly in `configuration-guide.md` and emit a one-time hint when `--treat-as-tool` runs against a composite whose member overlays have changed since synthesis.

#### Option 5B — Include Overlay Digest in Cache Key
- **Description**: Compute `sha256` over the relevant overlay file(s) for each member; fold into key.
- **Strengths**: "Edit overlay → next `--help` synthesises" — automatic.
- **Weaknesses**:
  - **Cosmetic edits trigger re-synthesis**: a typo fix in an overlay would force a full LLM run. This is the dominant case for overlay edits; it makes the cache near-useless.
  - **"Relevant overlay digest" is not well-defined**: overlays cascade (built-in overlay base + user overlay overlay). Hashing the merged effective overlay is correct but introduces a new dependency from synthesis on the overlay-merging code path.
  - **Performance**: hashing an entire overlays directory on every synthesis is wasteful even when overlays haven't changed.

#### Option 5C — Include Overlay Digest, but Only Per-Member Effective Overlay
- **Description**: For each member, compute the effective merged overlay digest (built-in + user) and fold those into the key.
- **Strengths**: Addresses 5B's "hashing the whole directory" objection.
- **Weaknesses**: Still triggers re-synthesis on cosmetic edits; still couples the synthesizer to overlay-merging internals.

### Comparison Matrix

| Criterion                             | 5A Spec key | 5B Whole-overlay digest | 5C Per-member overlay |
|---------------------------------------|-------------|-------------------------|----------------------|
| Cache hit rate after typical edits    | High        | Low                     | Low                  |
| User mental model fit                 | High        | Medium                  | Medium               |
| Implementation simplicity             | High        | Low                     | Medium               |
| Coupling to overlay internals         | None        | High                    | Medium               |
| Re-synthesis on substantive overlay change (with `--regenerate-capabilities`) | Manual | Automatic | Automatic |

### Recommendation: Option 5A (Spec key, no overlay digest), per the spec's A-6 assumption

Closes Open Question O-1 with **NO** — overlays are not in the cache key in v1.

**Concrete addition**: when synthesis runs on a cache hit, log a `composite_synthesis_start` event with a digest of the *current* effective overlays for each member. If a future plan wants to re-evaluate, the JSONL log already has the data to measure user pain (count of "edited overlay → manually ran `--regenerate-capabilities`" sequences). This is forward-looking instrumentation without any feature commitment.

**Documentation requirement**: `configuration-guide.md` must call out the contract — "overlay edits are cosmetic from the composite's perspective; re-run with `--regenerate-capabilities` if you want a fresh synthesis." This is the no-silent-fallback rule at the documentation layer.

## Question 6 — Stub-LLM Testing Pattern

### Existing Convention (codebase scan §IP-10)

```typescript
vi.spyOn(registry, 'createLLM').mockReturnValue({
  invoke: async () => ({ content: '<canned LLM output string>' }),
} as unknown as ReturnType<typeof registry.createLLM>);
```

This is the canonical stub. The investigation question is the *fixture shape* and *location* for synthesis tests, which involve multiple LLM round-trips (Stage-1 distill × N members + Stage-2 compose).

### Options Identified

#### Option 6A — Inline Canned Strings per Test
- Fastest to write; unmaintainable beyond two members. Not recommended.

#### Option 6B — Per-Scenario Folder with Three Files (RECOMMENDED)
- **Description**: One folder per scenario under `test_scripts/fixtures/synthesis/<scenario>/`:
  - `inputs.json` — `{ members: [{ name, capabilityDocPath }], cliAgentVersion, compositeName, synthesisModel }`
  - `transcript.json` — `{ "<promptDigest16>": "<cannedResponseString>" }` — one entry per LLM call (Stage-1 per member + Stage-2)
  - `expected.md` — golden composite doc (full doc, including frontmatter, AUTO-GENERATED, USER-RECIPES, USER-NOTES)
- The test harness (`test_scripts/lib/synthesisFixture.ts`) loads the folder, builds a stub LLM that hashes incoming messages with `sha256`, looks up the canned response, fails loudly on miss; the test asserts the produced doc equals `expected.md` byte-for-byte.
- **Strengths**: Fixtures are inspectable on disk; transcripts are recordable from a real LLM run with a `RECORD=1` env-var harness flag (capture mode); diff-friendly in PRs; one folder per scenario keeps the tree navigable.
- **Weaknesses**: The transcript is keyed by prompt digest, which means tweaking a prompt template invalidates all fixtures. Mitigation: a single `npm run record-fixtures` harness that re-records all transcripts in one batch.

#### Option 6C — Single Mega-Fixture File per Test
- **Description**: One JSON per test containing all three artifacts.
- **Strengths**: Single file to look at.
- **Weaknesses**: A 32 KB member doc embedded as a JSON string is unreadable in PRs; loses diff-friendliness.

### Comparison Matrix

| Criterion                          | 6A Inline | 6B Folder per scenario | 6C Mega-file |
|------------------------------------|-----------|------------------------|--------------|
| Diff-friendliness on PRs           | Low       | High                   | Low          |
| Recordability (capture from real LLM)| None    | Yes (with `RECORD=1`)  | Yes          |
| Maintainability at > 3 scenarios   | Low       | High                   | Medium       |
| Inspectability on disk             | N/A       | High                   | Low          |
| Alignment with project conventions (test_scripts) | Yes | Yes                | Yes          |

### Recommendation: Option 6B (folder per scenario)

**Concrete fixture-folder layout** (specify in plan-006):

```
test_scripts/
└── fixtures/
    └── synthesis/
        ├── two-cli-tools-happy-path/
        │   ├── inputs.json
        │   ├── members/
        │   │   ├── file-cli.md       # captured member capability doc
        │   │   └── outlook-cli.md
        │   ├── transcript.json       # { promptDigest16: cannedResponse }
        │   └── expected.md           # golden composite doc
        ├── empty-recipes-edge-case/
        │   └── ...
        └── three-members-large-budget/
            └── ...
```

**Harness** (`test_scripts/lib/synthesisFixture.ts`): exports `loadScenario(name)` returning `{ stubLLM, inputs, expectedDoc }` and a `recordScenario(name, realLLM)` for capture mode (gated by `process.env['RECORD'] === '1'`).

**Promptdigest scheme**: `sha256(JSON.stringify(messages))` first 16 hex chars, matching the codebase scan's prototype (`src/commands/extract-recipes.spec.ts` already follows this shape).

## Question 7 — `--regenerate-capabilities` UX

### Existing CLI surface (codebase scan §IP-9)

- `--refresh-capabilities` flag on the default command (member-tool refresh).
- `refresh-capabilities` subcommand (per-tool refresh).
- `show-capabilities` subcommand (print).
- `extract-recipes` subcommand (LLM-driven recipes).

### Options Identified

#### Option 7A — Flag Overload (`--regenerate-capabilities` resolves by `--treat-as-tool`) (RECOMMENDED)
- **Description**: Same flag name; behavior bifurcates on the presence of `--treat-as-tool`. With `--treat-as-tool`: forces composite re-synthesis. Without: existing member-tool refresh.
- **Strengths**:
  - The spec already specifies this dual semantics in FR-CMP-010 (existing flag-driven path) and FR-CMP-022 (subcommand `composite synthesize --regenerate` for CI).
  - **One mental model**: "regenerate this thing's capability doc, whatever this thing is." Aligns with `--refresh-capabilities`'s existing semantics for the member-tool world.
  - **Discoverable from `--help`** when `--treat-as-tool` is in scope.
- **Weaknesses**: Flag overloading is mildly confusing; mitigation is good help text.

Note on the flag-name choice: the spec uses `--regenerate-capabilities`; the existing codebase has `--refresh-capabilities`. **Recommendation**: keep the spec name `--regenerate-capabilities` for the new composite path (it's a synthesis, not a refresh — the verb difference signals the LLM-driven nature). The old `--refresh-capabilities` keeps its meaning. A user who supplies `--regenerate-capabilities` *without* `--treat-as-tool` should get a UsageError (exit 2) with message `"--regenerate-capabilities requires --treat-as-tool; use --refresh-capabilities for member-tool discovery refresh"`. **This corrects an ambiguity in FR-CMP-010** which says the flag without `--treat-as-tool` "behaves exactly as today (`refresh-capabilities` semantics)" — but the existing flag is `--refresh-capabilities`, not `--regenerate-capabilities`, so silently aliasing them creates a maintenance landmine. The plan should fix this by introducing `--regenerate-capabilities` as a *new* flag dedicated to composite synthesis, leaving `--refresh-capabilities` as today.

#### Option 7B — Separate Subcommand `cli-agent composite regenerate <name>`
- **Description**: A dedicated subcommand for forced re-synthesis.
- **Strengths**: Verb-noun-verb grammar.
- **Weaknesses**: Duplicates `composite synthesize --regenerate` from FR-CMP-022 with no functional difference; adds a third place where composite-name validation must live; harder to discover ("is it `regenerate` or `synthesize --regenerate`?").

#### Option 7C — Extension to `refresh-capabilities` Subcommand
- **Description**: Teach the existing subcommand to accept `--composite <id>` and re-synthesize composites.
- **Strengths**: Reuses one verb.
- **Weaknesses**: `refresh-capabilities` is conceptually a *member-tool* operation (introspection of `--help`); composite re-synthesis is conceptually different (LLM call, multi-stage, composite-name aware). Conflating them in one subcommand creates a polymorphic behavior driven by flag combinations that's hard to document and test.

### Comparison Matrix

| Criterion                              | 7A Flag overload    | 7B `composite regenerate` | 7C Extend `refresh-capabilities` |
|----------------------------------------|---------------------|---------------------------|----------------------------------|
| Spec alignment                         | Direct              | Drift                     | Drift                            |
| Discoverability                        | High (in `--help`)  | High (in subcommand list) | Medium                           |
| Code-path clarity                      | Two clear branches  | Three places to maintain  | Polymorphic in one place         |
| Verb-noun consistency with existing CLI| OK                  | Best                      | OK                               |
| Risk of name confusion                 | Low (with help text)| Medium                    | High                             |

### Recommendation: Option 7A (flag overload), with **two refinements** to the spec

1. **Rename the flag**: introduce `--regenerate-capabilities` strictly for the composite-synthesis path; keep `--refresh-capabilities` for the existing member-tool refresh. They are NOT aliases. This corrects the FR-CMP-010 ambiguity.
2. **Sibling subcommand for CI**: keep `cli-agent composite synthesize --regenerate` (FR-CMP-022) as the scriptable form. Do not add `composite regenerate` — it's a duplicate door.

Rationale: discoverability is high (the flag shows up in `--help` when `--treat-as-tool` is in effect; the subcommand shows up in the top-level command list); maintenance is low (two clear code paths); the rename eliminates the silent-aliasing landmine.

## Recommendation Summary (One-Line Each)

| # | Question                       | Recommendation                                                                                  |
|---|--------------------------------|-------------------------------------------------------------------------------------------------|
| 1 | Pipeline shape                 | Two-stage (1B), with Stage-1 outputs cached as addressable per-member artifacts.                |
| 2 | Wrapper format                 | POSIX shell shim (2A), `#!/usr/bin/env bash`, `exec`-based.                                     |
| 3 | Virtual dispatch (O-2)         | Subprocess (3B) default; in-process opt-in & experimental.                                      |
| 4 | Schema versioning              | Separate `COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3` constant; member docs untouched.             |
| 5 | Cache key (O-1)                | Spec key, NO overlay digest in v1; instrument JSONL to measure pain for v1.1 revisit.           |
| 6 | Test fixtures                  | Folder per scenario under `test_scripts/fixtures/synthesis/<name>/` with `inputs/transcript/expected`. |
| 7 | `--regenerate-capabilities` UX | Flag (renamed, distinct from `--refresh-capabilities`) + `composite synthesize --regenerate` subcommand. |

## Technical Research Guidance

**Research needed**: Yes (two narrow topics).

The investigation has gathered enough breadth to commit to the seven recommendations above and to draft plan-006. Two implementation areas warrant deeper research before code lands, because the planning step needs concrete contract details that the breadth-first investigation did not surface.

### Topic 1: Provider-side prompt-cache wire format for the project's LLM-provider stack

- **Why**: Recommendation 1 (two-stage pipeline) explicitly relies on the *on-disk* cache for Stage-1 outputs. The orthogonal *provider-side* prompt cache (Anthropic's `cache_control: {type: "ephemeral"}`, OpenAI's automatic prefix caching, Bedrock's `cachePoint` blocks) is what makes Stage-2 affordable on a re-run when Stage-1 hits the on-disk cache but the Stage-2 prompt prefix is rebuilt. Sources §1 surfaced the pattern but not the exact wire format per provider — and the project supports eight standard providers, each with its own caching contract or absence of one. The plan-006 implementation needs to know: which providers in the standard 8 currently expose explicit cache breakpoints; what the LangChain/LangGraph client API looks like to set them; what the minimum-token thresholds are; what the TTL knobs are. Without this, Stage-2 prompts may be assembled in a cache-hostile shape and the cost/latency wins of the two-stage choice evaporate.
- **Focus**: Anthropic cache breakpoints in `@langchain/anthropic` (set via message metadata), OpenAI Responses API automatic caching boundaries, Azure OpenAI parity, Bedrock `cachePoint`, Google `cachedContent`. Particularly: how to express "stable system prompt + per-member distilled context (cacheable) + dynamic compose instruction (variable tail)" in LangChain's `BaseChatModel.invoke()` API.
- **Depth**: Intermediate — enough detail to write the Stage-2 prompt assembler with correct breakpoint placement on the providers that support it, and a graceful no-op on those that don't.
- **Relevance**: Direct to Recommendation 1; bears on NFR-CMP-003 (latency ceiling) and NFR-CMP-004 (cache-hit cost).

### Topic 2: `cmd-shim` reference implementation for POSIX shim semantics

- **Why**: Recommendation 2 commits to a POSIX shell shim. The investigation surfaced the high-level pattern (Sources §2). Plan-006 will spec the exact shim text. To avoid subtle bugs (path-resolution under symlinks, `LANG` propagation, signal forwarding, exit-code preservation), the implementation should model on a battle-tested reference rather than re-derive. `cmd-shim` (npm) and `@pnpm/cmd-shim` ship the canonical POSIX shim text used by tens of millions of installs; reading the source clarifies edge cases the surface-level guidance does not.
- **Focus**: Source of `cmd-shim` (npm) for the POSIX shell branch — particularly: how `dirname`/`readlink` resolves the shim under a symlink (when the user adds `~/.local/bin/<id>` per FR-CMP-013's `--emit-wrapper-on-path`); how exit codes propagate from `exec`; whether `set -euo pipefail` is safe (cmd-shim doesn't use it — investigate why before adding).
- **Depth**: Overview — read 200 lines of `cmd-shim/lib/index.js` and the shim template; absorb the patterns. Skip the Windows branch.
- **Relevance**: Direct to Recommendation 2 implementation; closes a small but real risk on FR-CMP-013 acceptance criteria 11 ("when run with arbitrary args, execs cli-agent with the recorded `--tool` list").

### Topics NOT requiring further research

- **LangGraph subgraph re-entry mechanics** — the investigation gathered sufficient evidence (Issue #3020, Sources §3) to commit to subprocess dispatch. Going deeper is premature; only revisit if v1.1 pursues in-process as default.
- **Schema-version dual-read pattern** — codebase scan §IP-4 already enumerated every read site of `schemaVersion` in the codebase. The dual-read story is structurally trivial because the composite reader is a separate function from `cache.ts:readCacheEntry`. No further research needed.
- **Vitest stub patterns** — the codebase scan §IP-10 already cataloged the canonical stubs; plan-006 just applies them.

## Implementation Considerations

Notes for plan-006 author and implementers, distilled from the investigation:

1. **Order of implementation** — the safe sequencing is: (i) bootstrapAgentDir extension (capabilities/composite/ + composites/); (ii) Commander `helpOption(false)` migration with NFR-CMP-001 baseline pinned; (iii) composite cache reader + writer (no LLM); (iv) Stage-1 distillation + on-disk cache; (v) Stage-2 composition; (vi) `--treat-as-tool --help` flag wiring; (vii) `--emit-wrapper`; (viii) `--register-virtual` + child-process dispatcher; (ix) `composite synthesize/list/show/delete` subcommands; (x) in-process dispatch (experimental). Each step is independently testable.

2. **Key decisions deferred to plan-006 (not investigation-blocking)**:
   - Stage-1 prompt template wording (the *content* of "intent surface" extraction).
   - Stage-2 prompt template wording (the *content* of cross-tool-recipe generation).
   - Logger event-payload field names (must satisfy redaction policy).
   - Exact CLI flag descriptions for `--help` text.

3. **Pitfalls watched for**:
   - Commander `--help` interception is the single largest behavioral risk (§IP-2). Pin NFR-CMP-001 baseline *before* changing `helpOption(false)`.
   - Composite-doc co-location: write to `capabilities/composite/<id>.md` (canonical) and *also* mirror to `capabilities/<id>.md` so `composeCapabilitiesSystemPrompt` finds it without code change (§IP-8 / §Notes in the scan). Use a hardlink or copy, not a symlink (mode-0700 directories may surprise symlink resolution under some `mkdir -p`-like helpers).
   - `--regenerate-capabilities` vs `--refresh-capabilities` naming — apply the spec correction in this investigation (Recommendation 7) before code lands.
   - Recursion guard at *both* registration and dispatch time (FR-CMP-016 explicitly). Don't trust the manifest alone.
   - The `cli-agent` binary in the wrapper shim must be discoverable via PATH. If the user installed cli-agent via a private mechanism, the shim breaks. Document this prerequisite; consider recording the resolved binary path at synthesis time and templating it into the shim (`exec /resolved/path/to/cli-agent --tool …`). This trades portability of the shim across machines for reliability on the synthesis machine. Since the v1 spec already explicitly defers cross-machine sync (Out of scope §2), the resolved-path form is the right call.

4. **Suggested first step for plan-006 drafting**: write the data-flow diagram for the two-stage pipeline including the Stage-1 cache, the prompt-digest log keys, and the failure-recovery paths. The diagram surfaces the contract between `synthesizer.ts` and `cache.ts` cleanly and grounds the rest of the plan.

## References

| #  | Source                                                                                       | URL                                                                                                  | What was learned                                                                                                  |
|----|----------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------|
| 1  | "Multi-Step LLM Chains: Best Practices for Complex Workflows" (Deepchecks)                  | https://deepchecks.com/orchestrating-multi-step-llm-chains-best-practices/                            | Distill-then-compose pattern with intermediate-artifact caching is the production-recommended topology.          |
| 2  | "How We Cut LLM Costs by 59% With Prompt Caching" (ProjectDiscovery)                        | https://projectdiscovery.io/blog/how-we-cut-llm-cost-with-prompt-caching                              | Provider prompt caching is prefix-stable; "distill early, compose late" with addressable intermediates is the winning shape. |
| 3  | "Subgraph forgets its state of the first run when invoked the second time" (LangGraph #3020)| https://github.com/langchain-ai/langgraph/issues/3020                                                | Documented re-entry state-pollution bug; supports subprocess-default dispatch decision.                          |
| 4  | "Subgraphs" (LangChain docs)                                                                | https://docs.langchain.com/oss/python/langgraph/use-subgraphs                                        | Per-thread subgraphs explicitly do not support parallel tool calls without guards.                               |
| 5  | "How bin linking works in node.js npm and yarn and monorepos" (Jonathan Creamer)            | https://www.jonathancreamer.com/how-bin-linking-works-in-node-js-npm-and-yarn-and-monorepos/         | Confirms POSIX shell shim is the standard wrapper form; npm uses symlinks on POSIX, shims on Windows.            |
| 6  | "Installing npm packages and running bin scripts" (Exploring Shell Scripting with Node.js)  | https://exploringjs.com/nodejs-shell-scripting/ch_installing-packages.html                            | Reference for `cmd-shim` POSIX template — `#!/bin/sh`, `dirname` self-resolution, `exec node "$target" "$@"`.    |
| 7  | "Evolving JSON Schemas — Part I" (Creek Service)                                            | https://www.creekservice.org/articles/2024/01/08/json-schema-evolution-part-1.html                   | Open-vs-closed schema compatibility classification; supports per-document-type version constants.                |
| 8  | "Schema versioning strategies" (StudyRaid)                                                  | https://app.studyraid.com/en/read/12384/399934/schema-versioning-strategies                          | Embedded `schemaVersion`, additive-only changes, transform-on-read pattern.                                       |
| 9  | "Introducing versioning in JSON schema validation" (KrakenD)                                | https://www.krakend.io/blog/changes-in-json-schema/                                                  | Real-world example: per-version URLs preserved indefinitely for backward compatibility — supports keeping schema-2 reader untouched. |
| 10 | "What Is Prompt Caching?" (Redis)                                                           | https://redis.io/blog/what-is-prompt-caching/                                                        | Provider KV cache is prefix-only; layered caching (provider + Redis exact-match + semantic) is the production pattern. |
| 11 | Refined request                                                                              | docs/design/refined-request-composite-tools.md                                                       | The 22 FRs / 27 acceptance criteria the investigation must satisfy.                                              |
| 12 | Codebase scan                                                                                | docs/reference/codebase-scan-composite-tools.md                                                      | The 11 integration points; constants `CAPABILITY_SCHEMA_VERSION = 2` and `SUPPORTED_SCHEMA_VERSION` reside in `cache.ts`/`composeMarkdown.ts`; LLM stub pattern at `createLLM` boundary. |

## Original Request

This investigation was driven by a planning-phase brief that posed seven specific design questions ahead of plan-006 implementation: (1) synthesis pipeline stage count, (2) wrapper script format, (3) virtual-tool dispatch mode (Open Question O-2 in the refined request), (4) schema-3 versioning strategy, (5) cache-key composition (Open Question O-1), (6) stub-LLM testing fixture shape, (7) `--regenerate-capabilities` UX. The full original brief is preserved in the user's request to the investigation agent; the resolved questions are referenced by number in the recommendations above.
