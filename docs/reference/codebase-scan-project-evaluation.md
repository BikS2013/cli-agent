---
language: TypeScript
framework: Node.js CLI, Commander, LangGraph/LangChain
package_manager: npm
build_command: npm run build
test_command: npm test
lint_command: null
entry_points:
  - src/cli.ts
  - src/commands/agent.ts
  - src/agent/run.ts
  - src/tui/index.ts
last_scanned_commit: null
request_file: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/docs/reference/refined-request-project-evaluation.md
scan_scope: request-driven project evaluation
generated_at: 2026-06-14
---

# Codebase Scan: Project Evaluation

## Summary

`cli-agent` is a TypeScript npm package that builds a `cli-agent` binary. The product wraps external CLI binaries in a LangGraph ReAct agent, discovers their command surfaces through help text, and exposes a controlled cross-cutting toolkit for bash, file, web, TUI, provider, capability, profile, composite-tool, and logging workflows.

The repository is mature and feature-rich: it contains substantial design documentation, focused unit/integration tests, smoke scripts, tool documentation, and a maintained pending-items file. The main structural risk is complexity: the project now spans runtime provider wiring, terminal UI, dynamic capability discovery, configurable prompt overlays, vendored tool packs, composite tool synthesis, and LLM I/O capture.

`last_scanned_commit` is `null` because the project instructions prohibit version-control operations unless explicitly requested.

## Metadata Evidence

- Package name/version: `@biks2013/cli-agent` `0.3.0` in `package.json`.
- Runtime target: Node.js `>=22.0.0` in `package.json`.
- Binary entry: `cli-agent` maps to `dist/cli.js` in `package.json`.
- Build: `npm run build` runs TypeScript compilation plus postbuild asset copy and executable bit setup.
- Test: `npm test` runs `vitest run`.
- Typecheck: `npm run typecheck` runs `tsc --noEmit -p tsconfig.json`.
- Lint: no lint script detected in `package.json`.
- Test config: Vitest includes `src/**/*.spec.ts` and V8 coverage in `vitest.config.ts`.

## Module Map

### Root

- `package.json` — npm package metadata, scripts, dependencies, binary declaration.
- `tsconfig.json` — strict TypeScript config targeting ES2022 and NodeNext modules.
- `vitest.config.ts` — Vitest test/coverage configuration.
- `README.md` — user-facing product overview and usage guide.
- `AGENTS.md` / `CLAUDE.md` — project-level agent instructions and conventions.
- `Issues - Pending Items.md` — backlog of known issues, risk items, completed fixes, and validation notes.

### `src/`

- `src/cli.ts` — top-level Commander CLI parser and subcommand wiring.
- `src/errors.ts` — shared error classes and exit behavior.
- `src/cli-*-flags.ts` — command flag helpers for tool/profile/composite surfaces.

### `src/commands/`

- `src/commands/agent.ts` — one-shot, interactive, TUI dispatch.
- `src/commands/show-capabilities.ts` and `refresh-capabilities.ts` — capability cache inspection and regeneration.
- `src/commands/extract-tool-prompts.ts`, `show-tool-prompt.ts`, `audit-tool-prompts.ts` — prompt overlay tooling.
- `src/commands/extract-recipes.ts` — recipe extraction for capability docs.
- `src/commands/profile/*` — profile CRUD and dry-run behavior.
- `src/commands/composite/*` — composite tool list/show/delete/synthesize behavior.

### `src/config/`

- `agent-config.ts` — configuration loading, precedence, validation, and runtime config object construction.
- `profile-loader.ts`, `profile-schema.ts`, `profile-codec.ts` — profile schema and load/save behavior.

### `src/agent/`

- `run.ts` — main runtime orchestration for one-shot, streaming, interactive, and TUI flows.
- `graph.ts` — LangGraph ReAct graph creation and stream event translation.
- `system-prompt.ts` — system prompt construction and base prompt externalization.
- `logging.ts` — JSONL logging schema and redaction integration.
- `io-capture.ts` — optional request/response capture for LLM I/O inspection.
- `checkpoint-store.ts` — checkpoint persistence support.

### `src/agent/providers/`

