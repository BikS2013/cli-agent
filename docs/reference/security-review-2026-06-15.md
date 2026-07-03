---
project: cli-agent
review_type: security
status: findings
generated_at: 2026-06-15T05:49:57Z
refined_request: docs/reference/refined-request-security-review.md
codebase_scan: docs/reference/codebase-scan-security-review.md
last_scanned_commit: f8bf6b41fa7e10a322c0739acb54d146a6e94233
---

# Security Review: cli-agent

## Executive Summary

`cli-agent` has several strong security controls: shell-free subprocess spawning, credential stripping for `bash_run`, private `0700`/`0600` runtime files, a clean dependency audit, mutation-gated first-party file tools, and redacted operational logs.

The review also found security gaps that should be remediated before treating the tool as hardened for untrusted workspaces or hostile prompt/content inputs. The highest-priority items are:

1. First-party file mutators can create files outside the sandbox through a symlinked directory.
2. Default-on web fetch can reach localhost, private networks, and cloud metadata endpoints.
3. I/O capture redaction is only applied to disk writes; `/inspect show` renders the raw in-memory records.
4. `bash_run` read-only mode is advisory for wrapped CLIs; `--allow-mutations` does not enforce non-mutating argv.

## Review Scope

Reviewed:
- Command execution: `src/agent/tools/bash/*`
- File access: `src/agent/tools/file/sandbox.ts`, `src/agent/tools/agent-tools/agt-file-*.ts`
- Web access: `src/agent/tools/web/backends/registry.ts`, `src/agent/tools/agent-tools/agt-web-*.ts`
- Configuration and credentials: `src/config/agent-config.ts`, profile loader/schema
- Logging and capture: `src/agent/logging.ts`, `src/agent/io-capture.ts`, `src/tui/slash/inspect.ts`
- Tool catalog and mutation gates: `src/agent/tools/registry.ts`, `src/agent/tools/agent-tools/group-builder.ts`
- Composite dispatch: `src/agent/composite/dispatcher.ts`
- Dependencies and secret-pattern scan

## Positive Controls

- `bash_run` uses `spawn` with `shell: false`, explicit argv, no TTY, timeout, output caps, and a restricted child env. See `src/agent/tools/bash/exec.ts:73`.
- Credential-shaped env var names and values are stripped from bash child env unless explicitly passed via `--bash-pass-secret`. See `src/agent/tools/bash/exec.ts:15` and `src/agent/tools/bash/exec.ts:84`.
- Runtime directories and sensitive files are created/chmodded to `0700`/`0600` in bootstrap. See `src/config/agent-config.ts:537`, `src/config/agent-config.ts:546`, `src/config/agent-config.ts:595`, and `src/config/agent-config.ts:695`.
- First-party mutating file tools are only registered when `cfg.allowMutations` is true. See `src/agent/tools/agent-tools/group-builder.ts:218`, `src/agent/tools/agent-tools/group-builder.ts:225`, and `src/agent/tools/agent-tools/group-builder.ts:232`.
- Operational JSONL logs cap top-level string fields and pass payloads through `redactString` before writing. See `src/agent/logging.ts:94`.
- Provider factories use the resolved provider env snapshot, and missing provider credentials raise configuration errors rather than silently falling back. See `src/config/agent-config.ts:1205` and `src/config/agent-config.ts:1553`.
- `npm audit --audit-level=high` and full `npm audit --json` both report zero vulnerabilities after the dependency remediation.

## Findings

### HIGH-1: File sandbox can be bypassed for new files under symlinked directories

**Evidence**

`resolveSandboxPath` realpaths the full target path when it exists, but if the target does not exist it falls back to `path.resolve(absolute)` without realpathing the parent directory. See `src/agent/tools/file/sandbox.ts:29` through `src/agent/tools/file/sandbox.ts:36`. The prefix check then accepts paths that textually start with the root. See `src/agent/tools/file/sandbox.ts:38` through `src/agent/tools/file/sandbox.ts:40`.

The mutators then write to the returned path:
- `agt_file_write`: `src/agent/tools/agent-tools/agt-file-write.ts:84` through `src/agent/tools/agent-tools/agt-file-write.ts:85`
- `agt_file_append`: `src/agent/tools/agent-tools/agt-file-append.ts:83` through `src/agent/tools/agent-tools/agt-file-append.ts:84`
- `agt_file_edit`: `src/agent/tools/agent-tools/agt-file-edit.ts:96` through `src/agent/tools/agent-tools/agt-file-edit.ts:123`

