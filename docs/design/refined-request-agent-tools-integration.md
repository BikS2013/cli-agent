# Refined Request: Integrate `BikS2013/agent-tools` as Standard Tools in cli-agent

## Category
Development (multi-phase: investigation → feasibility assessment → design → implementation → review → testing)

## Objective
Inspect the public repository `https://github.com/BikS2013/agent-tools`, enumerate the
tools it exposes, and integrate the suitable subset into the `cli-agent` TypeScript
LangGraph ReAct agent as additional **standard cross-cutting tools** alongside the
existing `file_*`, `web_*`, `bash_*`, and `tool_help` toolkit. The integration must be
governed by a runtime opt-out mechanism that lets the user remove the new tools' system-
prompt descriptions (and ideally the tools themselves) from a given run, and must
integrate with the project's externalized / block-based system-prompt assembly.

A first-class deliverable of this work — produced **before any planning or
implementation** — is a **feasibility and rationality assessment** that evaluates whether
bundling these external tools and using the "describe in system prompt + opt-out"
pattern is the right approach, or whether a different pattern (per-tool gating via
configuration, lazy loading, dynamic prompt assembly, MCP-style external server, etc.)
should be adopted instead. The assessment must be reviewed and accepted before the
Planner phase begins, so that the resulting plan reflects the chosen approach.

## Scope

### In scope
1. Cloning / reading the upstream `agent-tools` repository and producing a complete
   inventory of every tool it exposes (name, purpose, runtime, language, dependencies,
   side-effects, mutating-vs-read-only classification, transport/interface).
2. A written feasibility & rationality assessment covering:
   - Whether each upstream tool is appropriate to bundle (license, runtime fit,
     dependency footprint, security posture, overlap with existing standard tools).
   - Whether the "embed in system prompt + opt-out" pattern is the right pattern for
     cli-agent given its current architecture, or whether a better pattern exists.
   - A recommended approach with explicit trade-offs.
3. Wrapping the accepted subset of upstream tools as native TypeScript LangChain
   `StructuredTool` (or equivalent) entries in `src/agent/tools/`, following the
   conventions already used by `file_*`, `web_*`, and `bash_*`.
4. Updating the standard-tools registry (`src/agent/tools/registry.ts`) to include the
   new tools by default, honoring the chosen opt-out mechanism.
5. Updating the system-prompt composition pipeline so that:
   - The new tools' descriptions appear by default in the assembled prompt.
   - The user can suppress the descriptions (and the tools themselves) at runtime via a
     documented mechanism that integrates with the existing prompt-assembly system
     (single-file `system-prompt.md` and/or `system-prompt-blocks/`, whichever is
     authoritative — see Open Questions §1).
6. Mutation-gating: any new tool that mutates state must be excluded unless
   `--allow-mutations` is set, consistent with FR-AGT-010.
7. Configuration surface: CLI flag(s), env var(s), and `config.json` key(s) for the
   opt-out, following the four-tier precedence chain (FR-AGT-011).
8. Documentation updates:
   - `docs/design/project-design.md` — extend §4 (Tool Catalog) and §5a/§5
     (System Prompt) to describe the new standard tools and the opt-out mechanism.
   - `docs/design/project-functions.md` — register new functional requirements
     (`FR-AGT-NNN`).
   - `docs/design/configuration-guide.md` — document the new flags / env vars.
   - `docs/tools/cli-agent.md` — extend the tool catalog reference.
   - `docs/reference/` — drop a copy of the upstream inventory as reference material.
9. Test coverage:
   - Unit tests for each new wrapped tool.
   - Integration tests for the opt-out mechanism (presence/absence of tool, presence/
     absence of description in the composed system prompt).
   - Regression test that the existing 104+ test suite still passes.
10. Updating `Issues - Pending Items.md` with anything deferred during the work.

### Out of scope
- Forking, modifying, or contributing back to the upstream `BikS2013/agent-tools`
  repository.
- Re-architecting the existing capability-discovery pipeline (`discoverAllTools`,
  capability cache) — this work concerns *standard cross-cutting* tools, not
  wrapped-CLI capability documents.
- Adding new LLM providers, changing the provider registry, or altering the eight
  mandatory log event kinds.
- Reworking the TUI subsystem beyond the minimal slash-command additions needed to
  toggle the opt-out at runtime (if the chosen pattern requires it).
- Bundling upstream tools whose runtime is incompatible with a Node.js / TypeScript
  process (e.g., tools that require a separate Python interpreter), unless the
  feasibility assessment explicitly recommends a sidecar pattern and the user approves
  it.

## Requirements

### Functional

