---
status: deprecations_found
mode: fix
package_manager: npm
ecosystem: node
iterations_run: 1
deprecations_initial: 1
deprecations_final: 1
vulnerabilities_initial: 12
vulnerabilities_final: 12
target_path: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent
validated_at: 2026-05-02T16:08:58Z
last_validated_commit: 5144a73f999abff6d9bdc731de1c0b2d36308bef
---

# Dependency Validation — cli-agent (config-profiles)

## 1. Summary

Validated the npm dependency tree of `@biks2013/cli-agent` at commit `5144a73` following the addition of `yaml ^2.8.4` as a new runtime dependency. The newly added `yaml@2.8.4` package is **clean** — no deprecation, no vulnerability. One transitive deprecation (`glob@10.5.0`) and twelve moderate security vulnerabilities were found in the pre-existing dependency tree. All identified fixes require major-version migrations, which exceed the safe auto-fix boundary defined by the agent's invariants. No automatic replacements were applied; all items are routed to "Manual Review Needed".

## 2. Initial State

### 2a. Deprecations

| Package | Current Version | Scope | Severity | Deprecation Message | Parent Chain |
|---------|----------------|-------|----------|---------------------|--------------|
| `glob` | 10.5.0 | transitive | info | "Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update." | `@vitest/coverage-v8@2.1.9` → `test-exclude@7.0.2` → `glob@10.5.0` |

### 2b. New Dependency (yaml — the trigger for this validation run)

| Package | Resolved Version | Scope | Status |
|---------|-----------------|-------|--------|
| `yaml` | 2.8.4 | direct (runtime) | **Clean** — no deprecation, no vulnerability, current within its semver range |

### 2c. Packages with Newer Versions Available (npm outdated, non-vulnerability)

The following direct dependencies have newer versions available outside the pinned semver range (informational only — not auto-fixed):

| Package | Current | Wanted (in range) | Latest | Notes |
|---------|---------|-------------------|--------|-------|
| `@langchain/core` | 1.1.42 | 1.1.43 | 1.1.43 | Minor patch; within `^1.1.42` range |
| `@langchain/google-genai` | 2.1.29 | 2.1.30 | 2.1.30 | Minor patch; within `^2.1.29` range |
| `@types/node` | 22.19.17 | 22.19.17 | 25.6.0 | Major version jump (22→25); dev dep |
| `@vitest/coverage-v8` | 2.1.9 | 2.1.9 | 4.1.5 | Major version jump (2→4); dev dep |
| `commander` | 12.1.0 | 12.1.0 | 14.0.3 | Major version jump (12→14); runtime |
| `typescript` | 5.9.3 | 5.9.3 | 6.0.3 | Major version jump (5→6); dev dep |
| `vitest` | 2.1.9 | 2.1.9 | 4.1.5 | Major version jump (2→4); dev dep |
| `zod` | 3.25.76 | 3.25.76 | 4.4.2 | Major version jump (3→4); runtime |

## 3. Replacements Applied

No replacements were applied. All identified issues require major-version migrations, which are excluded from auto-fix per invariant: "Never bump major versions silently. Auto-replacements are only for: (a) deprecated package → recommended replacement named in the deprecation message, or (b) patch/minor version bumps for security advisories."

## 4. Manual Review Needed

### MR-1: `glob@10.5.0` — Transitive deprecation via @vitest/coverage-v8

**Why it cannot be auto-fixed:** `glob@10.5.0` is a transitive dependency pulled in via the chain `@vitest/coverage-v8@2.1.9` → `test-exclude@7.0.2` → `glob@10.5.0`. Direct manipulation of transitive dependencies is prohibited. The only way to fix this is to update the parent `@vitest/coverage-v8` to version `4.1.5`, which is a major version jump (2.x → 4.x).

**Recommended next step:** Evaluate a coordinated migration of both `vitest` and `@vitest/coverage-v8` from 2.x to 4.x. This is a non-trivial migration — review the vitest v3 and v4 changelogs for breaking changes before proceeding. The migration also resolves MR-2 below (vite/esbuild vulnerabilities).

---

### MR-2: `vitest@2.1.9` + `@vitest/coverage-v8@2.1.9` — Security vulnerabilities (moderate)

**Affected packages (transitive chain):** `vitest` → `vite@5.4.21` → `esbuild@0.21.5`; `vitest` → `@vitest/mocker` → `vite`.

**Advisories:**
- `vite <=6.4.1`: GHSA-4w7w-66w2-5vf9 — "Vite Vulnerable to Path Traversal in Optimized Deps `.map` Handling" (CWE-22, CWE-200; CVSS 0.0 — score not published)
- `esbuild <=0.24.2`: GHSA-67mh-4wv8-2f99 — "esbuild enables any website to send any requests to the development server and read the response" (CWE-346; CVSS 5.3)

**Why it cannot be auto-fixed:** `npm audit` reports the fix as `vitest@4.1.5` with `isSemVerMajor: true`. Both vulnerabilities are in dev-only tools (test runner and build tool for tests). The severity is moderate. Impact is limited to the development environment (not the published `dist/`).

