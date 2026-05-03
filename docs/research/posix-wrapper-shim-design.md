---
topic: POSIX wrapper shim design for composite tool distribution
related_investigation: docs/reference/investigation-composite-tools.md §Question 2 / Topic 2
feature: composite-intelligent-tools (plan-006)
created_at: "2026-05-02"
sources_verified: true
---

# POSIX Wrapper Shim Design — Reference Research

## Overview

This document captures the complete reference research for the `--emit-wrapper` distribution
mode of composite tools. When activated, cli-agent writes a POSIX shell shim at
`~/.tool-agents/cli-agent/composites/<name>` that wraps `cli-agent --tool A --tool B … "$@"`.
Outer cli-agent invocations can then treat the shim exactly like any other binary tool.

The research models the shim on npm's `cmd-shim` (the battle-tested reference used by tens
of millions of npm installs) and resolves every low-level edge case the planning step
requires before writing code.

---

## 1. npm `cmd-shim` POSIX Shim — Exact Source

### 1.1 Repository

- **Package**: `cmd-shim@8.0.0` (npm Inc., ISC licence)
- **Source file**: `lib/index.js`
- **Raw URL**: `https://raw.githubusercontent.com/npm/cmd-shim/main/lib/index.js`
- **No external runtime dependencies** (`"dependencyCount": 0` per Bundlephobia API)
- **Minified size**: 3 628 bytes / 1 755 bytes gzip

### 1.2 Exact POSIX Shim Template (verbatim from source)

The following is the exact string assembled by `writeShim_()` in `lib/index.js` for the case
where `prog` is a program resolved from `#!/usr/bin/env` (e.g. `node`) and `shLongProg` exists
(the "does `$basedir/node.exe` exist?" branch). The source is reproduced verbatim from the
raw GitHub file — lines 128–172 of `lib/index.js`:

```sh
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case `uname` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=`cygpath -w "$basedir"`
        fi
    ;;
esac

if [ -x "$basedir/node" ]; then
  exec "$basedir/node" "$basedir/<relative-path-to-target>" "$@"
else
  exec node "$basedir/<relative-path-to-target>" "$@"
fi
```

For the simpler case (no `shLongProg`, i.e. no local-interpreter fallback), the shim reduces to:

```sh
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case `uname` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=`cygpath -w "$basedir"`
        fi
    ;;
esac

exec node "$basedir/<relative-path-to-target>" "$@"
```

**Critical observations from the source code**:

1. **Shebang is `#!/bin/sh`** — not `#!/usr/bin/env bash`. This is a deliberate choice for
   maximum portability. `/bin/sh` is guaranteed to exist on every POSIX system; `bash` is not.
2. **No `set -euo pipefail`** — npm intentionally omits strict mode (see §3 below).
3. **`exec` is used unconditionally** — never a fork.
4. **`"$@"` with double quotes** — preserves per-argument word boundaries.
5. **`basedir` computed via `dirname`+`sed`** — the `sed 's,\\\\,/,g'` backslash replacement
   exists for Cygwin/MSYS2 path normalisation on Windows; it is a no-op on POSIX.
6. **`chmod(to, 0o755)`** — applied after writing, not in the same `open()` call.

### 1.3 pnpm `@pnpm/cmd-shim` POSIX Shim (TypeScript variant, for comparison)

pnpm's `generateShShim()` produces the same structural pattern with two differences:

1. When `shLongProg` is absent, it falls back to:
   ```sh
   node "$basedir/<target>" "$@"
   exit $?
   ```
   Note `exit $?` instead of `exec` for this code path. This is likely a pnpm-specific
   deviation — npm's reference always uses `exec`.

2. It appends a trailing marker comment `# <shimTarget>` to enable the `isShimPointingAt()`
   API for overwrite-detection without re-parsing.

---

## 2. Shebang Line Analysis

### 2.1 What npm Uses

`#!/bin/sh` — the POSIX-minimal shell.

### 2.2 Why Not `#!/usr/bin/env bash`?

The investigator's recommendation (investigation-composite-tools.md §Q2, Option 2A) proposes
`#!/usr/bin/env bash`. The npm reference uses `#!/bin/sh`. The research reveals why npm chose
`/bin/sh` and what this means for cli-agent:

| Criterion | `#!/bin/sh` | `#!/usr/bin/env bash` |
|---|---|---|
| Guaranteed to exist | Yes — every POSIX system | No — Alpine, minimal Docker images may not have bash |
| `pipefail` support | No (not in POSIX-2017; added in POSIX-2024) | Yes |
| `[[` double-bracket | No | Yes |
| PATH-injection risk | None | Attacker-controlled PATH could substitute bash |
| npm uses | Yes | No |
| cli-agent target systems | macOS + Linux (deployment note says Alpine out of scope) | Safe for macOS + mainstream Linux |

**Conclusion for cli-agent**: The investigation's recommendation of `#!/usr/bin/env bash`
is defensible for a macOS/Linux-only tool, but `#!/bin/sh` is safer and is what npm ships.
The cli-agent shim does not need bash-specific features (no `[[`, no `pipefail` on pipelines,
no arrays). The recommended shim (§5) uses `#!/bin/sh` to match the npm reference and
eliminate the Alpine bash-not-installed failure mode.

