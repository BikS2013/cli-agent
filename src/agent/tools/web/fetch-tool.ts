import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { getWebBackend } from './backends/registry.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { WebError } from '../../../errors.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import { getToolDescription, getParamDescription } from '../tool-prompt-overlay.js';

const TOOL_NAME = 'web_fetch';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL_NAME]!;

export function createWebFetchTool(cfg: AgentConfig, requestBudget: { remaining: number }): DynamicStructuredTool {
  const maxRequests = parseInt(process.env['WEB_SEARCH_MAX_REQUESTS'] ?? '50', 10);
  const reg = cfg.toolPromptOverlays;
  const schema = z.object({
    url: z.string().url().describe(
      getParamDescription(reg, TOOL_NAME, 'url', BUILTIN.parameters['url']!),
    ),
    max_bytes: z.number().int().positive().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'max_bytes', BUILTIN.parameters['max_bytes']!),
    ),
  });

  return new DynamicStructuredTool({
    name: TOOL_NAME,
    description: getToolDescription(reg, TOOL_NAME, BUILTIN.description),
    schema,
    func: async (input) => {
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
