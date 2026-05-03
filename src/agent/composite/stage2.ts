/**
 * Stage-2 composer (plan-006 Phase 6, Unit U-SYNTH).
 *
 * Takes the per-member Stage-1 distillations + composite metadata,
 * builds the three-message Stage-2 prompt (`stage2ComposePrompt`),
 * applies provider-side prompt-cache markers via `withSynthesisCache`
 * (U-CACHE), invokes the LLM once, and returns the AUTO-GENERATED
 * markdown body together with normalised cache-usage telemetry.
 *
 * The composed body is validated for structural sanity:
 *   - non-empty after trim
 *   - contains the required `## Synopsis` section header
 *   - does NOT contain AUTO-GENERATED markers (the composer wires
 *     those, not the LLM)
 *
 * Token-budget enforcement: when `budgetTokens` is supplied, the
 * composer estimates the prompt's input-token cost (rough chars/4)
 * BEFORE invocation; if the estimate exceeds the cap the composer
 * raises `UsageError` exit 2 naming consumed/cap. After the call,
 * actual usage is checked against any remaining budget.
 */

import crypto from 'node:crypto';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { AgentConfig } from '../../config/agent-config.js';
import { ConfigurationError, UsageError } from '../../errors.js';
import {
  extractCacheUsage,
  resolveProviderFamily,
  withSynthesisCache,
} from './llm-cache.js';
import {
  STAGE2_TEMPLATE_VERSION,
  stage2ComposePrompt,
} from './prompts.js';
import type { Logger } from '../logging.js';
import type { ProviderFamily, Stage1Distillation } from './types.js';

export interface ComposeStageOptions {
  readonly compositeName: string;
  readonly members: ReadonlyArray<{
    readonly name: string;
    readonly distillation: Stage1Distillation;
  }>;
  readonly cfg: AgentConfig;
  readonly llm: BaseChatModel;
  readonly logger: Logger;
  /** Combined input + output token cap. Pre- AND post-call check. */
  readonly budgetTokens?: number;
  /** Tokens already consumed by Stage-1 — counts against the
   * combined budget per §14.G. Defaults to 0. */
  readonly tokensAlreadyConsumed?: number;
  readonly cliAgentVersion: string;
  readonly synthesisModel: string;
  readonly activeProfile: string | null;
  /** When true, skip the LLM call and return the assembled prompt
   * messages instead of an LLM body. The caller (synthesizer
   * dryRun) renders them. */
  readonly dryRun?: boolean;
  /** Override `Date.now()` for deterministic test fixtures. */
  readonly nowIso?: string;
}

export interface ComposeStageResult {
  readonly markdownBody: string;
  readonly tokenUsage: {
    readonly cachedTokens: number;
    readonly cacheCreationTokens: number;
    readonly provider: 'anthropic' | 'openai-compat' | 'unknown';
    readonly inputTokens: number;
    readonly outputTokens: number;
  };
  readonly templateVersion: string;
  readonly providerFamily: ProviderFamily;
  readonly promptDigest16: string;
  /** When `dryRun` is true, the assembled message array. Otherwise
   * undefined. */
  readonly dryRunMessages?: ReadonlyArray<BaseMessage>;
}

/**
 * Compose the AUTO-GENERATED body of the schema-3 composite doc.
 * Single LLM round-trip + structured-output validation.
 */
