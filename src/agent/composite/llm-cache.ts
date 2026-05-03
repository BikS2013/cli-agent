/**
 * Provider-agnostic LLM prompt-cache helper for composite-tool synthesis
 * (plan-006 Phase 6, Unit U-CACHE).
 *
 * Owns the entire surface that the Stage-2 synthesizer (U-SYNTH) calls
 * to opt the synthesis prompt into provider-side prompt caching:
 *
 *   - `resolveProviderFamily(cfg)` — collapse the eight standard
 *     `ProviderName` values into the nine-element `ProviderFamily` union
 *     used by the cache adapters. Unknown providers fall through to
 *     `'local-compat'` (an inert no-op family) per plan-006 §14.D's
 *     "no fallback solutions for required config" carve-out: this is
 *     not a configuration default, it is an interop policy choice.
 *
 *   - `withSynthesisCache(messages, options)` — annotate the message
 *     prefix `messages[0..prefixEndIndex]` with provider-specific cache
 *     markers. For Anthropic / Azure-Anthropic / LiteLLM-Anthropic:
 *     emit `cache_control` blocks with the requested TTL. For all
 *     other providers: return the messages unchanged (caching is
 *     either automatic on a stable byte-prefix — OpenAI / Azure-OpenAI
 *     / Azure-Inference / LiteLLM-OpenAI / Gemini implicit — or
 *     unavailable — Ollama / MLX / llama.cpp). This is a deliberate
 *     no-op rather than a thrown error so the synthesizer can call the
 *     helper unconditionally regardless of the resolved provider.
 *
 *   - `extractCacheUsage(responseMetadata)` — read provider-side cache
 *     usage out of an AIMessage's `response_metadata` (or the LangChain
 *     `usage_metadata.input_token_details`) into a normalized
 *     `{ cachedTokens, cacheCreationTokens, provider }` shape consumed
 *     by §14.M's `composite_stage2_run` JSONL event.
 *
 *   - `isProviderFamilyCachable(family)` — convenience predicate (true
 *     for explicit-marker families only).
 *
 * The exported `ProviderFamily` and `SynthesisCacheOptions` types are
 * re-exports of the plan-006 §14.D leaf-types module
 * (`./types.js`). They are NOT redefined here — extending them is
 * disallowed by the §14.P interface contract until the cross-unit
 * coordination protocol is exercised.
 */

import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import type { AgentConfig } from '../../config/agent-config.js';
import type { ProviderFamily, SynthesisCacheOptions } from './types.js';

export type { ProviderFamily, SynthesisCacheOptions };

/**
 * Collapse the configured `ProviderName` (`cfg.provider`) into the
 * 9-value `ProviderFamily` union the cache adapters key off of.
 *
 * Mapping (plan-006 §14.D + research §"Decision Table"):
 *   - `anthropic`        → `'anthropic'`
 *   - `azure-anthropic`  → `'anthropic'`        (Azure AI Foundry routes
 *     Claude requests through the Anthropic wire format via
 *     `ChatAnthropic` — the `cache_control` markers pass through
 *     unchanged; see `src/agent/providers/azure-anthropic.ts`)
 *   - `openai`           → `'openai'`
 *   - `azure-openai`     → `'azure-openai'`
 *   - `gemini`           → `'google-gemini'`
 *   - `ollama`           → `'ollama'`
 *   - `mlx`              → `'local-compat'`
 *   - `litellm`          → `'litellm-anthropic'` if `cfg.model` starts with
 *     `anthropic/`; else `'litellm-openai'` (matches research §"LiteLLM").
 *
 * Returns `'local-compat'` for any unrecognised value; this preserves
 * the no-op behaviour of `withSynthesisCache` for forward-compatibility
 * with future providers, and is also the safe fallback documented in
 * the research doc's helper sketch (§"Resolving providerFamily").
 */
