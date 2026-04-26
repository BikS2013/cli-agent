import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import { resolveSandboxPath, assertMaxBytes } from './sandbox.js';
import { FileError } from '../../../errors.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';

const schema = z.object({
  path: z.string().min(1).describe('Path to the file to read (relative to file root or absolute).'),
  max_bytes: z.number().int().positive().optional().describe('Maximum bytes to read (default 1 MiB).'),
  binary: z.boolean().optional().describe('If true, return content as base64. Default: false (utf8).'),
});

export function createFileReadTool(cfg: AgentConfig): DynamicStructuredTool {
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
    maxBytes: cfg.perToolBudgetBytes,
  };

  return new DynamicStructuredTool({
    name: 'file_read',
    description: 'Read the contents of a plain-text file on disk inside the allowed file root.',
    schema,
    func: async (input) => {
      try {
        const resolved = resolveSandboxPath(input.path, sandboxCfg);
        assertMaxBytes(resolved, input.max_bytes ?? 1024 * 1024);
        let content: string;
        if (input.binary) {
          const buf = await fsp.readFile(resolved);
          content = buf.toString('base64');
        } else {
          content = await fsp.readFile(resolved, 'utf8');
        }
        return JSON.stringify({ path: resolved, content, binary: input.binary ?? false });
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') {
          throw new FileError('E_FILE_NOT_FOUND', `File not found: ${input.path}`);
        }
        if ((err as { code?: string }).code === 'EACCES') {
          throw new FileError('E_FILE_PERMISSION', `Permission denied: ${input.path}`);
        }
        return handleToolError(err);
      }
    },
  });
}