1. **FR-NEW-001 — Upstream inventory deliverable.** The investigation phase must
   produce a Markdown document at `docs/reference/agent-tools-inventory.md` listing,
   for each tool in `BikS2013/agent-tools`: tool name, one-line purpose, full
   description, runtime/language, package dependencies, transport/interface (function
   call, CLI subprocess, HTTP, etc.), input/output schema, mutating-vs-read-only
   classification, license, and a "bundle / skip / sidecar" recommendation with
   rationale.

2. **FR-NEW-002 — Feasibility & rationality assessment deliverable.** A document at
   `docs/design/feasibility-agent-tools-integration.md` must be produced and reviewed
   **before the Planner phase**. It must contain:
   - Summary verdict (recommended approach in one paragraph).
   - Evaluation of the "embed in system prompt + opt-out" pattern: pros, cons,
     concrete failure modes, prompt-bloat impact (estimated token cost), latency and
     cost implications.
   - At least three alternative patterns evaluated side-by-side:
     a) per-tool gating via configuration (current `--tool` style),
     b) lazy/just-in-time tool registration triggered by an explicit user opt-in or
        by a small bootstrap-tool the LLM calls,
     c) dynamic prompt assembly based on declared "tool packs" (named bundles
        toggled per run),
     plus any additional pattern the analyst considers relevant (e.g., MCP server,
     LangGraph subgraph dispatch).
   - A scoring matrix on dimensions: prompt-token cost, runtime cost, complexity,
     security-blast-radius, user-experience, alignment with existing
     `<standard_conventions>` block, alignment with the externalized system-prompt
     architecture, reversibility.
   - A concrete recommendation including the opt-out mechanism's surface (flag,
     env var, config key, slash command).
   - Explicit acknowledgement of risks and rejected options.

3. **FR-NEW-003 — Phase gate before planning.** The user must sign off on the
   feasibility assessment before any `plan-xxx-*.md` file is created. If the
   assessment recommends an approach different from "embed in system prompt + opt-out",
   the rest of this specification is treated as a *target outcome description* and the
   plan must reflect the recommended approach instead.

4. **FR-NEW-004 — Standard-tool wrapping.** Every accepted upstream tool must be
   exposed to the LLM as a first-class LangChain tool registered through
   `src/agent/tools/registry.ts`, with:
   - A stable, snake_cased tool name following the existing naming pattern
     (`<group>_<verb>` or `<group>_<noun>`, e.g., `agt_<name>`).
   - A typed Zod input schema and a documented output shape.
   - Logging compliant with the existing JSONL schema (`tool_call`, `tool_result`).
   - Honoring the bash sandbox / file sandbox / web header rules wherever applicable.

5. **FR-NEW-005 — System-prompt description block.** The new tools' descriptions
   must be assembled into the system prompt through the same mechanism that produces
   the existing `<standard_conventions>` block. The exact integration point depends on
   the prompt-assembly architecture (Open Question §1) but must respect:
   - Composition order remains: base text + capabilities section + `--system-file` +
     `--system` (per FR-AGT-008).
   - The new block is byte-stable across runs unless the opt-out toggles it.

6. **FR-NEW-006 — Runtime opt-out mechanism.** The user must be able to disable the
   new tools (and their description block) for a given run via at least:
   - A CLI flag (e.g., `--no-agent-tools` or `--disable-tool-pack agent-tools`).
   - An env var (e.g., `CLI_AGENT_DISABLE_AGENT_TOOLS=1`).
   - A `config.json` key.
   - A TUI slash command (e.g., `/tools pack agent-tools off|on`) if the chosen
     pattern requires interactive toggling.
   The four sources must obey the project's standard four-tier precedence
   (FR-AGT-011). Granularity (whole pack vs. per-tool) is to be set by the
   feasibility assessment.

7. **FR-NEW-007 — Mutation gating compliance.** Any tool wrapped from the upstream
   that performs writes, network mutations, or out-of-sandbox effects must be
   excluded from the LLM-visible catalog when `--allow-mutations` is off, mirroring
   FR-AGT-010 for `file_write`/`file_edit`/`file_append`.

8. **FR-NEW-008 — No silent fallbacks.** If a configuration value related to the new
   tools is required and missing (e.g., an API key for a tool that needs one), the
   agent must raise a `ConfigurationError` (exit code 3). No defaults, no fallbacks
   (per project convention).

9. **FR-NEW-009 — Documentation registration.** New tools and the opt-out mechanism
   must be registered in `docs/design/project-functions.md` (as `FR-AGT-NNN` entries),
   `docs/design/project-design.md` (Tool Catalog table + Configuration section), and
   `docs/design/configuration-guide.md` (full variable description per the
   configuration-guide template).

