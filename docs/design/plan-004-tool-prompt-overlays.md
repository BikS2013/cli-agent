# Plan 004 — User-editable tool prompt overlays

**Status**: Accepted
**Author**: cli-agent maintainer + Claude
**Date**: 2026-05-01
**Related**: FR-OVR-001 through FR-OVR-008 in `docs/design/project-functions.md`; project-design §11.

## Problem

Each tool's `description` field (LangChain channel) and per-parameter zod
`.describe(...)` strings are baked into the TypeScript source at
`src/agent/tools/<group>/<name>-tool.ts`. End users who want to tune the
guidance the LLM receives — e.g. "always prefer `agt_grep` over `bash_run grep`"
or "never read `.env` even when `path` matches" — cannot do so without forking
and rebuilding the binary.

The user-facing system prompt at `~/.tool-agents/cli-agent/capabilities/system-prompt.md`
is already editable. The wrapped-CLI capability docs at
`~/.tool-agents/cli-agent/capabilities/<tool>.md` are already editable. The
**per-tool descriptions** the LLM consumes via `bindTools` are NOT.

## Goal

Let users edit the description of any registered tool and any parameter from
on-disk markdown files, with the same lifecycle (`~/.tool-agents/cli-agent/`,
no-fallback rule, four-tier override chain) as the rest of cli-agent's user
data.

## Non-goals

- Replacing the static base prompt (already user-editable elsewhere).
- Hot-reload during a running session — restart suffices.
- Templated/partial overrides (`{{default}}` substitution); v1 is full overwrite.
- Parameter type/validation overrides — only the description text is overridable.

## Architecture

### Where artifacts live

```
~/.tool-agents/cli-agent/
├── system-prompt.md           ← already user-editable
├── capabilities/<tool>.md     ← already user-editable (wrapped-CLI docs)
└── tool-prompts/              ← NEW (added by this plan)
    ├── file_read.md
    ├── file_list.md
    ├── file_write.md
    ├── file_edit.md
    ├── file_append.md
    ├── web_search.md
    ├── web_fetch.md
    ├── bash_run.md
    ├── bash_list_allowed.md
    ├── bash_which.md
    ├── tool_help.md
    ├── agt_glob.md
    ├── agt_grep.md
    ├── agt_multiedit.md
    ├── agt_patch.md
    ├── agt_todo_read.md
    └── agt_todo_write.md
```

Permissions: directory `0700`, files `0600` (consistent with the rest of the
agent dir).

### File format — pure markdown (no YAML dependency)

```markdown
# file_read

## Description

Read the contents of a plain-text file on disk inside the allowed file root.

Use this when you need to inspect a config file, log file, or piece of
documentation. Prefer file_list first if you don't know the exact path.

## Parameters

### path

Path to the file to read (relative to file root or absolute).

### max_bytes

Maximum bytes to read (default 1 MiB).

### binary

If true, return content as base64. Default: false (utf8).
```

Why pure markdown:

| Concern | Resolution |
|---|---|
| No new dep needed | Parser is ~50 LOC of regex; rejecting `js-yaml` keeps the install size unchanged. |
| Editor-friendly | `.md` files render in any editor with markdown support. |
| Self-documenting | Headings ARE the structure. No frontmatter syntax to memorize. |
| Sanity-checkable | The `# <name>` H1 is cross-checked against the filename at load time — mismatch raises `ConfigurationError`. |
| Multiline prose | Body of each section is free markdown; tool description can be multi-paragraph. |

### Parser contract

A new module `src/agent/tools/tool-prompt-overlay.ts` exports:

