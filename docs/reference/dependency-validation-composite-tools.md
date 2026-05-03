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
validated_at: 2026-05-02T22:12:09Z
last_validated_commit: 8461783c45cac88672a9d496e3e4f52bf3649c69
---

# Dependency Validation — cli-agent (composite-tools)

## 1. Summary

Validated the npm dependency tree of `@biks2013/cli-agent` at commit `8461783` following the plan-006 composite-tools implementation. Plan-006 confirmed no new runtime dependencies were added (the wrapper-shim generator templates shim text in TypeScript; the prompt-cache helper uses existing LangChain APIs; no `cmd-shim`, YAML, or schema-validation packages beyond what was already present). The installed dependency tree is identical to the plan-005 baseline plus `yaml@2.8.4` (already recorded as clean). **Compared to the plan-005 baseline (12 vulnerabilities + 1 deprecation): count is flat — no regression, no improvement.** All identified issues require major-version migrations that exceed the safe auto-fix boundary defined by the agent's invariants. No automatic replacements were applied in this iteration; all items are routed to "Manual Review Needed".

## 2. Initial State

### 2a. Deprecations Found

| Package | Current Version | Scope | Severity | Deprecation Message | Parent Chain |
|---------|----------------|-------|----------|---------------------|--------------|
| `glob` | 10.5.0 | transitive | info | "Old versions of glob are not supported, and contain widely publicized security vulnerabilities, which have been fixed in the current version. Please update. Support for old versions may be purchased (at exorbitant rates) by contacting i@izs.me" | `@vitest/coverage-v8@2.1.9` → `test-exclude@7.0.2` → `glob@10.5.0` |

Source: `package-lock.json` `deprecated` field confirmed by `npm ls glob`.

### 2b. Packages with Newer Versions Available (informational — not auto-fixed)

| Package | Current | Wanted (in range) | Latest | Notes |
|---------|---------|-------------------|--------|-------|
| `@langchain/core` | 1.1.42 | 1.1.44 | 1.1.44 | Patch within `^1.1.42` range; minor update available |
| `@langchain/google-genai` | 2.1.29 | 2.1.30 | 2.1.30 | Patch within `^2.1.29` range |
| `@types/node` | 22.19.17 | 22.19.17 | 25.6.0 | Major jump (22→25); dev dep |
| `@vitest/coverage-v8` | 2.1.9 | 2.1.9 | 4.1.5 | Major jump (2→4); dev dep; resolves vuln chain |
| `commander` | 12.1.0 | 12.1.0 | 14.0.3 | Major jump (12→14); runtime dep |
| `typescript` | 5.9.3 | 5.9.3 | 6.0.3 | Major jump (5→6); dev dep |
| `vitest` | 2.1.9 | 2.1.9 | 4.1.5 | Major jump (2→4); dev dep; resolves vuln chain |
| `zod` | 3.25.76 | 3.25.76 | 4.4.2 | Major jump (3→4); runtime dep |

### 2c. Baseline Comparison (plan-005 → plan-006)

| Metric | plan-005 Baseline | plan-006 Result | Delta |
|--------|------------------|-----------------|-------|
| Deprecations (total) | 1 | 1 | 0 (flat) |
| Vulnerabilities (total) | 12 | 12 | 0 (flat) |
| New runtime deps added | n/a | 0 | — |
| New dev deps added | n/a | 0 | — |

**Verdict: Flat. Plan-006 did not introduce any new dependency issues.**

## 3. Replacements Applied

No replacements were applied. All identified issues require major-version migrations or involve transitive dependencies, both of which are excluded from auto-fix per the following invariants:

- "Never bump major versions silently."
- "Never edit a transitive dependency."

The deprecation list and vulnerability count are identical between the start and end of this iteration, so the loop terminated after one pass with status `deprecations_found` (no progress possible without manual intervention).

## 4. Manual Review Needed

### MR-1: `glob@10.5.0` — Transitive deprecation via @vitest/coverage-v8

