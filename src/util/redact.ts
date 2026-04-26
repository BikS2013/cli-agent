/**
 * String redaction utility.
 *
 * Masks API keys, bearer tokens, JWTs, and long base64-URL runs before
 * any value is written to stderr or a log file.
 *
 * Rules:
 *  - Bearer / Basic auth headers
 *  - JWT pattern (three base64url segments separated by dots)
 *  - Long base64-URL runs (≥ 32 chars of [A-Za-z0-9+/=_-]) — catches most
 *    API key shapes
 *  - Common env-var patterns: OPENAI_API_KEY=<value>, etc.
 */

const PATTERNS: Array<{ re: RegExp; replacement: string }> = [
  // Bearer / Basic auth tokens in headers
  {
    re: /\b(Bearer|Basic)\s+[A-Za-z0-9+/=_\-\.]{8,}/gi,
    replacement: '$1 [REDACTED]',
  },
  // JWT (three base64url segments)
  {
    re: /\b[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g,
    replacement: '[JWT_REDACTED]',
  },
  // Long base64-URL runs that look like API keys (≥ 32 contiguous chars)
  {
    re: /[A-Za-z0-9+/=_\-]{32,}/g,
    replacement: '[KEY_REDACTED]',
  },
];

// Key=value pairs in env-like lines, e.g. OPENAI_API_KEY=sk-...
const ENV_KEY_RE =
  /\b(OPENAI_API_KEY|ANTHROPIC_API_KEY|GOOGLE_API_KEY|GEMINI_API_KEY|AZURE_OPENAI_API_KEY|AZURE_AI_INFERENCE_KEY|ANTHROPIC_FOUNDRY_API_KEY|LITELLM_MASTER_KEY|LITELLM_API_KEY|TAVILY_API_KEY|SERPAPI_API_KEY|BRAVE_API_KEY|WEB_SEARCH_API_KEY)=\S+/gi;

/**
 * Redact sensitive values from a string.
 * Returns the redacted string. Never throws.
 */
export function redactString(input: string): string {
  try {
    // First pass: key=value pairs
    let result = input.replace(ENV_KEY_RE, (match) => {
      const eqIdx = match.indexOf('=');
      return match.slice(0, eqIdx + 1) + '[REDACTED]';
    });

    // Second pass: generic patterns
    for (const { re, replacement } of PATTERNS) {
      result = result.replace(re, replacement);
    }

    return result;
  } catch {
    // Never let redaction crash the caller
    return '[REDACTED_FALLBACK]';
  }
}

/**
 * Redact sensitive values from an object by JSON-stringifying and redacting.
 * Returns a parsed object (unknown fields) or the string if parse fails.
 */
export function redactObject(obj: unknown): unknown {
  try {
    const s = redactString(JSON.stringify(obj));
    return JSON.parse(s) as unknown;
  } catch {
    return '[REDACTED_OBJECT]';
  }
}
