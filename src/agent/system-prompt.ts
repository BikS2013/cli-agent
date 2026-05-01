/**
 * System prompt builder for cli-agent.
 *
 * The base prompt text is no longer hard-coded into runtime: it lives on
 * disk at `~/.tool-agents/cli-agent/capabilities/system-prompt.md` and is
 * loaded into `cfg.systemPromptPath` by `loadAgentConfig`. The constant
 * below (`BUILTIN_DEFAULT_SYSTEM_PROMPT`) is used ONLY by the bootstrap
 * routine in `bootstrapAgentDir` to seed that file on first run, so the
 * user has a starting point they can edit without rebuilding the binary.
 *
 * It is NOT a runtime fallback. If the file the user selected (or the
 * default file at the path above) is unreadable, `loadAgentConfig`
 * raises a `UsageError` — see the no-fallback rule in CLAUDE.md.
 */

import fsp from 'node:fs/promises';

import { buildAgentToolsPromptBlock } from './tools/agent-tools/prompt-block.js';
import type { AgentToolsCatalogMeta } from './tools/agent-tools/group-builder.js';

export const BUILTIN_DEFAULT_SYSTEM_PROMPT = `You are cli-agent, a general-purpose assistant that helps the user accomplish tasks by
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
  argument.`;

/**
 * Composition order:
 *   1. baseText       — full base prompt loaded from cfg.systemPromptPath
 *   2. capabilitiesSection (if non-empty) — appended after a blank line
 *   3. agent-tools block (if `agentToolsMeta` registers any tool) —
 *      derived via `buildAgentToolsPromptBlock(agentToolsMeta)` and
 *      appended verbatim. The block is self-framed (leading + trailing
 *      `\n`), so concatenation does NOT add extra glue. When the block
 *      is empty (umbrella off OR every per-tool flag off), the prompt
 *      is BYTE-IDENTICAL to the pre-integration prompt.
 *   4. customSystemText (if provided)     — under "## User-provided instructions"
 *
 * `customSystemText` is the optional addendum supplied by `--system` /
 * `--system-file`; it does not replace the base, only appends.
 */
export async function buildSystemPrompt(
  baseText: string,
  capabilitiesSection: string,
  customSystemText?: string,
  agentToolsMeta?: AgentToolsCatalogMeta,
): Promise<string> {
  let prompt = baseText;

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
 * Composition: <base on disk> + capabilitiesSection + agent-tools block
 * (derived from `agentToolsMeta` when provided) + (file append + "\n\n" +
 * inline append).
 *
 * `agentToolsMeta` is optional for backward compatibility: callers that
 * have not yet been updated can omit it and receive the pre-integration
 * prompt verbatim. New entry points should always pass the meta returned
 * by `buildToolCatalog` so the prompt and the registered toolset stay in
 * lockstep.
 */
export async function buildSystemPromptForCfg(
  cfg: {
    readonly systemPromptPath: string;
    readonly systemAppendText: string | undefined;
    readonly systemAppendFile: string | undefined;
  },
  capabilitiesSection: string,
  agentToolsMeta?: AgentToolsCatalogMeta,
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
  return buildSystemPrompt(baseText, capabilitiesSection, custom, agentToolsMeta);
}