**Package:** `glob@10.5.0`
**Scope:** Transitive
**Parent chain:** `@vitest/coverage-v8@2.1.9` → `test-exclude@7.0.2` → `glob@10.5.0`

**Why it cannot be auto-fixed:** `glob@10.5.0` is a transitive dependency. Direct manipulation of transitive dependencies is prohibited. The only remediation path is to upgrade `@vitest/coverage-v8` and `vitest` from `2.x` to `4.x` (latest: `4.1.5`), which is a major-version jump. The newer `vitest@4.x` + `@vitest/coverage-v8@4.x` versions pull in `test-exclude@10.x`, which uses `glob@11.x` (non-deprecated).

**Recommended next step:** Pin `"vitest": "^4.1.5"` and `"@vitest/coverage-v8": "^4.1.5"` in `package.json`, update `vitest.config.ts` if the v4 API surface changed, run the full test suite to confirm no breakage. This is a dev-only dependency so there is no production risk.

---

### MR-2: `@anthropic-ai/sdk@0.90.0` — Vulnerable transitive via @langchain/anthropic

**Package:** `@anthropic-ai/sdk@0.90.0` (transitive under `@langchain/anthropic@1.3.28`)
**Advisory:** GHSA-p7fg-763f-g4gf — "Insecure Default File Permissions in Local Filesystem Memory Tool"
**Severity:** Moderate
**CVE/CWE:** CWE-732
**Vulnerable range:** `>=0.79.0 <0.91.1`
**Patched version:** `@anthropic-ai/sdk@0.91.1`

**Why it cannot be auto-fixed:** The vulnerable package is `@anthropic-ai/sdk`, which is a transitive dependency of `@langchain/anthropic`. As of validation time, even `@langchain/anthropic@1.3.28` (latest) still pins `@anthropic-ai/sdk@^0.90.0`, which resolves within the vulnerable range. No release of `@langchain/anthropic` currently ships with `@anthropic-ai/sdk@>=0.91.1`. The `npm audit` proposed fix is to downgrade to `@langchain/anthropic@1.3.26` (advisory `isSemVerMajor: true` because it is a downgrade from current; it uses `@anthropic-ai/sdk@^0.74.0` — a different range). Downgrade is a regression and is not a safe auto-fix.

**Recommended next step:** Monitor `@langchain/anthropic` for a release that requires `@anthropic-ai/sdk@>=0.91.1`. In the meantime this vulnerability only affects the local-filesystem memory tool feature of the Anthropic SDK, not the LangChain integration path used by this project. Consider adding an `overrides` block in `package.json` to force `@anthropic-ai/sdk@>=0.91.1` after testing compatibility.

---

### MR-3: `uuid@10.0.0` / `uuid@13.0.0` — Vulnerable transitives via @langchain/langgraph

**Packages:** `uuid@10.0.0` (under `@langchain/langgraph-checkpoint` and `@langchain/langgraph`), `uuid@13.0.0` (under `@langchain/langgraph-sdk`)
**Advisory:** GHSA-w5hq-g745-h8pq — "Missing buffer bounds check in v3/v5/v6 when buf is provided"
**Severity:** Moderate
**CVE/CWE:** CWE-787, CWE-1285
**Vulnerable range:** `< 14.0.0`
**Patched version:** `uuid@14.0.0`

**Why it cannot be auto-fixed:** All three `uuid` instances are transitive dependencies pinned by `@langchain/langgraph@1.2.9` (which requires `uuid@^10.0.0`), `@langchain/langgraph-checkpoint@1.0.1` (also `uuid@^10.0.0`), and `@langchain/langgraph-sdk@1.8.9` (which resolves to `uuid@13.0.0`). The `npm audit` proposed fix is to downgrade `@langchain/langgraph` to `0.0.12` — a massive regression from `1.2.9`. Upstream packages have not yet adopted `uuid@^14.0.0`.

