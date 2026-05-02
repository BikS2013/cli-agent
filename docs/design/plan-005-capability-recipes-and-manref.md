# Plan 005 — Capability recipes & manual-page reference

**Status**: Implemented (0.3.0)
**Author**: cli-agent maintainer + Claude
**Date**: 2026-05-02
**Related**: extends the capability subsystem from plan-001/plan-003; complements
the user-editable overlays from plan-004.

## Problem

`refresh-capabilities` currently produces a capability document containing only
the `--help` introspection: top-level synopsis + per-subcommand synopsis. That
output is fine for *flag discovery* but is the wrong level of detail for the two
things a human actually reaches for when **using** a tool:

1. **The canonical recipes** — "to commit staged changes, run
   `git commit -m <msg>`". `--help` lists every flag in isolation; recipes
   show the idiomatic invocation. The agent currently has to derive these
   from raw flag lists, which is error-prone for tools with large surface
   areas (`git`, `kubectl`, `ffmpeg`, `aws`).
2. **The manual page** — `--help` is intentionally terse on macOS / BSD tools
   (e.g. `cat -h` prints two lines). The man page is where exit codes,
   environment variables, examples, and flag interactions actually live. The
   agent has no pointer to it and currently cannot find this information at
   all.

Plan 004 made *tool descriptions* user-editable. This plan makes the *capability
content* match what a human reaches for during execution, not just discovery.

## Goal

Extend each per-tool capability document at
`~/.tool-agents/cli-agent/capabilities/<tool>.md` with:

- An **auto-detected manual reference** (frontmatter + inline section), refreshed
  each time `refresh-capabilities` runs.
- A **user-curated recipes block**, preserved across refresh exactly like the
  existing `USER-NOTES` block.
- An optional **LLM-assisted recipe extractor** (`extract-recipes`) that
  proposes recipes for the user to review and paste, never writes them
  silently.

Both new sections feed into the system-prompt composer so the running agent
sees them at invocation time, not just at help time.

## Non-goals

- Auto-writing recipes without user review. Recipes are a curation artifact
  (like `USER-NOTES`); silent generation invites stale, hallucinated commands
  that look authoritative.
- Embedding the full man page in the capability doc. Token budget is finite
  and man pages are LARGE (`man bash` ≈ 200 KB). The agent is told *where* to
  read from, not *given* the entire content.
- Cross-platform man page emulation. On Windows or for Node CLIs without man
  entries, the field is absent — no synthesis, no fabricated URL.
- Built-in seeded recipes for arbitrary external CLIs. The set of wrapped
  tools is open-world; we do not ship a curated database of recipes for
  unknown binaries. Plan 004 owns recipes for *internal* tools (`file_*`,
  `bash_*`, `agt_*`).

## Architecture

### File layout (no new files on disk)

The recipes and man-ref live **inside** the existing per-tool capability
document. This is intentional: the file the user already edits stays the
single point of truth. Two changes to the document shape:

```markdown
---
tool: git
binaryPath: /usr/bin/git
…existing fields…
manRef: man:1 git                          ← NEW (frontmatter)
manPagePath: /usr/share/man/man1/git.1.gz  ← NEW (frontmatter, optional)
schemaVersion: 2                           ← BUMPED from 1
---

<!-- AUTO-GENERATED:START hash=… -->
# git — capability document

## Top-level synopsis
…

## Subcommands
…

## Manual reference                         ← NEW (auto-generated)

A manual page is available. Read it with:

```bash
man 1 git
```

(Use `man:1 git` as the canonical identifier when referring to it.)
<!-- AUTO-GENERATED:END -->

<!-- USER-RECIPES:START -->                 ← NEW (preserved like USER-NOTES)
<!-- USER-RECIPES:END -->

<!-- USER-NOTES:START -->                   ← unchanged
<!-- USER-NOTES:END -->
```

Two reasons for inline (vs. a separate `<tool>.recipes.md`):

1. The system-prompt composer already opens one file per tool. A separate file
   doubles the I/O and adds another path the user must learn about.
2. `tool_help` already returns slices of the capability doc by section name.
   Adding `section: 'recipes' | 'manref'` is a one-line extension; a sibling
   file would need a new tool or new arg.

### Manual-reference detection

A new module `src/agent/capabilities/manref.ts` exports:

```ts
export interface ManRefResult {
  readonly manRef: string | null;        // "man:1 git", or null
  readonly manPagePath: string | null;   // "/usr/share/man/man1/git.1.gz", or null
}

export async function detectManRef(
  binaryName: string,
  timeoutMs: number,
): Promise<ManRefResult>;
```

Detection logic:

1. Spawn `man -w <binaryName>` (POSIX-portable; macOS, Linux, BSD all support
   `-w` to print the path of the man page). Timeout = `cfg.capabilities.timeoutMs`.
