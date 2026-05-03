/**
 * Composite-doc regenerate + delete lifecycle (plan-006 P6 / U-DOC).
 *
 * U-DOC owns the "USER-* preservation" extension layer that sits on top
 * of the schema-3 cache foundation (`cache.ts`, `composeCompositeDoc.ts`):
 *
 *   - `regenerateCompositeDoc` — preserves USER-RECIPES and USER-NOTES
 *     byte-for-byte across a `--regenerate-capabilities` rerun, then
 *     atomically swaps the canonical doc + capabilities mirror copy.
 *   - `deleteCompositeDocs`     — tears the canonical + mirror pair down
 *     for `composite-delete`, refusing to remove a user-modified mirror.
 *
 * AC-6 (USER blocks preserved across regenerate) is the load-bearing
 * acceptance criterion this module satisfies.
 *
 * Foundation primitives consumed (cache.ts, composeCompositeDoc.ts):
 *   - `readCompositeDoc` (schema-3 reader)
 *   - `writeCompositeDoc` (atomic write at mode 0o600)
 *   - `composeCompositeDoc` (composer with USER-* preservation knobs)
 *   - `extractCompositeUserRecipes` / `extractCompositeUserNotes`
 *     (markers-included extractors used to roundtrip prior bodies)
 *   - `mirrorCompositeDocToCapabilities` (writes the
 *     `<capabilitiesDir>/<id>.md` mirror copy per ADR-CMP-12)
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  extractCompositeUserNotes,
  extractCompositeUserRecipes,
  mirrorCompositeDocToCapabilities,
  readCompositeDoc,
  writeCompositeDoc,
} from './cache.js';
import { composeCompositeDoc } from './composeCompositeDoc.js';
import type { CompositeFrontmatter } from './types.js';

/* ------------------------------------------------------------------ */
/* Markers (mirror cache.ts; needed locally for body-stripping)        */
/* ------------------------------------------------------------------ */

const USER_RECIPES_START = '<!-- USER-RECIPES:START -->';
const USER_RECIPES_END = '<!-- USER-RECIPES:END -->';
const USER_NOTES_START = '<!-- USER-NOTES:START -->';
const USER_NOTES_END = '<!-- USER-NOTES:END -->';

/* ------------------------------------------------------------------ */
/* Regenerate: USER-* preservation                                     */
/* ------------------------------------------------------------------ */

export interface RegenInputs {
  readonly compositeName: string;
  /** `<compositeCapabilitiesDir>/<id>.md` (canonical schema-3 doc). */
  readonly compositeDocPath: string;
  /** Frontmatter for the new run; `composeCompositeDoc` will recompute
   * the `syntheticDigest` so callers may pass any placeholder there. */
  readonly newFrontmatter: CompositeFrontmatter;
  /** AUTO-GENERATED body produced by Stage-2 of the new synthesis run.
   * Markers are added by the composer; pass the inner body only. */
  readonly newAutoGenBody: string;
  /** `<agentDir>/capabilities/` — for the mirror copy (ADR-CMP-12). */
  readonly capabilitiesDir: string;
}

export interface RegenResult {
  /** Absolute path to the canonical doc that was just rewritten. */
  readonly path: string;
  /** Absolute path to the mirror copy under `capabilitiesDir`. */
  readonly mirrorPath: string;
  /** True iff a non-empty USER-RECIPES body was carried over from the
   * prior doc. */
  readonly preservedUserRecipes: boolean;
  /** True iff a non-empty USER-NOTES body was carried over from the
   * prior doc. */
  readonly preservedUserNotes: boolean;
  /** `null` when no prior doc existed (first synthesis); otherwise the
   * `syntheticDigest` recorded in the prior frontmatter. Useful for
   * telemetry / cli-agent's "what changed" diagnostics. */
  readonly previousSyntheticDigest: string | null;
  /** The freshly composed `syntheticDigest` (parsed back from the new
   * doc on disk). */
  readonly newSyntheticDigest: string;
}

/**
 * Strip the surrounding USER-RECIPES / USER-NOTES marker pair from a
 * marker-included block and return the inner body (trimmed of leading
 * and trailing whitespace surrounding the markers). The composer
 * accepts the marker-stripped body, so this is the de-facto inverse of
 * `extractCompositeUserRecipes` / `extractCompositeUserNotes`.
 *
 * Returns `''` for an empty (markers-only) block; the composer treats
 * that as "no user content, emit empty markers".
 */
