/**
 * Web search backend registry.
 * Only the configured backend is loaded at runtime.
 */

import { WebError } from '../../../../errors.js';
import type { AgentConfig } from '../../../../config/agent-config.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface FetchResult {
  url: string;
  status: number;
  contentType: string;
  text: string;
  _truncated?: boolean;
}

export interface WebBackend {
  search(query: string, topK?: number, site?: string, timeRange?: string): Promise<SearchResult[]>;
  fetch(url: string, maxBytes?: number): Promise<FetchResult>;
}

export function getWebBackend(cfg: AgentConfig): WebBackend {
  const backend = cfg.webSearch.backend;

  switch (backend) {
    case 'tavily':
      return getTavilyBackend(cfg);
    case 'serpapi':
      return getSerpApiBackend(cfg);
    case 'brave':
      return getBraveBackend(cfg);
    case 'duckduckgo':
      return getDuckDuckGoBackend();
    case 'custom-http':
      return getCustomHttpBackend(cfg);
    default:
      throw new WebError(
        'E_SEARCH_API_KEY_MISSING',
        `Unknown web search backend: '${backend}'. Valid values: tavily, serpapi, brave, duckduckgo, custom-http.`,
      );
  }
}

function getTavilyBackend(cfg: AgentConfig): WebBackend {
  const apiKey = process.env['TAVILY_API_KEY'];
  if (!apiKey) {
    throw new WebError(
      'E_SEARCH_API_KEY_MISSING',
      `TAVILY_API_KEY is required when web search backend is 'tavily'. Checked: env:TAVILY_API_KEY, ~/.tool-agents/cli-agent/.env`,
    );
  }

  return {
    async search(query, topK = 5, site, _timeRange) {
      const searchQuery = site ? `site:${site} ${query}` : query;
      const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ query: searchQuery, max_results: topK, search_depth: 'basic' }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        if (response.status === 429) throw new WebError('E_SEARCH_RATE_LIMITED', 'Tavily rate limit exceeded.');
        throw new WebError('E_FETCH_HTTP', `Tavily API returned ${response.status}.`);
      }
      const data = await response.json() as { results?: Array<{ title: string; url: string; content: string; published_date?: string }> };
      return (data.results ?? []).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.content,
        publishedAt: r.published_date,
      }));
    },
    async fetch(url, maxBytes = 1024 * 1024) {
      return fetchUrl(url, maxBytes);
    },
  };
}

