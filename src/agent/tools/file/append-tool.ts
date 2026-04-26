import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import { resolveSandboxPath } from './sandbox.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';

const schema = z.object({
  path: z.string().min(1).describe('File path to append to.'),
  content: z.string().describe('Content to append.'),
  confirmed: z.boolean().describe('Must be true to proceed.'),
});

export function createFileAppendTool(cfg: AgentConfig): DynamicStructuredTool {
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
  };

  return new DynamicStructuredTool({
    name: 'file_append',
    description: '[MUTATING] Append content to an existing file. Requires confirmed: true.',
    schema,
    func: async (input) => {
      try {
        if (!input.confirmed) {
          return JSON.stringify({
            requires_confirmation: true,
            operation: 'file_append',
            path: input.path,
            message: 'Set confirmed: true to proceed with appending to this file.',
          });
        }
        const resolved = resolveSandboxPath(input.path, sandboxCfg);
        await fsp.appendFile(resolved, input.content, 'utf8');
        return JSON.stringify({ ok: true, path: resolved, bytesAppended: Buffer.byteLength(input.content, 'utf8') });
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
