# Project Evaluation: cli-agent

Date: 2026-06-14

Refined request: `docs/reference/refined-request-project-evaluation.md`  
Codebase scan: `docs/reference/codebase-scan-project-evaluation.md`

## Executive Assessment

`cli-agent` is a mature TypeScript CLI-agent platform, not a small prototype. The architecture is coherent with the stated goal: a standalone Node.js binary wraps arbitrary CLIs, discovers capability docs, builds a LangGraph ReAct agent, and exposes controlled file/bash/web/TUI tooling. The repo shows strong engineering discipline: strict TypeScript, broad Vitest coverage, detailed design docs, tool documentation, and a living pending-items register.

The main risks are not basic correctness; they are maintenance and release-readiness risks:

1. Dependency/security backlog remains active and currently blocks a clean high-severity audit.
2. Project instructions are drifting from the current user-level conventions.
3. Runtime complexity is high enough that CI and release gates should become stricter before publishing or broader use.
4. Some known deferred UX/operational items affect polish and reliability but are already tracked.

## Verification Results

| Check | Result | Notes |
|---|---:|---|
| `npm run typecheck` | PASS | TypeScript strict compile check completed cleanly. |
| `npm test` | PASS | 80 test files, 1004 tests passed. |
| `npm run build` | PASS | TypeScript build succeeded; postbuild copied 8 runtime assets into `dist/`. |
| `npm audit --audit-level=high` | FAIL | 14 vulnerabilities reported: 9 moderate, 3 high, 2 critical. |

The test run reproduced the known Vite/esbuild duplicate-case warning in `src/tui/input/line-editor.ts:641`, already tracked in `Issues - Pending Items.md`.

## Strengths

### Clear product architecture

The project design documents the runtime flow from `src/cli.ts` through config loading, capability discovery, system prompt assembly, provider creation, tool catalog construction, graph execution, and logging (`docs/design/project-design.md:10`). The implemented CLI entry point follows that structure with Commander wiring and explicit error handling (`src/cli.ts:49`).

### Good module boundaries

The source tree is sensibly separated:

- `src/commands/` owns CLI command behavior.
- `src/config/` owns config/profile resolution.
- `src/agent/` owns graph, runtime, logging, providers, capability discovery, tools, and composites.
- `src/tui/` owns the raw terminal interface.

The top-level agent command remains small and dispatch-oriented (`src/commands/agent.ts:26`), while `src/agent/run.ts` centralizes runtime assembly for one-shot, streaming, interactive, and TUI paths (`src/agent/run.ts:20`, `src/agent/run.ts:131`, `src/agent/run.ts:265`).

### Strong safety posture

The bash execution layer uses `spawn` with explicit argv and `shell: false`, strips credential-shaped env vars, supports timeouts, and caps output (`src/agent/tools/bash/exec.ts:4`, `src/agent/tools/bash/exec.ts:104`). File tooling resolves paths against a sandbox root and rejects symlinks or paths outside the allowed root (`src/agent/tools/file/sandbox.ts:1`, `src/agent/tools/file/sandbox.ts:24`).

### Requirements and docs are unusually complete

Functional requirements cover the CLI, provider set, capability discovery, config precedence, logging, exit codes, TUI, and bash invariants (`docs/design/project-functions.md:3`, `docs/design/project-functions.md:93`, `docs/design/project-functions.md:140`). The project has a dedicated tool doc at `docs/tools/cli-agent.md`, matching the project's `AGENTS.md` Tools section (`AGENTS.md:60`).

### Test coverage is broad

The project has 80 passing Vitest spec files and over 1000 tests. Tests cover command flags, config profiles, provider registry, capability discovery/cache, prompt overlays, composite tools, TUI input/slash commands, logging, I/O capture, sandboxing, and vendored agent-tools wrappers.

## Findings

### 1. Dependency/security backlog remains release-blocking

