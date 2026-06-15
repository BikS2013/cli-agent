# Issues - Pending Items

## Pending

### [HIGH] Project `AGENTS.md` is not in sync with the current user-level Structure & Conventions chapter
- Surfaced during the 2026-06-14 project evaluation (`docs/reference/project-evaluation.md`).
- The current project `AGENTS.md` starts with a shorter/older `Structure & Conventions` chapter and does not include the current user-level request-refinement, investigation/research, codebase-scanning, and dependency-vetting rules.
- Impact: future agents working only from the project file may skip required refinement/scanning phases or dependency-vetting steps, producing workflow drift from the user-level instructions.
- Suggested fix: replace the leading `Structure & Conventions` chapter in `AGENTS.md` with the current user-level chapter, then verify the `Tools` section still remains concise and points to `docs/tools/cli-agent.md`.

### [HIGH] Web search backend ignores layered `.env` values for backend credentials
- Surfaced during the 2026-06-15 architecture review (`docs/reference/architecture-review-2026-06-15.md`).
- `bootstrapAgentDir` seeds `TAVILY_API_KEY`, `SERPAPI_API_KEY`, `BRAVE_API_KEY`, `WEB_SEARCH_URL`, `WEB_SEARCH_API_KEY`, and `WEB_SEARCH_MAX_REQUESTS` into `~/.tool-agents/cli-agent/.env`, and `loadAgentConfig` reads those keys into its layered env snapshot. However, `src/agent/tools/web/backends/registry.ts` and the `agt_web_*` wrappers read `process.env` directly, so values supplied only by the agent `.env` or local `.env` are not visible to the web backend.
- Impact: documented configuration sources do not work for web search unless the variables are exported in the shell; this violates the central configuration-resolution architecture and produces misleading `E_SEARCH_API_KEY_MISSING` errors.
- Suggested fix: add a resolved `webSearch` configuration snapshot to `AgentConfig` that carries backend credentials and `maxRequests` from the layered env resolver, then make `getWebBackend`, `agt_web_search`, and `agt_web_fetch` consume only that snapshot.

### [MEDIUM] Project design and requirements still describe pre-plan-011/012 tool catalog and old capability invalidation
- Surfaced during the 2026-06-15 architecture review (`docs/reference/architecture-review-2026-06-15.md`).
- `docs/design/project-design.md` still describes `file_read`, `file_list`, and mutating `file_*` tools as standard built-ins, while the current implementation has moved file operations into the agent-tools pack as `agt_file_*`. The same design and `docs/design/project-functions.md` also describe automatic capability-cache invalidation by binary path, mtime, and version hash, while `src/agent/capabilities/discover.ts` now intentionally trusts an existing capability document until explicit refresh.
- Impact: future design, implementation, and review work may reintroduce old assumptions, especially around `--no-builtin-tools`, file-tool availability, and startup cache freshness.
- Suggested fix: update `project-design.md` and `project-functions.md` to make the current contracts explicit: built-in toolkit is `bash_*` plus `tool_help`; file/web live in `agt_*`; normal startup uses the doc-exists shortcut; explicit refresh performs full rediscovery.

### [LOW] Partial-toolset fabrication hardening (defense-in-depth follow-up)
- The toolless-session fix (see Completed: "Toolless session fabricated tool output") injects the no-tools / anti-fabrication notice only when the catalog is **completely empty** (`registeredTools.length === 0`). In **partial** states — e.g. `--no-builtin-tools` with only `agt_glob`/`agt_grep` enabled — a user request that needs a missing capability (e.g. "run `git status`" when no bash tool is bound) could still be answered with fabricated output, because the always-empty tool blocks no longer carry the per-tool "X is not available" guidance for the *missing* tools.
- Mitigation already partly present: when `builtinTools` is on but `bash_run` is unbound, the built-in block says "command execution is not available"; the agt blocks describe what IS present. The gap is the cross-product of "tool group off + user asks for that capability".
- Suggested fix: add a single always-present CORE RULE — "Only report the output of a tool you actually called this turn; never fabricate or simulate results for a capability you do not have" — to the general rules (not gated on any toggle), so the anti-fabrication guidance survives every tool combination. Keep the dedicated empty-toolset notice as the strong explicit case.