export function resolveProviderFamily(cfg: AgentConfig): ProviderFamily {
  const provider = cfg.provider;
  const model = cfg.model ?? '';

  switch (provider) {
    case 'anthropic':
      return 'anthropic';
    case 'azure-anthropic':
      // Azure AI Foundry's Anthropic-Claude offering speaks the
      // Anthropic wire format. `cache_control` blocks pass through
      // verbatim.
      return 'anthropic';
    case 'openai':
      return 'openai';
    case 'azure-openai':
      return 'azure-openai';
    case 'gemini':
      return 'google-gemini';
    case 'ollama':
      return 'ollama';
    case 'mlx':
      return 'local-compat';
    case 'litellm':
      // LiteLLM proxies the upstream wire format. Detect the upstream
      // by model-name prefix so the right adapter is selected.
      return model.startsWith('anthropic/') ? 'litellm-anthropic' : 'litellm-openai';
    default:
      return 'local-compat';
  }
}

/**
 * Convenience predicate: which families benefit from explicit
 * `cache_control` markers? Only Anthropic-wire-format families.
 *
 * Automatic-prefix providers (`openai`, `azure-openai`,
 * `azure-inference`, `litellm-openai`, `google-gemini`) and
 * markerless local providers (`ollama`, `local-compat`) return
 * `false` — calling `withSynthesisCache` is still safe, but it's a
 * no-op.
 */
export function isProviderFamilyCachable(family: ProviderFamily): boolean {
  return family === 'anthropic' || family === 'litellm-anthropic';
}

/**
 * Annotate a synthesis message array with provider-specific
 * prompt-cache markers.
 *
 * Inputs:
 *   - `messages` — the assembled message array (typically:
 *     `[SystemMessage(staticPrefix), HumanMessage([membersBlock,
 *     composeInstruction])]`).
 *   - `options.providerFamily` — output of `resolveProviderFamily(cfg)`.
 *   - `options.prefixEndIndex` — last message index (inclusive) that
 *     should be cached. The Stage-2 synthesizer passes
 *     `messages.length - 1` to cover system + members; the dynamic
 *     compose-instruction block lives inside the last message's
 *     content array and is left unmarked (the helper marks the LAST
 *     content block of each cached message; for HumanMessages with a
 *     two-block content array, callers should put the dynamic tail in
 *     a SEPARATE block — see §14.G).
 *   - `options.anthropicTtl` — `'5m'` (default, 1.25× write cost) or
 *     `'1h'` (2× write cost; preferred for synthesis, which typically
 *     runs minutes apart).
 *
 * Per-family behaviour:
 *
 *   anthropic / litellm-anthropic
 *     Clone every message in `messages[0..prefixEndIndex]` and mark
 *     the last content block with
 *     `cache_control: { type: 'ephemeral', ttl?: '1h' }`.
 *     If the message's content is a string, normalize to a single-element
 *     content-block array `[{ type: 'text', text: <orig>, cache_control }]`.
 *     Up to two breakpoints are typically used (system + members) per
 *     §14.G; Anthropic supports up to four total per request.
 *
 *   openai / azure-openai / azure-inference / litellm-openai
 *     No mutation. Caching is automatic when the request prefix is
 *     ≥1024 tokens AND byte-identical across calls. The synthesizer
 *     achieves byte-identity by pinning the static system prompt and
 *     by pre-sorting members.
 *     If a future caller wants to attach `prompt_cache_key` for OpenAI
 *     2024-12+ explicit cache routing, that's done at the LLM-invoke
 *     site, not here — this helper only sees messages.
 *
 *   google-gemini
 *     No mutation. Implicit caching on Gemini 2.5+ requires no action;
 *     the explicit `caches.create()` API requires ~32 K tokens which
 *     Stage-2 prompts never reach.
 *
 *   ollama / local-compat
 *     No API. Returned unchanged. Prefix stability still helps the
 *     local KV cache.
 *
 * Returns: a NEW array (does not mutate the input). For passthrough
 * families, the returned array still contains the original message
 * instances — clone-on-mark is only paid on Anthropic-family inputs.
 */
export function withSynthesisCache(
  messages: BaseMessage[],
  options: SynthesisCacheOptions,
): BaseMessage[] {
  const { providerFamily, prefixEndIndex, anthropicTtl } = options;

  switch (providerFamily) {
    case 'anthropic':
    case 'litellm-anthropic':
      return applyAnthropicCacheMarkers(messages, prefixEndIndex, anthropicTtl ?? '5m');

    case 'openai':
    case 'azure-openai':
    case 'azure-inference':
    case 'litellm-openai':
    case 'google-gemini':
    case 'ollama':
    case 'local-compat':
      // Pass-through — return a shallow copy so callers can rely on
      // mutating the result without touching the input array.
      return [...messages];

    default: {
      // Exhaustiveness — TS will complain here if a new family is added
      // to the union without updating this switch. We still return a
      // safe pass-through (no throw) per the §14.P contract: callers
      // must be able to invoke this helper unconditionally.
      const _exhaustive: never = providerFamily;
      void _exhaustive;
      return [...messages];
    }
  }
}

