---
topic: LLM Prompt Caching — Provider Wire Format & LangChain API
related_investigation: docs/reference/investigation-composite-tools.md
related_feature: composite-intelligent-tools (plan-006)
created_at: "2026-05-02"
depth: implementation-ready
---

# LLM Prompt Caching — Provider Wire Format & LangChain/LangGraph API

## Overview

This document is the implementation-ready research companion for the composite-tools synthesis pipeline (plan-006). It answers the question surfaced in `investigation-composite-tools.md` §"Technical Research Guidance — Topic 1": what is the exact wire format, minimum-token threshold, TTL, and LangChain TypeScript API for prompt caching across the 8 standard providers that cli-agent supports?

The synthesis pipeline (Stage-2 in particular) is the primary consumer. Stage-2 assembles a prompt of the form:

```
[system prompt — static, invariant across all composite invocations]
[per-member distilled summaries — stable per member; changes only when a member doc changes]
[compose instruction — variable tail]
```

Provider-side prompt caching saves the KV computation for the static prefix so that when Stage-2 re-runs (e.g., the user re-synthesizes after changing one member), only the variable tail pays full token cost.

**Critical upfront finding for the synthesis pipeline**: Stage-1 distillation outputs are designed to be ~2 KB of structured text. At ~4 characters per token, 2 KB ≈ 500 tokens per member distillation. Even for a 5-member composite the Stage-1 outputs feeding Stage-2 would total roughly 2,500 tokens across all members — but the system prompt + invariant header is where caching matters most, not the per-member payloads. See §"Architecture Findings" for the full analysis.

---

## Decision Table — Provider Cache Support Summary

| Provider | Cache Support | Activation | Min Tokens | TTL | Cost Impact | Verify With |
|----------|--------------|------------|-----------|-----|-------------|-------------|
| **Anthropic** (direct) | Explicit, granular | `cache_control: {type:"ephemeral"}` on content blocks | 1024 (Claude Sonnet 4.x / 4.6); 4096 (Haiku 4.5+, Opus 4.5+, Opus 4.6) | 5 min (default) or 1 h (`"ttl":"1h"`) | Write: 1.25×; Read: 0.1× (5-min) | `usage_metadata.cache_read_input_tokens` |
| **OpenAI** (direct) | Automatic, no markers | Prefix must be identical and ≥1024 tokens | 1024 | 5–10 min (in-memory), up to 24 h (extended) | Read: 0.5× input price (50% discount) | `usage.prompt_tokens_details.cached_tokens` |
| **Google Gemini** (direct) | Explicit (API object) + implicit (2.5+) | Explicit: `caches.create()` + `cachedContent` ref; Implicit: automatic on 2.5+ | Explicit: ~32,768 tokens minimum; Implicit: 1024 (Flash) / 4096 (Pro) | Explicit default: 1 h (configurable); Implicit: automatic | Explicit: 75–90% discount on cached reads | `response.usageMetadata.cachedContentTokenCount` |
| **Azure OpenAI** | Automatic (same as OpenAI) | Identical prefix ≥1024 tokens | 1024 | 5–10 min typical; up to 1 h; 24 h via `x-prompt-cache-retention` (rolling out) | Read: 50% discount (Provisioned: up to 100%) | `usage.prompt_tokens_details.cached_tokens` |
| **Azure AI Inference** | Automatic (service-level) | Identical prefix ≥1024 tokens | 1024 | 5–10 min; always cleared within 1 h | Same as Azure OpenAI | `usage.prompt_tokens_details.cached_tokens` |
| **Ollama** | Local KV / LRU prefix reuse (no API surface) | Automatic internal LRU | N/A — model-resident | Model keep-alive (default 5 min; set `keep_alive` param) | No billing | Not accessible via response object |
| **LiteLLM** (proxy) | Passthrough: translates `cache_control` to each upstream | Anthropic: explicit markers; OpenAI/Azure: auto; Gemini: translated | Same as upstream provider | Same as upstream | Same as upstream | Same as upstream + LiteLLM normalizes to `prompt_tokens_details.cached_tokens` |
| **MLX / llama.cpp** (OpenAI-compat) | Local KV cache only — no API surface | Automatic (model-level) | N/A | Process lifetime (no eviction API) | No billing | Not accessible |

---

## Provider 1: Anthropic (`@langchain/anthropic`)

### Mechanism

Anthropic uses explicit cache-breakpoint markers. You annotate specific content blocks with `cache_control: { type: "ephemeral" }`. The API caches all tokens up to and including the marked block. Up to **4 breakpoints** are allowed per request.

### Current Minimum Token Thresholds (as of May 2026)

| Model family | Min tokens for caching |
|---|---|
| Claude Sonnet 4, 4.5, 4.6 | **1,024** |
| Claude Opus 4, 4.1 | **1,024** |
| Claude Opus 4.5, 4.6 | **4,096** |
| Claude Haiku 4.5+ | **4,096** |
| Claude Haiku 3.5 (deprecated) | 2,048 |
| Claude Sonnet 3.7 (deprecated) | 1,024 |

**Important**: The documented threshold for some Claude 3.x models was 1,024; the Claude 4.x family has diverged. Always check `cache_creation_input_tokens` in the response — if it is 0, the prefix did not meet the threshold. No error is returned.

**Model deprecation note**: Claude Sonnet 4 (`claude-sonnet-4-20250514`) and Claude Opus 4 (`claude-opus-4-20250514`) are scheduled for retirement on the Claude API on June 15, 2026. Migrate to claude-sonnet-4-6 and claude-opus-4-7.

### TTL

- Default: **5 minutes**. Refreshed on each cache hit.
- Extended: **1 hour** via `"ttl": "1h"` in the `cache_control` field. Write cost is 2× base input price at 1-hour TTL vs 1.25× at 5-minute TTL.

### Cache Isolation (Important — February 2026 Change)

Starting February 5, 2026, Anthropic uses **workspace-level** cache isolation (was organization-level). This means caches are not shared across workspaces within the same organization. This is relevant if cli-agent is deployed across multiple API workspaces.

### Wire Format

