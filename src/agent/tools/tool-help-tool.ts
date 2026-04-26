import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { handleToolError } from './types.js';
import { CapabilityError } from '../../errors.js';
import type { AgentConfig } from '../../config/agent-config.js';

const schema = z.object({
  tool: z.string().min(1).describe('Name of the wrapped CLI tool to look up.'),
  subcommand: z.string().optional().describe('Specific subcommand to retrieve help for.'),
  section: z.enum(['full', 'frontmatter', 'synopsis']).optional().describe('Which part of the document to return: "full" (default), "frontmatter", or "synopsis".'),
});

export function createToolHelpTool(cfg: AgentConfig): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'tool_help',
    description: 'Look up the full help text of a wrapped CLI tool or one of its subcommands when the in-prompt summary is insufficient.',
    schema,
    func: async (input) => {
      try {
        const capFile = path.join(cfg.capabilitiesDir, `${input.tool}.md`);
        let content: string;
        try {
          content = await fsp.readFile(capFile, 'utf8');
        } catch (e) {
          if ((e as { code?: string }).code === 'ENOENT') {
            throw new CapabilityError(
              'E_CAPABILITY_NOT_FOUND',
              `No capability document found for tool '${input.tool}'. Run: cli-agent refresh-capabilities --tool ${input.tool}`,
              { tool: input.tool },
            );
          }
          throw e;
        }

        const section = input.section ?? 'full';

        if (section === 'frontmatter') {
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          return JSON.stringify({ tool: input.tool, section: 'frontmatter', content: fmMatch ? fmMatch[0] : '' });
        }

        if (section === 'synopsis') {
          const synopsisMatch = content.match(/## Top-level synopsis\n([\s\S]*?)(?=\n## |\n<!-- |$)/);
          return JSON.stringify({ tool: input.tool, section: 'synopsis', content: synopsisMatch?.[1] ? synopsisMatch[1].trim() : '' });
        }

        // Full or subcommand section
        if (input.subcommand) {
          const subcmdRe = new RegExp(`### ${input.subcommand}\\n([\\s\\S]*?)(?=\\n### |\\n## |<!-- |$)`);
          const match = content.match(subcmdRe);
          if (!match) {
            return JSON.stringify({
              tool: input.tool,
              subcommand: input.subcommand,
              content: null,
              message: `Subcommand '${input.subcommand}' not found in capability document.`,
            });
          }
          return JSON.stringify({ tool: input.tool, subcommand: input.subcommand, content: match[1]?.trim() ?? '' });
        }

        // Return full doc, truncated to per-tool budget
        const truncated = content.length > cfg.perToolBudgetBytes;
        const text = truncated ? content.slice(0, cfg.perToolBudgetBytes) + '\n…TRUNCATED' : content;
        return JSON.stringify({ tool: input.tool, section: 'full', content: text, _truncated: truncated });
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
