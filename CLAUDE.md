<structure-and-conventions>
## Structure & Conventions

### Pre-Implementation Pipeline

Every non-trivial request flows through up to four phases BEFORE any planning, design, implementation, review, or testing work. Each phase is owned by a dedicated subagent dispatched via the Agent tool — NEVER write a phase artifact by hand: the subagent owns its template, YAML frontmatter schema, and file-naming convention (read the subagent prompt under `~/.claude/agents/` to inspect the full specification).

| Phase | Subagent | Key question | Output (under project root) | Context variable |
|---|---|---|---|---|
| 1. Request Refinement | `request-refiner` | What exactly is being asked? | `docs/reference/refined-request-<slug>.md` | `REFINED_REQUEST_FILE` |
| 2a. Investigation | `investigator` | WHICH approach should we take? | `docs/reference/investigation-<slug>.md` | `INVESTIGATION_FILE` |
| 2b. Technical Research | `technical-researcher` (one per topic; parallelize with `run_in_background: true`) | HOW does the chosen technology actually work? | `docs/research/<topic>.md` | `TECHNICAL_RESEARCH_FILES` (list) |
| 3. Codebase Scan | `codebase-scanner` | Is it already (partially) implemented, and where does the change land? | `docs/reference/codebase-scan-<slug>.md` | `CODEBASE_SCAN_FILE` |

**Shared pipeline rules** (they apply to every phase):

- Use the same `<slug>` (short, lowercase, hyphenated, derived from the request objective) across all artifacts of one request. The subagent creates `docs/reference/` / `docs/research/` if missing.
- Capture each artifact's absolute path under its context variable for the duration of the conversation.
- Pass the captured paths to EVERY downstream subagent (planner, designer, coder, reviewer, dependency-validator, test-builder, integration-verifier, etc.) with explicit lines such as: *"Read the refined request specification at `<REFINED_REQUEST_FILE>` for scope and acceptance criteria."* Likewise pass them in the context block of any skill that needs scope, approach, or structural context (`taches-cc-resources:create-plans`, `huashu-design`, `presentation-maker:create-presentation`, etc.).
- Reference all captured paths at the top of the project plan (`docs/design/plan-NNN-<description>.md`), and cite the relevant ones in the design-decision sections of `docs/design/project-design.md`, so the provenance chain (refined-request → investigation → research → scan → plan → design) is permanent and auditable.
- Phase artifacts are authoritative — never edit one during execution. If the scope changes mid-flight, re-run the producing subagent to create or update the artifact; never mutate it silently. **Sanctioned exceptions** (workflow orchestrators only): (a) appending the user's resolutions to an artifact's "Open Questions" section at an open-questions gate, and (b) the code-review phase updating the per-request design file to reflect review fixes, with each change mirrored as a dated note in `docs/design/project-design.md`. Anything beyond these two means re-running the producing subagent.
- Workflow slash commands (`/team-workflow`, `/change-workflow`, `/doc-workflow`, etc.) run all of these phases internally and produce/track their own artifacts — pass them the RAW request and do NOT pre-run any phase at the orchestrator level.
- **Explicit-skip rule:** whenever you skip a phase, state the reason briefly in your first response (e.g., "Skipping refinement — single-step read-only action.") so the user can override if they disagree.

**Phase 1 — Request Refinement** (`request-refiner`, `~/.claude/agents/request-refiner.md`)

- Required when: the request is broad, vague, or implicitly multi-step; it will trigger downstream planning/design/implementation/testing (directly or via a skill/workflow); it spans multiple files, modules, or systems; acceptance criteria are not explicitly stated; it mixes WHAT and HOW or leaves either underspecified; the deliverable will be consumed by others (documentation, research, design, infrastructure plan, etc.).
- Skip when: simple read-only or exploratory questions; trivial single-step actions; the request is already a fully-specified instruction (objective, scope, and acceptance criteria provided); a refined-request file from the current conversation already covers the new ask.

