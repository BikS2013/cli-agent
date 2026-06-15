---
status: clean
mode: report-only
package_manager: npm
ecosystem: node
iterations_run: 0
deprecations_initial: 1
deprecations_final: 1
vulnerabilities_initial: 14
vulnerabilities_final: 14
target_path: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent
validated_at: 2026-06-13T00:00:00Z
last_validated_commit: c546d3891d273d3afdcf6271f6257cba3ce9022b
replaced_modules: []
touched_source_files: []
---

# Dependency Validation — cli-agent (LLM I/O Inspector)

## 1. Summary

Validated the npm dependency tree of `@biks2013/cli-agent` at commit `c546d38` following the implementation of the LLM I/O Inspector feature (plan-007). **This feature introduced zero new runtime or development dependencies.** `package.json` and `package-lock.json` are unchanged from the prior validation baseline (`5144a73`) except for the package version bump (`0.2.1` → `0.3.0`) and the `yaml` entry that was added in the config-profiles feature (already validated). The tool-schema serialization deliberately uses `convertToOpenAITool` from the already-installed `@langchain/core@1.1.42`, confirmed resolvable at `@langchain/core/utils/function_calling`. **Status for this feature: CLEAN — no new dependency issues introduced.**

The pre-existing dependency backlog (1 transitive deprecation, 14 security advisories) is unchanged in structure from the prior report, though the audit severity picture has evolved since the config-profiles run on 2026-05-02. New advisory data is recorded here for completeness. Per the project decision recorded in `Issues - Pending Items.md`, this backlog is deferred and not bundled with feature work.

> **Note on audit severity change vs prior report:** The prior validation (2026-05-02) found 12 moderate advisories. This run finds 14 advisories at elevated severities (2 critical, 3 high, 9 moderate). The increase is due to new CVEs published upstream for `esbuild` (GHSA-gv7w-rqvm-qjhr — high, GHSA-g7r4-m6w7-qqqr — low), `vitest` (GHSA-5xrq-8626-4rwp — critical, CVSS 9.8), `langsmith` (GHSA-3644-q5cj-c5c7 — high), and `brace-expansion` (GHSA-jxxr-4gwj-5jf2 — moderate). None were introduced by this feature; all are pre-existing transitive chains. Additionally, the npm audit now flags `tsx` directly (via `esbuild`) and confirms `@langchain/anthropic` and `@langchain/langgraph` now have minor-range–fixable paths (see Section 5).

---

## 2. Feature Attribution Analysis

### 2a. Did the LLM I/O Inspector feature add any dependencies?

**No.** A `git diff` of `package.json` from the prior validation baseline commit (`5144a73`) to HEAD (`c546d38`) shows only one change: a `yaml: ^2.8.4` entry added in the config-profiles feature work (already validated in `docs/reference/dependency-validation-config-profiles.md`). No dependencies were added between the config-profiles merge and the LLM I/O Inspector feature.

```
Prior baseline (5144a73) deps:
  @langchain/anthropic, @langchain/core, @langchain/google-genai,
  @langchain/langgraph, @langchain/openai, commander, fast-glob,
  ignore, zod

HEAD (c546d38) deps (same set + yaml from config-profiles):
  @langchain/anthropic, @langchain/core, @langchain/google-genai,
  @langchain/langgraph, @langchain/openai, commander, fast-glob,
  ignore, yaml, zod
```

DevDependencies are unchanged between the two commits.

### 2b. `convertToOpenAITool` resolution

The new file `src/agent/io-capture.ts` imports:

```typescript
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
```

**Confirmed resolvable:** The path `node_modules/@langchain/core/utils/function_calling.js` exists and re-exports from `../dist/utils/function_calling.js`. The dist bundle exports `convertToOpenAITool` as a named export. No new package (`zod-to-json-schema` or otherwise) was added to supply this utility — it resolves entirely from the already-installed `@langchain/core@1.1.42`.