/**
 * Anthropic content-block shape with optional `cache_control`. Mirrors
 * the wire-format documented in the research doc §"Provider 1:
 * Anthropic › Wire Format".
 */
interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral'; ttl?: '1h' | '5m' };
  [key: string]: unknown;
}

function applyAnthropicCacheMarkers(
  messages: BaseMessage[],
  prefixEndIndex: number,
  ttl: '5m' | '1h',
): BaseMessage[] {
  // Anthropic's API accepts `cache_control` either with or without an
  // explicit `ttl` key. The 5-minute TTL is the default if `ttl` is
  // omitted; we still emit it explicitly for unambiguous wire bytes
  // (deterministic byte-for-byte repeat per AC).
  const cacheControl: { type: 'ephemeral'; ttl: '1h' | '5m' } = {
    type: 'ephemeral',
    ttl,
  };

  return messages.map((msg, i) => {
    if (i > prefixEndIndex) return msg;

    // Normalize the message's content to an array of content blocks.
    // For string content, we wrap as a single text block. For array
    // content, we deep-copy entries so the original is never mutated.
    const rawContent = msg.content as
      | string
      | Array<Record<string, unknown>>;

    const contentArr: AnthropicTextBlock[] = Array.isArray(rawContent)
      ? rawContent.map((block) => ({ ...(block as AnthropicTextBlock) }))
      : [{ type: 'text', text: rawContent }];

    if (contentArr.length === 0) {
      // Edge case: empty content array; nothing to cache. Return the
      // original message untouched.
      return msg;
    }

    // Mark the LAST block of the cached message with cache_control.
    const lastIdx = contentArr.length - 1;
    contentArr[lastIdx] = {
      ...contentArr[lastIdx]!,
      cache_control: cacheControl,
    };

    return cloneMessageWithContent(msg, contentArr);
  });
}

function cloneMessageWithContent(
  source: BaseMessage,
  content: AnthropicTextBlock[],
): BaseMessage {
  // `content` is typed as Anthropic-style text blocks but BaseMessage
  // accepts any MessageContent shape; cast through unknown so TS does
  // not require us to teach it the LangChain MessageContentComplex
  // hierarchy from here.
  const langchainContent = content as unknown as BaseMessage['content'];

  if (source instanceof SystemMessage) {
    return new SystemMessage({ content: langchainContent });
  }
  if (source instanceof HumanMessage) {
    return new HumanMessage({ content: langchainContent });
  }
  if (source instanceof AIMessage) {
    return new AIMessage({ content: langchainContent });
  }
  // For any other BaseMessage subtype, attempt to reconstruct via the
  // constructor with `{ content }` — every standard LangChain message
  // type accepts that shape. We go through `unknown` because TS's
  // intrinsic `Function` typing for `.constructor` does not carry the
  // subtype's call signature.
  const Ctor = (source as unknown as {
    constructor: new (input: { content: unknown }) => BaseMessage;
  }).constructor;
  return new Ctor({ content: langchainContent });
}

/**
 * Cache-usage extraction from an AIMessage response (Stage-2's
 * `await llm.invoke(messages)` return value).
 *
 * Input: a `Record<string, unknown>` typically obtained as either
 *   - `response.response_metadata` (LangChain's normalized field), OR
 *   - `response.usage_metadata.input_token_details` (LangChain's
 *      normalized usage shape introduced with the 0.3.x usage_metadata
 *      contract), OR
 *   - the raw provider response payload.
 *
 * The helper is defensive: it accepts any of those shapes by walking
 * the well-known nested keys.
 *
 * Returns:
 *   `{ cachedTokens, cacheCreationTokens, provider }` where:
 *     - `provider` is `'anthropic'` if any Anthropic-shape key is
 *       found (`cache_read_input_tokens`,
 *       `cache_creation_input_tokens`, or LangChain's
 *       `input_token_details.cache_read` /
 *       `input_token_details.cache_creation`),
 *     - `provider` is `'openai-compat'` if `prompt_tokens_details
 *       .cached_tokens` is found,
 *     - `provider` is `'unknown'` and both counts are 0 otherwise.
 *
 * The shape is consumed by §14.M's `composite_stage2_run` JSONL event
 * (fields `providerCacheCreation` / `providerCacheRead`).
 */
