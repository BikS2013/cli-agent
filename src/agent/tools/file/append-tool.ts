import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import { resolveSandboxPath } from './sandbox.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import { getToolDescription, getParamDescription } from '../tool-prompt-overlay.js';

const TOOL_NAME = 'file_append';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL_NAME]!;

export function createFileAppendTool(cfg: AgentConfig): DynamicStructuredTool {
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
  };
  const reg = cfg.toolPromptOverlays;
  const schema = z.object({
    path: z.string().min(1).describe(
      getParamDescription(reg, TOOL_NAME, 'path', BUILTIN.parameters['path']!),
    ),
    content: z.string().describe(
      getParamDescription(reg, TOOL_NAME, 'content', BUILTIN.parameters['content']!),
    ),
    confirmed: z.boolean().describe(
      getParamDescription(reg, TOOL_NAME, 'confirmed', BUILTIN.parameters['confirmed']!),
    ),
  });

  return new DynamicStructuredTool({
    name: TOOL_NAME,
    description: getToolDescription(reg, TOOL_NAME, BUILTIN.description),
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