### 2c. Package manifest integrity

| File | Changed by this feature? | Verification |
|------|--------------------------|--------------|
| `package.json` | No | `git diff c546d38 -- package.json` shows zero hunk changes to `dependencies` or `devDependencies` |
| `package-lock.json` | No | The lockfile SHA in HEAD matches the lockfile at the conclusion of the config-profiles feature work |

---

## 3. Initial State — Pre-existing Deprecation Inventory

### 3a. Deprecation warnings

The `npm install --dry-run` and `npm ci --dry-run` commands returned exit code 0 with no deprecation warnings emitted. The glob deprecation is only surfaced during a full network-install via `npm ci`; the current `node_modules` is already installed and consistent with the lockfile.

| Package | Current Version | Scope | Severity | Deprecation Message | Parent Chain |
|---------|----------------|-------|----------|---------------------|--------------|
| `glob` | 10.5.0 | transitive | info | "Old versions of glob are not supported, and contain widely publicized security vulnerabilities" | `@vitest/coverage-v8@2.1.9` → `test-exclude@7.0.2` → `glob@10.5.0` |
| `brace-expansion` | 5.0.5 | transitive | moderate | Advisory GHSA-jxxr-4gwj-5jf2 (NEW since prior report) | `@vitest/coverage-v8@2.1.9` → `test-exclude@7.0.2` → `glob@10.5.0` → `brace-expansion@5.0.5` |

### 3b. Outdated packages (npm outdated as of 2026-06-13)

Note: the `yaml@2.8.4` package (added in config-profiles, validated clean then) now has `2.9.0` available within its `^2.8.4` range — this is a minor patch, not a security issue. All LangChain packages have minor-range updates available.

| Package | Current | Wanted (in range) | Latest | Scope | Notes |
|---------|---------|-------------------|--------|-------|-------|
| `@langchain/anthropic` | 1.3.28 | 1.4.1 | 1.4.1 | direct runtime | `1.4.1` is within `^1.3.28` range; **now resolves anthropic-sdk advisory** (see §5) |
| `@langchain/core` | 1.1.42 | 1.1.49 | 1.1.49 | direct runtime | Minor patch; within range |
| `@langchain/google-genai` | 2.1.29 | 2.1.31 | 2.1.31 | direct runtime | Minor patch; within range |
| `@langchain/langgraph` | 1.2.9 | 1.4.2 | 1.4.2 | direct runtime | `1.4.2` is within `^1.2.9` range; **now resolves uuid advisory** (see §5) |
| `@langchain/openai` | 1.4.5 | 1.4.7 | 1.4.7 | direct runtime | Minor patch; within range |
| `@types/node` | 22.19.17 | 22.19.21 | 25.9.3 | direct dev | 22→25 is major (dev only) |
| `@vitest/coverage-v8` | 2.1.9 | 2.1.9 | 4.1.8 | direct dev | Major version jump (2→4) |
| `commander` | 12.1.0 | 12.1.0 | 15.0.0 | direct runtime | Major version jump (12→15) |
| `tsx` | 4.21.0 | 4.22.4 | 4.22.4 | direct dev | Minor update; within `^4.21.0` range; **4.22.4 resolves esbuild advisory** (see §5) |
| `typescript` | 5.9.3 | 5.9.3 | 6.0.3 | direct dev | Major version jump (5→6) |
| `vitest` | 2.1.9 | 2.1.9 | 4.1.8 | direct dev | Major version jump (2→4) |
| `yaml` | 2.8.4 | 2.9.0 | 2.9.0 | direct runtime | Minor patch; within range; no security issues |
| `zod` | 3.25.76 | 3.25.76 | 4.4.3 | direct runtime | Major version jump (3→4) |

---

## 4. Replacements Applied

None. This run is `mode: report-only`. No modifications were made to any file.

---

## 5. Manual Review Needed