### [LOW] Pre-existing duplicate `case` clause in src/tui/input/line-editor.ts (bundler warning only)
- Surfaced (not introduced) during the plan-007 integration-verification full-suite run: the Vite/esbuild transform emits `warning: This case clause will never be evaluated because it duplicates an earlier case clause` at `src/tui/input/line-editor.ts:641` (a `case 'unknown':` / `case 'enter':` / `case 'newline':` group that duplicates an earlier `case` in the same `switch`).
- Impact: cosmetic only — it is a build-time bundler lint warning, NOT a TypeScript error (`npm run typecheck` is clean) and NOT a test failure (suite is 954/954, exit 0). The duplicated branch is dead code; behaviour is unchanged because the earlier matching clause already handles those labels.
- Unrelated to the LLM I/O inspector (no `src/tui/input/` files were touched by plan-007). Pre-existing.
- Suggested fix: remove the redundant `case` labels at line 641 (or consolidate the two switch arms) so the bundler warning clears. No functional change.

### [LOW] LLM I/O inspector — minor as-built deviations from design-007 (informational)
- `src/agent/graph.ts`: invoke-path capture factored into a module-private `captureInvokePath(...)`; terminal `captureResponse` de-duplicated when a turn ends on an already-captured tool-calling step; `runInteractiveAgent`'s legacy 4-arg `runOneShot` call left uninstrumented (capture is wired via `runOneShotAgent`/`streamOneShotAgent`/`buildTuiAgentRuntime`).
- `src/agent/io-capture.ts`: `FIELD_TRUNCATE_BYTES` (64 KiB) replicated as a local const (logging.ts keeps it module-private); truncation is a recursive deep-walk; `tool_result.result` routed through `redactObject`. The deep-walk emits `_orig_size_bytes` as an object map (dotted field-path → original byte size) rather than a scalar — RECONCILED in Phase-7 review: design-007 "Field-cap & redaction markers" and `project-design.md` now document the object-map shape (richer implementation retained; `docs/tools/cli-agent.md` was already accurate).
- `src/tui/slash/inspect.ts`: `/inspect show` clips each rendered block at a 4000-char `RENDER_BLOCK_MAX` (presentation-only; on-disk JSONL retains the 64 KiB-capped field) with a visible `… [truncated]` marker; `/inspect-io` registered as an alias.
- Out-of-ownership minimal typecheck fixes (required-field propagation, documented): `inspectIo: null` added to the `AgentConfig` fixture in `src/agent/providers/registry.spec.ts` (Unit A); `ioCapture: new NullIoCapture()` added to the `TuiController` fixture in `src/tui/controller.spec.ts` (Unit D).
- Disposition: all design-faithful; no action required. Listed for traceability.

### [LOW] Pre-existing flaky test: composite synthesizer.spec.ts temp-dir cleanup race
- During the plan-007 full-suite run, `src/agent/composite/synthesizer.spec.ts > … (E-5)` failed once with `ENOTEMPTY: directory not empty, rmdir '…/capabilities/composite/_distill'`. Re-running the spec in isolation passes 11/11. Unrelated to the LLM I/O inspector (no `src/agent/composite/` files were touched; capture is off by default).
- Root cause: a temp-dir cleanup race under vitest parallel execution (afterEach `rmdir`/`rm` on a directory still being written). Pre-existing flakiness.
- Suggested fix: make the synthesizer spec's temp-dir teardown hermetic (`fs.rm(dir, { recursive: true, force: true })` and/or unique per-test dirs; await all async writes before cleanup).

### [LOW] plan-006 §14.P named cache-export rename (readCompositeCacheEntry / writeCompositeCacheEntry → readCompositeDoc / writeCompositeDoc)
- Design §14.P names U-DOC's exports as `readCompositeCacheEntry` /
  `writeCompositeCacheEntry`. The implementation chose
  `readCompositeDoc` / `writeCompositeDoc` (no behavioural change — same
  signature, same atomic write, same frontmatter parsing) and
  `mirrorCompositeDocToCapabilities` matches §14.P verbatim.
- Disposition: minor cosmetic deviation; implementation names better
  reflect that the unit's payload is a parsed doc, not a generic cache
  entry. The cache-key composition + invalidation contract from §14.L
  is honoured (`computeMemberDocDigest`, `computeSyntheticDigest`,
  `canonicaliseSyntheticInputs` are exported and exercised by tests).
- Suggested follow-up: a one-line note in §14.P clarifying the
  rename to keep doc and code in lockstep. No code change required.

### [MEDIUM] Pre-existing dependency-tree security & deprecation backlog
- Surfaced by `dependency-validator` during plan-005 Phase 8. **None introduced by config-profiles** — all are pre-existing and could not be auto-fixed because remediation requires major-version migrations.
- Full report: `docs/reference/dependency-validation-config-profiles.md`.
- Items:
  - **vitest 2 → 4 migration** — closes 1 deprecation (`glob`) and several vite/esbuild CVEs in the test toolchain.
  - **`@langchain/anthropic` upgrade** — blocked on upstream shipping `@anthropic-ai/sdk >= 0.91.1`.
  - **uuid override decision** for the langgraph dependency chain.
  - Two additional minor advisories detailed in the report.
