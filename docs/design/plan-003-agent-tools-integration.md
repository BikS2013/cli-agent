# Plan 003 — Embed `BikS2013/agent-tools` curated subset into cli-agent

**Status:** Pending
**Created:** 2026-04-30
**Refined Request:** `docs/design/refined-request-agent-tools-integration.md`
**Investigation:** `docs/reference/investigation-agent-tools-integration.md`
**Inventory:** `docs/reference/agent-tools-inventory.md`
**Token-budget research:** `docs/reference/research-token-budget-methodology.md`
**ToolContext-injection research:** `docs/reference/research-toolcontext-injection.md`

---

## 0. Open decisions

**None.** All user-locked decisions are recorded at the top of this file (see "User-locked decisions" below). Every decision the investigator surfaced has been resolved. If during execution any new decision arises (e.g., upstream API drift forces a wrapper-shape change), it is to be raised under deviation Rule 4 (architectural) before being implemented.

### User-locked decisions (binding)

| # | Decision | Locked value |
|---|---|---|
| D1 | Opt-out mechanism | Per-tool config-flag gating (B2) + pack-level umbrella (B3). Prompt block derived from registered set. Describe-and-suppress (B1) is **rejected**. |
| D2 | Bundle scope | 6 tools — `agt_glob`, `agt_grep`, `agt_multiedit`, `agt_patch` (default-on); `agt_todo_read`, `agt_todo_write` (default-off pair). Skip `read`/`write`/`edit`/`bash`/`webfetch`/`list`. |
| D3 | Naming prefix | `agt_` for every bundled tool. |
| D4 | Tokenizer | Reuse `js-tiktoken` already transitively present via `@langchain/core` and `@langchain/openai`. **No new direct dependency.** |
| D5 | ToolContext injection | Per-call via `RunnableConfig.configurable`, read by each tool's `DynamicStructuredTool.func` (3rd argument). cli-agent writes its own wrappers — does NOT use upstream's `toLangChainTool` adapter. |
| D6 | Distribution | Vendor under `src/agent/tools/agent-tools-vendored/` with pinned SHA + `PROVENANCE.md` + `scripts/sync-agent-tools.sh`. |
| D7 | Permission bridge | Single `cliAgentPermissionPolicy(cfg)` factory built **once** in `buildToolCatalog` and **shared** by every wrapper. |

---

## 1. Goal & acceptance criteria

Embed a curated 6-tool subset of `BikS2013/agent-tools` into cli-agent as additional standard tools, gated by per-tool config flags under a pack-level umbrella, with the system-prompt block derived from the registered set, mutation-gating enforced for `agt_multiedit`/`agt_patch`, and a token-budget assertion in CI.

**Acceptance — maps back to FR-NEW-* IDs in the refined request:**

| FR | Acceptance condition | Verified in phase |
|---|---|---|
| FR-NEW-001 | Inventory exists at `docs/reference/agent-tools-inventory.md` | Already done (pre-plan) |
| FR-NEW-002 | Feasibility verdict captured in `docs/reference/investigation-agent-tools-integration.md` | Already done (pre-plan); no separate `feasibility-*.md` file produced because the investigation document is the verdict |
| FR-NEW-003 | This plan exists, references the investigation, was created after user sign-off | This file |
| FR-NEW-004 | Each accepted upstream tool exposed as a registered LangChain `DynamicStructuredTool`, named `agt_<tool>`, with Zod input schema and JSONL `tool_call` / `tool_result` records | Phase 3 + Phase 4 |
| FR-NEW-005 | System-prompt block emitted from registered set; composition order preserved | Phase 6 |
| FR-NEW-006 | Opt-out reachable from CLI flag, env var, `config.json`, four-tier precedence | Phase 5 |
| FR-NEW-007 | Mutation-gated tools absent when `--allow-mutations` is off | Phase 4 |
| FR-NEW-008 | No silent fallbacks for required config; missing required → `ConfigurationError` | Phase 5 |
| FR-NEW-009 | Documentation updates landed | Phase 8 |
| NFR-NEW-001 | Token-budget Vitest assertion passes (per-tool ≤ 400, default-on pack ≤ 2000, full pack ≤ 2800 — per token-budget research §5.2) | Phase 7 |
| NFR-NEW-002 | Cold-start time delta ≤ 100 ms — verified by smoke script | Phase 9 |
| NFR-NEW-003 | New deps justified: only `fast-glob` and `ignore` added (`zod` already present; `@vscode/ripgrep` optional). NOT added: `@mozilla/readability`, `jsdom`, `turndown`, `dotenv` | Phase 1 |
| NFR-NEW-004 | Each wrapped tool routes through `cliAgentPermissionPolicy` so the same security model holds | Phase 2 + Phase 3 |

---

## 2. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | **Upstream API drift** — `BikS2013/agent-tools` is `"private": true`, in active development; the wrapper signatures may shift between SHAs | Pin a specific SHA in `PROVENANCE.md`; the `scripts/sync-agent-tools.sh` script always overwrites the vendored copy and runs `npm run typecheck` so drift surfaces immediately; integration tests in Phase 9 catch silent behavioral changes |
| R2 | **Transitive dep size** — adding `fast-glob` + `ignore` (+ optional `@vscode/ripgrep`) | Bundle only what the 6 selected tools need; explicitly do NOT pull in `@mozilla/readability`, `jsdom`, `turndown`, `dotenv` (those are for `webfetch`/`read` which we are NOT bundling) |
| R3 | **ESM / Node ≥ 22 incompatibilities in vendored code** | Upstream targets Node ≥ 20.10 ESM; cli-agent is Node ≥ 22 ESM. Compatibility is high. Vendor sync script runs `tsc --noEmit` to catch breakage |
| R4 | **Prompt token bloat** | Token-budget Vitest spec asserts per-tool ≤ 400 tokens and default-on pack ≤ 2000 tokens (research §5.2). Author trims fragments if test fails |
| R5 | **`createReactAgent` rebind cost** if catalog were rebuilt per turn | Resolved: tools built once at session start; per-call values flow through `RunnableConfig.configurable` (research §5, Option B) |
| R6 | **Vendored code's own tests** use `node:test`, not Vitest | Do NOT include upstream tests in the vendor copy. cli-agent runs only its own Vitest specs against the wrappers and integration |
| R7 | **`@vscode/ripgrep` install failure** in locked-down CI | Mark as `optionalDependencies`. JS fallback in vendored code handles missing native binary |
| R8 | **Todo session state lost across process restarts** | Acceptable — todo pair is default-off; documented in `configuration-guide.md` |