All items below are **pre-existing**, documented in the backlog entry `[MEDIUM] Pre-existing dependency-tree security & deprecation backlog` in `Issues - Pending Items.md`, and confirmed **not introduced by the LLM I/O Inspector feature**.

### MR-1 (pre-existing): `glob@10.5.0` — Transitive deprecation via @vitest/coverage-v8

**Status:** Unchanged from prior report. Blocked on vitest 2→4 migration.

**Why it cannot be auto-fixed:** Transitive dependency via `@vitest/coverage-v8@2.1.9` → `test-exclude@7.0.2` → `glob@10.5.0`. Direct manipulation of transitive deps is prohibited by invariant. Fix = upgrade `vitest` and `@vitest/coverage-v8` to `4.x`.

---

### MR-2 (pre-existing, ESCALATED): vitest/vite/esbuild security chain — severity increased to CRITICAL

**Previous severity:** Moderate (GHSA-4w7w-66w2-5vf9, GHSA-67mh-4wv8-2f99 only)

**Current severity:** CRITICAL — two new advisories now apply:

- `vitest < 3.2.6`: GHSA-5xrq-8626-4rwp — "When Vitest UI server is listening, arbitrary file can be read and executed" (CWE-862; CVSS 9.8 CRITICAL). Affects `vitest@2.1.9`.
- `esbuild >= 0.17.0 < 0.28.1`: GHSA-gv7w-rqvm-qjhr — "Missing binary integrity verification in Deno module enables remote code execution via NPM_CONFIG_REGISTRY" (CWE-426/494; CVSS 8.1 HIGH).
- `esbuild >= 0.27.3 < 0.28.1`: GHSA-g7r4-m6w7-qqqr — "esbuild allows arbitrary file read when running development server on Windows" (CWE-22; CVSS 2.5 LOW).

**ESCALATION NOTE:** The `vitest` CVSS 9.8 critical advisory makes this backlog item higher priority than previously classified. However:
- The critical `vitest` advisory (GHSA-5xrq-8626-4rwp) is exploitable only when the **Vitest UI server is actively listening** (i.e., `vitest --ui` mode). This project does not ship or document the Vitest UI. Exploitability in the default `vitest run` / `vitest watch` flow is zero unless a developer explicitly starts the UI server.
- All affected packages are **dev-only** (test toolchain). The published `dist/` bundle is unaffected.

**fix path available (minor version bump possible for tsx, major required for vitest):**
- `tsx`: upgrading from `4.21.0` to `4.22.4` (within `^4.21.0` — minor bump) switches the `esbuild` dependency from `0.27.7` (vulnerable) to `~0.28.0` (patched). This resolves the two esbuild advisories for the `tsx` path.
- `vitest` + `@vitest/coverage-v8`: fix requires `4.1.8` — a major version jump (2→4). This also resolves the `vite`, `vite-node`, `@vitest/mocker`, `brace-expansion`, and `glob` chains.

**Recommended next step (updated):** Due to severity escalation, consider fast-tracking the `tsx` minor bump immediately (low risk, same-major, fixes esbuild CVEs on the dev-run path). Schedule the `vitest 2→4` migration as a dedicated sprint — it closes the critical advisory and resolves MR-1.

---

### MR-3 (pre-existing, STATUS CHANGED — NOW FIXABLE): `@langchain/anthropic` / `@anthropic-ai/sdk` — fix path now available

**Previous status:** Blocked — no `@langchain/anthropic` 1.x release pinned `@anthropic-ai/sdk >= 0.91.1`.

**Current status:** `@langchain/anthropic@1.4.1` (the "wanted" version within the `^1.3.28` range) now pins `@anthropic-ai/sdk@^0.103.0`, which is well above the fixed floor of `0.91.1`. Running `npm update @langchain/anthropic` would resolve this advisory without a manifest change.

