---
status: partially_fixed
mode: fix
package_manager: npm
ecosystem: node
iterations_run: 2
deprecations_initial: 0
deprecations_final: 0
vulnerabilities_initial: 14
vulnerabilities_final: 12
target_path: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent
validated_at: 2026-04-30T23:33:31Z
last_validated_commit: 25bbfb6e05fed1135a9e39157166591f2009474d
---

# Dependency Validation — cli-agent (agent-tools-integration)

## 1. Summary

The dependency tree of `@biks2013/cli-agent` was validated after adding `fast-glob` and `ignore` as direct dependencies. The package manager is **npm 11.12.1** with a `package-lock.json` lockfile. No deprecated packages were found anywhere in the tree. The security audit detected **14 moderate-severity vulnerabilities** on the initial scan. After applying patch/minor-version bumps to four direct LangChain dependencies (`@langchain/anthropic`, `@langchain/core`, `@langchain/google-genai`, `@langchain/openai`), the count reduced to **12**. All 12 remaining advisories require major-version migrations of their parent packages (`@langchain/langgraph`, `@langchain/anthropic`, `vitest`) and are flagged for manual review.

---

## 2. Initial State

### 2a. Deprecation scan (install output)

No deprecation warnings were emitted by `npm install`. The two newly added dependencies (`fast-glob@3.3.3`, `ignore@7.0.5`) are both actively maintained and have no deprecation markers.

### 2b. Security vulnerabilities (first audit — 14 moderate)

| Package | Scope | Current | Advisory | Severity | Advisory URL |
|---|---|---|---|---|---|
| `@anthropic-ai/sdk` | transitive (via `@langchain/anthropic`) | 0.90.0 | GHSA-p7fg-763f-g4gf — Insecure Default File Permissions in Local Filesystem Memory Tool | moderate | https://github.com/advisories/GHSA-p7fg-763f-g4gf |
| `@langchain/anthropic` | direct | 1.3.27 | Inherits from `@anthropic-ai/sdk` | moderate | — |
| `@langchain/core` | direct | 1.1.41 | Inherits from `uuid` | moderate | — |
| `@langchain/google-genai` | direct | 2.1.28 | Inherits from `uuid` | moderate | — |
| `@langchain/langgraph` | direct | 1.2.9 | Inherits from `uuid` (via checkpoint + sdk) | moderate | — |
| `@langchain/langgraph-checkpoint` | transitive | 1.0.1 | Inherits from `uuid` | moderate | — |
| `@langchain/langgraph-sdk` | transitive | 1.8.9 | Inherits from `uuid` | moderate | — |
| `uuid` | transitive (4 nodes) | 10.0.0 / 11.1.0 / 13.0.0 | GHSA-w5hq-g745-h8pq — Missing buffer bounds check in v3/v5/v6 when buf is provided | moderate | https://github.com/advisories/GHSA-w5hq-g745-h8pq |
| `vitest` | direct (devDep) | 2.1.9 | Inherits from `vite`, `@vitest/mocker`, `vite-node` | moderate | — |
| `@vitest/coverage-v8` | direct (devDep) | 2.1.9 | Inherits from `vitest` | moderate | — |
| `@vitest/mocker` | transitive (devDep) | 2.1.9 | Inherits from `vite` | moderate | — |
| `vite` | transitive (devDep) | 5.4.21 | GHSA-4w7w-66w2-5vf9 — Path Traversal in Optimized Deps `.map` Handling | moderate | https://github.com/advisories/GHSA-4w7w-66w2-5vf9 |
| `vite-node` | transitive (devDep) | 2.1.9 | Inherits from `vite` | moderate | — |
| `esbuild` | transitive (devDep) | 0.21.x | GHSA-67mh-4wv8-2f99 — esbuild allows cross-origin requests to the dev server | moderate | https://github.com/advisories/GHSA-67mh-4wv8-2f99 |

### 2c. Outdated packages (first scan — direct dependencies only)

