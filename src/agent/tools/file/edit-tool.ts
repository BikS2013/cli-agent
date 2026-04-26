import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import { resolveSandboxPath } from './sandbox.js';
import { handleToolError } from '../types.js';
import { FileError } from '../../../errors.js';
import type { AgentConfig } from '../../../config/agent-config.js';

const schema = z.object({
  path: z.string().min(1).describe('File path to edit.'),
  find: z.string().min(1).describe('Exact substring or regex pattern to find.'),
  replace: z.string().describe('Replacement string.'),
  occurrence: z.enum(['first', 'all']).optional().describe('Which occurrence to replace: "first" (default) or "all".'),
  use_regex: z.boolean().optional().describe('Treat find as a regular expression.'),
  confirmed: z.boolean().describe('Must be true to proceed.'),
});

export function createFileEditTool(cfg: AgentConfig): DynamicStructuredTool {
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
  };

  return new DynamicStructuredTool({
    name: 'file_edit',
    description: '[MUTATING] Find and replace text in a file. Requires confirmed: true.',
    schema,
    func: async (input) => {
      try {
        if (!input.confirmed) {
          return JSON.stringify({
            requires_confirmation: true,
            operation: 'file_edit',
            path: input.path,
            find: input.find,
            message: 'Set confirmed: true to proceed with editing this file.',
          });
        }
        const resolved = resolveSandboxPath(input.path, sandboxCfg);
        const content = await fsp.readFile(resolved, 'utf8');

        let pattern: RegExp;
        if (input.use_regex) {
          const flags = input.occurrence === 'all' ? 'g' : '';
          pattern = new RegExp(input.find, flags);
        } else {
          const escaped = input.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const flags = input.occurrence === 'all' ? 'g' : '';
          pattern = new RegExp(escaped, flags);
        }

        if (!pattern.test(content)) {
          throw new FileError(
            'E_FILE_EDIT_NO_MATCH',
            `Pattern not found in '${resolved}': ${input.find}`,
            { path: resolved, find: input.find },
          );
        }

        const matches = content.match(new RegExp(pattern.source, 'g'));
        if ((matches?.length ?? 0) > 1 && input.occurrence !== 'all') {
          // Ambiguous — multiple matches but occurrence='first' (default) is explicit enough
        }

        const newContent = content.replace(pattern, input.replace);
        await fsp.writeFile(resolved, newContent, 'utf8');
        return JSON.stringify({ ok: true, path: resolved, replacements: matches?.length ?? 1 });
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
