---
language: TypeScript
framework: Node.js CLI, LangGraph, Commander, Vitest
package_manager: npm
build_command: "npm run build"
test_command: "npm test"
lint_command: null
entry_points:
  - "src/cli.ts"
  - "src/commands/agent.ts"
  - "src/agent/run.ts"
last_scanned_commit: "f8bf6b41fa7e10a322c0739acb54d146a6e94233"
request_file: "docs/reference/refined-request-runtime-assembly-dedup.md"
scan_scope: "Request-driven scan for runtime assembly duplication in agent runner paths"
generated_at: "2026-06-15T10:29:34Z"
---

# Codebase Scan: Runtime Assembly Deduplication

## Metadata

- Language: TypeScript ESM.
- Package manager: npm.
- Build command: `npm run build`.
- Test command: `npm test`.
- Typecheck command: `npm run typecheck`.
- Lint command: not detected.
- Primary entry points: `src/cli.ts`, `src/commands/agent.ts`, `src/agent/run.ts`.

## Module Map

| Path | Purpose | Relevant symbols |
|---|---|---|
| `src/agent/run.ts` | Runner orchestration for one-shot, streaming, TUI bootstrap, and legacy readline interactive modes. | `runOneShotAgent`, `streamOneShotAgent`, `buildTuiAgentRuntime`, `runInteractiveAgent`, `TuiAgentRuntime` |
| `src/agent/graph.ts` | LangGraph ReAct graph builder and invoke/stream wrappers. | `buildAgentGraph`, `runOneShot`, `streamOneShot`, `AgentGraph`, `AgentStreamEvent` |
| `src/agent/providers/registry.ts` | Provider registry and LLM factory. | `createLLM` |
| `src/agent/tools/registry.ts` | LLM-visible tool catalog assembly. | `buildToolCatalog`, `ToolCatalog` |
| `src/agent/system-prompt.ts` | Runtime system prompt loading and composition. | `buildSystemPromptForCfg` |
| `src/agent/capabilities/discover.ts` | Wrapped CLI capability discovery. | `discoverAllTools`, `defaultDiscoveryReporter` |
| `src/agent/capabilities/compose-system-prompt.ts` | Capability document prompt section composition. | `composeCapabilitiesSystemPrompt` |
| `src/agent/io-capture.ts` | Optional LLM I/O capture channel. | `createIoCapture`, `IoCapture` |
| `src/agent/logging.ts` | Structured JSONL session logger. | `createLogger`, `Logger`, `CLI_VERSION` |
| `src/commands/agent.ts` | CLI command routing into streaming, TUI, or legacy interactive runners. | `runAgentCommand` |
| `src/tui/controller.ts` | TUI controller consumes `buildTuiAgentRuntime` output and owns runtime cleanup. | `TuiController` |

## Conventions

- Local imports use ESM `.js` specifiers, including TypeScript source imports such as `import { buildAgentGraph } from './graph.js'`.
- Runner code uses structured JSONL logger events and closes logger/capture channels explicitly.
- Capability discovery is gated by `cfg.tools.length > 0`.
- System prompt composition uses `buildSystemPromptForCfg(cfg, capSection, agentToolsMeta, tools)` so prompt prose tracks the actual registered tool catalog.
- Tests use Vitest and commonly mock module boundaries such as `createLLM`, `buildToolCatalog`, and command modules.

## Integration Points

### In Scope

- `src/agent/run.ts:20` through `src/agent/run.ts:365`: repeated runtime assembly sequence appears in all four runner/bootstrap exports.
- `src/agent/run.ts:53` through `src/agent/run.ts:74`, `src/agent/run.ts:162` through `src/agent/run.ts:183`, `src/agent/run.ts:291` through `src/agent/run.ts:312`, and `src/agent/run.ts:342` through `src/agent/run.ts:363`: duplicated `session_start` and `profile_active` logging.
- `src/agent/run.ts:30` through `src/agent/run.ts:51`, `src/agent/run.ts:145` through `src/agent/run.ts:160`, `src/agent/run.ts:273` through `src/agent/run.ts:289`, and `src/agent/run.ts:328` through `src/agent/run.ts:340`: duplicated LLM/catalog/discovery/prompt assembly.
- New test file near `src/agent/run.ts` or a new helper module under `src/agent/` is an appropriate integration point.

### Out of Scope

- `src/tui/slash/*.ts` graph rebuild commands: they intentionally rebuild the graph in an existing TUI session with an existing logger and mutable config; they can be revisited separately.
- `src/agent/graph.ts`: graph execution and capture semantics are already centralized and do not need refactoring for this request.
- Provider factories, tool factories, capability document generation, and CLI routing.

### Existing Implementation Status

The requested feature is partially implemented only as repeated inline sequences. No shared runtime assembly helper currently exists, so the fix should extend the existing runner layer rather than creating a parallel runner.

## Duplication Evidence

`src/agent/run.ts` repeats the same setup pattern:

```ts
const llm = createLLM(cfg);
const { tools, agentToolsMeta } = buildToolCatalog(cfg, logger);
...
await discoverAllTools(cfg, llm, logger, false, defaultDiscoveryReporter());
...
const systemPrompt = await buildSystemPromptForCfg(cfg, capSection, agentToolsMeta, tools);
...
const agentGraph = buildAgentGraph(llm, tools, systemPrompt, cfg.maxSteps, cfg);
```

This same structure appears in one-shot, streaming one-shot, TUI bootstrap, and legacy interactive paths with small lifecycle differences around prompt logging and cleanup.

## Recommended Landing

Create a shared helper in the agent layer that returns the assembled runtime:

- `agentGraph`
- `logger`
- `sessionId`
- `threadId`
- `ioCapture`
- optionally `tools`

The helper should accept the desired initial `threadId` so the TUI can keep `tui-bootstrap` while other paths can use `randomUUID()`.

## Anomalies

- `docs/reference/architecture-review-2026-06-15.md` already records the duplication finding.
- `Issues - Pending Items.md` does not yet track this specific item; the implementation should add a completed entry documenting the fix.