**Recommended next step:** Plan a dedicated migration sprint for `vitest 2.x → 4.x` (simultaneously updating `@vitest/coverage-v8`, `@types/node`, and related dev tooling). Review vitest migration guides at https://vitest.dev/. The existing test suite should be used as the regression gate.

---

### MR-3: `@langchain/anthropic@1.3.28` — Security vulnerability via `@anthropic-ai/sdk` (moderate)

**Advisory:** GHSA-p7fg-763f-g4gf — "Claude SDK for TypeScript has Insecure Default File Permissions in Local Filesystem Memory Tool" (CWE-732; affects `@anthropic-ai/sdk@0.79.0–0.91.0`). Current installed version: `@anthropic-ai/sdk@0.90.0`.

**Why it cannot be auto-fixed:** `npm audit` reports the fix as `@langchain/anthropic@1.3.26` with `isSemVerMajor: true`. However, `1.3.26` is a **downgrade** from the currently installed `1.3.28` and also pins `@anthropic-ai/sdk@^0.74.0`, which resolves to a version that is also within the vulnerable range — meaning the suggested npm fix does not actually resolve the advisory. The real fix requires `@anthropic-ai/sdk >=0.91.1` to be consumed by `@langchain/anthropic`. As of this validation, no published `@langchain/anthropic` 1.x release pins `@anthropic-ai/sdk@^0.91.x`. The upstream package must publish an updated release.

**Recommended next step:** Monitor `@langchain/anthropic` releases for a version that raises the `@anthropic-ai/sdk` dependency floor to `>=0.91.1`. Until then, assess actual exploitability: the advisory targets the "Local Filesystem Memory Tool" feature; if cli-agent does not use that feature, exploitability is zero in practice. Track https://github.com/advisories/GHSA-p7fg-763f-g4gf for upstream resolution.

---

### MR-4: `@langchain/langgraph@1.2.9` — Security vulnerabilities via `uuid` (moderate)

**Affected transitive chain:** `@langchain/langgraph@1.2.9` → `@langchain/langgraph-checkpoint@1.0.1` → `uuid@10.0.0`; `@langchain/langgraph@1.2.9` → `@langchain/langgraph-sdk@1.8.9` → `uuid@13.0.0`.

**Advisory:** GHSA-w5hq-g745-h8pq — "uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided" (CWE-787, CWE-1285; CVSS not published). Fixed in `uuid >=14.0.0`.

**Why it cannot be auto-fixed:** `npm audit` reports the fix as `@langchain/langgraph@0.0.12` with `isSemVerMajor: true`. That is a catastrophic **downgrade** from 1.2.9 to 0.0.12 (from a completely different era of the package). The real fix requires `@langchain/langgraph` (and its sub-packages) to update their internal `uuid` dependency from `^10.0.0` to `>=14.0.0`. As of this validation, `@langchain/langgraph@1.2.9` is the latest 1.x release and still pins `uuid@^10.0.0`. A `npm overrides` entry could force `uuid` to `^14.0.0`, but this risks API breakage inside langgraph if the `uuid` v14 API differs from v10 in ways langgraph relies on.

**Recommended next step:** Monitor `@langchain/langgraph` releases for an update that raises the `uuid` dependency to `>=14.0.0`. As a lower-risk intermediate step, evaluate adding a `overrides` entry in `package.json` after reviewing uuid v10→v14 changelog for breaking changes. Track https://github.com/advisories/GHSA-w5hq-g745-h8pq.

---

### MR-5: Outdated direct dependencies with major-version upgrades available

The following are informational — not vulnerabilities or deprecations, but represent significant version lag:

| Package | Current | Available | Risk of staying behind |
|---------|---------|-----------|------------------------|
| `zod` | 3.25.76 | 4.4.2 | Low (3.x is actively maintained; security record is clean) |
| `commander` | 12.1.0 | 14.0.3 | Low (stable CLI library; no security history) |
| `@types/node` | 22.19.17 | 25.6.0 | Low (dev-only type definitions) |
| `typescript` | 5.9.3 | 6.0.3 | Low (compiler; no runtime impact) |

## 5. Security Audit

Audit performed with `npm audit --json` (npm 11.12.1). All 12 vulnerabilities are **moderate** severity. No high or critical severity vulnerabilities found.