- Provider factories and registry for `openai`, `anthropic`, `gemini`, `azure-openai`, `azure-anthropic`, `ollama`, `litellm`, and `mlx`.
- Provider utilities centralize environment handling and avoid direct provider-specific reads outside config wiring.

### `src/agent/capabilities/`

- Capability discovery, cache validation, help command execution, subcommand extraction, Markdown composition, system prompt capability injection, and man-page references.

### `src/agent/tools/`

- Native cross-cutting tool registry and types.
- File tools under `file/`, web tools under `web/`, bash tools under `bash/`.
- Tool prompt overlay support via `tool-prompts-builtin.ts` and `tool-prompt-overlay.ts`.
- Profile scoping and profile-specific tool argument support.
- `agent-tools/` wraps the curated vendored agent-tools subset.
- `agent-tools-vendored/` stores upstream-provenance source and prompt assets.

### `src/agent/composite/`

- Composite tool manifest, cache, virtual registry, stage-1/stage-2 synthesis, dispatcher, regen path, shim writer, and documentation composition.

### `src/tui/`

- Raw-mode terminal UI controller, streaming renderer, spinner, ANSI helpers, UTF-8 handling, clipboard integration, slash commands, multiline input editor, and transcript persistence.

### `test_scripts/`

- Smoke scripts and fixtures outside the main Vitest suite.
- Baselines for help output and shim synthesis.

### `docs/`

- `docs/design/` — project design, plans, functional requirements, configuration guide, design docs.
- `docs/reference/` — refined requests, scans, investigations, dependency validation, test-build, verification, inventory, and examples.
- `docs/research/` — targeted research documents.
- `docs/tools/cli-agent.md` — tool documentation reference for project agents.
- `docs/guides/` — end-user configuration and capability guides.

## Conventions Observed

- Source is TypeScript ESM with NodeNext module resolution and strict typechecking.
- Tests are colocated as `*.spec.ts` under `src/`.
- CLI behavior is separated into command modules under `src/commands/`.
- Configuration behavior is documented as "no silent fallback" for required settings.
- Cross-cutting tools are organized by domain (`bash`, `file`, `web`) and exposed through a catalog.
- Project documentation follows a phase-plan pattern under `docs/design/plan-xxx-*.md`.
- Reference artifacts are already heavily used under `docs/reference/`.
- Known issues are actively tracked in `Issues - Pending Items.md`.

## Integration Points for This Request

### In Scope

- `README.md` — primary user-facing description and usage flow.
- `package.json` — build, test, dependency, and package metadata.
- `tsconfig.json` — compile strictness and language baseline.
- `vitest.config.ts` — test configuration and coverage shape.
- `src/cli.ts` — CLI entry and command routing.
- `src/agent/run.ts` — runtime orchestration.
- `src/agent/graph.ts` — LangGraph streaming and execution seam.
- `src/config/agent-config.ts` — configuration precedence and no-fallback behavior.
- `src/agent/tools/registry.ts` — tool catalog behavior.
- `src/tui/` — TUI implementation surface.
- `src/agent/composite/` — composite tool implementation surface.
- `docs/design/project-design.md` — architectural source of truth.
- `docs/design/project-functions.md` — functional requirements source of truth.
- `docs/tools/cli-agent.md` — tool documentation source.
- `Issues - Pending Items.md` — known project risk register.

### Out of Scope

- `dist/`, `node_modules/`, coverage output, build artifacts, and package-manager cache content.
- Remediation patches to source modules.
- npm publishing or release mechanics.
- External upstream repository inspection.

### New Integration Points

- `docs/reference/project-evaluation.md` — evaluation report for this request.
- `docs/reference/refined-request-project-evaluation.md` — refined evaluation scope.
- `docs/reference/codebase-scan-project-evaluation.md` — this scan.

## Anomalies

- `AGENTS.md` begins with an older, shorter `Structure & Conventions` chapter and does not include the current user-level request-refinement, investigation/research, codebase-scanning, and dependency-vetting sections.
- The user-level instructions name `/docs/design/project-functions.MD`, while the project uses `docs/design/project-functions.md` with lowercase extension.
- No lint script is declared in `package.json`.
- A dependency/security backlog is already recorded in `Issues - Pending Items.md`, including high/critical advisory notes from a prior dependency validation.
