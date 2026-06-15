/**
 * Tests for `agt_web_fetch` (plan-011) — the first-party web-fetch wrapper
 * re-homed from the former built-in `web_fetch` into the agt_* pack.
 *
 * Coverage mirrors what the built-in web_fetch behaviour guaranteed:
 *   - backend-call: a successful fetch invokes `getWebBackend(cfg).fetch`
 *     with the resolved url + max_bytes and serialises the result.
 *   - budget-exhaustion: a drained shared per-session budget yields the
 *     `E_SEARCH_BUDGET_EXCEEDED` envelope WITHOUT calling the backend.
 *   - overlay: a registered overlay overrides the LLM-visible description.
 *
 * The web backend registry is mocked so no network call happens.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const searchMock = vi.fn();
const fetchMock = vi.fn();
const getWebBackendMock = vi.fn(() => ({ search: searchMock, fetch: fetchMock }));
vi.mock('../web/backends/registry.js', () => ({
  getWebBackend: (...args: unknown[]) => getWebBackendMock(...(args as [])),
}));

import {
  AGT_WEB_FETCH_NAME,
  AGT_WEB_FETCH_DESCRIPTION,
  buildAgtWebFetchTool,
} from './agt-web-fetch.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import type { OverlayRegistry } from '../tool-prompt-overlay.js';

function makeCfg(overlays?: OverlayRegistry): AgentConfig {
  return {
    webSearch: { backend: 'tavily' },
    toolPromptOverlays: overlays,
  } as unknown as AgentConfig;
}

beforeEach(() => {
  searchMock.mockReset();
  fetchMock.mockReset();
  getWebBackendMock.mockClear();
  getWebBackendMock.mockImplementation(() => ({ search: searchMock, fetch: fetchMock }));
});

describe('agt_web_fetch — identity', () => {
  it('has the agt_web_fetch name', () => {
    expect(AGT_WEB_FETCH_NAME).toBe('agt_web_fetch');
  });

  it('description aliases the canonical built-in (incl. the never-fabricate-URLs guidance)', () => {
    expect(AGT_WEB_FETCH_DESCRIPTION).toBe(BUILTIN_TOOL_PROMPTS['agt_web_fetch']!.description);
    expect(AGT_WEB_FETCH_DESCRIPTION).toContain('Never fabricate URLs');
  });

  it('builds a DynamicStructuredTool named agt_web_fetch', () => {
    const tool = buildAgtWebFetchTool({ cfg: makeCfg(), requestBudget: { remaining: 5 } });
    expect(tool.name).toBe('agt_web_fetch');
  });
});

describe('agt_web_fetch — backend call', () => {
  it('calls the backend with url + max_bytes, serialises the result, decrements the budget', async () => {
    fetchMock.mockResolvedValue({ url: 'https://example.com', status: 200, contentType: 'text/plain', text: 'hi' });
    const budget = { remaining: 2 };
    const tool = buildAgtWebFetchTool({ cfg: makeCfg(), requestBudget: budget });

    const out = await tool.invoke({ url: 'https://example.com', max_bytes: 4096 });

    expect(getWebBackendMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://example.com', 4096);
    const parsed = JSON.parse(out) as { status: number; text: string };
    expect(parsed.status).toBe(200);
    expect(parsed.text).toBe('hi');
    expect(budget.remaining).toBe(1);
  });

  it('defaults max_bytes to 1 MiB when omitted', async () => {
    fetchMock.mockResolvedValue({ url: 'https://example.com', status: 200, contentType: 'text/plain', text: '' });
    const tool = buildAgtWebFetchTool({ cfg: makeCfg(), requestBudget: { remaining: 2 } });
    await tool.invoke({ url: 'https://example.com' });
    expect(fetchMock).toHaveBeenCalledWith('https://example.com', 1024 * 1024);
  });
});

describe('agt_web_fetch — budget exhaustion', () => {
  it('returns the E_SEARCH_BUDGET_EXCEEDED envelope and does NOT call the backend when budget is 0', async () => {
    const tool = buildAgtWebFetchTool({ cfg: makeCfg(), requestBudget: { remaining: 0 } });
    const out = await tool.invoke({ url: 'https://example.com' });
    const parsed = JSON.parse(out) as { error?: { code?: string } };
    expect(parsed.error?.code).toBe('E_SEARCH_BUDGET_EXCEEDED');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('agt_web_fetch — shared budget with agt_web_search', () => {
  it('a budget object passed to both tools decrements across both', async () => {
    const { buildAgtWebSearchTool } = await import('./agt-web-search.js');
    searchMock.mockResolvedValue([]);
    fetchMock.mockResolvedValue({ url: 'https://example.com', status: 200, contentType: 'text/plain', text: '' });
    const budget = { remaining: 2 };
    const search = buildAgtWebSearchTool({ cfg: makeCfg(), requestBudget: budget });
    const fetch = buildAgtWebFetchTool({ cfg: makeCfg(), requestBudget: budget });

    await search.invoke({ query: 'q' });
    expect(budget.remaining).toBe(1);
    await fetch.invoke({ url: 'https://example.com' });
    expect(budget.remaining).toBe(0);
    // Third call (either tool) is now over budget.
    const out = await fetch.invoke({ url: 'https://example.com' });
    expect((JSON.parse(out) as { error?: { code?: string } }).error?.code).toBe('E_SEARCH_BUDGET_EXCEEDED');
  });
});

describe('agt_web_fetch — overlay', () => {
  it('a registered overlay overrides the LLM-visible description', () => {
    const overlays = {
      get: (name: string) =>
        name === 'agt_web_fetch'
          ? { tool: name, description: 'OVERLAID web fetch', parameters: new Map<string, string>(), source: 'test' }
          : undefined,
      list: () => [],
    } as unknown as OverlayRegistry;
    const tool = buildAgtWebFetchTool({ cfg: makeCfg(), requestBudget: { remaining: 1 }, overlays });
    expect(tool.description).toBe('OVERLAID web fetch');
  });
});
