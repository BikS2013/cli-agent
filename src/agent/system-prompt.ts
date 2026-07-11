/**
 * System prompt builder for cli-agent.
 *
 * The base prompt text is no longer hard-coded into runtime: it lives on
 * disk at `~/.tool-agents/cli-agent/capabilities/system-prompt.md` and is
 * loaded into `cfg.systemPromptPath` by `loadAgentConfig`. The constant
 * `BUILTIN_DEFAULT_SYSTEM_PROMPT` is used ONLY by the bootstrap routine in
 * `bootstrapAgentDir` to seed that file on first run, so the user has a
 * starting point they can edit without rebuilding the binary.
 *
 * The base prompt is deliberately SLIM and tool-agnostic (identity +
 * generic conduct). The built-in cross-cutting toolkit's instructions
 * (bash_run framing, CORE RULES, OUT-OF-SCOPE, the available-tools list)
 * are NOT baked into the base; they are injected at runtime by
 * `buildBuiltinToolsPromptBlock`. The umbrella toggle (`cfg.builtinTools
 * !== false`) suppresses the whole block, mirroring the `agt_*` agent-tools
 * block and keeping the prompt coherent with `--no-builtin-tools` (plan-008),
 * which drops the built-in tool schemas — so the model is no longer told
 * about tools it cannot call. Within the block, the prose describes EXACTLY
 * the registered built-in tools (plan-010): the bash_run framing appears
 * only when `bash_run` is bound (non-empty allowlist) and the mutating-file
 * tools only when `file_write`/`file_edit`/`file_append` are bound
 * (--allow-mutations), so the prompt never over-promises vs the bound
 * schemas.
 *
 * It is NOT a runtime fallback. If the file the user selected (or the
 * default file at the path above) is unreadable, `loadAgentConfig`
 * raises a `UsageError` — see the no-fallback rule in CLAUDE.md.
 */

import fsp from 'node:fs/promises';

import { buildAgentToolsPromptBlock } from './tools/agent-tools/prompt-block.js';
import type { AgentToolsCatalogMeta } from './tools/agent-tools/group-builder.js';

/**
 * Prior verbatim default base prompts, kept ONLY so `bootstrapAgentDir`
 * can detect an unmodified seeded `system-prompt.md` (byte-exact match)
 * and upgrade it in place to the current slim {@link BUILTIN_DEFAULT_SYSTEM_PROMPT}.
 *
 * It is an array so future default revisions can be appended: any entry
 * that byte-equals the on-disk file marks it as an unmodified prior
 * default and therefore safe to overwrite. A file that matches NONE of
 * these entries is treated as user-customized and left untouched.
 *
 * Index 0 is the pre-plan-009 default (the built-in tool instructions
 * were baked into the base prompt; plan-009 moved them into the runtime
 * conditional built-in-tools block — see {@link buildBuiltinToolsPromptBlock}).
 * The string below is byte-identical to the prompt that earlier builds
 * seeded to disk.
 */
export const LEGACY_DEFAULT_SYSTEM_PROMPTS: readonly string[] = [
  `You are cli-agent, a general-purpose assistant that helps the user accomplish tasks by
invoking external CLI tools on their local machine. You do this through the bash_run tool,
which executes only the specific binaries the user has allowed.

CORE RULES
1. Before attempting bash_run, call bash_list_allowed to see which commands are permitted.
   If the command you need is not on the allowlist, tell the user which binary would help
   instead of attempting a workaround.
2. Use the capability documents embedded in this prompt to understand each tool's subcommand
   surface. If you need more detail, call tool_help before guessing.
3. bash_run requires confirmed: true. Never call it speculatively. Explain what you are
   about to run and why before calling it.
4. Treat command output as read-only evidence. Never paste captured tokens, API keys,
   or credentials back into a later tool argument or into your reply.
5. If a tool returns an error (JSON with an "error" field), read the code and message,
   then either retry with corrected arguments, ask the user for clarification, or explain
   what failed plainly.
6. When a tool returns "__truncated": true, the output was cut to fit the context budget.
   Narrow your request (fewer results, smaller page, specific subcommand) and retry.
7. Keep responses concise. Use plain prose or a short bullet list. Never include raw
   credentials, bearer tokens, or long base64 strings in your reply.
8. NEVER invent URLs that did not appear in a web_search or web_fetch result.
   Cite sources by URL when you reference them.

OUT-OF-SCOPE
- You cannot execute arbitrary shell scripts or use shell features (pipes, redirects,
  globbing) — each bash_run call is a single binary with explicit arguments.
- You cannot modify files unless the user has passed --allow-mutations.
- You cannot access the internet beyond the configured web_search/web_fetch backend.

You also have three general-purpose tools that exist on every assistant in this family:

- file_read / file_list: read or enumerate plain-text files on disk inside the working root.
  Use them when you need to inspect a config file, log file, or piece of documentation that
  the wrapped CLI does not expose through its own commands. Do NOT use file_edit / file_write /
  file_append unless the user has asked for a file change.
- web_search / web_fetch: search the public internet and read pages. Use them only when the
  user's question depends on information that is not in the wrapped CLI's surface (e.g. "what
  does this error code mean upstream?", "what is the latest release of <library>"). Never
  fabricate URLs; if a search returns no relevant results, say so plainly. Quote sources by
  URL when you cite them.
- bash_list_allowed / bash_which / bash_run: run short, allow-listed local commands and inspect
  their stdout/stderr to decide your next step. Always call bash_list_allowed first to see what
  is permitted in this session — do NOT guess. If the command you need is not on the allowlist,
  tell the user which entry would unlock the answer instead of attempting a workaround.
  bash_run requires user confirmation; never call it speculatively. Treat output as read-only
  evidence: never paste captured tokens or secrets back into a later prompt or another tool
  argument.`,
];

