---
status: completed
mode: write-and-run
scope_slug: buildToolCatalog-integration-testing
language: typescript
framework: vitest
test_command_full: npx vitest run
test_command_scope: npx vitest run src/agent/tools/registry.spec.ts --reporter=verbose
test_dir: src/agent/tools (co-located, per project convention)
target_path: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent
test_files_owned:
  - src/agent/tools/registry.spec.ts
tests_added: 27
tests_updated: 0
tests_run: 27
tests_passed: 27
tests_failed: 0
implementation_gaps: 0
built_at: "2026-04-30T23:50:00Z"
last_built_commit: 25bbfb6e05fed1135a9e39157166591f2009474d
---

# Test Build — buildToolCatalog Integration Testing

## 1. Summary

All 27 new tests written and executed against `src/agent/tools/registry.spec.ts`
(Vitest, TypeScript, Node environment). The spec exercises `buildToolCatalog` across
every relevant flag combination — default config, `allowMutations` gating, umbrella
disable, per-tool selective flags, bash-run gating, `agentToolsMeta` lockstep invariant,
`cliAgentPermissionPolicy` invocation, and error-path cases for malformed config. All 27
tests pass with no failures and no implementation gaps. No existing spec files were
modified.

## 2. Scope Resolved

**Source file in scope:** `src/agent/tools/registry.ts`

In-scope symbols:

- `buildToolCatalog(cfg: AgentConfig, logger: Logger): ToolCatalog` — the single
  authoritative assembly point for the LLM-visible tool catalog.
- `ToolCatalog` interface — bundle shape `{ tools: AnyTool[]; agentToolsMeta: AgentToolsCatalogMeta }`.

Supporting symbols transitively exercised (not independently owned):

- `cliAgentPermissionPolicy(cfg)` — `src/agent/tools/agent-tools/permissions.ts`; called
  once per `buildToolCatalog` invocation.
- `buildAgentToolsGroup(cfg, policy)` — `src/agent/tools/agent-tools/group-builder.ts`;
  assembles the `agt_*` subset.
- All six `build*` wrapper factories in `src/agent/tools/agent-tools/` (via
  `buildAgentToolsGroup`).
- All standard tool factories (`createFileReadTool`, etc.) — exercised at construction
  time only; no `.func()` calls in this test suite.

## 3. Existing Coverage

| Symbol | Existing test files |
|---|---|
| `buildToolCatalog` | None found — zero direct references in any `*.spec.ts` file prior to this build. |
| `cliAgentPermissionPolicy` | `src/agent/tools/agent-tools/permissions.spec.ts` (indirect unit coverage of its helpers; the function itself is tested via the spy in `registry.spec.ts`). |
| `buildAgentToolsGroup` | `src/agent/tools/agent-tools/group-builder.spec.ts` — 8 cases covering the gating matrix at the group level. `registry.spec.ts` tests the full catalog (group + standard tools). |

`buildToolCatalog` had **zero existing test coverage**. All 27 tests in this build are new.

## 4. Plan

