/**
 * Tests for the web backend registry configuration boundary.
 *
 * The registry must consume the resolved AgentConfig snapshot built by
 * loadAgentConfig. It must not read process.env directly, otherwise
 * ~/.tool-agents/cli-agent/.env and local .env values disappear.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../../../config/agent-config.js';
import { getWebBackend } from './registry.js';

const ENV_KEYS = [
  'TAVILY_API_KEY',
  'SERPAPI_API_KEY',
  'BRAVE_API_KEY',
  'WEB_SEARCH_URL',
  'WEB_SEARCH_API_KEY',
] as const;

const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

function makeCfg(webSearch: Partial<AgentConfig['webSearch']> & { backend: string }): AgentConfig {
  return {
    webSearch: {
      backend: webSearch.backend,
      tavilyApiKey: webSearch.tavilyApiKey,
      serpApiKey: webSearch.serpApiKey,
      braveApiKey: webSearch.braveApiKey,
      customHttpUrl: webSearch.customHttpUrl,
      customHttpApiKey: webSearch.customHttpApiKey,
      maxRequests: webSearch.maxRequests ?? 50,
    },
  } as unknown as AgentConfig;
}

describe('getWebBackend — resolved config snapshot', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  it('uses cfg.webSearch.tavilyApiKey even when process.env has no TAVILY_API_KEY', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [
          { title: 'T', url: 'https://example.com', content: 'S', published_date: '2026-06-15' },
        ],
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const backend = getWebBackend(makeCfg({ backend: 'tavily', tavilyApiKey: 'cfg-tavily-key' }));
    const results = await backend.search('query', 1);

    expect(results).toEqual([
      { title: 'T', url: 'https://example.com', snippet: 'S', publishedAt: '2026-06-15' },
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.tavily.com/search',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer cfg-tavily-key' }),
      }),
    );
  });

  it('uses cfg.webSearch custom HTTP URL and optional API key', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        results: [{ title: 'T', url: 'https://example.com', snippet: 'S' }],
      }),
    } as unknown as Response);
    vi.stubGlobal('fetch', fetchMock);

    const backend = getWebBackend(makeCfg({
      backend: 'custom-http',
      customHttpUrl: 'https://search.example/api',
      customHttpApiKey: 'cfg-custom-key',
    }));
    const results = await backend.search('query', 3, 'example.com', 'week');

    expect(results).toEqual([{ title: 'T', url: 'https://example.com', snippet: 'S' }]);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://search.example/api',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer cfg-custom-key' }),
        body: JSON.stringify({
          query: 'query',
          top_k: 3,
          site: 'example.com',
          time_range: 'week',
        }),
      }),
    );
  });

  it('still raises the backend-specific missing-key error when the resolved snapshot lacks the key', () => {
    expect(() => getWebBackend(makeCfg({ backend: 'tavily' }))).toThrow(
      /TAVILY_API_KEY is required/,
    );
  });
});