/**
 * Slim, tool-agnostic agent identity + truly-generic conduct.
 *
 * This is the base prompt seeded to
 * `~/.tool-agents/cli-agent/capabilities/system-prompt.md` on first run.
 * It deliberately says NOTHING about specific tools (bash_run / file_* /
 * tool_help / --allow-mutations). The built-in toolkit's
 * instructions are injected at runtime by
 * {@link buildBuiltinToolsPromptBlock} ONLY when the built-in tools are
 * actually loaded (`cfg.builtinTools !== false`), mirroring how the
 * agent-tools (`agt_*`) block is gated. This keeps the prompt coherent
 * with `--no-builtin-tools`, which drops the built-in tool schemas.
 *
 * It is NOT a runtime fallback. If the file the user selected (or the
 * default file at the path above) is unreadable, `loadAgentConfig`
 * raises a `UsageError` — see the no-fallback rule in CLAUDE.md.
 */
export const BUILTIN_DEFAULT_SYSTEM_PROMPT = `You are cli-agent, a general-purpose assistant that helps the user accomplish tasks by invoking external CLI tools on their local machine.

Keep responses concise: plain prose or a short bullet list. Never include raw credentials, bearer tokens, API keys, or long base64 strings in your reply.`;

/**
 * Presence of the runtime-gated built-in tool groups, derived from the
 * actually-registered tool NAMES (plan-010). This makes the `## Built-in
 * tools` prompt block describe EXACTLY the tools bound to the model — not a
 * static superset — so the prompt prose and the bound tool schemas cannot
 * drift across the two gates that govern these tools:
 *
 *   - `builtinTools`  — the umbrella toggle (`cfg.builtinTools !== false`,
 *     plan-008). When `false`, no built-in tool schemas are bound at all,
 *     so the whole block is suppressed.
 *   - `bashRun`       — whether `bash_run` is registered. Since 2026-07-04
 *     it is bound whenever the built-in group is on (an empty allowlist
 *     means UNRESTRICTED, no longer "unbound"); a profile deny can still
 *     remove it (`registry.ts`).
 *
 * (File operations are no longer built-in — plan-012 moved them into the
 * agt_ pack as `agt_file_*`, so there is no longer a `mutatingFile` built-in
 * gate. The built-in toolkit is now bash_* + tool_help only.)
 *
 * Deriving from the registered names also respects a profile `deny` of a
 * built-in tool, because `buildSystemPromptForCfg` is handed the
 * post-scoping `tools` array.
 */
export interface BuiltinToolsPresence {
  /** Umbrella toggle — `cfg.builtinTools !== false`. */
  readonly builtinTools: boolean;
  /** `bash_run` is registered (built-in group on; a profile deny can still
   * remove it). Since 2026-07-04 an empty allowlist no longer suppresses
   * the tool — it means UNRESTRICTED execution (see `bashUnrestricted`). */
  readonly bashRun: boolean;
  /** No allowlist entry is configured — bash_run may execute ANY binary on
   * PATH (fail-open by explicit user decision, 2026-07-04). Optional for
   * fixture compatibility; omitted/false ⇒ restricted (allow-listed) prose. */
  readonly bashUnrestricted?: boolean;
}