2. If exit code is 0 and stdout is a non-empty path: parse the section number
   from the filename (`/usr/share/man/man1/git.1.gz` → section `1`); return
   `{ manRef: 'man:1 git', manPagePath: '/usr/share/man/man1/git.1.gz' }`.
3. On any other outcome (non-zero exit, empty stdout, `man` itself not on
   PATH, timeout): return `{ manRef: null, manPagePath: null }`. **This is
   not a configuration fallback** — it is the explicit "no man page" state,
   identical to the "binary not found" placeholder convention.
4. Never invokes `man <name>` itself. Reading the man content is left to the
   agent (via `bash_run man …`) at execution time. We only record the
   pointer.

`detectManRef` is called from `discoverTool` after the binary-probe step and
before the `--help` introspection. Its result is passed into
`composeCapabilityDoc` via two new `ComposeOptions` fields (`manRef`,
`manPagePath`).

### Composition changes

`src/agent/capabilities/composeMarkdown.ts`:

1. `ComposeOptions` gains `manRef: string | null` and
   `manPagePath: string | null`.
2. Frontmatter emission writes both fields. When null, the line is omitted
   entirely (not emitted as `manRef: null`) to keep the absence-state clean
   and grep-friendly.
3. After the `## Subcommands` block, append:
   - `## Manual reference\n\nA manual page is available. Read it with:\n\n\`\`\`bash\nman <section> <tool>\n\`\`\`\n\n(Use \`man:<section> <tool>\` as the canonical identifier when referring to it.)\n` — when manRef present.
   - Nothing — when manRef is null. Do not emit "no manual page available";
     the agent reads the doc, and an empty section is noise.
4. `schemaVersion` bumps from `1` to `2`.
5. Below the AUTO-GENERATED block, emit a `USER-RECIPES` marker pair
   (`<!-- USER-RECIPES:START -->\n<!-- USER-RECIPES:END -->`) BEFORE the
   existing `USER-NOTES` marker pair. Recipes appear before notes in the
   rendered file because they are the more frequently-edited section.
6. New helper `extractUserRecipes(existingDoc)` mirrors `extractUserNotes`,
   returning the marker block (including markers) or the empty pair when
   absent. Used to preserve the user's recipes across refresh.

### Cache reader changes

`src/agent/capabilities/cache.ts`:

1. `CacheFrontmatter` interface gains optional `manRef?: string | null` and
   `manPagePath?: string | null`.
2. `parseFrontmatter` reads both keys; absent → `null`. Quoted-string and
   bare-value forms both accepted (consistent with existing parser).
3. `SUPPORTED_SCHEMA_VERSION` bumps to `2`. Documents with `schemaVersion: 1`
   are treated as cache miss and re-discovered on the first refresh after
   upgrade. (Same convention used today for unsupported schemas — see
   line 64 of `cache.ts`.)
4. `CacheEntry` gains `userRecipes: string` (extracted block, including
   markers, or empty pair).

### Schema-1 → schema-2 migration

The bump is non-destructive:

- Reading a v1 doc returns `null` (cache miss). The next `cli-agent` start
  triggers `discoverTool`, which writes a v2 doc, **preserving USER-NOTES
  via the existing extraction path**. USER-RECIPES will be empty (the v1
  doc didn't have one).
- The `--refresh-capabilities` startup flag and explicit `refresh-capabilities`
  command both already trigger this path; no special migration command needed.
- For users who hand-wrote USER-NOTES in v1 docs, those notes are preserved
  by the existing `existing?.fullContent` path through `composeCapabilityDoc`.

### System-prompt composer changes

`src/agent/capabilities/compose-system-prompt.ts`:

1. After the `userNotes` extraction, also extract `userRecipes` (same regex
   strategy with the new markers) and the `manRef` from the parsed
   frontmatter (already available via `cache.readCacheEntry`; refactor the
   composer to use that helper instead of re-reading the file ad-hoc).
2. Emission ordering inside each tool's section, byte budget permitting:
   1. AUTO-GENERATED body (already includes `## Manual reference`).
   2. `**User recipes:**` + recipes content (only when non-empty).
   3. `**User notes:**` + notes content (existing).
3. When over budget, the compact-entry path (`composeCompactEntry`) is
   extended to also include the manRef line and a one-line "user recipes
   present" hint pointing the agent at `tool_help` with `section='recipes'`.
   The full recipes content does not get embedded compactly — the agent is
   told to fetch it on demand. This protects the prompt budget for
   high-flag tools like `git`.

### tool_help extension

`src/agent/tools/tool-help-tool.ts`:

1. The `section` enum gains two values: `'recipes'` and `'manref'`.
2. `'recipes'`: returns the body inside `<!-- USER-RECIPES:START -->` … `<!-- USER-RECIPES:END -->`,
   with markers stripped, trimmed. Empty string when absent.
3. `'manref'`: returns the `## Manual reference` section body from the
   AUTO-GENERATED block, with the manRef identifier and the canonical
   `man <section> <tool>` invocation. Empty string when no man page was
   detected at refresh time.
4. Both are byte-budget-respected (truncate to `cfg.perToolBudgetBytes`,
   same as the existing `'full'` path).
5. Tool-prompt overlay description updated to enumerate the two new section
   values (via the `tool_help.md` overlay file scaffolded by plan 004 — the
   built-in description string in `tool-prompts-builtin.ts` is the source of
   truth, and the overlay seed regenerates on next bootstrap if absent).

### Recipe extractor (LLM-driven, default-write)

A new CLI subcommand:

```
cli-agent extract-recipes --tool <name> [--max-recipes <N>] [--stdout] [--append]
```

Behavior:

1. Read the cached capability doc for `<tool>`. Error with
   `CapabilityError` (`E_CAPABILITY_NOT_FOUND`) when absent — same shape
   that `tool_help` already raises.
2. Read the man page when `manRef` is present:
   `bash -c 'man <section> <tool> | col -bx'`. Cap at 64 KB. Continue with
   `--help` only when man fetch fails or absent.
3. Build a focused prompt: "Given the following help and man-page text,
   produce up to N idiomatic invocations as `### <name>` followed by a
   fenced bash block. Avoid destructive flags. Do not invent flags not
   present in the input."
4. Call the configured LLM (same provider stack as discovery) with that
   prompt. Result is markdown.
5. **Default**: splice the proposal between the existing
   `<!-- USER-RECIPES:START -->` / `<!-- USER-RECIPES:END -->` markers,
   replacing any existing inner content. Write `mode: 0o600`. Stderr
   summary names the path and whether content was replaced or appended.
6. `--stdout`: print without touching the file (review / CI / piping).
7. `--append`: keep existing recipes and append new ones instead of
   replacing.
8. When the document is missing the marker pair (stale v1 doc),
   default-write raises `UsageError` pointing the user at
   `refresh-capabilities`. We do NOT silently invent the markers — that
   would mask a stale-schema condition.

Why default-write: recipes are user-curated truth, but the curation
boundary is the user's editor (deletion of unwanted recipes), not a
copy-paste step. An LLM proposal landing directly between the markers
is the most ergonomic workflow; the user prunes what they don't want.
The structural defense moves from "stdout-only" to "the user reads and
edits the file like any other config file." For automated / piped
workflows that DO need stdout, `--stdout` exists.

`--max-recipes` defaults to `8`. Hard upper bound `20` (defensive — beyond
this the prompt-budget rule defeats the purpose).

### Configuration

No new env vars. No new config-file keys. Two existing fields are reused:

- `cfg.capabilities.timeoutMs` — gates `man -w` invocation.
- `cfg.perToolBudgetBytes` — applies to `tool_help` returns and to the
  per-tool slice of the system-prompt composer.

The man-detection step is **not** behind a feature flag. It is a single,
fast (`man -w` is < 50 ms on every system tested) syscall and adds at most
one frontmatter line. Hiding it behind a flag would add config surface for
no benefit.

## File ownership for implementation

| Unit | Files |
|---|---|
| Plan + project docs | `docs/design/plan-005-capability-recipes-and-manref.md` (this file), `docs/design/project-functions.md` (FR-CAP-101 … FR-CAP-108), `docs/design/project-design.md` (§ on capability subsystem), `docs/tools/cli-agent.md` (extract-recipes section + new tool_help sections) |
| Man-ref detector | `src/agent/capabilities/manref.ts`, `src/agent/capabilities/manref.spec.ts` |
| Compose update | `src/agent/capabilities/composeMarkdown.ts`, `composeMarkdown.spec.ts` |
| Cache update | `src/agent/capabilities/cache.ts`, `cache.spec.ts` |
| Discovery wiring | `src/agent/capabilities/discover.ts`, `discover.spec.ts` |
| System-prompt composer | `src/agent/capabilities/compose-system-prompt.ts`, `compose-system-prompt.spec.ts` |
| tool_help extension | `src/agent/tools/tool-help-tool.ts` (and its existing spec) |
| Recipe extractor | `src/commands/extract-recipes.ts`, `src/cli.ts` (new subcommand wiring), `extract-recipes.spec.ts` |
| Built-in tool prompts | `src/agent/tools/tool-prompts-builtin.ts` (description for `tool_help` enumerates new section values) |

No new top-level dependencies. `man -w` is a process spawn (already used
extensively by `runHelp.ts`).

## Acceptance criteria

1. **AC-CAP-1** When the wrapped binary has a man page, the capability doc
   contains a `manRef: man:<section> <tool>` line in YAML frontmatter and a
   `## Manual reference` section in the AUTO-GENERATED block. When absent,
   neither artifact appears (no fallback / no placeholder).
2. **AC-CAP-2** Every freshly-written capability doc contains both
   `<!-- USER-RECIPES:START --> ... <!-- USER-RECIPES:END -->` and
   `<!-- USER-NOTES:START --> ... <!-- USER-NOTES:END -->` marker pairs,
   with USER-RECIPES appearing first.
3. **AC-CAP-3** Refreshing a doc that already has user content inside
   USER-RECIPES preserves that content byte-for-byte across the refresh,
   identical to the USER-NOTES preservation guarantee.
4. **AC-CAP-4** `cli-agent` started against a v1 capability doc treats it
   as a cache miss, re-discovers, and emits a v2 doc carrying any
   pre-existing USER-NOTES forward.
5. **AC-CAP-5** `tool_help --tool <name> --section recipes` returns the
   USER-RECIPES body (markers stripped, trimmed, byte-budget respected).
   `--section manref` returns the `## Manual reference` body. Both return
   the empty string when the corresponding artifact is absent.
6. **AC-CAP-6** The system-prompt composer includes the manRef pointer for
   every wrapped tool that has one, AND the user-recipes content for every
   tool whose recipes block is non-empty, subject to per-tool byte budget.
   When over budget, the compact path emits the manRef line and a hint
   ("recipes available — call `tool_help` with section=recipes") instead of
   the full recipes body.
7. **AC-CAP-7** `cli-agent extract-recipes --tool <name>` prints LLM-proposed
   recipes to stdout in the documented `### <name>` + fenced-bash format.
   It NEVER writes to disk. With no man page available, it falls back to
   `--help` text alone and prints a one-line stderr notice.
8. **AC-CAP-8** Full test suite passes (≥ baseline + new tests for manref
   detection, schema-2 round-trip, USER-RECIPES preservation,
   tool_help section dispatch, system-prompt composition with recipes,
   extract-recipes stdout shape). `npm run build` clean. `npx tsc --noEmit`
   clean.
9. **AC-CAP-9** Bumping minor version (0.2.x → 0.3.0) since the schema bump
   is observable on disk and the new section values for `tool_help` are a
   visible API addition.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| User pastes a recipe that references a flag the underlying tool no longer supports (drift) | Recipes are user-owned; we don't audit them. The agent invokes them via `bash_run` which surfaces the underlying CLI's error message. The `extract-recipes` command can be re-run after a major upgrade. |
| `man -w` hangs on a slow filesystem | `cfg.capabilities.timeoutMs` already caps the spawn; on timeout, `manRef` is null. |
| Extract-recipes returns recipes referencing non-existent flags (LLM hallucination) | The user reviews every line before pasting. Stdout-only contract makes this enforcement structural, not aspirational. |
| Schema bump breaks v1 caches that users hand-edited | The bump treats v1 docs as cache miss and re-discovers, preserving USER-NOTES. Hand-edited recipes in v1 docs can only have lived in USER-NOTES (no other preserved block existed); they survive. We document the migration in `Issues - Pending Items.md` until the first 0.3 release ships. |
| Token-budget regression: recipes inflate per-tool footprint for users who write extensively | The compact-entry path already truncates to a synopsis + TOC; extended to also keep the manRef + one-line hint. The full recipes block is fetched on demand via `tool_help`. |
| `man` not installed on the host | Detection step gracefully degrades (non-zero exit ⇒ `manRef = null`). Common on minimal Docker images and on Windows; behavior identical to "tool has no man page". |

## Phasing

| Phase | Deliverable |
|---|---|
| **1** | This plan + FR registration in `project-functions.md` + design-doc cross-reference |
| **2** | `manref.ts` detector + spec |
| **3** | `composeMarkdown.ts` schema-2 emission + `cache.ts` reader update + specs |
| **4** | `discover.ts` wiring + spec; round-trip migration test |
| **5** | `compose-system-prompt.ts` integration + budget tests |
| **6** | `tool-help-tool.ts` new sections + spec |
| **7** | `extract-recipes` command + cli wiring + spec |
| **8** | Documentation (`docs/tools/cli-agent.md` extension; configuration-guide cross-reference); version bump → 0.3.0; CHANGELOG; smoke verification with `git`, `cat`, and one Node-CLI tool that has no man page |

Phases 2 through 6 are stackable in a single commit because they form the
schema-2 boundary; phase 7 may land separately if the LLM-extractor surface
needs more iteration. Phase 8 always lands with whichever commit ships the
public schema bump.
