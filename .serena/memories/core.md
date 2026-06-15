# Core — cli-agent source map

Generic LangGraph ReAct agent that wraps external CLI binaries, auto-introspects their `--help` trees into capability docs, and exposes a bash/file/web toolkit across 8 LLM providers. Published as `@biks2013/cli-agent` (bin: `cli-agent`). Entry: `src/cli.ts` → `dist/cli.js`.

## Project-wide invariants
- TypeScript ESM (`"type":"module"`, NodeNext, target ES2022). Source under `src/`, compiled to `dist/`. Node >= 22.
- NO fallback/default values for missing configuration — raise a typed error instead (hard project rule; enforced in `src/config/`, errors in `src/errors.ts`).
- Eight standard LLM providers must all stay supported: openai, anthropic, gemini, azure-openai, azure-anthropic, ollama, mlx, litellm (`src/agent/providers/`).
- Tests are colocated `*.spec.ts` beside sources, run via vitest. See `mem:tech_stack`, `mem:conventions`, `mem:suggested_commands`, `mem:task_completion`.

## Source map (src/)
- `cli.ts` — Commander program; root entry, registers subcommands & global flags (large, ~33k).
- `cli-agent-tools-flags.ts`, `cli-composite-flags.ts`, `cli-profile-flags.ts` — flag-group builders attached to subcommands.
- `agent/` — ReAct agent core:
  - `run.ts` — agent run loop / invocation entry. `graph.ts` — LangGraph ReAct graph construction.
  - `system-prompt.ts` — assembles the system prompt sent to the LLM.
  - `logging.ts` (+ `logging.spec.ts`) — structured agent event logging (LLM calls, tool calls). KEY for any LLM-I/O-capture work.
  - `checkpoint-store.ts` — LangGraph checkpointer (thread/conversation persistence).
  - `capabilities/` — introspect external CLI `--help` → capability markdown → system prompt: `discover.ts`, `runHelp.ts`, `extractSubcommands.ts`, `composeMarkdown.ts`, `compose-system-prompt.ts`, `manref.ts`, `cache.ts`, `invalidate.ts`.
  - `providers/` — one module per LLM provider + `registry.ts`, `types.ts`, `util.ts`.
  - `tools/` — toolkit exposed to the LLM: `bash/`, `file/`, `web/`, vendored `agent-tools/` (glob/grep/patch/multiedit/todo). `registry.ts` assembles them; `tool-prompt-overlay.ts` + `tool-prompts-builtin.ts` inject per-tool usage instructions; `tool-help-tool.ts`.
  - `composite/` — composite (multi-CLI) tool synthesis pipeline (stage1/stage2/synthesizer/dispatcher/manifest/shim-writer/virtual-registry).
- `config/` — `agent-config.ts` (resolution; no fallbacks) + profiles (`profile-schema.ts`, `profile-codec.ts`, `profile-loader.ts`).
- `commands/` — subcommand impls: `agent.ts`, capability/recipe/tool-prompt commands, `composite/`, `profile/`.
- `tui/` — raw-mode terminal chat UI: `controller.ts`, `index.ts`, `input/` (line-editor, keybindings), `slash/` (commands incl. `memory.ts`, `model.ts`, `provider.ts`, `tools.ts`, `tool-help.ts`), `transcript/` (`persist.ts`, `types.ts` — conversation transcript persistence), `spinner.ts`, `clipboard.ts`, `ansi.ts`.
- `util/redact.ts` — secret redaction helper (use before logging/printing anything that may contain secrets).

## Docs
`docs/design/project-design.md` (living design), `docs/design/project-functions.md` (functional reqs), `docs/design/plan-NNN-*.md`, `docs/tools/cli-agent.md` (tool doc), `Issues - Pending Items.md` (root). Per-feature workflow artifacts under `docs/reference/`.