/**
 * Self-framed leading glue for the `## Built-in tools` section. Leading
 * `\n\n` keeps concatenation with the base prompt clean (no extra glue at
 * the call site), matching the prior single-string built-in block.
 */
const BUILTIN_BLOCK_HEADER = `

## Built-in tools

You have a set of built-in tools this session; their JSON schemas are bound to you separately. Use them as described below.`;

/**
 * Command-execution framing + the two bash_run-specific CORE RULES.
 * Included ONLY when `bash_run` is registered. Two variants: restricted
 * (an allowlist is configured) and unrestricted (no allowlist configured —
 * fail-open, 2026-07-04).
 */
const BUILTIN_BLOCK_BASHRUN_INTRO = `

You act on the user's machine through the bash_run tool, which executes only the specific allow-listed binaries the user has permitted — never arbitrary shell.`;

/**
 * Unrestricted variant: no allowlist is configured, so any binary on PATH
 * may be executed. The framing makes the breadth explicit AND instructs
 * restraint — the power is the user's deliberate choice, not an invitation
 * to run destructive commands.
 */
const BUILTIN_BLOCK_BASHRUN_UNRESTRICTED_INTRO = `

You act on the user's machine through the bash_run tool. No command allowlist is configured this session, so ANY binary on PATH may be executed (single binary + explicit arguments — never arbitrary shell). Use this breadth conservatively: prefer read-only commands, and never run a destructive or irreversible command unless the user explicitly asked for it.`;

/**
 * Stated when `bash_run` is NOT registered (built-in group off for this
 * tool, e.g. a profile `deny`; since 2026-07-04 an empty allowlist no
 * longer unbinds it). Replaces the bash_run framing AND omits the two
 * bash_run CORE RULES.
 *
 * Deliberately does NOT name the command-execution tool, so the block never
 * mentions a tool the model cannot call (the registered read-only bash
 * inspection tools are still described in the available-tools list below).
 */
const BUILTIN_BLOCK_NO_BASHRUN_INTRO = `

No local commands are allow-listed in this session, so command execution is not available — you cannot run binaries on the user's machine. If a task needs one, tell the user which binary to allow-list.`;

/** The two bash_run-specific CORE RULES (only when bashRun, restricted). */
const BUILTIN_BLOCK_BASHRUN_RULES = `
1. Before attempting bash_run, call bash_list_allowed to see which commands are permitted.
   If the command you need is not on the allowlist, tell the user which binary would help
   instead of attempting a workaround.
2. bash_run requires confirmed: true. Never call it speculatively. Explain what you are
   about to run and why before calling it.`;

/** The two bash_run-specific CORE RULES (only when bashRun, UNRESTRICTED). */
const BUILTIN_BLOCK_BASHRUN_UNRESTRICTED_RULES = `
1. No allowlist is configured — any binary on PATH is executable. Choose the least
   powerful command that answers the question, prefer read-only invocations, and never
   run a destructive or irreversible command unless the user explicitly asked for it.
2. bash_run requires confirmed: true. Never call it speculatively. Explain what you are
   about to run and why before calling it.`;

/**
 * General CORE RULES — capability-docs/tool_help, read-only-evidence/
 * no-secret-echo, error-JSON handling, `__truncated` handling. Always
 * present (when the umbrella is on). Web/URL guidance is no longer here:
 * web moved to the agent-tools pack (agt_web_search / agt_web_fetch,
 * plan-011), and the "never fabricate URLs" guidance now rides on those
 * tools' descriptions in the agent-tools block.
 */
const BUILTIN_BLOCK_GENERAL_RULES = `
- Use the capability documents embedded in this prompt to understand each tool's subcommand
  surface. If you need more detail, call tool_help before guessing.
- Treat command and file output as read-only evidence. Never paste captured tokens, API keys,
  or credentials back into a later tool argument or into your reply.
- If a tool returns an error (JSON with an "error" field), read the code and message,
  then either retry with corrected arguments, ask the user for clarification, or explain
  what failed plainly.
- When a tool returns "__truncated": true, the output was cut to fit the context budget.
  Narrow your request (fewer results, smaller page, specific subcommand) and retry.`;