- Suggested approach: dedicated upgrade tasks per item; do not bundle with feature work.
- **Update (plan-007 validation, 2026-06-13):** Re-confirmed the LLM I/O inspector added NO dependencies (report: `docs/reference/dependency-validation-llm-io-inspector.md`). Changes since plan-005: (a) the `vitest` advisory severity escalated to **CRITICAL (CVSS 9.8)** and a new `langsmith` high advisory (CVSS 7.1) was published upstream — both pre-existing in the tree, not introduced here; (b) `@langchain/anthropic@1.4.1` and `@langchain/langgraph@1.4.2` resolved their advisories upstream WITHIN the existing caret ranges, so a plain `npm update` would close two CVEs with no manifest edit. NOT applied here — deliberately not bundled with feature work, and `@langchain/langgraph` powers the new `streamEvents` capture hooks, so that bump must be validated on its own.

### [MEDIUM] plan-005 E10 load-time toolArgs schema validation — defer to v2
- **E10**: `validateToolArgsAgainstTool(name, args, schema?)` was originally named in plan-005 §6 / project-design §12.D so profile load could Zod-validate `toolArgs` entries against each tool's input schema (`.partial()`) and surface a hard `ConfigurationError` at load time for malformed presets against known schemas.
- v1 disposition: NOT implemented. The shallow merge already lets runtime input override preset keys, so a bad preset value surfaces as a Zod parse error at the moment the LLM first calls the tool. This is acceptable for v1; the comment at the top of `src/agent/tools/profile-tool-args.ts` documents the disposition.
- Suggested fix (v2): implement `validateToolArgsAgainstTool` in `profile-schema.ts`, plumb a tool-name → input-schema map from `registry.ts` to `loadProfile` (or evaluate at catalog assembly), and emit ConfigurationError for known schemas, stderr warning otherwise.

### [LOW] Schema-2 capability migration may emit a one-time refresh on upgrade
- 0.3.0 bumps the capability-doc schema from 1 to 2 (adds `manRef` /
  `manPagePath` frontmatter fields and the USER-RECIPES marker pair). Per
  `cache.ts`, schema-1 docs are treated as a cache miss on first read after
  upgrade; the next agent invocation re-runs discovery and writes a v2 doc.
- Existing USER-NOTES content is preserved byte-for-byte through the existing
  `composeCapabilityDoc(opts, existingDoc)` path.
- Pre-upgrade hand-edited content that lived OUTSIDE USER-NOTES (e.g. inside the
  AUTO-GENERATED block) is overwritten by the regenerated content — that was
  already the case in v1, so no new risk, but worth flagging.
- Action: leave this entry until the first 0.3 release ships; remove afterwards.

### [LOW] TUI does not react to terminal resize (SIGWINCH) mid-edit
- The wrap-redraw fix tracks terminal rows correctly given the current `process.stdout.columns`
  value, but if the user resizes the terminal between two keystrokes the previous render's row
  count was computed against the old width. The next redraw's clear math will be off by however
  many rows the resize introduced or removed, leaving stale text or over-clearing real output.
- Suggested fix: subscribe to `process.stdout.on('resize', ...)` and on each event call
  `redrawCurrentLine` with `prevTermRows = 1` after first issuing a clear-screen-from-cursor-down
  (`\x1b[J`). Or: reset the editor's `prevTermRows` cache to `state.lines.length` on resize.
- Workaround for users: avoid resizing the terminal while editing; press Enter or Ctrl+C to
  resync.

### [LOW] Suggest hardening the asset-copy postbuild step
- `scripts/copy-vendored-assets.mjs` (added during Phase 10 verification) walks `src/`
  and copies `.md` / `.txt` / `.json` files into `dist/` so the vendored
  agent-tools `*.prompt.md` files are present at runtime. The implementation works
  but is broad (it will copy ANY `.md` placed under `src/`, not just vendored
  prompts). A future iteration could narrow the include set to
  `src/agent/tools/agent-tools-vendored/**/*.prompt.md` plus any explicitly
  whitelisted assets.

### [HIGH] Expiry warning for Azure API keys not yet implemented
- `config.json` accepts `_azure_openai_key_expires` and similar fields per the configuration guide,
  but `loadAgentConfig` does not yet read them or emit warnings on startup.
- Planned for a follow-up iteration.

