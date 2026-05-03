/**
 * Shared helpers for the `composite-*` subcommand handlers (plan-006 P6 / U-CMD).
 *
 * Houses:
 *   - `validateCompositeName` / `deriveCompositeName` — name policy from §14.F.
 *   - `renderTable` / `formatMtime` — duplicated from
 *     `src/commands/profile/shared.ts` so the composite handlers do not
 *     reach across feature boundaries.
 *   - `emitJson` — `JSON.stringify(_, null, 2) + '\n'` to stdout.
 *   - `regenerateCompositeDoc` — compose + atomic write + mirror, with
 *     USER-RECIPES / USER-NOTES preservation when the previous doc exists.
 *     This is the U-CMD-local helper around U-DOC's primitives that the
 *     prompt refers to as "regenerateCompositeDoc(...) from U-DOC".
 *   - `deleteCompositeDocs` — fs.unlink the canonical schema-3 doc and the
 *     mirror copy under `<capabilitiesDir>/<id>.md`.
 *
 * The §14.P interface contracts list `writeCompositeCacheEntry` /
 * `mirrorCompositeDocToCapabilities` as the U-DOC exports; this module
 * composes them into the higher-level "regenerate" + "delete" operations
 * U-CMD needs without forcing U-DOC to grow new public API surface.
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { UsageError } from '../../errors.js';
import { composeCompositeDoc } from '../../agent/composite/composeCompositeDoc.js';
import {
  readCompositeDoc,
  writeCompositeDoc,
  mirrorCompositeDocToCapabilities,
} from '../../agent/composite/cache.js';
import type {
  CompositeFrontmatter,
} from '../../agent/composite/types.js';

/* ------------------------------------------------------------------ */
/* Name policy (§14.F)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Composite-name regex from §14.F: lowercase alpha first char, then
 * alnum / `_` / `-`, max 63 chars.
 */
export const COMPOSITE_NAME_RE = /^[a-z][a-z0-9_-]{0,62}$/u;

/**
 * Validate a composite name against the §14.F regex. Returns the name
 * verbatim on pass; throws `UsageError` (exit 2) with the canonical
 * message on fail.
 */
export function validateCompositeName(name: string): string {
  if (!COMPOSITE_NAME_RE.test(name)) {
    throw new UsageError(
      `composite-name '${name}' violates ${COMPOSITE_NAME_RE.source}`,
      { compositeName: name, regex: COMPOSITE_NAME_RE.source },
    );
  }
  return name;
}

/**
 * Auto-derive a composite name from a sorted member list (§14.F).
 *
 * Format: sorted member names joined by `+`, suffixed with
 * `@<sha8>` where `<sha8>` is the first 8 hex chars of
 * `sha256(JSON.stringify({ members, cliAgentVersion?, schemaVersion? }))`.
 * If the joined-with-`+` form would exceed 63 chars OR violate the
 * regex (the `+` character is not in the regex's character class), the
 * derivation collapses to a digest-only `c<sha8>` form so the result
 * always passes `validateCompositeName`.
 *
 * The plan-006 §14.F text uses `<sorted-members-joined-by-+>@<hash8>`
 * as the human-friendly form; the regex does NOT permit `+`, so the
 * `+`-joined form is used for the derived KEY only — the output is
 * normalised to a regex-safe form by replacing `+` with `-`.
 */
export function deriveCompositeName(members: ReadonlyArray<string>): string {
  if (members.length === 0) {
    throw new UsageError(
      'deriveCompositeName: at least one member required',
    );
  }
  const sorted = [...members].sort();
  const hashInput = JSON.stringify({ members: sorted });
  const hash8 = crypto
    .createHash('sha256')
    .update(hashInput)
    .digest('hex')
    .slice(0, 8);
  const joined = sorted.join('+').replace(/\+/g, '-');
  const candidate = `${joined}@${hash8}`;
  // The regex forbids `@` too — replace with `-` for the canonical form.
  const sanitised = candidate.replace(/@/g, '-');
  if (COMPOSITE_NAME_RE.test(sanitised)) return sanitised;
  // Fallback: digest-only (always passes the regex).
  return `c${hash8}`;
}

/* ------------------------------------------------------------------ */
/* Table renderer (mirrors src/commands/profile/shared.ts)             */
/* ------------------------------------------------------------------ */

/**
 * Render a 2-column or N-column aligned table to a string. Follows the
 * existing `audit-tool-prompts` / `profile-list` style: pad-right
 * columns separated by two spaces, dashed underline row between header
 * and body.
 */
export function renderTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const sep = '  ';
  const fmtRow = (cells: ReadonlyArray<string>): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(sep).trimEnd();

  const lines: string[] = [];
  lines.push(fmtRow(headers));
  lines.push(fmtRow(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) lines.push(fmtRow(r));
  return lines.join('\n') + '\n';
}

