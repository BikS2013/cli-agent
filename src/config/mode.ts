/**
 * Agent mode knob (plan-015).
 *
 * `--mode <chat|basic|tool|composite>` is the single pinnable knob that
 * decides which tool GROUPS load for a session. It replaces the three
 * group-toggle flag pairs (`--builtin-tools/--no-builtin-tools`,
 * `--agent-tools/--no-agent-tools`, `--composites/--no-composites`), their
 * `CLI_AGENT_DISABLE_*` env vars, the `config.json` keys
 * (`builtinTools`/`composites`/`agentTools.enabled`), and the profile keys
 * (`tools.builtin`/`tools.composites`/`tools.agentTools`) — all hard-removed.
 *
 * The resolved mode expands into the three internal group booleans
 * (`AgentConfig.builtinTools` / `.composites` / `.agentTools.enabled`),
 * which remain the internal representation consumed by the tool catalog.
 * After plan-015 the mode mapping is the ONLY producer of that triple, so
 * exactly four combinations are reachable and {@link deriveModeFromGroups}
 * is an exact inverse.
 *
 * This module is dependency-free apart from the error hierarchy.
 */

import { UsageError } from '../errors.js';

/** The four agent modes, in ascending capability order. */
export const AGENT_MODES = ['chat', 'basic', 'tool', 'composite'] as const;

export type AgentMode = (typeof AGENT_MODES)[number];

/** Resolved group booleans a mode expands into. */
export interface ModeGroups {
  readonly builtinTools: boolean;
  readonly composites: boolean;
  readonly agentToolsEnabled: boolean;
}

/**
 * Migration hint appended to every legacy-surface rejection error
 * (removed flags, removed env vars, removed config.json keys, removed
 * profile keys). One shared constant so all error sites stay in lockstep.
 */
export const MODE_MIGRATION_HINT =
  'Tool groups are now controlled by the single mode knob: --mode <chat|basic|tool|composite> ' +
  '(env: CLI_AGENT_MODE; config.json: "mode"; profile: cliParams.mode; default: composite). ' +
  'Individual agt_* tools are toggled with --enable-tool <name> / --disable-tool <name> ' +
  '(env: CLI_AGENT_AGT_*; config.json: agentTools.tools.*).';

/** Type guard for the mode enum. */
export function isAgentMode(v: unknown): v is AgentMode {
  return typeof v === 'string' && (AGENT_MODES as readonly string[]).includes(v);
}

/**
 * Expand a mode into the three internal group booleans.
 *
 *   chat      → builtin OFF, composites OFF, agentTools OFF
 *   basic     → builtin OFF, composites OFF, agentTools ON
 *   tool      → builtin ON,  composites OFF, agentTools ON
 *   composite → builtin ON,  composites ON,  agentTools ON
 */
export function modeToGroups(mode: AgentMode): ModeGroups {
  switch (mode) {
    case 'chat':
      return { builtinTools: false, composites: false, agentToolsEnabled: false };
    case 'basic':
      return { builtinTools: false, composites: false, agentToolsEnabled: true };
    case 'tool':
      return { builtinTools: true, composites: false, agentToolsEnabled: true };
    case 'composite':
      return { builtinTools: true, composites: true, agentToolsEnabled: true };
  }
}

/**
 * Exact inverse of {@link modeToGroups}. The four combinations NOT produced
 * by the mapping are unreachable by construction (the mode knob is the only
 * producer of the triple after plan-015); hitting one means an internal
 * invariant was violated, so a plain Error is thrown rather than a typed
 * configuration error.
 */
export function deriveModeFromGroups(groups: ModeGroups): AgentMode {
  const { builtinTools, composites, agentToolsEnabled } = groups;
  if (!builtinTools && !composites && !agentToolsEnabled) return 'chat';
  if (!builtinTools && !composites && agentToolsEnabled) return 'basic';
  if (builtinTools && !composites && agentToolsEnabled) return 'tool';
  if (builtinTools && composites && agentToolsEnabled) return 'composite';
  throw new Error(
    `internal invariant violation: tool-group combination builtinTools=${builtinTools}, ` +
      `composites=${composites}, agentTools=${agentToolsEnabled} does not correspond to any ` +
      `agent mode (plan-015: the mode knob is the only producer of this triple)`,
  );
}

/**
 * Validate the raw `--mode` CLI value. `undefined` passes through (flag not
 * given → defer to the lower tiers); any other non-mode value raises
 * `UsageError` (exit 2) listing the valid values.
 */
export function parseModeFlag(raw: unknown): AgentMode | undefined {
  if (raw === undefined) return undefined;
  if (isAgentMode(raw)) return raw;
  throw new UsageError(
    `Invalid --mode value '${String(raw)}'. Valid modes: ${AGENT_MODES.join(', ')}.`,
    { flag: '--mode', value: raw },
  );
}