`npm audit --audit-level=high` fails. The current audit reports 14 vulnerabilities, including high-severity issues in `esbuild`/`vite`/`vitest`/`tsx` and `langsmith`, plus critical entries in the dependency tree. This aligns with the existing pending item about dependency-tree security and deprecation backlog (`Issues - Pending Items.md:37`).

Recommendation: treat this as the top release-readiness task. Start with non-breaking `npm update` to pick up fixes already permitted by existing caret ranges, then isolate the `vitest` 2 -> 4 migration in its own branch/task because audit says force-fixing would install `vitest@4.1.8`.

### 2. Project `AGENTS.md` has instruction drift

The project `AGENTS.md` begins with an older, shorter `Structure & Conventions` chapter (`AGENTS.md:1`) and lacks the current user-level request-refinement, investigation/research, codebase-scanning, and dependency-vetting sections. This conflicts with the user-level instruction that every project `AGENTS.md` should begin with the current chapter.

Action taken: registered this as a new pending item in `Issues - Pending Items.md`.

Recommendation: replace the leading `Structure & Conventions` block in `AGENTS.md` with the current user-level version, preserving the concise `Tools` section.

### 3. No lint/static-style gate is declared

`package.json` declares build, typecheck, test, coverage, and dev scripts, but no lint script (`package.json:37`). The tests still surface an esbuild warning about a duplicate `case` clause in the TUI line editor (`src/tui/input/line-editor.ts:641`), already tracked in `Issues - Pending Items.md:5`.

Recommendation: add a lint/static-analysis gate after the dependency backlog is stabilized. At minimum, enforce no duplicate switch cases and no accidental checked-in generated/runtime asset broadening.

### 4. Build asset copy is intentionally broad

The postbuild asset copy walks `src/` and copies every `.md`, `.txt`, and `.json` file into `dist/`, excluding only a few fixture-like names (`scripts/copy-vendored-assets.mjs:11`, `scripts/copy-vendored-assets.mjs:25`). This is already tracked as a hardening suggestion (`Issues - Pending Items.md:76`).

Recommendation: narrow the copy list to known runtime assets before publishing new feature-heavy versions.

### 5. Capability cache docs and functional requirements disagree on cache invalidation nuance

The functional requirements still state capability cache invalidates on binary path, mtime, or version hash changes (`docs/design/project-functions.md:33`). The implementation now trusts an existing doc and skips all probe/version/hash checks unless the user forces refresh (`src/agent/capabilities/discover.ts:187`). The project design also still states cache validity is path/mtime/version-hash based (`docs/design/project-design.md:102`).

This may be an intentional performance tradeoff, but the requirement/design docs should explicitly reflect the new "doc-exists shortcut" behavior to avoid future agents reintroducing automatic probing.

Recommendation: update `project-design.md` and `project-functions.md` to match the current implementation or restore the documented invalidation behavior.

### 6. Configuration behavior is mostly aligned with the no-fallback rule

Provider selection raises `ConfigurationError` when no provider is supplied (`src/config/agent-config.ts:1218`). Optional toggles apply documented default starting values with comments distinguishing them from missing required config fallbacks (`src/config/agent-config.ts:1266`, `src/config/agent-config.ts:1354`). This is a good pattern and should be preserved.

Remaining risk: the known pending item for Azure key expiry warnings remains high priority (`Issues - Pending Items.md:85`).

## Prioritized Recommendations

1. Resolve or reduce the audit backlog, starting with caret-range `npm update` plus focused validation.
2. Sync `AGENTS.md` with the current user-level `Structure & Conventions` chapter.
3. Reconcile capability-cache invalidation docs vs implementation.
4. Add a lint/static-analysis gate once dependency upgrades settle.
5. Narrow `scripts/copy-vendored-assets.mjs` to explicit runtime assets.
6. Fix the duplicate TUI switch case and flaky composite temp-dir cleanup for signal-clean CI.

## Overall Verdict

The project is architecturally sound and already has the foundations of a serious CLI-agent platform. It is suitable for continued feature development, but I would not treat it as release-clean until the dependency audit backlog and documentation drift are addressed.
