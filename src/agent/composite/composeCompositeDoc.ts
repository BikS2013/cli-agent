/**
 * Schema-3 composite capability doc composer (plan-006 P5).
 *
 * Assembles the canonical text the cache writer hashes and persists.
 * Mirrors the schema-2 composer's structure (frontmatter +
 * AUTO-GENERATED block + USER-RECIPES block + USER-NOTES block) so
 * the existing `composeCapabilitiesSystemPrompt` reader picks up
 * composite docs transparently — only the frontmatter shape and the
 * `composite: true` literal differ from schema-2.
 */

import crypto from 'node:crypto';
import { ConfigurationError } from '../../errors.js';
import {
  canonicaliseSyntheticInputs,
  computeSyntheticDigest,
} from './cache.js';
import type { CompositeFrontmatter } from './types.js';

const USER_NOTES_START = '<!-- USER-NOTES:START -->';
const USER_NOTES_END = '<!-- USER-NOTES:END -->';
const USER_RECIPES_START = '<!-- USER-RECIPES:START -->';
const USER_RECIPES_END = '<!-- USER-RECIPES:END -->';

export interface ComposeCompositeDocInput {
  /** Frontmatter for the composite. The composer overrides
   * `syntheticDigest` based on the canonical inputs the
   * frontmatter declares — callers may pass a placeholder; what they
   * pass is ignored. All other frontmatter fields are emitted
   * verbatim in canonical key order. */
  readonly frontmatter: CompositeFrontmatter;
  /** Stage-2-produced AUTO-GENERATED body (without surrounding
   * markers). Must be a non-empty string when `dryRun` is false; an
   * empty body is rejected with `ConfigurationError`. */
  readonly autoGenBody: string;
  /** Pre-filled USER-RECIPES body (markers excluded) — Stage-2 seeds
   * this on first synthesis; on regenerate, the writer preserves the
   * existing block by passing the prior body through verbatim. */
  readonly userRecipes?: string;
  /** Empty stub on first synthesis; user-edited text on regenerate.
   * Empty string is an explicit valid value. */
  readonly userNotes?: string;
}

/**
 * Compose the schema-3 composite doc as a complete UTF-8 string.
 *
 * Frontmatter key order is fixed by §14.C and load-bearing for the
 * `syntheticDigest` integrity check (the reader recomputes the
 * digest from the canonicalised input fields, so order and quoting
 * must be deterministic).
 *
 * The function recomputes `syntheticDigest` from the canonical
 * inputs (members, memberDigests, etc.) so the on-disk doc's
 * frontmatter `syntheticDigest` field always matches the digest of
 * those exact inputs. Callers do NOT need to pre-compute the digest.
 */
export function composeCompositeDoc(input: ComposeCompositeDocInput): string {
  if (input.autoGenBody.trim().length === 0) {
    throw new ConfigurationError('autoGenBody', [
      'composeCompositeDoc.autoGenBody must be non-empty (synthesis pipeline output)',
    ]);
  }

  const fm = input.frontmatter;
  // Recompute syntheticDigest deterministically from the canonical
  // inputs declared in the frontmatter. The caller's value is
  // intentionally ignored — the composer is the single source of
  // truth for this field.
  const syntheticDigest = computeSyntheticDigest(
    canonicaliseSyntheticInputs({
      schemaVersion: fm.schemaVersion,
      compositeName: fm.compositeName,
      members: fm.members,
      memberDigests: fm.memberDigests,
      cliAgentVersion: fm.cliAgentVersion,
      synthesisModel: fm.synthesisModel,
    }),
  );

  // ---- Frontmatter (canonical key order — §14.C) ----
  const fmLines: string[] = [];
  fmLines.push('---');
  fmLines.push(`schemaVersion: ${String(fm.schemaVersion)}`);
  fmLines.push('composite: true');
  fmLines.push(`compositeName: ${fm.compositeName}`);
  fmLines.push('members:');
  for (const m of [...fm.members].sort()) {
    fmLines.push(`  - ${m}`);
  }
  fmLines.push('memberDigests:');
  for (const k of Object.keys(fm.memberDigests).sort()) {
    fmLines.push(`  ${k}: ${fm.memberDigests[k]!}`);
  }
  fmLines.push(`synthesizedAt: ${fm.synthesizedAt}`);
  fmLines.push(`syntheticDigest: ${syntheticDigest}`);
  fmLines.push(`cliAgentVersion: ${fm.cliAgentVersion}`);
  fmLines.push(`synthesisModel: ${fm.synthesisModel}`);
  fmLines.push(`activeProfile: ${fm.activeProfile === null ? 'null' : fm.activeProfile}`);
  // The literal `null` is emitted as the YAML null token so the parser
  // can validate it strictly (see cache.ts:parseCompositeFrontmatter).
  fmLines.push('manRef: null');
  fmLines.push('manPagePath: null');
  fmLines.push('---');
  const frontmatter = fmLines.join('\n');

  // ---- AUTO-GENERATED block ----
  // The hash inside the START marker mirrors schema-2's pattern; it's
  // a sha256[:16] of the body bytes for change-detection in diff
  // tools (NOT used as a security/integrity primitive; that's
  // syntheticDigest's job).
  const bodyHash = crypto
    .createHash('sha256')
    .update(input.autoGenBody)
    .digest('hex')
    .slice(0, 16);
  const autoGenBlock = [
    `<!-- AUTO-GENERATED:START hash=${bodyHash} -->`,
    input.autoGenBody.trim(),
    '<!-- AUTO-GENERATED:END -->',
  ].join('\n');

  // ---- USER-RECIPES block (markers always present; body optional) ----
  const recipesBody = input.userRecipes ?? '';
  const userRecipesBlock = recipesBody.length === 0
    ? `${USER_RECIPES_START}\n${USER_RECIPES_END}`
    : `${USER_RECIPES_START}\n${recipesBody.trim()}\n${USER_RECIPES_END}`;

  // ---- USER-NOTES block (markers always present; body optional) ----
  const notesBody = input.userNotes ?? '';
  const userNotesBlock = notesBody.length === 0
    ? `${USER_NOTES_START}\n${USER_NOTES_END}`
    : `${USER_NOTES_START}\n${notesBody.trim()}\n${USER_NOTES_END}`;

  return [
    frontmatter,
    '',
    `# ${fm.compositeName} — capability document`,
    '',
    autoGenBlock,
    '',
    userRecipesBlock,
    '',
    userNotesBlock,
  ].join('\n') + '\n';
}
