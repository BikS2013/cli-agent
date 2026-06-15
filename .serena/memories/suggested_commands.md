# Suggested commands

- Typecheck (fast gate): `npm run typecheck`  (= `tsc --noEmit -p tsconfig.json`).
- Build: `npm run build`  (tsc + copy vendored assets + chmod bin).
- Test all: `npm test`  (= `vitest run`). Watch: `npm run test:watch`. Coverage: `npm run test:coverage`.
- Single test file: `npx vitest run src/path/to/file.spec.ts`.
- Run from source: `npm run dev -- <args>`  or  `npx tsx src/cli.ts <args>`.
- Run built CLI: `node dist/cli.js <args>`  (bin name `cli-agent` once linked/installed).
- Clean: `npm run clean`.
- Darwin/zsh: BSD coreutils — use `find … -maxdepth N`, avoid GNU-only flags; prefer `rg` over grep.
