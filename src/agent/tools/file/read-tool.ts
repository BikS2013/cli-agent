import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import { resolveSandboxPath, assertMaxBytes } from './sandbox.js';
import { FileError } from '../../../errors.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import { getToolDescription, getParamDescription } from '../tool-prompt-overlay.js';
import { mergeProfileToolArgs, type ProfileToolArgsConfigurable } from '../profile-tool-args.js';

const TOOL_NAME = 'file_read';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL_NAME]!;

export function createFileReadTool(cfg: AgentConfig): DynamicStructuredTool {
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
    maxBytes: cfg.perToolBudgetBytes,
  };
  const reg = cfg.toolPromptOverlays;
  const schema = z.object({
    path: z.string().min(1).describe(
      getParamDescription(reg, TOOL_NAME, 'path', BUILTIN.parameters['path']!),
    ),
    max_bytes: z.number().int().positive().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'max_bytes', BUILTIN.parameters['max_bytes']!),
    ),
    binary: z.boolean().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'binary', BUILTIN.parameters['binary']!),
    ),
  });

  return new DynamicStructuredTool({
    name: TOOL_NAME,
    description: getToolDescription(reg, TOOL_NAME, BUILTIN.description),
    schema,
    func: async (rawInput, _runManager, runConfig) => {
      const input = mergeProfileToolArgs(
        rawInput,
        runConfig?.configurable as ProfileToolArgsConfigurable | undefined,
        TOOL_NAME,
      );
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