/**
 * Injected when a session has ZERO registered tools (`--mode chat`
 * (plan-015), or a profile scoped the catalog to nothing). The slim base
 * identity still says
 * the agent "accomplishes tasks by invoking external CLI tools", but no tools
 * are bound this turn — without this notice the model role-plays a tool-user
 * and FABRICATES tool output (e.g. a directory listing it never ran). The
 * notice tells the model it is toolless and forbids inventing results.
 * Self-framed with a leading `\n\n` so it concatenates cleanly after the base.
 */
const NO_TOOLS_BLOCK = `

## No tools are available this session

No tools are enabled, so you have NO way to act on the user's machine or the outside world: you cannot run commands, read or write files, list directories, search or fetch from the internet, or execute anything. This turn you are a plain conversational assistant.

NEVER fabricate, guess, simulate, or role-play the result of an action you cannot perform — do not invent command output, directory listings, file contents, process lists, or URLs, and never claim you ran something. If a request needs a tool, say plainly that no tools are enabled in this session and that the user can re-run cli-agent with --mode composite or --mode tool (adding --allow-mutations or a bash allowlist where needed) to enable them. You can still answer from your own knowledge and help the user reason about what to do.`;

/**
 * Render the `## Built-in tools` system-prompt block, describing EXACTLY
 * the registered built-in tools (plan-010). After plan-012 the built-in
 * toolkit is bash_* + tool_help only — file operations moved to the agt_
 * pack (`agt_file_*`) and are documented by the agent-tools block instead.
 *
 * @param p the resolved {@link BuiltinToolsPresence} — umbrella toggle plus
 *          the `bashRun` presence flag derived from the registered tool
 *          names.
 * @returns `''` when `!p.builtinTools` (the `--no-builtin-tools` case — no
 *          built-in tool schemas are bound, so the prompt omits every
 *          built-in tool instruction). Otherwise the self-framed block
 *          (leading `\n\n`), assembled from composable, gated sections so
 *          the prose matches the bound schemas across the single bashRun gate.
 */
export function buildBuiltinToolsPromptBlock(p: {
  builtinTools: boolean;
  bashRun: boolean;
  bashUnrestricted?: boolean;
}): string {
  if (!p.builtinTools) return '';

  const unrestricted = p.bashRun && p.bashUnrestricted === true;

  let block = BUILTIN_BLOCK_HEADER;

  // Command execution: bash_run framing (+ its two CORE RULES) only when
  // bash_run is actually bound; otherwise an explicit "not available" note.
  // The framing adapts to the allowlist state (restricted vs unrestricted).
  block += p.bashRun
    ? (unrestricted ? BUILTIN_BLOCK_BASHRUN_UNRESTRICTED_INTRO : BUILTIN_BLOCK_BASHRUN_INTRO)
    : BUILTIN_BLOCK_NO_BASHRUN_INTRO;

  // CORE RULES: the two bash_run-specific rules (only when bashRun) followed
  // by the general rules (always). Numbered bash_run rules lead; the general
  // rules are bulleted so the list reads coherently with or without them.
  block += '\n\nCORE RULES';
  if (p.bashRun) {
    block += unrestricted
      ? BUILTIN_BLOCK_BASHRUN_UNRESTRICTED_RULES
      : BUILTIN_BLOCK_BASHRUN_RULES;
  }
  block += BUILTIN_BLOCK_GENERAL_RULES;

  // Available tools — the built-in toolkit is now bash_* + tool_help only
  // (file operations moved to the agt_ pack, plan-012). Describe the bash
  // tools (adapted to whether bash_run is bound and the allowlist state)
  // and tool_help.
  block += `

Available tools:`;
  if (p.bashRun && unrestricted) {
    block += `
- bash_list_allowed / bash_which / bash_run: run local commands and inspect their stdout/stderr
  to decide your next step. No allowlist is configured — any binary on PATH may be executed;
  bash_which resolves where a binary lives. bash_run requires user confirmation; never call it
  speculatively. Treat output as read-only evidence: never paste captured tokens or secrets back
  into a later prompt or another tool argument.`;
  } else if (p.bashRun) {
    block += `
- bash_list_allowed / bash_which / bash_run: run allow-listed local commands and inspect their
  stdout/stderr to decide your next step. Always call bash_list_allowed first to see what is
  permitted in this session — do NOT guess. bash_run requires user confirmation; never call it
  speculatively. Treat output as read-only evidence: never paste captured tokens or secrets back
  into a later prompt or another tool argument.`;
  } else {
    block += `
- bash_list_allowed / bash_which: inspect which local commands are allow-listed (currently none)
  and resolve binary paths on PATH.`;
  }
  block += `
- tool_help: look up the full help text of a wrapped CLI tool or subcommand when the in-prompt
  summary is insufficient.`;

  // OUT-OF-SCOPE — only the shell-features caveat, and only when bash_run is
  // bound. When bash_run is absent the no-bashRun intro already states that
  // command execution is unavailable, so there is nothing left to scope. File
  // operations are no longer built-in (plan-012), so no file caveat here.
  if (p.bashRun) {
    block += `

OUT-OF-SCOPE
- You cannot execute arbitrary shell scripts or use shell features (pipes, redirects,
  globbing) — each bash_run call is a single binary with explicit arguments.`;
  }

  return block;
}

