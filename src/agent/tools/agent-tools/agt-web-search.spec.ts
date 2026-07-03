/**
 * Tests for `agt_web_search` (plan-011) — the first-party web-search wrapper
 * re-homed from the former built-in `web_search` into the agt_* pack.
 *
 * Coverage mirrors what the built-in web_search behaviour guaranteed:
 *   - backend-call: a successful search invokes `getWebBackend(cfg).search`
 *     with the resolved args and serialises the results + remaining budget.
 *   - budget-exhaustion: once the shared per-session budget is drained the
 *     tool returns the `E_SEARCH_BUDGET_EXCEEDED` error envelope (via
 *     handleToolError) WITHOUT calling the backend.
 *   - overlay: a registered tool-prompt overlay overrides the LLM-visible
 *     description (and the constant exposes the canonical built-in text).
 *
 * The web backend registry is mocked so no network call happens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the backend registry BEFORE importing the wrapper so the wrapper's
// `getWebBackend` import binds to the mock.
const searchMock = vi.fn();
const fetchMock = vi.fn();
const getWebBackendMock = vi.fn(() => ({ search: searchMock, fetch: fetchMock }));
vi.mock('../web/backends/registry.js', () => ({
  getWebBackend: (...args: unknown[]) => getWebBackendMock(...(args as [])),
}));

import {
  AGT_WEB_SEARCH_NAME,
  AGT_WEB_SEARCH_DESCRIPTION,
  buildAgtWebSearchTool,
} from './agt-web-search.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import type { OverlayRegistry } from '../tool-prompt-overlay.js';

function makeCfg(overlays?: OverlayRegistry): AgentConfig {
  return {
    webSearch: { backend: 'tavily', maxRequests: 50 },
    toolPromptOverlays: overlays,
  } as unknown as AgentConfig;
}

beforeEach(() => {
  searchMock.mockReset();
  fetchMock.mockReset();
  getWebBackendMock.mockClear();
  getWebBackendMock.mockImplementation(() => ({ search: searchMock, fetch: fetchMock }));
});

describe('agt_web_search — identity', () => {
  it('has the agt_web_search name', () => {
    expect(AGT_WEB_SEARCH_NAME).toBe('agt_web_search');
  });

  it('description aliases the canonical built-in (incl. the never-fabricate-URLs guidance)', () => {
    expect(AGT_WEB_SEARCH_DESCRIPTION).toBe(BUILTIN_TOOL_PROMPTS['agt_web_search']!.description);
    expect(AGT_WEB_SEARCH_DESCRIPTION).toContain('Never fabricate URLs');
  });

  it('builds a DynamicStructuredTool named agt_web_search', () => {
    const tool = buildAgtWebSearchTool({ cfg: makeCfg(), requestBudget: { remaining: 5 } });
    expect(tool.name).toBe('agt_web_search');
  });
});

describe('agt_web_search — backend call', () => {
  it('calls the backend and serialises results + remaining budget; decrements the budget', async () => {
    searchMock.mockResolvedValue([
      { title: 'T', url: 'https://example.com', snippet: 'S' },
    ]);
    const budget = { remaining: 3 };
    const tool = buildAgtWebSearchTool({ cfg: makeCfg(), requestBudget: budget });

    const out = await tool.invoke({ query: 'hello', top_k: 2, site: 'example.com', time_range: 'week' });

    expect(getWebBackendMock).toHaveBeenCalledTimes(1);
    expect(searchMock).toHaveBeenCalledWith('hello', 2, 'example.com', 'week');
    const parsed = JSON.parse(out) as { results: unknown[]; remainingBudget: number };
    expect(parsed.results).toHaveLength(1);
    expect(parsed.remainingBudget).toBe(2);
    expect(budget.remaining).toBe(2);
  });

  it('defaults top_k to 5 when omitted', async () => {
    searchMock.mockResolvedValue([]);
    const tool = buildAgtWebSearchTool({ cfg: makeCfg(), requestBudget: { remaining: 3 } });
    await tool.invoke({ query: 'q' });
    expect(searchMock).toHaveBeenCalledWith('q', 5, undefined, undefined);
  });
});

describe('agt_web_search — budget exhaustion', () => {
  it('returns the E_SEARCH_BUDGET_EXCEEDED envelope and does NOT call the backend when budget is 0', async () => {
    const tool = buildAgtWebSearchTool({ cfg: makeCfg(), requestBudget: { remaining: 0 } });
    const out = await tool.invoke({ query: 'q' });
    const parsed = JSON.parse(out) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe('E_SEARCH_BUDGET_EXCEEDED');
    expect(searchMock).not.toHaveBeenCalled();
  });
});

describe('agt_web_search — overlay', () => {
  it('a registered overlay overrides the LLM-visible description', () => {
    const overlays = {
      get: (name: string) =>
        name === 'agt_web_search'
          ? { tool: name, description: 'OVERLAID web search', parameters: new Map<string, string>(), source: 'test' }
          : undefined,
      list: () => [],
    } as unknown as OverlayRegistry;
    const tool = buildAgtWebSearchTool({ cfg: makeCfg(), requestBudget: { remaining: 1 }, overlays });
    expect(tool.description).toBe('OVERLAID web search');
  });
});