### [MEDIUM] Agent-tools vendored copy has no automated re-sync alerting
- The vendored subset under `src/agent/tools/agent-tools-vendored/` is pinned to upstream SHA
  `b8ab63b2f4124325a31e00c9afd3645f02ffd072` and refreshed manually via
  `bash scripts/sync-agent-tools.sh --sha <sha>` (the current SHA is recorded in
  `src/agent/tools/agent-tools-vendored/PROVENANCE.md`).
- No scheduled job or CI hook compares the pinned SHA against `BikS2013/agent-tools` HEAD;
  drift detection and security-patch propagation are entirely manual.
- Suggested follow-up: add a scheduled GitHub Action that runs `git ls-remote` against
  upstream, diffs against the recorded SHA, and opens an issue (or PR running the sync
  script) when they diverge. The sync script already runs `npm run typecheck`, so the
  PR would surface API drift automatically.

### [MEDIUM] Upstream `BikS2013/agent-tools` does not ship a top-level LICENSE file
- The vendor sync script writes a synthesized MIT license text to
  `src/agent/tools/agent-tools-vendored/LICENSE` because the upstream tree has no
  redistributable license file at its root, despite `package.json` declaring `"license": "MIT"`.
- This works for distribution but is a provenance smell — the synthesized text is not
  byte-equivalent to anything the upstream maintainer signed.
- Suggested follow-up: file an issue against `BikS2013/agent-tools` requesting a real
  LICENSE file (and a `NOTICE` if applicable). Once present, drop the synthesizer in
  `scripts/sync-agent-tools.sh` and copy the upstream file verbatim.

### [MEDIUM] `robots.txt` check in web_fetch is simplified
- The current implementation does a best-effort check for `Disallow: /` on the root `robots.txt`.
- A full robots.txt parser (honoring `Disallow: /path`, `User-agent:` sections, `Crawl-delay`, etc.)
  is deferred as it requires a dependency or significant custom parsing logic.

### [LOW] `config.json` not auto-seeded on first run
- If `~/.tool-agents/cli-agent/config.json` does not exist, the agent starts without defaults
  (throws if `provider` is not provided by any other source). The guide says to copy
  `docs/reference/config.json.example` into place on first run. This auto-seed step is not
  yet implemented in `bootstrapAgentDir`.

### [LOW] Capability extraction depth > 2 not tested
- The discovery orchestrator supports `depth >= 2` for per-subcommand drill-down but does not
  recurse further (depth 3+). The depth config is respected for enabling/disabling the
  per-subcommand pass, but deeper recursion would require a recursive call to `extractSubcommands`
  on each subcommand's own subcommands.

### [LOW] `--bash-allow-file` with `argv-regex:` prefix not tested end-to-end
- Unit tests cover the allowlist parser for `argv-regex:` entries but there is no integration test
  for the `--bash-allow-file` flag reading a file that contains `argv-regex:` entries.

### [LOW] TUI: `/history` thread-selection (load as read-only context) deferred
- The MVP `/history` command lists past threads from `~/.tool-agents/cli-agent/history/index.jsonl`
  but does not yet support selecting a row to load that thread as read-only context for the
  active session. Selection requires terminal-side interaction beyond the simple slash dispatch
  (a numeric prompt or arrow-key picker), so it is registered as a follow-up.

### [LOW] TUI: per-tool-call collapsible expansion (Tab key) not implemented
- Tool-call summaries currently render single-line and stay that way. Pressing Tab over a
  summary to expand the captured stdout/stderr is described in the brief but is deferred.
  The full output is already available in `~/.tool-agents/cli-agent/logs/`.

## Completed

### Done — Toolless session fabricated tool output (hallucinated a directory listing with no tools loaded)
- **Symptom**: Running `cli-agent --no-builtin-tools --no-composites --no-agent-tools` (every tool group disabled — the documented "plain conversational LLM" state) and asking "list files in current folder" produced a fabricated `ls -la`-style directory listing (root-owned `main.py` / `README.md` / `data/` / `scripts/`). `/inspect show` confirmed the response carried **zero tool calls** — pure hallucination presented as real filesystem output. The agent also claimed *"I can run commands and use CLI tools on your machine"* despite having none.
- **Root cause**: When all tool groups are off, `buildToolCatalog` returns an empty `tools` array (correct) and `buildSystemPrompt`'s built-in + agent-tools blocks both render `''`. The assembled system prompt collapsed to the slim base identity alone — *"You are cli-agent... by invoking external CLI tools on their local machine"* — which asserts the agent is a tool-user, while **no tools are bound and nothing told the model it was toolless**. Every anti-fabrication line ("treat command output as read-only evidence", "never fabricate URLs") lived inside the now-empty tool blocks, so they vanished too. Result: the model role-played a tool-user with no tools and invented output. The `buildToolCatalog` empty-toolset warning existed only on **stderr (to the user)**, never in the **prompt (to the model)**.
- **Fix** (root cause, at the prompt-assembly layer):
  - `src/agent/system-prompt.ts` — added a `NO_TOOLS_BLOCK` constant (a "## No tools are available this session" notice: states the agent cannot run commands / read-write files / list dirs / access the internet, and **forbids fabricating, guessing, or role-playing** command output, directory listings, file contents, or URLs; tells the user how to re-enable tools). `buildSystemPrompt` gained a `noToolsAvailable = false` param that injects the block right after the base identity. `buildSystemPromptForCfg` computes `noToolsAvailable = registeredTools.length === 0` and passes it — mirroring the existing catalog stderr warning into the prompt the model sees.
  - All entry points already pass `buildToolCatalog(...).tools` as `registeredTools` (`run.ts:31` + the TUI slash rebuilders), so the guard fires automatically whenever the catalog is empty (all groups off, or a profile scopes the catalog to nothing).