I reproduced this against a temporary directory: `resolveSandboxPath('linkdir/new.txt', { root, allowPaths: [] })` accepted a path under `root/linkdir/new.txt` even though `realpath(dirname(resolved))` was an outside directory reached via symlink.

**Impact**

With `--allow-mutations` enabled, a write or append to a new file under a symlinked directory inside the root can create or modify files outside `fileEdit.root`. This breaks the file sandbox guarantee.

**Recommendation**

Resolve and verify the nearest existing parent directory with `fs.realpathSync.native` for non-existent targets, then join the unresolved tail. Re-check the canonical parent against `root` and `allowPaths` before writing. Add regression tests for:
- create new file under symlinked directory pointing outside root
- append to new file under symlinked directory
- nested missing path where an intermediate parent is a symlink

### HIGH-2: Default-on web fetch has SSRF and private-network reachability risk

**Evidence**

`agt_web_fetch` is default-on as an agent-tools wrapper and is registered without `allowMutations`. See `src/agent/tools/agent-tools/group-builder.ts:178` through `src/agent/tools/agent-tools/group-builder.ts:190`, and default `webFetch: true` in `src/config/agent-config.ts:1393` through `src/config/agent-config.ts:1395`.

The tool accepts any Zod-valid URL. See `src/agent/tools/agent-tools/agt-web-fetch.ts:63` through `src/agent/tools/agent-tools/agt-web-fetch.ts:69`. The backend fetches the supplied URL directly, with no scheme allowlist beyond URL parsing and no blocklist for localhost, link-local, RFC1918, IPv6 local ranges, or cloud metadata endpoints. See `src/agent/tools/web/backends/registry.ts:213` through `src/agent/tools/web/backends/registry.ts:238`.

**Impact**

A prompt injection or model mistake can fetch internal resources such as `http://localhost:*`, private service URLs, or `http://169.254.169.254/` cloud metadata. The fetched content is returned to the LLM and may leave the machine through the model provider.

**Recommendation**

Add an outbound URL policy before every fetch:
- allow only `http:` and `https:`
- reject localhost, loopback, link-local, private, multicast, and metadata IP ranges
- resolve DNS and validate every resolved address
- re-check redirect targets
- make private-network access an explicit opt-in flag/config value with clear warnings
- add SSRF regression tests for IPv4, IPv6, DNS names resolving to private IPs, and redirects

### HIGH-3: `/inspect show` renders unredacted in-memory I/O capture records

**Evidence**

`FileIoCapture.write` stores the raw record in memory before applying redaction for the on-disk JSONL payload. See `src/agent/io-capture.ts:406` through `src/agent/io-capture.ts:420`.

The `/inspect show` renderer reads from `ioCapture.read()` and prints message content, tool-call args, final text, and tool results directly. See `src/tui/slash/inspect.ts:71` through `src/tui/slash/inspect.ts:80`, `src/tui/slash/inspect.ts:111` through `src/tui/slash/inspect.ts:120`, and `src/tui/slash/inspect.ts:121` through `src/tui/slash/inspect.ts:130`.

**Impact**

Even with capture redaction enabled, secrets present in prompts, tool args, tool outputs, or provider responses can be displayed in plaintext in the TUI when the user runs `/inspect show`. That plaintext can enter terminal scrollback, screenshots, recordings, or copy buffers.

**Recommendation**

Store the same redacted/capped record in memory that is written to disk, or apply `redactRecord` in `read()`/the renderer when `redact` is true. Add tests asserting `/inspect show` does not render a known secret when capture redaction is enabled.

### MEDIUM-1: `bash_run` read-only mode is advisory, not enforced

**Evidence**

`createBashRunTool` only changes the tool description based on `allowMutations`; when false, the description says the user has not enabled mutations and the model should prefer read-only commands. See `src/agent/tools/bash/run-tool.ts:29` through `src/agent/tools/bash/run-tool.ts:35`.

Execution is still allowed whenever the command is on the allowlist and `confirmed` is true. See `src/agent/tools/bash/run-tool.ts:74` through `src/agent/tools/bash/run-tool.ts:93`, and `src/agent/tools/bash/run-tool.ts:134` through `src/agent/tools/bash/run-tool.ts:143`. The `confirmed` field is part of the tool input schema, so it is set by the model/tool caller rather than by a separate user-confirmation UI.

**Impact**

If a broad binary such as `git`, `kubectl`, `aws`, `docker`, `python`, or `node` is allowlisted, the agent can still execute mutating subcommands without `--allow-mutations`. The current read-only posture relies on prompt guidance and operator judgment, not a hard runtime gate.