---

## 3. Phase plan (execution order)

The plan has **9 internal phases** (numbered Phase 1 — Phase 9 inside this plan). These are NOT the workflow phases; they are the execution-order phases for the Implementation phase of the workflow. Phase parallelization for the workflow's "parallel coders" step is identified in §4.

### Phase 1 — Vendoring + sync infrastructure

**Goal:** A reproducible, scripted vendor of the upstream library at a pinned SHA, with provenance and dependency additions.

**Steps:**
1. Choose upstream SHA. Action: `git ls-remote https://github.com/BikS2013/agent-tools.git refs/heads/main` to capture the current tip. **Record the SHA in this plan and in `PROVENANCE.md`.** (To be filled by implementer at execution time; suggested: latest `main` HEAD as of plan acceptance, e.g., the SHA returned by the `git ls-remote` call.)
2. Create `scripts/sync-agent-tools.sh` (idempotent):
   - Accepts `SHA` env var (default: pinned SHA from `PROVENANCE.md`)
   - `git clone --depth 1` upstream into a tmp dir, then `git fetch && git checkout <SHA>`
   - Wipe `src/agent/tools/agent-tools-vendored/`
   - Copy upstream `src/` → `src/agent/tools/agent-tools-vendored/`
   - Copy upstream `LICENSE` → `src/agent/tools/agent-tools-vendored/LICENSE`
   - Regenerate `src/agent/tools/agent-tools-vendored/PROVENANCE.md` with: upstream URL, pinned SHA, `git show -s --format=%cI <SHA>` ISO date, derivation chain (sst/opencode → anomalyco → biks), MIT license note, list of vendored tool dirs, sync timestamp
   - Run `npm run typecheck` and abort on failure
   - Print a concise summary to stdout
   - `chmod +x` on the script
3. First sync against the chosen SHA. The sync produces:
   - `src/agent/tools/agent-tools-vendored/{adapters/, prompts/, tools/{glob,grep,multiedit,patch,todoread,todowrite}/, types.ts, categories.ts, ...}` — only the directories needed by the 6 bundled tools and their direct dependencies. The sync script uses an inclusion list (declared at the top of the script); `read`/`write`/`edit`/`bash`/`webfetch`/`list` directories are excluded.
   - Note: `prompts/index.ts` and `types.ts` are vendored regardless (they are shared infrastructure used by every tool).
4. `package.json` changes (runtime deps for the bundled subset only):
   - Add to `dependencies`: `fast-glob: ^3.x`, `ignore: ^5.x`
   - Add to `optionalDependencies`: `@vscode/ripgrep: ^1.x` (JS fallback covers absence)
   - **Do NOT add**: `@mozilla/readability`, `jsdom`, `turndown`, `dotenv` (these are for `webfetch`/`read` which we are NOT bundling)
   - `zod` and `@langchain/core` are already present
5. `.gitignore` audit: ensure the vendored directory IS committed (no ignore rules touch it).

**Files created/modified:**

| Path | Action |
|---|---|
| `scripts/sync-agent-tools.sh` | new (~80 LOC bash) |
| `src/agent/tools/agent-tools-vendored/` | new directory + vendored TS source |
| `src/agent/tools/agent-tools-vendored/PROVENANCE.md` | new |
| `src/agent/tools/agent-tools-vendored/LICENSE` | new (MIT verbatim) |
| `package.json` | modified (deps additions only) |
| `package-lock.json` | modified (auto by `npm install`) |

**Dependencies:** None (this phase is the foundation).

**Acceptance criteria:**
- `bash scripts/sync-agent-tools.sh` runs end-to-end with `SHA=<pinned>` and exits 0
- `tsc --noEmit -p tsconfig.json` passes after vendor copy
- `PROVENANCE.md` records the SHA, ISO date, derivation chain, vendored tool list
- `npm install` succeeds with the new deps; `node_modules/fast-glob`, `node_modules/ignore`, `node_modules/js-tiktoken` all present (last one already there)

**Verification commands:**
```bash
bash scripts/sync-agent-tools.sh
npm run typecheck
test -f src/agent/tools/agent-tools-vendored/PROVENANCE.md
test -f src/agent/tools/agent-tools-vendored/LICENSE
test -d src/agent/tools/agent-tools-vendored/tools/grep
node -e "console.log(require('fast-glob/package.json').version)"
```

---

### Phase 2 — Permission policy bridge

**Goal:** A single factory that maps cli-agent's security primitives onto the upstream `PermissionPolicy` shape, instantiated once and shared across every bundled wrapper.

**Steps:**
1. Read `src/agent/tools/agent-tools-vendored/types.ts` to capture the exact `PermissionPolicy` shape (`checkBash`, `checkFsRead`, `checkFsWrite`, `scrubEnv` — exact names confirmed at vendor time).
2. Implement `src/agent/tools/agent-tools/permissions.ts` exporting `cliAgentPermissionPolicy(cfg: AgentConfig): PermissionPolicy` that:
   - Delegates `checkBash(command, args)` → re-uses `parseAllowlistEntries(cfg.bash.allow)` from `src/agent/tools/bash/allowlist.ts`. Returns `{ allowed: false, reason }` if not allow-listed; `{ allowed: true }` if allow-listed.
   - Delegates `checkFsRead(absPath)` → reuses `resolveSandboxPath(cfg, absPath)` from `src/agent/tools/file/sandbox.ts`. Read is permitted within `cfg.fileEdit.root`.
   - Delegates `checkFsWrite(absPath)` → first asserts `cfg.allowMutations === true` (returns `{ allowed: false, reason: 'mutations disabled' }` otherwise), then routes through `resolveSandboxPath`.
   - Delegates `scrubEnv(env)` → returns env stripped of credential-shaped keys per cli-agent's existing `bashEnvAllow` / `passEnv` rules in `src/agent/tools/bash/exec.ts`.
