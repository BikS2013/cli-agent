/**
 * Built-in tool-prompt registry — single source of truth for the
 * description and per-parameter help text every native cli-agent tool
 * exposes through `bindTools`.
 *
 * Each entry mirrors the EXACT current strings hard-coded in the
 * matching `src/agent/tools/<group>/<name>-tool.ts` factory (and the
 * `AGT_*_DESCRIPTION` constants for the agent-tools wrappers). Keeping
 * a single canonical copy means:
 *
 *   • the bootstrap routine in `bootstrapAgentDir` can seed an editable
 *     overlay file at `~/.tool-agents/cli-agent/tool-prompts/<name>.md`;
 *   • the `extract-tool-prompts` / `show-tool-prompt` / `audit-tool-prompts`
 *     commands have a deterministic reference to compare overlays against;
 *   • every tool factory consults one constant for its built-in default,
 *     never a forked literal.
 *
 * NOTE on the "no fallback" rule: per CLAUDE.md, defaults are starting
 * values, NOT silent substitutes for missing required configuration.
 * The built-in defaults below are starting values for the prompt-overlay
 * lifecycle — the overlay file is intentionally optional, so the absence
 * of an overlay is the documented "no overlay" state, not a fallback.
 *
 * If you change a description here, update the matching factory's
 * `AGT_*_DESCRIPTION` (where applicable). The `tool-prompts-builtin.spec.ts`
 * registry-completeness test asserts every name in `buildToolCatalog`
 * is represented here.
 */

// Tool-name string literals are duplicated here (instead of imported
// from `./agent-tools/index.js`) to avoid a circular import: the
// `agt-*.ts` wrappers import this module to source their canonical
// description, and the wrappers also export the `AGT_*_NAME` constants.
// Keeping the names as inline literals breaks the cycle and makes this
// module a leaf in the dependency graph.
//
// The `tool-prompts-builtin.spec.ts` registry-completeness test asserts
// these literals match every tool name returned by `buildToolCatalog`,
// so a typo here will fail loudly.

export interface BuiltinToolPrompt {
  readonly description: string;
  readonly parameters: { readonly [param: string]: string };
}