- **Tests**: 5 new tests in `src/agent/system-prompt.spec.ts` (pure-composer injects/omits the notice by flag; `buildSystemPromptForCfg` injects on empty catalog and omits when a tool is present). AC-2 byte-equivalence test updated to pass a registered tool (so it isolates the "no built-in block" contract without tripping the new toolless guard). Plus `test_scripts/verify-no-tools-notice.ts` — an end-to-end repro that loads the real toolless config, asserts 0 tools, and confirms the notice is in the assembled prompt. Full suite 1112 → **1117 green**; typecheck + build clean.
- **Follow-up logged below** (LOW): partial-toolset fabrication hardening.

### Done — `--builtin-tools` / `--no-builtin-tools` help text still listed `web_*` after web moved to the agent-tools pack (plan-011)
- **Symptom**: The CLI help for `--builtin-tools` and `--no-builtin-tools` described the built-in cross-cutting toolkit as `file_*, web_*, bash_*, tool_help`. After plan-011 web is NO LONGER built-in — it moved to the agent-tools pack as `agt_web_search` / `agt_web_fetch` — so the help wrongly implied `--no-builtin-tools` drops web. Web is now governed by `--no-agent-tools` / `--disable-agt-web-search` / `--disable-agt-web-fetch`.
- **Root cause**: plan-011 §6 cleaned the live system-prompt built-in block (`buildBuiltinToolsPromptBlock`) and `BUILTIN_TOOL_PROMPTS` (no `web_*` keys remain) and added the `agt_web_*` flags, but the two Commander `.option(...)` help strings for the built-in-tools toggle were left referencing `web_*`. The captured `--help` baseline carried the same stale text.
- **Fix**:
  - `src/cli.ts:112-113` — both help strings now read `file_*, bash_*, tool_help` (web removed).
  - `test_scripts/baselines/help-no-treat-as-tool.txt:40-41` — baseline re-recorded to match.
  - Rebuilt `dist/` so the compiled binary matches; `src/cli-help-baseline.spec.ts` (NFR-CMP-001 byte-stability) passes 2/2.
- **Investigated but intentionally left as-is (NOT a bug)**: `LEGACY_DEFAULT_SYSTEM_PROMPTS[0]` in `src/agent/system-prompt.ts` still contains `web_search`/`web_fetch` text. That array is a deliberately frozen historical snapshot used by `bootstrapAgentDir` for byte-exact detection of unmodified seeded `system-prompt.md` files; editing it would break upgrade-in-place detection. The live prompt path already omits web per plan-011.

### Done — capability docs always preserve user-curated sections (USER-NOTES, USER-RECIPES)
- **Symptom**: a previously curated capability doc could lose its `USER-NOTES` and/or `USER-RECIPES` content under two paths:
  1. Binary not found on PATH → `discoverTool` wrote a fresh schema-1 "BINARY NOT FOUND" placeholder over any existing doc, dropping all user-curated content and omitting the `USER-RECIPES` markers entirely (which then broke `extract-recipes` for that tool).
  2. Schema mismatch on forced refresh → `discoverTool` extracted the existing doc through `readCacheEntry`, which returns `null` for any doc whose `schemaVersion` differs from the supported value (schema-1 legacy docs, schema-3 composite mirrors), so the composer received `undefined` for `existingDoc` and silently dropped the user content.
