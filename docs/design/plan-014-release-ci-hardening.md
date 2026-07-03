# Plan 014 — Release / CI Hardening

## Provenance

- Refined request: `docs/reference/refined-request-release-ci-hardening.md`
- Investigation: skipped — single established npm/TypeScript/Vitest release path.
- Technical research: skipped — no new technology introduced.
- Codebase scan: skipped — the user identified the release surface at `package.json`, and implementation is localized to package scripts, build config, release helper scripts, and required project documentation.

## Objective

Harden the local release gate so package publication is blocked when linting,
typechecking, tests, build, high-or-higher dependency audit, or package payload
validation fails.

## Files To Modify

- `package.json`
- `tsconfig.build.json`
- `scripts/copy-vendored-assets.mjs`
- `scripts/check-package-content.mjs`
- `README.md`
- `docs/design/project-design.md`
- `docs/design/project-functions.md`
- `Issues - Pending Items.md`

## Implementation

1. Add `npm run lint` as dependency-free TypeScript static validation.
2. Add `release:audit` using `npm audit --audit-level=high`.
3. Add `release:package` to inspect `npm pack --dry-run --json`.
4. Change `prepublishOnly` to run lint, typecheck, clean release build, tests,
   audit, and package validation.
5. Add `tsconfig.build.json` so release builds exclude specs/tests and source
   JSON that is not runtime-required.
6. Make `npm run build` clean `dist/` first so stale artifacts cannot leak.
7. Narrow postbuild asset copying to vendored `*.prompt.md` runtime assets.
8. Register the release hardening in project design, project functions, README,
   and the issue tracker.

## Validation

- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- `npm run release:audit`
- `npm run release:package`
- `npm run prepublishOnly`

## Risks

- `lint` currently aliases TypeScript static validation rather than a dedicated
  style linter. This avoids adding unvetted lint dependencies and gives the
  release gate a deterministic static-analysis step now.
- `npm run build` now cleans `dist/`; workflows relying on incremental leftover
  build artifacts should not depend on that behavior.