| # | Package | Type | Severity | Advisory | Fixed In | Direct? | Viable Auto-Fix? |
|---|---------|------|----------|----------|----------|---------|------------------|
| 1 | `@langchain/anthropic` | Insecure file permissions in memory tool | moderate | GHSA-p7fg-763f-g4gf | Upstream must release | yes | No — no viable 1.x fix exists yet |
| 2 | `@anthropic-ai/sdk` | Insecure file permissions in memory tool | moderate | GHSA-p7fg-763f-g4gf | `>=0.91.1` | no (parent: @langchain/anthropic) | No — transitive |
| 3 | `@langchain/langgraph` | uuid buffer bounds check | moderate | GHSA-w5hq-g745-h8pq | Major downgrade only | yes | No — fix is catastrophic downgrade |
| 4 | `@langchain/langgraph-checkpoint` | uuid buffer bounds check | moderate | GHSA-w5hq-g745-h8pq | Parent update needed | no | No — transitive |
| 5 | `@langchain/langgraph-sdk` | uuid buffer bounds check | moderate | GHSA-w5hq-g745-h8pq | Parent update needed | no | No — transitive |
| 6 | `uuid` | Missing buffer bounds check in v3/v5/v6 | moderate | GHSA-w5hq-g745-h8pq | `>=14.0.0` | no (parent: langgraph packages) | No — transitive |
| 7 | `vitest` | vite path traversal + esbuild CORS | moderate | GHSA-4w7w-66w2-5vf9, GHSA-67mh-4wv8-2f99 | `vitest@4.1.5` | yes | No — major version jump (2→4) |
| 8 | `@vitest/coverage-v8` | via vitest | moderate | GHSA-4w7w-66w2-5vf9 | `4.1.5` | yes | No — major version jump (2→4) |
| 9 | `@vitest/mocker` | via vite | moderate | GHSA-4w7w-66w2-5vf9 | Parent update needed | no | No — transitive |
| 10 | `vite` | Path traversal + CORS | moderate | GHSA-4w7w-66w2-5vf9, GHSA-67mh-4wv8-2f99 | `>=6.4.2` | no (parent: vitest) | No — transitive |
| 11 | `vite-node` | via vite | moderate | GHSA-4w7w-66w2-5vf9 | Parent update needed | no | No — transitive |
| 12 | `esbuild` | CORS bypass via dev server | moderate | GHSA-67mh-4wv8-2f99 | `>=0.25.0` | no (parent: vite) | No — transitive |

**Note on exploitability context:**
- Vulnerabilities #7–#12 (vitest/vite/esbuild chain) are **dev-only** — they affect the test/dev toolchain, not the published `dist/` bundle shipped to end users. Exploitation requires an attacker to have access to a running `vite` dev server on the developer's machine.
- Vulnerabilities #1–#2 (`@anthropic-ai/sdk`) target the "Local Filesystem Memory Tool" feature. If cli-agent does not use that feature, the vulnerability is unexploitable in this project's context.
- Vulnerabilities #3–#6 (`uuid`) involve a buffer bounds check in `v3/v5/v6` UUID generation with a user-supplied `buf`. If cli-agent only calls `uuid()` for random UUIDs (v4), this is unexploitable.

## 6. Final State

The project's dependency tree is **not clean** — 1 transitive deprecation and 12 moderate security vulnerabilities remain. The newly added `yaml@2.8.4` dependency is **clean**.

No changes were made to `package.json` or any source files during this validation run because all identified fixes require major-version migrations that fall outside the agent's safe auto-fix boundary.

The project is deployable and the issues are moderate-severity dev-toolchain or upstream-pinning problems. No critical or high severity issues were found.

**Items remaining for human resolution:**
- MR-1: `glob` deprecation (blocked on vitest 2→4 migration)
- MR-2: `vitest`/`vite`/`esbuild` security vulnerabilities (dev-only; fix = vitest 4.x migration)
- MR-3: `@langchain/anthropic` / `@anthropic-ai/sdk` vulnerability (waiting on upstream release)
- MR-4: `@langchain/langgraph` / `uuid` vulnerability (waiting on upstream or overrides decision)
- MR-5: Several direct deps with major-version updates available (informational)

## 7. Commands Run

| # | Command | Exit Code | Notes |
|---|---------|-----------|-------|
| 1 | `npm install` (in `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent`) | 0 | Clean install; no deprecation warnings emitted by install itself |
| 2 | `npm outdated --json` | 1 | Exit 1 is expected when outdated packages exist; parsed JSON successfully |
| 3 | `npm audit --json` | 1 | Exit 1 is expected when vulnerabilities exist; 12 moderate vulnerabilities found |
| 4 | `npm ci` (for deprecation warning capture) | 0 | Captured `glob@10.5.0` deprecation warning on stderr |
| 5 | `npm ls glob` | 0 | Traced transitive chain: `@vitest/coverage-v8` → `test-exclude` → `glob` |
| 6 | `npm ls uuid` | 0 | Traced transitive chain: `@langchain/langgraph` → sub-packages → `uuid@10.0.0` / `uuid@13.0.0` |
| 7 | `npm ls vite` | 0 | Traced transitive chain: `vitest` → `vite@5.4.21` |
| 8 | `npm ls @anthropic-ai/sdk` | 0 | Traced transitive chain: `@langchain/anthropic` → `@anthropic-ai/sdk@0.90.0` |
| 9 | `npm view @langchain/anthropic versions --json` | 0 | Confirmed no 1.x release exists with `@anthropic-ai/sdk >=0.91.1` |
| 10 | `npm view uuid versions --json` | 0 | Confirmed `uuid@14.0.0` exists (the fixed version) |
| 11 | `npm view @anthropic-ai/sdk@">=0.91.1" version --json` | 0 | Confirmed `0.91.1` and `0.92.0` exist as fixed versions |

## Anomalies

None detected. The lockfile was in sync with the manifest at the start of this validation run. The `npm outdated` exit code 1 is expected behavior (not an error condition) when any package has a newer version available.