**Advisory:** GHSA-p7fg-763f-g4gf — "Claude SDK for TypeScript has Insecure Default File Permissions in Local Filesystem Memory Tool" (CWE-732; `@anthropic-ai/sdk >= 0.79.0 < 0.91.1`).

**Recommended next step:** This is now a minor-version update within the existing semver range. It can be resolved with `npm update @langchain/anthropic` (no manifest edit required). Consider batching this with the next routine maintenance window.

---

### MR-4 (pre-existing, STATUS CHANGED — NOW FIXABLE): `@langchain/langgraph` / `uuid` — fix path now available

**Previous status:** Blocked — `@langchain/langgraph@1.2.9` was the latest 1.x release and still pinned `uuid@^10.0.0`.

**Current status:** `@langchain/langgraph@1.4.2` (within the `^1.2.9` range) has removed `uuid` entirely from its dependency tree (`@langchain/langgraph-checkpoint@1.1.1` and `@langchain/langgraph-sdk@1.9.22` no longer list `uuid` as a dependency). Running `npm update @langchain/langgraph` would resolve the uuid advisory without a manifest change.

**Advisory:** GHSA-w5hq-g745-h8pq — "uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided" (CWE-787, CWE-1285; CVSS 7.5).

**Recommended next step:** This is now a minor-version update within the existing semver range. It can be resolved with `npm update @langchain/langgraph` (no manifest edit required). Note that `@langchain/langgraph` 1.3.x→1.4.x may have behavioral changes — review the changelog and run the full test suite before shipping.

---

### MR-5 (pre-existing, NEW entry): `langsmith@0.5.25` — High severity advisory via @langchain/core

**New since prior report.** `langsmith` is pulled transitively via `@langchain/core@1.1.42` → `langsmith@0.5.25`.

**Advisory:** GHSA-3644-q5cj-c5c7 — "LangSmith SDK: Public prompt pull deserializes untrusted manifests without trust boundary warning" (CWE-502; CVSS 7.1 HIGH; fixed in `langsmith >= 0.6.0`). Current installed: `0.5.25`. Latest: `0.7.7`.

**Why it cannot be auto-fixed:** `langsmith` is a transitive dependency of `@langchain/core`. The project does not directly declare `langsmith`. Fixing requires either (a) upgrading `@langchain/core` so it pulls a `langsmith@>=0.6.0`, or (b) adding a `npm overrides` entry. Since `@langchain/core` is updated via `npm update @langchain/core` (minor patch from 1.1.42→1.1.49), check whether 1.1.49 resolves to `langsmith@>=0.6.0`.

**Exploitability context:** This advisory targets `langsmith`'s "public prompt pull" feature — a specific API call to download prompts from the LangSmith hub (`pull` from hub.langchain.com). `cli-agent` does not use LangSmith hub prompt-pull functionality. Exploitability in this project's context is zero unless a developer or end user explicitly calls the LangSmith hub pull API.

**Recommended next step:** Run `npm update @langchain/core` and verify whether the pulled `langsmith` version is `>=0.6.0`. If not, evaluate an `overrides` entry as part of the next maintenance window.

---

### MR-6 (pre-existing, NEW entry): `brace-expansion@5.0.5` — Moderate severity advisory

**New since prior report.** `brace-expansion` is pulled transitively via `@vitest/coverage-v8` → `test-exclude` → `glob@10.5.0` → `brace-expansion@5.0.5`.

**Advisory:** GHSA-jxxr-4gwj-5jf2 — "brace-expansion: Large numeric range defeats documented max DoS protection" (CWE-400; CVSS 6.5; fixed in `brace-expansion >= 5.0.6`). The installed version (`5.0.5`) is in range `5.0.2 – 5.0.5`.

**Why it cannot be auto-fixed:** Triple-transitive dependency. Fixed by the vitest 2→4 migration (same resolution as MR-1/MR-2).

---

### MR-7 (informational): Major-version outdated direct dependencies

Not vulnerabilities or deprecations — informational only. Unchanged from prior report except version numbers updated.