**Recommended next step:** Monitor `@langchain/langgraph` for a release that depends on `uuid@>=14.0.0`. In the meantime, assess whether the vulnerable `buf` parameter path in uuid v3/v5/v6 is exercised by LangGraph in this project — it is unlikely to be. Consider adding an `overrides` block to force `uuid@^14.0.0` once compatibility is confirmed.

---

### MR-4: `vite` + `esbuild` — Dev-only transitive vulnerabilities via vitest

**Packages:** `vite@<=6.4.1` (via `vitest`), `esbuild@<=0.24.2` (via `vite`), `vite-node@<=2.2.0-beta.2` (via `vitest`), `@vitest/mocker@<=3.0.0-beta.4` (via `vite`)
**Advisories:**
- GHSA-4w7w-66w2-5vf9 — "Vite Vulnerable to Path Traversal in Optimized Deps .map Handling" (CWE-22, CWE-200, CVSS 0)
- GHSA-67mh-4wv8-2f99 — "esbuild enables any website to send any requests to the development server and read the response" (CWE-346, CVSS 5.3)
**Severity:** Moderate (all dev-only)

**Why it cannot be auto-fixed:** All four vulnerabilities are in transitive packages under `vitest@2.1.9`. The only remediation is the same as MR-1: upgrade `vitest` and `@vitest/coverage-v8` from `2.x` to `4.x`. These vulnerabilities affect the Vite dev server, which is not deployed in production — they are test-infrastructure risk only.

**Recommended next step:** Consolidate with MR-1. Upgrading `vitest@^4.1.5` + `@vitest/coverage-v8@^4.1.5` resolves MR-1 and MR-4 simultaneously (4 out of 12 vulnerabilities and the 1 deprecation).

---

### MR-5: `@langchain/anthropic@1.3.28` — Version-pinned vulnerability exposure note

**Note for completeness:** `npm audit` reports `@langchain/anthropic` itself in the vulnerable range `1.3.27 - 1.4.0-dev-1775763803878` because it depends on the vulnerable `@anthropic-ai/sdk`. This is a transitive exposure, not a direct vulnerability in the `@langchain/anthropic` code. The remediation is the same as MR-2.

## 5. Security Audit

Audit performed with `npm audit --json` (npm 11.12.1). Total: **12 moderate, 0 high, 0 critical**.

| Vulnerable Package | Installed Version | Severity | Advisory | Fixed In | Fix Path | Dev-only? |
|---|---|---|---|---|---|---|
| `@anthropic-ai/sdk` | 0.90.0 | moderate | GHSA-p7fg-763f-g4gf | `@anthropic-ai/sdk@0.91.1` | Bump `@langchain/anthropic` when upstream adopts it | No (runtime) |
| `@langchain/anthropic` | 1.3.28 | moderate | (via @anthropic-ai/sdk) | see above | see MR-2 | No (runtime) |
| `uuid` | 10.0.0 (×2) / 13.0.0 | moderate | GHSA-w5hq-g745-h8pq | `uuid@14.0.0` | Bump `@langchain/langgraph` when upstream adopts uuid 14 | No (runtime) |
| `@langchain/langgraph` | 1.2.9 | moderate | (via uuid) | see above | see MR-3 | No (runtime) |
| `@langchain/langgraph-checkpoint` | 1.0.1 | moderate | (via uuid) | see above | see MR-3 | No (runtime) |
| `@langchain/langgraph-sdk` | 1.8.9 | moderate | (via uuid) | see above | see MR-3 | No (runtime) |
| `vite` | (via vitest) | moderate | GHSA-4w7w-66w2-5vf9 | `vite@>=6.4.2` | Upgrade `vitest` to `^4.1.5` | Yes (dev) |
| `esbuild` | (via vite/vitest) | moderate | GHSA-67mh-4wv8-2f99 | `esbuild@>=0.25.0` | Upgrade `vitest` to `^4.1.5` | Yes (dev) |
| `vite-node` | (via vitest) | moderate | (via vite) | see above | Upgrade `vitest` to `^4.1.5` | Yes (dev) |
| `@vitest/mocker` | (via vitest) | moderate | (via vite) | see above | Upgrade `vitest` to `^4.1.5` | Yes (dev) |
| `vitest` | 2.1.9 | moderate | (via vite + vite-node + @vitest/mocker) | `vitest@4.1.5` | Upgrade to `^4.1.5` | Yes (dev) |
| `@vitest/coverage-v8` | 2.1.9 | moderate | (via vitest) | `@vitest/coverage-v8@4.1.5` | Upgrade to `^4.1.5` | Yes (dev) |

