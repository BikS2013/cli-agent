# Issues - Pending Items

## Pending

### [HIGH] Expiry warning for Azure API keys not yet implemented
- `config.json` accepts `_azure_openai_key_expires` and similar fields per the configuration guide,
  but `loadAgentConfig` does not yet read them or emit warnings on startup.
- Planned for a follow-up iteration.

### [MEDIUM] `robots.txt` check in web_fetch is simplified
- The current implementation does a best-effort check for `Disallow: /` on the root `robots.txt`.
- A full robots.txt parser (honoring `Disallow: /path`, `User-agent:` sections, `Crawl-delay`, etc.)
  is deferred as it requires a dependency or significant custom parsing logic.

### [LOW] `--system` and `--system-file` flags parsed but not passed to buildSystemPrompt
- The CLI accepts `--system <text>` and `--system-file <path>` flags but `runAgentCommand`
  does not yet forward them to `buildSystemPrompt`. The system prompt always uses the base
  template only. Fix: pass `opts.system` / read `opts.systemFile` and forward to `buildSystemPrompt`.

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