3. The factory is **stateless** and **side-effect-free** — safe to construct once per session and reuse across all wrappers (research-confirmed in research-toolcontext-injection.md §clarifying-questions item 3).

**Files created/modified:**

| Path | Action |
|---|---|
| `src/agent/tools/agent-tools/permissions.ts` | new (~80 LOC) |
| `src/agent/tools/agent-tools/permissions.spec.ts` | new (~120 LOC, see Phase 9) |

**Dependencies:** Phase 1 (needs vendored `types.ts` to import the `PermissionPolicy` interface).

**Acceptance criteria:**
- `cliAgentPermissionPolicy(cfg)` returns a `PermissionPolicy` whose four methods route through cli-agent's existing primitives — verified by spec
- The factory is pure: same `cfg` → same observable behavior; no module-level state

**Verification commands:**
```bash
npx vitest run src/agent/tools/agent-tools/permissions.spec.ts
npm run typecheck
```

---

### Phase 3 — Per-tool DynamicStructuredTool wrappers

**Goal:** Six wrapper modules — one per bundled tool — each exposing a `createAgt<Tool>Tool(cfg)` factory that returns a `DynamicStructuredTool` with the `agt_<tool>` name, the upstream prompt fragment as description, and a `func` that pulls per-call context from `RunnableConfig.configurable` and delegates to the upstream tool's `execute`.

**Wrapper contract (every file follows the same shape):**

```typescript
// src/agent/tools/agent-tools/agt-<tool>.ts
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentConfig } from '../../../config/agent-config.js';
import type { ToolContext } from '../agent-tools-vendored/types.js';
import { <tool>Tool } from '../agent-tools-vendored/tools/<tool>/index.js';
import { handleToolError } from '../types.js';
// permissions is passed in (NOT created here) — see registry-built-once policy (D7)

export function createAgt<Tool>Tool(
  cfg: AgentConfig,
  policy: PermissionPolicy,
  sessionStore?: SessionStore,   // todo pair only
): DynamicStructuredTool {
  const staticCwd = cfg.fileEdit.root;
  return new DynamicStructuredTool({
    name: 'agt_<tool>',
    description: <tool>Tool.prompt,             // upstream prompt fragment
    schema: <tool>Tool.schema,                  // re-exported zod schema from vendored module
    func: async (input, _runManager, config?: RunnableConfig) => {
      try {
        const cwd = (config?.configurable?.['workingDirectory'] as string | undefined) ?? staticCwd;
        const ctx: ToolContext = {
          cwd,
          permissions: policy,
          signal: config?.signal,
          session: sessionStore,                 // todo pair only
          limits: { maxOutputBytes: cfg.perToolBudgetBytes },
        };
        const result = await <tool>Tool.execute(input, ctx);
        if (result.ok) return result.output;
        return `[agt_<tool> error] ${result.error.name}: ${result.error.message}`;
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
```

**Per-wrapper specifics:**

| File | Tool name | Schema source | Mutating | SessionStore? | Notes |
|---|---|---|---|---|---|
| `src/agent/tools/agent-tools/agt-glob.ts` | `agt_glob` | upstream `glob.schema` (re-exported zod) | No | No | Pure read-only file enumeration |
| `src/agent/tools/agent-tools/agt-grep.ts` | `agt_grep` | upstream `grep.schema` | No | No | Content search; uses `@vscode/ripgrep` if available, JS fallback otherwise |
| `src/agent/tools/agent-tools/agt-multiedit.ts` | `agt_multiedit` | upstream `multiedit.schema` | **Yes** | No | Atomic multi-replace on one file; only registered when `cfg.allowMutations === true` (Phase 4) |
| `src/agent/tools/agent-tools/agt-patch.ts` | `agt_patch` | upstream `patch.schema` | **Yes** | No | Opencode-style patch envelope; only registered when `cfg.allowMutations === true` (Phase 4) |
| `src/agent/tools/agent-tools/agt-todo-read.ts` | `agt_todo_read` | upstream `todoread.schema` | No | **Yes** | Reads `sessionStore.todos` from the per-session in-memory store |
| `src/agent/tools/agent-tools/agt-todo-write.ts` | `agt_todo_write` | upstream `todowrite.schema` | No (in-mem only — not host-mutating; therefore NOT gated by `--allow-mutations`) | **Yes** | Writes `sessionStore.todos` |

**SessionStore design (todo pair):**

- Type: `interface SessionStore { todos: TodoItem[] | null }` (re-exported from vendored types).
- Lifetime: one instance per `AgentGraph` (i.e., per cli-agent session). Held in process heap; not serialized by `MemorySaver`.
- Construction: created in `buildAgentGraph` (`src/agent/graph.ts`) when at least one of the todo tools is registered. Otherwise `undefined`.
- Injection: `agentGraph.todoSession` field; passed via `configurable.agentToolsSession` on every `graph.invoke` / `graph.streamEvents` call (see Phase 4 + research §4).
- Fallback for restart durability: explicitly **none** (acceptable per the default-off semantics; documented in `configuration-guide.md`).

**Files created/modified:**

| Path | Action |
|---|---|
| `src/agent/tools/agent-tools/agt-glob.ts` | new (~70 LOC) |
| `src/agent/tools/agent-tools/agt-grep.ts` | new (~70 LOC) |
| `src/agent/tools/agent-tools/agt-multiedit.ts` | new (~70 LOC) |
| `src/agent/tools/agent-tools/agt-patch.ts` | new (~70 LOC) |
| `src/agent/tools/agent-tools/agt-todo-read.ts` | new (~80 LOC; reads sessionStore) |
| `src/agent/tools/agent-tools/agt-todo-write.ts` | new (~80 LOC; writes sessionStore) |
| `src/agent/tools/agent-tools/types.ts` | new (~20 LOC; re-exports `PermissionPolicy`, `ToolContext`, `SessionStore` from vendored types for ergonomic import) |
| `src/agent/tools/agent-tools/index.ts` | new (~20 LOC barrel) |
| `src/agent/tools/agent-tools/agt-glob.spec.ts` ... `agt-todo-write.spec.ts` | new — see Phase 9 |

