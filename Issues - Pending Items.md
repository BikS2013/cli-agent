# Issues - Pending Items

## Pending

### [HIGH] Expiry warning for Azure API keys not yet implemented
- `config.json` accepts `_azure_openai_key_expires` and similar fields per the configuration guide,
  but `loadAgentConfig` does not yet read them or emit warnings on startup.
- Planned for a follow-up iteration.

### [MEDIUM] llm_chunk events not yet wired to streaming
- The `llm_chunk` LogEvent type is defined and the graph supports streaming via `streamAgent`,
  but `runOneShotAgent` currently uses `invoke` (not stream). Tool call events are therefore
  logged as `tool_call` / `tool_result` but not as `llm_chunk` fragments.
- Full streaming support is deferred per spec §2 (Non-goals v1: streaming model output).
- `llm_final` events are also not emitted from `runOneShot`; the session_end log entry covers the session boundary.
- To fully comply with the 8-mandatory-events logging schema, a streaming invocation path
  needs to be added in a follow-up.

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

## Completed

(None yet — project was just scaffolded.)
