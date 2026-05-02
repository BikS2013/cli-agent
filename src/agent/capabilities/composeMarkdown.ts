/**
 * Assemble the YAML frontmatter + AUTO-GENERATED block + preserved
 * USER-RECIPES + USER-NOTES sections of a per-tool capability document.
 *
 * Schema versions:
 *  - 1: original shape (synopsis + subcommands + USER-NOTES).
 *  - 2: adds optional `manRef` / `manPagePath` frontmatter fields, an
 *       inline `## Manual reference` section in the AUTO-GENERATED block
 *       when the binary has a man page, and a USER-RECIPES marker block
 *       above USER-NOTES whose content is preserved across refresh.
 */

import crypto from 'node:crypto';
import type { SubcommandInfo } from './extractSubcommands.js';

export const CAPABILITY_SCHEMA_VERSION = 2;

export interface ComposeOptions {
  tool: string;
  binaryPath: string;
  binaryMtimeMs: number;
  versionString: string;
  versionHash: string;
  introspectionDepth: number;
  introspectionBytes: number;
  topLevelHelp: string;
  subcommands: Array<{ name: string; synopsis: string; helpText: string }>;
  /** Optional schema override; defaults to the current
   * `CAPABILITY_SCHEMA_VERSION`. Tests pin v1 to exercise the migration
   * path. */
  schemaVersion?: number;
  /** Canonical man-page identifier (e.g. `man:1 git`). `null` or
   * `undefined` ⇒ no man page detected; both the frontmatter line AND
   * the inline `## Manual reference` section are omitted. */
  manRef?: string | null;
  /** Absolute path of the underlying man-page file, recorded for
   * debugging. Same null semantics as `manRef`. */
  manPagePath?: string | null;
}

const USER_NOTES_START = '<!-- USER-NOTES:START -->';
const USER_NOTES_END = '<!-- USER-NOTES:END -->';
const USER_RECIPES_START = '<!-- USER-RECIPES:START -->';
const USER_RECIPES_END = '<!-- USER-RECIPES:END -->';

/**
 * Extract the USER-NOTES section (markers included) from an existing
 * document, if present.
 */
export function extractUserNotes(existingDoc: string): string {
  const start = existingDoc.indexOf(USER_NOTES_START);
  const end = existingDoc.indexOf(USER_NOTES_END);
  if (start === -1 || end === -1) return '';
  return existingDoc.slice(start, end + USER_NOTES_END.length);
}

/**
 * Extract the USER-RECIPES section (markers included) from an existing
 * document, if present. Returns the empty string when the markers are
 * absent — the caller seeds an empty marker pair in that case.
 */
export function extractUserRecipes(existingDoc: string): string {
  const start = existingDoc.indexOf(USER_RECIPES_START);
  const end = existingDoc.indexOf(USER_RECIPES_END);
  if (start === -1 || end === -1) return '';
  return existingDoc.slice(start, end + USER_RECIPES_END.length);
}

/**
 * Extract the body inside the USER-RECIPES markers (markers stripped,
 * trimmed). Used by `tool_help --section recipes` and the system-prompt
 * composer.
 */
export function extractUserRecipesBody(existingDoc: string): string {
  const block = extractUserRecipes(existingDoc);
  if (!block) return '';
  return block
    .replace(USER_RECIPES_START, '')
    .replace(USER_RECIPES_END, '')
    .trim();
}

/**
 * Extract the body of the inline `## Manual reference` section from the
 * AUTO-GENERATED block, trimmed. Empty string when absent.
 */
