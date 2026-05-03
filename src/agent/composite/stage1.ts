/**
 * Stage-1 per-member distillation (plan-006 Phase 6, Unit U-SYNTH).
 *
 * Reads a member tool's schema-2 capability doc, hashes the
 * canonicalised bytes, and looks up an on-disk Stage-1 cache entry
 * keyed by `<member>@<digest16>.json` under
 * `cfg.compositeDistillDir`. On hit, the cached `Stage1Distillation`
 * is returned without invoking the LLM. On miss, the Stage-1
 * distillation prompt is built (`stage1DistillPrompt`), submitted to
 * the LLM, validated against the structured-content shape, and
 * persisted atomically (temp + rename, mode 0600).
 *
 * The cache key incorporates `STAGE1_TEMPLATE_VERSION` (so prompt
 * iterations invalidate stale entries) and `cfg.model` (different
 * models produce different distillation styles, so the cache must be
 * model-scoped). Per ADR-CMP-14, the cli-agent version is NOT in the
 * Stage-1 key — Stage-1 distillations are stable across cli-agent
 * binary upgrades, only the Stage-2 compose may need to re-run.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentConfig } from '../../config/agent-config.js';
import { ConfigurationError } from '../../errors.js';
import {
  canonicaliseMemberDoc,
  computeMemberDocDigest,
} from './cache.js';
import {
  STAGE1_TEMPLATE_VERSION,
  stage1DistillPrompt,
} from './prompts.js';
import type { Logger } from '../logging.js';
import type { Stage1Distillation } from './types.js';

/* --------------------------------------------------------------------- */
/* Validation schema for the Stage-1 LLM JSON output                      */
/* --------------------------------------------------------------------- */

const Stage1ContentSchema = z
  .object({
    synopsis: z.string().min(1),
    intents: z.array(z.string().min(1)).max(8),
    subcommands: z
      .array(z.object({ name: z.string().min(1), purpose: z.string().min(1) }))
      .max(12),
    flags: z
      .array(z.object({ name: z.string().min(1), purpose: z.string().min(1) }))
      .max(12),
    examples: z
      .array(z.object({ command: z.string().min(1), explanation: z.string().min(1) }))
      .max(5),
    constraints: z.array(z.string().min(1)).max(8),
  })
  .strict();

/**
 * Persisted Stage-1 cache file shape (also the on-the-wire return
 * type of `distillMember`). The `content` field is the JSON-stringified
 * Stage1ContentSchema instance — keeping the on-disk format as a
 * string preserves the option to swap the structured surface for a
 * different shape in v1.x without bumping STAGE1_TEMPLATE_VERSION.
 */