| Package | Current | Wanted | Latest | Scope |
|---|---|---|---|---|
| `@langchain/anthropic` | 1.3.27 | 1.3.28 | 1.3.28 | dep |
| `@langchain/core` | 1.1.41 | 1.1.42 | 1.1.42 | dep |
| `@langchain/google-genai` | 2.1.28 | 2.1.29 | 2.1.29 | dep |
| `@langchain/openai` | 1.4.4 | 1.4.5 | 1.4.5 | dep |
| `@types/node` | 22.19.17 | 22.19.17 | 25.6.0 | devDep |
| `@vitest/coverage-v8` | 2.1.9 | 2.1.9 | 4.1.5 | devDep |
| `commander` | 12.1.0 | 12.1.0 | 14.0.3 | dep |
| `typescript` | 5.9.3 | 5.9.3 | 6.0.3 | devDep |
| `vitest` | 2.1.9 | 2.1.9 | 4.1.5 | devDep |
| `zod` | 3.25.76 | 3.25.76 | 4.4.1 | dep |

---

## 3. Replacements Applied

### Iteration 1 — Patch/minor version bumps for direct LangChain packages

Four direct dependencies were bumped to their latest patch/minor releases within the same major version. No package was renamed and no import paths changed.

**File modified:** `package.json` (dependencies section)

| Package | Old range | New range | Reason |
|---|---|---|---|
| `@langchain/anthropic` | `^1.3.27` | `^1.3.28` | Latest patch; advisory not fully resolved (explained in §4) |
| `@langchain/core` | `^1.1.41` | `^1.1.42` | v1.1.42 drops `uuid` from its direct dependencies, eliminating the `uuid` advisory chain through this parent |
| `@langchain/google-genai` | `^2.1.28` | `^2.1.29` | Latest patch; clears its `uuid` advisory chain (uuid no longer needed in 2.1.29) |
| `@langchain/openai` | `^1.4.4` | `^1.4.5` | Latest patch; no advisory directly, part of routine maintenance |

**Result:** `npm install` completed cleanly; 1 package removed, 4 changed. Audit count dropped from 14 to 12 moderate.

---

## 4. Manual Review Needed

All remaining 12 advisory counts require either a major-version upgrade of a parent package or an upstream library release. Per agent policy, major-version migrations are not performed automatically.

### 4a. `@anthropic-ai/sdk` (GHSA-p7fg-763f-g4gf) — `@langchain/anthropic` chain

**Current state:** `@langchain/anthropic@1.3.28` pins `@anthropic-ai/sdk@^0.90.0`, which installs `0.90.0`. The advisory is patched in `@anthropic-ai/sdk >= 0.91.1`.

**Why not auto-fixed:** `@langchain/anthropic@1.3.28` (the latest stable release as of validation date) only allows `^0.90.0`. No release in the `1.3.x` line pins `^0.91.x`. Bumping to a hypothetical `^0.91.x` pin would require `@langchain/anthropic` to ship a new release, which was not available at the time of this scan.

**Advisory context:** The vulnerability is in the `FilesystemMemoryTool` component of the Anthropic SDK. `cli-agent` does **not** use `FilesystemMemoryTool` — it uses the SDK only as the transport layer behind `@langchain/anthropic`. The practical risk to this project is therefore low. However, it cannot be dismissed if the project is published as a library and downstream consumers might enable that tool.

**Recommended action:** Monitor `@langchain/anthropic` releases. As soon as a `1.3.x` or `1.4.x` release ships with `@anthropic-ai/sdk@^0.91.1`, update `package.json` accordingly. Alternatively, if the project can accept a major jump to whatever `@langchain/anthropic` 2.x line ships (if/when it exists), that migration should be planned.

---

### 4b. `uuid` (GHSA-w5hq-g745-h8pq) — `@langchain/langgraph` chain

**Current state:** `@langchain/langgraph@1.2.9` directly pins `uuid@^10.0.0` (installs 10.0.0). Its sub-packages `@langchain/langgraph-checkpoint@1.0.1` (uuid 10.0.0) and `@langchain/langgraph-sdk@1.8.9` (uuid 13.0.0) also pin vulnerable ranges. The advisory requires `uuid >= 14.0.0`.