/**
 * Composition order:
 *   1. baseText       — full base prompt loaded from cfg.systemPromptPath
 *   2. built-in-tools block (if `builtinPresence.builtinTools !== false`) —
 *      derived via `buildBuiltinToolsPromptBlock(builtinPresence)`. Self-
 *      framed (leading `\n\n`), describing EXACTLY the registered built-in
 *      tools: the bash_run framing + its two CORE RULES appear only when
 *      `bashRun` is set, and the general CORE RULES + the bash inspection
 *      tools + tool_help are always present (file operations moved to the
 *      agt_ pack, plan-012). Injected right after the base (the core tool framing) and
 *      BEFORE the wrapped-CLI capabilities. When `builtinTools === false`
 *      the block is `''`, so the prompt omits every built-in tool
 *      instruction — coherent with `--no-builtin-tools`, which also drops
 *      the built-in tool schemas.
 *   3. capabilitiesSection (if non-empty) — appended after a blank line
 *   4. agent-tools block (if `agentToolsMeta` registers any tool) —
 *      derived via `buildAgentToolsPromptBlock(agentToolsMeta)` and
 *      appended verbatim. The block is self-framed (leading + trailing
 *      `\n`), so concatenation does NOT add extra glue. When the block
 *      is empty (umbrella off OR every per-tool flag off), no agent-tools
 *      section is added.
 *   5. customSystemText (if provided)     — under "## User-provided instructions"
 *
 * `customSystemText` is the optional addendum supplied by `--system` /
 * `--system-file`; it does not replace the base, only appends.
 *
 * `builtinPresence` defaults to `{ builtinTools: true, bashRun: true }` for
 * backward compatibility: callers that have not been updated (and tests)
 * receive today's full built-in-tools block.
 */
export async function buildSystemPrompt(
  baseText: string,
  capabilitiesSection: string,
  customSystemText?: string,
  agentToolsMeta?: AgentToolsCatalogMeta,
  builtinPresence: BuiltinToolsPresence = {
    builtinTools: true,
    bashRun: true,
  },
  noToolsAvailable = false,
): Promise<string> {
  let prompt = baseText;

  // Toolless-session guard: when NO tools are registered, the tool blocks
  // below are all empty, so the prompt would be just the base identity
  // ("...by invoking external CLI tools..."). Inject an explicit no-tools /
  // anti-fabrication notice right after the base so the model does not invent
  // command/file output. Placed before the (empty) tool blocks + capabilities.
  if (noToolsAvailable) {
    prompt += NO_TOOLS_BLOCK;
  }

  // `buildBuiltinToolsPromptBlock` returns '' when builtinTools === false
  // (matching --no-builtin-tools, which also drops the built-in schemas)
  // or the self-framed block (leading '\n\n') otherwise, assembled from the
  // bashRun presence flag so it matches the bound schemas.
  const builtinBlock = buildBuiltinToolsPromptBlock(builtinPresence);
  if (builtinBlock.length > 0) {
    prompt += builtinBlock;
  }

  if (capabilitiesSection) {
    prompt += '\n\n' + capabilitiesSection;
  }

  if (agentToolsMeta) {
    // `buildAgentToolsPromptBlock` returns '' when nothing is registered
    // (preserving byte-stability with pre-integration prompts) or a
    // self-framed block (leading + trailing '\n') otherwise.
    const block = buildAgentToolsPromptBlock(agentToolsMeta);
    if (block.length > 0) {
      prompt += block;
    }
  }

  if (customSystemText) {
    prompt += '\n\n## User-provided instructions\n\n' + customSystemText;
  }

  return prompt;
}