The JSON sent to `api.anthropic.com/v1/messages` looks like:

```json
{
  "model": "claude-sonnet-4-6",
  "system": [
    {
      "type": "text",
      "text": "<static system prompt — 1024+ tokens>",
      "cache_control": { "type": "ephemeral" }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "text",
          "text": "<stable per-member distillations>",
          "cache_control": { "type": "ephemeral" }
        },
        {
          "type": "text",
          "text": "<dynamic compose instruction>"
        }
      ]
    }
  ]
}
```

For the 1-hour TTL variant, the `cache_control` block becomes:
```json
{ "type": "ephemeral", "ttl": "1h" }
```

The `anthropic-beta: prompt-caching-2024-07-31` header is **no longer required** as of current Anthropic API versions — caching is enabled by default when `cache_control` markers are present.

### Verifying Cache Hits

Check the response `usage` object:

```typescript
// First call: expect cache_creation_input_tokens > 0, cache_read_input_tokens = 0
// Second call: expect cache_creation_input_tokens = 0, cache_read_input_tokens > 0
const usage = response.usage_metadata;
console.log({
  cacheCreation: usage?.input_token_details?.cache_creation,
  cacheRead:     usage?.input_token_details?.cache_read,
});
```

In raw `response_metadata.usage` from `@langchain/anthropic`:
- `cache_creation_input_tokens` — tokens written to cache this call (billed at 1.25× or 2×)
- `cache_read_input_tokens` — tokens read from cache (billed at 0.1×)

### LangChain TypeScript Code Pattern

**Pattern 1 — Direct `SystemMessage` content block (recommended for Stage-2 static prefix):**

```typescript
import { ChatAnthropic } from "@langchain/anthropic";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

const model = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  // No special client options needed for caching as of current API
});

// BREAKPOINT 1: static system prompt (must be ≥1024 tokens to cache)
const systemMsg = new SystemMessage({
  content: [
    {
      type: "text",
      text: STATIC_SYSTEM_PROMPT, // synthesis pipeline's invariant header
      cache_control: { type: "ephemeral" },
    },
  ],
});

// BREAKPOINT 2: stable per-member distillations (vary per composite, stable per run)
const userMsg = new HumanMessage({
  content: [
    {
      type: "text",
      text: DISTILLED_MEMBERS_BLOCK, // concatenated Stage-1 outputs
      cache_control: { type: "ephemeral" },
    },
    {
      type: "text",
      text: COMPOSE_INSTRUCTION, // variable: the actual "compose this into a composite doc" instruction
    },
  ],
});

const response = await model.invoke([systemMsg, userMsg]);

// Verify cache hit
const usage = response.response_metadata?.usage;
console.log("cache_creation:", usage?.cache_creation_input_tokens);
console.log("cache_read:    ", usage?.cache_read_input_tokens);
```

**Pattern 2 — `anthropicPromptCachingMiddleware` (for agent/chat loop use):**

```typescript
import { createAgent, anthropicPromptCachingMiddleware } from "langchain";

// Automatically places cache breakpoints on system, tools, and last user message
const agent = createAgent({
  model: "claude-sonnet-4-6",
  prompt: STATIC_SYSTEM_PROMPT,
  middleware: [
    anthropicPromptCachingMiddleware({
      ttl: "1h", // Use 1h TTL if synthesis runs more than 5 min apart
    }),
  ],
});
```

The middleware's `ttl` parameter accepts `"5m"` or `"1h"` only.

**Known caveats:**
- `cache_control` must be placed inside the `content` array of the message block, NOT in `additional_kwargs` on the message wrapper — the `additional_kwargs` approach is unreliable with `ChatPromptTemplate`.
- `cache_control` on `HumanMessage` alone does NOT work — the block must be in the content array as shown above.
- When using `anthropicPromptCachingMiddleware` with a model fallback middleware, the `cache_control` kwargs cause errors if the fallback model is non-Anthropic (e.g., OpenAI). Guard with `unsupportedModelBehavior: "ignore"`.

---

## Provider 2: OpenAI (`@langchain/openai` / `ChatOpenAI`)

### Mechanism

OpenAI uses **fully automatic** prompt caching. No markers, no client-side code changes required. The API automatically detects repeated prefixes of ≥1024 tokens and serves cached KV computations. Cache hits occur in **128-token increments** after the initial 1024-token threshold.

### Requirements for a Cache Hit

1. The prompt must be **≥1024 tokens**.
2. The prefix (from the beginning of the messages array) must be **byte-for-byte identical** across requests. One character difference in the first 1024 tokens = cache miss.
3. Requests must reach the same backend node. OpenAI routes based on a hash of the initial prefix (~256 tokens). The `prompt_cache_key` parameter lets you influence routing.

### TTL

- **In-memory (default)**: 5–10 minutes of inactivity; maximum 1 hour. Available for all models except gpt-5.5 and gpt-5.5-pro.
- **Extended (24h)**: Available for gpt-4.1 and newer (gpt-5.x). Set via `prompt_cache_retention: "24h"` on the Responses API. For `gpt-5.5` and newer, `24h` is the default and `in_memory` is not supported.

### Wire Format

No on-the-wire markers — standard OpenAI chat completions format. The response carries cache data in `usage`:

```json
"usage": {
  "prompt_tokens": 2006,
  "completion_tokens": 300,
  "total_tokens": 2306,
  "prompt_tokens_details": {
    "cached_tokens": 1920
  }
}
```

For `prompt_cache_key` routing hint (Responses API):
```json
{
  "model": "gpt-4o",
  "input": [...],
  "prompt_cache_key": "synthesis-stage2-v1",
  "prompt_cache_retention": "24h"
}
```

### LangChain TypeScript Code Pattern

LangChain's `ChatOpenAI` does **not** natively expose `prompt_cache_key` as a first-class parameter. The workaround is to pass it via `model_kwargs` / `extraBody`, or subclass `ChatOpenAI`.