**Impact triage:** 7 of 12 vulnerabilities are dev-only (vitest/vite/esbuild chain; no production exposure). 5 affect runtime packages (`@anthropic-ai/sdk`, `uuid`, and the LangGraph chain).

## 6. Final State

The project's dependency tree is **unchanged** from the plan-005 baseline:

- **1 transitive deprecation** remains: `glob@10.5.0` (via `@vitest/coverage-v8@2.1.9`). Cannot be auto-fixed without upgrading `vitest` 2.x → 4.x.
- **12 moderate vulnerabilities** remain: same advisory fingerprint as plan-005. None are high or critical. 7 are dev-only. All require either upstream package updates or major-version migrations.
- **Plan-006 added zero new packages.** The composite-tools implementation is dependency-clean: wrapper-shim generation is pure TypeScript string templating, prompt-cache uses existing `@langchain/core` and `@langchain/langgraph` APIs, and no YAML or schema-validation packages beyond the existing `yaml@2.8.4` and `zod@3.25.76` were added.
- **`yaml@2.8.4`** (added in plan-005): confirmed clean — no deprecation, no vulnerability advisory.
- **`zod@3.25.76`**: confirmed clean — no deprecation, no vulnerability advisory.

The quickest path to reducing the vulnerability count is upgrading `vitest@^4.1.5` + `@vitest/coverage-v8@^4.1.5` (resolves 7 of 12 vulnerabilities and the 1 deprecation, all in one coordinated change). The remaining 5 runtime vulnerabilities require waiting on upstream `@langchain/*` releases.

## 7. Commands Run

| # | Command | Exit Code | Notes |
|---|---------|-----------|-------|
| 1 | `npm install` (cwd: `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent`) | 0 | "up to date, audited 176 packages in 5s" — no deprecation warnings in output |
| 2 | `npm install --verbose` (filtered for `deprecated`) | 0 | No deprecation lines emitted |
| 3 | `node -e "...parse package-lock.json for deprecated field..."` | 0 | Found `node_modules/glob@10.5.0` with deprecated field |
| 4 | `npm ls glob` | 0 | Confirmed chain: `@vitest/coverage-v8@2.1.9` → `test-exclude@7.0.2` → `glob@10.5.0` |
| 5 | `npm outdated --json` | 1 (packages out of date) | 8 packages outdated; all within or outside semver range as noted in §2b |
| 6 | `npm audit --json` | 1 (vulnerabilities found) | `{"moderate": 12, "high": 0, "critical": 0, "total": 12}` |
| 7 | `npm ls uuid` | 0 | Confirmed uuid@10.0.0 (×2) and uuid@13.0.0 in tree |
| 8 | `npm ls --depth=0` | 0 | 15 top-level packages; tree identical to plan-005 baseline plus `yaml@2.8.4` |
| 9 | `npm view @langchain/anthropic@latest dependencies` | 0 | Still pins `@anthropic-ai/sdk@^0.90.0`; no safe upgrade path in current release |
| 10 | `npm view @langchain/anthropic@1.3.26 dependencies` | 0 | Uses `@anthropic-ai/sdk@^0.74.0`; downgrade not a viable fix |
| 11 | `npm view @langchain/langgraph@1.2.9 dependencies` | 0 | Still pins `uuid@^10.0.0`; confirmed no upstream fix in latest release |
| 12 | `git rev-parse HEAD` | 0 | `8461783c45cac88672a9d496e3e4f52bf3649c69` |