export async function composeStage(
  opts: ComposeStageOptions,
): Promise<ComposeStageResult> {
  // Step 1: build the assembled messages.
  const built = stage2ComposePrompt({
    compositeName: opts.compositeName,
    members: opts.members,
    cliAgentVersion: opts.cliAgentVersion,
    synthesisModel: opts.synthesisModel,
    activeProfile: opts.activeProfile,
    ...(opts.nowIso === undefined ? {} : { nowIso: opts.nowIso }),
  });

  // Step 2: apply provider-side cache markers.
  const providerFamily = resolveProviderFamily(opts.cfg);
  const cachedMessages = withSynthesisCache(built.messages, {
    providerFamily,
    prefixEndIndex: built.prefixEndIndex,
    anthropicTtl: '1h',
  });

  const promptDigest16 = computePromptDigest16(cachedMessages);

  // Step 3: pre-call budget check.
  const estimatedInputTokens = estimateTokenCount(cachedMessages);
  const tokensAlreadyConsumed = opts.tokensAlreadyConsumed ?? 0;
  if (
    opts.budgetTokens !== undefined &&
    estimatedInputTokens + tokensAlreadyConsumed > opts.budgetTokens
  ) {
    throw new UsageError(
      `synthesis budget exceeded: estimated ${String(estimatedInputTokens + tokensAlreadyConsumed)} tokens > cap ${String(opts.budgetTokens)}`,
      {
        consumed: tokensAlreadyConsumed,
        estimated: estimatedInputTokens,
        cap: opts.budgetTokens,
        stage: 'stage2-pre-call',
      },
    );
  }

  // Step 4: dry-run early exit. Return the assembled messages and
  // skip the LLM call; the body is empty.
  if (opts.dryRun === true) {
    return {
      markdownBody: '',
      tokenUsage: {
        cachedTokens: 0,
        cacheCreationTokens: 0,
        provider: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
      },
      templateVersion: built.templateVersion,
      providerFamily,
      promptDigest16,
      dryRunMessages: cachedMessages,
    };
  }

  // Step 5: LLM invocation.
  const startMs = Date.now();
  const response = await opts.llm.invoke(cachedMessages);
  const latencyMs = Date.now() - startMs;

  const responseText = extractResponseText(response).trim();
  if (responseText.length === 0) {
    throw new ConfigurationError(
      `Stage-2 composer for '${opts.compositeName}'`,
      ['LLM returned an empty response'],
      { compositeName: opts.compositeName },
    );
  }

  // Step 6: structural validation.
  validateComposedBody(responseText, opts.compositeName);

  // Step 7: extract usage telemetry.
  const responseMetaRecord = extractResponseMetaRecord(response);
  const cacheUsage = extractCacheUsage(responseMetaRecord);
  const usage = extractTokenUsage(response);

  // Step 8: post-call budget enforcement.
  const totalUsedNow =
    tokensAlreadyConsumed + usage.input + usage.output;
  if (
    opts.budgetTokens !== undefined &&
    totalUsedNow > opts.budgetTokens
  ) {
    throw new UsageError(
      `synthesis budget exceeded: actual ${String(totalUsedNow)} tokens > cap ${String(opts.budgetTokens)}`,
      {
        consumed: totalUsedNow,
        cap: opts.budgetTokens,
        stage: 'stage2-post-call',
      },
    );
  }

  // Step 9: structured log emission per §14.M.
  logCompositeEvent(opts.logger, {
    kind: 'composite_stage2_run',
    ts: new Date().toISOString(),
    compositeName: opts.compositeName,
    promptDigest16,
    tokensInput: usage.input,
    tokensOutput: usage.output,
    latencyMs,
    providerCacheCreation: cacheUsage.cacheCreationTokens,
    providerCacheRead: cacheUsage.cachedTokens,
    providerFamily,
  });

  return {
    markdownBody: responseText,
    tokenUsage: {
      cachedTokens: cacheUsage.cachedTokens,
      cacheCreationTokens: cacheUsage.cacheCreationTokens,
      provider: cacheUsage.provider,
      inputTokens: usage.input,
      outputTokens: usage.output,
    },
    templateVersion: built.templateVersion,
    providerFamily,
    promptDigest16,
  };
}

/* --------------------------------------------------------------------- */
/* Internal helpers                                                       */
/* --------------------------------------------------------------------- */

const AUTO_GEN_START_PREFIX = '<!-- AUTO-GENERATED:START';
const AUTO_GEN_END = '<!-- AUTO-GENERATED:END -->';

/**
 * Validate that the LLM response is well-formed enough for the
 * composer to wrap it. The composer (composeCompositeDoc) wires the
 * AUTO-GENERATED + USER-* markers; the LLM must NOT emit those —
 * that would break the digest computation. The body must contain
 * the required ## Synopsis section header.
 */