export const BUILTIN_TOOL_PROMPTS: { readonly [tool: string]: BuiltinToolPrompt } = Object.freeze({
  // -------------------------------------------------------------------------
  // agt_file_* — first-party file wrappers (plan-012).
  //
  // These were the former built-in `file_*` tools, re-homed into the agt_
  // pack as FIRST-PARTY members (like agt_web_* in plan-011). Unlike the
  // vendored agt_glob / agt_grep / agt_multiedit / agt_patch below, they are
  // NOT vendored from upstream `agent-tools` — they reuse cli-agent's own
  // sandbox (`src/agent/tools/file/sandbox.ts`). The description/parameter
  // text is copied verbatim from the former file_* entries.
  // -------------------------------------------------------------------------
  agt_file_read: Object.freeze({
    description: 'Read the contents of a plain-text file on disk inside the allowed file root.',
    parameters: Object.freeze({
      path: 'Path to the file to read (relative to file root or absolute).',
      max_bytes: 'Maximum bytes to read (default 1 MiB).',
      binary: 'If true, return content as base64. Default: false (utf8).',
    }),
  }),
  agt_file_list: Object.freeze({
    description: 'List files in a directory inside the allowed file root.',
    parameters: Object.freeze({
      path: 'Directory path to list (relative to file root or absolute).',
      glob: 'Optional glob pattern to filter files (e.g. "*.ts").',
    }),
  }),
  agt_file_write: Object.freeze({
    description: '[MUTATING] Overwrite a file with new content. Requires confirmed: true.',
    parameters: Object.freeze({
      path: 'Path to write (relative to file root or absolute).',
      content: 'Full content to write to the file.',
      confirmed: 'Must be true to proceed with the write.',
    }),
  }),
  agt_file_edit: Object.freeze({
    description: '[MUTATING] Find and replace text in a file. Requires confirmed: true.',
    parameters: Object.freeze({
      path: 'File path to edit.',
      find: 'Exact substring or regex pattern to find.',
      replace: 'Replacement string.',
      occurrence: 'Which occurrence to replace: "first" (default) or "all".',
      use_regex: 'Treat find as a regular expression.',
      confirmed: 'Must be true to proceed.',
    }),
  }),
  agt_file_append: Object.freeze({
    description: '[MUTATING] Append content to an existing file. Requires confirmed: true.',
    parameters: Object.freeze({
      path: 'File path to append to.',
      content: 'Content to append.',
      confirmed: 'Must be true to proceed.',
    }),
  }),

  // -------------------------------------------------------------------------
  // bash_*
  //
  // bash_run's runtime description is dynamic ([MUTATING] vs
  // [READ-ONLY-AGENT] prefix) but the canonical built-in default below
  // matches the [MUTATING] form so the on-disk overlay seed has a single
  // representative text the user can edit. The factory still composes the
  // dynamic prefix at build time when no overlay is present.
  // -------------------------------------------------------------------------
  bash_run: Object.freeze({
    description:
      '[MUTATING] Execute an allow-listed local command and capture its stdout/stderr. ' +
      'Requires confirmed: true. Only binaries on the allowlist may be called.',
    parameters: Object.freeze({
      command: 'Binary name to execute (must be on the allowlist).',
      args: 'Arguments to pass to the binary.',
      timeout_ms: 'Per-call timeout in milliseconds (max 300000).',
      cwd: 'Working directory for the command.',
      stdin: 'Static stdin string passed to the process.',
      confirmed: 'Must be true to execute the command.',
    }),
  }),
  bash_list_allowed: Object.freeze({
    description:
      'List all commands currently on the bash allowlist. Call this first before attempting bash_run to know what is permitted.',
    parameters: Object.freeze({}),
  }),
  bash_which: Object.freeze({
    description:
      'Resolve a binary name to its full path on PATH and check if it is on the allowlist.',
    parameters: Object.freeze({
      binary: 'Binary name to look up on PATH.',
    }),
  }),

  // -------------------------------------------------------------------------
  // tool_help
  // -------------------------------------------------------------------------
  tool_help: Object.freeze({
    description:
      'Look up the full help text of a wrapped CLI tool or one of its subcommands when the in-prompt summary is insufficient. ' +
      'Use section="recipes" to fetch the user-curated invocation recipes and section="manref" to get the manual-page pointer.',
    parameters: Object.freeze({
      tool: 'Name of the wrapped CLI tool to look up.',
      subcommand: 'Specific subcommand to retrieve help for.',
      section:
        'Which part of the document to return: "full" (default), "frontmatter", "synopsis", "recipes" (user-curated invocations), or "manref" (manual-page pointer).',
    }),
  }),

  // -------------------------------------------------------------------------
  // agt_* — agent-tools pack wrappers (vendored upstream).
  // Description strings duplicate the AGT_*_DESCRIPTION constants exported
  // from each wrapper module; the wrapper modules now re-export
  // BUILTIN_TOOL_PROMPTS[<name>].description so the constants are a thin
  // alias and there is exactly one literal per tool.
  // -------------------------------------------------------------------------
  agt_glob: Object.freeze({
    description:
      'Fast file-pattern matching across the working directory. ' +
      'Supports glob patterns like "**/*.ts" or "src/**/*.{ts,tsx}". ' +
      'Returns matching file paths sorted by modification time (newest first). ' +
      'Use this when you need to find files by name patterns; prefer running ' +
      'multiple searches in parallel when the queries are independent.',
    parameters: Object.freeze({
      pattern: 'The glob pattern to match files against (e.g. "**/*.ts").',
      path:
        'Optional directory to search in. Defaults to the working directory; ' +
        'resolved relative to it when not absolute.',
    }),
  }),
  agt_grep: Object.freeze({
    description:
      'Fast regex content search across the working directory. ' +
      'Supports full regex syntax (e.g. "log.*Error", "function\\\\s+\\\\w+"). ' +
      'Filter files by glob with the `include` parameter (e.g. "*.ts", "*.{ts,tsx}"). ' +
      'Returns matching files (or lines, depending on `outputMode`) sorted by mtime ' +
      'descending. Capped at 100 matches. Use when you need to find files containing ' +
      'specific patterns; prefer this over a manual `bash rg` invocation.',
    parameters: Object.freeze({
      pattern: 'Regular expression to search for inside file contents.',
      path:
        'Optional file or directory to search. Defaults to the working ' +
        'directory; resolved relative to it when not absolute.',
      include:
        'Optional include glob restricting which files are searched ' +
        '(e.g. "*.ts", "*.{ts,tsx}").',
      outputMode:
        'Result shape: "files_with_matches" (default) lists paths only, ' +
        '"count" reports per-file match counts, "content" emits ' +
        'path:line:matched-text per match.',
    }),
  }),
  agt_multiedit: Object.freeze({
    description:
      'Apply an ordered list of exact string replacements to one file atomically. ' +
      'All edits succeed or none are applied (the file on disk is left unchanged ' +
      'on any failure). Each edit is `{oldString, newString, replaceAll?}`; later ' +
      'edits operate on the result of earlier ones, so a rename can be followed ' +
      'by updates to text it introduced. Use this instead of multiple single-edit ' +
      'calls when the changes belong together; one diff, one permission check.',
    parameters: Object.freeze({
      filePath:
        'Path to the file to modify. Resolved against the working directory ' +
        'when not absolute.',
      edits: 'Non-empty list of edits applied in order.',
    }),
  }),
  agt_patch: Object.freeze({
    description:
      'Apply a `*** Begin Patch ... *** End Patch` envelope describing ' +
      'add/update/delete/move operations across one or more files. Each file ' +
      'section starts with `*** Add File: <path>`, `*** Delete File: <path>`, ' +
      'or `*** Update File: <path>` (optionally followed by `*** Move to: ' +
      '<path>`). Add/Update line bodies are prefixed with `+`/`-`. Pre-flight ' +
      'validates every hunk and every permission BEFORE any disk write, so ' +
      'partial application is impossible.',
    parameters: Object.freeze({
      patchText:
        'The full `*** Begin Patch ... *** End Patch` envelope describing ' +
        'add/update/delete/move operations across one or more files.',
    }),
  }),
  agt_todo_read: Object.freeze({
    description:
      "Read the agent's session todo list. Returns a human-readable checklist " +
      '— `[x]` for completed, `[~]` for in-progress, `[ ]` for pending — one ' +
      'item per line. Use this at the start of a multi-step task to recover ' +
      'the plan from a previous turn, or after completing a subtask to confirm ' +
      'what remains. The list is empty (returned as the literal string ' +
      '"(no todos)") until `agt_todo_write` has been called at least once. ' +
      'Inputs: none — call with `{}`.',
    parameters: Object.freeze({}),
  }),
  agt_todo_write: Object.freeze({
    description:
      'Replace the in-process todo list for the current session. ' +
      'Full-list-replace semantics: the supplied `todos` array becomes the ' +
      'new canonical list and the previous list is discarded entirely. ' +
      'Use proactively for multi-step tasks (3+ steps), tasks the user gave ' +
      'as a list, or after receiving new instructions. Each todo carries ' +
      '`{id, content, status: pending|in_progress|completed, priority?: ' +
      'high|medium|low}`. Keep at most ONE item `in_progress` at a time. ' +
      'Skip the todo list for trivial single-step or purely conversational ' +
      'requests.',
    parameters: Object.freeze({
      todos:
        'The complete updated todo list. Replaces any previously stored list ' +
        'in full. Pass an empty array to clear all todos.',
    }),
  }),

  // agt_web_* — first-party web wrappers (plan-011). The ONLY non-vendored
  // members of the agt_* pack. Descriptions/params are verbatim copies of
  // the former built-in web_search / web_fetch entries (incl. the "Never
  // fabricate URLs" guidance); the AGT_WEB_*_DESCRIPTION constants alias
  // these so there is exactly one literal per tool.
  agt_web_search: Object.freeze({
    description:
      'Search the public internet and return a list of results with titles, URLs, and snippets. ' +
      'Never fabricate URLs — only use URLs returned by this tool.',
    parameters: Object.freeze({
      query: 'Search query string.',
      top_k: 'Number of results to return (default 5).',
      site: 'Restrict search to this domain (e.g. "docs.python.org").',
      time_range: 'Time range filter, e.g. "day", "week", "month".',
    }),
  }),
  agt_web_fetch: Object.freeze({
    description:
      'Fetch a URL and return its content as readable text. HTML is stripped to plain text. ' +
      'Never fabricate URLs.',
    parameters: Object.freeze({
      url: 'URL to fetch. HTML is converted to readable text.',
      max_bytes: 'Maximum response size in bytes (default 1 MiB).',
    }),
  }),
});

/** All built-in tool names — convenient for iteration. */
export const BUILTIN_TOOL_NAMES: ReadonlyArray<string> = Object.freeze(
  Object.keys(BUILTIN_TOOL_PROMPTS),
);
