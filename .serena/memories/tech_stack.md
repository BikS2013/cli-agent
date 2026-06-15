# Tech stack

- Language: TypeScript 5.9, strict mode. Notable flags: `strict`, `noImplicitOverride`, `noUncheckedIndexedAccess` ON; `exactOptionalPropertyTypes` OFF; `useUnknownInCatchVariables` ON. ESM + NodeNext module resolution. Target ES2022. Node >= 22.
- Agent framework: LangGraph (`@langchain/langgraph` ^1.2) + `@langchain/core` ^1.1. Provider SDKs: `@langchain/openai` ^1.4, `@langchain/anthropic` ^1.3, `@langchain/google-genai` ^2.1.
- CLI: `commander` ^12. Validation/schema: `zod` ^3.25. Globbing: `fast-glob` + `ignore`. YAML: `yaml` ^2.8.
- Build: `tsc` → `dist/`, then `scripts/copy-vendored-assets.mjs` (copies vendored `*.prompt.md`), then chmod +x bin.
- Tests: `vitest` ^2.1 (colocated `*.spec.ts`). Coverage: `@vitest/coverage-v8`. Dev runner: `tsx`.
- Package manager: npm (package-lock.json). No ESLint/Prettier configured — TS strict mode is the static gate.