**Dependencies:** Phase 1 (vendored sources), Phase 2 (`PermissionPolicy` factory).

**Acceptance criteria:**
- Each factory returns a `DynamicStructuredTool` whose `name` equals the spec, whose `description` is non-empty (sourced from the upstream prompt fragment), and whose `schema` is a `ZodObject`
- Calling `tool.invoke(args, { configurable: { workingDirectory: '/tmp/test' } })` exercises the upstream tool with the live cwd
- Errors from the upstream surface as a string `[agt_<tool> error] <name>: <message>` (matches the existing JSONL `tool_result.output` contract — no schema change to logging)
- Type-check passes

**Verification commands:**
```bash
npm run typecheck
npx vitest run src/agent/tools/agent-tools/
```

---

### Phase 4 — Catalog registration

**Goal:** Conditionally append the bundled wrappers to the LLM-visible catalog in `buildToolCatalog`, honoring per-tool flags, the umbrella, and `--allow-mutations`.

**Steps:**
1. Modify `src/agent/tools/registry.ts`:
   - Import the six wrappers + `cliAgentPermissionPolicy` + `SessionStore` factory.
   - Build `policy = cliAgentPermissionPolicy(cfg)` **once** at the top of `buildToolCatalog` (D7).
   - Build `sessionStore: SessionStore | undefined` once if either todo tool is enabled.
   - Add a helper `buildAgentToolsGroup(cfg, policy, sessionStore): { tools: AnyTool[]; metadata: AgentToolMetadata[] }`:
     - If `cfg.agentTools.enabled === false` (umbrella off): return empty arrays.
     - Otherwise, for each of the 6 wrappers, append iff its per-tool flag is enabled. Mutating wrappers (`agt_multiedit`, `agt_patch`) additionally require `cfg.allowMutations === true`.
   - The function returns both the tool array and a parallel `AgentToolMetadata[]` array describing what was registered (used by the prompt builder in Phase 6).
2. Surface the catalog metadata so the system-prompt builder can derive its block:
   - Define `interface AgentToolMetadata { name: string; promptFragment: string; mutating: boolean }`.
   - Either (a) extend the return type of `buildToolCatalog` to `{ tools: AnyTool[]; agentToolsMeta: AgentToolMetadata[] }` and update all four call sites in `src/agent/run.ts`, **or** (b) export a separate `buildAgentToolsMetadata(cfg)` function that the prompt builder calls. **Choose (a)** — it keeps the metadata co-located with the catalog and removes the chance of drift between "what is registered" and "what is described in the prompt".
3. Update all four call sites in `src/agent/run.ts` (`runOneShotAgent`, `streamOneShotAgent`, `buildTuiAgentRuntime`, plus the slash-command rebuild paths) to destructure the new return shape and forward `agentToolsMeta` into `buildSystemPromptForCfg` (Phase 6 will consume it).
4. Update `src/agent/graph.ts` `buildAgentGraph` to accept (or attach) the optional `sessionStore`, expose it as `AgentGraph.todoSession`, and pass `configurable.agentToolsSession = todoSession` (only when defined) and `configurable.workingDirectory = cfg.fileEdit.root` in both `invokeOptions` (`runOneShot`) and `streamConfig` (`streamOneShot`).

**Files created/modified:**

| Path | Action |
|---|---|
| `src/agent/tools/registry.ts` | modified (return shape + agent-tools group) |
| `src/agent/tools/agent-tools/group-builder.ts` | new (~80 LOC; encapsulates the `buildAgentToolsGroup` logic for testability) |
| `src/agent/run.ts` | modified (4 call sites) |
| `src/agent/graph.ts` | modified (`AgentGraph.todoSession`, `invokeOptions.configurable`, `streamConfig.configurable`) |
| `src/agent/tools/registry.spec.ts` | new (~150 LOC; see Phase 9) |
| `src/agent/tools/agent-tools/group-builder.spec.ts` | new (~120 LOC; see Phase 9) |

**Dependencies:** Phase 2 (policy factory), Phase 3 (wrappers), Phase 5 (config flags must exist on `AgentConfig` first — but signature can be stubbed and refined; recommend Phase 5 lands before Phase 4 finalizes).

**Acceptance criteria:**
- With default config (umbrella on, default-on tools on, todo pair off, `--allow-mutations` off): catalog includes `agt_glob`, `agt_grep` and excludes the four others
- With `--allow-mutations`: `agt_multiedit` and `agt_patch` join the catalog
- With `--no-agent-tools`: none of the six are registered, regardless of per-tool flags
- With `--enable-agt-todo-read --enable-agt-todo-write`: the pair appears and the `AgentGraph.todoSession` is non-null
- `agentToolsMeta.length` equals the number of registered `agt_*` tools (invariant — used by the prompt builder)

**Verification commands:**
```bash
npm run typecheck
npx vitest run src/agent/tools/registry.spec.ts src/agent/tools/agent-tools/group-builder.spec.ts
```

---

### Phase 5 — Configuration surface

**Goal:** First-class config slots for the umbrella + 6 per-tool flags, wired through the four-tier precedence chain (CLI flag > shell env > `~/.tool-agents/cli-agent/.env` > `./.env` > `config.json`), with defaults applied last and **no fallback for required values** (none of the new flags are required — the defaults are starting values, not fallbacks).

**Steps:**

1. Extend `AgentConfigFile` (`src/config/agent-config.ts:82`):
   ```typescript
   readonly agentTools?: {
     readonly enabled?: boolean;        // umbrella; default true
     readonly tools?: {
       readonly glob?: boolean;
       readonly grep?: boolean;
       readonly multiedit?: boolean;
       readonly patch?: boolean;
       readonly todoRead?: boolean;
       readonly todoWrite?: boolean;
     };
   };
   ```

2. Extend `AgentConfig` (`src/config/agent-config.ts:125`) with a frozen resolved view:
   ```typescript
   readonly agentTools: {
     readonly enabled: boolean;
     readonly tools: {
       readonly glob: boolean;
       readonly grep: boolean;
       readonly multiedit: boolean;
       readonly patch: boolean;
       readonly todoRead: boolean;
       readonly todoWrite: boolean;
     };
   };
   ```