**Phase 2a — Investigation** (`investigator`, `~/.claude/agents/investigator.md` — answers WHICH)

- Required when: more than one plausible approach, technology, library, tool, or pattern could satisfy the request; the choice materially affects scope, cost, complexity, or risk; the project has no established convention for this kind of work; the user explicitly asks to investigate, evaluate options, compare, recommend, or research approaches.
- Pass it `REFINED_REQUEST_FILE` and, if available, `CODEBASE_SCAN_FILE`.

**Phase 2b — Technical Research** (`technical-researcher`, `~/.claude/agents/technical-researcher.md` — answers HOW; complementary to 2a)

- Required when: the investigation's "Technical Research Guidance" section flags `Research needed: Yes` (dispatch one agent per listed topic); the chosen technology is new to the project and implementation-level depth is needed (APIs, configuration, error handling, edge cases, best practices); the request directly names a specific library/API/SDK and asks for usage guidance, integration patterns, or a deep dive — in that case skip investigation and go straight to research; the investigation found conflicting or insufficient information about a critical implementation aspect.
- Pass each agent the topic name, focus areas, depth level, and `INVESTIGATION_FILE` (when applicable).
- Skip BOTH 2a and 2b when: a single, obvious approach already used in the project satisfies the request; the project's `CLAUDE.md`, `docs/design/project-design.md`, or an existing tool documentation already prescribes the approach; the work is a localized change (rename, bug fix, formatting, minor refactor) with a self-evident strategy; the request continues a previous workflow whose investigation/research artifacts are still valid and referenced in the current refined-request file.

**Phase 3 — Codebase Scan** (`codebase-scanner`, `~/.claude/agents/codebase-scanner.md` — read-only on the codebase)

- Required when: the request involves coding, implementation, refactoring, or modification of source files in an existing project; it might extend, replace, or duplicate existing functionality; it mentions a feature area, module, or pattern without pointing at specific files; multiple downstream subagents need a shared, consistent view of the project's structure, conventions, and build/test commands; you are about to extend a feature whose current implementation you have not read end-to-end.
- Skip when: the project is greenfield (no source files under the project root excluding `node_modules/`, `.git/`, `docs/`); the request is purely read-only with no implementation downstream; the user already pointed at the exact files, symbols, or line ranges; the task is documentation-only or design-only; a scan already exists at `docs/reference/codebase-scan-<slug>.md` whose `last_scanned_commit` matches the current `HEAD` AND whose `scanned_for_request` matches the current refined-request slug — reuse it as `CODEBASE_SCAN_FILE` instead of re-scanning.
- Dispatch with `request_file: <REFINED_REQUEST_FILE>` (this enables the request-driven "Integration Points" narrowing, classifying files as In-Scope, Out-of-Scope, or New Integration Point) and `output_path: docs/reference/codebase-scan-<slug>.md`. The file is overwritten on each scan, never merged.
- **Duplication check (mandatory after every scan):** read the scan's "Module Map" and "Integration Points" sections before launching planner/designer/coder. If the feature is already implemented → STOP and ask the user via `AskUserQuestion` whether to (a) extend the existing implementation, (b) replace it, or (c) abandon the request as already done. If partially implemented → the planner must scope the work as an extension of the existing module (citing its file/symbol locations from the scan), NOT as a parallel implementation. If the scan flags a New Integration Point → the design must explain where the new module lands, how it interacts with the existing surface, and which conventions it adopts from the scan's "Conventions" section.
- **Staleness:** the scan is stale if `last_scanned_commit` differs from the current `HEAD` AND the diff touches files in the scan's "Module Map" or "Integration Points" sections — re-run the scanner before planning; never plan against a stale scan.
- **Downstream usage:** all downstream agents read the scan's YAML frontmatter for the project's build/test/lint commands and entry points instead of re-detecting them; the planner lists each In-Scope file in the plan's "Files to modify" section and leaves Out-of-Scope modules untouched; the designer aligns new modules with the scan's "Conventions" section (citing the same file:line evidence); the coder works on the identified symbols via `mcp__serena__find_symbol` / `mcp__serena__replace_symbol_body` rather than creating files that duplicate existing ones; the test-builder takes the test framework from the scan's frontmatter instead of guessing.

