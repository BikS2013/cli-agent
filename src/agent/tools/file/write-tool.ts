import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import { resolveSandboxPath } from './sandbox.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';

const schema = z.object({
  path: z.string().min(1).describe('Path to write (relative to file root or absolute).'),
  content: z.string().describe('Full content to write to the file.'),
  confirmed: z.boolean().describe('Must be true to proceed with the write.'),
});

export function createFileWriteTool(cfg: AgentConfig): DynamicStructuredTool {
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
  };

  return new DynamicStructuredTool({
    name: 'file_write',
    description: '[MUTATING] Overwrite a file with new content. Requires confirmed: true.',
    schema,
    func: async (input) => {
      try {
        if (!input.confirmed) {
          return JSON.stringify({
            requires_confirmation: true,
            operation: 'file_write',
            path: input.path,
            message: 'Set confirmed: true to proceed with writing this file.',
          });
        }
        const resolved = resolveSandboxPath(input.path, sandboxCfg);
        await fsp.writeFile(resolved, input.content, 'utf8');
        return JSON.stringify({ ok: true, path: resolved, bytesWritten: Buffer.byteLength(input.content, 'utf8') });
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