```ts
interface ParsedOverlay {
  readonly tool: string;          // from H1 heading
  readonly description: string;   // body of "## Description"
  readonly parameters: ReadonlyMap<string, string>;
                                  // from "### <param>" within "## Parameters"
  readonly source: string;        // absolute path of file
}

function parseOverlayFile(path: string, content: string): ParsedOverlay;
//  - throws ConfigurationError on:
//    - missing H1 / wrong format
//    - missing "## Description" section
//    - empty description body
//    - duplicate parameter names
//  - DOES NOT throw on missing "## Parameters" section (a tool with no params
//    has nothing to describe).
//  - DOES NOT validate that the H1 matches the filename — the loader does that.

interface OverlayRegistry {
  get(tool: string): ParsedOverlay | undefined;
  list(): readonly ParsedOverlay[];
}

function loadOverlayRegistry(cfg: AgentConfig): Promise<OverlayRegistry>;
//  - reads every *.md file in `cfg.toolPromptsDir`
//  - for each file: parseOverlayFile(...) AND validate filename matches the H1
//  - on any parse / mismatch error: ConfigurationError naming the file
//  - missing dir: returns an empty registry (no overlays — built-in defaults)

function getToolDescription(reg: OverlayRegistry, tool: string, fallback: string): string;
function getParamDescription(reg: OverlayRegistry, tool: string, param: string, fallback: string): string;
//  - fallback is the built-in default baked into the tool factory.
//  - returned only when the registry has no overlay for the tool/param.
//  - "fallback" here is the default-built-in concept, NOT a config-fallback.
//    Per CLAUDE.md, defaults are starting values, not silent substitutes for
//    missing required config.
```

### Built-in default registry

A single file `src/agent/tools/tool-prompts-builtin.ts` exports:

```ts
export interface BuiltinToolPrompts {
  readonly description: string;
  readonly parameters: { readonly [param: string]: string };
}

export const BUILTIN_TOOL_PROMPTS: { readonly [tool: string]: BuiltinToolPrompts } = {
  file_read: {
    description: 'Read the contents of a plain-text file on disk inside the allowed file root.',
    parameters: {
      path: 'Path to the file to read (relative to file root or absolute).',
      max_bytes: 'Maximum bytes to read (default 1 MiB).',
      binary: 'If true, return content as base64. Default: false (utf8).',
    },
  },
  // ... 16 more entries, one per registered tool
};
```

This is the single source of truth for built-in defaults. The bootstrap, the
extract command, the audit command, and every tool factory all read from this
constant.

### Tool factory integration pattern

Each `createXxxTool(cfg)` factory (and each `buildAgt<X>Tool(deps)`) consults
the overlay registry passed in via `cfg.toolPromptOverlays` (a new field on
`AgentConfig`) — falling back to `BUILTIN_TOOL_PROMPTS[<tool>]`.

```ts
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import { getToolDescription, getParamDescription } from '../tool-prompt-overlay.js';

const TOOL = 'file_read';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL]!;

export function createFileReadTool(cfg: AgentConfig): DynamicStructuredTool {
  const reg = cfg.toolPromptOverlays;
  const schema = z.object({
    path: z.string().min(1).describe(
      getParamDescription(reg, TOOL, 'path', BUILTIN.parameters.path),
    ),
    max_bytes: z.number().int().positive().optional().describe(
      getParamDescription(reg, TOOL, 'max_bytes', BUILTIN.parameters.max_bytes),
    ),
    binary: z.boolean().optional().describe(
      getParamDescription(reg, TOOL, 'binary', BUILTIN.parameters.binary),
    ),
  });

  return new DynamicStructuredTool({
    name: TOOL,
    description: getToolDescription(reg, TOOL, BUILTIN.description),
    schema,
    func: ...,
  });
}
```

### Bootstrap (first-run seed)

`bootstrapAgentDir` (`src/config/agent-config.ts`) is extended:

1. After creating `~/.tool-agents/cli-agent/capabilities/`, also create
   `~/.tool-agents/cli-agent/tool-prompts/` (mode `0700`).
2. For every entry in `BUILTIN_TOOL_PROMPTS`, write the corresponding
   `<tool>.md` file (mode `0600`) using the `serializeOverlay(builtin)` helper.
3. The write is **additive**: existing files are NEVER overwritten. Future
   releases that add new tools seed only the new files. Users see a one-line
   message: `seeded N new tool-prompt overlays: <names>`.

### Three new CLI subcommands

```
cli-agent extract-tool-prompts [--force]
  Walk BUILTIN_TOOL_PROMPTS and write one overlay file per tool to
  ~/.tool-agents/cli-agent/tool-prompts/. Idempotent — skips files that
  already exist unless --force is passed.

cli-agent show-tool-prompt --tool <name>
  Print the effective (overlay-merged) description + parameters for the named
  tool. Used to verify overlays are taking effect without launching the agent.

cli-agent audit-tool-prompts [--strict]
  Cross-check every overlay file against the current code:
   - warn on overlays for tools no longer in BUILTIN_TOOL_PROMPTS
   - warn on parameters present in overlay but not in current schema
   - warn on parameters missing from overlay that are present in current schema
  --strict: exit non-zero on any warning (CI gate).
```