3. Defaults (applied AFTER all four tiers have been consulted; documented as starting values, not fallbacks):
   - `enabled: true`
   - `tools.glob: true`, `tools.grep: true`, `tools.multiedit: true`, `tools.patch: true`
   - `tools.todoRead: false`, `tools.todoWrite: false`

4. CLI flags — single coherent style. **Decision: discrete flags** (one per tool + umbrella). Justification: matches cli-agent's existing flag style (`--allow-mutations`, `--no-color`-style booleans, `--tool <name>` repeatable) and is unambiguous in shell completion. The composite `--agent-tools=tool1,!tool3` syntax was considered but rejected because it leaks negation semantics into a single string and is harder to compose with env/config. The discrete style adds 13 flags (1 umbrella on, 1 umbrella off, 6 enable, 6 disable):
   ```
   --no-agent-tools                  // umbrella off
   --agent-tools                     // umbrella on (default; rarely needed)
   --enable-agt-glob   --disable-agt-glob
   --enable-agt-grep   --disable-agt-grep
   --enable-agt-multiedit  --disable-agt-multiedit
   --enable-agt-patch  --disable-agt-patch
   --enable-agt-todo-read   --disable-agt-todo-read
   --enable-agt-todo-write  --disable-agt-todo-write
   ```
   Implementation in `src/cli.ts`: each pair as a Commander `.option()`. `disable` wins over `enable` if both are passed (raise `UsageError` instead — fail fast, no fallback).

5. Add env keys to `OTHER_ENV_KEYS` (`src/config/agent-config.ts:419`):
   ```
   'CLI_AGENT_DISABLE_AGENT_TOOLS',
   'CLI_AGENT_AGT_GLOB', 'CLI_AGENT_AGT_GREP', 'CLI_AGENT_AGT_MULTIEDIT',
   'CLI_AGENT_AGT_PATCH', 'CLI_AGENT_AGT_TODO_READ', 'CLI_AGENT_AGT_TODO_WRITE',
   ```
   Each per-tool env var is parsed as a tri-state: `'1'` / `'true'` → enable; `'0'` / `'false'` → disable; missing → no-op (defer to lower tier).

6. Resolution function `resolveAgentTools(layered, configFile, cliFlags)` returns the frozen `AgentConfig.agentTools`:
   - Walk: CLI flag → shell env → agent-tools-dir `.env` → local `.env` → `config.json` → default
   - **No fallback for required values** — but none of these are required; they all have defaults. The "no fallback" rule applies to *missing required* config; defaults for optional config are explicit starting values and are documented as such.

7. Configuration guide (`docs/design/configuration-guide.md`) updated with a new section per the existing template — see Phase 8.

**Files created/modified:**

| Path | Action |
|---|---|
| `src/config/agent-config.ts` | modified — `AgentConfigFile`, `AgentConfig`, `OTHER_ENV_KEYS`, `loadAgentConfig`, new `resolveAgentTools` helper |
| `src/cli.ts` | modified — 13 new `.option()` entries + a `mapAgentToolFlags` helper that writes to `AgentCliFlags.agentTools` |
| `src/config/agent-config.spec.ts` | extended (~200 LOC) — tier precedence per flag, conflict (enable+disable) raises `UsageError`, defaults applied last |

**Dependencies:** None (can run in parallel with Phase 2 / Phase 3).

**Acceptance criteria:**
- CLI flag `--no-agent-tools` overrides env `CLI_AGENT_DISABLE_AGENT_TOOLS=0` (CLI wins)
- Shell env `CLI_AGENT_AGT_TODO_READ=1` overrides `config.json agentTools.tools.todoRead: false`
- Local `.env` is overridden by both shell env and CLI flag
- Conflicting flags `--enable-agt-grep --disable-agt-grep` raise `UsageError` (exit 2) — not silent precedence
- Defaults applied: with no flags, no env, empty `config.json`, the resolved view is `{ enabled: true, tools: { glob: true, grep: true, multiedit: true, patch: true, todoRead: false, todoWrite: false } }`

**Verification commands:**
```bash
npm run typecheck
npx vitest run src/config/agent-config.spec.ts
```

---

### Phase 6 — System-prompt injection point

**Goal:** Inject a derived "## Optional standard tools (agent-tools pack)" block into the assembled system prompt, sourced from `agentToolsMeta` (which is sourced from the registered set), placed between the existing static standard-tools section and the user `--system` addendum. Byte-stable when the umbrella is off OR no bundled tool is registered.

**Steps:**

1. Add `buildAgentToolsPromptBlock(meta: AgentToolMetadata[]): string` in a new module `src/agent/tools/agent-tools/agent-tools-block.ts`:
   - If `meta.length === 0`: return `''` (caller will skip the section entirely)
   - Otherwise: emit
     ```
     ## Optional standard tools (agent-tools pack)

     The following tools are provided by the agent-tools pack. Each is described
     by its upstream prompt fragment.

     ---

     <fragment 1>

     ---

     <fragment 2>

     ...
     ```
     Separator `\n\n---\n\n` matches the upstream `buildSystemPromptBlock` convention (research §References, source 5).

2. Modify `buildSystemPromptForCfg` (`src/agent/system-prompt.ts:106`) to accept an optional 3rd argument `agentToolsBlock?: string`:
   - Composition order becomes: `baseText` + (capabilitiesSection? `'\n\n' + capabilitiesSection`) + (agentToolsBlock? `'\n\n' + agentToolsBlock`) + (custom? `'\n\n## User-provided instructions\n\n' + custom`)
   - When `agentToolsBlock` is empty/undefined, the assembled prompt is **byte-stable** with the previous behavior — verified by spec
3. Each call site in `src/agent/run.ts` builds the block from `agentToolsMeta` (Phase 4 returned it) and passes it through.
4. The prompt builder is **catalog-derived** by construction: `meta` came from `buildToolCatalog`, which honors all the gates from Phase 4. The invariant "what's in the prompt == what's in the catalog" is maintained (rejected option B1 from the investigation).

