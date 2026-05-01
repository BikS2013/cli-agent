---
status: completed
mode: write-and-run
scope_slug: token-budget-agent-tools-prompt-block
language: typescript
framework: vitest
test_command_full: npx vitest run
test_command_scope: npx vitest run src/agent/tools/agent-tools/token-budget.spec.ts src/agent/system-prompt.spec.ts
test_dir: src (co-located *.spec.ts convention)
target_path: /Users/giorgosmarinos/aiwork/coding-platform/cli-agent
test_files_owned:
  - src/agent/tools/agent-tools/token-budget.spec.ts
  - src/agent/system-prompt.spec.ts
tests_added: 16
tests_updated: 6
tests_run: 26
tests_passed: 26
tests_failed: 0
implementation_gaps: 0
built_at: "2026-04-30T02:49:37Z"
last_built_commit: 25bbfb6e05fed1135a9e39157166591f2009474d
---

# Test Build — Token-Budget Assertion + `agentToolsMeta` Parameter Exercise

## 1. Summary

Status: **completed** — all 26 tests pass with zero failures. Two files were
touched: one new spec file (`token-budget.spec.ts`) and one extended spec file
(`system-prompt.spec.ts`). The token-budget spec covers NFR-NEW-001 using
`js-tiktoken` (already a transitive dependency) with the `cl100k_base` encoding.
The system-prompt spec extension adds 6 new tests covering the `agentToolsMeta`
parameter introduced by the agent-tools integration, including byte-stability
regressions for the no-meta and empty-meta paths and structural assertions for
the full-meta (all-six-tools) path. All 10 pre-existing tests in
`system-prompt.spec.ts` continue to pass.

## 2. Scope Resolved

### `src/agent/tools/agent-tools/prompt-block.ts`
- `buildAgentToolsPromptBlock(meta: AgentToolsCatalogMeta): string`
  — pure renderer of the agent-tools prompt section from catalog metadata.

### `src/agent/tools/agent-tools/agt-glob.ts`
- `AGT_GLOB_DESCRIPTION` (string constant) — LangChain tool description for `agt_glob`.
- `AGT_GLOB_NAME`

### `src/agent/tools/agent-tools/agt-grep.ts`
- `AGT_GREP_DESCRIPTION`
- `AGT_GREP_NAME`

### `src/agent/tools/agent-tools/agt-multiedit.ts`
- `AGT_MULTIEDIT_DESCRIPTION`
- `AGT_MULTIEDIT_NAME`

### `src/agent/tools/agent-tools/agt-patch.ts`
- `AGT_PATCH_DESCRIPTION`
- `AGT_PATCH_NAME`

### `src/agent/tools/agent-tools/agt-todo-read.ts`
- `AGT_TODO_READ_DESCRIPTION`
- `AGT_TODO_READ_NAME`

### `src/agent/tools/agent-tools/agt-todo-write.ts`
- `AGT_TODO_WRITE_DESCRIPTION`
- `AGT_TODO_WRITE_NAME`

### `src/agent/system-prompt.ts`
- `buildSystemPromptForCfg(cfg, capabilitiesSection, agentToolsMeta?)` — async
  composer that loads the base prompt file and assembles all sections.

## 3. Existing Coverage

| Symbol | Existing test file(s) |
|---|---|
| `buildAgentToolsPromptBlock` | `src/agent/tools/agent-tools/prompt-block.spec.ts` — 8 tests (not owned; not modified) |
| `AGT_*_DESCRIPTION` constants | None — new coverage added by `token-budget.spec.ts` |
| `buildSystemPromptForCfg` | `src/agent/system-prompt.spec.ts` — 5 existing tests; extended with 6 new tests |
| `buildSystemPrompt` (pure) | `src/agent/system-prompt.spec.ts` — 5 existing tests; not modified |

## 4. Plan