**Recommendation**

Make the security contract explicit and enforceable:
- In read-only mode, require `argv-regex:` entries for `bash_run`, or provide built-in deny patterns for common mutating verbs.
- Treat binary-name allowlist entries as "full CLI authority" and document them as such.
- Add a real user-confirmation gate outside the model-controlled tool arguments for dangerous commands.
- Log when `bash_run` executes while `allowMutations` is false so audits can distinguish prompt-advised read-only commands from mutation-enabled sessions.

### MEDIUM-2: Web response size is checked after buffering the full response

**Evidence**

`fetchUrl` calls `response.arrayBuffer()` before checking `totalBytes > maxBytes`. See `src/agent/tools/web/backends/registry.ts:244` through `src/agent/tools/web/backends/registry.ts:252`.

**Impact**

A large response can consume memory before the tool enforces its size limit. The 15-second timeout limits duration, but not peak memory during the response read.

**Recommendation**

Read the response body as a stream and abort once the byte budget is exceeded. Also enforce a maximum `Content-Length` before reading when the header is present.

### MEDIUM-3: Composite child-process dispatch buffers stdout/stderr without caps

**Evidence**

Composite child dispatch pushes all stdout and stderr chunks into arrays and concatenates them after the process exits. See `src/agent/composite/dispatcher.ts:339` through `src/agent/composite/dispatcher.ts:371`.

**Impact**

A composite child process or wrapped member can produce large output and cause memory pressure in the parent process. This bypasses the stricter output-capping discipline used by `spawnCommand`.

**Recommendation**

Reuse `spawnCommand` or add equivalent per-stream byte caps and truncation markers to composite dispatch. Prefer returning capped output to the LLM and logging only capped previews.

### MEDIUM-4: Web backend credential resolution bypasses layered config

**Evidence**

The resolved config carries `webSearch.backend`, but backend credential reads still use `process.env` directly for Tavily, SerpAPI, Brave, and custom HTTP. See `src/agent/tools/web/backends/registry.ts:51`, `src/agent/tools/web/backends/registry.ts:87`, `src/agent/tools/web/backends/registry.ts:120`, and `src/agent/tools/web/backends/registry.ts:181`.

**Impact**

Credentials placed only in the documented agent `.env` or local `.env` layers are not consistently available to web search/fetch. This is already tracked in `Issues - Pending Items.md`, but it is also a security/control issue because it creates misleading configuration behavior and encourages users to export secrets into the shell.

**Recommendation**

Move web backend credentials and `WEB_SEARCH_MAX_REQUESTS` into a resolved `cfg.webSearch` snapshot. Backend factories should not read `process.env` directly.

### LOW-1: Secret redaction is pattern-based and should be treated as best-effort

**Evidence**

`redactString` masks known key names, bearer/basic tokens, JWTs, and long base64-like strings. See `src/util/redact.ts:15` through `src/util/redact.ts:35`.

**Impact**

Secrets with short values, unusual vendor prefixes, structured multiline values, or non-base64 alphabets can slip through logs/captures. This is expected for regex redaction, but the UI/docs should not imply complete data-loss-prevention coverage.

**Recommendation**

Keep expanding vendor-specific patterns, but document redaction as best-effort. For capture/logging, prefer secret-source exclusion where possible over post-hoc masking.

## Dependency And Secret Checks

### Dependency Audit

Commands:
- `npm audit --audit-level=high`
- `npm audit --json`

Result:
- Zero vulnerabilities at all severities.

### Secret-Pattern Search

Command:
- `rg -n --hidden -g '!node_modules' -g '!dist' -g '!package-lock.json' ...`

Result:
- No real project secrets found.
- Matches were limited to test fixtures using dummy `sk-...` strings and documentation placeholders/examples such as `.env.example` and configuration guides.

## Recommended Remediation Order

1. Fix the file sandbox symlink-parent bypass and add regression tests.
2. Add SSRF/private-network blocking to `agt_web_fetch` and all backend fetch paths.
3. Redact the in-memory I/O capture path used by `/inspect show`.
4. Clarify and harden `bash_run` mutation semantics.
5. Add streaming byte caps to web fetch and composite dispatch.
6. Complete the existing web-backend credential-layer fix.

## Commands Run

- `npm audit --audit-level=high`
- `npm audit --json`
- secret-pattern `rg` scan
- targeted source reads with `nl -ba`
- temporary reproduction of the file sandbox symlink-parent behavior using `dist/agent/tools/file/sandbox.js`