**Contradiction of investigator's recommendation**: The investigation recommended
`#!/usr/bin/env bash`. This research recommends `#!/bin/sh` for better fidelity to the
npm reference. The cli-agent shim body uses only POSIX `sh` constructs, so there is no
functional need for bash. The only bash feature the investigator's template uses is
`set -euo pipefail` — which is addressed separately in §3.

---

## 3. `set -euo pipefail` — Why npm Omits It

npm's `cmd-shim` POSIX shim does **not** include `set -euo pipefail`. This is intentional,
for three concrete reasons:

### 3.1 `pipefail` is Not POSIX-sh-Portable

`set -o pipefail` was only standardised in POSIX.1-2024. It is absent from `dash` (Ubuntu's
default `/bin/sh`). A shim with `#!/bin/sh` and `set -o pipefail` would silently be ignored
on dash — the flag is not recognised and is a no-op, or worse, causes an error on strict
implementations.

### 3.2 `exec` Makes Most of `set -e` Redundant

When the shim body is:
```sh
exec cli-agent --tool A --tool B "$@"
```
the shell is **replaced** by the child process. There is no subsequent shell code that could
fail silently. `set -e` would only protect the lines before the `exec`. For a 4-line shim
with one `case` statement and one `exec`, the protection surface is negligible.

### 3.3 `set -u` Interaction With `${1:-}` Pattern

The investigation's recommended shim uses `${1:-}` to safely access `$1` even when no
arguments are provided. If `set -u` is active and we used `$1` bare instead of `${1:-}`,
the script would exit 1 with "unbound variable" when no args are passed. npm avoids this
class of bug entirely by not setting `-u`.

### 3.4 Recommended Practice for cli-agent Shim

Because the shim is a thin wrapper that does almost nothing before `exec`-ing, the risk
that strict mode would catch a real bug is very low. The risk that it introduces a
portability or correctness bug (§3.1, §3.3) is real. **Do not use `set -euo pipefail`
in the shim.**

The `case` guard before the `exec` uses `${1:-}` defensively. That single pattern
eliminates the unbound-variable risk without requiring `-u`.

---

## 4. `exec` vs Fork — Signal Forwarding and Exit-Code Propagation

### 4.1 npm Uses `exec` Unconditionally

Every `exec` call in the npm `cmd-shim` POSIX shim is a true `exec()` syscall. The shell
process is replaced in-place by the child. This has three consequences:

**Exit-code propagation**: automatic. When the child exits with code N, the OS reports N
to whoever launched the shim. No `exit $?` needed.

**Signal forwarding**: automatic. Ctrl+C sends SIGINT to the foreground process group.
After `exec`, the child *is* the process group leader — it receives SIGINT directly.
Without `exec`, the shell is the process group leader and must manually trap and forward
signals.

**PID stability**: after `exec`, the PID of the "shim process" becomes the PID of
`cli-agent`. Tools that `wait $PID` or watch `/proc/$PID` see the real cli-agent process.

### 4.2 The Fork Case (pnpm fallback)

pnpm's `generateShShim()` for the no-long-prog case emits:
```sh
node "$basedir/<target>" "$@"
exit $?
```
This is a fork: `sh` spawns `node` as a child and then waits. Signals sent to the `sh`
process (e.g., SIGINT from Ctrl+C) may or may not be forwarded depending on the shell
implementation. `exit $?` propagates the exit code correctly but signal semantics are
weaker. **This is a pnpm deviation from npm. cli-agent must use `exec`.**

### 4.3 Signal Edge Cases

| Signal | `exec` shim | Fork shim |
|---|---|---|
| SIGINT (Ctrl+C) | Delivered directly to child | Shell may or may not forward |
| SIGTERM | Delivered directly to child | Not forwarded by default in sh |
| SIGKILL | Process group killed | Only parent killed; child orphaned |
| SIGHUP (terminal close) | Delivered to child | Shell may forward or not |

The `exec` pattern is unambiguously correct. For cli-agent, which is always invoked from
an interactive or CI terminal (never as PID 1), `exec` delivers correct signal semantics
without any `trap` machinery.

---

## 5. Recommended Shim Text for cli-agent (macOS/Linux, Cygwin Block Removed)

The following is the **cli-agent production shim template**. The Cygwin/MINGW/MSYS block
is omitted because cli-agent targets macOS and Linux only (Windows is explicitly out of
scope for v1 per the investigation document).

```sh
#!/bin/sh
# cli-agent composite wrapper — <compositeName>
# Generated: <synthesizedAt>
# DO NOT HAND-EDIT — regenerate with:
#   cli-agent --treat-as-tool --regenerate-capabilities --composite-name <compositeName>
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
DOC="<absoluteDocPath>"
case "${1:-}" in
  --help|-h)
    if [ ! -r "$DOC" ]; then
      echo "composite cache stale; re-run: cli-agent --treat-as-tool --regenerate-capabilities --composite-name <compositeName>" >&2
      exit 6
    fi
    exec cat "$DOC"
    ;;
esac
exec <absoluteCLIAgentPath> --tool <m1> --tool <m2> "$@"
```