| target_symbol | category | test_file | test_name | intent |
|---|---|---|---|---|
| `AGT_GLOB_DESCRIPTION` | unit | `token-budget.spec.ts` | `unit: AGT_GLOB_DESCRIPTION is within 400-token per-tool ceiling` | Proves the glob description constant fits the per-tool token budget |
| `AGT_GREP_DESCRIPTION` | unit | `token-budget.spec.ts` | `unit: AGT_GREP_DESCRIPTION is within 400-token per-tool ceiling` | Proves the grep description constant fits the per-tool token budget |
| `AGT_MULTIEDIT_DESCRIPTION` | unit | `token-budget.spec.ts` | `unit: AGT_MULTIEDIT_DESCRIPTION is within 400-token per-tool ceiling` | Proves the multiedit description constant fits the per-tool token budget |
| `AGT_PATCH_DESCRIPTION` | unit | `token-budget.spec.ts` | `unit: AGT_PATCH_DESCRIPTION is within 400-token per-tool ceiling` | Proves the patch description constant fits the per-tool token budget |
| `AGT_TODO_READ_DESCRIPTION` | unit | `token-budget.spec.ts` | `unit: AGT_TODO_READ_DESCRIPTION is within 400-token per-tool ceiling` | Proves the todo-read description constant fits the per-tool token budget |
| `AGT_TODO_WRITE_DESCRIPTION` | unit | `token-budget.spec.ts` | `unit: AGT_TODO_WRITE_DESCRIPTION is within 400-token per-tool ceiling` | Proves the todo-write description constant fits the per-tool token budget |
| `buildAgentToolsPromptBlock` | regression | `token-budget.spec.ts` | `regression: default-on pack (glob+grep+multiedit+patch) assembled block <= 2000 tokens` | Guards the default-on pack (4 tools) against token bloat |
| `buildAgentToolsPromptBlock` | regression | `token-budget.spec.ts` | `regression: full pack (all 6 tools) assembled block <= 2800 tokens` | Guards the full pack (all tools) against worst-case token bloat |
| `buildAgentToolsPromptBlock` | unit | `token-budget.spec.ts` | `unit: empty meta (umbrella OFF) produces zero-length block` | Confirms empty input is 0 tokens (byte-stable contract) |
| `buildAgentToolsPromptBlock` | unit | `token-budget.spec.ts` | `unit: each individual tool fragment assembled through buildAgentToolsPromptBlock is <= 400 tokens` | Validates per-tool assembled block ceiling with header overhead included |
| `buildSystemPromptForCfg` | regression | `system-prompt.spec.ts` | `regression: undefined agentToolsMeta produces same output as pre-integration` | Proves omitting the new parameter causes no output change |
| `buildSystemPromptForCfg` | regression | `system-prompt.spec.ts` | `regression: emptyMeta (umbrella OFF) produces byte-stable output identical to no-meta case` | Proves empty AgentToolsCatalogMeta preserves pre-integration byte-stability |
| `buildSystemPromptForCfg` | unit | `system-prompt.spec.ts` | `unit: fullMeta (all 6 tools registered) includes the agent-tools section header` | Confirms the block header is injected when meta has registered entries |
| `buildSystemPromptForCfg` | unit | `system-prompt.spec.ts` | `unit: fullMeta output contains all registered tool names` | Confirms all six tool names appear in the assembled prompt |
| `buildSystemPromptForCfg` | unit | `system-prompt.spec.ts` | `unit: fullMeta agent-tools block appears AFTER the capabilities section` | Verifies composition order: caps section precedes agent-tools block |
| `buildSystemPromptForCfg` | unit | `system-prompt.spec.ts` | `unit: fullMeta agent-tools block appears BEFORE the user-addendum (--system)` | Verifies composition order: agent-tools block precedes user addendum |

## 5. Files Owned

| File | Reason |
|---|---|
| `src/agent/tools/agent-tools/token-budget.spec.ts` | new — no prior file existed |
| `src/agent/system-prompt.spec.ts` | updated — extended with `agentToolsMeta` describe block and import |

## 6. Test Run Results

Command: `npx vitest run src/agent/tools/agent-tools/token-budget.spec.ts src/agent/system-prompt.spec.ts --reporter=verbose`
Exit code: 0

