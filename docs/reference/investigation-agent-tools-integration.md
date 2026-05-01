---
investigation_topic: "Integrating BikS2013/agent-tools into cli-agent as standard tools"
refined_request: docs/design/refined-request-agent-tools-integration.md
codebase_scan: docs/reference/codebase-scan-agent-tools-integration.md
inventory: docs/reference/agent-tools-inventory.md
investigated_at: "2026-04-30"
investigated_by: solutions-investigator
verdict: "Bundling is rational with a curated subset; the user's proposed opt-out pattern is the WRONG primary mechanism. Use config-flag gating (per-tool, with a pack-level umbrella) as the source of truth, with the prompt block derived from the registered set."
---

# Investigation: Integrating `BikS2013/agent-tools` into cli-agent

## Executive Summary

Bundling a **curated subset of four-to-six tools** from `BikS2013/agent-tools`
into cli-agent is feasible and rational. The upstream is TypeScript / ESM /
Node ≥ 20.10 / MIT-licensed and ships a first-class LangChain adapter, so it
is technically a near-drop-in fit. The high-value, non-overlapping additions
are **`agt_glob`**, **`agt_grep`**, **`agt_multiedit`**, **`agt_patch`**, with
**`agt_todo_read`/`agt_todo_write`** as a default-off optional pair. Tools
that overlap cli-agent's existing standard catalog (`read`, `write`, `edit`,
`bash`, `webfetch`, `list`) should be **skipped**, not duplicated.

The user's stated opt-out pattern — *"describe the tools in the system prompt;
let the user remove the descriptions to opt out"* — is the **wrong primary
mechanism**. It would leave the tools registered with the LLM but invisible in
the prompt, producing a behavioral split where the model can still call a tool
it doesn't know how to use, with prompt-token cost paid in full or savings
that come at the cost of capability discovery. The architecturally clean
answer is the inverse: **the registered tool set is the source of truth, and
the prompt block is derived from it.** Opt-out happens by un-registering the
tool (config flag → not in the catalog → not in the prompt). cli-agent already
uses exactly this pattern for `bash_run` (gated on a non-empty allowlist) and
for `file_write`/`file_edit`/`file_append` (gated on `--allow-mutations`).

The recommended opt-out surface is **per-tool with a pack-level umbrella**,
exposed through the standard four-tier config chain (CLI flag → shell env →
agent `.env` → local `.env` → `config.json`).

## Context

- **What was investigated**: whether to bundle the upstream `agent-tools` library, which subset to bundle, and whether the user's "describe-and-suppress" opt-out approach is the right pattern given cli-agent's actual architecture.
- **Key constraints**: TypeScript-only, LangChain `StructuredTool` compatibility, no fallbacks for required config, four-tier env precedence, mutation gating already in place (FR-AGT-010), prompt assembly today is *static text in a single file* (no `system-prompt-blocks/` directory exists).
- **Refined request**: see `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/refined-request-agent-tools-integration.md`.
- **Codebase facts**: see `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/codebase-scan-agent-tools-integration.md`. Critical points:
  - `buildToolCatalog` (`src/agent/tools/registry.ts:23`) is the single source of truth for what the LLM sees.
  - The system prompt is a **single file** (`~/.tool-agents/cli-agent/capabilities/system-prompt.md`), seeded from `BUILTIN_DEFAULT_SYSTEM_PROMPT`. There is no block registry. The standard-tool descriptions are inline prose at lines 48–65 of that constant.
  - `composeCapabilitiesSystemPrompt` injects per-CLI-tool capability docs but is unrelated to standard tools.
- **Inventory**: see `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/agent-tools-inventory.md`. Twelve upstream tools; six recommended for bundling, six skipped due to overlap.

## Options Identified

The investigation has two largely-orthogonal axes:

- **Axis A: bundling strategy** — *do we bundle these tools at all, and how do we distribute the code?*
- **Axis B: opt-out / registration mechanism** — *how does a user remove a tool (and its prompt description) from a given run?*

Each axis is enumerated below.

---

### Axis A — Bundling strategies

#### A1. Bundle a curated subset (recommended)

