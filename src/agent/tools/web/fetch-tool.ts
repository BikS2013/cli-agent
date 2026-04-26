import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { getWebBackend } from './backends/registry.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { WebError } from '../../../errors.js';

const schema = z.object({
  url: z.string().url().describe('URL to fetch. HTML is converted to readable text.'),
  max_bytes: z.number().int().positive().optional().describe('Maximum response size in bytes (default 1 MiB).'),
});

export function createWebFetchTool(cfg: AgentConfig, requestBudget: { remaining: number }): DynamicStructuredTool {
  const maxRequests = parseInt(process.env['WEB_SEARCH_MAX_REQUESTS'] ?? '50', 10);

  return new DynamicStructuredTool({
    name: 'web_fetch',
    description: 'Fetch a URL and return its content as readable text. HTML is stripped to plain text. Never fabricate URLs.',
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