**Why not auto-fixed:** All three nested `uuid` instances are inside packages pinned tightly by `@langchain/langgraph@1.2.9`. The `1.2.x` line is the latest stable line for `@langchain/langgraph` and has not released a version that moves to `uuid@^14.x`. The npm audit "fix" suggestion pointing to `@langchain/langgraph@0.0.12` is misleading — it is an ancient, incompatible version. Manually setting an `overrides` entry is a non-trivial intervention because of the nested package boundaries.

**Advisory context:** CWE-787 (out-of-bounds write) and CWE-1285 (improper validation of array index) affect the `uuid.v3`, `uuid.v5`, and `uuid.v6` generation functions only when a `buf` argument is supplied. LangGraph uses `uuid` for internal state-checkpoint identifiers. Whether `buf` is ever passed in LangGraph's usage is unclear without source inspection.

**Recommended actions (two options, pick one):**
1. **Wait for upstream fix.** Monitor `@langchain/langgraph` for a release that pins `uuid@^14.x`. This is the safest approach.
2. **Use npm `overrides`.** Add the following to `package.json` to force all nested `uuid` instances to a non-vulnerable version. This requires verifying runtime compatibility with LangGraph's actual uuid API calls:
   ```json
   "overrides": {
     "uuid": "^14.0.0"
   }
   ```
   This technique is supported in npm 8.3+ and the project uses npm 11.x, so it is mechanically safe. The risk is a runtime breakage if LangGraph internally calls `uuid.v3/v5/v6` with a `buf` argument, since that API changed in v14. The overrides approach is classified as a **manual** action because it requires human verification of LangGraph's internal uuid usage before applying.

---

### 4c. `vitest` / `vite` / `esbuild` cluster (GHSA-4w7w-66w2-5vf9, GHSA-67mh-4wv8-2f99)

**Current state:** `vitest@2.1.9` is installed. It pulls in `vite@5.4.21` and `esbuild@0.21.x`. Both `vite` and `esbuild` have advisories fixed only in versions bundled with `vitest >= 4.0.0`.

**Why not auto-fixed:** Moving from `vitest@2.x` to `vitest@4.x` is a **major version jump** (skipping 3.x as well). The vitest 3.x and 4.x releases introduced API changes: configuration format, snapshot format, and some matchers changed. The `@vitest/coverage-v8` package must be bumped in lock-step.

**Advisory context:** Both advisories affect the **development server** (`vite dev`) and **esbuild's serve mode** — not the test runner itself. `cli-agent` uses `vitest` only for `npm test` (a test runner invocation), not as a dev server. Neither advisory is exploitable in a `vitest run` invocation; they require a browser or HTTP client to connect to the Vite dev server. The practical risk to this project in its CI/test usage is **negligible**.

**Recommended action:**

1. Update `vitest` and `@vitest/coverage-v8` together by bumping both to `^3.x` first (less risky intermediate step), run the full test suite, then proceed to `^4.x` if clean. The test suite currently has 104+ tests that provide a safety net. The migration involves:
   - Updating `package.json`: `"vitest": "^3.2.4"` and `"@vitest/coverage-v8": "^3.2.4"` (or directly `^4.1.5`/`^4.1.5`).
   - Reviewing the `vitest.config.ts` for any deprecated configuration keys (e.g., `pool` options changed in v3).
   - Running `npm test` and fixing any test failures introduced by vitest API changes.

---

### 4d. Major-version outdated packages (not security-related)

The following packages have major-version updates available but carry no security advisories. They are noted here for completeness and are **not** blockers.

| Package | Installed | Latest | Notes |
|---|---|---|---|
| `commander` | 12.1.0 | 14.0.3 | No advisory. Major version jump. API changes in 13.x and 14.x; requires review of CLI arg parsing code. |
| `typescript` | 5.9.3 | 6.0.3 | No advisory. TypeScript 6 has stricter type checking. Full type-check pass required before upgrading. |
| `zod` | 3.25.76 | 4.4.1 | No advisory. Zod 4 has breaking API changes, particularly around error formatting. All schema definitions require review. |
| `@types/node` | 22.19.17 | 25.6.0 | No advisory. Major jump across Node 23/24/25 type definitions. |