/** `YYYY-MM-DD HH:mm` (UTC). Free of timezone ambiguity for table output. */
export function formatMtime(d: Date): string {
  const yr = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const hr = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yr}-${mo}-${da} ${hr}:${mi}`;
}

/* ------------------------------------------------------------------ */
/* JSON emit                                                            */
/* ------------------------------------------------------------------ */

/** Emit an object as pretty-printed JSON to stdout, terminated by `\n`. */
export function emitJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/* ------------------------------------------------------------------ */
/* TTY predicates                                                       */
/* ------------------------------------------------------------------ */

/** Returns true when both stdin AND stdout are TTYs. */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

/* ------------------------------------------------------------------ */
/* Regenerate + delete helpers                                          */
/* ------------------------------------------------------------------ */

export interface RegenerateCompositeDocInput {
  /** Full schema-3 frontmatter. The composer recomputes
   * `syntheticDigest` from canonical inputs — caller's value is
   * intentionally ignored (see composeCompositeDoc). */
  readonly frontmatter: CompositeFrontmatter;
  /** Stage-2 AUTO-GENERATED body. Required, non-empty. */
  readonly autoGenBody: string;
  /** Pre-filled USER-RECIPES body (markers excluded). When omitted and
   * a previous doc exists, the previous doc's recipes are preserved
   * verbatim. */
  readonly userRecipes?: string;
  /** USER-NOTES body. Same preservation policy as recipes. */
  readonly userNotes?: string;
  /** Canonical destination — `<compositeCapabilitiesDir>/<id>.md`. */
  readonly compositeDocPath: string;
  /** `<capabilitiesDir>` for the mirror copy (`<capabilitiesDir>/<id>.md`).
   * Required by ADR-CMP-12. */
  readonly capabilitiesDir: string;
  readonly compositeName: string;
}

export interface RegenerateCompositeDocResult {
  readonly compositeDocPath: string;
  readonly mirrorPath: string;
  /** True when an existing schema-3 doc was found at the canonical path
   * and its USER-* blocks were preserved. */
  readonly preservedUserBlocks: boolean;
}

/**
 * Compose a schema-3 composite doc, atomically write it to the canonical
 * path, and mirror-copy it to `<capabilitiesDir>/<id>.md`. Preserves
 * USER-RECIPES / USER-NOTES content from any pre-existing doc unless the
 * caller explicitly supplies the corresponding fields.
 *
 * This helper wraps U-DOC's three primitives (`composeCompositeDoc` +
 * `writeCompositeDoc` + `mirrorCompositeDocToCapabilities`) so the
 * U-CMD handlers do not duplicate the read-modify-write dance.
 */
export async function regenerateCompositeDoc(
  input: RegenerateCompositeDocInput,
): Promise<RegenerateCompositeDocResult> {
  // Best-effort read of the previous doc to preserve user-edited blocks.
  let preservedUserBlocks = false;
  let userRecipes = input.userRecipes;
  let userNotes = input.userNotes;
  if (userRecipes === undefined || userNotes === undefined) {
    const prior = await readCompositeDoc(input.compositeDocPath);
    if (prior.ok) {
      preservedUserBlocks = true;
      if (userRecipes === undefined) userRecipes = prior.doc.userRecipes;
      if (userNotes === undefined) userNotes = prior.doc.userNotes;
    }
  }

  const docText = composeCompositeDoc({
    frontmatter: input.frontmatter,
    autoGenBody: input.autoGenBody,
    userRecipes: userRecipes ?? '',
    userNotes: userNotes ?? '',
  });

  await writeCompositeDoc(input.compositeDocPath, docText);
  const mirrorPath = await mirrorCompositeDocToCapabilities(
    input.compositeDocPath,
    input.capabilitiesDir,
    input.compositeName,
  );

  return {
    compositeDocPath: input.compositeDocPath,
    mirrorPath,
    preservedUserBlocks,
  };
}

export interface DeleteCompositeDocsInput {
  /** `<compositeCapabilitiesDir>/<id>.md` (canonical schema-3 doc). */
  readonly compositeDocPath: string;
  /** `<capabilitiesDir>/<id>.md` (mirror copy). */
  readonly mirrorPath: string;
}

export interface DeleteCompositeDocsResult {
  readonly removedCanonical: boolean;
  readonly removedMirror: boolean;
}

/**
 * Delete the canonical schema-3 doc and the mirror copy. Idempotent:
 * silently tolerates either file already being absent. Any non-ENOENT
 * filesystem error is rethrown so the caller can surface it via the
 * standard `FileError` exit-code path.
 */
export async function deleteCompositeDocs(
  input: DeleteCompositeDocsInput,
): Promise<DeleteCompositeDocsResult> {
  const removedCanonical = await unlinkIfExists(input.compositeDocPath);
  const removedMirror = await unlinkIfExists(input.mirrorPath);
  return { removedCanonical, removedMirror };
}

async function unlinkIfExists(p: string): Promise<boolean> {
  try {
    await fsp.unlink(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Composite directory helpers                                          */
/* ------------------------------------------------------------------ */

/** `<compositesDir>/<id>/manifest.json`. */
export function manifestPathFor(compositesDir: string, name: string): string {
  return path.join(compositesDir, name, 'manifest.json');
}

/** `<compositesDir>/<id>/<id>` — the POSIX shim. */
export function shimPathFor(compositesDir: string, name: string): string {
  return path.join(compositesDir, name, name);
}

/** `<compositesDir>/<id>/` — the per-composite folder. */
export function compositeFolderFor(compositesDir: string, name: string): string {
  return path.join(compositesDir, name);
}

/** `<compositeCapabilitiesDir>/<id>.md` — the canonical schema-3 doc. */
export function canonicalDocPathFor(
  compositeCapabilitiesDir: string,
  name: string,
): string {
  return path.join(compositeCapabilitiesDir, `${name}.md`);
}

/** `<capabilitiesDir>/<id>.md` — the mirror copy (ADR-CMP-12). */
export function mirrorDocPathFor(capabilitiesDir: string, name: string): string {
  return path.join(capabilitiesDir, `${name}.md`);
}