Each command must use the `cmd.optsWithGlobals()` + `pickFirstTool()` recovery
pattern (see `src/cli.ts`) to avoid the parent-program `--tool` shadowing bug
fixed in 0.1.1.

## File ownership for implementation

| Unit | Files |
|---|---|
| Plan + docs | `docs/design/plan-004-tool-prompt-overlays.md`, `docs/design/project-functions.md`, `docs/design/project-design.md` (§11), `docs/tools/cli-agent.md` |
| Loader + parser | `src/agent/tools/tool-prompt-overlay.ts`, `src/agent/tools/tool-prompt-overlay.spec.ts` |
| Built-in registry | `src/agent/tools/tool-prompts-builtin.ts` |
| Config wiring | `src/config/agent-config.ts` (add `toolPromptOverlays` field; bootstrap seed) |
| CLI | `src/commands/extract-tool-prompts.ts`, `src/commands/show-tool-prompt.ts`, `src/commands/audit-tool-prompts.ts`, `src/cli.ts` (3 new subcommands) |
| Factory updates | `src/agent/tools/file/{read,list,write,edit,append}-tool.ts`, `src/agent/tools/web/{search,fetch}-tool.ts`, `src/agent/tools/bash/{run,list-allowed,which}-tool.ts`, `src/agent/tools/tool-help-tool.ts`, `src/agent/tools/agent-tools/agt-{glob,grep,multiedit,patch,todo-read,todo-write}.ts` |

## Acceptance criteria

1. **AC-OVR-1** Built-in registry contains an entry for every tool currently
   returned by `buildToolCatalog`. Audit command verifies parity.
2. **AC-OVR-2** Bootstrap on a fresh `~/.tool-agents/cli-agent/` writes 17
   overlay files (one per built-in tool). Existing files are never overwritten.
3. **AC-OVR-3** When an overlay file's body for `## Description` differs from
   the built-in, `cli-agent show-tool-prompt --tool <name>` prints the overlay
   value. The same value is bound to the LangChain `description` field at
   `bindTools` time.
4. **AC-OVR-4** When an overlay file is malformed (missing H1, missing
   `## Description`, duplicate `### <param>`, H1 mismatches filename), every
   cli-agent command that loads the registry exits with `ConfigurationError`
   naming the file.
5. **AC-OVR-5** When an overlay file is absent for a tool, the built-in
   default is used. This is NOT a configuration fallback — it is the explicit
   "no overlay" state.
6. **AC-OVR-6** `cli-agent audit-tool-prompts` reports drift correctly:
   unknown tools, stale parameters, missing parameters. `--strict` exits 1
   on any drift.
7. **AC-OVR-7** Full test suite passes (≥ 308 baseline + new overlay tests).
   `npm run build` clean. `npx tsc --noEmit` clean.
8. **AC-OVR-8** Bumping minor version (0.1.x → 0.2.0) since this is a feature.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| User overlay names a parameter that no longer exists in current schema (after a code change renames a field) | `audit-tool-prompts` warns; runtime IGNORES the unknown key (logged once at startup). Hard fail would lock the user out. |
| Overlay description is unbounded length, blowing the prompt token budget | Document a recommended ceiling per tool (matches existing 400-token rule from agent-tools pack). Audit command reports per-tool token count via `js-tiktoken` (already transitively present). |
| Forgetting to update `BUILTIN_TOOL_PROMPTS` when a new tool is added | Add a registry-completeness test that asserts every tool name returned by a stub `buildToolCatalog` invocation has an entry in `BUILTIN_TOOL_PROMPTS`. |
| Existing users on 0.1.x upgrade and don't see new overlays | Bootstrap is run on every cold start (not just first run) — additive seed catches any new tools added in subsequent releases. |

## Phasing

| Phase | Deliverable |
|---|---|
| **1** | Plan + project docs (this commit) |
| **2** | Loader, parser, built-in registry, tool-prompt-overlay.spec.ts |
| **3** | Bootstrap auto-seed, 3 CLI subcommands, cli.ts wiring |
| **4** | Update all 17 tool factories to consume the overlay |
| **5** | Tests, build, smoke verification, version bump → 0.2.0 |

All phases land in a single commit (the user has a clean tree right now and
asked for a single coherent feature). If the implementation surfaces problems
that warrant a revisit, we split.