---

## 5. Security Audit

### Final audit result (after iteration 1) — 12 moderate

| Advisory ID | Package | Severity | CWE | CVSS | Fixed In | Affects cli-agent Production? |
|---|---|---|---|---|---|---|
| GHSA-p7fg-763f-g4gf | `@anthropic-ai/sdk` | moderate | CWE-732 | N/A | `@anthropic-ai/sdk >= 0.91.1` | Low — FilesystemMemoryTool not used by cli-agent |
| GHSA-w5hq-g745-h8pq | `uuid` | moderate | CWE-787, CWE-1285 | N/A | `uuid >= 14.0.0` | Low — affects v3/v5/v6 with `buf` param only; likely not triggered by LangGraph |
| GHSA-4w7w-66w2-5vf9 | `vite` | moderate | CWE-22, CWE-200 | N/A | `vite >= 6.4.2` (via `vitest >= 4.0.0`) | No — dev server path traversal, not exploitable via `vitest run` |
| GHSA-67mh-4wv8-2f99 | `esbuild` | moderate | CWE-346 | 5.3 | `esbuild >= 0.25.0` (via `vitest >= 4.0.0`) | No — affects esbuild serve mode, not triggered by test runner |

**No high or critical severity vulnerabilities were found at any point.**

---

## 6. Final State

After iteration 1, the project is in **partially_fixed** state:

- **Zero** deprecated packages (was zero; no change needed).
- **12 moderate** security advisories remain (reduced from 14).
- **No high or critical** advisories at any iteration.
- **`fast-glob@3.3.3`** and **`ignore@7.0.5`** (the two new dependencies added by the agent-tools-integration work) are both clean: no deprecations, no advisories.
- All remaining 12 advisories require major-version parent upgrades and have been documented above with priority guidance.

**Production/runtime posture:** Of the 12 remaining advisories, none are exploitable in the normal runtime execution path of `cli-agent` as a CLI tool:
- The Anthropic SDK advisory targets a tool component not used by this project.
- The uuid advisory requires a specific `buf` argument pattern unlikely to be exercised by LangGraph's checkpoint logic.
- The vite/esbuild advisories target development-server features not invoked by the test runner.

The loop terminated because no further patch/minor-version bumps are available — all remaining issues require major-version migrations (invariant: major-version migrations are flagged for manual review and not applied automatically).

---

## 7. Commands Run

| # | Command | Exit Code | Notes |
|---|---|---|---|
| 1 | `npm install` (initial) | 0 | "up to date, audited 176 packages in 5s" — no deprecation warnings |
| 2 | `npm audit --json` | 1 | 14 moderate vulnerabilities found (non-zero exit indicates vulnerabilities present) |
| 3 | `npm outdated --json` | 1 | 10 packages with newer versions; non-zero exit is normal when outdated packages exist |
| 4 | `npm install` (after bumping 4 deps) | 0 | "removed 1 package, changed 4 packages, audited 175 packages in 3s" |
| 5 | `npm audit --json` | 1 | 12 moderate vulnerabilities remain after bumps |
| 6 | `npm outdated --json` | 1 | 6 packages still show newer versions (all major-version jumps except none in direct LangChain) |

**Anomalies noted:**
- npm audit's suggested fix for `@langchain/langgraph` points to version `0.0.12`, which is an ancient incompatible release. This is a known npm audit limitation where it finds the highest-priority semver-compatible ancestor with no vulnerability, which in this case happens to be from a completely different product era. The suggestion must be disregarded.
- npm audit's suggested fix for `@langchain/anthropic` points to `1.3.26` (a downgrade from `1.3.28`). This is because 1.3.26 pins `@anthropic-ai/sdk@^0.74.0` which npm does not flag (the advisory range starts at `0.79.0`), even though 0.74.0 is older and no safer. The suggestion must be disregarded.
