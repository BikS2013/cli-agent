---
language: TypeScript
framework: Node.js CLI / LangGraph
package_manager: npm
build_command: "npm run build"
test_command: "npm test"
lint_command: null
entry_points:
  - "src/cli.ts"
  - "src/commands/agent.ts"
  - "src/agent/run.ts"
last_scanned_commit: "f8bf6b41fa7e10a322c0739acb54d146a6e94233"
request_file: "docs/reference/refined-request-security-review.md"
scan_scope: "request-driven security review of command execution, file access, web access, configuration, logging, prompts, dependency health"
generated_at: "2026-06-15T05:49:57Z"
---

# Codebase Scan: Security Review

## Metadata

- Runtime: Node.js, ESM TypeScript.
- Package manager: npm, detected from `package-lock.json`.
- Build command: `npm run build`, from `package.json`.
- Test command: `npm test`, from `package.json`.
- Lint command: not detected.
- Main CLI binary: `dist/cli.js`, mapped from `package.json` `bin.cli-agent`.
- Source entry point: `src/cli.ts`.
- Current worktree: dirty at scan time due dependency-remediation changes and security-review docs.

## Module Map

| Area | Path | Purpose | Security relevance |
|---|---|---|---|
| CLI entry | `src/cli.ts` | Commander parser, global flags, subcommand wiring, error redaction. | Exposes security switches such as `--allow-mutations`, `--bash-allow`, `--bash-pass-secret`, web backend flags, and `--inspect-io-raw`. |
| Configuration | `src/config/agent-config.ts` | Loads config/env/profile layers, bootstraps `~/.tool-agents/cli-agent`, resolves provider credentials, tool toggles, prompt files, logging/capture dirs. | Central trust boundary for credentials, filesystem modes, defaults, and strict missing-config behavior. |
| Profiles | `src/config/profile-*.ts`, `src/commands/profile/*` | Parses and applies named profiles. | Profiles can alter tools, `allowMutations`, provider settings, and per-tool default arguments. |
| Bash execution | `src/agent/tools/bash/*` | Allowlist parser, binary lookup, subprocess spawning, bash tool wrappers. | Main OS command-execution surface. Uses shell-free spawn, credential-stripped env, output caps, timeouts, and cwd checks. |
| File tools | `src/agent/tools/file/sandbox.ts`, `src/agent/tools/agent-tools/agt-file-*.ts` | File read/list/write/edit/append tools under `agt_*`. | Filesystem read/write sandbox and mutation-gated tools. |
| Web tools | `src/agent/tools/web/backends/registry.ts`, `src/agent/tools/agent-tools/agt-web-*.ts` | Web search/fetch backends and LangChain wrappers. | Network egress, API-key handling, SSRF risk, response-size handling, robots behavior. |
| Tool catalog | `src/agent/tools/registry.ts`, `src/agent/tools/agent-tools/group-builder.ts` | Assembles LLM-visible tools and prompt metadata. | Determines what capabilities the model can invoke and which mutators are registered. |
| Tool prompt overlays | `src/agent/tools/tool-prompt-overlay.ts`, `src/commands/*tool-prompt*` | User-editable tool descriptions and parameter text. | Prompt-surface integrity; overlays can alter model-visible safety wording. |
| Capability discovery | `src/agent/capabilities/*` | Runs `--help`/man discovery and writes capability docs. | Executes declared binaries for introspection and injects generated docs into the system prompt. |
| Composite tools | `src/agent/composite/*`, `src/commands/composite/*` | Synthesizes/dispatches composite virtual tools and wrapper shims. | Nested agent dispatch, PATH shims, child-process env inheritance, output buffering. |
| Agent graph/run | `src/agent/run.ts`, `src/agent/graph.ts`, `src/commands/agent.ts` | Builds LangGraph ReAct agent, streams events, captures tool calls. | Prompt/tool boundary, memory, tool results, LLM I/O capture hooks. |
| Logging/redaction | `src/agent/logging.ts`, `src/agent/io-capture.ts`, `src/util/redact.ts` | Operational JSONL logs and optional LLM I/O capture. | Secret redaction, data retention, file permissions, diagnostic plaintext risks. |
| TUI | `src/tui/*` | Interactive terminal UI and slash commands. | Displays history, capture output, copy-to-clipboard, runtime tool/model switches. |
| Vendored agent tools | `src/agent/tools/agent-tools-vendored/*` | Pinned subset of external `agent-tools`. | Third-party code copied into the tree; provenance tracked manually. |