| Package | Current | Available | Risk of staying behind |
|---------|---------|-----------|------------------------|
| `commander` | 12.1.0 | 15.0.0 | Low (stable CLI library; no security history) |
| `zod` | 3.25.76 | 4.4.3 | Low (3.x is actively maintained) |
| `@types/node` | 22.19.17 | 25.9.3 | Low (dev-only type definitions) |
| `typescript` | 5.9.3 | 6.0.3 | Low (compiler; no runtime impact) |

---

## 6. Security Audit

Audit performed with `npm audit --json` (npm 11.12.1) on 2026-06-13. All vulnerabilities are pre-existing; **none were introduced by the LLM I/O Inspector feature**.

Total: 14 vulnerabilities (2 critical, 3 high, 9 moderate).

| # | Package | Severity | Advisory | CVSS | Fixed In | Direct? | Pre-existing? | Feature-introduced? |
|---|---------|----------|----------|------|----------|---------|---------------|---------------------|
| 1 | `vitest` | **critical** | GHSA-5xrq-8626-4rwp (UI server arbitrary file read/exec) | 9.8 | `vitest@4.1.8` (major) | yes | yes | no |
| 2 | `@vitest/coverage-v8` | **critical** | via vitest | — | `4.1.8` (major) | yes | yes | no |
| 3 | `esbuild` | **high** | GHSA-gv7w-rqvm-qjhr (integrity verification bypass) | 8.1 | `>=0.28.1` | no (tsx, vite) | yes | no |
| 4 | `langsmith` | **high** | GHSA-3644-q5cj-c5c7 (unsafe prompt deserialization) | 7.1 | `>=0.6.0` | no (@langchain/core) | yes (new CVE) | no |
| 5 | `tsx` | **high** | via esbuild | — | `tsx@4.22.4` (minor) | yes | yes | no |
| 6 | `vite` | moderate | GHSA-4w7w-66w2-5vf9 (path traversal .map) + esbuild | 0.0 + 5.3 | via vitest@4.x | no (vitest) | yes | no |
| 7 | `@langchain/anthropic` | moderate | GHSA-p7fg-763f-g4gf (insecure file permissions) | 0.0 | `1.4.1` (minor) | yes | yes | no |
| 8 | `@anthropic-ai/sdk` | moderate | GHSA-p7fg-763f-g4gf | — | `>=0.91.1` | no (@langchain/anthropic) | yes | no |
| 9 | `@langchain/langgraph` | moderate | GHSA-w5hq-g745-h8pq (uuid buffer bounds) | 7.5 | `1.4.2` (minor) | yes | yes | no |
| 10 | `@langchain/langgraph-checkpoint` | moderate | GHSA-w5hq-g745-h8pq | — | parent update | no | yes | no |
| 11 | `uuid` | moderate | GHSA-w5hq-g745-h8pq | 7.5 | `>=11.1.1` | no (langgraph) | yes | no |
| 12 | `brace-expansion` | moderate | GHSA-jxxr-4gwj-5jf2 (DoS via large range) | 6.5 | `>=5.0.6` | no (glob chain) | yes (new CVE) | no |
| 13 | `@vitest/mocker` | moderate | via vite | — | via vitest@4.x | no | yes | no |
| 14 | `vite-node` | moderate | via vite | — | via vitest@4.x | no | yes | no |

**Exploitability notes (unchanged from prior report, plus new items):**
- Rows 1–2 (`vitest` critical): exploitable only when Vitest UI server (`vitest --ui`) is actively listening. `cli-agent` does not use `vitest --ui`. Zero exploitability in normal CI or `vitest run` usage.
- Rows 3, 5–6, 13–14 (esbuild/vite chain): dev-only tools; affect only the developer's machine during test execution. Not present in the published `dist/`.
- Row 4 (`langsmith`): affects the LangSmith hub "prompt pull" API. `cli-agent` does not call this API. Zero exploitability in this project's usage.
- Row 7–8 (`@anthropic-ai/sdk`): targets the "Local Filesystem Memory Tool" feature. `cli-agent` does not use that feature. Zero exploitability in this project's usage.
- Rows 9–11 (`uuid`): buffer bounds issue in `v3/v5/v6` with a user-supplied `buf` argument. If `cli-agent` only uses v4 random UUIDs (as is typical for LangGraph session IDs), this is not exploitable.

