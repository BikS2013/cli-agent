/**
 * Compose the "Wrapped CLI Capabilities" section of the system prompt
 * from cached capability documents. Pulls in:
 *
 *   - the AUTO-GENERATED block (synopsis, subcommands, manual reference)
 *   - the user-curated recipes block (preserved across refresh)
 *   - the user-curated notes block (preserved across refresh)
 *
 * When the per-tool byte budget would be exceeded, falls through to a
 * compact entry that keeps the synopsis, subcommand TOC, and the
 * manRef pointer + a recipes-availability hint so the agent always
 * knows where to look on demand.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { composeCompactEntry } from './composeMarkdown.js';

const AUTO_GEN_START = '<!-- AUTO-GENERATED:START';
const AUTO_GEN_END = '<!-- AUTO-GENERATED:END -->';
const USER_NOTES_START_TAG = '<!-- USER-NOTES:START -->';
const USER_NOTES_END_TAG = '<!-- USER-NOTES:END -->';
const USER_RECIPES_START_TAG = '<!-- USER-RECIPES:START -->';
const USER_RECIPES_END_TAG = '<!-- USER-RECIPES:END -->';

/**
 * Extract the AUTO-GENERATED section body from a capability doc.
 */
function extractAutoGenBody(content: string): string {
  const start = content.indexOf(AUTO_GEN_START);
  const end = content.indexOf(AUTO_GEN_END);
  if (start === -1 || end === -1) return content;
  const bodyStart = content.indexOf('\n', start) + 1;
  return content.slice(bodyStart, end).trim();
}

/**
 * Extract the top-level synopsis from the auto-generated body.
 */
function extractSynopsis(autoGenBody: string): string {
  const match = autoGenBody.match(/## Top-level synopsis[\s\S]*?```\n([\s\S]*?)```/);
  return match ? match[1]!.trim() : autoGenBody.slice(0, 1024);
}

/**
 * Extract subcommand names from the auto-generated body.
 */
function extractSubcommandNames(autoGenBody: string): Array<{ name: string; oneLineSynopsis: string }> {
  const names: Array<{ name: string; oneLineSynopsis: string }> = [];
  const re = /### (\S+)\n\n\*\*Synopsis:\*\* ([^\n]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(autoGenBody)) !== null) {
    names.push({ name: match[1]!, oneLineSynopsis: match[2]! });
  }
  return names;
}

/** Read the `manRef` field from a doc's YAML frontmatter. Returns null
 * when absent (schema-1 docs, v2 docs without a man page, malformed
 * frontmatter). Lightweight inline parser — keeps this composer
 * self-contained instead of forcing every caller through `cache.ts`. */
function extractManRef(content: string): string | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const m = fmMatch[1]!.match(/^manRef:\s*(.+)$/m);
  if (!m) return null;
  const raw = m[1]!.trim().replace(/^"(.*)"$/, '$1');
  return raw.length > 0 ? raw : null;
}

function extractTaggedBlock(
  content: string,
  startTag: string,
  endTag: string,
): string {
  const s = content.indexOf(startTag);
  const e = content.indexOf(endTag);
  if (s === -1 || e === -1) return '';
  return content.slice(s + startTag.length, e).trim();
}

export interface CapabilitySection {
  tool: string;
  content: string;
  truncated: boolean;
  bytes: number;
}

export async function composeCapabilitiesSystemPrompt(
  capabilitiesDir: string,
  tools: ReadonlyArray<string>,
  maxBytesPerTool: number,
): Promise<string> {
  if (tools.length === 0) return '';

  const sections: CapabilitySection[] = [];

  for (const tool of tools) {
    const filePath = path.join(capabilitiesDir, `${tool}.md`);
    try {
      const content = await fsp.readFile(filePath, 'utf8');
      const autoGenBody = extractAutoGenBody(content);
      const userNotes = extractTaggedBlock(content, USER_NOTES_START_TAG, USER_NOTES_END_TAG);
      const userRecipes = extractTaggedBlock(content, USER_RECIPES_START_TAG, USER_RECIPES_END_TAG);
      const manRef = extractManRef(content);

      const bodyBytes = Buffer.byteLength(autoGenBody, 'utf8');
      const recipesBytes = Buffer.byteLength(userRecipes, 'utf8');
      const notesBytes = Buffer.byteLength(userNotes, 'utf8');
      const projectedBytes = bodyBytes + recipesBytes + notesBytes;

      let sectionContent: string;
      let truncated = false;

      if (projectedBytes <= maxBytesPerTool) {
        sectionContent = `## ${tool} capability\n\n${autoGenBody}`;
        if (userRecipes) sectionContent += `\n\n**User recipes:**\n${userRecipes}`;
        if (userNotes) sectionContent += `\n\n**User notes:**\n${userNotes}`;
      } else {
        // Over budget — embed compact entry. ManRef + recipes-available
        // hint are kept (cheap, high-value); full recipes/notes are not
        // — the agent fetches them on demand via tool_help.
        const synopsis = extractSynopsis(autoGenBody);
        const subcommandNames = extractSubcommandNames(autoGenBody);
        sectionContent = composeCompactEntry(
          tool,
          synopsis,
          subcommandNames,
          manRef,
          userRecipes.length > 0,
        );
        if (userNotes) sectionContent += `\n\n**User notes:**\n${userNotes}`;
        truncated = true;
      }

      sections.push({ tool, content: sectionContent, truncated, bytes: projectedBytes });
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') {
        sections.push({
          tool,
          content: `## ${tool}\n\n(No capability document found. Run: cli-agent refresh-capabilities --tool ${tool})\n`,
          truncated: false,
          bytes: 0,
        });
      }
    }
  }

  if (sections.length === 0) return '';

  return [
    '## Wrapped CLI Capabilities',
    '',
    'The following tools are available via bash_run. Use their exact subcommand names and flags.',
    '',
    ...sections.map((s) => s.content),
  ].join('\n');
}