function stripUserBlockMarkers(blockWithMarkers: string, startTag: string, endTag: string): string {
  if (blockWithMarkers.length === 0) return '';
  const s = blockWithMarkers.indexOf(startTag);
  const e = blockWithMarkers.indexOf(endTag);
  if (s === -1 || e === -1 || e < s) return '';
  return blockWithMarkers.slice(s + startTag.length, e).trim();
}

/**
 * Regenerate a composite doc while preserving the prior USER-RECIPES
 * and USER-NOTES bodies byte-for-byte (modulo their surrounding
 * markers, which the composer always emits).
 *
 * Algorithm:
 *   1. Read the prior doc (if it exists). Failure modes (`malformed`,
 *      `integrity_failed`, `cli_version_mismatch`,
 *      `schema_version_unsupported`) all collapse to "no preservable
 *      USER-* content" — we can't trust the bytes, so we fall through
 *      to empty-body composition. The synthesis pipeline itself decides
 *      whether to emit a stderr notice for those reasons.
 *   2. Compose the new doc with the carried-over USER-* bodies and the
 *      new AUTO-GENERATED body.
 *   3. Atomic-write to `compositeDocPath` (cache.ts:writeCompositeDoc).
 *   4. Mirror-copy to `<capabilitiesDir>/<compositeName>.md` so
 *      `composeCapabilitiesSystemPrompt` finds it (ADR-CMP-12).
 *
 * The full sequence is "regenerate while preserving USER-*"; from the
 * outer agent's perspective, by the time this returns both the
 * canonical and the mirror are coherent and contain the new body.
 *
 * AC-6 (`--regenerate-capabilities` preserves USER blocks).
 */