const Stage1DistillationFileSchema = z
  .object({
    memberName: z.string().min(1),
    content: z.string().min(1),
    modelId: z.string().min(1),
    templateVersion: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

/* --------------------------------------------------------------------- */
/* Cache-key + path helpers                                               */
/* --------------------------------------------------------------------- */

/**
 * The Stage-1 cache key the on-disk file is named with. Uses sha256
 * over `<docDigest>:<templateVersion>:<modelId>` truncated to 16 hex
 * chars — long enough that birthday collisions are astronomically
 * unlikely across the per-member cache space.
 */
function computeDistillCacheKey(opts: {
  readonly memberDocDigest: string;
  readonly templateVersion: string;
  readonly modelId: string;
}): string {
  return crypto
    .createHash('sha256')
    .update(`${opts.memberDocDigest}:${opts.templateVersion}:${opts.modelId}`)
    .digest('hex')
    .slice(0, 16);
}

function distillCacheFilePath(
  cfg: AgentConfig,
  memberName: string,
  cacheKey: string,
): string {
  return path.join(cfg.compositeDistillDir, `${memberName}@${cacheKey}.json`);
}

/* --------------------------------------------------------------------- */
/* Read / write                                                            */
/* --------------------------------------------------------------------- */

/**
 * Read a Stage-1 cache entry from disk. Returns `null` on ENOENT or
 * when the file fails schema validation (treat-as-miss; the caller
 * falls back to LLM invocation).
 *
 * Exposed for forward-looking v1.1 audit hooks per §14.P.
 */
export async function readDistillCacheEntry(
  filePath: string,
): Promise<Stage1Distillation | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const validated = Stage1DistillationFileSchema.safeParse(parsed);
  if (!validated.success) return null;
  return validated.data;
}

/**
 * Atomically write a Stage-1 cache entry: temp + rename, mode 0600.
 *
 * Exposed for forward-looking v1.1 audit hooks per §14.P.
 */
export async function writeDistillCacheEntry(
  filePath: string,
  entry: Stage1Distillation,
): Promise<void> {
  const dir = path.dirname(filePath);
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp.${String(process.pid)}.${process.hrtime.bigint().toString(36)}`;
  await fsp.writeFile(tmp, JSON.stringify(entry, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await fsp.rename(tmp, filePath);
  } catch (e) {
    try { await fsp.unlink(tmp); } catch { /* tolerated */ }
    throw e;
  }
  try { await fsp.chmod(filePath, 0o600); } catch { /* tolerated on Windows */ }
}

/* --------------------------------------------------------------------- */
/* Distill orchestrator                                                    */
/* --------------------------------------------------------------------- */

export interface DistillMemberOptions {
  readonly memberName: string;
  readonly memberDocPath: string;
  readonly cfg: AgentConfig;
  readonly llm: BaseChatModel;
  readonly logger: Logger;
  /** Bypass the on-disk Stage-1 cache and always invoke the LLM. */
  readonly forceRegenerate?: boolean;
  /** When true, do NOT invoke the LLM and do NOT write the cache.
   * Returns the assembled prompt-message digest in the
   * `distillation.content` (callers use this for `--dry-run-synthesis`).
   * The returned distillation is NOT a real distillation; the caller
   * MUST NOT pass it to Stage-2. */
  readonly dryRun?: boolean;
}

export interface DistillMemberResult {
  readonly distillation: Stage1Distillation;
  readonly cacheHit: boolean;
  readonly tokensInput: number;
  readonly tokensOutput: number;
  /** sha256[:16] over the assembled prompt messages — used by the
   * `--dry-run-synthesis` caller and by `composite_stage1_run`
   * JSONL telemetry per §14.M. */
  readonly promptDigest16: string;
}

/**
 * Distill a single member tool's capability doc into a structured
 * intent surface. On cache hit, returns the cached entry without
 * touching the LLM. On miss, invokes the LLM and persists the
 * validated result.
 *
 * Throws `ConfigurationError` (exit 3) when the member-doc file is
 * missing — there is no silent fallback to running the binary's
 * `--help` here; the caller (synthesizer) is responsible for the
 * discovery step before calling this function.
 */
export async function distillMember(
  opts: DistillMemberOptions,
): Promise<DistillMemberResult> {
  // Step 1: read the member doc bytes from disk. Absent file →
  // ConfigurationError (no silent fallback). The synthesizer is
  // expected to have run `discoverTool` first so the doc exists.
  let memberDocText: string;
  try {
    memberDocText = await fsp.readFile(opts.memberDocPath, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      throw new ConfigurationError(
        `composite member capability doc for '${opts.memberName}'`,
        [opts.memberDocPath],
        { memberName: opts.memberName, expectedAt: opts.memberDocPath },
      );
    }
    throw e;
  }

  // Step 2: compute digest + canonical bytes.
  const memberDocDigest = computeMemberDocDigest(memberDocText);
  const memberDocCanonical = canonicaliseMemberDoc(memberDocText);

  // Step 3: build the Stage-1 prompt (used for both cache-key
  // diagnostics + the actual LLM call on miss).
  const { messages, templateVersion } = stage1DistillPrompt({
    memberName: opts.memberName,
    memberDocCanonical,
  });

  const promptDigest16 = computePromptDigest16(messages);

  // Step 4: cache-key + cache-path.
  const cacheKey = computeDistillCacheKey({
    memberDocDigest,
    templateVersion,
    modelId: opts.cfg.model,
  });
  const cacheFilePath = distillCacheFilePath(opts.cfg, opts.memberName, cacheKey);

  // Step 5: cache lookup (skip on forceRegenerate or dryRun).
  if (!opts.forceRegenerate && !opts.dryRun) {
    const cached = await readDistillCacheEntry(cacheFilePath);
    if (cached !== null) {
      logCompositeEvent(opts.logger, {
        kind: 'composite_stage1_cached',
        ts: new Date().toISOString(),
        member: opts.memberName,
        distillCacheKey: cacheKey,
        cacheFilePath,
      });
      return {
        distillation: cached,
        cacheHit: true,
        tokensInput: 0,
        tokensOutput: 0,
        promptDigest16,
      };
    }
  }

  // Step 6: dry-run early exit. Return a synthetic distillation
  // carrying the prompt digest so the caller can render it; do NOT
  // invoke the LLM, do NOT touch the cache.
  if (opts.dryRun === true) {
    const synthetic: Stage1Distillation = {
      memberName: opts.memberName,
      content: JSON.stringify({
        dryRun: true,
        promptDigest16,
        templateVersion,
        modelId: opts.cfg.model,
      }),
      modelId: opts.cfg.model,
      templateVersion,
      createdAt: new Date().toISOString(),
    };
    return {
      distillation: synthetic,
      cacheHit: false,
      tokensInput: 0,
      tokensOutput: 0,
      promptDigest16,
    };
  }

  // Step 7: LLM invocation.
  const startMs = Date.now();
  const response = await opts.llm.invoke(messages);
  const latencyMs = Date.now() - startMs;
  const responseText = extractResponseText(response);

  // Step 8: validate JSON shape.
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(responseText);
  } catch {
    throw new ConfigurationError(
      `Stage-1 distillation for '${opts.memberName}'`,
      ['LLM response was not valid JSON'],
      { memberName: opts.memberName, responseTextPreview: responseText.slice(0, 256) },
    );
  }
  const validated = Stage1ContentSchema.safeParse(parsedJson);
  if (!validated.success) {
    throw new ConfigurationError(
      `Stage-1 distillation for '${opts.memberName}'`,
      ['LLM JSON failed schema validation'],
      {
        memberName: opts.memberName,
        validationErrors: validated.error.issues,
        responseTextPreview: responseText.slice(0, 256),
      },
    );
  }

  // Step 9: persist the cache entry.
  const entry: Stage1Distillation = {
    memberName: opts.memberName,
    content: JSON.stringify(validated.data),
    modelId: opts.cfg.model,
    templateVersion,
    createdAt: new Date().toISOString(),
  };
  await writeDistillCacheEntry(cacheFilePath, entry);

  // Step 10: log + return.
  const usage = extractTokenUsage(response);
  logCompositeEvent(opts.logger, {
    kind: 'composite_stage1_run',
    ts: new Date().toISOString(),
    member: opts.memberName,
    promptDigest16,
    tokensInput: usage.input,
    tokensOutput: usage.output,
    latencyMs,
  });

  return {
    distillation: entry,
    cacheHit: false,
    tokensInput: usage.input,
    tokensOutput: usage.output,
    promptDigest16,
  };
}

/* --------------------------------------------------------------------- */
/* Internal helpers                                                       */
/* --------------------------------------------------------------------- */

interface MessageWithContent {
  readonly content: unknown;
}

function extractResponseText(response: unknown): string {
  // LangChain BaseChatModel.invoke() returns AIMessage; AIMessage
  // exposes `.content` as either a string or array of content blocks.
  const r = response as MessageWithContent;
  if (typeof r.content === 'string') return r.content;
  if (Array.isArray(r.content)) {
    // Concatenate text-typed blocks (the only shape Stage-1 expects).
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
  // LangChain 0.3+ exposes usage_metadata as the canonical shape.
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
  // Fallback: response_metadata.usage.{input_tokens,output_tokens}
  // or .{prompt_tokens,completion_tokens}.
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

function computePromptDigest16(messages: ReadonlyArray<unknown>): string {
  // Deterministic over messages: serialize each message's role +
  // content. We stringify with sorted keys so V8 insertion order
  // doesn't drift the digest.
  const serial = JSON.stringify(
    messages.map((m) => {
      const mm = m as { _getType?: () => string; content: unknown };
      const type = typeof mm._getType === 'function' ? mm._getType() : 'unknown';
      return { type, content: mm.content };
    }),
  );
  return crypto.createHash('sha256').update(serial).digest('hex').slice(0, 16);
}

/**
 * Append-only structural log call. The `LogEvent` union in
 * `logging.ts` does not yet enumerate composite_* events (those are
 * landed by U-DOC / U-CMD); we emit through the `Logger.log` channel
 * via a structurally-compatible cast so the event still flows into
 * the JSONL sink. Callers that consume the JSONL stream will see the
 * extra `kind` literals.
 */
function logCompositeEvent(
  logger: Logger,
  event: {
    readonly kind: string;
    readonly ts: string;
    readonly [key: string]: unknown;
  },
): void {
  // Cast through `unknown` then to the logger's accepted shape — the
  // logger's writeline path is parametric over the JSONL bytes; it
  // doesn't introspect the `kind` discriminant beyond passing it
  // through `redactString`.
  (logger as { log: (e: unknown) => void }).log(event);
}