### Non-functional

10. **NFR-NEW-001 — Prompt-token budget.** The new description block's token
    contribution must be measured and reported; the feasibility assessment must
    state an upper bound and the implementation must verify it (e.g., a unit test
    asserting `tokens(block) <= N`).

11. **NFR-NEW-002 — Startup latency.** Adding the new tools must not increase
    cold-start time of `cli-agent --help` or a one-shot run by more than a small,
    quantified threshold to be set in the feasibility assessment (target: < 100 ms
    additional, subject to revision).

12. **NFR-NEW-003 — Dependency footprint.** Any new npm dependency pulled in by the
    integration must be justified in the feasibility assessment. Tools whose
    integration would require heavyweight or duplicative dependencies must default
    to "skip" or "sidecar" recommendations.

13. **NFR-NEW-004 — Security posture.** Each wrapped tool must be reviewed against
    the project Security Model (project-design §7): allowlist enforcement, sandbox
    roots, credential redaction, child-env stripping. Deviations must be documented.

## Constraints

- **Language**: TypeScript only. New tools must be implemented in TS, not bound via
  Python or other-runtime sidecars unless the feasibility assessment explicitly
  recommends and the user approves.
- **LangGraph stack**: New tools must be standard LangChain `StructuredTool` /
  `tool()` instances compatible with `createReactAgent` from
  `@langchain/langgraph/prebuilt`.
- **Provider-agnostic**: Tools must work across all eight supported providers without
  provider-specific code.
- **Existing patterns**: Follow the layout under `src/agent/tools/` (one
  module per tool group), the registry pattern in
  `src/agent/tools/registry.ts`, the logging redaction in `redactString`, and the
  configuration loading in `src/config/agent-config.ts`.
- **No version-control operations** unless the user explicitly requests them.
- **No fallback for required configuration** — raise `ConfigurationError` instead.
- **Tool-doc convention**: Per current CLAUDE.md, project tool documentation lives
  under `docs/tools/<tool-name>.md`. The new tools are *components inside* the
  existing `cli-agent` tool, so they extend `docs/tools/cli-agent.md` rather than
  spawning a new tool doc — the `/tool-conventions scaffold` command is NOT to be
  invoked for these.
- **Upstream license**: Bundling is contingent on the upstream license permitting
  redistribution / derivative works. The investigation phase must check and report
  the license.

## Acceptance Criteria

1. `docs/reference/agent-tools-inventory.md` exists and covers every tool in the
   upstream repo with the fields listed in FR-NEW-001.
2. `docs/design/feasibility-agent-tools-integration.md` exists, covers the points
   listed in FR-NEW-002, and has been explicitly approved by the user (the approval
   is recorded as a note at the top of the file).
3. A plan file `docs/design/plan-xxx-agent-tools-integration.md` exists, references
   the approved feasibility document, and was created **after** approval.