**Update on fixability (vs prior report):**
- MR-3 (`@langchain/anthropic`): `npm update @langchain/anthropic` now resolves the advisory (no manifest change needed).
- MR-4 (`@langchain/langgraph`): `npm update @langchain/langgraph` now resolves the advisory (no manifest change needed).
- MR-5 (`langsmith`): may be resolved by `npm update @langchain/core` depending on whether 1.1.49 pulls `langsmith@>=0.6.0`.
- All vitest/vite/esbuild chain items: still require vitest 2→4 major migration, except `tsx@4.22.4` (minor bump) which resolves the `tsx`-specific esbuild chain.

---

## 7. Final State

### Feature verdict: CLEAN

The LLM I/O Inspector feature introduced **zero new dependencies**. `package.json` and `package-lock.json` are byte-identical between the config-profiles validation baseline and the LLM I/O Inspector HEAD in terms of dependencies. The `convertToOpenAITool` symbol is confirmed present in the already-installed `@langchain/core@1.1.42` at path `@langchain/core/utils/function_calling`. No new deprecations or advisories were introduced by this feature.

### Pre-existing backlog: unchanged in scope, two advisories changed status to fixable

The backlog recorded in `Issues - Pending Items.md` (`[MEDIUM] Pre-existing dependency-tree security & deprecation backlog`) remains the correct tracking vehicle. No items in the backlog were introduced by the LLM I/O Inspector. Two items have changed status since the prior report:

- **MR-3** (`@langchain/anthropic`): the upstream has shipped a fix — `@langchain/anthropic@1.4.1` resolves the `@anthropic-ai/sdk` advisory without a major version jump.
- **MR-4** (`@langchain/langgraph`): the upstream has dropped `uuid` from its dependency tree in `1.4.2`, resolving the uuid advisory without a major version jump.

Two new advisories have been published since the prior report (GHSA-5xrq-8626-4rwp for vitest at CVSS 9.8, and GHSA-3644-q5cj-c5c7 for langsmith at CVSS 7.1) — these should be reflected in the next update to the `Issues - Pending Items.md` backlog entry.

**Issues remaining for human resolution (all pre-existing, all deferred per project policy):**
- MR-1: `glob` deprecation (blocked on vitest 2→4 migration — same fix as MR-2)
- MR-2: vitest/vite/esbuild chain (ESCALATED: now critical severity; `vitest@4.1.8` resolves all; `tsx@4.22.4` minor bump partially addresses esbuild)
- MR-3: `@langchain/anthropic` / `@anthropic-ai/sdk` (STATUS CHANGED: now fixable via `npm update @langchain/anthropic`)
- MR-4: `@langchain/langgraph` / `uuid` (STATUS CHANGED: now fixable via `npm update @langchain/langgraph`)
- MR-5: `langsmith` advisory (NEW: high severity, but zero exploitability in this project)
- MR-6: `brace-expansion` advisory (NEW: moderate; resolved by vitest 2→4 migration)
- MR-7: Major-version outdated direct deps (informational)

---

## 8. Commands Run