- **Fix**:
  - `src/agent/capabilities/cache.ts` — added `readRawCapabilityDoc(capabilitiesDir, tool)` that returns the on-disk file contents regardless of schema version. This is the new preservation seam for user-curated sections.
  - `src/agent/capabilities/discover.ts` — main compose path now reads the existing doc via `readRawCapabilityDoc` (so legacy schemas keep their notes/recipes through regeneration); binary-not-found placeholder reads existing user content and re-emits it inside the placeholder, always seeds both `USER-RECIPES` and `USER-NOTES` marker pairs, and stops downgrading `schemaVersion` to 1.
  - `src/agent/capabilities/discover.spec.ts` — three new regression tests: schema-1 → re-introspect preserves notes; binary-not-found preserves notes + recipes from a v2 doc; fresh capabilities dir still seeds both marker pairs.
- **Behaviour guarantee**: `discoverTool` never deletes a capability doc, and any rewrite preserves the `<!-- USER-NOTES … -->` and `<!-- USER-RECIPES … -->` blocks verbatim. Composite delete (`composite delete` / `composite/regen.ts`) is the only remaining path that removes a capability file, and that is user-initiated.
- All 826 tests pass, including the 3 new regression tests.

### Done — plan-005 Phase 7 deferred items closed (AC-19, E9, AC-22)
- **AC-19 / FR-PROF-007** — `profile_active` JSONL log event added.
  - `LogEvent` union in `src/agent/logging.ts` extended with
    `{ kind: 'profile_active'; ts; sessionId; profileName; profilePath; schemaVersion; digest }`.
  - `src/agent/run.ts` emits the event after `session_start` and before `user_prompt`,
    gated on `cfg.activeProfile`, in all four entry points: `runOneShotAgent`,
    `streamOneShotAgent`, `buildTuiAgentRuntime`, `runInteractiveAgent`.
  - Hermetic test in `src/agent/logging.spec.ts` constructs the event and verifies
    the serialized fields.
- **E9** — profile `toolArgs` dead-reference warning.
  - `buildToolCatalog` in `src/agent/tools/registry.ts` walks
    `cfg.activeProfileData?.toolArgs` keys after scoping and emits a
    non-fatal stderr warning per name not present among survivors:
    `"profile toolArgs references tool 'X' that is not in the active catalog (excluded by allow/deny or unknown)"`.
  - Three tests in `src/agent/tools/registry.spec.ts` cover excluded-by-deny,
    unknown-name, and the no-warning case for surviving keys.
- **AC-22 / NFR-PROF-001** — cold-start smoke script.
  - `test_scripts/smoke-profile-cold-start.ts` added; spawns three cold
    `node dist/cli.js --help` runs and reports min/median/max in ms.
  - Documented in `test_scripts/README.md` with the ≤ 50 ms regression
    budget. Smoke is informational; does not gate CI.

### Done — User-editable tool prompt overlays (plan-004, v0.2.0)
- **Goal**: let end users tune the LangChain `description` and per-parameter
  `.describe(...)` strings every native tool exposes through `bindTools`,
  WITHOUT forking the binary. See `docs/design/plan-004-tool-prompt-overlays.md`
  and project-design §11 / FR-OVR-001..008.
- **Implementation**:
  - New canonical registry at `src/agent/tools/tool-prompts-builtin.ts`
    holding the EXACT current strings for all 17 native tools. Used as the
    single source of truth by the bootstrap, the three new commands, and
    every tool factory.
  - New loader/parser at `src/agent/tools/tool-prompt-overlay.ts`
    (regex-based, no new npm dep). Parses `~/.tool-agents/cli-agent/tool-prompts/<name>.md`
    files; raises `ConfigurationError` (with file path) on malformed input;
    returns an empty registry when the dir is absent — the documented
    "no overlay" state.
  - `bootstrapAgentDir` (and a new `bootstrapToolPromptsDir`) seed all 17
    overlay files (mode 0600 inside a 0700 dir) on first run; existing
    files are NEVER overwritten. Newly seeded names are reported to stderr.
  - Three new CLI subcommands wired into `src/cli.ts` with the
    `optsWithGlobals` + `pickFirstTool` recovery pattern:
    `extract-tool-prompts [--force]`, `show-tool-prompt --tool <name>`,
    `audit-tool-prompts [--strict]`.
  - All 17 tool factories now consult the overlay registry via
    `getToolDescription` / `getParamDescription` helpers; the
    `AGT_*_DESCRIPTION` constants are now thin aliases for
    `BUILTIN_TOOL_PROMPTS[<name>].description` (single literal per tool).
  - `AgentConfig` gains `toolPromptsDir` + `toolPromptOverlays`
    (marked optional on the static type to keep older test fixtures
    type-compatible; runtime always populates them).
  - Version bump 0.1.4 → 0.2.0.
