import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import { resolveSandboxPath } from './sandbox.js';
import { handleToolError } from '../types.js';
import { FileError } from '../../../errors.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import { getToolDescription, getParamDescription } from '../tool-prompt-overlay.js';
import { mergeProfileToolArgs, type ProfileToolArgsConfigurable } from '../profile-tool-args.js';

const TOOL_NAME = 'file_edit';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL_NAME]!;

export function createFileEditTool(cfg: AgentConfig): DynamicStructuredTool {
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
  };
  const reg = cfg.toolPromptOverlays;
  const schema = z.object({
    path: z.string().min(1).describe(
      getParamDescription(reg, TOOL_NAME, 'path', BUILTIN.parameters['path']!),
    ),
    find: z.string().min(1).describe(
      getParamDescription(reg, TOOL_NAME, 'find', BUILTIN.parameters['find']!),
    ),
    replace: z.string().describe(
      getParamDescription(reg, TOOL_NAME, 'replace', BUILTIN.parameters['replace']!),
    ),
    occurrence: z.enum(['first', 'all']).optional().describe(
      getParamDescription(reg, TOOL_NAME, 'occurrence', BUILTIN.parameters['occurrence']!),
    ),
    use_regex: z.boolean().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'use_regex', BUILTIN.parameters['use_regex']!),
    ),
    confirmed: z.boolean().describe(
      getParamDescription(reg, TOOL_NAME, 'confirmed', BUILTIN.parameters['confirmed']!),
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