```typescript
import { ChatOpenAI } from "@langchain/openai";

// For basic use: nothing special — caching is automatic if prefix is ≥1024 tokens
const model = new ChatOpenAI({
  model: "gpt-4o",
  // Ensure static content is at the beginning of every invoke() call
});

// To pass prompt_cache_key via extra_body (workaround, no native LangChain support as of 2026):
const modelWithCacheKey = new ChatOpenAI({
  model: "gpt-4o",
}).bind({
  // @ts-ignore — not a typed field in LangChain's ChatOpenAI
  prompt_cache_key: "synthesis-stage2-v1",
});

// Verify hit
const response = await model.invoke(messages);
const cached = response.response_metadata?.usage?.prompt_tokens_details?.cached_tokens ?? 0;
console.log(`Cached tokens: ${cached}`);
```

**Key discipline: prefix stability.** The synthesis pipeline MUST assemble the messages array in a **deterministic byte-for-byte identical** order every time the same prefix is intended. The most common cache-busting mistakes:
- Serializing JSON tool definitions in non-deterministic object-key order
- Inserting timestamps, session IDs, or request IDs into the system message
- Whitespace differences in template rendering

### Verifying Cache Hits

```typescript
const usage = response.response_metadata?.usage;
const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;
if (cachedTokens > 0) {
  console.log(`Cache hit: ${cachedTokens} tokens served from cache`);
}
```

---

## Provider 3: Google Gemini (`@langchain/google-genai` / `ChatGoogleGenerativeAI`)

### Mechanism

Gemini offers two mechanisms:
1. **Implicit caching** (Gemini 2.5+ only): Automatic, no cost guarantee, identical-prefix detection. No code changes needed.
2. **Explicit context caching**: You create a `CachedContent` object via the API, store it (with a TTL), then reference it by name in subsequent generation requests. Guarantees the cache discount.

### Minimum Tokens

| Model | Implicit min | Explicit min |
|---|---|---|
| Gemini 2.5 Flash | 1,024 | ~32,768 (large context files) |
| Gemini 2.5 Pro | 4,096 | ~32,768 |
| Gemini 3 Flash Preview | 1,024 | varies |
| Gemini 3 Pro Preview | 4,096 | varies |

**Practical note**: Explicit caching is designed for very large corpora (video files, large PDFs, book-length documents) — the minimum is typically 32,768 tokens. For the synthesis pipeline, where per-member distillations are ~500 tokens and the system prompt is a few hundred tokens, **explicit Gemini caching is not applicable**. Implicit caching may apply if running Gemini 2.5 and the system prompt is ≥1024 tokens.

### TTL

Explicit cache: default 1 hour; configurable via `ttlSeconds` parameter.

### LangChain TypeScript Code Pattern

**For implicit caching (Gemini 2.5+):** No code changes. Ensure system prompt is at beginning of messages.

**For explicit caching (large-corpus use cases only):**

```typescript
import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import {
  GoogleAICacheManager,
  GoogleAIFileManager,
} from "@google/generative-ai/server";

const cacheManager = new GoogleAICacheManager(process.env.GOOGLE_API_KEY!);

// Step 1: Upload the large document
const fileManager = new GoogleAIFileManager(process.env.GOOGLE_API_KEY!);
const fileResult = await fileManager.uploadFile("path/to/large-corpus.txt", {
  displayName: "synthesis-corpus",
  mimeType: "text/plain",
});

// Step 2: Create the cache (TTL = 1 hour)
const cachedContent = await cacheManager.create({
  model: "models/gemini-2.5-flash",
  displayName: "synthesis-static-context",
  systemInstruction: STATIC_SYSTEM_PROMPT,
  contents: [
    {
      role: "user",
      parts: [
        { fileData: { mimeType: fileResult.file.mimeType, fileUri: fileResult.file.uri } },
      ],
    },
  ],
  ttlSeconds: 3600,
});

// Step 3: Reference the cache in subsequent generation requests
const model = new ChatGoogleGenerativeAI({
  model: "gemini-2.5-flash",
});
const modelWithCache = (model as any).enableCachedContent(cachedContent);

const response = await modelWithCache.invoke([
  new HumanMessage(COMPOSE_INSTRUCTION),
]);

console.log(response.response_metadata?.usageMetadata?.cachedContentTokenCount);
```

**Critical limitation**: When `cachedContent` is used, you **cannot** also pass `tools` or `systemInstruction` in the `GenerateContent` request body — they must be baked into the cache at creation time. This makes the explicit cache incompatible with LangChain's standard `bind_tools()` / agent pattern.

**Deprecation warning**: `@langchain/google-genai` is being deprecated. New implementations should target the `@langchain/google-genai`'s successor or use the `@google/genai` SDK directly with a thin adapter.

### Verifying Cache Hits

```typescript
const usage = response.response_metadata?.usageMetadata;
console.log("Cached token count:", usage?.cachedContentTokenCount ?? 0);
```

---

## Provider 4: Azure OpenAI (`@langchain/openai` with Azure config)

### Mechanism

Azure OpenAI behaves identically to OpenAI for prompt caching: automatic, no markers, prefix-based. Supported on GPT-4o and newer models.

### Differences from OpenAI Direct

| Aspect | OpenAI | Azure OpenAI |
|---|---|---|
| Activation | Automatic | Automatic |
| Cache key param | `prompt_cache_key` | Same (rolling out) |
| Retention header | `prompt_cache_retention` | `x-prompt-cache-retention` (not yet available on all deployments) |
| Region reliability | Consistent | Variable by region — some regions show 0 cache hits even after 10 identical calls |
| Provisioned deployments | N/A | Up to 100% discount on cached tokens |

**Known issue**: The `x-prompt-cache-retention` header for 24-hour extended caching is documented but not yet enabled across all Azure OpenAI deployments as of May 2026.

### LangChain TypeScript Code Pattern

```typescript
import { AzureChatOpenAI } from "@langchain/openai";

const model = new AzureChatOpenAI({
  model: "gpt-4o",
  azureOpenAIApiVersion: process.env.AZURE_OPENAI_API_VERSION,
  azureOpenAIApiInstanceName: process.env.AZURE_OPENAI_API_INSTANCE_NAME,
  azureOpenAIApiDeploymentName: process.env.AZURE_OPENAI_API_DEPLOYMENT_NAME,
  azureOpenAIApiKey: process.env.AZURE_OPENAI_API_KEY,
});

// Caching is automatic — no additional configuration required
// Ensure prefix stability (same as OpenAI section above)

const response = await model.invoke(messages);
const cachedTokens = response.response_metadata?.usage?.prompt_tokens_details?.cached_tokens ?? 0;
```