export async function loadSystemPromptFile(filePath: string): Promise<string> {
  return fsp.readFile(filePath, 'utf8');
}

/**
 * Convenience composer used by every entry point that calls
 * `buildSystemPrompt`. Loads the base prompt from `cfg.systemPromptPath`,
 * loads the append-file (if any), concatenates with the inline append
 * text (if any), and returns the assembled prompt.
 *
 * Composition: <base on disk> + built-in-tools block (when
 * `cfg.builtinTools !== false`) + capabilitiesSection + agent-tools block
 * (derived from `agentToolsMeta` when provided) + (file append + "\n\n" +
 * inline append).
 *
 * The built-in-tools block describes EXACTLY the registered built-in tools
 * (plan-010): presence is derived from `registeredTools` — the post-scoping
 * tool array from `buildToolCatalog` — so the `bash_run` framing appears
 * only when `bash_run` is bound (non-empty allowlist) and the mutating-file
 * clause only when `file_write`/`file_edit`/`file_append` is bound
 * (--allow-mutations), and a profile `deny` of a built-in is reflected too.
 * `cfg.builtinTools` is the umbrella: when `false`, no built-in schemas are
 * bound and the block is omitted entirely.
 *
 * `agentToolsMeta` is optional for backward compatibility: callers that
 * have not yet been updated can omit it and receive the pre-integration
 * prompt verbatim. New entry points should always pass the meta returned
 * by `buildToolCatalog` so the prompt and the registered toolset stay in
 * lockstep.
 *
 * `registeredTools` is the same `tools` array `buildToolCatalog` returns
 * alongside `agentToolsMeta`; every entry point already has it in scope.
 */
export async function buildSystemPromptForCfg(
  cfg: {
    readonly systemPromptPath: string;
    readonly systemAppendText: string | undefined;
    readonly systemAppendFile: string | undefined;
    readonly builtinTools: boolean;
    /** Optional (fixture compatibility): resolved bash allowlist. An empty
     * list means UNRESTRICTED bash (2026-07-04) and switches the bash_run
     * prompt prose to the unrestricted variant. Omitted ⇒ restricted prose. */
    readonly bash?: { readonly allow: readonly string[] };
  },
  capabilitiesSection: string,
  agentToolsMeta?: AgentToolsCatalogMeta,
  registeredTools: ReadonlyArray<{ name: string }> = [],
): Promise<string> {
  const baseText = await loadSystemPromptFile(cfg.systemPromptPath);
  let custom: string | undefined;
  if (cfg.systemAppendFile && cfg.systemAppendText) {
    const fileText = await loadSystemPromptFile(cfg.systemAppendFile);
    custom = fileText + '\n\n' + cfg.systemAppendText;
  } else if (cfg.systemAppendFile) {
    custom = await loadSystemPromptFile(cfg.systemAppendFile);
  } else if (cfg.systemAppendText) {
    custom = cfg.systemAppendText;
  }

  // Derive the built-in-tools presence from the actually-registered tool
  // NAMES so the prompt prose matches the bound schemas (plan-010). The
  // umbrella (`cfg.builtinTools`) suppresses the whole block; the `bashRun`
  // flag gates the bash_run framing. (File operations are no longer built-in
  // — plan-012 moved them to the agt_ pack as agt_file_*, so there is no
  // longer a mutating-file built-in gate to derive.)
  const names = new Set(registeredTools.map((t) => t.name));
  const builtinPresence: BuiltinToolsPresence = {
    builtinTools: cfg.builtinTools !== false,
    bashRun: names.has('bash_run'),
    // Empty allowlist ⇒ unrestricted bash (2026-07-04): the prompt framing
    // switches to the any-binary-on-PATH variant with restraint guidance.
    bashUnrestricted: (cfg.bash?.allow?.length ?? 1) === 0,
  };

  // Toolless-session guard: zero registered tools (every group disabled, or a
  // profile scoped the catalog to nothing) means the model has no way to act.
  // Inject the no-tools / anti-fabrication notice so it does not invent
  // command or file output (the catalog itself already warns the user on
  // stderr — this mirrors that warning into the prompt the model sees).
  const noToolsAvailable = registeredTools.length === 0;

  return buildSystemPrompt(
    baseText,
    capabilitiesSection,
    custom,
    agentToolsMeta,
    builtinPresence,
    noToolsAvailable,
  );
}