### Project Artifacts & Layout

- Test scripts go in the `test_scripts` folder; create the folder if it doesn't exist.
- Plans live under `docs/design/`, one file per plan, named `plan-NNN-<indicative-description>.md`.
- The complete project design is maintained in `docs/design/project-design.md`; update it with each new design or design change.
- All reference material used for the project is collected and kept under `docs/reference/`.
- All functional requirements and feature descriptions are registered in `docs/design/project-functions.md`.
- Every prompt created while working in a project goes in a dedicated `prompts` folder (create it if missing); each prompt file name has a sequential number prefix and is representative of the prompt's use and purpose.
- Maintain `Issues - Pending Items.md` at the project root: register every issue, pending item, inconsistency, or discrepancy you detect, and whenever you fix a defect or issue, check the file for an item to remove. Pending items come first (most critical and important on top), completed items after.
- Every time you are asked to solve an issue, you must resolve it AND thoroughly document both the issue and the solution.

<configuration-guide>
- If the user asks for a configuration guide, create it at `docs/design/configuration-guide.md` and make sure it explains:
  - When multiple configuration options exist (config file, env variables, CLI params, etc.), what the options are and the priority of each one.
  - The purpose and use of each configuration variable.
  - How the user can obtain such a configuration variable.
  - The recommended approach for storing or managing the variable.
  - Which options exist for the variable and what each option means for the project.
  - Any default value the parameter has.
  - For configuration parameters that expire (e.g., PAT keys, tokens), propose adding a parameter that captures the expiration date, so the app or service can proactively warn users to renew.
</configuration-guide>

### Tools

