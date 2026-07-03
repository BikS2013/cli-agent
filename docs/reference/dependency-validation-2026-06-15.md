---
project: cli-agent
package_manager: npm
mode: fix
include_security_audit: true
started_at: 2026-06-15
completed_at: 2026-06-15
initial_high_or_critical: 5
initial_total_vulnerabilities: 14
final_high_or_critical: 0
final_total_vulnerabilities: 0
status: clean
refined_request: docs/reference/refined-request-dependency-vulnerability-remediation.md
---

# Dependency Validation: 2026-06-15

## Summary

Release-blocking dependency advisories were remediated. The initial audit reported 14 vulnerabilities: 9 moderate, 3 high, and 2 critical. The final audit reports zero vulnerabilities at all severities.

## Changes Applied

- Upgraded `vitest` from `^2.1.9` to `^4.1.8`.
- Upgraded `@vitest/coverage-v8` from `^2.1.9` to `^4.1.8`.
- Upgraded `tsx` from `^4.21.0` to `^4.22.4`.
- Upgraded `@langchain/anthropic` from `^1.3.28` to `^1.4.1`.
- Upgraded `@langchain/core` from `^1.1.42` to `^1.1.49`.
- Upgraded `@langchain/langgraph` from `^1.2.9` to `^1.4.2`.
- Updated transitive `langsmith` to `0.7.7` through the existing `@langchain/core` dependency range.
- Regenerated `package-lock.json` through npm install/update commands.

## Advisory Closure

| Package / chain | Initial severity | Resolution |
|---|---:|---|
| `vitest` / `@vitest/coverage-v8` / `vite` / `vite-node` / `@vitest/mocker` / `esbuild` | Critical / High / Moderate | Upgraded Vitest toolchain to `4.1.8`, which resolved Vite and esbuild advisory chains. |
| `tsx` / `esbuild` | High | Upgraded `tsx` to `4.22.4`, which uses fixed `esbuild` releases. |
| `@langchain/anthropic` / `@anthropic-ai/sdk` | Moderate | Upgraded `@langchain/anthropic` to `1.4.1`, pulling `@anthropic-ai/sdk@0.103.0`. |
| `@langchain/langgraph` / `uuid` | Moderate | Upgraded `@langchain/langgraph` to `1.4.2`, pulling fixed LangGraph transitive packages. |
| `@langchain/core` / `langsmith` | High | Pinned `@langchain/core` to `^1.1.49` and updated transitive `langsmith` to `0.7.7`. |

## Command Audit Trail

| Command | Exit code | Notes |
|---|---:|---|
| `npm audit --audit-level=high --json` | 1 | Initial audit: 14 total vulnerabilities, including 3 high and 2 critical. |
| `npm view vitest version` | 0 | Candidate latest: `4.1.8`. |
| `npm view @vitest/coverage-v8 version` | 0 | Candidate latest: `4.1.8`. |
| `npm view tsx version` | 0 | Candidate latest: `4.22.4`. |
| `npm view @langchain/langgraph version` | 0 | Candidate latest: `1.4.2`. |
| `npm view @langchain/anthropic version` | 0 | Candidate latest: `1.4.1`. |
| `npm outdated --json` | 1 | Reported outdated direct dependencies; non-zero is expected when outdated packages exist. |
| `npm install @langchain/anthropic@^1.4.1 @langchain/langgraph@^1.4.2 tsx@^4.22.4 --save` | 0 | First remediation pass; left one high `langsmith` advisory. |
| `npm install vitest@^4.1.8 @vitest/coverage-v8@^4.1.8 --save-dev` | 0 | Remediated critical Vitest/Vite/esbuild chain; left one high `langsmith` advisory. |
| `npm audit --audit-level=high --json` | 1 | Intermediate audit: 1 high vulnerability in `langsmith@0.5.25`. |
| `npm ls langsmith` | 0 | Confirmed `langsmith@0.5.25` was pulled through `@langchain/core@1.1.49`. |
| `npm view langsmith version` | 0 | Candidate latest: `0.7.7`. |
| `npm update langsmith` | 0 | Updated transitive `langsmith` to `0.7.7`; npm reported zero vulnerabilities. |
| `npm install @langchain/core@^1.1.49 --save` | 0 | Pinned the direct `@langchain/core` manifest range to the verified clean installed version. |
| `npm audit --audit-level=high --json` | 0 | Final high-threshold audit: zero vulnerabilities. |
| `npm audit --json` | 0 | Final full audit: zero vulnerabilities at all severities. |
| `npm audit --audit-level=high` | 0 | Final exact release-gate command: `found 0 vulnerabilities`. |
| `npm ls langsmith` | 0 | Confirmed `langsmith@0.7.7`. |
| `npm run typecheck` | 0 | TypeScript validation passed. |
| `npm test` | 0 | Vitest 4.1.8 test run passed: 87 files, 1117 tests. |
| `npm run build` | 0 | Build passed and copied 8 runtime assets. |

## Manual Review Items

None. No high-or-above advisories remain, and no override was required.