- **Tests**: 21 new tests across two new spec files
  (`tool-prompt-overlay.spec.ts`, `tool-prompts-builtin.spec.ts`).
  Full suite 308 → 329 passing. `npm run build` clean. Smoke-tested on a
  fresh temp HOME — all 17 overlay files seeded with non-empty content,
  all three new subcommands return valid `--help` output and produce
  expected output end-to-end.

### Done — TUI input "creep-up" on word-motion against a wrapped line
- **Symptom (after 0.1.3)**: pressing word-left or word-right on a wrapped line caused the entire
  input block to visually shift up by one terminal row on each keystroke, without scrolling the
  rest of the screen. Repeated motions made the input climb out of view.
- **Root cause**: `redrawCurrentLine` started each redraw with `cursorUp(prevTermRows - 1)`,
  assuming the cursor was at the *bottom* of the previous render. But the previous redraw had
  positioned the cursor at the *target* row, which after Home/word-left was the top (row 0)
  of the input. From row 0 of input, `cursorUp(prevTermRows - 1)` overshoots above the input
  area; `\x1b[J` then wipes one extra row above input, and the new content fills from there
  downward — visually one row higher than before.
- **Fix**: changed the redraw API to pass and return a `RedrawState` carrying both the row count
  AND the cursor's row offset from the top of the previous render. The clear-step now does
  `cursorUp(prev.cursorRowFromTop)` — exactly the right distance regardless of where the cursor
  was left previously.
- **Regression coverage**: `src/tui/input/line-editor-wrap.spec.ts` extended with 5 new tests:
  cursor-row tracking, "no cursorUp emitted when prev cursor was at top", full Home → Right →
  Right scenario, word-right staying on row 0, word-left dropping cursor row by row. 15 wrap
  tests total.

### Done — TUI smearing on Home-then-Right (and other state changes after wrap)
- **Symptom (after 0.1.2)**: even with the terminal-row tracking fix, typing a long line then pressing
  Home and pressing Right (or any cursor motion) still produced duplicated tail content below the
  active line. The original tail kept reappearing under each keystroke.
- **Root cause**: the per-row `CLEAR_LINE + \n` clear loop in `redrawCurrentLine` was sound when
  `prevTermRows` exactly matched the actual terminal-row count of the previous render — but it had
  no recovery path if the count drifted by even one. Drift can happen when:
  - the terminal soft-wraps at a different column than `process.stdout.columns` reports (Greek
    fonts in some terminals render slightly wider than 1 cell each)
  - the terminal scrolled between the previous render and the current one
  - any unrelated writer wrote to stdout during the input loop
  The original line-by-line loop trusted the count completely; one drift sufficed to leave stale
  rows visible, which the next render then "patched over" instead of clearing.
- **Fix**: replaced the per-row clear loop with a single `\x1b[J` (erase from cursor to end of
  screen) after moving up to the top of the previous render. This is a terminal-native operation
  that wipes every row from the cursor downward in one shot, regardless of row count or any
  scroll/drift. The cursor-positioning math from 0.1.2 is preserved.
- **Regression coverage**: extended `src/tui/input/line-editor-wrap.spec.ts` with a Home → Right →
  Right scenario asserting that each redraw emits exactly one `\x1b[J` and zero leftover
  `CLEAR_LINE` (`\x1b[2K`) escapes. 10 wrap tests total now.

### Done — TUI input renderer smeared `You> ...` lines when input wrapped past terminal width
- **Symptom**: typing a long line (e.g. Greek prose past ~80 chars) produced a cascade of duplicate
  `You> ...` lines, one per keystroke, growing across the screen.
- **Root cause**: `redrawCurrentLine` (`src/tui/input/line-editor.ts`) tracked `state.lines.length`
  — the count of *logical* lines (split on user-pressed newlines) — and used that as the count of
  terminal rows it had previously occupied. When a logical line was longer than `process.stdout.columns`
  it soft-wrapped to multiple terminal rows, but `prevLines` stayed `1`, so only one row was cleared
  per redraw. Subsequent redraws started one row below the previous content, leaving stale prompt
  copies above.
- **Fix**: `redrawCurrentLine` now tracks **terminal rows**, computing
  `ceil((promptWidth + contentWidth) / cols)` per logical line. The clear loop, the cursor-positioning
  math, and the returned row count all use this terminal-row metric. Cursor is positioned with
  `cursorUp` + `\r` + `cursorRight(targetCol)` instead of relying on `cursorLeft` from end-of-line
  (which broke once the end-of-line wrapped).
- **Regression coverage**: `src/tui/input/line-editor-wrap.spec.ts` — 9 tests covering wrap math,
  Greek BMP input, multi-line buffer with one wrapped line, phantom-column boundary, non-TTY stdout,
  and the second-redraw clear count (the exact failure mode of the original bug).
