# Conventions

- Tests colocated as `<name>.spec.ts` beside source; vitest. Integration/e2e specs named `*-e2e.spec.ts` or `integration-*.spec.ts`.
- NO fallback values for missing config — throw a typed error from `src/errors.ts`. Hard project rule; do not substitute defaults.
- LLM provider env-vars are vendor-canonical: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `AZURE_OPENAI_*`, `AZURE_AI_INFERENCE_*`, `OLLAMA_HOST`, `LITELLM_*`. Four-tier resolution (lowest→highest): shell env → `~/.tool-agents/<name>/.env` → local `.env` → CLI flag.
- Per-tool LLM-usage instructions are markdown overlays injected at registry build (`src/agent/tools/tool-prompt-overlay.ts`, `tool-prompts-builtin.ts`). Vendored agent-tools keep upstream `*.prompt.md` — do NOT hand-edit anything under `src/agent/tools/agent-tools-vendored/upstream/` (see its `PROVENANCE.md`).
- Secrets must pass through `src/util/redact.ts` before any logging/printing.
- New tools must be TypeScript, documented at `docs/tools/<name>.md` with a concise CLAUDE.md "Tools" entry — scaffolded via the `tool-doc-config-architect` agent, never by hand.
- System prompt is composed from capability docs (`src/agent/capabilities/compose-system-prompt.ts`) + base (`src/agent/system-prompt.ts`); capability docs are generated from external CLI `--help` and cached (invalidate via `src/agent/capabilities/invalidate.ts`).
