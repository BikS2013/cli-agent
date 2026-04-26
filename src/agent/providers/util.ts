/**
 * Shared utilities for provider factories.
 */

/**
 * Normalize an Azure AI Foundry endpoint URL for use with Anthropic.
 *
 * Rules:
 *  - Strip trailing slashes
 *  - Strip trailing `/models` segment (case-insensitive)
 *  - Append `/anthropic`
 */
export function normalizeFoundryEndpoint(base: string): string {
  let b = base.trim().replace(/\/+$/, '');
  if (/\/models$/i.test(b)) {
    b = b.slice(0, -'/models'.length);
  }
  b = b.replace(/\/+$/, '');
  return b + '/anthropic';
}

/**
 * Ensure an Ollama host has the /v1 suffix for OpenAI wire compatibility.
 */
export function normalizeOllamaBaseUrl(host: string): string {
  const base = host.trim().replace(/\/+$/, '');
  if (base.endsWith('/v1')) return base;
  return base + '/v1';
}