### Template Variables

| Placeholder | Value at generation time |
|---|---|
| `<compositeName>` | The composite's identifier string |
| `<synthesizedAt>` | ISO-8601 timestamp of synthesis |
| `<absoluteDocPath>` | Resolved absolute path to `capabilities/composite/<id>.md` |
| `<absoluteCLIAgentPath>` | Resolved absolute path to the cli-agent binary (see §6) |
| `<m1>`, `<m2>`, … | The recorded member tool names, one `--tool` flag per member |

### Design Decisions Reflected in This Template

1. **`#!/bin/sh`** — not `#!/usr/bin/env bash`. Matches npm reference, eliminates Alpine/bash
   failure mode. The shim body uses only POSIX `sh` constructs.
2. **No `set -euo pipefail`** — unnecessary and potentially harmful (§3).
3. **`exec cat "$DOC"`** — the `--help` branch also uses `exec` so the shim's PID becomes
   cat's PID; clean exit-code propagation if the doc is missing (via `[ ! -r ]` guard).
4. **`exec <absoluteCLIAgentPath>`** — absolute path (see §6); signal forwarding (§4).
5. **`"$@"` with double quotes** — preserves per-argument word-splitting boundaries.
6. **`${1:-}`** in the `case` — safe access to `$1` when no arguments are passed; avoids
   unbound-variable issues without needing `set -u`.