- **Description**: Vendor the upstream library under `src/agent/tools/agent-tools-vendored/` (pinned commit SHA + provenance file), but only register the four-to-six tools that don't overlap cli-agent's existing catalog. Skip `read`/`write`/`edit`/`bash`/`webfetch`/`list`.
- **Strengths**: Net-new capability for the LLM (in-process `glob`/`grep`/`multiedit`/`patch`); no duplicate tools confusing the model; prompt-token cost contained; aligned with the existing standard-tool pattern.
- **Weaknesses**: Requires a vendoring workflow (sync script or manual periodic SHA bump). Adds new transitive deps (`fast-glob`, `ignore`, optional `@vscode/ripgrep`).
- **Effort/Complexity**: Medium.
- **Risk**: Low — every bundled tool has a clean LangChain adapter, MIT license, no native dep mandatory.
- **Best suited when**: cli-agent wants a one-stop-shop tool catalog without taking on a heavy fork.

#### A2. Bundle the full set verbatim

- **Description**: Register all twelve upstream tools, including the duplicates.
- **Strengths**: Easiest sync — just re-export. Lossless w.r.t. upstream evolution.
- **Weaknesses**: Two tools doing the same thing (e.g., `file_read` AND `agt_read`) confuses the LLM and bloats every system prompt. Mutation-gating becomes inconsistent across pairs. Prompt-token cost roughly doubles.
- **Effort/Complexity**: Low to register, Medium-High to debug behavioral split.
- **Risk**: Medium — split brain on which tool the LLM picks.
- **Best suited when**: never, in cli-agent's case.

#### A3. Skip the bundle; cherry-pick utilities only

- **Description**: Don't register any upstream tool as LLM-visible. Reuse only the upstream's pure-utility helpers (`scrubEnv`, the `PermissionPolicy` types, the prompt-block builder API) inside cli-agent's own tools.
- **Strengths**: Minimum dependency footprint; minimum prompt-token cost; no behavioral surprises.
- **Weaknesses**: cli-agent loses out on the genuinely useful net-new tools (`glob`, `grep`, `multiedit`, `patch`) that the user does not currently have a substitute for.
- **Effort/Complexity**: Low.
- **Risk**: Low.
- **Best suited when**: the user explicitly does not want any new LLM-visible tools, only library reuse.

#### A4. MCP / sidecar server

- **Description**: Run `agent-tools` as an MCP server (or HTTP sidecar) and consume it via a generic MCP client.
- **Strengths**: Process isolation. No transitive deps in cli-agent's install. Tool list discovered dynamically.
- **Weaknesses**: Massive over-engineering for a TS library that's already LangChain-ready. Adds a process boundary, IPC latency, and operational complexity (when does the sidecar start? who supervises it?). cli-agent has no MCP client today.
- **Effort/Complexity**: High.
- **Risk**: Medium (new failure mode: sidecar crash).
- **Best suited when**: the upstream had been Python-only or the integration needed to span untrusted code. Neither applies.

---

### Axis B — Opt-out / registration mechanism

For each option, the rows of interest are:

- **What's in the catalog**: which tools the LLM can call.
- **What's in the prompt**: which descriptions the LLM sees.
- **Behavioral consistency**: does (catalog set) == (prompt set)?
- **Prompt-token cost** (relative).
- **Implementation complexity** against the actual cli-agent code.

#### B1. Description-only suppression — the user's stated approach

- **Description**: All bundled tools are always registered with the LLM. The system-prompt block listing them is a removable section; the user opts out by stripping that section.
- **Catalog**: always full.
- **Prompt**: optional block.
- **Behavioral consistency**: **No.** When the block is stripped, the LLM still has the tools available but no idea how to use them well. It may still call them based on tool-name + JSON-schema introspection, but with degraded quality (no usage guidance, no chaining rules, no caveats).
- **Prompt-token cost**: 0 when stripped, full when enabled. Best case for token savings *at the cost of correct behavior*.
- **Complexity**: Medium. Requires inventing a new "removable block" concept in `buildSystemPromptForCfg`.
- **Failure modes**: silent quality degradation; user thinks tool is gone but the LLM still calls it; testing surface confused (does "opt-out" mean unbound, or just unmentioned?).
- **Verdict**: **Reject as primary mechanism.** Prompt-only suppression breaks the invariant that what the LLM sees in the prompt matches what it has access to. cli-agent's current code already maintains that invariant — the bash tool's `[READ-ONLY-AGENT]` prefix is a visible deviation precisely because the project values matching prompt to capability.