## Conventions Observed

- Config bootstrap creates private directories at `0700` and sensitive files at `0600` in `src/config/agent-config.ts`.
- Provider factories consume `cfg.providerEnv` snapshots rather than reading provider secrets directly from `process.env`, while the web backend currently still reads backend credentials from `process.env`.
- Native bash execution uses `child_process.spawn` with `shell: false`, explicit argv, stripped env, timeout, and output caps in `src/agent/tools/bash/exec.ts`.
- File read/list/write/edit/append wrappers share `resolveSandboxPath` from `src/agent/tools/file/sandbox.ts`.
- Mutating first-party file tools and vendored mutating tools are registered only when `cfg.allowMutations === true` in `src/agent/tools/agent-tools/group-builder.ts`.
- Operational logs are redacted and capped before write in `src/agent/logging.ts`; optional I/O captures are off by default and redacted on disk unless `--inspect-io-raw` is used.
- `.gitignore` excludes `.env`, `.env.*`, `node_modules/`, `dist/`, and `coverage/`.

## Integration Points

### In Scope

- `src/agent/tools/file/sandbox.ts`
  - Shared path authorization for first-party file tools.
  - Security-review focus: symlink handling, create-new-file handling, TOCTOU, allow-path behavior.

- `src/agent/tools/agent-tools/agt-file-write.ts`
  - Writes resolved paths after sandbox authorization.
  - Security-review focus: whether the resolver’s authorization remains true at write time.

- `src/agent/tools/agent-tools/agt-file-edit.ts`
  - Reads, regex-processes, and writes resolved paths.
  - Security-review focus: regex DoS, large-file handling, sandbox preservation.

- `src/agent/tools/agent-tools/agt-file-append.ts`
  - Appends to resolved paths after sandbox authorization.
  - Security-review focus: symlink and append-to-new-file behavior.

- `src/agent/tools/web/backends/registry.ts`
  - Network fetch/search implementation.
  - Security-review focus: SSRF, private-network access, response memory cap, robots handling, credential source.

- `src/agent/tools/agent-tools/agt-web-fetch.ts`
  - Default-on LLM-facing fetch wrapper.
  - Security-review focus: request budget and URL validation.

- `src/agent/tools/bash/run-tool.ts`
  - LLM-facing command execution wrapper.
  - Security-review focus: `--allow-mutations` semantics, allowlist breadth, PATH resolution, cwd restrictions.

- `src/agent/tools/bash/exec.ts`
  - Subprocess environment, timeout, output capping, and spawn behavior.
  - Security-review focus: credential stripping and hardening guarantees.

- `src/agent/io-capture.ts`
  - Optional full prompt/request/response capture.
  - Security-review focus: redaction consistency between on-disk and in-memory views.

- `src/tui/slash/inspect.ts`
  - Renders I/O capture records in the TUI.
  - Security-review focus: whether rendered capture output is redacted.

- `src/agent/composite/dispatcher.ts`
  - Dispatches virtual composite tools through child processes or in-process calls.
  - Security-review focus: env inheritance, output caps, recursion guard, child timeout.

### Out of Scope

- Pure UI rendering except where it displays security-sensitive capture/log data.
- Feature documentation drift unrelated to security behavior.
- Generated `dist/` code except where used for a temporary reproduction.
- External runtime directories beyond the documented `~/.tool-agents/cli-agent` paths.

### Existing Related Issues

- `Issues - Pending Items.md` already tracks web backend credential-layer drift.
- `Issues - Pending Items.md` already tracks simplified robots.txt behavior.
- `Issues - Pending Items.md` already tracks missing Azure API-key expiry warnings.
- The dependency vulnerability backlog has been completed in the current working tree and `npm audit` is clean.

## Commands Used For Scan

- `git rev-parse HEAD`
- `rg --files -g '!node_modules' -g '!dist' -g '!coverage' -g '!package-lock.json'`
- `find src -maxdepth 4 -type d`
- `find src -maxdepth 4 -type f`
- `nl -ba package.json`
- `nl -ba .gitignore`
- targeted `nl -ba` reads of config, bash, file, web, logging, I/O capture, profile, registry, and composite modules.