7. **`exit 6`** — matches the investigation's exit-code contract for cache-stale errors
   (FR-CMP-013 #4).
8. **`basedir` computation** — kept for forward compatibility (e.g., if a future `$basedir`
   reference is needed); the `sed` backslash replacement is a no-op on macOS/Linux.

---

## 6. Absolute vs Relative Path for the cli-agent Binary

The investigation document (§Pitfalls, point 3) already notes:

> "Consider recording the resolved binary path at synthesis time and templating it into the
> shim (`exec /resolved/path/to/cli-agent --tool …`). This trades portability of the shim
> across machines for reliability on the synthesis machine."

This research confirms that **absolute path is the correct choice** for v1, for the following
reasons:

### 6.1 `which`/`command -v` Are Not Reliable in the Shim

At shim *execution* time, the `PATH` may differ from the `PATH` at synthesis time. npm
installs to a directory that is on the user's `PATH` — but composites may be placed in
`~/.tool-agents/cli-agent/composites/<name>` which may or may not be on `PATH`. Looking
up `cli-agent` at execution time via PATH is unreliable.

### 6.2 How to Resolve the Absolute Path at Synthesis Time

In the TypeScript generator (§8), use:

```typescript
import { execFileSync } from 'node:child_process';

function resolveCLIAgentBin(): string {
  // Prefer process.argv[0] chain: the current invocation's Node binary path
  // combined with the argv[1] script path gives the shim or real path.
  // For a globally installed cli-agent, the shim is the entry point;
  // the real binary (after resolving symlinks) is what we embed.
  const via = execFileSync('which', ['cli-agent'], { encoding: 'utf8' }).trim();
  return via; // or: fs.realpathSync(via) to dereference symlinks
}
```

Alternatively, if cli-agent is always invoked via its own shim (the npm-installed case),
`process.argv[1]` gives the path to the running script. `fs.realpathSync(process.argv[1])`
resolves symlinks; that is the path to embed.

### 6.3 `process.argv[1]` Under Symlinks

Node.js by default **resolves symlinks** when populating `process.argv[1]` — it points to
the real file, not the symlink. This is relevant when cli-agent itself is installed via
npm link: `process.argv[1]` will point to the project source, not the symlink.

To get the symlink path, use `--preserve-symlinks-main` when invoking Node. For cli-agent's
shim-generation case, `process.argv[1]` (the real path) is exactly what we want embedded —
it is the canonical path to the script that Node will execute.

---

## 7. Symlink vs Shim — Pros and Cons

The question was raised: could a symlink to the cli-agent binary serve in place of a shim?

### 7.1 What a Symlink Would Do

A symlink `~/.tool-agents/cli-agent/composites/<name>` → `/path/to/cli-agent` would cause:
- `cli-agent` to be invoked without any pre-baked `--tool` arguments.
- The composite member set would need to be discovered from the symlink's own name or some
  out-of-band mechanism.
- `process.argv[1]` inside Node would point to the resolved real path (not the symlink),
  so detecting "I was invoked as composite X" from `process.argv[1]` is not possible.
- `process.argv0` would contain the symlink path, but only if `--preserve-symlinks-main`
  is passed — which requires modifying the shebang or launcher.

### 7.2 Why Symlinks Are Wrong Here

| Property | Shell Shim | Symlink |
|---|---|---|
| Bakes `--tool A --tool B` into the invocation | Yes — in the shim body | No — would require separate manifest read on each startup |
| `--help` interception | Yes — `case` block in shim | No — `cli-agent --help` with no composite context |
| `process.argv[1]` detection | Irrelevant (shim handles dispatch) | Unreliable (Node resolves symlink) |
| Recognisable by capability discovery as a "real binary" | Yes — executable file | Yes — but with different argv |
| Works when cli-agent binary is replaced on upgrade | Yes (absolute path stays valid) | Yes (symlink target updates) |
| Per-composite doc cache path embedded | Yes | No |

**Conclusion**: symlinks cannot serve in place of shims for composites. The shim is the
only mechanism that embeds the `--tool` list into the invocation.

---

## 8. TypeScript Generator — `generateCompositeWrapperShim()`

The following is the complete implementation-ready generator. It writes the shim atomically
(write to a temp file, chmod, rename) to avoid a race window where the shim exists but is
not yet executable.

```typescript
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface CompositeShimOptions {
  /** The composite's identifier, used in comments and the --help message. */
  compositeName: string;
  /** The member tool names, in the order they should appear as --tool flags. */
  members: string[];
  /** Absolute path to the cli-agent binary to embed in the exec line. */
  cliAgentBinPath: string;
  /** Absolute path to the composite capability doc (for --help). */
  capabilityDocPath: string;
  /** The parent directory where the shim file will be written. */
  shimDir: string;
  /** ISO-8601 timestamp to embed in the generated-at comment. */
  synthesizedAt: string;
}

export interface GeneratedShim {
  /** Absolute path of the written shim file. */
  shimPath: string;
  /** File mode applied. */
  mode: number;
}

/**
 * Generate and write a POSIX shell shim for a composite tool.
 *
 * Design principles:
 * - Shebang is #!/bin/sh (matches npm cmd-shim; no bash dependency).
 * - No set -euo pipefail (see research §3; exec makes it unnecessary).
 * - Uses exec for signal forwarding and exit-code propagation (§4).
 * - Embeds absolute paths for both the doc and the cli-agent binary (§6).
 * - Writes via a temp file + rename to avoid a race window (§permissions note).
 * - Mode 0o755 matches npm cmd-shim's chmodShim().
 */
export async function generateCompositeWrapperShim(
  opts: CompositeShimOptions,
): Promise<GeneratedShim> {
  const {
    compositeName,
    members,
    cliAgentBinPath,
    capabilityDocPath,
    shimDir,
    synthesizedAt,
  } = opts;

  if (members.length === 0) {
    throw new Error(
      `generateCompositeWrapperShim: composite "${compositeName}" has no members`,
    );
  }

  // Build the --tool flags string, one flag per member, no trailing space.
  const toolFlags = members.map((m) => `--tool ${m}`).join(' ');

  // The shim body. Uses only POSIX sh constructs.
  const shimContent = [
    '#!/bin/sh',
    `# cli-agent composite wrapper — ${compositeName}`,
    `# Generated: ${synthesizedAt}`,
    '# DO NOT HAND-EDIT — regenerate with:',
    `#   cli-agent --treat-as-tool --regenerate-capabilities --composite-name ${compositeName}`,
    'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\\\\\,/,g\')")',
    `DOC=${shellescape(capabilityDocPath)}`,
    'case "${1:-}" in',
    '  --help|-h)',
    '    if [ ! -r "$DOC" ]; then',
    `      echo "composite cache stale; re-run: cli-agent --treat-as-tool --regenerate-capabilities --composite-name ${compositeName}" >&2`,
    '      exit 6',
    '    fi',
    '    exec cat "$DOC"',
    '    ;;',
    'esac',
    `exec ${shellescape(cliAgentBinPath)} ${toolFlags} "$@"`,
  ].join('\n') + '\n';

  await fsp.mkdir(shimDir, { recursive: true });

  const shimPath = path.join(shimDir, compositeName);
  const MODE = 0o755;

  // Write via temp file + rename to avoid a race window where the shim is
  // visible but not yet executable.  This is especially important on NFS or
  // shared home directories.
  const tmp = path.join(
    os.tmpdir(),
    `cli-agent-shim-${compositeName}-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await fsp.writeFile(tmp, shimContent, { encoding: 'utf8', mode: MODE });
    await fsp.rename(tmp, shimPath);
  } catch (err) {
    // Clean up temp file if rename failed.
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }

  return { shimPath, mode: MODE };
}

/**
 * Minimal POSIX single-quote escaping for embedding paths in shell literals.
 * Wraps the value in single quotes; any embedded single quote is escaped
 * by ending the single-quote string, inserting a literal ', and reopening.
 *
 * Example: /home/user's dir  →  '/home/user'"'"'s dir'
 */
function shellescape(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}
```

### Notes on the Generator

**`writeFile` with `mode` option**: on Node.js, `fsp.writeFile(path, data, { mode })` sets
the file mode at creation. This is effectively atomic with the write — the file is created
with the correct permissions rather than written world-readable and then chmoded. The
temp-file+rename pattern means the shim at its final path is always fully written and
executable the instant it is visible.

**`shellescape()`**: paths on macOS and Linux can contain spaces and single quotes (rare but
possible). The `shellescape()` helper wraps the path in single quotes and escapes any
embedded single quotes using the `'"'"'` idiom. This matches the approach taken by pnpm's
`generateShShim()` for quoted path targets.

**Member names**: the generator does not quote individual member names in the `--tool` flags.
Member names should only contain alphanumeric characters, hyphens, and underscores (the
existing CLI validation already enforces this). If that contract ever changes, add
`shellescape()` around each member name.

---

## 9. The `cmd-shim` Package — Dependency Decision

### 9.1 The Package's API Surface

```javascript
const cmdShim = require('cmd-shim');

// Creates POSIX shim + .cmd + .ps1 at `to`, reading the shebang of `from`
await cmdShim(from, to);

// Idempotent — no-ops if `from` does not exist
await cmdShim.ifExists(from, to);
```

The package accepts a *source* path and a *destination* path. It reads the source file's
shebang to derive the interpreter, then writes three shim files (POSIX `.sh`, `.cmd`, `.ps1`).

### 9.2 Why `cmd-shim` Package Does Not Fit cli-agent's Use Case

| Factor | `cmd-shim` package | cli-agent template approach |
|---|---|---|
| What it wraps | An existing script whose shebang it reads | A cli-agent command-line invocation (not a script file) |
| Shim template control | Fixed template; no --tool flag support | Full control — we own the template |
| Windows support | Required feature of the package | Explicitly out of scope for cli-agent v1 |
| Bundle weight | 3 628 bytes min / 1 755 bytes gzip, 0 extra deps | 0 bytes (code is in cli-agent source) |
| API stability | Public, versioned | Internal |
| Overwrite-detection | `isShimPointingAt()` helper | Not needed for cli-agent (manifest is the source of truth) |

### 9.3 Decision: Do NOT Depend on `cmd-shim`

**Recommendation: template the shim in TypeScript and write directly via `fsp.writeFile`.**

Rationale:

1. **Wrong abstraction level**: `cmd-shim` is designed to wrap an existing executable by
   reading its shebang. cli-agent's shim is not wrapping an executable — it is constructing
   a new command-line invocation from a recorded member list. The package cannot produce the
   `exec cli-agent --tool A --tool B "$@"` line; that would require `cmd-shim` to accept a
   fully custom `exec` line, which is not in its API.

2. **Windows bloat**: `cmd-shim` always writes three files (`.sh`, `.cmd`, `.ps1`). On
   macOS/Linux, the `.cmd` and `.ps1` files are dead weight. The generator in §8 writes
   only the POSIX shim.

3. **Zero benefit in practice**: the features `cmd-shim` provides beyond a plain `writeFile`
   are: (a) auto-discovery of the shebang interpreter, (b) Cygwin path translation, (c)
   PowerShell shim. cli-agent needs none of these.

4. **Dependency hygiene**: `cmd-shim@8.0.0` has zero runtime dependencies (confirmed via
   Bundlephobia API). Adding it would still mean tracking an upstream package for a feature
   that a 30-line TypeScript function handles completely.

---

## 10. File Permissions — Atomic Creation

### 10.1 `0o755` or `0755`?

Both are octal literals for the same mode. In TypeScript/Node.js, use `0o755` (ES2015
octal literal syntax). `0755` is the legacy octal form (valid in CommonJS but emits
a deprecation warning in strict mode). `chmod(path, 0o755)` in TypeScript is unambiguous.

### 10.2 Write-then-chmod Race Window

The naive approach:
```typescript
await fsp.writeFile(shimPath, content);     // world-readable, not executable
await fsp.chmod(shimPath, 0o755);           // now executable
```
Between the two calls, the file exists but is not executable. On shared filesystems
(NFS, networked home directories), another process could observe the shim before it
is executable and cache that state. The `{ mode }` option on `writeFile` eliminates
the race:
```typescript
await fsp.writeFile(shimPath, content, { mode: 0o755 });
```
On Linux and macOS, `open(2)` with `O_CREAT | O_WRONLY` and the supplied mode creates
the file executable from the first moment it is visible. This is what the generator
in §8 does via the temp-file+rename pattern.

### 10.3 umask Interaction

The `mode` option to `writeFile` is subject to the process's `umask`. If the user's umask
is `0022` (the default), the effective mode is `0o755 & ~0o022 = 0o755` (no change, because
0755 already has no group-write or other-write bits). If the user has a restrictive umask
(e.g., `0077`), the effective mode would be `0o755 & ~0o077 = 0o700` — executable only by
the owner, which is still correct for a personal `~/.tool-agents` shim.

For cli-agent's use case (writing to `~/.tool-agents/cli-agent/composites/`), umask
interaction is acceptable — users who restrict their umask expect that restriction to apply.

If strict `0o755` is required regardless of umask (e.g., for testability), call
`fsp.chmod(shimPath, 0o755)` after the rename in the generator. The race window risk is
negligible post-rename since the file is already written.

---

## 11. How to Test the Shim End-to-End Without Provider Credentials

The investigation document (§Q6) already establishes the fixture-folder pattern for
synthesis tests. Testing the shim itself is a separate concern.

### 11.1 Test Pattern A — Shim Execution With `--dry-run` Stub

cli-agent supports a `CLI_AGENT_DRY_RUN_SYNTHESIS=1` environment variable pattern (per the
investigation's stub-LLM guidance). For shim testing, the relevant stub is the
`CLI_AGENT_STUB_LLM=1` environment variable the codebase uses to avoid real LLM calls.

A minimal end-to-end shim test:

```typescript
// test_scripts/shim-e2e.ts
import { execFileSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { generateCompositeWrapperShim } from '../src/agent/composite/shimGenerator.js';

const TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-shim-test-'));

// 1. Write a minimal fixture doc so --help works.
const docPath = path.join(TMP, 'test-composite.md');
await fsp.writeFile(docPath, '# test-composite\nA fixture composite.\n');

// 2. Generate the shim pointing at the current cli-agent entrypoint.
const cliAgentBin = process.argv[1]; // path to cli-agent (resolved by Node)
const result = await generateCompositeWrapperShim({
  compositeName: 'test-composite',
  members: ['file-cli', 'search-cli'],
  cliAgentBinPath: cliAgentBin,
  capabilityDocPath: docPath,
  shimDir: TMP,
  synthesizedAt: new Date().toISOString(),
});

// 3. Verify --help returns the doc content.
const helpOut = execFileSync(result.shimPath, ['--help'], { encoding: 'utf8' });
console.assert(helpOut.includes('test-composite'), '--help must include the composite name');

// 4. Verify --version (or any non-help arg) exec-s cli-agent.
//    Use CLI_AGENT_STUB_LLM=1 to avoid real provider init.
const versionOut = execFileSync(result.shimPath, ['--version'], {
  encoding: 'utf8',
  env: { ...process.env, CLI_AGENT_STUB_LLM: '1' },
});
console.assert(versionOut.length > 0, '--version must produce output');

// 5. Verify exit code propagation.
let shimExitCode = 0;
try {
  execFileSync(result.shimPath, ['--unknown-flag-that-errors'], {
    env: { ...process.env, CLI_AGENT_STUB_LLM: '1' },
  });
} catch (err: any) {
  shimExitCode = err.status ?? 1;
}
console.assert(shimExitCode !== 0, 'bad flag must produce non-zero exit code');

console.log('Shim e2e tests passed.');
await fsp.rm(TMP, { recursive: true });
```

### 11.2 Test Pattern B — Shim Content Snapshot

A faster unit test that does not exec the shim:

```typescript
import { generateCompositeWrapperShim } from '../src/agent/composite/shimGenerator.js';
import { readFileSync } from 'node:fs';

const result = await generateCompositeWrapperShim({ /* … */ });
const content = readFileSync(result.shimPath, 'utf8');

// Snapshot assertions
assert(content.startsWith('#!/bin/sh\n'), 'must begin with #!/bin/sh');
assert(content.includes("exec '/usr/local/bin/cli-agent' --tool file-cli --tool search-cli \"$@\""));
assert(content.includes('case "${1:-}"'));
assert(content.includes('exec cat "$DOC"'));
assert(content.includes('exit 6'));
```

### 11.3 Verifying the Mode

```typescript
import { statSync } from 'node:fs';
const stat = statSync(result.shimPath);
const actualMode = stat.mode & 0o777;
assert.strictEqual(actualMode & 0o111, 0o111, 'shim must be executable by owner/group/other');
```

---

## 12. Common Pitfalls

### 12.1 Paths With Spaces

The `shellescape()` function in §8 handles this. Without it, a path like
`/Users/john doe/bin/cli-agent` would be split at the space and become two arguments to
`exec`. Always single-quote paths.

The `DOC` assignment in the shim also needs quoting. In the template, `DOC=<value>` must
be `DOC='/path/with spaces/doc.md'` — which `shellescape()` produces correctly.

### 12.2 `$PATH` Precedence — Shim Name Colliding With a Real Binary

If the user installs a composite named `git` or `npm`, the shim at
`~/.tool-agents/cli-agent/composites/git` could shadow the real binary if that directory
is prepended to `PATH`. The cli-agent shim writer should:

1. Validate the composite name against a reserved-names list at synthesis time.
2. Emit a warning if the name matches any binary found via `which <name>`.
3. Document that `~/.tool-agents/cli-agent/composites/` should never appear in `PATH`
   ahead of system paths.

Because the investigation spec (FR-CMP-013) puts the composites directory at
`~/.tool-agents/cli-agent/composites/<name>`, not in a system-wide `PATH` entry, the
risk is low by default. `--emit-wrapper-on-path` (if implemented in a later version)
must include this collision check.

### 12.3 Stale Shim After Member Set Change

If the user modifies the composite member set (adds or removes a tool), the existing shim
at `~/.tool-agents/cli-agent/composites/<name>` embeds the *old* member list. The shim
is not automatically invalidated. The correct fix is:

1. The shim regeneration path (`--regenerate-capabilities`) must overwrite the shim via
   the same `generateCompositeWrapperShim()` function.
2. The regeneration function should compare the shim's embedded `--tool` flags against the
   manifest before deciding whether to regenerate, to avoid unnecessary writes.

### 12.4 Signal Forwarding With `nohup` or Background Jobs

When the shim is backgrounded (`& disown`) or run under `nohup`, `exec` still replaces the
shell with `cli-agent`. However, if the shell receives a signal *before* the `exec` line
executes (e.g., during the `case` statement evaluation), the signal is handled by the shell.
For a 4-line shim this window is microseconds — it is not a practical concern.

### 12.5 `exec` With a Non-Existent Binary

If `cliAgentBinPath` does not exist at execution time (e.g., cli-agent was uninstalled after
the composite was created), `exec` will fail with:
```
/path/to/cli-agent: No such file or directory
```
and exit with code 127. This is the correct POSIX behaviour for "command not found". The
shim does not need to handle this case specially.

### 12.6 Symlink Resolution in `basedir`

The npm `basedir` computation:
```sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")
```
computes the directory containing `$0` — the path used to *invoke* the shim. It does **not**
resolve symlinks. If the user creates a symlink `~/.local/bin/<name>` → shim, `$0` will be
`/home/user/.local/bin/<name>` and `basedir` will be `/home/user/.local/bin`. This is fine
for the cli-agent shim because `basedir` is only used for the optional comment; the shim
uses absolute paths for `DOC` and `cliAgentBinPath`. If a future version of the shim
needs `basedir` for a relative path, use `readlink -f "$0"` (Linux) or
`$(cd "$(dirname "$0")"; pwd -P)` (POSIX-portable) instead.

---

## 13. Investigator Recommendation Alignment / Contradictions

The investigation document (§Q2 / Option 2A) recommended `#!/usr/bin/env bash` and
`set -euo pipefail`. This research finds two contradictions:

| Investigator recommendation | Research finding | Verdict |
|---|---|---|
| `#!/usr/bin/env bash` | npm uses `#!/bin/sh`; cli-agent shim uses no bash features; `#!/bin/sh` is safer | **Change to `#!/bin/sh`** |
| `set -euo pipefail` | npm omits it; `pipefail` is not POSIX-sh; `exec` makes it redundant; `set -u` interacts badly with `${1:-}` | **Omit** |
| `exec cli-agent …` | Confirmed — `exec` is correct and matches npm | Confirmed |
| `"$@"` with double quotes | Confirmed — matches npm | Confirmed |
| Absolute path for cli-agent binary | Confirmed (research §6) | Confirmed |
| Exit 6 for cache-stale | Confirmed (FR-CMP-013) | Confirmed |
| Omit Cygwin block for macOS/Linux | Confirmed — safe to omit | Confirmed |

The investigation's core recommendation (POSIX shell shim, `exec`-based) is correct.
The two deviations (`#!/usr/bin/env bash`, `set -euo pipefail`) should be corrected in
plan-006 to match the npm reference.

---

## Assumptions & Scope

### Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|---|---|---|
| cli-agent targets macOS and Linux only; no Windows in v1 | HIGH — stated in investigation doc Out of Scope §2 | If Windows is added, a `.cmd` and `.ps1` shim must also be written; the generator must call `cmd-shim` or equivalent |
| The user has `/bin/sh` (POSIX sh) on their system | HIGH — true on every macOS and mainstream Linux distro | None on macOS/Linux; relevant only on stripped Docker images |
| Member names contain only `[a-zA-Z0-9_-]` characters | HIGH — implied by existing CLI validation | `shellescape()` around member names would be needed if relaxed |
| The cli-agent binary's absolute path is stable across sessions | MEDIUM — true for global npm installs; fragile for nvm/volta shims that change per shell | Generator should document this; cross-machine portability is already deferred |
| `fsp.writeFile` with `mode` option is not subject to TOCTOU on macOS APFS | HIGH — APFS is atomic for file creation | Negligible risk; the temp-file+rename pattern provides an additional safety layer |

### What is Explicitly Out of Scope

- Windows support (`.cmd` shim, `.ps1` shim)
- Alpine Linux bash-installation fallback
- The `cmd-shim` npm package as a runtime dependency
- Cross-machine shim portability (deferred to post-v1)
- `--emit-wrapper-on-path` collision detection (noted as a pitfall; implementation deferred)

### Uncertainties and Gaps

- **`nvm`/`volta` managed Node installations**: the absolute path to cli-agent captured at
  synthesis time may be `/Users/user/.nvm/versions/node/v22.0.0/bin/cli-agent`. If the user
  switches Node versions, this path no longer exists. The shim would fail with exit 127.
  Resolution: document this in the configuration guide; add a warning at synthesis time if
  the detected cli-agent path is inside `~/.nvm/` or `~/.volta/`.

- **`basedir` in the shim is computed but not used**: the current template computes `basedir`
  but only uses absolute paths. This is intentional forward-compatibility. If a future version
  needs relative paths, the `basedir` computation is already present.

---

## References

| # | Source | URL | Information Gathered |
|---|--------|-----|---------------------|
| 1 | npm/cmd-shim lib/index.js (raw) | https://raw.githubusercontent.com/npm/cmd-shim/main/lib/index.js | Exact POSIX shim template, chmod strategy, `exec` pattern, Cygwin block |
| 2 | npm/cmd-shim package.json | https://raw.githubusercontent.com/npm/cmd-shim/main/package.json | Version 8.0.0, zero runtime dependencies, engines node >=22.9.0 |
| 3 | @pnpm/cmd-shim src/index.ts | https://raw.githubusercontent.com/pnpm/cmd-shim/main/src/index.ts | `generateShShim()` implementation; `exit $?` fallback; `isShimPointingAt()` marker |
| 4 | npm/cmd-shim test/basic.js | https://raw.githubusercontent.com/npm/cmd-shim/main/test/basic.js | Test cases for various shebang forms; snapshot test pattern |
| 5 | Bundlephobia API (cmd-shim@8.0.0) | https://bundlephobia.com/api/size?package=cmd-shim@8.0.0 | 3 628 bytes minified, 1 755 bytes gzip, 0 dependencies |
| 6 | npm/cmd-shim GitHub issues — real-world shim examples | https://github.com/anthropics/claude-code/issues/33955 | Real shim content from npm global installs; POSIX exec line pattern |
| 7 | pnpm issue #4769 — env var inheritance | https://github.com/pnpm/pnpm/issues/4769 | Confirms exec does forward environment variables; shim pattern |
| 8 | nodejs/node issue #58346 — real shim with CYGWIN block | https://github.com/nodejs/node/issues/58346 | Full shim example with CYGWIN/MINGW/MSYS block; exec pattern |
| 9 | Rodaine.com — sh shebang and pipefail fail | https://rodaine.com/til/2020/11/sh-shebang-pipefail/ | `pipefail` is not POSIX-sh; dash ignores it silently |
| 10 | Linuxize — Bash strict mode | https://linuxize.com/post/bash-strict-mode/ | What each flag does; interaction with exec |
| 11 | OneUptime — Docker entrypoint signal handling | https://oneuptime.com/blog/post/2026-02-08-how-to-handle-error-handling-in-docker-entrypoint-scripts/view | `exec "$@"` replaces shell with app; signals reach app directly |
| 12 | mundobytes.com — trap and signal forwarding | https://mundobytes.com/en/bash-scripting-with-set-euo-pipefail-trap-and-logging/ | `trap` pattern for when exec cannot be used |
| 13 | Node.js docs — process.argv | https://nodejs.org/docs/latest/api/process.html | `process.argv[1]` is resolved real path; `--preserve-symlinks-main` for symlink retention |
| 14 | Baeldung — Path of bash script from symlink | https://www.baeldung.com/linux/path-of-bash-script | `readlink -f "$0"` vs `$(cd … pwd -P)` portability |
| 15 | ko1nksm/readlinkf — portable readlink -f | https://github.com/ko1nksm/readlinkf | POSIX-portable readlink -f implementation for cross-platform shims |
| 16 | Baeldung — `#!/bin/sh` vs `#!/usr/bin/env bash` | https://www.baeldung.com/linux/bash-shebang-lines | Decision guide for shebang selection |
| 17 | nixCraft — portable shebang via env | https://www.cyberciti.biz/tips/finding-bash-perl-python-portably-using-env.html | `#!/usr/bin/env` advantages and caveats |
| 18 | investigation-composite-tools.md §Q2 | docs/reference/investigation-composite-tools.md | Upstream investigation findings and constraints |

### Recommended for Deep Reading

- **Source 1** (`npm/cmd-shim lib/index.js`): The 172-line reference implementation. Read in
  full before writing the generator — particularly the `writeShim_()` function and how it
  handles `shLongProg` (local interpreter fallback) vs the simpler `exec prog target "$@"` case.

- **Source 3** (`@pnpm/cmd-shim src/index.ts`): The TypeScript version with clearer structure
  and the `isShimPointingAt()` overwrite-detection pattern. Relevant if cli-agent ever needs
  to detect "this shim was already written and points at a different composite version."

- **Source 11** (OneUptime Docker entrypoint): Concise explanation of why `exec` is the
  correct signal-forwarding mechanism and what breaks without it.

---

## Clarifying Questions for Follow-up

1. **nvm/volta path stability**: should the generator detect if `cliAgentBinPath` is inside
   a version-manager directory (`~/.nvm/`, `~/.volta/`, `~/.asdf/`) and either warn or refuse
   to embed it? If yes, what is the fallback — refuse synthesis, or embed a wrapper that
   uses `which cli-agent` at runtime?

2. **`--emit-wrapper-on-path` (FR-CMP-013)**: if a future version of the shim is placed in
   a `PATH` directory, should the generator add a collision check for reserved binary names?
   If so, should the check be a warning (emit and log) or a hard error?

3. **Shim regeneration on member-set change**: is the regeneration path expected to diff
   the current shim's `--tool` flags against the manifest, or should it always overwrite?
   Always-overwrite is simpler and still correct; diff-and-skip saves a write but adds
   complexity.

4. **`basedir` usage**: the current template computes `basedir` for forward compatibility.
   If it is confirmed that the shim will always use absolute paths and `basedir` will never
   be needed, the `basedir` line can be dropped to reduce shim size.
