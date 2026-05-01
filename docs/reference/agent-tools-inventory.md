---
upstream_repo: https://github.com/BikS2013/agent-tools
upstream_package_name: "@agent-platform/agent-tools"
upstream_version: 0.0.1
upstream_license: MIT (derived from sst/anomalyco-opencode, MIT)
upstream_published_to_npm: false   # `"private": true` in package.json
upstream_node_engines: ">=20.10"
upstream_module_type: ESM only
upstream_tooling: TypeScript, tsc-only build, node:test
inspected_at: "2026-04-30"
inspected_by: solutions-investigator
---

# `BikS2013/agent-tools` — Tool Inventory

This document satisfies **FR-NEW-001** of the refined request. It enumerates every
tool the upstream library exposes and gives a per-tool bundle/skip/sidecar
recommendation against the existing `cli-agent` standard tool catalog.

## 0. Repository facts

| Property | Value |
|---|---|
| Name | `@agent-platform/agent-tools` |
| Status | "in active development", workspace-private, **not published to npm** |
| Language / runtime | TypeScript, Node ≥ 20.10, ESM only — fully compatible with cli-agent (Node ≥ 22, ESM) |
| Build | `tsc -p tsconfig.json && npm run copy:prompts` (no bundler) |
| Test | `node --test` (no Vitest); deterministic + LLM-gated suites |
| LangChain integration | First-class `toLangChainTool` / `toLangChainTools` adapter, errors-to-string contract that does not crash `createReactAgent` loops |
| Prompt model | Per-tool `<name>.prompt.md` fragments + a `buildSystemPromptBlock({ include, context, heading })` helper with `${var}` substitution |
| Permission model | `PermissionPolicy` interface + `createStrictPolicy(...)` + `permissivePolicy` + `scrubEnv()` for child-process env hygiene |
| License | MIT (verbatim upstream MIT preserved at `docs/reference/opencode/LICENSE` and provenance pinned in `PROVENANCE.md`) |

**Runtime dependencies** (transitive footprint pulled in by bundling):

| Package | Purpose | Notes for cli-agent |
|---|---|---|
| `@mozilla/readability` | HTML article extraction (used by `webfetch`) | New dep — large but well-maintained |
| `dotenv` | `.env` loading | cli-agent already vendors its own loader; this becomes a duplicate but is small |
| `fast-glob` | Glob fallback when ripgrep is absent | New dep |
| `ignore` | `.gitignore`-style filtering | New dep |
| `jsdom` | DOM for readability | **Heavy** (≈ 6 MB, transitive) — only loaded when `webfetch` is invoked, but added to install size |
| `turndown` | HTML → Markdown | New dep |
| `zod` | Schemas | cli-agent already uses zod ✅ |
| `@vscode/ripgrep` (optional) | Native rg binary for `glob`/`grep` | Optional, JS fallback exists |
| `@langchain/core` (peer, optional) | LangChain types | cli-agent already has it ✅ |

**Distribution form**: because the package is `"private": true`, it cannot be
`npm install`-ed from the registry. Three viable distribution paths:

