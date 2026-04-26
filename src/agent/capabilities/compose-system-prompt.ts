/**
 * Compose the "Wrapped CLI Capabilities" section of the system prompt
 * from cached capability documents.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { extractUserNotes, composeCompactEntry } from './composeMarkdown.js';
import { extractSubcommands } from './extractSubcommands.js';
import type { BaseChatModel } from '../providers/types.js';

const AUTO_GEN_START = '<!-- AUTO-GENERATED:START';
const AUTO_GEN_END = '<!-- AUTO-GENERATED:END -->';
const USER_NOTES_START = '<!-- USER-NOTES:START -->';

/**
 * Extract the AUTO-GENERATED section body from a capability doc.
 */
function extractAutoGenBody(content: string): string {
  const start = content.indexOf(AUTO_GEN_START);
  const end = content.indexOf(AUTO_GEN_END);
  if (start === -1 || end === -1) return content;
  // Get content between the markers
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
      const userNotes = extractUserNotes(content)
        .replace('<!-- USER-NOTES:START -->', '')
        .replace('<!-- USER-NOTES:END -->', '')
        .trim();

      const bodyBytes = Buffer.byteLength(autoGenBody, 'utf8');

      let sectionContent: string;
      let truncated = false;

      if (bodyBytes <= maxBytesPerTool) {
        sectionContent = `## ${tool} capability\n\n${autoGenBody}`;
        if (userNotes) sectionContent += `\n\n**User notes:**\n${userNotes}`;
      } else {
        // Over budget — embed synopsis + TOC only
        const synopsis = extractSynopsis(autoGenBody);
        const subcommandNames = extractSubcommandNames(autoGenBody);
        sectionContent = composeCompactEntry(tool, synopsis, subcommandNames);
        if (userNotes) sectionContent += `\n\n**User notes:**\n${userNotes}`;
        truncated = true;
      }

      sections.push({ tool, content: sectionContent, truncated, bytes: bodyBytes });
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
