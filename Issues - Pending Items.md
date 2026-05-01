# Issues - Pending Items

## Pending

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