- **Limitation deferred**: SIGWINCH (terminal resize mid-edit) is not yet handled. If `columns`
  changes between two `redrawCurrentLine` calls, the clear math reverts to using the previous
  call's row count. Suggested follow-up: subscribe to the `resize` event on `process.stdout` and
  force a full clear-and-redraw.

### Done — Subcommand `--tool` flag shadowed by parent's repeatable `--tool` option (Commander.js)
- **Symptom**: `cli-agent refresh-capabilities --tool <name>` (and `show-capabilities --tool <name>`)
  raised `Error [E_USAGE]: No tools configured. Pass --tool <name> or add tools[] to config.json.`
  even though the user explicitly passed the flag.
- **Root cause**: The root program defines `--tool <name>` with the `collectTool` aggregator
  (so the agent run subcommand can accept a repeatable list). The two subcommands also declared
  `--tool <name>` for their own single-string semantics. In Commander v12, when parent and
  subcommand declare the same long flag, the parent's option wins during parsing — the user-
  supplied value lands in `program.opts().tool` as `string[]`, while the subcommand's local
  `opts.tool` stays `undefined`. The subcommand then fell into the "no tools configured" error.
- **Fix** (`src/cli.ts`): both subcommand actions now read `this.optsWithGlobals()` and fall
  back to the parent's array value (taking the first element) when the local `opts.tool` is
  missing. Helper `pickFirstTool(v)` normalizes the array-vs-string case.
- **Regression coverage**: `src/cli-subcommand-tool-flag.spec.ts` exercises the Commander parsing
  path end-to-end against the same two-level option topology used by the real program.
- **Verified**: `cli-agent refresh-capabilities --tool telegram-cli` now refreshes successfully
  (8 subcommands extracted, 5837 bytes cached).

### Done — Vendored `*.prompt.md` files now copied to `dist/` at build time
- `tsc` only emits `.js` / `.d.ts`. The vendored `BikS2013/agent-tools` upstream reads
  six `*.prompt.md` files at runtime via `loadPromptFile()`, so a built CLI threw
  ENOENT on first import of any `agt_*` factory.
- Fix: added `scripts/copy-vendored-assets.mjs` and a `postbuild:assets` npm script
  (chained between `tsc` and `chmod +x dist/cli.js`). The script mirrors `.md` /
  `.txt` / `.json` files from `src/` into `dist/` preserving relative paths.
  Verified by `node dist/cli.js --help` exiting 0 cleanly post-build.

### Done — TypeScript build broke on `agent-tools-e2e.spec.ts`
- Three errors fixed during Phase 10 verification:
  - `StubGlobLlm.bindTools` return type was `RunnableLike<…, AIMessage, …>`,
    incompatible with `BaseChatModel.bindTools` which expects
    `Runnable<…, AIMessageChunk, …>`. Loosened to `any` (the body already
    `as any`-casts).
  - `TodoItem` literal in B3 missed the required `id` field. Added
    `id: 'todo-1'`.
  - `agentGraph.agentToolsSession.todos[0]` flagged as possibly null. Added
    `!` non-null assertion.

### Done — `--system` / `--system-file` flags now wired through buildSystemPrompt
- `cfg.systemAppendText` and `cfg.systemAppendFile` are populated by `loadAgentConfig`.
  All six `buildSystemPrompt` call sites switched to the new helper
  `buildSystemPromptForCfg()` in `src/agent/system-prompt.ts`, which loads the base
  text from `cfg.systemPromptPath` and composes the file/inline addenda on top.
  Closed as part of the externalize-system-prompt change (FR-AGT-008a).

### Done — see plan-002-tui.md
- `[MEDIUM] llm_chunk events not yet wired to streaming` — closed by plan-002.
  `streamOneShot()` in `src/agent/graph.ts` emits `llm_chunk` for every
  `on_chat_model_stream` event and `llm_final` on `on_chat_model_end`. Both
  carry `sessionId`+`turnId` for per-turn analysis. The non-streaming
  `runOneShotAgent`/`runOneShot` path is unchanged and still uses `.invoke()`;
  it doesn't see chunks anyway.

### Done — `agent-config.spec.ts` mock bypass via default-import
- The `vi.mock('node:fs/promises', …)` block omitted the `default` export, so
  `import fsp from 'node:fs/promises'` in `src/config/agent-config.ts` bypassed
  the mock and read the real `~/.tool-agents/cli-agent/.env`. Latent until the
  user added `AGENT_PROVIDER=azure-openai` to that file. Fix: the mock now
  exposes both named exports AND a `default: { ...actual, ...mocks }` object,
  so default-import sites see the mocked methods. Suite back to 104/104.
