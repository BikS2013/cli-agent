/**
 * Co-located tests for the U-CACHE prompt-cache helper
 * (`./llm-cache.ts`). Hermetic — no LLM calls; messages are built
 * directly from `@langchain/core/messages`.
 */

import { describe, expect, it } from 'vitest';
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';

import {
  extractCacheUsage,
  isProviderFamilyCachable,
  resolveProviderFamily,
  withSynthesisCache,
} from './llm-cache.js';
import type { ProviderFamily } from './types.js';
import type { AgentConfig, ProviderName } from '../../config/agent-config.js';

/* ------------------------------------------------------------------ */
/* Test fixtures                                                       */
/* ------------------------------------------------------------------ */

/**
 * Minimal AgentConfig stub. Only the two fields the helper actually
 * reads — `provider` and `model` — are populated; the rest is cast
 * through `unknown` because the helper does not touch them.
 */
function makeCfg(provider: ProviderName, model = ''): AgentConfig {
  return { provider, model } as unknown as AgentConfig;
}

function buildStage2Messages(): BaseMessage[] {
  return [
    new SystemMessage({ content: 'STATIC_SYSTEM_PROMPT_ABOVE_1024_TOKENS' }),
    new HumanMessage({
      content: [
        { type: 'text', text: 'MEMBERS_BLOCK' },
        { type: 'text', text: 'COMPOSE_INSTRUCTION_DYNAMIC' },
      ],
    }),
  ];
}

/* ------------------------------------------------------------------ */
/* resolveProviderFamily                                               */
/* ------------------------------------------------------------------ */

describe('resolveProviderFamily', () => {
  it.each<[ProviderName, ProviderFamily]>([
    ['anthropic', 'anthropic'],
    ['azure-anthropic', 'anthropic'],
    ['openai', 'openai'],
    ['azure-openai', 'azure-openai'],
    ['gemini', 'google-gemini'],
    ['ollama', 'ollama'],
    ['mlx', 'local-compat'],
  ])('maps %s → %s', (provider, expected) => {
    expect(resolveProviderFamily(makeCfg(provider))).toBe(expected);
  });

  it('routes litellm by model prefix → litellm-anthropic', () => {
    expect(
      resolveProviderFamily(makeCfg('litellm', 'anthropic/claude-sonnet-4-6')),
    ).toBe('litellm-anthropic');
  });

  it('routes litellm without anthropic prefix → litellm-openai', () => {
    expect(resolveProviderFamily(makeCfg('litellm', 'gpt-4o'))).toBe('litellm-openai');
    expect(resolveProviderFamily(makeCfg('litellm', ''))).toBe('litellm-openai');
  });

  it('returns local-compat for unknown providers (forward-compatible no-op)', () => {
    const cfg = { provider: 'novel-future-provider', model: 'x' } as unknown as AgentConfig;
    expect(resolveProviderFamily(cfg)).toBe('local-compat');
  });
});

/* ------------------------------------------------------------------ */
/* isProviderFamilyCachable                                            */
/* ------------------------------------------------------------------ */