function validateComposedBody(body: string, compositeName: string): void {
  if (body.includes(AUTO_GEN_START_PREFIX) || body.includes(AUTO_GEN_END)) {
    throw new ConfigurationError(
      `Stage-2 composer for '${compositeName}'`,
      ['LLM emitted AUTO-GENERATED markers; the composer is the sole owner'],
      { compositeName },
    );
  }
  if (
    body.includes('<!-- USER-RECIPES:START -->') ||
    body.includes('<!-- USER-NOTES:START -->')
  ) {
    throw new ConfigurationError(
      `Stage-2 composer for '${compositeName}'`,
      ['LLM emitted USER-* markers; the composer is the sole owner'],
      { compositeName },
    );
  }
  if (!/^##\s+Synopsis\b/m.test(body)) {
    throw new ConfigurationError(
      `Stage-2 composer for '${compositeName}'`,
      ['LLM response missing required `## Synopsis` section'],
      {
        compositeName,
        bodyPreview: body.slice(0, 256),
      },
    );
  }
}

/** Rough token estimate: chars / 4 across all message text. */
function estimateTokenCount(messages: ReadonlyArray<BaseMessage>): number {
  let chars = 0;
  for (const m of messages) {
    const c = m.content as unknown;
    if (typeof c === 'string') {
      chars += c.length;
    } else if (Array.isArray(c)) {
      for (const block of c) {
        if (block && typeof block === 'object') {
          const t = (block as { text?: unknown }).text;
          if (typeof t === 'string') chars += t.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

interface MessageWithContent {
  readonly content: unknown;
}

function extractResponseText(response: unknown): string {
  const r = response as MessageWithContent;
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.content)) {
    return r.content
      .map((block) => {
        if (block && typeof block === 'object') {
          const b = block as { type?: unknown; text?: unknown };
          if (b.type === 'text' && typeof b.text === 'string') return b.text;
        }
        return '';
      })
      .join('');
  }
  return '';
}

function extractTokenUsage(response: unknown): { input: number; output: number } {
  const r = response as { usage_metadata?: unknown; response_metadata?: unknown };
  const usageMeta = r.usage_metadata;
  if (usageMeta && typeof usageMeta === 'object') {
    const u = usageMeta as { input_tokens?: unknown; output_tokens?: unknown };
    if (typeof u.input_tokens === 'number' || typeof u.output_tokens === 'number') {
      return {
        input: typeof u.input_tokens === 'number' ? u.input_tokens : 0,
        output: typeof u.output_tokens === 'number' ? u.output_tokens : 0,
      };
    }
  }
  const respMeta = r.response_metadata;
  if (respMeta && typeof respMeta === 'object') {
    const usage = (respMeta as { usage?: unknown }).usage;
    if (usage && typeof usage === 'object') {
      const u = usage as {
        input_tokens?: unknown;
        output_tokens?: unknown;
        prompt_tokens?: unknown;
        completion_tokens?: unknown;
      };
      const inp = typeof u.input_tokens === 'number'
        ? u.input_tokens
        : (typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0);
      const out = typeof u.output_tokens === 'number'
        ? u.output_tokens
        : (typeof u.completion_tokens === 'number' ? u.completion_tokens : 0);
      if (inp > 0 || out > 0) return { input: inp, output: out };
    }
  }
  return { input: 0, output: 0 };
}

function extractResponseMetaRecord(response: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const r = response as {
    response_metadata?: unknown;
    usage_metadata?: unknown;
    usage?: unknown;
  };
  if (r.response_metadata && typeof r.response_metadata === 'object') {
    Object.assign(out, r.response_metadata as Record<string, unknown>);
  }
  if (r.usage_metadata !== undefined) out.usage_metadata = r.usage_metadata;
  if (r.usage !== undefined && out.usage === undefined) out.usage = r.usage;
  return out;
}

function computePromptDigest16(messages: ReadonlyArray<BaseMessage>): string {
  const serial = JSON.stringify(
    messages.map((m) => {
      const mm = m as { _getType?: () => string; content: unknown };
      const type = typeof mm._getType === 'function' ? mm._getType() : 'unknown';
      return { type, content: mm.content };
    }),
  );
  return crypto.createHash('sha256').update(serial).digest('hex').slice(0, 16);
}

function logCompositeEvent(
  logger: Logger,
  event: {
    readonly kind: string;
    readonly ts: string;
    readonly [key: string]: unknown;
  },
): void {
  (logger as { log: (e: unknown) => void }).log(event);
}

/* Re-export for downstream consumers that want the locked version
 * pin without importing from prompts.ts directly. */
export { STAGE2_TEMPLATE_VERSION };