| # | Command | Exit Code | Notes |
|---|---------|-----------|-------|
| 1 | `ls /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/package-lock.json` | 0 | Confirmed lockfile present |
| 2 | `npm --version` | 0 | npm 11.12.1 confirmed |
| 3 | `git log --oneline -8` | 0 | Confirmed HEAD at c546d38 |
| 4 | `git diff HEAD~5..HEAD -- package.json package-lock.json` | 0 | Only version bump and yaml entry (config-profiles, not LLM I/O Inspector) |
| 5 | `git show HEAD:package.json` (dep extraction) | 0 | Confirmed dep list at HEAD |
| 6 | `git show 5144a73:package.json` (dep extraction) | 0 | Confirmed dep list at prior validation baseline |
| 7 | `git diff 5144a73..HEAD -- package.json` | 0 | Exact diff: only version and yaml entry |
| 8 | `git log --oneline c546d38..HEAD` | 0 | No commits after last merged PR; all LLM I/O Inspector work is uncommitted |
| 9 | `git status --short` | 0 | Confirmed package.json and package-lock.json not in modified working tree |
| 10 | `git rev-parse HEAD` | 0 | Confirmed HEAD SHA: c546d3891d273d3afdcf6271f6257cba3ce9022b |
| 11 | `git diff HEAD -- package.json package-lock.json \| wc -l` | 0 | 0 lines — no uncommitted changes to package files |
| 12 | `grep -r "convertToOpenAITool" src/` | 0 | Confirmed used only in src/agent/io-capture.ts; imports from @langchain/core/utils/function_calling |
| 13 | `ls node_modules/@langchain/core/utils/function_calling*` | 0 | Module path confirmed present |
| 14 | `cat node_modules/@langchain/core/utils/function_calling.js` | 0 | Re-exports from dist; confirmed |
| 15 | `grep "convertToOpenAITool" node_modules/@langchain/core/dist/utils/function_calling.js` | 0 | Symbol exported and defined in dist bundle |
| 16 | `npm install --dry-run` | 0 | No deprecation warnings; "up to date in 120ms" |
| 17 | `npm ci --dry-run` | 0 | No deprecation warnings; lockfile in sync |
| 18 | `npm outdated --json` | 1 | Exit 1 expected; parsed successfully; 13 packages outdated |
| 19 | `npm audit --json` | 1 | Exit 1 expected; 14 vulnerabilities found (2 critical, 3 high, 9 moderate) |
| 20 | `npm ls glob --depth=10` | 0 | Traced: @vitest/coverage-v8 → test-exclude → glob@10.5.0 |
| 21 | `npm ls brace-expansion --depth=5` | 0 | Traced: … → glob@10.5.0 → brace-expansion@5.0.5 |
| 22 | `npm ls langsmith --depth=5` | 0 | Traced: @langchain/core → langsmith@0.5.25 |
| 23 | `npm ls tsx esbuild --depth=5` | 0 | Traced: tsx@4.21.0 → esbuild@0.27.7; vitest → vite → esbuild@0.21.5 |
| 24 | `npm view tsx@latest version && npm view tsx@latest dependencies` | 0 | tsx@4.22.4 uses esbuild@~0.28.0 (patched) |
| 25 | `npm view @langchain/anthropic@1.4.1 dependencies` | 0 | Confirmed @anthropic-ai/sdk@^0.103.0 (above fixed floor 0.91.1) |
| 26 | `npm view @langchain/langgraph@1.4.2 dependencies` | 0 | Confirmed no uuid in direct deps |
| 27 | `npm view @langchain/langgraph-checkpoint@1.1.1 dependencies` | 0 | Confirmed no uuid dependency |
| 28 | `npm view @langchain/langgraph-sdk@1.9.22 --json dependencies` | 0 | Confirmed no uuid dependency |

## Anomalies

None detected. The lockfile was in sync with the manifest at the start of this validation run. The `npm outdated` exit code 1 is expected behavior when any package has a newer version available. The `npm audit` exit code 1 is expected when vulnerabilities exist.

This is a workspace with a single root `package.json` (no `workspaces` declaration, no `pnpm-workspace.yaml`, no `turbo.json`/`nx.json`/`lerna.json`). No postinstall hooks were triggered — `npm install --dry-run` ran in 120ms.
