/**
 * Assemble the YAML frontmatter + AUTO-GENERATED block + preserved USER-NOTES.
 */

import crypto from 'node:crypto';
import type { SubcommandInfo } from './extractSubcommands.js';

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
  schemaVersion?: number;
}

const USER_NOTES_START = '<!-- USER-NOTES:START -->';
const USER_NOTES_END = '<!-- USER-NOTES:END -->';

/**
 * Extract the USER-NOTES section from an existing document, if present.
 */
export function extractUserNotes(existingDoc: string): string {
  const start = existingDoc.indexOf(USER_NOTES_START);
  const end = existingDoc.indexOf(USER_NOTES_END);
  if (start === -1 || end === -1) return '';
  return existingDoc.slice(start, end + USER_NOTES_END.length);
}

export function composeCapabilityDoc(opts: ComposeOptions, existingDoc?: string): string {
  const now = new Date().toISOString();
  const schemaVersion = opts.schemaVersion ?? 1;

  // Build AUTO-GENERATED content
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

  const contentHash = crypto
    .createHash('sha256')
    .update(generatedContent)
    .digest('hex')
    .slice(0, 16);

  const versionHashShort = opts.versionHash.replace('sha256:', '').slice(0, 16);

  const frontmatter = [
    '---',
    `tool: ${opts.tool}`,
    `binaryPath: ${opts.binaryPath}`,
    `binaryMtimeMs: ${opts.binaryMtimeMs}`,
    `versionString: "${opts.versionString}"`,
    `versionHash: sha256:${versionHashShort}`,
    `introspectedAt: ${now}`,
    `introspectionDepth: ${opts.introspectionDepth}`,
    `introspectionBytes: ${opts.introspectionBytes}`,
    `schemaVersion: ${schemaVersion}`,
    '---',
  ].join('\n');

  const autoGenBlock = [
    `<!-- AUTO-GENERATED:START hash=${contentHash} -->`,
    generatedContent.trim(),
    '<!-- AUTO-GENERATED:END -->',
  ].join('\n');

  // Preserve USER-NOTES from existing doc or start with empty block
  const userNotes = existingDoc
    ? extractUserNotes(existingDoc)
    : `${USER_NOTES_START}\n${USER_NOTES_END}`;

  return [frontmatter, '', autoGenBlock, '', userNotes].join('\n') + '\n';
}

/**
 * Compose a compact system-prompt entry when the full doc exceeds the byte budget.
 * Returns synopsis + table-of-contents only.
 */
export function composeCompactEntry(tool: string, synopsis: string, subcommandNames: SubcommandInfo[]): string {
  let out = `## ${tool}\n\n`;
  out += `**Synopsis (truncated — use tool_help for details):**\n\`\`\`\n${synopsis.slice(0, 2048)}\n\`\`\`\n`;
  if (subcommandNames.length > 0) {
    out += `\n**Subcommands:** ${subcommandNames.map((s) => `\`${s.name}\``).join(', ')}\n`;
  }
  return out;
}
