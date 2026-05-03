/**
 * Composite-tool synthesis orchestrator (plan-006 Phase 6, Unit
 * U-SYNTH).
 *
 * Top-level entry point exposing `synthesizeComposite(input)` per the
 * §14.D / §14.G contract:
 *   1. Distill each member's capability doc in parallel (Stage-1).
 *      Cache hits avoid the LLM; misses persist to disk.
 *   2. Compose the AUTO-GENERATED body (Stage-2). Provider-side
 *      prompt-cache markers are applied via `withSynthesisCache`.
 *   3. Build the schema-3 frontmatter + canonical doc bytes via
 *      `composeCompositeDoc`.
 *
 * The returned `SynthesisResult.doc` is the full schema-3 markdown
 * (frontmatter + AUTO-GENERATED + USER-RECIPES + USER-NOTES, the
 * latter two left empty on first synthesis). The caller (U-CMD)
 * writes it to disk via the U-DOC writer; this module does NOT touch
 * the canonical composite-doc location itself.
 *
 * Dry-run (§14.G dry-run-synthesis) returns a result with empty
 * `doc` bytes and `cacheHit: true` to signal "no LLM contact". The
 * caller renders the assembled prompts from the per-stage messages
 * captured in the (typed-extension) `dryRun` field.
 *
 * Token-budget enforcement happens INSIDE `composeStage`; the
 * orchestrator threads the running consumed counter across both
 * stages so the cap covers Stage-1 + Stage-2 combined per §14.G.
 */

import path from 'node:path';
import type { BaseMessage } from '@langchain/core/messages';
import type { CompositeFrontmatter, Stage1Distillation, SynthesisInputs, SynthesisResult } from './types.js';
import {
  canonicaliseSyntheticInputs,
  computeMemberDocDigest,
  computeSyntheticDigest,
} from './cache.js';
import { composeCompositeDoc } from './composeCompositeDoc.js';
import { distillMember } from './stage1.js';
import { composeStage } from './stage2.js';
import { stage1DistillPrompt, stage2ComposePrompt } from './prompts.js';
import { CLI_VERSION } from '../logging.js';
import type { Logger } from '../logging.js';
import { ConfigurationError } from '../../errors.js';
import fsp from 'node:fs/promises';

/* --------------------------------------------------------------------- */
/* Extended input + result shapes                                         */
/* --------------------------------------------------------------------- */

/**
 * Optional per-call extension over §14.D `SynthesisInputs`. The
 * fields below are CONSUMED by U-CMD when it threads
 * `--force-regenerate` / `--dry-run-synthesis` flags through.
 */
export interface SynthesizeCompositeOptions {
  /** Bypass the per-member Stage-1 on-disk cache. */
  readonly forceRegenerate?: boolean;
  /** Override `Date.now()` for deterministic test fixtures. */
  readonly nowIso?: string;
}

/**
 * Forward-compatible extension of the §14.D `SynthesisResult`. When
 * `dryRun` is true, the result carries the assembled per-stage
 * messages so the caller can render them; the canonical `doc` field
 * is empty and `cacheHit` is false.
 */
export interface ExtendedSynthesisResult extends SynthesisResult {
  /** When `dryRun` was true, the assembled messages per stage. */
  readonly dryRun?: {
    readonly stage1: ReadonlyArray<{
      readonly memberName: string;
      readonly messages: ReadonlyArray<BaseMessage>;
    }>;
    readonly stage2: ReadonlyArray<BaseMessage>;
  };
  /** Per-member Stage-1 distillation results, useful for telemetry. */
  readonly distillations: ReadonlyArray<Stage1Distillation>;
}

/* --------------------------------------------------------------------- */
/* Orchestrator                                                            */
/* --------------------------------------------------------------------- */

/**
 * Top-level composite synthesis pipeline.
 *
 * Throws `ConfigurationError` (exit 3) on:
 *   - members list empty (§14.D contract)
 *   - any member capability-doc absent on disk
 * Throws `UsageError` (exit 2) on token-budget overrun (delegated to
 * `composeStage`).
 */