describe('isProviderFamilyCachable', () => {
  it('returns true for explicit-marker families only', () => {
    expect(isProviderFamilyCachable('anthropic')).toBe(true);
    expect(isProviderFamilyCachable('litellm-anthropic')).toBe(true);
  });

  it('returns false for automatic / no-API families', () => {
    const others: ProviderFamily[] = [
      'openai',
      'azure-openai',
      'azure-inference',
      'litellm-openai',
      'google-gemini',
      'ollama',
      'local-compat',
    ];
    for (const f of others) {
      expect(isProviderFamilyCachable(f)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ */
/* withSynthesisCache — Anthropic family                               */
/* ------------------------------------------------------------------ */

describe('withSynthesisCache — anthropic', () => {
  it('marks the last content block of each cached message with cache_control (ttl=5m default)', () => {
    const messages = buildStage2Messages();
    const out = withSynthesisCache(messages, {
      providerFamily: 'anthropic',
      prefixEndIndex: 1,
    });

    expect(out).toHaveLength(2);

    // Message 0 (SystemMessage with string content) → normalized to a
    // single text block with cache_control.
    const sysContent = out[0]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(sysContent)).toBe(true);
    expect(sysContent).toEqual([
      {
        type: 'text',
        text: 'STATIC_SYSTEM_PROMPT_ABOVE_1024_TOKENS',
        cache_control: { type: 'ephemeral', ttl: '5m' },
      },
    ]);

    // Message 1 (HumanMessage with two-block content) → only the LAST
    // block carries cache_control. The first block is cloned but
    // unmarked.
    const humanContent = out[1]!.content as Array<Record<string, unknown>>;
    expect(humanContent).toHaveLength(2);
    expect(humanContent[0]).toEqual({ type: 'text', text: 'MEMBERS_BLOCK' });
    expect(humanContent[1]).toEqual({
      type: 'text',
      text: 'COMPOSE_INSTRUCTION_DYNAMIC',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });
  });

  it('honours anthropicTtl=1h override', () => {
    const messages = buildStage2Messages();
    const out = withSynthesisCache(messages, {
      providerFamily: 'anthropic',
      prefixEndIndex: 0,
      anthropicTtl: '1h',
    });
    const sysContent = out[0]!.content as Array<Record<string, unknown>>;
    expect(sysContent[0]).toEqual({
      type: 'text',
      text: 'STATIC_SYSTEM_PROMPT_ABOVE_1024_TOKENS',
      cache_control: { type: 'ephemeral', ttl: '1h' },
    });
    // Message 1 not in prefix range → returned as-is.
    expect(out[1]).toBe(messages[1]);
  });

  it('does not mutate the input message array', () => {
    const messages = buildStage2Messages();
    const inputSnapshot = JSON.stringify(
      messages.map((m) => ({ type: m._getType(), content: m.content })),
    );
    withSynthesisCache(messages, { providerFamily: 'anthropic', prefixEndIndex: 1 });
    const after = JSON.stringify(
      messages.map((m) => ({ type: m._getType(), content: m.content })),
    );
    expect(after).toBe(inputSnapshot);
  });

  it('clones SystemMessage / HumanMessage as the same subtype', () => {
    const messages = buildStage2Messages();
    const out = withSynthesisCache(messages, {
      providerFamily: 'anthropic',
      prefixEndIndex: 1,
    });
    expect(out[0]).toBeInstanceOf(SystemMessage);
    expect(out[1]).toBeInstanceOf(HumanMessage);
  });

  it('is deterministic byte-for-byte across repeated calls', () => {
    const messages = buildStage2Messages();
    const a = withSynthesisCache(messages, {
      providerFamily: 'anthropic',
      prefixEndIndex: 1,
      anthropicTtl: '1h',
    });
    const b = withSynthesisCache(buildStage2Messages(), {
      providerFamily: 'anthropic',
      prefixEndIndex: 1,
      anthropicTtl: '1h',
    });
    expect(JSON.stringify(a.map((m) => m.content))).toBe(
      JSON.stringify(b.map((m) => m.content)),
    );
  });

  it('treats litellm-anthropic identically to anthropic', () => {
    const messages = buildStage2Messages();
    const a = withSynthesisCache(messages, {
      providerFamily: 'anthropic',
      prefixEndIndex: 1,
    });
    const b = withSynthesisCache(buildStage2Messages(), {
      providerFamily: 'litellm-anthropic',
      prefixEndIndex: 1,
    });
    expect(JSON.stringify(a.map((m) => m.content))).toBe(
      JSON.stringify(b.map((m) => m.content)),
    );
  });

  it('handles an empty content array as a no-op for that message', () => {
    const messages: BaseMessage[] = [
      new HumanMessage({ content: [] }),
      new HumanMessage({ content: 'tail' }),
    ];
    const out = withSynthesisCache(messages, {
      providerFamily: 'anthropic',
      prefixEndIndex: 1,
    });
    // First message: identity (empty array — nothing to mark).
    expect(out[0]).toBe(messages[0]);
    // Second message: marked.
    const tail = out[1]!.content as Array<Record<string, unknown>>;
    expect(tail).toEqual([
      { type: 'text', text: 'tail', cache_control: { type: 'ephemeral', ttl: '5m' } },
    ]);
  });
});

/* ------------------------------------------------------------------ */
/* withSynthesisCache — pass-through families                          */
/* ------------------------------------------------------------------ */

describe('withSynthesisCache — pass-through families', () => {
  const passThroughs: ProviderFamily[] = [
    'openai',
    'azure-openai',
    'azure-inference',
    'litellm-openai',
    'google-gemini',
    'ollama',
    'local-compat',
  ];

  for (const family of passThroughs) {
    it(`returns identical messages for family=${family}`, () => {
      const messages = buildStage2Messages();
      const out = withSynthesisCache(messages, {
        providerFamily: family,
        prefixEndIndex: 1,
      });
      expect(out).toHaveLength(messages.length);
      // Same instances, same content — no mutation, no clone.
      expect(out[0]).toBe(messages[0]);
      expect(out[1]).toBe(messages[1]);
    });
  }

  it('returns a new array container (caller can mutate freely)', () => {
    const messages = buildStage2Messages();
    const out = withSynthesisCache(messages, {
      providerFamily: 'openai',
      prefixEndIndex: 1,
    });
    expect(out).not.toBe(messages);
  });
});

/* ------------------------------------------------------------------ */
/* extractCacheUsage                                                   */
/* ------------------------------------------------------------------ */

describe('extractCacheUsage — anthropic shapes', () => {
  it('reads cache_read/creation_input_tokens from response_metadata.usage', () => {
    const meta = {
      usage: {
        input_tokens: 50,
        output_tokens: 200,
        cache_read_input_tokens: 1234,
        cache_creation_input_tokens: 5678,
      },
    };
    expect(extractCacheUsage(meta)).toEqual({
      cachedTokens: 1234,
      cacheCreationTokens: 5678,
      provider: 'anthropic',
    });
  });

  it('reads top-level cache_*_input_tokens (when meta IS the usage record)', () => {
    const meta = {
      cache_read_input_tokens: 42,
      cache_creation_input_tokens: 0,
    };
    expect(extractCacheUsage(meta)).toEqual({
      cachedTokens: 42,
      cacheCreationTokens: 0,
      provider: 'anthropic',
    });
  });

  it('reads LangChain usage_metadata.input_token_details shape', () => {
    const meta = {
      usage_metadata: {
        input_tokens: 1500,
        output_tokens: 300,
        input_token_details: {
          cache_read: 1000,
          cache_creation: 400,
        },
      },
    };
    expect(extractCacheUsage(meta)).toEqual({
      cachedTokens: 1000,
      cacheCreationTokens: 400,
      provider: 'anthropic',
    });
  });

  it('reports zero cache reads when keys are present but zero', () => {
    const meta = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    };
    expect(extractCacheUsage(meta)).toEqual({
      cachedTokens: 0,
      cacheCreationTokens: 0,
      provider: 'anthropic',
    });
  });
});

describe('extractCacheUsage — openai-compat shapes', () => {
  it('reads response_metadata.token_usage.prompt_tokens_details.cached_tokens', () => {
    const meta = {
      token_usage: {
        prompt_tokens: 2000,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    };
    expect(extractCacheUsage(meta)).toEqual({
      cachedTokens: 1024,
      cacheCreationTokens: 0,
      provider: 'openai-compat',
    });
  });

  it('reads usage.prompt_tokens_details.cached_tokens (direct provider shape)', () => {
    const meta = {
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 300,
        prompt_tokens_details: { cached_tokens: 768 },
      },
    };
    expect(extractCacheUsage(meta)).toEqual({
      cachedTokens: 768,
      cacheCreationTokens: 0,
      provider: 'openai-compat',
    });
  });

  it('reads top-level prompt_tokens_details.cached_tokens', () => {
    const meta = {
      prompt_tokens_details: { cached_tokens: 256 },
    };
    expect(extractCacheUsage(meta)).toEqual({
      cachedTokens: 256,
      cacheCreationTokens: 0,
      provider: 'openai-compat',
    });
  });
});

describe('extractCacheUsage — unknown / empty shapes', () => {
  it('returns all zeros / unknown for an empty record', () => {
    expect(extractCacheUsage({})).toEqual({
      cachedTokens: 0,
      cacheCreationTokens: 0,
      provider: 'unknown',
    });
  });

  it('returns all zeros / unknown for a non-recognised shape', () => {
    const meta = {
      foo: 'bar',
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    expect(extractCacheUsage(meta)).toEqual({
      cachedTokens: 0,
      cacheCreationTokens: 0,
      provider: 'unknown',
    });
  });

  it('coerces non-numeric token counts to 0 (defensive parsing)', () => {
    const meta = {
      usage: {
        cache_read_input_tokens: 'NaN-string',
        cache_creation_input_tokens: null,
      },
    };
    expect(extractCacheUsage(meta)).toEqual({
      cachedTokens: 0,
      cacheCreationTokens: 0,
      provider: 'anthropic',
    });
  });
});

/* ------------------------------------------------------------------ */
/* End-to-end: extract from a synthetic AIMessage's response_metadata  */
/* ------------------------------------------------------------------ */

describe('extractCacheUsage — applied to a synthetic AIMessage.response_metadata', () => {
  it('Anthropic AIMessage', () => {
    const ai = new AIMessage({
      content: 'response text',
      response_metadata: {
        usage: {
          input_tokens: 100,
          output_tokens: 200,
          cache_read_input_tokens: 800,
          cache_creation_input_tokens: 0,
        },
      },
    });
    expect(extractCacheUsage(ai.response_metadata)).toEqual({
      cachedTokens: 800,
      cacheCreationTokens: 0,
      provider: 'anthropic',
    });
  });

  it('OpenAI AIMessage', () => {
    const ai = new AIMessage({
      content: 'response text',
      response_metadata: {
        token_usage: {
          prompt_tokens: 1200,
          completion_tokens: 400,
          prompt_tokens_details: { cached_tokens: 1024 },
        },
      },
    });
    expect(extractCacheUsage(ai.response_metadata)).toEqual({
      cachedTokens: 1024,
      cacheCreationTokens: 0,
      provider: 'openai-compat',
    });
  });
});