| target_symbol | category | test_file | test_name | intent |
|---|---|---|---|---|
| `buildToolCatalog` | integration | `registry.spec.ts` | default flags + allowMutations=false → only agt_glob and agt_grep register | Verifies that with default flags (glob/grep/multiedit/patch=true, todo=false) and mutations off, only the two read-only wrappers appear. |
| `buildToolCatalog` | integration | `registry.spec.ts` | default flags + allowMutations=false → agentToolsMeta reflects exactly the registered pair | `agentToolsMeta.registered` mirrors the two registered agt_* tools; umbrellaEnabled=true. |
| `buildToolCatalog` | integration | `registry.spec.ts` | default flags + allowMutations=false → standard read-only tools are all present | All 7 standard read-only tools are always in the catalog regardless of agent-tools state. |
| `buildToolCatalog` | integration | `registry.spec.ts` | glob+grep+multiedit+patch flags ON, allowMutations=true → all four agt_* tools register | Mutation gate lifted: agt_multiedit and agt_patch appear. |
| `buildToolCatalog` | integration | `registry.spec.ts` | allowMutations=true → standard mutating file tools are also included | file_write/file_edit/file_append appear when mutations are on. |
| `buildToolCatalog` | integration | `registry.spec.ts` | all six agt_* flags ON + allowMutations=true → all six agt_* tools register in canonical order | Full catalog: 7 readonly + 3 mutating + 6 agt_* = 16 tools. |
| `buildToolCatalog` | integration | `registry.spec.ts` | agentToolsMeta matches registered tools exactly when allowMutations=true and all flags on | Lockstep invariant at maximum cardinality. |
| `buildToolCatalog` | integration | `registry.spec.ts` | agentTools.enabled=false → no agt_* tools regardless of per-tool flags | Umbrella OFF wins over any per-tool flag. |
| `buildToolCatalog` | integration | `registry.spec.ts` | agentTools.enabled=false → umbrellaEnabled is false and registered is empty | Meta reports correct umbrella state and empty registered list. |
| `buildToolCatalog` | integration | `registry.spec.ts` | umbrella OFF → standard read-only tools are still present | Non-agt_* tools unaffected by umbrella. |
| `buildToolCatalog` | integration | `registry.spec.ts` | todoRead=true AND todoWrite=true → both register (no mutation gate applies) | Todo tools are read-only from the registry's perspective. |
| `buildToolCatalog` | integration | `registry.spec.ts` | todoRead=true AND todoWrite=true meta entries carry non-empty descriptions | Each registered meta entry has a non-empty description string. |
| `buildToolCatalog` | integration | `registry.spec.ts` | only glob enabled → only agt_glob registers from the agt_* pack | Selective per-tool flag: only glob on. |
| `buildToolCatalog` | integration | `registry.spec.ts` | only grep enabled → only agt_grep registers from the agt_* pack | Selective per-tool flag: only grep on. |
| `buildToolCatalog` | integration | `registry.spec.ts` | multiedit flag ON but allowMutations=false → agt_multiedit NOT registered | Mutation gate blocks agt_multiedit even when per-tool flag is on. |
| `buildToolCatalog` | integration | `registry.spec.ts` | patch flag ON but allowMutations=false → agt_patch NOT registered | Mutation gate blocks agt_patch even when per-tool flag is on. |
| `buildToolCatalog` | integration | `registry.spec.ts` | patch flag ON + allowMutations=true → agt_patch IS registered | Both conditions satisfied: agt_patch appears. |
| `buildToolCatalog` | integration | `registry.spec.ts` | tools[i].name === agentToolsMeta.registered[i].name for all i | Lockstep invariant across full six-tool set. |
| `buildToolCatalog` | integration | `registry.spec.ts` | meta is consistent when only a partial subset is registered | Lockstep with glob+todoRead only. |
| `buildToolCatalog` | integration | `registry.spec.ts` | empty bash.allow → bash_run is not in the catalog | Bash-run tool excluded when allowlist is empty (fail-closed). |
| `buildToolCatalog` | integration | `registry.spec.ts` | non-empty bash.allow → bash_run IS in the catalog | Bash-run tool included when allowlist is non-empty. |
| `buildToolCatalog` | regression | `registry.spec.ts` | all agt_* flags off + allowMutations=false + no bash allow → exactly 7 standard tools | Byte-stable baseline: catalog size = 7 when everything optional is off. |
| `buildToolCatalog` | regression | `registry.spec.ts` | umbrella OFF + allowMutations=false + no bash allow → still exactly 7 standard tools | Alternative path to the same baseline. |
| `buildToolCatalog` | integration | `registry.spec.ts` | cliAgentPermissionPolicy is invoked once per buildToolCatalog call via spy | Spy verifies policy factory is called on every catalog build. |
| `buildToolCatalog` | integration | `registry.spec.ts` | policy.id returned by cliAgentPermissionPolicy matches CLI_AGENT_POLICY_ID | Stable policy identity constant verified through direct factory call. |
| `buildToolCatalog` | error_path | `registry.spec.ts` | throws ConfigurationError when cfg.bash is missing | Malformed cfg propagates ConfigurationError from cliAgentPermissionPolicy. |
| `buildToolCatalog` | error_path | `registry.spec.ts` | throws ConfigurationError when cfg.fileEdit.root is empty string | Empty root string triggers ConfigurationError. |

## 5. Files Owned

| File | Reason |
|---|---|
| `src/agent/tools/registry.spec.ts` | NEW — created for this build. |

No existing files were modified. No shared infrastructure (`conftest.py`, `vitest.config.ts`,
`vitest.setup.ts`, etc.) was touched.

## 6. Test Run Results

