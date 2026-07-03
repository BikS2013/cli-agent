# Refined Request: Web Search Layered Configuration

## Category
Development / Configuration bug fix.

## Objective
Fix the web search configuration architecture so `agt_web_search` and `agt_web_fetch` use the resolved layered configuration snapshot instead of reading `process.env` directly.

## Scope
In scope:
- Add web backend credentials and request budget to the resolved `AgentConfig.webSearch` snapshot.
- Resolve `TAVILY_API_KEY`, `SERPAPI_API_KEY`, `BRAVE_API_KEY`, `WEB_SEARCH_URL`, `WEB_SEARCH_API_KEY`, and `WEB_SEARCH_MAX_REQUESTS` through the existing layered environment loader.
- Update web backend registry and agent-tools web wrappers to consume `cfg.webSearch` only.
- Add focused regression tests proving `.env`/layered values work without `process.env` and that request budget uses the resolved snapshot.
- Update the project pending-items log with the issue and solution.

Out of scope:
- Changing web backend behavior, SSRF policy, robots handling, or response buffering.
- Adding new runtime dependencies.
- Changing provider configuration resolution.
- Performing version control operations.

## Requirements
- Backend credential lookup must not use `process.env` inside the web backend registry.
- Web request budget lookup must not use `process.env` inside `group-builder`, `agt_web_search`, or `agt_web_fetch`.
- Missing required backend credentials must still raise the existing web errors.
- The default request budget remains `50` when `WEB_SEARCH_MAX_REQUESTS` is unset.
- Invalid `WEB_SEARCH_MAX_REQUESTS` values must not silently degrade budget enforcement.

## Constraints
- Follow existing TypeScript patterns and config precedence.
- Keep the fix localized to config and web-tool wiring.
- Preserve existing public tool names and CLI flags.
- Do not add dependencies.

## Acceptance Criteria
- `loadAgentConfig` returns `cfg.webSearch` with backend, backend credentials, custom HTTP settings, and numeric `maxRequests` from the layered environment.
- A value present only in `~/.tool-agents/cli-agent/.env` or local `.env` is visible to the selected web backend through `cfg.webSearch`.
- Tests fail before the fix and pass after it for backend credentials and request budget.
- `npm run typecheck` passes.
- Relevant focused tests pass.

## Assumptions
- The reported files are the correct integration points.
- Web credentials remain environment-driven rather than config-file-driven secret fields.
- Existing config precedence semantics stay unchanged.

## Open Questions
None blocking.

## Original Request
I have this finding in the current project 

  2. Web search config has a real architecture bug. The loader reads web keys into the layered config, but the web backend still reads
     process.env directly, so values in ~/.tool-agents/cli-agent/.env may be ignored. See src/agent/tools/web/backends/registry.ts:51 and
     src/agent/tools/agent-tools/group-builder.ts:158.

I want you to fix it