4. For each accepted upstream tool:
   - A TypeScript module exists under `src/agent/tools/` with a Zod input schema and
     a typed implementation.
   - The tool is registered in `src/agent/tools/registry.ts` and is visible to the
     LLM by default.
   - A unit test in `test_scripts/` (or the project's existing test directory)
     exercises happy-path and one error path.
5. The system-prompt assembly emits the new description block by default; with the
   opt-out engaged, the block is absent from the composed prompt AND the tools are
   absent from the LLM-visible catalog. Both behaviors are covered by automated
   tests.
6. The opt-out is reachable from at least: a CLI flag, an env var, a `config.json`
   key, and (if required) a TUI slash command. Precedence follows FR-AGT-011 and is
   verified by a test.
7. Mutating tools are absent from the catalog when `--allow-mutations` is off,
   verified by a test.
8. `docs/design/project-design.md`, `docs/design/project-functions.md`,
   `docs/design/configuration-guide.md`, and `docs/tools/cli-agent.md` are updated
   coherently.
9. `npm test` (or the project's test runner) passes with all new tests added and the
   existing 104+ tests still green.
10. `Issues - Pending Items.md` is updated with any deferrals encountered during the
    work, ranked by criticality.
11. The token-budget assertion (NFR-NEW-001) is implemented as a test and passes.

## Assumptions

- **A1**: The upstream `BikS2013/agent-tools` repository is publicly accessible and
  can be cloned over HTTPS without authentication. If not, the investigation phase
  will pause and request credentials.
- **A2**: The upstream is a Node/TypeScript project, or at least one whose tools can
  be invoked from Node. If a significant portion is Python-only, the feasibility
  assessment will recommend a sidecar pattern or skip those tools.
- **A3**: The user wants the new tools enabled **by default** (opt-out semantics),
  matching the wording of the raw request. If opt-in semantics are preferred, the
  feasibility assessment will surface this as a recommendation.
- **A4**: "Standard tools" in the raw request means the same category as
  `file_*`/`web_*`/`bash_*` — i.e., always-on cross-cutting tools registered in
  `src/agent/tools/registry.ts`, NOT wrapped-CLI tools that go through the
  capability-discovery pipeline.
- **A5**: The opt-out granularity is at the *pack* level (all-or-nothing for the
  bundle); per-tool granularity is desirable but secondary. The feasibility
  assessment may revise this.
- **A6**: The new prompt block is small enough that the existing one-file
  externalized prompt (`~/.tool-agents/cli-agent/capabilities/system-prompt.md`)
  does not need to be split. If the block is large or composed conditionally, the
  feasibility assessment will recommend introducing a `system-prompt-blocks/`
  directory pattern.

## Open Questions

1. **System-prompt assembly architecture (factual divergence to resolve early).**
   The raw request states that system-prompt externalization "is now assembled from
   named capability blocks in `system-prompt-blocks/`". The current
   `docs/design/project-design.md` §5a and `docs/design/project-functions.md`
   FR-AGT-008a describe a **single externalized file** (`system-prompt.md`), with no
   mention of a `system-prompt-blocks/` directory. The investigation phase must
   reconcile this by inspecting `src/agent/system-prompt.ts`,
   `src/agent/capabilities/compose-system-prompt.ts`, and the
   `~/.tool-agents/cli-agent/capabilities/` layout, and treat whichever it finds as
   authoritative. The integration must hook into the *actual* mechanism in code, not
   the one described in the request. If the request's description is the *intended
   future state*, the work must either implement the block-based system first or
   build the integration on the current single-file mechanism and migrate later.

2. **Per-tool vs. pack-level opt-out.** Should the user be able to disable individual
   tools from the upstream pack, or only the whole pack? Default assumption is
   pack-level (A5) but the feasibility assessment should make a recommendation.

3. **Naming prefix for the new tools.** `agt_*`, `at_*`, or no prefix at all (rely
   on the upstream tool names)? The feasibility assessment should propose one and
   the implementation should follow it.

4. **What to do with upstream tools that overlap existing standard tools** (e.g., if
   `agent-tools` ships a file-reader that overlaps `file_read`)? Skip, alias, or
   replace? Default assumption: skip overlapping tools, document the decision in the
   inventory.

5. **Distribution model**: vendor the upstream code into `src/agent/tools/agent-tools-vendored/`,
   add it as an npm dependency (if it is a published package), or use a git
   submodule? Decision belongs in the feasibility assessment.

## Original Request

```
I want you to study the tools in this https://github.com/BikS2013/agent-tools
repository and embed them as standard tools in the cli-agent project (currently at
/Users/giorgosmarinos/aiwork/coding-platform/cli-agent).

I want these tools to be described in the default system-prompt of the cli-agent,
with a mechanism that allows the user to exclude them — i.e., the user should be
able to remove their descriptions from the prompt at runtime.

I also want a feasibility and rationality assessment of this approach: is it
sensible to bundle these external tools, and is the "describe in system prompt +
opt-out" pattern the right pattern, or are there better alternatives (e.g.,
per-tool gating via configuration, lazy loading, dynamic prompt assembly, etc.)?

Important context:
- cli-agent is a TypeScript LangGraph ReAct agent (see CLAUDE.md and
  docs/design/project-design.md in the project).
- cli-agent already has a `<standard_conventions>` block in its system prompt that
  documents standard cross-cutting tools (file_*, web_*, bash). The new tools
  should follow the same pattern.
- The agent-tools repo at https://github.com/BikS2013/agent-tools needs to be
  inspected to enumerate what tools it exposes, what runtime they require (Node?
  Python?), what their interfaces are, and what dependencies they pull in. This
  inventory is part of the refinement work.
- The cli-agent project recently completed a system-prompt externalization (see
  docs/design/project-functions.md and the
  refined-request-system-prompt-externalization.md document) — the prompt is now
  assembled from named capability blocks in `system-prompt-blocks/`. The opt-out
  mechanism for the new tools should integrate with that block-based assembly
  system.
- The user wants the FEASIBILITY ASSESSMENT to be a first-class output of the
  workflow — not just an implementation. If the answer is "this approach is
  wrong, do X instead", that needs to be raised before Phase 4 (Planner) so the
  plan reflects the right approach.
```