- Tools created in the context of a project are always written in TypeScript.
- **Tool creation is MANDATORY via `/tool-conventions scaffold <tool-name>`.** Do NOT scaffold a tool's documentation file or its `~/.tool-agents/<tool-name>/` configuration folder by hand under any circumstances. The slash command dispatches the `tool-doc-config-architect` subagent (`~/.claude/agents/tool-doc-config-architect.md`), which owns the full specification — the documentation file format (the `<toolName>` XML block under `docs/tools/<tool-name>.md`), the configuration folder structure and modes (`~/.tool-agents/<tool-name>/` at `0700`, `.env` at `0600`), the four-tier env-var resolution chain (shell env → `~/.tool-agents/<name>/.env` → local `.env` → CLI flags, lowest to highest priority), the vendor-canonical LLM provider env-var names (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `AZURE_OPENAI_*`, `AZURE_AI_INFERENCE_*`, `OLLAMA_HOST`, `LITELLM_*`), and the required set of eight standard LLM providers every LLM-enabled tool must support out of the box. Read the subagent prompt to inspect the full specification. For existing tools, run `/tool-conventions audit <tool-name>` to verify conformance.
- The project's CLAUDE.md must NOT contain full tool documentation. It must contain a "Tools" section with a concise entry per tool: the tool's name, a one-or-two-sentence description of what it is capable of, and the relative path to its dedicated documentation file (e.g. `docs/tools/<tool-name>.md`) so the full documentation can be retrieved any time it is needed. The slash command produces the recommended entry text after each scaffold.
- Before writing any code script, examine the tools already implemented in the project (via the "Tools" section of the project's CLAUDE.md and the documentation under `docs/tools/`) to detect whether the planned code fits the scope of an existing tool. If so, implement it as an extension of that tool; otherwise build a generic, abstract version of the code as a new tool in the project's toolset. The goal is to progressively grow the tools needed to test, evaluate, generate data, collect information, etc., and reuse them consistently — all referenced in the project's CLAUDE.md.

### General Rules

- When asked to locate code, report the folder, the file name, the class, and the line number together with the code extract.
- Don't perform any version-control operation unless explicitly requested.
- Database table naming: table names must be singular (e.g. the table keeping customers' data is `Customer`). Tables expressing references from one entity to another may be plural when the first entity links to many of the second — so with `Customer` and `Transaction` tables, the link table is `CustomerTransactions`.
- NEVER create fallback solutions for configuration settings. Whenever a configuration setting is not provided, raise the appropriate exception — never substitute the missing value with a default or fallback. If the user explicitly asks for an exception to this rule, write the exception in the project's memory file before implementing it.

<dependency-vetting>
- Before adding ANY new runtime dependency to a project (`package.json`, `pyproject.toml`, `go.mod`, etc.), you MUST verify the version you are about to pin is free of known security advisories. Apply this rule especially to:
  - **Browser/embedded-engine packages:** `electron`, `puppeteer`, `playwright`, `chromium`, `webview2` — they ship with full browser engines and accumulate CVEs fast.
  - **Test/build toolchains:** `vitest`, `vite`, `esbuild`, `webpack`, `rollup`, `parcel` — frequent dev-server-RCE advisories with transitive impact.
  - **Network/proxy libraries:** `node-http-proxy`, `http-proxy-3`, `proxy-chain`, `axios`, `node-fetch`, `request`, `got`, `undici`.
  - **Cryptography / auth libraries:** `jsonwebtoken`, `jose`, `bcrypt`, `node-forge`, `crypto-js`.

- Vetting procedure (run BEFORE writing the dependency into the manifest):
  1. Identify the latest stable major version available on the registry (e.g. `npm view <pkg> versions --json | tail -10` or `pnpm info <pkg> versions --json`).
  2. Check the package's security advisory page (GitHub Advisory Database, npmjs.com vulnerability tab, or `npm audit --package <pkg>@<version> --json`) for the candidate version.
  3. If the candidate version has unfixed advisories at HIGH severity or above, bump to the next non-vulnerable major (or, if no such version exists, surface the trade-off to the user via AskUserQuestion before proceeding).
  4. Pin to a caret range against the verified clean version (e.g. `"electron": "^39.8.5"`, not `"electron": "^38"`).
  5. Record the vetted-on date in a one-line comment in `Issues - Pending Items.md` under a "Dependency vetting log" section so future audits can date the decision.

- For ESPECIALLY fast-moving packages (`electron`, `vite`, `vitest`, `esbuild`), ALWAYS pull the latest stable major even when a reference implementation uses an older one. The reference's version is informational, not authoritative — verify it is still on a supported branch before adopting it verbatim.

- After installing, ALWAYS run the project's audit command (`pnpm audit`, `npm audit`, `pip-audit`, `cargo audit`, `go list -m -u -json all | nancy sleuth`, etc.) and confirm the advisory count is zero before marking the scaffolding step complete. Treat any HIGH-or-above advisory as a blocker; surface it before continuing.

- When a transitive dependency carries an advisory that the direct dependency has not yet fixed (e.g. `vitest@1` pulling `vite@5` with a CVE), use the package manager's override mechanism (`pnpm.overrides`, `npm overrides`, `yarn resolutions`, `cargo [patch]`) to force the fixed transitive version, AND document the override in `Issues - Pending Items.md` with its expiry condition (i.e. "remove this override once direct-dep X reaches version Y").
</dependency-vetting>

</structure-and-conventions>

## Tools

- **cli-agent** — Generic LangGraph ReAct agent that wraps external CLI binaries, auto-introspects their `--help` trees to build capability documents, and exposes the full bash/file/web cross-cutting toolkit backed by all eight standard LLM providers. See `docs/tools/cli-agent.md`.
