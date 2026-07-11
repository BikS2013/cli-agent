/**
 * CLI flag mapper for the agent-tools pack (plan-015).
 *
 * Lives in its own module so tests can import it WITHOUT triggering the
 * Commander parse side-effect at the bottom of `src/cli.ts` (which would
 * call `process.exit` against vitest's argv).
 *
 * The mapper is the single CLI-tier gatekeeper for the generic per-tool
 * pair `--enable-tool <name>` / `--disable-tool <name>` (which replaced
 * the 26 per-tool `--enable-agt-*`/`--disable-agt-*` flags): unknown-name
 * validation and conflict detection (the same tool named in both flags)
 * happen here and surface as `UsageError` (exit code 2). The remaining
 * tiers of the per-tool chain (env `CLI_AGENT_AGT_*` > config.json
 * `agentTools.tools.*` > default) are then completed inside
 * `loadAgentConfig` via the `resolveAgentTools` helper.
 *
 * Whether the pack loads AT ALL is no longer a CLI-tier concern: the
 * umbrella is decided by the `--mode` knob (see `src/config/mode.ts`).
 */

import { UsageError } from './errors.js';
import type { AgentCliFlags } from './config/agent-config.js';

/**
 * Canonical registered tool name → per-tool config key
 * (`AgentConfig.agentTools.tools.*`). The keys of this map are the ONLY
 * names `--enable-tool`/`--disable-tool` accept; they mirror the
 * `AGT_*_NAME` constants exported by the wrappers under
 * `src/agent/tools/agent-tools/` (cross-checked by the mapper's spec so
 * canonical-name drift is impossible).
 */
export const AGT_TOOL_NAME_TO_KEY = Object.freeze({
  agt_glob: 'glob',
  agt_grep: 'grep',
  agt_multiedit: 'multiedit',
  agt_patch: 'patch',
  agt_todo_read: 'todoRead',
  agt_todo_write: 'todoWrite',
  agt_web_search: 'webSearch',
  agt_web_fetch: 'webFetch',
  agt_file_read: 'fileRead',
  agt_file_list: 'fileList',
  agt_file_write: 'fileWrite',
  agt_file_edit: 'fileEdit',
  agt_file_append: 'fileAppend',
} as const);

export type AgtToolName = keyof typeof AGT_TOOL_NAME_TO_KEY;

function assertKnownToolName(
  raw: string,
  flag: '--enable-tool' | '--disable-tool',
): AgtToolName {
  if (Object.prototype.hasOwnProperty.call(AGT_TOOL_NAME_TO_KEY, raw)) {
    return raw as AgtToolName;
  }
  throw new UsageError(
    `Unknown tool name '${raw}' for ${flag}. Valid names: ` +
      `${Object.keys(AGT_TOOL_NAME_TO_KEY).join(', ')}.`,
    { flag, value: raw },
  );
}

/**
 * Translate Commander's parsed options into the partial
 * `AgentCliFlags['agentTools']` shape consumed by `loadAgentConfig`.
 *
 * `--enable-tool` and `--disable-tool` are repeatable options collected
 * into string arrays (Commander collector, same pattern as `--tool`).
 * Duplicates within one array are harmless (idempotent). Returns
 * `undefined` when neither flag was passed at all, so the per-tool
 * resolver falls through to env / config / default cleanly. Throws
 * `UsageError` (exit code 2) on an unknown tool name or when the same
 * name appears in both flags — STRICT, no silent precedence between
 * conflicting CLI flags.
 *
 * NOTE: mutation gating is untouched by this mapper — enabling a mutating
 * tool (e.g. `--enable-tool agt_patch`) still requires `--allow-mutations`
 * for the wrapper to register (gated downstream in the catalog builder).
 */
export function mapAgentToolFlags(
  opts: Record<string, unknown>,
): AgentCliFlags['agentTools'] | undefined {
  const enableRaw = opts['enableTool'];
  const disableRaw = opts['disableTool'];
  const enables = Array.isArray(enableRaw) ? enableRaw.map(String) : [];
  const disables = Array.isArray(disableRaw) ? disableRaw.map(String) : [];
  if (enables.length === 0 && disables.length === 0) return undefined;

  type ToolKey = (typeof AGT_TOOL_NAME_TO_KEY)[AgtToolName];
  const tools: Partial<Record<ToolKey, boolean>> = {};
  const enabledNames = new Set<AgtToolName>();

  for (const raw of enables) {
    const name = assertKnownToolName(raw, '--enable-tool');
    enabledNames.add(name);
    tools[AGT_TOOL_NAME_TO_KEY[name]] = true;
  }
  for (const raw of disables) {
    const name = assertKnownToolName(raw, '--disable-tool');
    if (enabledNames.has(name)) {
      throw new UsageError(
        `Conflicting flags: tool '${name}' is named in both --enable-tool and --disable-tool.`,
        { conflict: [`--enable-tool ${name}`, `--disable-tool ${name}`] },
      );
    }
    tools[AGT_TOOL_NAME_TO_KEY[name]] = false;
  }

  return { tools };
}