#### B2. Per-tool config-flag gating (recommended primary mechanism)

- **Description**: Each bundled tool is registered if and only if a config flag enables it. The prompt block is *generated from the registered set*, not maintained separately. Mirror what `bash_run` already does (registered iff allowlist is non-empty) and what mutating file tools do (registered iff `--allow-mutations`).
- **Catalog**: subset based on config.
- **Prompt**: derived from catalog → always in sync.
- **Behavioral consistency**: **Yes.** Invariant is maintained.
- **Prompt-token cost**: proportional to the enabled set. Disabled tools cost zero tokens.
- **Complexity**: Low-Medium. Same pattern already used in `registry.ts`. Adds N booleans to `AgentConfig`.
- **Surface**: per-tool flags (`--enable-agt-grep` / `CLI_AGENT_AGT_GREP=1` / `config.json agentTools.grep: true`) plus a pack-level umbrella `--no-agent-tools` / `CLI_AGENT_DISABLE_AGENT_TOOLS=1` that disables all of them in one shot.
- **Failure modes**: minor — the LLM gets a different tool catalog per run. This is exactly what `--allow-mutations` already does, so users are not surprised.
- **Verdict**: **Accept as primary mechanism.**

#### B3. Pack-level toggle only (whole-pack on/off)

- **Description**: One flag enables/disables the whole agent-tools pack; no per-tool granularity.
- **Catalog**: all-or-nothing.
- **Prompt**: derived from catalog.
- **Behavioral consistency**: Yes.
- **Prompt-token cost**: 0 or full pack.
- **Complexity**: Lowest of the three sane options.
- **Failure modes**: user can't get e.g. `grep` without also getting `multiedit`. For most use cases this is fine, but power users want finer control.
- **Verdict**: **Use as the umbrella alongside B2.** Default the per-tool flags to "enabled when the umbrella is on", so the umbrella is the simple-case knob and per-tool flags are the power-user knob.

#### B4. Dynamic prompt assembly via a real block registry

- **Description**: First implement the `system-prompt-blocks/` directory + named-block registry that the original request assumed (and that does not exist). Then ship the agent-tools description as one named block among many.
- **Catalog**: still derived from `buildToolCatalog`.
- **Prompt**: assembled from named blocks at runtime.
- **Behavioral consistency**: depends on whether the blocks are linked to catalog membership. If yes, equivalent to B2 plus a generic block subsystem. If no, equivalent to B1's failure mode.
- **Prompt-token cost**: proportional to enabled blocks.
- **Complexity**: **High.** Requires building the block registry, the assembly pipeline, and the per-block toggle UX *before* anything tool-related is added. Out of scope for an "integrate these tools" effort.
- **Failure modes**: scope creep; risks delaying the actual integration; reinvents what cli-agent's per-tool config already gives via B2.
- **Verdict**: **Reject for this scope.** Worth doing later if the prompt grows multiple toggleable narrative blocks (e.g., persona blocks, customer-specific guidance blocks). Not justified by this single integration.

#### B5. Lazy / just-in-time tool registration

- **Description**: Tools are registered only after the LLM calls a meta-tool (`enable_pack agent-tools`).
- **Catalog**: dynamic, grows mid-session.
- **Prompt**: bootstrap mentions the meta-tool only.
- **Behavioral consistency**: depends on dynamic re-binding of `createReactAgent`. LangGraph's prebuilt `createReactAgent` does **not** support hot-adding tools mid-session — you'd have to rebuild the graph and replay history, which is painful.
- **Prompt-token cost**: minimal until invoked.
- **Complexity**: **Very high** for `createReactAgent`-based agents. Doable for hand-rolled graphs.
- **Verdict**: **Reject.** Not worth the architectural complexity for this integration.