export async function regenerateCompositeDoc(inputs: RegenInputs): Promise<RegenResult> {
  // ---- 1. Read prior doc to harvest USER-* + previous digest ----
  let preservedRecipesBody = '';
  let preservedNotesBody = '';
  let previousSyntheticDigest: string | null = null;

  let priorRaw: string | null = null;
  try {
    priorRaw = await fsp.readFile(inputs.compositeDocPath, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
    // No prior doc → empty USER-* (handled by composer's defaults).
  }

  if (priorRaw !== null) {
    // Foundation extractors return marker-included blocks.
    const recipesBlock = extractCompositeUserRecipes(priorRaw);
    const notesBlock = extractCompositeUserNotes(priorRaw);
    preservedRecipesBody = stripUserBlockMarkers(
      recipesBlock,
      USER_RECIPES_START,
      USER_RECIPES_END,
    );
    preservedNotesBody = stripUserBlockMarkers(
      notesBlock,
      USER_NOTES_START,
      USER_NOTES_END,
    );

    // Best-effort previousSyntheticDigest harvest. We use the schema-3
    // reader so a corrupt/integrity-failed prior doc surfaces as "no
    // recoverable previous digest" rather than crashing the regen.
    const priorRead = await readCompositeDoc(inputs.compositeDocPath);
    if (priorRead.ok) {
      previousSyntheticDigest = priorRead.doc.frontmatter.syntheticDigest;
    }
  }

  // ---- 2. Compose new doc with preserved USER-* ----
  const newDoc = composeCompositeDoc({
    frontmatter: inputs.newFrontmatter,
    autoGenBody: inputs.newAutoGenBody,
    userRecipes: preservedRecipesBody,
    userNotes: preservedNotesBody,
  });

  // ---- 3. Atomic write of canonical doc ----
  await writeCompositeDoc(inputs.compositeDocPath, newDoc);

  // ---- 4. Mirror copy to capabilitiesDir ----
  const mirrorPath = await mirrorCompositeDocToCapabilities(
    inputs.compositeDocPath,
    inputs.capabilitiesDir,
    inputs.compositeName,
  );

  // Read back the new doc to extract the composer-recomputed
  // syntheticDigest (the composer recomputes it deterministically; we
  // re-parse rather than re-compute here so the returned digest reflects
  // exactly what's on disk).
  const verifyRead = await readCompositeDoc(inputs.compositeDocPath);
  if (!verifyRead.ok) {
    // This branch is structurally unreachable when the composer + writer
    // are consistent (every regen we just wrote a valid schema-3 doc).
    // We surface a clear error rather than silently returning a stale
    // digest, which would corrupt telemetry downstream.
    throw new Error(
      `regenerateCompositeDoc: post-write read failed (${verifyRead.reason}). ` +
        `This indicates a foundation-level inconsistency between composer + reader.`,
    );
  }

  return {
    path: inputs.compositeDocPath,
    mirrorPath,
    preservedUserRecipes: preservedRecipesBody.length > 0,
    preservedUserNotes: preservedNotesBody.length > 0,
    previousSyntheticDigest,
    newSyntheticDigest: verifyRead.doc.frontmatter.syntheticDigest,
  };
}

/* ------------------------------------------------------------------ */
/* Delete: canonical + mirror teardown                                 */
/* ------------------------------------------------------------------ */

export interface DeleteInputs {
  readonly compositeName: string;
  /** `<compositeCapabilitiesDir>/<id>.md` (canonical schema-3 doc). */
  readonly compositeDocPath: string;
  /** `<agentDir>/capabilities/` — for the mirror copy (ADR-CMP-12). */
  readonly capabilitiesDir: string;
  /** `<agentDir>/capabilities/composite/_distill/` — the Stage-1
   * per-member distill cache. NEVER touched by this delete path
   * (Stage-1 entries are keyed by `<member>@<digest>` and shared across
   * composites; deleting them here would needlessly invalidate other
   * composites that share members). The path is accepted in the input
   * shape for API symmetry / future-proofing only. */
  readonly distillDir: string;
}

export interface DeleteResult {
  /** Absolute paths that were removed. */
  readonly deleted: readonly string[];
  /** Non-fatal warnings (e.g., user-modified mirror was preserved). */
  readonly warnings: readonly string[];
}

/**
 * Tear down the canonical doc + the mirror copy in one shot. Refuses
 * to remove a user-modified mirror (content mismatch with the
 * canonical) — those are returned in `warnings` so the caller can show
 * the user what was preserved.
 *
 * The Stage-1 distill cache (`<distillDir>/<member>@<digest>.json`) is
 * INTENTIONALLY left in place: cache entries are keyed by member +
 * member-doc digest, NOT by composite, so multiple composites sharing
 * the same members reuse the same cached distillations. Deleting them
 * here would silently invalidate those siblings. (See plan-006
 * §14.F / ADR-CMP-1.)
 */
export async function deleteCompositeDocs(inputs: DeleteInputs): Promise<DeleteResult> {
  const deleted: string[] = [];
  const warnings: string[] = [];

  // Capture canonical bytes BEFORE deletion so we can compare to the
  // mirror. If the canonical is missing, we'll fall through to a "best
  // effort" mirror cleanup with no comparison possible — which we
  // refuse, since we can't tell whether the mirror is user-modified.
  let canonicalBytes: Buffer | null = null;
  try {
    canonicalBytes = await fsp.readFile(inputs.compositeDocPath);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }

  // ---- Delete the canonical doc ----
  if (canonicalBytes !== null) {
    try {
      await fsp.unlink(inputs.compositeDocPath);
      deleted.push(inputs.compositeDocPath);
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e;
    }
  }

  // ---- Delete the mirror copy IFF it matches the canonical ----
  const mirrorPath = path.join(inputs.capabilitiesDir, `${inputs.compositeName}.md`);
  let mirrorBytes: Buffer | null = null;
  try {
    mirrorBytes = await fsp.readFile(mirrorPath);
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }

  if (mirrorBytes !== null) {
    if (canonicalBytes === null) {
      // We can't compare; refuse to delete — this is the safe choice.
      // The user can `rm` the mirror manually if they really want it gone.
      warnings.push(
        `mirror at ${mirrorPath} preserved: canonical doc was missing, ` +
          `cannot verify the mirror is unmodified`,
      );
    } else if (Buffer.compare(canonicalBytes, mirrorBytes) === 0) {
      try {
        await fsp.unlink(mirrorPath);
        deleted.push(mirrorPath);
      } catch (e) {
        if ((e as { code?: string }).code !== 'ENOENT') throw e;
      }
    } else {
      warnings.push(
        `mirror at ${mirrorPath} preserved: content differs from canonical doc ` +
          `(user modifications detected)`,
      );
    }
  }

  // ---- Stage-1 distill cache: intentionally NOT touched ----
  // Reference inputs.distillDir so the parameter is not silently dropped
  // by linters; documents the policy decision in code.
  void inputs.distillDir;

  return { deleted, warnings };
}
