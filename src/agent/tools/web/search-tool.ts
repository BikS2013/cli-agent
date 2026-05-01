import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { getWebBackend } from './backends/registry.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { WebError } from '../../../errors.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import { getToolDescription, getParamDescription } from '../tool-prompt-overlay.js';

const TOOL_NAME = 'web_search';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL_NAME]!;

export function createWebSearchTool(cfg: AgentConfig, requestBudget: { remaining: number }): DynamicStructuredTool {
  const maxRequests = parseInt(process.env['WEB_SEARCH_MAX_REQUESTS'] ?? '50', 10);
  const reg = cfg.toolPromptOverlays;
  const schema = z.object({
    query: z.string().min(1).describe(
      getParamDescription(reg, TOOL_NAME, 'query', BUILTIN.parameters['query']!),
    ),
    top_k: z.number().int().positive().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'top_k', BUILTIN.parameters['top_k']!),
    ),
    site: z.string().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'site', BUILTIN.parameters['site']!),
    ),
    time_range: z.string().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'time_range', BUILTIN.parameters['time_range']!),
    ),
  });

  return new DynamicStructuredTool({
    name: TOOL_NAME,
    description: getToolDescription(reg, TOOL_NAME, BUILTIN.description),
    schema,
    func: async (input) => {
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