export async function synthesizeComposite(
  inputs: SynthesisInputs,
  options: SynthesizeCompositeOptions = {},
): Promise<ExtendedSynthesisResult> {
  const { cfg, llm, members, compositeName, dryRun, budgetTokens, logger } = inputs;

  if (members.length === 0) {
    throw new ConfigurationError(
      'composite synthesis members',
      ['SynthesisInputs.members must contain at least one member'],
      { compositeName },
    );
  }

  // Sort and dedupe — caller is supposed to pre-sort, but defensive
  // duplication suppression keeps the digest deterministic if an
  // upstream bug slipped through.
  const sortedMembers = [...new Set(members)].sort();

  logCompositeEvent(logger, {
    kind: 'composite_synthesis_started',
    ts: new Date().toISOString(),
    compositeName,
    members: sortedMembers,
    cacheHit: false,
    dryRun,
    providerFamily: cfg.provider,
    stage1OnDiskHits: 0, // back-filled by post-loop count if needed by callers
    currentEffectiveOverlayDigests: {},
  });

  // -- Stage-1 (parallel per-member) --
  const stage1Results = await Promise.all(
    sortedMembers.map(async (name) => {
      const docPath = path.join(cfg.capabilitiesDir, `${name}.md`);
      const r = await distillMember({
        memberName: name,
        memberDocPath: docPath,
        cfg,
        llm,
        logger,
        ...(options.forceRegenerate === undefined ? {} : { forceRegenerate: options.forceRegenerate }),
        ...(dryRun === undefined ? {} : { dryRun }),
      });
      return { name, docPath, result: r };
    }),
  );

  const distillations: Stage1Distillation[] = stage1Results.map((s) => s.result.distillation);
  let runningTokens = 0;
  for (const s of stage1Results) {
    runningTokens += s.result.tokensInput + s.result.tokensOutput;
  }

  // -- Compute member digests for the frontmatter --
  // We re-read each member-doc source to compute the digest the
  // composer hashes over. Stage-1 already canonicalised internally
  // but did not surface the digest, so we recompute here. The
  // cost is one extra fs.readFile per member; deemed acceptable.
  const memberDigests: Record<string, string> = {};
  await Promise.all(
    sortedMembers.map(async (name) => {
      const docPath = path.join(cfg.capabilitiesDir, `${name}.md`);
      const text = await fsp.readFile(docPath, 'utf8');
      memberDigests[name] = computeMemberDocDigest(text);
    }),
  );

  const synthesisModel = `${cfg.provider}:${cfg.model}`;
  const cliAgentVersion = readCliAgentVersion();
  const activeProfile = cfg.activeProfile?.name ?? null;

  // -- Stage-2 --
  const stage2Members = stage1Results.map((s) => ({
    name: s.name,
    distillation: s.result.distillation,
  }));

  const stage2 = await composeStage({
    compositeName,
    members: stage2Members,
    cfg,
    llm,
    logger,
    ...(budgetTokens === undefined ? {} : { budgetTokens }),
    tokensAlreadyConsumed: runningTokens,
    cliAgentVersion,
    synthesisModel,
    activeProfile,
    ...(dryRun === undefined ? {} : { dryRun }),
    ...(options.nowIso === undefined ? {} : { nowIso: options.nowIso }),
  });

  runningTokens += stage2.tokenUsage.inputTokens + stage2.tokenUsage.outputTokens;

  // -- Frontmatter assembly --
  const synthesizedAt = options.nowIso ?? new Date().toISOString();
  const frozenMemberDigests = Object.freeze({ ...memberDigests });
  const syntheticDigest = computeSyntheticDigest(
    canonicaliseSyntheticInputs({
      schemaVersion: 3,
      compositeName,
      members: sortedMembers,
      memberDigests: frozenMemberDigests,
      cliAgentVersion,
      synthesisModel,
    }),
  );

  const frontmatter: CompositeFrontmatter = Object.freeze({
    schemaVersion: 3 as const,
    composite: true as const,
    compositeName,
    members: Object.freeze([...sortedMembers]),
    memberDigests: frozenMemberDigests,
    synthesizedAt,
    syntheticDigest,
    cliAgentVersion,
    synthesisModel,
    activeProfile,
    manRef: null as null,
    manPagePath: null as null,
  });

  // -- Doc composition --
  // Dry-run: skip composeCompositeDoc (it requires non-empty body).
  // Return assembled prompts so the caller can render them.
  if (dryRun) {
    const stage1Prompts = sortedMembers.map((name) => {
      const docPath = path.join(cfg.capabilitiesDir, `${name}.md`);
      // Re-read + re-canonicalise to avoid relying on stage1's
      // internal state. The fs read is already cached by the OS.
      void docPath;
      return { name };
    });

    // For dry-run, re-build Stage-1 prompts using canonical bytes
    // captured from disk. This keeps the dry-run output reproducible.
    const stage1Assembled: Array<{
      memberName: string;
      messages: ReadonlyArray<BaseMessage>;
    }> = [];
    await Promise.all(
      stage1Prompts.map(async ({ name }) => {
        const docPath = path.join(cfg.capabilitiesDir, `${name}.md`);
        const memberDocText = await fsp.readFile(docPath, 'utf8');
        const { canonicaliseMemberDoc } = await import('./cache.js');
        const built = stage1DistillPrompt({
          memberName: name,
          memberDocCanonical: canonicaliseMemberDoc(memberDocText),
        });
        stage1Assembled.push({ memberName: name, messages: built.messages });
      }),
    );
    const stage2Built = stage2ComposePrompt({
      compositeName,
      members: stage2Members,
      cliAgentVersion,
      synthesisModel,
      activeProfile,
      ...(options.nowIso === undefined ? {} : { nowIso: options.nowIso }),
    });

    return {
      doc: '',
      frontmatter,
      totalTokens: 0,
      cacheHit: false,
      distillations,
      dryRun: {
        stage1: stage1Assembled,
        stage2: stage2Built.messages,
      },
    };
  }

  const doc = composeCompositeDoc({
    frontmatter,
    autoGenBody: stage2.markdownBody,
    userRecipes: '',
    userNotes: '',
  });

  return {
    doc,
    frontmatter,
    totalTokens: runningTokens,
    cacheHit: false,
    distillations,
  };
}

/* --------------------------------------------------------------------- */
/* Internal helpers                                                       */
/* --------------------------------------------------------------------- */

/**
 * Resolve the running cli-agent semver. Reads from
 * `process.env.npm_package_version` when run under npm, falls back to
 * `CLI_VERSION` constant exported by `agent/logging.ts`. Both are
 * static; the runtime never lacks a version string.
 */
function readCliAgentVersion(): string {
  const fromEnv = process.env['npm_package_version'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return CLI_VERSION;
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