**Files created/modified:**

| Path | Action |
|---|---|
| `src/agent/tools/agent-tools/agent-tools-block.ts` | new (~50 LOC) |
| `src/agent/system-prompt.ts` | modified (`buildSystemPromptForCfg` accepts the block) |
| `src/agent/run.ts` | modified (4 call sites — pass meta through) |
| `src/agent/system-prompt.spec.ts` | extended (~120 LOC) — see Phase 9 |
| `src/agent/tools/agent-tools/agent-tools-block.spec.ts` | new (~80 LOC) — see Phase 9 |

**Dependencies:** Phase 4 (needs `agentToolsMeta` from `buildToolCatalog`).

**Acceptance criteria:**
- When the umbrella is on and 4 default-on tools registered: prompt contains `## Optional standard tools (agent-tools pack)` followed by 4 fragments separated by `\n\n---\n\n`
- When the umbrella is off: prompt is byte-identical to the pre-integration prompt (no header, no separator, no fragments)
- When only `agt_grep` is registered: only its fragment appears; the header is still present (one tool is still a registered tool)
- The block is positioned BEFORE the user `--system` addendum and AFTER the wrapped-CLI capabilities section

**Verification commands:**
```bash
npm run typecheck
npx vitest run src/agent/system-prompt.spec.ts src/agent/tools/agent-tools/agent-tools-block.spec.ts
```

---

### Phase 7 — Tokenizer-based budget assertion

**Goal:** A Vitest spec that uses `js-tiktoken` (already transitively present, D4 + research §3) with the `cl100k_base` encoding to assert per-tool and pack-level token ceilings. Documented in `project-functions.md`.

**Steps:**

1. Confirm `js-tiktoken` is resolvable from the project root:
   ```bash
   node -e "const t = require('js-tiktoken'); console.log(t.getEncoding('cl100k_base').encode('hello').length)"
   ```
2. Implement `src/agent/tools/agent-tools/agent-tools-block.spec.ts` (or a dedicated `token-budget.spec.ts` next to it) per the snippet in research §6:
   - Per-tool ceiling: **400 tokens** (research §5.2)
   - Default-on pack ceiling (4 tools, with header + separators): **2000 tokens** (research §5.2)
   - Full pack ceiling (6 tools): **2800 tokens** (research §5.2)
   - Encoder created once via `getEncoding('cl100k_base')`, freed in `afterAll`
   - Each `expect` carries an actionable error message (`tool name + actual count + ceiling`)
3. Document the ceilings in `docs/design/project-functions.md` under the new FR (§FR-NEW-* entries — Phase 8) so the rationale is in version control.
4. **If a per-tool fragment exceeds 400 tokens at first measurement**, the implementer trims the upstream prompt fragment (a small wrapper around the upstream text — keep semantic meaning, drop verbose examples). This is a *known author-time gate*, not a runtime fallback.

**Files created/modified:**

| Path | Action |
|---|---|
| `src/agent/tools/agent-tools/agent-tools-block.spec.ts` | extended OR `token-budget.spec.ts` (new ~70 LOC) — implementer chooses; both options leave the assertion in a single spec file |
| `docs/design/project-functions.md` | extended (Phase 8) — records the ceilings as part of NFR-NEW-001 |

**Dependencies:** Phase 6 (needs `buildAgentToolsPromptBlock` and the metadata pipeline).

**Acceptance criteria:**
- `npx vitest run` includes the new spec; assertions pass
- If a fragment is too long, the test fails with a message naming the offending tool and the actual vs. ceiling counts

**Verification commands:**
```bash
npx vitest run src/agent/tools/agent-tools/
```

---

### Phase 8 — Documentation updates

**Goal:** All project documentation reflects the new pack: tool reference doc extended, architecture doc and component list updated, functional requirements registered, configuration guide describes every new flag/env/config key, opt-out matrix landed.

**Steps:**

1. **`docs/tools/cli-agent.md`** — extend the `<cliAgent>` block with a new `<agentToolsPack>` subsection that:
   - Lists the 6 tools (name, one-line purpose, default state, mutation-gated y/n)
   - Documents the 13 CLI flags + 7 env vars + `config.json agentTools` shape
   - Documents how to opt out at three different granularities (umbrella, per-tool, mutation-gating)
2. **`docs/design/project-design.md`** — Section 4 (Tool Catalog):
   - Add a new sub-table "Agent-tools pack (curated subset, vendored from `BikS2013/agent-tools`)" with the 6 tools
   - Section 2 (Architecture) — add the agent-tools group to the `buildToolCatalog` description
   - Add Section 4a "Agent-tools pack" describing: vendoring layout, `cliAgentPermissionPolicy` bridge, `SessionStore` lifetime, `RunnableConfig.configurable` injection
