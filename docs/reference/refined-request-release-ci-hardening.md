# Refined Request: Release CI Hardening

## Category
Development

## Objective
Harden the package release and CI posture for the current Node.js/TypeScript `cli-agent` project by adding an npm `lint` script and strengthening the `prepublishOnly` gate so release attempts run the appropriate static checks, tests, build, security audit, and package-content validation before publishing.

## Scope
- **In scope**:
  - Update `package.json` scripts related to release validation.
  - Add a runnable `npm run lint` script.
  - Update `prepublishOnly` so it runs lint, typecheck, tests, build, audit, and package-content checks as appropriate for this package.
  - Add or wire a narrowly scoped package-content check only if needed to verify the npm package payload.
  - Keep changes focused on package/release hardening.
- **Out of scope**:
  - Broad refactors of source code unrelated to release validation.
  - Changes to runtime agent behavior, provider behavior, TUI behavior, or tool execution semantics.
  - Reworking the project build system beyond what is necessary to support the requested release gate.
  - Adding new runtime dependencies unless they are strictly necessary and vetted under the project dependency-vetting rules.
  - Changing package metadata such as name, version, license, repository, or published access unless required by the package-content check.

## Requirements
1. `package.json` must define a `lint` script that can be run with `npm run lint`.
2. The lint script must be deterministic and suitable for local and CI execution.
3. `prepublishOnly` must run the release gate checks needed to prevent publishing when linting, typechecking, testing, building, security auditing, or package-content validation fails.
4. `prepublishOnly` must preserve the existing build requirement so the publishable `dist/` output is generated before package-content validation depends on it.
5. The security audit step must use the project package manager and fail on high-or-higher severity advisories unless the project already defines a stricter standard.
6. The package-content check must verify the npm publish payload, not just the working tree, and must fail if required published files such as the CLI entrypoint or package documentation are missing.
7. The package-content check must also detect obviously unintended publish payload content, such as source-only files or test artifacts, when those are not part of the intended package files list.
8. Any new script file added for package-content validation must be narrowly scoped, documented by its npm script name, and placed consistently with the existing project script layout.
9. If implementation adds or upgrades any dependency, the dependency must be vetted before it is written into the manifest and the audit result must be zero high-or-higher advisories before completion.
10. No unrelated source, documentation, configuration, or formatting changes may be included.

## Constraints
- The active project root is `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent`.
- The current project is a Node.js package with TypeScript source, `npm` scripts, `package-lock.json`, and `dist/` as the publishable output.
- Existing relevant scripts include `clean`, `build`, `typecheck`, `test`, and `prepublishOnly`.
- The current `prepublishOnly` script runs `npm run clean && npm run build && npm test` and does not run lint, audit, or package-content validation.
- No ESLint, Biome, Oxlint, or similar lint configuration was found during refinement; implementation must either use an existing suitable check or add tooling only with dependency vetting.
- Project instructions require dependency-vetting before adding or changing package dependencies and require audit validation after installation.
- Do not perform version-control operations unless explicitly requested.

## Acceptance Criteria
1. `package.json` contains a `lint` script.
2. `npm run lint` exits with status 0 on the completed change set.
3. `npm run typecheck` exits with status 0 on the completed change set.
4. `npm test` exits with status 0 on the completed change set.
5. `npm run build` exits with status 0 and produces the publishable CLI entrypoint under `dist/`.
6. The selected audit command exits with status 0 for high-or-higher severity advisories.
7. The package-content validation can be run independently through an npm script or as a clearly named step in `prepublishOnly`, and it exits with status 0 on the completed change set.
8. `npm run prepublishOnly` exits with status 0 only after running the release gate checks for lint, typecheck, tests, build, audit, and package-content validation.
9. A forced failure in any individual release gate check would cause `npm run prepublishOnly` to fail rather than continue silently.
10. The final diff is limited to release/CI hardening files and does not include unrelated refactors.

## Assumptions
- The package manager for this project is npm because `package.json` and `package-lock.json` are present and the existing scripts use npm.
- A high-or-higher audit threshold is acceptable because the project dependency-vetting rules treat high-or-above advisories as blockers.
- Package-content validation should inspect the npm package payload produced by npm packaging behavior, because the finding specifically concerns release/publish safety.
- The lint mechanism is intentionally left to implementation because the project currently has no dedicated lint configuration.
- No clarification is required before implementation because the user explicitly constrained the scope to package/release hardening.

## Open Questions
- None.

## Original Request
```text
I have this finding in the current project

  5. Release/CI posture needs hardening. package.json has no lint script and prepublishOnly does not run audit or package-content checks.
     See package.json:37.

I want you to fix it
```