function getSerpApiBackend(cfg: AgentConfig): WebBackend {
  const apiKey = process.env['SERPAPI_API_KEY'];
  if (!apiKey) {
    throw new WebError(
      'E_SEARCH_API_KEY_MISSING',
      `SERPAPI_API_KEY is required when web search backend is 'serpapi'.`,
    );
  }

  return {
    async search(query, topK = 5, site, _timeRange) {
      const searchQuery = site ? `site:${site} ${query}` : query;
      const params = new URLSearchParams({ q: searchQuery, api_key: apiKey, num: String(topK) });
      const response = await fetch(`https://serpapi.com/search.json?${params.toString()}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        if (response.status === 429) throw new WebError('E_SEARCH_RATE_LIMITED', 'SerpAPI rate limit exceeded.');
        throw new WebError('E_FETCH_HTTP', `SerpAPI returned ${response.status}.`);
      }
      const data = await response.json() as { organic_results?: Array<{ title: string; link: string; snippet: string }> };
      return (data.organic_results ?? []).slice(0, topK).map((r) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet,
      }));
    },
    async fetch(url, maxBytes = 1024 * 1024) {
      return fetchUrl(url, maxBytes);
    },
  };
}

function getBraveBackend(cfg: AgentConfig): WebBackend {
  const apiKey = process.env['BRAVE_API_KEY'];
  if (!apiKey) {
    throw new WebError(
      'E_SEARCH_API_KEY_MISSING',
      `BRAVE_API_KEY is required when web search backend is 'brave'.`,
    );
  }

  return {
    async search(query, topK = 5, site, _timeRange) {
      const searchQuery = site ? `site:${site} ${query}` : query;
      const params = new URLSearchParams({ q: searchQuery, count: String(topK) });
      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params.toString()}`, {
        headers: { 'Accept': 'application/json', 'Accept-Encoding': 'gzip', 'X-Subscription-Token': apiKey },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        if (response.status === 429) throw new WebError('E_SEARCH_RATE_LIMITED', 'Brave Search rate limit exceeded.');
        throw new WebError('E_FETCH_HTTP', `Brave Search returned ${response.status}.`);
      }
      const data = await response.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
      return (data.web?.results ?? []).slice(0, topK).map((r) => ({
        title: r.title,
        url: r.url,
        snippet: r.description,
      }));
    },
    async fetch(url, maxBytes = 1024 * 1024) {
      return fetchUrl(url, maxBytes);
    },
  };
}

function getDuckDuckGoBackend(): WebBackend {
  return {
    async search(query, topK = 5, site, _timeRange) {
      // DuckDuckGo HTML search scrape — fragile but free
      const searchQuery = site ? `site:${site} ${query}` : query;
      const params = new URLSearchParams({ q: searchQuery });
      const response = await fetch(`https://html.duckduckgo.com/html/?${params.toString()}`, {
        headers: { 'User-Agent': 'cli-agent/0.1.0' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new WebError('E_FETCH_HTTP', `DuckDuckGo returned ${response.status}.`);
      const html = await response.text();
      // Very basic scrape of result titles and URLs
      const results: SearchResult[] = [];
      const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/g;
      let match: RegExpExecArray | null;
      while ((match = linkRe.exec(html)) !== null && results.length < topK) {
        results.push({ title: match[2]?.replace(/<[^>]+>/g, '') ?? '', url: match[1] ?? '', snippet: '' });
      }
      return results;
    },
    async fetch(url, maxBytes = 1024 * 1024) {
      return fetchUrl(url, maxBytes);
    },
  };
}

function getCustomHttpBackend(cfg: AgentConfig): WebBackend {
  const searchUrl = process.env['WEB_SEARCH_URL'];
  if (!searchUrl) {
    throw new WebError(
      'E_SEARCH_API_KEY_MISSING',
      `WEB_SEARCH_URL is required when web search backend is 'custom-http'.`,
    );
  }
  const apiKey = process.env['WEB_SEARCH_API_KEY'];

  return {
    async search(query, topK = 5, site, timeRange) {
      const response = await fetch(searchUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({ query, top_k: topK, site, time_range: timeRange }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new WebError('E_FETCH_HTTP', `Custom search backend returned ${response.status}.`);
      const data = await response.json() as { results?: SearchResult[] };
      return data.results ?? [];
    },
    async fetch(url, maxBytes = 1024 * 1024) {
      return fetchUrl(url, maxBytes);
    },
  };
}

/** Generic fetch with sanitized headers and size cap. */
async function fetchUrl(url: string, maxBytes: number): Promise<FetchResult> {
  // Check robots.txt — simplified: only block if robots.txt explicitly disallows all
  // (Full robots.txt compliance is complex; we do a best-effort check)
  const parsedUrl = new URL(url);
  const robotsUrl = `${parsedUrl.protocol}//${parsedUrl.host}/robots.txt`;
  try {
    const robotsResp = await fetch(robotsUrl, {
      headers: { 'User-Agent': 'cli-agent/0.1.0' },
      signal: AbortSignal.timeout(5000),
    });
    if (robotsResp.ok) {
      const robotsTxt = await robotsResp.text();
      // Check if all user-agents are disallowed from all paths
      if (/User-agent:\s*\*[\s\S]*?Disallow:\s*\/\s*$/m.test(robotsTxt)) {
        throw new WebError('E_FETCH_BLOCKED_BY_ROBOTS', `Fetching '${url}' is blocked by robots.txt.`);
      }
    }
  } catch (e) {
    if (e instanceof WebError) throw e;
    // robots.txt fetch failed — proceed anyway
  }

  const response = await fetch(url, {
    headers: { 'User-Agent': 'cli-agent/0.1.0', 'Accept': 'text/html,text/plain,application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new WebError('E_FETCH_HTTP', `HTTP ${response.status} fetching '${url}'.`);
  }

  const contentType = response.headers.get('content-type') ?? 'text/plain';
  const buffer = await response.arrayBuffer();
  const totalBytes = buffer.byteLength;

  if (totalBytes > maxBytes) {
    throw new WebError(
      'E_FETCH_TOO_LARGE',
      `Response from '${url}' is ${totalBytes} bytes, exceeding limit of ${maxBytes} bytes.`,
    );
  }

  let text = new TextDecoder().decode(buffer);
  // Strip HTML tags for readability
  if (contentType.includes('html')) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  const truncated = Buffer.byteLength(text, 'utf8') > maxBytes;
  if (truncated) {
    text = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8');
  }

  return {
    url,
    status: response.status,
    contentType,
    text,
    ...(truncated ? { _truncated: true } : {}),
  };
}
