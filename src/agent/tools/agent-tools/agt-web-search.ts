/**
 * `agt_web_search` — LangChain `DynamicStructuredTool` for public-internet
 * search, re-homed from the former built-in `web_search` into the
 * agent-tools (`agt_*`) pack (plan-011).
 *
 * Unlike the vendored-upstream wrappers (`agt_glob` / `agt_grep` / …), this
 * tool is a FIRST-PARTY member of the `agt_` namespace: there is no
 * upstream `agent-tools` source for it. It REUSES the existing cli-agent
 * web backend (`../web/backends/registry.js`, `getWebBackend`) verbatim —
 * the backend was NOT moved or duplicated.
 *
 * Read-only. Governed by `--agent-tools` (umbrella) + the per-tool
 * `--enable/--disable-agt-web-search` flag (default ON). NOT affected by
 * `--no-builtin-tools`.
 *
 * The body is the former `createWebSearchTool` verbatim, with the name and
 * prompt key changed to `agt_web_search`: it keeps `getWebBackend(cfg)`, the
 * per-session request budget (`WEB_SEARCH_MAX_REQUESTS`, default 50) with
 * `E_SEARCH_BUDGET_EXCEEDED`, `mergeProfileToolArgs`, and `handleToolError`.
 */

import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { getWebBackend } from '../web/backends/registry.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { WebError } from '../../../errors.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import {
  getToolDescription,
  getParamDescription,
  type OverlayRegistry,
} from '../tool-prompt-overlay.js';
import { mergeProfileToolArgs, type ProfileToolArgsConfigurable } from '../profile-tool-args.js';

/** LangChain-visible tool name. Stable across catalog / prompt-block. */
export const AGT_WEB_SEARCH_NAME = 'agt_web_search' as const;

/**
 * Description handed both to LangChain (`DynamicStructuredTool.description`)
 * and to the agent-tools prompt-block assembler. Sourced from the canonical
 * `BUILTIN_TOOL_PROMPTS` registry so there is a SINGLE literal per tool
 * (incl. the "Never fabricate URLs" guidance).
 */
export const AGT_WEB_SEARCH_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_WEB_SEARCH_NAME]!.description;

/** Dependency bag injected by U5's catalog builder. */
export interface AgtWebSearchDeps {
  cfg: AgentConfig;
  /** Per-session request budget, shared with `agt_web_fetch`. */
  requestBudget: { remaining: number };
  /** Optional overlay registry; when present, user-edited descriptions
   * take precedence over the canonical built-in. */
  overlays?: OverlayRegistry;
}

/** Build the LangChain tool. */
export function buildAgtWebSearchTool(deps: AgtWebSearchDeps): DynamicStructuredTool {
  const { cfg, requestBudget } = deps;
  const maxRequests = cfg.webSearch.maxRequests;
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_WEB_SEARCH_NAME]!;
  const reg = deps.overlays ?? cfg.toolPromptOverlays;
  const schema = z.object({
    query: z.string().min(1).describe(
      getParamDescription(reg, AGT_WEB_SEARCH_NAME, 'query', BUILTIN.parameters['query']!),
    ),
    top_k: z.number().int().positive().optional().describe(
      getParamDescription(reg, AGT_WEB_SEARCH_NAME, 'top_k', BUILTIN.parameters['top_k']!),
    ),
    site: z.string().optional().describe(
      getParamDescription(reg, AGT_WEB_SEARCH_NAME, 'site', BUILTIN.parameters['site']!),
    ),
    time_range: z.string().optional().describe(
      getParamDescription(reg, AGT_WEB_SEARCH_NAME, 'time_range', BUILTIN.parameters['time_range']!),
    ),
  });

  return new DynamicStructuredTool({
    name: AGT_WEB_SEARCH_NAME,
    description: getToolDescription(reg, AGT_WEB_SEARCH_NAME, BUILTIN.description),
    schema,
    func: async (rawInput, _runManager, runConfig) => {
      const input = mergeProfileToolArgs(
        rawInput,
        runConfig?.configurable as ProfileToolArgsConfigurable | undefined,
        AGT_WEB_SEARCH_NAME,
      );
      try {
        if (requestBudget.remaining <= 0) {
          throw new WebError('E_SEARCH_BUDGET_EXCEEDED', `Web search session budget of ${maxRequests} requests exceeded.`);
        }
        requestBudget.remaining -= 1;

        const backend = getWebBackend(cfg);
        const results = await backend.search(input.query, input.top_k ?? 5, input.site, input.time_range);
        return JSON.stringify({ results, remainingBudget: requestBudget.remaining });
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
