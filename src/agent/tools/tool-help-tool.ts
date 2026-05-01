import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { handleToolError } from './types.js';
import { CapabilityError } from '../../errors.js';
import type { AgentConfig } from '../../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from './tool-prompts-builtin.js';
import { getToolDescription, getParamDescription } from './tool-prompt-overlay.js';

const TOOL_NAME = 'tool_help';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL_NAME]!;

export function createToolHelpTool(cfg: AgentConfig): DynamicStructuredTool {
  const reg = cfg.toolPromptOverlays;
  const schema = z.object({
    tool: z.string().min(1).describe(
      getParamDescription(reg, TOOL_NAME, 'tool', BUILTIN.parameters['tool']!),
    ),
    subcommand: z.string().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'subcommand', BUILTIN.parameters['subcommand']!),
    ),
    section: z.enum(['full', 'frontmatter', 'synopsis']).optional().describe(
      getParamDescription(reg, TOOL_NAME, 'section', BUILTIN.parameters['section']!),
    ),
  });
  return new DynamicStructuredTool({
    name: TOOL_NAME,
    description: getToolDescription(reg, TOOL_NAME, BUILTIN.description),
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
