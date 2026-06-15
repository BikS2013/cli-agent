# Task completion checklist

When a coding task is considered done, run in order:
1. `npm run typecheck` — must be clean (strict TS is the primary static gate; no ESLint/Prettier exists).
2. `npm test` — vitest must pass. Add/update colocated `*.spec.ts` for any changed/added behavior.
3. `npm run build` — must succeed before shipping (validates vendored-asset copy + bin chmod too).

Then per project rules, when applicable: update `docs/design/project-design.md` (living design), `docs/design/project-functions.md` (functional requirements), and `Issues - Pending Items.md` (pending items first, completed after).