---

## Comparison Matrix

### Axis A (bundling)

| Criterion | A1: Curated subset | A2: Full set | A3: Utilities only | A4: MCP sidecar |
|---|---|---|---|---|
| Net-new LLM capability | High (4–6 new tools) | High but with duplicates | None | High |
| Prompt-token cost | Moderate (4–6 tools) | High (12 tools incl. duplicates) | Zero | Moderate |
| Dependency footprint | Moderate (+`fast-glob`, `ignore`, opt. `ripgrep`) | Moderate-High (+`jsdom`, `turndown`, `readability`) | Minimal | Minimal in cli-agent; sidecar elsewhere |
| Implementation complexity | Medium | Low to ship, Medium-High to debug | Low | High |
| Operational complexity | Low (pure code) | Low | Low | High (process boundary) |
| Risk | Low | Medium (LLM split-brain) | Low | Medium (sidecar lifecycle) |
| Long-term viability | High | Low (drift between duplicates) | High | Medium (over-engineered) |

**Winner: A1.**

### Axis B (opt-out mechanism)

| Criterion | B1: Description-only | B2: Per-tool gating | B3: Pack-level | B4: Block registry | B5: Lazy/JIT |
|---|---|---|---|---|---|
| Catalog-prompt invariant | **Broken** | Held | Held | Configurable | Held |
| Prompt-token cost when off | 0 | 0 | 0 | 0 | ~0 (bootstrap only) |
| Implementation complexity | Medium (new mechanism) | Low (existing pattern) | Lowest | High (new subsystem) | Very High |
| User-experience granularity | Pack | Per-tool | Pack | Per-block | Lazy + meta-tool |
| Alignment with cli-agent today | Poor | Excellent (`bash_run`, mutation-gated tools follow this) | Good | Poor (subsystem absent) | Poor |
| Reversibility | Per-run | Per-run | Per-run | Per-run | Per-session (mid-session re-bind hard) |
| Risk of silent behavior | **High** | Low | Low | Medium | Medium |

**Winner: B2 + B3 (per-tool flags with a pack-level umbrella).**

---

## Recommendation

Adopt **A1 + (B2 with B3 umbrella)**:

1. **Vendor a curated subset** of `BikS2013/agent-tools` under `src/agent/tools/agent-tools-vendored/`, pinned to a specific commit SHA, with a `docs/reference/agent-tools/PROVENANCE.md` file documenting the SHA, the upstream MIT LICENSE, and the per-tool mapping. The bundled tools:

   | cli-agent name | Upstream | Default | Mutation-gated |
   |---|---|---|---|
   | `agt_glob` | `glob` | On | No |
   | `agt_grep` | `grep` | On | No |
   | `agt_multiedit` | `multiedit` | On (when `--allow-mutations`) | **Yes** |
   | `agt_patch` | `patch` | On (when `--allow-mutations`) | **Yes** |
   | `agt_todo_read` | `todoread` | **Off** by default | No |
   | `agt_todo_write` | `todowrite` | **Off** by default | No (in-mem only) |

   Skip `read`, `write`, `edit`, `bash`, `webfetch`, `list` — all overlap with cli-agent's existing standard tools.

2. **Make the registered tool set the source of truth.** Generate the system-prompt section listing the agent-tools group from the actual registered set, in `buildSystemPromptForCfg` (`src/agent/system-prompt.ts`). When a tool is not registered, its description does not appear in the prompt — automatically. This is the inverse of the user's original mental model and is architecturally cleaner: there is *one* place to look (the catalog) and the prompt follows.

3. **Expose opt-out controls** through the existing four-tier chain:

   - **Pack umbrella (default ON)**: `--no-agent-tools` / `CLI_AGENT_DISABLE_AGENT_TOOLS=1` / `config.json` `agentTools.enabled: false`.
   - **Per-tool overrides**: `--disable-tool agt_grep` (extending the existing `--tool` flag style) / `CLI_AGENT_DISABLE_AGT_GREP=1` / `config.json` `agentTools.disabled: ["agt_grep"]`.
   - **Per-tool enables for default-off tools**: `--enable-tool agt_todo_read` / `CLI_AGENT_ENABLE_AGT_TODO_READ=1` / `config.json` `agentTools.enabled: ["agt_todo_read"]`.

