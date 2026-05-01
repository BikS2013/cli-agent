import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveSandboxPath } from './sandbox.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import { getToolDescription, getParamDescription } from '../tool-prompt-overlay.js';

const TOOL_NAME = 'file_list';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL_NAME]!;

export function createFileListTool(cfg: AgentConfig): DynamicStructuredTool {
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
  };
  const reg = cfg.toolPromptOverlays;
  const schema = z.object({
    path: z.string().min(1).describe(
      getParamDescription(reg, TOOL_NAME, 'path', BUILTIN.parameters['path']!),
    ),
    glob: z.string().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'glob', BUILTIN.parameters['glob']!),
    ),
  });

  return new DynamicStructuredTool({
    name: TOOL_NAME,
    description: getToolDescription(reg, TOOL_NAME, BUILTIN.description),
    schema,
    func: async (input) => {
      try {
        const resolved = resolveSandboxPath(input.path, sandboxCfg);
        const entries = await fsp.readdir(resolved, { withFileTypes: true });
        const items = entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          path: path.join(resolved, e.name),
        }));
        // Apply simple glob filter if provided
        const filtered = input.glob
          ? items.filter((item) => {
              const pattern = input.glob!.replace(/\./g, '\\.').replace(/\*/g, '.*');
              return new RegExp('^' + pattern + '$').test(item.name);
            })
          : items;
        return JSON.stringify({ path: resolved, items: filtered });
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