---

## Provider 5: Azure AI Inference (`@azure-rest/ai-inference`)

### Mechanism

The `@azure-rest/ai-inference` SDK targets Azure AI Foundry model endpoints (non-OpenAI models served via the Azure AI Inference API). Prompt caching at this endpoint is **automatic at the service level** for supported models — there is no explicit marker API.

### LangChain Integration

As of May 2026, `@langchain/openai` with an Azure AI Inference-compatible base URL is the practical path, since Microsoft's own guidance points developers toward migrating from `@azure-rest/ai-inference` to the OpenAI SDK for broader compatibility. The `@langchain/azure-openai` package or `ChatOpenAI` with a custom `baseURL` is the recommended approach.

```typescript
// No caching API surface — caching is entirely automatic and opaque
// Comment to place in synthesis code:
// Azure AI Inference: no explicit prompt-cache API.
// Caching is applied server-side for identical prefixes ≥1024 tokens.
// Check usage.prompt_tokens_details.cached_tokens in the response.

import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: process.env.AZURE_AI_INFERENCE_MODEL_NAME!,
  openAIApiKey: process.env.AZURE_AI_INFERENCE_KEY,
  configuration: {
    baseURL: process.env.AZURE_AI_INFERENCE_ENDPOINT,
  },
});
```

---

## Provider 6: Ollama (`@langchain/ollama`)

### Mechanism

Ollama provides server-side **KV cache with LRU prefix reuse**. When two consecutive requests share a prefix, Ollama skips re-processing those tokens. There is no client-callable cache API — no markers, no cache-control objects, no usage metadata for cache hits in the HTTP response.

The `keep_alive` parameter controls how long a model stays in memory:
- Default: `5m`
- Set to `-1` to keep loaded indefinitely

### LangChain TypeScript Code Pattern

```typescript
// No caching API; relies on stable prompt prefix and Ollama's internal LRU.
// Ensure messages are assembled in a consistent, stable order.

import { ChatOllama } from "@langchain/ollama";

const model = new ChatOllama({
  model: "llama3.2",
  keepAlive: "30m", // Keep model warm for repeated synthesis calls
});

// Cache verification: not possible via response — inspect Ollama server logs
// or measure latency reduction on second call (TTFT improvement).
```

**Implication for synthesis pipeline**: Ollama has no programmable cache API. The synthesis pipeline should rely on its **on-disk Stage-1 cache** for cost/latency optimization when using Ollama. The provider-side cache is a latency bonus when requests are closely spaced, not a cost control mechanism.

---

## Provider 7: LiteLLM (proxy, OpenAI-compatible interface)

### Mechanism

LiteLLM acts as a translation proxy. It accepts Anthropic-style `cache_control` markers in the request and translates them to the appropriate upstream format:

| Upstream | LiteLLM Translation |
|---|---|
| Anthropic API | Passes `cache_control` through unchanged |
| OpenAI / Azure OpenAI | Strips `cache_control` (automatic caching handles it) |
| Google Gemini | Attempts to translate to prefix-cache; known first-point-only bug (see below) |
| Bedrock | Translates to `cachePoint` blocks |
| Other providers | `cache_control` is silently ignored |

LiteLLM normalizes cache usage metrics to the OpenAI format:
```json
"usage": {
  "prompt_tokens": ...,
  "prompt_tokens_details": { "cached_tokens": ... },
  "cache_creation_input_tokens": ...  // Anthropic only
}
```

### Known Issues

