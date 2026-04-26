import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolveSandboxPath } from './sandbox.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';

const schema = z.object({
  path: z.string().min(1).describe('Directory path to list (relative to file root or absolute).'),
  glob: z.string().optional().describe('Optional glob pattern to filter files (e.g. "*.ts").'),
});

export function createFileListTool(cfg: AgentConfig): DynamicStructuredTool {
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
  };

  return new DynamicStructuredTool({
    name: 'file_list',
    description: 'List files in a directory inside the allowed file root.',
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
