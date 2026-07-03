/**
 * `agt_web_fetch` — LangChain `DynamicStructuredTool` for fetching a URL and
 * returning its content as readable text, re-homed from the former built-in
 * `web_fetch` into the agent-tools (`agt_*`) pack (plan-011).
 *
 * Like `agt_web_search`, this is a FIRST-PARTY member of the `agt_`
 * namespace (no vendored-upstream source) that REUSES the existing cli-agent
 * web backend (`../web/backends/registry.js`, `getWebBackend`) verbatim — the
 * backend was NOT moved or duplicated.
 *
 * Read-only. Governed by `--agent-tools` (umbrella) + the per-tool
 * `--enable/--disable-agt-web-fetch` flag (default ON). NOT affected by
 * `--no-builtin-tools`.
 *
 * The body is the former `createWebFetchTool` verbatim, with the name and
 * prompt key changed to `agt_web_fetch`: it keeps `getWebBackend(cfg)`, the
 * per-session request budget (`WEB_SEARCH_MAX_REQUESTS`, default 50, shared
 * with `agt_web_search`) with `E_SEARCH_BUDGET_EXCEEDED`,
 * `mergeProfileToolArgs`, and `handleToolError`.
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
export const AGT_WEB_FETCH_NAME = 'agt_web_fetch' as const;

/**
 * Description handed both to LangChain (`DynamicStructuredTool.description`)
 * and to the agent-tools prompt-block assembler. Sourced from the canonical
 * `BUILTIN_TOOL_PROMPTS` registry so there is a SINGLE literal per tool
 * (incl. the "Never fabricate URLs" guidance).
 */
export const AGT_WEB_FETCH_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_WEB_FETCH_NAME]!.description;

/** Dependency bag injected by U5's catalog builder. */
export interface AgtWebFetchDeps {
  cfg: AgentConfig;
  /** Per-session request budget, shared with `agt_web_search`. */
  requestBudget: { remaining: number };
  /** Optional overlay registry; when present, user-edited descriptions
   * take precedence over the canonical built-in. */
  overlays?: OverlayRegistry;
}

/** Build the LangChain tool. */
export function buildAgtWebFetchTool(deps: AgtWebFetchDeps): DynamicStructuredTool {
  const { cfg, requestBudget } = deps;
  const maxRequests = cfg.webSearch.maxRequests;
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_WEB_FETCH_NAME]!;
  const reg = deps.overlays ?? cfg.toolPromptOverlays;
  const schema = z.object({
    url: z.string().url().describe(
      getParamDescription(reg, AGT_WEB_FETCH_NAME, 'url', BUILTIN.parameters['url']!),
    ),
    max_bytes: z.number().int().positive().optional().describe(
      getParamDescription(reg, AGT_WEB_FETCH_NAME, 'max_bytes', BUILTIN.parameters['max_bytes']!),
    ),
  });

  return new DynamicStructuredTool({
    name: AGT_WEB_FETCH_NAME,
    description: getToolDescription(reg, AGT_WEB_FETCH_NAME, BUILTIN.description),
    schema,
    func: async (rawInput, _runManager, runConfig) => {
      const input = mergeProfileToolArgs(
        rawInput,
        runConfig?.configurable as ProfileToolArgsConfigurable | undefined,
        AGT_WEB_FETCH_NAME,
      );
      try {
        if (requestBudget.remaining <= 0) {
          throw new WebError('E_SEARCH_BUDGET_EXCEEDED', `Web request session budget of ${maxRequests} requests exceeded.`);
        }
        requestBudget.remaining -= 1;

        const backend = getWebBackend(cfg);
        const result = await backend.fetch(input.url, input.max_bytes ?? 1024 * 1024);
        return JSON.stringify(result);
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