1. **Gemini translation bug** (Issue #17201): LiteLLM uses a "first-found" strategy when translating multiple Anthropic `cache_control` markers to Gemini's prefix cache. Only the first marker (usually system prompt) is translated; all subsequent ones are discarded. This means a two-breakpoint Stage-2 prompt (system + members block) will only cache the system prefix on Gemini via LiteLLM.

2. **Vertex AI + Anthropic caching bug** (Issue #14293): When routing Anthropic models via Vertex AI, LiteLLM incorrectly adds `anthropic-beta: prompt-caching-2024-07-31` which Vertex AI rejects. No workaround other than using the Anthropic API directly.

3. **OpenRouter**: When proxying through OpenRouter, non-Anthropic models may receive `cache_control` fields that cause 404 errors. Fixed in PR #12850 — `cache_control` is stripped for non-Anthropic models.

### LangChain TypeScript Code Pattern

When the cli-agent is configured to use LiteLLM as its provider, the synthesis pipeline can use Anthropic-style `cache_control` markers and LiteLLM handles the translation:

```typescript
import { ChatOpenAI } from "@langchain/openai";

// LiteLLM proxy appears as an OpenAI-compatible endpoint
const model = new ChatOpenAI({
  model: "anthropic/claude-sonnet-4-6", // LiteLLM model routing string
  openAIApiKey: process.env.LITELLM_API_KEY,
  configuration: {
    baseURL: process.env.LITELLM_BASE_URL, // e.g., http://localhost:4000
  },
});

// Use Anthropic-style cache_control in the message payload
// LiteLLM will route these to Anthropic and pass cache_control through
const messages = [
  {
    role: "system" as const,
    content: [
      {
        type: "text",
        text: STATIC_SYSTEM_PROMPT,
        // @ts-ignore — extended field, not in OpenAI types
        cache_control: { type: "ephemeral" },
      },
    ],
  },
  {
    role: "user" as const,
    content: COMPOSE_INSTRUCTION,
  },
];
```

**Auto-inject via proxy config**: LiteLLM can be configured to automatically inject `cache_control` on the system message, removing the need to annotate from the client side:

```yaml
# litellm_config.yaml
model_list:
  - model_name: claude-sonnet-4-6
    litellm_params:
      model: anthropic/claude-sonnet-4-6
      api_key: os.environ/ANTHROPIC_API_KEY
      cache_control_injection_points:
        - location: message
          role: system
```

---

## Provider 8: MLX / llama.cpp (OpenAI-compatible endpoints)

### Mechanism

Both MLX and llama.cpp expose an OpenAI-compatible HTTP server (`/v1/chat/completions`). Neither exposes a prompt-caching API to the client.

**llama.cpp (`llama-server`)**: Internally manages a per-slot KV cache. For multi-user (`--np > 1`) setups, the system prompt can be pre-loaded as a shared prefix via `--system-prompt-file`. The KV cache is RAM-resident only (no persistence). Cache hits are visible in server debug logs but not in the HTTP response body.

**MLX**: Uses a rotating KV cache (default 4k tokens) on Apple Silicon. Prompt cache files can be used to skip recomputation of repeated prefixes, but this is a server-side configuration, not a per-request API.

Neither provides `usage.prompt_tokens_details.cached_tokens` in the response — the field will be absent or zero.

### LangChain TypeScript Code Pattern

```typescript
// No caching API; relies on stable prompt prefix and local KV cache.

import { ChatOpenAI } from "@langchain/openai";

// llama.cpp / MLX server typically binds to localhost:8080 or 11434
const model = new ChatOpenAI({
  model: "local-model", // arbitrary; ignored by the server
  openAIApiKey: "not-needed",
  configuration: {
    baseURL: process.env.LOCAL_LLM_BASE_URL ?? "http://localhost:8080/v1",
  },
});

// Cache verification: not possible via API response.
// Measure TTFT (time-to-first-token) reduction on second call with same prefix.
```

---

## Provider-Agnostic Helper Sketch

The following TypeScript module provides a `withSynthesisCache` helper that the synthesis pipeline can call regardless of provider. Each adapter knows its own cache-marker strategy; providers without explicit cache APIs receive the messages unmodified.

```typescript
// src/agent/composite/synthesis-cache.ts

import type { BaseMessage } from "@langchain/core/messages";
import { SystemMessage, HumanMessage } from "@langchain/core/messages";

export type ProviderFamily =
  | "anthropic"
  | "openai"
  | "azure-openai"
  | "azure-inference"
  | "google-gemini"
  | "litellm-anthropic"
  | "litellm-openai"
  | "ollama"
  | "local-compat"; // llama.cpp / MLX

export interface SynthesisCacheOptions {
  /** Which provider family the resolved LLM belongs to */
  providerFamily: ProviderFamily;
  /**
   * Index into `messages` up to which content is considered "stable prefix".
   * Messages 0..prefixEndIndex are marked for caching on providers that support it.
   * Typically: 0 = system prompt, 1 = distilled members block.
   */
  prefixEndIndex: number;
  /** Anthropic TTL: "5m" | "1h". Ignored for other providers. Default "5m". */
  anthropicTtl?: "5m" | "1h";
}

/**
 * Annotates a messages array with provider-specific cache markers up to
 * `prefixEndIndex`. For providers without an explicit marker API, the
 * messages are returned unmodified (caching relies on prefix stability alone).
 *
 * IMPORTANT: Call this function with the SAME messages every time to ensure
 * byte-for-byte identical prefixes for providers that use automatic caching.
 */
export function withSynthesisCache(
  messages: BaseMessage[],
  options: SynthesisCacheOptions,
): BaseMessage[] {
  const { providerFamily, prefixEndIndex, anthropicTtl = "5m" } = options;

  switch (providerFamily) {
    case "anthropic":
    case "litellm-anthropic":
      return applyAnthropicCacheMarkers(messages, prefixEndIndex, anthropicTtl);

    case "openai":
    case "azure-openai":
    case "azure-inference":
    case "litellm-openai":
      // Automatic caching — no markers needed.
      // Caller MUST ensure messages 0..prefixEndIndex are identical byte-for-byte.
      return messages;

    case "google-gemini":
      // Implicit caching on Gemini 2.5+ requires no action.
      // Explicit cache (large corpora) is out of scope for synthesis pipeline.
      return messages;

    case "ollama":
    case "local-compat":
      // No cache API — return messages unmodified.
      return messages;

    default:
      return messages;
  }
}

function applyAnthropicCacheMarkers(
  messages: BaseMessage[],
  prefixEndIndex: number,
  ttl: "5m" | "1h",
): BaseMessage[] {
  const ttlSeconds = ttl === "1h" ? 3600 : 300;
  const cacheControl: Record<string, unknown> =
    ttl === "1h"
      ? { type: "ephemeral", ttl: "1h" }
      : { type: "ephemeral" };

  return messages.map((msg, i) => {
    if (i > prefixEndIndex) return msg;

    const contentArr = Array.isArray(msg.content) ? msg.content : [{ type: "text", text: msg.content }];

    // Mark the LAST content block of this message with cache_control.
    const markedContent = contentArr.map((block: Record<string, unknown>, blockIdx: number) => {
      if (blockIdx !== contentArr.length - 1) return block;
      return { ...block, cache_control: cacheControl };
    });

    if (msg instanceof SystemMessage) {
      return new SystemMessage({ content: markedContent as any });
    }
    if (msg instanceof HumanMessage) {
      return new HumanMessage({ content: markedContent as any });
    }
    // For other message types, return with modified content
    return msg.constructor
      ? new (msg.constructor as any)({ content: markedContent })
      : msg;
  });
}

/**
 * Inspects a LangChain AIMessage response to report how many tokens
 * were served from the provider-side cache.
 */
export function extractCacheUsage(responseMetadata: Record<string, unknown>): {
  cachedTokens: number;
  cacheCreationTokens: number;
  provider: "anthropic" | "openai-compat" | "unknown";
} {
  const usage = (responseMetadata?.usage ?? responseMetadata) as Record<string, unknown>;

  // Anthropic shape
  if ("cache_read_input_tokens" in usage || "cache_creation_input_tokens" in usage) {
    return {
      provider: "anthropic",
      cachedTokens: (usage.cache_read_input_tokens as number) ?? 0,
      cacheCreationTokens: (usage.cache_creation_input_tokens as number) ?? 0,
    };
  }

  // OpenAI / Azure / LiteLLM normalized shape
  const details = usage?.prompt_tokens_details as Record<string, unknown> | undefined;
  if (details?.cached_tokens !== undefined) {
    return {
      provider: "openai-compat",
      cachedTokens: (details.cached_tokens as number) ?? 0,
      cacheCreationTokens: 0,
    };
  }

  return { provider: "unknown", cachedTokens: 0, cacheCreationTokens: 0 };
}
```

### Resolving `providerFamily` from `cfg`

The synthesis pipeline should resolve `providerFamily` at initialization time from the cli-agent's resolved configuration:

```typescript
// src/agent/composite/synthesizer.ts (sketch)

import { withSynthesisCache, type ProviderFamily } from "./synthesis-cache.js";

function resolveProviderFamily(cfg: AgentConfig): ProviderFamily {
  const provider = cfg.llmProvider; // "anthropic" | "openai" | "azure-openai" | etc.
  const modelId = cfg.modelId ?? "";

  switch (provider) {
    case "anthropic": return "anthropic";
    case "openai":    return "openai";
    case "azure-openai": return "azure-openai";
    case "azure-inference": return "azure-inference";
    case "google-gemini": return "google-gemini";
    case "litellm":
      // LiteLLM routes based on model prefix
      return modelId.startsWith("anthropic/") ? "litellm-anthropic" : "litellm-openai";
    case "ollama":    return "ollama";
    case "mlx":
    case "llama-cpp": return "local-compat";
    default:          return "local-compat";
  }
}
```

---

## Stage-2 Prompt Assembly with Correct Breakpoint Placement

For the two-stage synthesis pipeline, the recommended message layout is:

```
Message[0] — SystemMessage
  Block[0]: static system prompt (synthesizer identity + formatting rules)
             CACHE BREAKPOINT HERE  ← marks everything up to this block
  
Message[1] — HumanMessage
  Block[0]: concatenated Stage-1 distillation outputs for all members
             (stable per composite; changes only when a member's doc changes)
             CACHE BREAKPOINT HERE (2nd breakpoint — Anthropic supports up to 4)
  Block[1]: compose instruction (dynamic: may include composite name, date, requested sections)
             NO cache marker
```

On Anthropic, this means two `cache_control` breakpoints. On OpenAI/Azure, no markers — the messages array itself IS the prefix and must be byte-identical up to Block[1] on repeated calls.

### Stage-2 Assembly Code

```typescript
// src/agent/composite/stage2.ts (sketch)

import { SystemMessage, HumanMessage } from "@langchain/core/messages";
import { withSynthesisCache } from "./synthesis-cache.js";
import type { AgentConfig } from "../config.js";
import type { DistillationResult } from "./stage1.js";

export function buildStage2Messages(
  staticSystemPrompt: string,
  distillations: DistillationResult[],
  composeInstruction: string,
  cfg: AgentConfig,
): ReturnType<typeof withSynthesisCache> {
  const membersBlock = distillations
    .map((d) => `## ${d.memberName}\n${d.content}`)
    .join("\n\n---\n\n");

  const rawMessages = [
    new SystemMessage({ content: staticSystemPrompt }),
    new HumanMessage({
      content: [
        { type: "text" as const, text: membersBlock },
        { type: "text" as const, text: composeInstruction },
      ],
    }),
  ];

  return withSynthesisCache(rawMessages, {
    providerFamily: resolveProviderFamily(cfg),
    prefixEndIndex: 1, // cache system (0) + members block (1)
    anthropicTtl: "1h", // synthesis typically runs minutes apart; prefer 1h
  });
}
```

---

## Architecture Findings for the Synthesis Pipeline

These findings directly affect plan-006 decisions.

### Finding 1: Stage-1 Output Size vs. Token Thresholds

Stage-1 outputs are designed to be "structured intent surfaces" at ≤~2 KB each. At ~4 chars/token, 2 KB ≈ 500 tokens per member. For a 5-member composite: ~2,500 tokens of Stage-1 content.

**The 1024-token threshold is met by the system prompt alone**, provided the static synthesis system prompt is written with sufficient detail (~800-1200 tokens is realistic for a well-specified synthesis persona + formatting rules). The system prompt breakpoint (Message[0]) will qualify for caching on:
- Anthropic (Sonnet 4.x / 4.6): YES — threshold 1024
- Anthropic (Opus 4.5+, Haiku 4.5+): MAYBE — threshold 4096, likely NOT met by system prompt alone
- OpenAI / Azure OpenAI: YES — 1024 tokens, automatic
- Gemini 2.5 (implicit): YES for Flash (1024 min); MAYBE for Pro (4096 min)

**The combined system prompt + members block** (Message[0] + Message[1] Block[0]) will be 1500–4000 tokens for a typical 2–5 member composite. This meets the OpenAI and Anthropic Sonnet thresholds but may fall short for Anthropic Opus 4.5+ and Gemini Pro.

**Recommendation**: Do not rely on provider-side caching for Stage-1 outputs. The on-disk Stage-1 cache (per `investigation-composite-tools.md` Recommendation 1) is the correct and sufficient mechanism for Stage-1 reuse. Provider-side caching applies only to Stage-2's **static system prompt prefix**, not to the per-member distillation block.

### Finding 2: Cost Arithmetic for Stage-2 Caching

A typical Stage-2 prompt for a 3-member composite:
- System prompt: ~800 tokens (static)
- Members block: ~1,500 tokens (stable per composite run)
- Compose instruction: ~200 tokens (variable)
- Total: ~2,500 input tokens

On **Anthropic Sonnet 4.6** (1024-token threshold met by system prompt):
- Cold call: 2,500 tokens at base price + 800-token write surcharge (1.25×)
- Warm call (same composite, re-run within 5 min): 2,300 tokens at 0.1× + 200 tokens at 1.0×
- Savings: ~80% on the 2,300 cached tokens = substantial for high-volume synthesis

On **OpenAI GPT-4o** (1024-token threshold met by full prefix):
- Warm call: cached_tokens = 2,300 at 0.5× = 50% savings on cached portion

### Finding 3: Anthropic `anthropic-beta` Header No Longer Needed

As of current API versions, the `anthropic-beta: prompt-caching-2024-07-31` header is NOT required. Some older examples still include it. It is safe to omit.

### Finding 4: Gemini Explicit Cache Incompatible with Tool-Calling Agents

Gemini's explicit `cachedContent` feature prohibits passing `tools` or `systemInstruction` in the same `GenerateContent` call. Since the synthesis pipeline may need tool-calling capability (or future versions might), explicit Gemini caching is architecturally incompatible with the pipeline. Use implicit caching (Gemini 2.5+) only, which requires no code changes.

### Finding 5: LiteLLM Gemini Translation Bug

When `providerFamily === "litellm-anthropic"` and the upstream is actually Gemini via LiteLLM, only the first `cache_control` marker is translated. The second breakpoint (members block) will NOT be cached. Flag this in the JSONL telemetry event `synthesis_stage2_start` so it is visible.

### Finding 6: Non-Caching Providers Need On-Disk Cache More Than Caching Providers

For Ollama and local MLX/llama.cpp, there is zero provider-side API-level caching. The synthesis pipeline's on-disk Stage-1 cache is the only cost/latency saving mechanism. This reinforces the investigation's Recommendation 1 that the on-disk cache is the primary optimization — provider-side caching is complementary, not primary.

---

## Common Pitfalls

### Pitfall 1: Message Ordering Invalidates Cache (OpenAI, Azure)

OpenAI hashes the first ~256 tokens to route to a cache node. Any difference in the first 1024 tokens is a cache miss. Common causes:
- Tool definition arrays serialized in non-deterministic JSON key order
- Timestamp or run-ID injected into system prompt
- Whitespace variation in template rendering
- Different model-ids in the same "provider" config (e.g., `gpt-4o-2024-05-13` vs `gpt-4o-2024-11-20`)

**Fix**: Serialize tool definitions with sorted keys. Never include timestamps in the static prefix. Use a stable template renderer.

### Pitfall 2: Model Version Mismatch Invalidates Anthropic Cache

Anthropic caches are model-specific. Switching from `claude-sonnet-4-6` to `claude-sonnet-4-6-20251101` (different snapshot) invalidates all cached prefixes. The synthesis pipeline should include the `synthesis-model-id` in the Stage-1 on-disk cache key (the investigation already recommends this) AND also pin the full model snapshot ID in Stage-2 to avoid this.

### Pitfall 3: Anthropic 4-Breakpoint Limit

Anthropic allows at most **4 cache breakpoints per request**. If the synthesis pipeline marks more than 4 blocks, the API silently ignores the extras. The Stage-2 two-breakpoint layout (system + members) is well within this limit.

### Pitfall 4: Short Prefixes Do Not Cache — No Error, Silent Skip

All providers (Anthropic, OpenAI, Gemini) silently skip caching for prefixes below the minimum threshold. The pipeline MUST check `cache_creation_input_tokens` (Anthropic) or `cached_tokens` (OpenAI) in the response to confirm caching occurred. If the static system prompt is below the threshold, caching is a no-op and the pipeline should log a warning (`synthesis_cache_miss_threshold`).

### Pitfall 5: Anthropic Workspace Isolation Change (February 2026)

If multiple cli-agent deployments share the same Anthropic API key but operate in different workspaces, they no longer share a cache pool. This is a regression only for multi-workspace deployments that relied on cross-workspace cache warmth. Single-workspace deployments are unaffected.

### Pitfall 6: Gemini `cachedContent` + Tools = 400 Error

Attempting to call `model.bindTools(tools).invoke(...)` when the model has an active `cachedContent` results in a 400 API error from Gemini. Do not mix explicit Gemini caching with tool-binding in the synthesis pipeline.

### Pitfall 7: LiteLLM `anthropic-beta` Header Conflicts with Vertex AI

When routing through LiteLLM to Anthropic-on-Vertex, `cache_control` markers will cause LiteLLM to inject the `anthropic-beta` header, which Vertex AI rejects with a 400. Workaround: when `llmProvider === "litellm"` and the upstream target is Vertex AI, strip `cache_control` markers before passing to LiteLLM, or use the Vertex AI adapter directly.

### Pitfall 8: Stage-1 Outputs Below 1024 Tokens — Provider Cache Does Not Help

As analyzed in §Finding 1, individual Stage-1 distillation outputs (~500 tokens each) are too short to benefit from provider-side caching on their own. The on-disk per-member cache keyed by `(member-doc-digest, distill-template-version, model-id)` is the correct and sufficient mechanism. Do not attempt to use provider-side caching for Stage-1 individual calls.

---

## Assumptions & Scope

### Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|------------|------------|-----------------|
| Anthropic `anthropic-beta` header is no longer required (caching is on by default when `cache_control` present) | HIGH | Would need to add `clientOptions.defaultHeaders` to `ChatAnthropic` instantiation for older API versions |
| Stage-1 output ~500 tokens per member (≤2 KB) | HIGH — matches investigation spec | If Stage-1 outputs are larger (e.g., 2000+ tokens for 4+ members combined), provider caching of the members block becomes viable |
| LangChain v0.3.x `@langchain/anthropic` and `@langchain/openai` API shapes | HIGH — verified against current docs | Minor changes if LangChain bumps to v0.4 before plan-006 lands |
| OpenAI `prompt_cache_key` is not natively exposed in LangChain `ChatOpenAI` | HIGH — confirmed via GitHub issue #32937 | If LangChain adds native support, the workaround subclass approach becomes unnecessary |
| `@langchain/google-genai` is being deprecated but still functional | MEDIUM — deprecation timeline unclear | If deprecated before plan-006 ships, need to migrate to `@langchain/google-genai` successor |
| Gemini explicit cache minimum is ~32,768 tokens (not documented precisely) | MEDIUM — inferred from use-case documentation | If minimum is lower, explicit Gemini caching could apply to synthesis pipeline |

### Scope Explicitly Excluded

- AWS Bedrock: not one of the 8 standard providers in cli-agent. Research note: Bedrock uses `cachePoint` blocks for Claude models, translated by LiteLLM when Bedrock is the upstream.
- Semantic caching (Redis, vector-based exact-match or approximate caching): orthogonal to provider-side KV caching; not covered here.
- Token-streaming interactions with caching (caching works with streaming but cache-hit detection requires full `usage` objects which streaming delivers at the end).
- Cost calculations per specific model pricing: pricing changes frequently; the multiplier ratios (0.1× read, 1.25× write, 0.5× OpenAI) are the stable figures to use.

### Uncertainties & Gaps

- **Exact minimum token thresholds for Claude 4.x family**: LiteLLM's table shows 2048 for "Anthropic Claude Sonnet/Opus 4.x" but Anthropic's own docs and finout.io report 1024 for Sonnet 4.x and 4096 for Opus 4.5+. The discrepancy may be due to different sub-versions. **Use `cache_creation_input_tokens` in the response to confirm empirically.**
- **`prompt_cache_key` in LangChain JS**: GitHub issue #32937 was open as of research date. Check if it has been resolved before implementing the workaround subclass.
- **`@langchain/google-genai` deprecation timeline**: No hard date found. Monitor the langchain-google repository.

---

## References

| # | Source | URL | Information Gathered |
|---|--------|-----|---------------------|
| 1 | Anthropic Prompt Caching Docs | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | Wire format, TTL options, 1-hour beta, breakpoint limits |
| 2 | Anthropic Pricing Docs | https://platform.claude.com/docs/en/about-claude/pricing | Cache write/read multipliers |
| 3 | LangChain JS Anthropic Integration Docs | https://docs.langchain.com/oss/javascript/integrations/chat/anthropic | TypeScript patterns for `SystemMessage` with `cache_control` |
| 4 | LangChain Anthropic Middleware Docs | https://docs.langchain.com/oss/javascript/integrations/middleware/anthropic | `anthropicPromptCachingMiddleware` API, TTL options |
| 5 | LangChain JS Reference: `anthropicPromptCachingMiddleware` | https://reference.langchain.com/javascript/langchain/index/anthropicPromptCachingMiddleware | Type signature, `unsupportedModelBehavior` |
| 6 | OpenAI Prompt Caching Docs | https://developers.openai.com/api/docs/guides/prompt-caching | Automatic caching, routing, `prompt_cache_key`, `prompt_cache_retention`, usage object |
| 7 | OpenAI Prompt Caching Blog Post | https://openai.com/index/api-prompt-caching/ | 50% discount confirmation, 80% latency reduction |
| 8 | Google Gemini Context Caching API Docs | https://ai.google.dev/gemini-api/docs/caching | Implicit vs explicit, TTL, `cachedContents`, JS code example |
| 9 | LangChain ChatGoogleGenerativeAI Docs | https://docs.langchain.com/oss/javascript/integrations/chat/google_generative_ai | `enableCachedContent()` method, deprecation notice |
| 10 | LiteLLM Prompt Caching Docs | https://docs.litellm.ai/docs/completion/prompt_caching | Provider table, min token table, usage object normalization, `prompt_cache_retention` |
| 11 | LiteLLM Anthropic Provider Docs | https://docs.litellm.ai/docs/providers/anthropic | Passthrough behavior |
| 12 | LiteLLM Issue #17201 (Gemini Translation Bug) | https://github.com/BerriAI/litellm/issues/17201 | First-found strategy bug for multi-breakpoint Gemini translation |
| 13 | LiteLLM Issue #14293 (Vertex AI + Anthropic) | https://github.com/BerriAI/litellm/issues/14293 | `anthropic-beta` header rejection on Vertex AI |
| 14 | Azure OpenAI Prompt Caching Docs | https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching | GPT-4o+ support, 1024-token threshold, `x-prompt-cache-retention` rollout status |
| 15 | Azure AI Inference REST Client Readme | https://learn.microsoft.com/en-us/javascript/api/overview/azure/ai-inference-rest-readme | `@azure-rest/ai-inference` SDK structure; no explicit cache API |
| 16 | Ollama FAQ | https://docs.ollama.com/faq | `keep_alive` parameter, default 5-minute model retention |
| 17 | llama.cpp KV Cache Tutorial | https://github.com/ggml-org/llama.cpp/discussions/13606 | Per-slot save/restore, `--system-prompt-file`, RAM-only constraint |
| 18 | LangChain GitHub Issue #32937 | https://github.com/langchain-ai/langchain/issues/32937 | `prompt_cache_key` not natively supported in LangChain `ChatOpenAI` |
| 19 | LangChain GitHub Issue #6705 | https://github.com/langchain-ai/langchainjs/issues/6705 | `cache_control` on `HumanMessage` — confirmed not working alone |
| 20 | finout.io Anthropic API Pricing Guide 2026 | https://www.finout.io/blog/anthropic-api-pricing | Model-specific minimum thresholds, workspace isolation change Feb 2026 |

---

## Clarifying Questions for Follow-up

1. **What is the target system prompt length for Stage-2?** If the static synthesis system prompt is < 1024 tokens, provider-side caching does nothing until the members block pushes the combined prefix over the threshold. Plan-006 should specify a minimum prompt length or pad the static block.

2. **Which Claude model will be the default synthesis model?** The minimum-token threshold varies significantly (1024 for Sonnet 4.x vs 4096 for Opus 4.5+). Choosing Sonnet 4.6 as the synthesis default enables caching at a lower token count.

3. **Will the `prompt_cache_key` LangChain gap (issue #32937) be resolved before plan-006 implementation?** If not, the subclass workaround should be included in the implementation plan.

4. **Is multi-workspace Anthropic deployment a scenario?** If yes, the February 2026 workspace-isolation change means separate workspaces do not share caches — document this as a known limitation.

5. **Should the `anthropicTtl` option in the synthesis config default to `"5m"` or `"1h"`?** If typical synthesis-to-synthesis intervals exceed 5 minutes (likely for interactive use), default to `"1h"` at the 2× write cost to guarantee cache hits across sessions.