| # | Test name | File | Result |
|---|---|---|---|
| 1 | unit: AGT_GLOB_DESCRIPTION is within 400-token per-tool ceiling | token-budget.spec.ts | PASS |
| 2 | unit: AGT_GREP_DESCRIPTION is within 400-token per-tool ceiling | token-budget.spec.ts | PASS |
| 3 | unit: AGT_MULTIEDIT_DESCRIPTION is within 400-token per-tool ceiling | token-budget.spec.ts | PASS |
| 4 | unit: AGT_PATCH_DESCRIPTION is within 400-token per-tool ceiling | token-budget.spec.ts | PASS |
| 5 | unit: AGT_TODO_READ_DESCRIPTION is within 400-token per-tool ceiling | token-budget.spec.ts | PASS |
| 6 | unit: AGT_TODO_WRITE_DESCRIPTION is within 400-token per-tool ceiling | token-budget.spec.ts | PASS |
| 7 | regression: default-on pack (glob+grep+multiedit+patch) assembled block <= 2000 tokens | token-budget.spec.ts | PASS |
| 8 | regression: full pack (all 6 tools) assembled block <= 2800 tokens | token-budget.spec.ts | PASS |
| 9 | unit: empty meta (umbrella OFF) produces zero-length block | token-budget.spec.ts | PASS |
| 10 | unit: each individual tool fragment assembled through buildAgentToolsPromptBlock is <= 400 tokens | token-budget.spec.ts | PASS |
| 11 | returns baseText alone when capabilities and custom are empty | system-prompt.spec.ts | PASS (pre-existing) |
| 12 | appends capabilities section after a blank line | system-prompt.spec.ts | PASS (pre-existing) |
| 13 | appends custom text under a User-provided instructions header | system-prompt.spec.ts | PASS (pre-existing) |
| 14 | composes base + capabilities + custom in that order | system-prompt.spec.ts | PASS (pre-existing) |
| 15 | built-in default constant is exported and non-empty | system-prompt.spec.ts | PASS (pre-existing) |
| 16 | AC-2 byte-equivalence: with no addenda, output is exactly baseText + capSection | system-prompt.spec.ts | PASS (pre-existing) |
| 17 | AC-8: --system inline text is appended under the User-provided header | system-prompt.spec.ts | PASS (pre-existing) |
| 18 | --system-file contents are appended | system-prompt.spec.ts | PASS (pre-existing) |
| 19 | --system-file + --system are concatenated (file first, then inline) | system-prompt.spec.ts | PASS (pre-existing) |
| 20 | throws when systemPromptPath does not exist (no silent fallback) | system-prompt.spec.ts | PASS (pre-existing) |
| 21 | regression: undefined agentToolsMeta produces same output as pre-integration | system-prompt.spec.ts | PASS (new) |
| 22 | regression: emptyMeta (umbrella OFF) produces byte-stable output identical to no-meta case | system-prompt.spec.ts | PASS (new) |
| 23 | unit: fullMeta (all 6 tools registered) includes the agent-tools section header | system-prompt.spec.ts | PASS (new) |
| 24 | unit: fullMeta output contains all registered tool names | system-prompt.spec.ts | PASS (new) |
| 25 | unit: fullMeta agent-tools block appears AFTER the capabilities section | system-prompt.spec.ts | PASS (new) |
| 26 | unit: fullMeta agent-tools block appears BEFORE the user-addendum (--system) | system-prompt.spec.ts | PASS (new) |

## 7. Implementation Gaps

None. All tests pass against the current implementation.

## 8. Manual Review Needed

### `js-tiktoken` free() method absent in the pure-JS port

The research document (`docs/reference/research-token-budget-methodology.md §6`)
shows a snippet calling `enc?.free()` in `afterAll`. The `Tiktoken` class in
`js-tiktoken` v1.0.21 (the pure-JS port) has NO `free()` method — that method
belongs to the WASM `tiktoken` package (the OpenAI package). The correct
approach for `js-tiktoken` is to create the encoder once (module-scope constant)
and let it be GC'd with the module. The spec was implemented correctly with a
module-scope constant; the research snippet was treated as aspirational. No
shared infra was modified.

### Full test suite baseline

This agent ran only the two owned spec files. The pre-existing 130-test suite
was not run in full — that is the integration verifier's responsibility. The
agent confirmed that both owned files pass and that no production source was
touched.

## 9. Commands Run

| # | Command | Exit code |
|---|---|---|
| 1 | `npx vitest run src/agent/system-prompt.spec.ts --reporter=verbose` | 0 (baseline: 10 pass) |
| 2 | `npx vitest run src/agent/tools/agent-tools/prompt-block.spec.ts --reporter=verbose` | 0 (baseline: 8 pass) |
| 3 | `npx vitest run src/agent/tools/agent-tools/token-budget.spec.ts --reporter=verbose` | 1 (10 pass, afterAll TypeError — `enc.free` not a function on js-tiktoken pure-JS) |
| 4 | `npx vitest run src/agent/tools/agent-tools/token-budget.spec.ts --reporter=verbose` | 0 (10 pass, after removing free() call) |
| 5 | `npx vitest run src/agent/system-prompt.spec.ts --reporter=verbose` | 0 (16 pass after extension) |
| 6 | `npx vitest run src/agent/tools/agent-tools/token-budget.spec.ts src/agent/system-prompt.spec.ts --reporter=verbose` | 0 (26 pass — final combined run) |