1. **Vendored copy** under `src/agent/tools/agent-tools-vendored/` (build their TS as
   part of cli-agent's `tsc` pass). Requires periodic re-sync.
2. **Git submodule** at `vendor/agent-tools/`, with a small barrel that re-exports
   the bits cli-agent needs. Cleaner provenance; harder for end users to install.
3. **Direct git dependency** — `"@biks2013/agent-tools": "github:BikS2013/agent-tools#<sha>"`
   in `package.json`. Works because the repo's `package.json` declares `"files": ["dist", "src", ...]`,
   but their `prepare`/`postinstall` would have to run `tsc` on every install of cli-agent.
   Fragile.

The recommendation in Part B of the investigation is **option 1 (vendor with pinned
SHA + provenance file)**, for the same reason the upstream itself vendors opencode.

---

## 1. Tools exposed (12 total)

For each tool: `name`, `purpose`, `runtime`, `mutating?`, `overlap with cli-agent`,
`recommendation`, `rationale`.

### 1.1 `read`

- **Purpose**: Read a file (with line range + truncation) or list a directory; supports images and PDFs as attachments.
- **Runtime**: TS / Node, no native dependency.
- **Mutating**: No (read-only).
- **Overlap**: **Direct** — cli-agent has `file_read` (`src/agent/tools/file/read-tool.ts`) and `file_list`.
- **Recommendation**: **Skip** (do not bundle as `agt_read`). Rationale: 100 % overlap with `file_read`/`file_list`. Adding it would split LLM mental model and waste prompt tokens. If upstream's image/PDF attachment behavior is desired, file a separate enhancement against `file_read`.

### 1.2 `write`

- **Purpose**: Create or overwrite a file with BOM preservation.
- **Runtime**: TS / Node.
- **Mutating**: **Yes** — must be gated by `--allow-mutations`.
- **Overlap**: Direct with `file_write`.
- **Recommendation**: **Skip**. Same reasoning as `read`. The BOM-preservation nuance can be back-ported into `file_write` if the user wants it.

### 1.3 `edit`

- **Purpose**: Single-occurrence exact string-replace edit on one file.
- **Runtime**: TS / Node.
- **Mutating**: **Yes**.
- **Overlap**: Direct with `file_edit`.
- **Recommendation**: **Skip**. Overlap.

### 1.4 `multiedit`

- **Purpose**: Atomic multi-replacement edit on a single file (apply N replacements or none).
- **Runtime**: TS / Node.
- **Mutating**: **Yes**.
- **Overlap**: **Partial** — cli-agent has only single-edit semantics today. `multiedit` adds atomicity for batched edits.
- **Recommendation**: **Bundle** as `agt_multiedit`. Rationale: net-new capability the LLM frequently needs (e.g., renaming a symbol in many places in one file safely). Mutation-gated.

### 1.5 `patch`

- **Purpose**: Apply an opencode-style `*** Begin Patch` envelope (Add / Update / Delete / Move). Higher-level than text edit.
- **Runtime**: TS / Node.
- **Mutating**: **Yes**.
- **Overlap**: None — cli-agent has no patch primitive.
- **Recommendation**: **Bundle** as `agt_patch`. Rationale: net-new, high-leverage when the LLM wants to issue a multi-file change in one call. Mutation-gated.

### 1.6 `bash`

- **Purpose**: Run a POSIX shell command with a timeout, env scrub, and policy enforcement.
- **Runtime**: TS / Node + spawned shell.
- **Mutating**: Effectively yes (state-changing).
- **Overlap**: **Direct** — cli-agent has `bash_run` with its own allowlist + sandbox model.
- **Recommendation**: **Skip**. Rationale: cli-agent's allowlist semantics (FR-AGT-006/007) and the existing `bash_list_allowed`/`bash_which`/`bash_run` triad are stricter and project-canonical. Bundling a second `bash` would create a confusing two-allowlist situation. The upstream's `scrubEnv()` helper can be **reused as a library function inside cli-agent's `bash/exec.ts`** even if the tool itself is skipped — that is a pure-utility win without prompt-surface cost.

### 1.7 `glob`

- **Purpose**: Find files by glob pattern, sorted by mtime; ripgrep with JS fallback.
- **Runtime**: TS / Node + optional `@vscode/ripgrep`.
- **Mutating**: No.
- **Overlap**: None — cli-agent has `file_list` (single-directory) but no recursive glob.
- **Recommendation**: **Bundle** as `agt_glob`. Rationale: net-new, high-leverage. Read-only. Pulls in `fast-glob` + optional `@vscode/ripgrep` (~30 MB if installed, but optional — JS fallback covers locked-down envs).

### 1.8 `grep`

- **Purpose**: Content search with regex (ripgrep with JS fallback).
- **Runtime**: TS / Node + optional `@vscode/ripgrep`.
- **Mutating**: No.
- **Overlap**: None — cli-agent has no content-search primitive (relies on `bash_run` + an allow-listed `grep` binary, which most users don't allow-list).
- **Recommendation**: **Bundle** as `agt_grep`. Rationale: very high-leverage; cli-agent currently lacks any in-process content search. Read-only.

### 1.9 `list`

- **Purpose**: Directory listing with depth limit and ignore rules.
- **Runtime**: TS / Node.
- **Mutating**: No.
- **Overlap**: **Direct** with `file_list` (cli-agent's), though cli-agent's is depth-1 only.
- **Recommendation**: **Skip** (default) **OR** rename to `agt_tree` if the depth-N + ignore-rules behavior is judged distinct enough. Default: skip to avoid confusion; revisit if `file_list` proves too thin.

### 1.10 `webfetch`

- **Purpose**: HTTP GET with HTML→Markdown conversion (Readability + Turndown) and a 5 MB cap.
- **Runtime**: TS / Node + `jsdom` + `@mozilla/readability` + `turndown` (heavy).
- **Mutating**: No (read-only HTTP GET).
- **Overlap**: **Direct** with `web_fetch` in cli-agent.
- **Recommendation**: **Skip**. Rationale: overlap. cli-agent's `web_fetch` already does the same job with a smaller dependency footprint. The Readability/Turndown extraction quality may be superior — if so, that's a focused enhancement to `web_fetch`, not a new tool. Bundling `agt_webfetch` would also add `jsdom` (~6 MB) just for a duplicate capability.

### 1.11 `todoread`

- **Purpose**: Read the in-process todo list for the current session.
- **Runtime**: TS / Node, in-memory `SessionStore`.
- **Mutating**: No.
- **Overlap**: None.
- **Recommendation**: **Bundle** as `agt_todo_read` **only if** `todowrite` is also bundled — they form a pair. See §1.12 for the joint recommendation.

### 1.12 `todowrite`

- **Purpose**: Replace the in-process todo list for the current session.
- **Runtime**: TS / Node, in-memory `SessionStore`.
- **Mutating**: **Yes** (mutates session state, but the state is in-memory and ephemeral; not a host-mutating tool).
- **Overlap**: None.
- **Recommendation**: **Bundle as a pair with `todoread`**, but treat as **opt-in (default off)**. Rationale: useful for long ReAct sessions where the LLM benefits from an explicit task list (Anthropic and Aider both find this pattern reduces drift), but cli-agent today is mostly used in one-shot mode where a todo list adds nothing. Default-off keeps the prompt token cost zero for one-shot users; TUI users can flip it on per session via `--enable-todo` or `/tools enable todo`.

---

## 2. Summary table

| Tool | Mutating | Overlap | Recommendation | Default state |
|---|---|---|---|---|
| `read` | No | Direct (`file_read`) | **Skip** | n/a |
| `write` | Yes | Direct (`file_write`) | **Skip** | n/a |
| `edit` | Yes | Direct (`file_edit`) | **Skip** | n/a |
| `multiedit` | Yes | Partial | **Bundle** as `agt_multiedit` | On (mutation-gated) |
| `patch` | Yes | None | **Bundle** as `agt_patch` | On (mutation-gated) |
| `bash` | Yes | Direct (`bash_run`) | **Skip** (reuse `scrubEnv` as library) | n/a |
| `glob` | No | None | **Bundle** as `agt_glob` | On |
| `grep` | No | None | **Bundle** as `agt_grep` | On |
| `list` | No | Direct (`file_list`) | **Skip** | n/a |
| `webfetch` | No | Direct (`web_fetch`) | **Skip** | n/a |
| `todoread` | No | None | **Bundle** as `agt_todo_read` | **Off by default** |
| `todowrite` | Yes (in-mem) | None | **Bundle** as `agt_todo_write` | **Off by default** |

**Net result: 5 tools bundled by default behavior** (`agt_glob`, `agt_grep`,
`agt_multiedit`, `agt_patch`, plus the two todo tools as a default-off pair).
Of these, two require `--allow-mutations` (`agt_multiedit`, `agt_patch`).

## 3. License & provenance

The upstream is MIT-licensed and itself a derivative of MIT-licensed
`anomalyco/opencode` (formerly `sst/opencode`). Bundling a vendored copy into
cli-agent is permissible provided cli-agent preserves the upstream LICENSE and
records provenance (the vendoring SHA + the chain of derivation). The upstream
already documents this pattern at `docs/reference/opencode/PROVENANCE.md` —
cli-agent should mirror it at `docs/reference/agent-tools/PROVENANCE.md`.

## 4. Notes for the implementation phase

- Upstream's `toLangChainTool` adapter returns plain LangChain `StructuredTool`
  instances and converts errors to strings rather than throwing — this matches
  cli-agent's existing `handleToolError` JSON-string-return contract closely
  enough that tool-call output should flow through cli-agent's logger without
  schema changes. Verify in the plan phase that the JSONL `tool_result` records
  receive a sensible `output` field for both `ok: true` and `ok: false` paths.
- The upstream's `ToolContext` requires `sessionId`, `workingDirectory`, and a
  `PermissionPolicy`. cli-agent must build these per-tool-call from
  `cfg`/`sessionId`/`cfg.fileEdit.root`/the chosen permission policy. Trivial,
  but it's a structural difference from the cli-agent factory pattern (which
  closes over `cfg` once at registration time). The plan should standardize on
  one of: (a) build `ToolContext` once at registration, (b) build per call.
  Recommendation: per call, so `sessionId` is fresh for every turn.
- The optional `@vscode/ripgrep` install can fail in locked-down CI; the JS
  fallback handles it transparently. cli-agent's CI already runs unsandboxed,
  so this is a non-issue, but the configuration guide should mention it.
- The upstream test suite uses `node:test`, not Vitest. Bundled-in code's tests
  must be **rewritten as Vitest specs** under cli-agent's `src/**/*.spec.ts`
  convention, OR the upstream tests must be left in place and excluded from
  cli-agent's test runner. Recommendation: write fresh, focused Vitest specs
  for the *integration* (registration, opt-out, mutation gating, prompt
  composition) and rely on the upstream's own test suite for the *internals*
  by re-running it during vendor sync, not at every cli-agent build.

## 5. References

| # | Source | URL | What was learned |
|---|---|---|---|
| 1 | Upstream README | https://github.com/BikS2013/agent-tools | Tool list, prompt-block helper, LangChain adapter contract, sandboxing policy, MIT license |
| 2 | Upstream `package.json` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/package.json | `"private": true`, deps, peer deps, optional `@vscode/ripgrep`, Node ≥ 20.10, ESM only |
| 3 | Upstream `src/index.ts` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/index.ts | Public exports, twelve tools, category exports |
| 4 | Upstream `src/categories.ts` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/categories.ts | `READ_ONLY_TOOLS`, `FS_TOOLS`, `WEB_TOOLS`, `SHELL_TOOLS`, `TODO_TOOLS` |
| 5 | Upstream `src/prompts/index.ts` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/prompts/index.ts | `buildSystemPromptBlock(opts)`, `${var}` substitution, registration-order rendering, `\n\n---\n\n` separator |
| 6 | Upstream `src/tools/index.ts` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/tools/index.ts | Tool barrel, named exports, bundle helpers (`allTools()`, `readOnlyTools()`, etc.) |
| 7 | Upstream `read.prompt.md` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/tools/read/read.prompt.md | Sample prompt size — ~1.2 KB / ~250 tokens per tool fragment |
| 8 | Upstream `bash.prompt.md` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/tools/bash/bash.prompt.md | Largest fragment — ~5–6 KB / ~1.2 K tokens (heavy with git-safety prose) |