4. **Mutation gating** for `agt_multiedit` and `agt_patch` follows the existing `--allow-mutations` pattern (`registry.ts:40-47`). They simply join the `mutatingFile` array conditionally.

5. **Reuse upstream utilities** even where the tool itself is skipped: `scrubEnv` should be adopted by cli-agent's `bash/exec.ts`, and the upstream `PermissionPolicy`/`createStrictPolicy` types can be wrapped to delegate to cli-agent's existing allowlist + sandbox modules so the bundled tools enforce *the same* security policy as native tools.

### Why this combination over alternatives

- **A1 vs A2**: duplicate tools confuse LLMs in practice (Anthropic's own model card warnings about overlapping tool names). The marginal benefit of adopting upstream's `read`/`write`/etc. is negative because cli-agent's variants are already battle-tested with its sandbox and logging.
- **A1 vs A3**: A3 throws away the genuinely useful `glob`/`grep`/`patch` tools, which cli-agent has no equivalent for. The user's intent is to *gain capability*, not just refactor.
- **A1 vs A4**: MCP overhead is unjustified when the upstream is already a TypeScript LangChain library.
- **B2 vs B1**: The user's stated approach (B1) violates the invariant that prompt content matches catalog content. cli-agent already follows the invariant elsewhere; breaking it here would be a regression.
- **B2 vs B4**: B4 requires building a generic block subsystem first. That's a worthwhile separate project but is out of scope here. The current request can ship cleanly with B2.

### Conditions under which this would change

- If a future request adds **multiple narrative-only blocks** (persona, customer-specific instructions, etc.), revisit B4 — building a block registry then becomes amortizable.
- If the user explicitly wants the LLM to be able to **discover and enable tools on demand**, revisit B5 (and accept the LangGraph re-binding cost).
- If the upstream library publishes to npm later, switch from vendoring (A1's distribution form) to a normal `dependencies` entry. The choice between vendor / submodule / git-dep is orthogonal to the recommended A1 selection.

### Caveats

- The recommendation defers to the user's confirmation of `agt_*` as the naming prefix (Open Question §3 below).
- Token-budget assertion (NFR-NEW-001) is straightforward with this approach because the prompt block is generated from a known list. The plan should add a Vitest spec asserting `tokens(buildAgentToolsBlock(catalog)) <= N` for an upper-bound `N` documented in the plan (initial guess: ≤ 3 K tokens for the four default-on tools, based on observed fragment sizes of ~250–1200 tokens each).
- The optional `@vscode/ripgrep` install can fail in locked-down CI; the JS fallback handles it. Mention in `configuration-guide.md`.
- The upstream's `ToolContext` requires a fresh `sessionId` per call. The plan must wire cli-agent's session/turn IDs through correctly.

---

## Resolution of Open Questions (from the refined request)

1. **System-prompt assembly architecture (raw-request divergence).** **Resolved.**
   The codebase scan confirms `system-prompt-blocks/` does not exist. The
   single-file `~/.tool-agents/cli-agent/capabilities/system-prompt.md` is the
   authoritative base; standard-tool descriptions live as inline prose in
   `BUILTIN_DEFAULT_SYSTEM_PROMPT`. The recommendation does **not** require
   building the block subsystem first. Instead, the agent-tools descriptions
   are emitted as a programmatically-composed section by an extension to
   `buildSystemPromptForCfg`, sandwiched between the wrapped-CLI capabilities
   block and the user addenda. (See codebase-scan §4.2 "Integration landing
   point".)

2. **Per-tool vs. pack-level opt-out.** **Resolved: both.** Per-tool granularity
   is the source of truth in `AgentConfig`; a pack-level umbrella is layered on
   top as a convenience. This matches B2 + B3 in the comparison.

3. **Naming prefix.** **Recommendation: `agt_`** (matches the request's
   `agt_<name>` suggestion in FR-NEW-004). Stable, two-character, recognizable.
   Alternative `at_` is ambiguous with shell `@` and email-style; `no prefix`
   would risk clashes (e.g., `grep` is too generic). User decision still
   requested before implementation.

4. **What to do with overlapping tools.** **Resolved: skip them.** All six
   overlapping upstream tools (`read`, `write`, `edit`, `bash`, `webfetch`,
   `list`) are skipped. The upstream's pure-utility helpers (`scrubEnv`,
   `PermissionPolicy`) can still be reused as libraries inside cli-agent's
   native tools.

5. **Distribution model (vendor / submodule / npm dep).** **Resolved: vendor**
   under `src/agent/tools/agent-tools-vendored/` with a pinned commit SHA and
   a provenance file. Rationale: the upstream is `"private": true` (not on
   npm), git-submodule complicates end-user `npm install` of cli-agent, and a
   `github:` dep would require running upstream's `tsc` build at every
   install. Vendoring keeps the install footprint clean and gives cli-agent a
   stable, auditable copy. Re-sync is a deliberate periodic action recorded in
   `PROVENANCE.md`.

---

## Technical Research Guidance

**Research needed**: Yes — limited.

The investigation gathered enough detail on the upstream library, the
LangChain adapter contract, the recommended architecture, and the dep
footprint to write the plan. Two narrow topics remain where a deeper
`technical-researcher` dive would meaningfully sharpen the plan:

### Topic 1: Token-budget measurement methodology for the new prompt block

- **Why**: NFR-NEW-001 asserts a token budget; the plan needs a test that
  measures it. cli-agent does not currently embed a tokenizer.
- **Focus**: Lightweight tokenization options that are good-enough for an
  assertion (`tiktoken` vs. `gpt-tokenizer` vs. character-count heuristic);
  consensus on a per-tool-fragment ceiling and a pack-level ceiling; whether
  to reuse a tokenizer the project already pulls in transitively via
  `@langchain/openai`.
- **Depth**: Overview (1–2 hours).
- **Relevance**: Determines whether the budget test is a real tokenizer
  assertion or a `length`-based proxy.

### Topic 2: LangGraph `createReactAgent` behavior with per-call `ToolContext` injection

- **Why**: cli-agent's existing tools close over `cfg` once at registration.
  The upstream `agent-tools` adapter expects a `ToolContext` (`sessionId`,
  `workingDirectory`, `permissions`) that cli-agent will want to refresh
  per-call. The plan needs to confirm the right wiring — wrap each tool
  factory so `func()` rebuilds the context, or rebuild the whole catalog per
  turn? The latter conflicts with `createReactAgent`'s graph compile model.
- **Focus**: Whether `StructuredTool.func` can capture a closure that pulls
  current session info from a mutable holder cli-agent maintains; whether the
  `state` object visible inside the graph carries enough to substitute for
  `sessionId`; what happens to LangGraph's checkpointer if tool identities
  change across turns.
- **Depth**: Intermediate (3–4 hours, with one or two prototype invocations).
- **Relevance**: Determines the integration shape in `src/agent/tools/agent-tools/<tool>.ts`.

No research is needed on:

- The upstream library's structure, license, or test approach (covered by inventory).
- LangChain `StructuredTool` basics (cli-agent already has 11 such tools).
- The configuration-loading chain (already documented in `agent-config.ts`).
- Mutation gating (already implemented for file tools).

---

## Implementation Considerations

Practical notes for the planner:

- **The single biggest decision still pending user sign-off** is the naming prefix (`agt_`). Lock it in before the plan starts so test files, doc strings, and config keys are stable.
- **Vendoring workflow needs a script.** Suggest `scripts/sync-agent-tools.sh` that fetches a SHA, copies `src/` and `LICENSE` from the upstream into `src/agent/tools/agent-tools-vendored/`, and updates `PROVENANCE.md`. Without this, drift will be invisible.
- **Permission policy bridge.** The upstream `PermissionPolicy` is a clean abstraction. Implement a single `cliAgentPermissionPolicy(cfg)` factory that delegates `checkBash` to cli-agent's allowlist, `checkFsWrite` to cli-agent's sandbox, and `scrubEnv` to its own existing logic. Pass that policy into every bundled tool's `ToolContext`. This is the single most important integration point — it's what keeps the bundled tools honoring cli-agent's security model rather than re-implementing one.
- **System-prompt section ordering.** The new block should be appended after the existing static standard-tools prose and before the user `--system` addendum, with a clear header (`## Optional standard tools (agent-tools pack)`). This keeps the existing prompt byte-stable when the pack is fully disabled.
- **Logging.** No new event kinds needed; tool calls already flow through the standard `tool_call`/`tool_result` JSONL records via the LangChain adapter. Verify that the adapter's `[<tool> error] ...` strings are captured cleanly in `tool_result.output`.
- **Test plan.** New Vitest specs:
  1. Each bundled tool (happy path + one error path).
  2. `system-prompt.spec.ts` extension: prompt contains/excludes the agent-tools section per config.
  3. `agent-config.spec.ts` extension: per-tool flags, pack umbrella, four-tier precedence.
  4. `registry.spec.ts` (new): catalog assembly under various flag combinations.
  5. Token-budget assertion (NFR-NEW-001) — see Research Topic 1.
- **Suggested first step in the plan**: spike the vendor + permission-policy bridge for `agt_grep` only (smallest, read-only, no mutation gating). Get one tool end-to-end before fanning out.

---

## References

| # | Source | URL | What was learned |
|---|---|---|---|
| 1 | Upstream README | https://github.com/BikS2013/agent-tools | Tool list (12), MIT, LangChain-ready, ships its own `buildSystemPromptBlock` helper |
| 2 | Upstream `package.json` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/package.json | `"private": true`, deps inventory, Node ≥ 20.10, ESM only |
| 3 | Upstream `src/index.ts` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/index.ts | Public exports surface; what the vendor would re-import |
| 4 | Upstream `src/categories.ts` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/categories.ts | `READ_ONLY_TOOLS`, `FS_TOOLS`, `WEB_TOOLS`, `SHELL_TOOLS`, `TODO_TOOLS` constants |
| 5 | Upstream `src/prompts/index.ts` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/prompts/index.ts | Substitution model (`${var}`), `\n\n---\n\n` separator, registration-order rendering |
| 6 | Upstream `src/tools/index.ts` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/tools/index.ts | Twelve tool exports, bundle helpers (`allTools()`, `readOnlyTools()`, etc.) |
| 7 | Upstream `read.prompt.md` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/tools/read/read.prompt.md | Sample fragment ~1.2 KB / ~250 tokens |
| 8 | Upstream `bash.prompt.md` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/tools/bash/bash.prompt.md | Largest fragment ~5–6 KB / ~1.2 K tokens |
| 9 | cli-agent `src/agent/tools/registry.ts` | local | Existing pattern for conditional tool inclusion (`bash_run` allowlist gating; `--allow-mutations` gating) |
| 10 | cli-agent `src/agent/system-prompt.ts` | local | `buildSystemPromptForCfg` is the integration point for the new block |
| 11 | cli-agent codebase scan | `docs/reference/codebase-scan-agent-tools-integration.md` | `system-prompt-blocks/` directory does NOT exist; standard-tool descriptions are inline static prose in `BUILTIN_DEFAULT_SYSTEM_PROMPT` |
| 12 | Inventory document | `docs/reference/agent-tools-inventory.md` | Per-tool bundle/skip rationale; license; dependency footprint |

---

## Original Request

The full refined request lives at
`/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/design/refined-request-agent-tools-integration.md`.

The user's literal question — *"is bundling these external tools, and the
'describe in system prompt + opt-out' pattern, the right approach?"* — is
answered above:

- **Bundling**: yes, with a curated subset (skip overlapping tools).
- **Opt-out pattern**: no, not as the user described it. Use config-flag
  gating where the registered tool set is the source of truth and the prompt
  block is derived from it. The user's "describe-and-suppress" approach
  breaks the prompt-to-catalog invariant cli-agent already holds elsewhere.