export function extractManualReferenceBody(content: string): string {
  const match = content.match(/## Manual reference\n([\s\S]*?)(?=\n## |\n<!-- |$)/);
  return match?.[1] ? match[1].trim() : '';
}

export function composeCapabilityDoc(opts: ComposeOptions, existingDoc?: string): string {
  const now = new Date().toISOString();
  const schemaVersion = opts.schemaVersion ?? CAPABILITY_SCHEMA_VERSION;
  const manRef = opts.manRef ?? null;
  const manPagePath = opts.manPagePath ?? null;

  // ---- AUTO-GENERATED body ----
  let generatedContent = `# ${opts.tool} — capability document\n\n`;
  generatedContent += `## Top-level synopsis\n\n\`\`\`\n${opts.topLevelHelp.trim()}\n\`\`\`\n`;

  if (opts.subcommands.length > 0) {
    generatedContent += `\n## Subcommands\n`;
    for (const sub of opts.subcommands) {
      generatedContent += `\n### ${sub.name}\n\n**Synopsis:** ${sub.synopsis}\n\n`;
      if (sub.helpText.trim()) {
        generatedContent += `\`\`\`\n${sub.helpText.trim().slice(0, 4096)}\n\`\`\`\n`;
      }
    }
  }

  if (manRef) {
    // The section is intentionally tiny: its only job is to point the
    // agent at `man <section> <tool>` so it can fetch the real content
    // on demand via bash_run. Embedding the full man page would blow
    // the prompt budget.
    const section = manRef.replace(/^man:/, '').split(' ')[0] ?? '';
    generatedContent += `\n## Manual reference\n\n`;
    generatedContent += `A manual page is available. Read it with:\n\n`;
    generatedContent += `\`\`\`bash\nman ${section} ${opts.tool}\n\`\`\`\n\n`;
    generatedContent += `(Use \`${manRef}\` as the canonical identifier when referring to it.)\n`;
  }

  const contentHash = crypto
    .createHash('sha256')
    .update(generatedContent)
    .digest('hex')
    .slice(0, 16);

  const versionHashShort = opts.versionHash.replace('sha256:', '').slice(0, 16);

  // ---- Frontmatter ----
  const fmLines: string[] = [
    '---',
    `tool: ${opts.tool}`,
    `binaryPath: ${opts.binaryPath}`,
    `binaryMtimeMs: ${opts.binaryMtimeMs}`,
    `versionString: "${opts.versionString}"`,
    `versionHash: sha256:${versionHashShort}`,
    `introspectedAt: ${now}`,
    `introspectionDepth: ${opts.introspectionDepth}`,
    `introspectionBytes: ${opts.introspectionBytes}`,
  ];
  // Only emit manRef / manPagePath when present. Per the no-fallback
  // rule, absent is the explicit "no man page" state — we don't write
  // `manRef: null` because that is an alarm flag for stale parsers.
  if (manRef) fmLines.push(`manRef: ${manRef}`);
  if (manPagePath) fmLines.push(`manPagePath: ${manPagePath}`);
  fmLines.push(`schemaVersion: ${schemaVersion}`);
  fmLines.push('---');
  const frontmatter = fmLines.join('\n');

  const autoGenBlock = [
    `<!-- AUTO-GENERATED:START hash=${contentHash} -->`,
    generatedContent.trim(),
    '<!-- AUTO-GENERATED:END -->',
  ].join('\n');

  // ---- Preserved blocks ----
  // USER-RECIPES appears BEFORE USER-NOTES so the more frequently-edited
  // block is at the top of the user-editable region.
  const userRecipes = existingDoc
    ? (extractUserRecipes(existingDoc) || `${USER_RECIPES_START}\n${USER_RECIPES_END}`)
    : `${USER_RECIPES_START}\n${USER_RECIPES_END}`;

  const userNotes = existingDoc
    ? (extractUserNotes(existingDoc) || `${USER_NOTES_START}\n${USER_NOTES_END}`)
    : `${USER_NOTES_START}\n${USER_NOTES_END}`;

  return [frontmatter, '', autoGenBlock, '', userRecipes, '', userNotes].join('\n') + '\n';
}

/**
 * Compose a compact system-prompt entry when the full doc exceeds the
 * byte budget. Returns synopsis + table-of-contents only. When a manRef
 * is present we ALSO emit the `man …` pointer + a one-line hint that
 * recipes are available via `tool_help`, because those are the smallest
 * artifacts that still tell the agent where to look.
 */
export function composeCompactEntry(
  tool: string,
  synopsis: string,
  subcommandNames: SubcommandInfo[],
  manRef?: string | null,
  hasUserRecipes?: boolean,
): string {
  let out = `## ${tool}\n\n`;
  out += `**Synopsis (truncated — use tool_help for details):**\n\`\`\`\n${synopsis.slice(0, 2048)}\n\`\`\`\n`;
  if (subcommandNames.length > 0) {
    out += `\n**Subcommands:** ${subcommandNames.map((s) => `\`${s.name}\``).join(', ')}\n`;
  }
  if (manRef) {
    const section = manRef.replace(/^man:/, '').split(' ')[0] ?? '';
    out += `\n**Manual:** \`man ${section} ${tool}\` (canonical id: \`${manRef}\`)\n`;
  }
  if (hasUserRecipes) {
    out += `\n**User recipes:** available — call \`tool_help\` with \`section: "recipes"\`\n`;
  }
  return out;
}