export function extractCacheUsage(
  responseMetadata: Record<string, unknown>,
): {
  cachedTokens: number;
  cacheCreationTokens: number;
  provider: 'anthropic' | 'openai-compat' | 'unknown';
} {
  // ---- Anthropic shapes ------------------------------------------------

  // Direct provider shape: top-level `usage` with
  // `cache_read_input_tokens` / `cache_creation_input_tokens`.
  const usageDirect = pickRecord(responseMetadata, 'usage');
  if (usageDirect) {
    const cacheRead = numericOrZero(usageDirect.cache_read_input_tokens);
    const cacheCreate = numericOrZero(usageDirect.cache_creation_input_tokens);
    if (cacheRead > 0 || cacheCreate > 0 ||
        'cache_read_input_tokens' in usageDirect ||
        'cache_creation_input_tokens' in usageDirect) {
      return {
        cachedTokens: cacheRead,
        cacheCreationTokens: cacheCreate,
        provider: 'anthropic',
      };
    }
  }

  // Top-level (responseMetadata IS the usage record).
  if ('cache_read_input_tokens' in responseMetadata ||
      'cache_creation_input_tokens' in responseMetadata) {
    return {
      cachedTokens: numericOrZero(responseMetadata.cache_read_input_tokens),
      cacheCreationTokens: numericOrZero(responseMetadata.cache_creation_input_tokens),
      provider: 'anthropic',
    };
  }

  // LangChain `usage_metadata.input_token_details.{cache_read,cache_creation}`.
  const usageMeta = pickRecord(responseMetadata, 'usage_metadata');
  const inputDetails = usageMeta ? pickRecord(usageMeta, 'input_token_details') : undefined;
  if (inputDetails && ('cache_read' in inputDetails || 'cache_creation' in inputDetails)) {
    return {
      cachedTokens: numericOrZero(inputDetails.cache_read),
      cacheCreationTokens: numericOrZero(inputDetails.cache_creation),
      provider: 'anthropic',
    };
  }

  // ---- OpenAI / Azure / LiteLLM-OpenAI ---------------------------------

  // `response_metadata.token_usage.prompt_tokens_details.cached_tokens`.
  const tokenUsage = pickRecord(responseMetadata, 'token_usage');
  const promptDetailsTok = tokenUsage
    ? pickRecord(tokenUsage, 'prompt_tokens_details')
    : undefined;
  if (promptDetailsTok && 'cached_tokens' in promptDetailsTok) {
    return {
      cachedTokens: numericOrZero(promptDetailsTok.cached_tokens),
      cacheCreationTokens: 0,
      provider: 'openai-compat',
    };
  }

  // Direct: `usage.prompt_tokens_details.cached_tokens`.
  const promptDetailsUsage = usageDirect
    ? pickRecord(usageDirect, 'prompt_tokens_details')
    : undefined;
  if (promptDetailsUsage && 'cached_tokens' in promptDetailsUsage) {
    return {
      cachedTokens: numericOrZero(promptDetailsUsage.cached_tokens),
      cacheCreationTokens: 0,
      provider: 'openai-compat',
    };
  }

  // Top-level prompt_tokens_details (rare).
  const promptDetailsTop = pickRecord(responseMetadata, 'prompt_tokens_details');
  if (promptDetailsTop && 'cached_tokens' in promptDetailsTop) {
    return {
      cachedTokens: numericOrZero(promptDetailsTop.cached_tokens),
      cacheCreationTokens: 0,
      provider: 'openai-compat',
    };
  }

  // ---- Unknown ---------------------------------------------------------

  return { cachedTokens: 0, cacheCreationTokens: 0, provider: 'unknown' };
}

/* ---------- internal helpers ----------------------------------------- */

function pickRecord(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const v = obj[key];
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return undefined;
}

function numericOrZero(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