3. **`docs/design/project-functions.md`** — register new functional requirements as **accepted**:
   - `FR-NEW-001` through `FR-NEW-009` and `NFR-NEW-001` through `NFR-NEW-004` (full text from refined-request §Requirements; copy verbatim and mark `Status: Accepted`)
   - This file update happens **after the plan is saved** (per the user's instruction at the bottom of the prompt — "Update project docs: After saving the plan, append the new functional requirements")
   - Per-IDs naming: keep the FR-NEW-* numbering from the refined request; do not renumber to FR-AGT-018+ (the FR-NEW-* prefix marks them as deriving from this integration)
4. **`docs/design/configuration-guide.md`** — new section "Agent-tools pack" per the configuration-guide template (multi-source priority, purpose, source rules, recommended storage, options, defaults). Includes the **opt-out matrix**:

   | Behavior | CLI flag | Env var | `config.json` |
   |---|---|---|---|
   | Disable whole pack | `--no-agent-tools` | `CLI_AGENT_DISABLE_AGENT_TOOLS=1` | `agentTools.enabled: false` |
   | Enable `agt_grep` (default-on; rarely needed) | `--enable-agt-grep` | `CLI_AGENT_AGT_GREP=1` | `agentTools.tools.grep: true` |
   | Disable `agt_grep` | `--disable-agt-grep` | `CLI_AGENT_AGT_GREP=0` | `agentTools.tools.grep: false` |
   | Enable todo pair (default-off) | `--enable-agt-todo-read --enable-agt-todo-write` | `CLI_AGENT_AGT_TODO_READ=1`, `CLI_AGENT_AGT_TODO_WRITE=1` | `agentTools.tools.todoRead: true`, `agentTools.tools.todoWrite: true` |

   Note: no PAT/token-style expiring values are introduced by this pack, so the configuration-guide expiration-date subsection does not apply.
5. **`CLAUDE.md`** — Tools section reference: cli-agent entry already exists. **Confirm no change needed** by re-reading the existing entry; the agent-tools pack is documented as part of `cli-agent`, not as a separate tool, so the CLAUDE.md reference list is unchanged.
6. **`Issues - Pending Items.md`** — update under "Completed items" (or create if missing) to register the integration's completion + the SHA pinned in Phase 1.

**Files created/modified:**

| Path | Action |
|---|---|
| `docs/tools/cli-agent.md` | extended |
| `docs/design/project-design.md` | extended (§2, §4, new §4a) |
| `docs/design/project-functions.md` | extended (10 new entries) |
| `docs/design/configuration-guide.md` | extended (new section + opt-out matrix) |
| `CLAUDE.md` | re-checked, expected no-op |
| `Issues - Pending Items.md` | extended |

**Dependencies:** Phase 7 (token ceilings need to be settled before they're documented).

**Acceptance criteria:**
- All four design docs cross-reference each other (project-design ↔ project-functions ↔ configuration-guide ↔ docs/tools/cli-agent.md)
- The opt-out matrix in `configuration-guide.md` matches exactly what `agent-config.spec.ts` exercises
- `CLAUDE.md` Tools section unchanged; the cli-agent entry's description still reads accurately

**Verification commands:**
```bash
grep -l "agent-tools" docs/design/*.md docs/tools/*.md
grep -l "FR-NEW-" docs/design/project-functions.md
```

---

### Phase 9 — Test coverage

**Goal:** A complete Vitest test surface across unit, registry, config, prompt, and integration layers — designed to be executed in parallel by multiple test-builder agents in the workflow's parallel-coders phase.

**Test buckets (parallelizable):**

| Bucket | Files | Owner-friendly chunk |
|---|---|---|
| **B-A: Wrapper unit tests** | 6 specs, one per `agt_*` wrapper. Each: happy path + 1 error path. Mock vendored upstream tool's `execute` to return both `ok` and `err` cases. Verify that `RunnableConfig.configurable.workingDirectory` is honored. | `src/agent/tools/agent-tools/agt-glob.spec.ts` ... `agt-todo-write.spec.ts` |
| **B-B: Permission bridge** | `permissions.spec.ts` — 4 tests (one per `PermissionPolicy` method) confirming each route hits cli-agent's existing primitive (allowlist, sandbox, mutations gate, env scrub). | `src/agent/tools/agent-tools/permissions.spec.ts` |
| **B-C: Catalog under flag combinations** | `registry.spec.ts` (new) — exercises the matrix: `(umbrella on/off) × (--allow-mutations on/off) × (per-tool flags various)`. Asserts the resulting tool name set and the `agentToolsMeta` length. | `src/agent/tools/registry.spec.ts`, `src/agent/tools/agent-tools/group-builder.spec.ts` |
| **B-D: Config tier precedence** | `agent-config.spec.ts` extension — for each new flag: CLI > env > local-`.env` > agent-dir-`.env` > config.json > default. Plus the conflict (enable+disable raises `UsageError`). | `src/config/agent-config.spec.ts` |
| **B-E: Prompt block inclusion / exclusion + token budget** | `system-prompt.spec.ts` extension + `agent-tools-block.spec.ts` (new). Block present iff catalog non-empty. Block byte-stable with previous behavior when umbrella off. Per-tool / pack token ceilings asserted via `js-tiktoken cl100k_base` per Phase 7. | `src/agent/system-prompt.spec.ts`, `src/agent/tools/agent-tools/agent-tools-block.spec.ts` |
| **B-F: End-to-end ReAct integration** | One spec that builds an agent with a stub LLM (returns a single `tool_calls` block invoking `agt_grep`), runs `streamOneShotAgent`, and asserts the bundled tool was actually called. The stub LLM is a `BaseChatModel` subclass returning a hard-coded `AIMessage` with `tool_calls`. | `src/agent/integration/agent-tools-end-to-end.spec.ts` (new) |

**Parallelization map** (for the workflow's parallel-coders phase):

- **B-A** is the largest fan-out (6 specs); each spec is independent and uses its own mock — assign each to a separate parallel coder.
- **B-B**, **B-C**, **B-D**, **B-E**, **B-F** are each a single-author chunk and can run in parallel with each other and with B-A.

**Dependencies:** Phases 2–6 must have landed (the modules being tested must exist).

**Acceptance criteria:**
- All new specs pass: `npx vitest run`
- The pre-integration test count (130) plus the new specs all green
- Coverage report shows the new modules at ≥ 80% branch coverage: `npm run test:coverage` then inspect `coverage/index.html`

**Verification commands:**
```bash
npm test
npm run test:coverage
```

---

## 4. Workflow parallelization map

Mapping the internal phases above to the workflow's "parallel coders" phase (Phase 6 of the workflow):

```
Sequential foundation:
  Phase 1 (vendoring + sync)
       │
       ▼
  Phase 2 (permission bridge)        ─┐
       │                               ├─ both depend only on Phase 1
  Phase 5 (config surface)           ─┘    (Phase 5 is independent of Phase 2)
       │       │
       ▼       ▼
  ┌────────────────────────────┐
  │ Parallel coders fan-out:    │
  │   Phase 3-glob   wrapper    │
  │   Phase 3-grep   wrapper    │
  │   Phase 3-multiedit wrapper │
  │   Phase 3-patch  wrapper    │
  │   Phase 3-todo-read wrapper │
  │   Phase 3-todo-write wrapper│
  └─────────────┬──────────────┘
                ▼
  Phase 4 (catalog registration)
       │
       ▼
  Phase 6 (prompt injection)
       │
       ▼
  Phase 7 (token-budget spec)
       │
       ▼
  Parallel test-builders (Phase 9 buckets B-A … B-F)
       │
       ▼
  Phase 8 (documentation)
```

**Coordination note:** Phase 5 (config) can land in parallel with Phase 2 (permissions) — they touch disjoint files. Phase 3 wrappers are 6 independent units once Phases 1+2 are done. Phase 9 test buckets are 6 parallel chunks.

---

## 5. File-creation matrix (consolidated)

**New files** (~22):

| Path | Phase |
|---|---|
| `scripts/sync-agent-tools.sh` | 1 |
| `src/agent/tools/agent-tools-vendored/**` (whole subtree) | 1 |
| `src/agent/tools/agent-tools-vendored/PROVENANCE.md` | 1 |
| `src/agent/tools/agent-tools-vendored/LICENSE` | 1 |
| `src/agent/tools/agent-tools/permissions.ts` | 2 |
| `src/agent/tools/agent-tools/permissions.spec.ts` | 9 (B-B) |
| `src/agent/tools/agent-tools/types.ts` | 3 |
| `src/agent/tools/agent-tools/index.ts` | 3 |
| `src/agent/tools/agent-tools/agt-glob.ts` | 3 |
| `src/agent/tools/agent-tools/agt-grep.ts` | 3 |
| `src/agent/tools/agent-tools/agt-multiedit.ts` | 3 |
| `src/agent/tools/agent-tools/agt-patch.ts` | 3 |
| `src/agent/tools/agent-tools/agt-todo-read.ts` | 3 |
| `src/agent/tools/agent-tools/agt-todo-write.ts` | 3 |
| `src/agent/tools/agent-tools/agt-glob.spec.ts` | 9 (B-A) |
| `src/agent/tools/agent-tools/agt-grep.spec.ts` | 9 (B-A) |
| `src/agent/tools/agent-tools/agt-multiedit.spec.ts` | 9 (B-A) |
| `src/agent/tools/agent-tools/agt-patch.spec.ts` | 9 (B-A) |
| `src/agent/tools/agent-tools/agt-todo-read.spec.ts` | 9 (B-A) |
| `src/agent/tools/agent-tools/agt-todo-write.spec.ts` | 9 (B-A) |
| `src/agent/tools/agent-tools/group-builder.ts` | 4 |
| `src/agent/tools/agent-tools/group-builder.spec.ts` | 9 (B-C) |
| `src/agent/tools/registry.spec.ts` | 9 (B-C) |
| `src/agent/tools/agent-tools/agent-tools-block.ts` | 6 |
| `src/agent/tools/agent-tools/agent-tools-block.spec.ts` | 9 (B-E) |
| `src/agent/integration/agent-tools-end-to-end.spec.ts` | 9 (B-F) |

**Modified files**:

| Path | Phases |
|---|---|
| `package.json` | 1 |
| `package-lock.json` | 1 (auto) |
| `src/agent/tools/registry.ts` | 4 |
| `src/agent/run.ts` | 4 |
| `src/agent/graph.ts` | 4 |
| `src/agent/system-prompt.ts` | 6 |
| `src/agent/system-prompt.spec.ts` | 9 (B-E) |
| `src/cli.ts` | 5 |
| `src/config/agent-config.ts` | 5 |
| `src/config/agent-config.spec.ts` | 9 (B-D) |
| `docs/tools/cli-agent.md` | 8 |
| `docs/design/project-design.md` | 8 |
| `docs/design/project-functions.md` | 8 (also pre-plan in this turn) |
| `docs/design/configuration-guide.md` | 8 |
| `Issues - Pending Items.md` | 8 |

---

## 6. Overall verification (gate before declaring complete)

```bash
# 1. Type-check
npm run typecheck

# 2. Build
npm run build

# 3. Full test suite
npm test

# 4. Coverage (informational — no hard gate, but inspect)
npm run test:coverage

# 5. Manual smoke — list catalog with default config and with --no-agent-tools
node dist/cli.js show-capabilities --tool grep || true   # not applicable — agt_grep is a standard tool, not a wrapped CLI
node dist/cli.js -i <<< '/help'                          # confirm /help still works; no regression
node dist/cli.js -i --no-agent-tools <<< '/help'

# 6. Verify vendored copy is reproducible
bash scripts/sync-agent-tools.sh && git diff --stat src/agent/tools/agent-tools-vendored/   # should be empty after a clean re-sync
```

**Gate:** Acceptance for the plan as a whole is the conjunction of all per-phase acceptance criteria above plus the FR-NEW-* mappings in §1.

---

## 7. Post-implementation: project-doc updates done in this turn

Per the user instruction at the bottom of the planner prompt, **after this plan is saved**:

1. The plan author appends FR-NEW-001 through FR-NEW-009 and NFR-NEW-001 through NFR-NEW-004 to `docs/design/project-functions.md` as **Accepted**, copying the text from `docs/design/refined-request-agent-tools-integration.md` §Requirements.
2. `project-design.md` is **NOT** updated yet — that is the Designer phase's job.

---

## 8. Notes for executors

- **Single biggest pitfall**: the upstream `toLangChainTool` adapter closes over `ToolContext` once at construction (research-toolcontext-injection §3 source 3). cli-agent's wrappers MUST NOT use that adapter. They build `DynamicStructuredTool` directly and pull live values from `RunnableConfig.configurable` per call. Any deviation breaks per-session `workingDirectory` / `sessionStore` injection.
- **Single biggest invariant to preserve**: the prompt block is *derived from* the registered set, not maintained separately. If a tool is unregistered, its fragment must not appear in the prompt — automatically. The `AgentToolMetadata[]` returned by `buildToolCatalog` is the single source of truth.
- **Smallest first step** (suggested in investigation §Implementation Considerations): land `agt_grep` end-to-end (Phase 1 vendor + Phase 2 permissions + Phase 3 grep wrapper + Phase 4 registration of just grep + Phase 6 prompt block of just grep + a single B-A spec for grep + the B-F integration spec). Confirm one tool flows cleanly through the whole stack before fanning out the other five wrappers.
