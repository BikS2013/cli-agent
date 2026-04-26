import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { getWebBackend } from './backends/registry.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { WebError } from '../../../errors.js';

const schema = z.object({
  query: z.string().min(1).describe('Search query string.'),
  top_k: z.number().int().positive().optional().describe('Number of results to return (default 5).'),
  site: z.string().optional().describe('Restrict search to this domain (e.g. "docs.python.org").'),
  time_range: z.string().optional().describe('Time range filter, e.g. "day", "week", "month".'),
});

export function createWebSearchTool(cfg: AgentConfig, requestBudget: { remaining: number }): DynamicStructuredTool {
  const maxRequests = parseInt(process.env['WEB_SEARCH_MAX_REQUESTS'] ?? '50', 10);

  return new DynamicStructuredTool({
    name: 'web_search',
    description: 'Search the public internet and return a list of results with titles, URLs, and snippets. Never fabricate URLs — only use URLs returned by this tool.',
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