Command: `npx vitest run src/agent/tools/registry.spec.ts --reporter=verbose`

Exit code: 0

```
 RUN  v2.1.9 /Users/giorgosmarinos/aiwork/coding-platform/cli-agent

 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: default agent-tools config > default flags + allowMutations=false → only agt_glob and agt_grep register
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: default agent-tools config > default flags + allowMutations=false → agentToolsMeta reflects exactly the registered pair
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: default agent-tools config > default flags + allowMutations=false → standard read-only tools are all present
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: allowMutations=true > glob+grep+multiedit+patch flags ON, allowMutations=true → all four agt_* tools register
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: allowMutations=true > allowMutations=true → standard mutating file tools are also included
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: allowMutations=true > all six agt_* flags ON + allowMutations=true → all six agt_* tools register in canonical order
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: allowMutations=true > agentToolsMeta matches registered tools exactly when allowMutations=true and all flags on
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: umbrella disabled > agentTools.enabled=false → no agt_* tools regardless of per-tool flags
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: umbrella disabled > agentTools.enabled=false → umbrellaEnabled is false and registered is empty
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: umbrella disabled > umbrella OFF → standard read-only tools are still present
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: todoRead + todoWrite > todoRead=true AND todoWrite=true → both register (no mutation gate applies)
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: todoRead + todoWrite > todoRead=true AND todoWrite=true meta entries carry non-empty descriptions
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: selective per-tool flags > only glob enabled → only agt_glob registers from the agt_* pack
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: selective per-tool flags > only grep enabled → only agt_grep registers from the agt_* pack
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: selective per-tool flags > multiedit flag ON but allowMutations=false → agt_multiedit NOT registered
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: selective per-tool flags > patch flag ON but allowMutations=false → agt_patch NOT registered
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: selective per-tool flags > patch flag ON + allowMutations=true → agt_patch IS registered
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: agentToolsMeta lockstep invariant > tools[i].name === agentToolsMeta.registered[i].name for all i
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: agentToolsMeta lockstep invariant > meta is consistent when only a partial subset is registered
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: bash_run gating > empty bash.allow → bash_run is not in the catalog
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: bash_run gating > non-empty bash.allow → bash_run IS in the catalog
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — regression: baseline standard tool count > all agt_* flags off + allowMutations=false + no bash allow → exactly 7 standard tools
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — regression: baseline standard tool count > umbrella OFF + allowMutations=false + no bash allow → still exactly 7 standard tools
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: cliAgentPermissionPolicy side-effect > cliAgentPermissionPolicy is invoked once per buildToolCatalog call via spy
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — integration: cliAgentPermissionPolicy side-effect > policy.id returned by cliAgentPermissionPolicy matches CLI_AGENT_POLICY_ID
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — error_path: malformed cfg to cliAgentPermissionPolicy > throws ConfigurationError when cfg.bash is missing
 ✓ src/agent/tools/registry.spec.ts > buildToolCatalog — error_path: malformed cfg to cliAgentPermissionPolicy > throws ConfigurationError when cfg.fileEdit.root is empty string

 Test Files  1 passed (1)
      Tests  27 passed (27)
   Start at  02:49:47
   Duration  487ms (transform 116ms, setup 0ms, collect 238ms, tests 6ms, environment 0ms, prepare 31ms)
```

## 7. Implementation Gaps

None. All 27 tests pass. No acceptance criteria from `refined-request-agent-tools-integration.md`
were found to be unmet by the current implementation.

## 8. Manual Review Needed

None. No shared test infrastructure (`vitest.config.ts`, shared fixtures, `tests/helpers/`)
needed modification. The spy test uses Vitest's built-in `vi.spyOn` within the owned spec file.

One note for future maintenance: the `cliAgentPermissionPolicy` spy test relies on Vitest's
ES-module spy support. If the project ever switches to a bundled test environment or adds
module-level caching of the policy, the spy approach may need to be replaced with a dependency-
injection pattern. This is informational — not a blocker today.

## 9. Commands Run

| # | Command | Exit code |
|---|---|---|
| 1 | `ls /Users/giorgosmarinos/aiwork/coding-platform/cli-agent/src/agent/tools/registry.spec.ts` | 2 (file did not exist — confirmed) |
| 2 | `npx vitest run src/agent/tools/registry.spec.ts --reporter=verbose` | 0 |
