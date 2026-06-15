/**
 * `agt_file_edit` — LangChain `DynamicStructuredTool` that find/replaces text
 * in a file inside the sandbox root. Re-homed from the former built-in
 * `file_edit` into the agent-tools (`agt_*`) pack (plan-012).
 *
 * FIRST-PARTY agt_ member (not vendored). REUSES cli-agent's own sandbox
 * (`../file/sandbox.js`). MUTATING: the `confirmed: true` gate is preserved
 * verbatim; the RUNTIME `allowMutations` gate lives in `group-builder.ts`.
 * Governed by `--agent-tools` + `--enable/--disable-agt-file-edit`
 * (default ON) + `--allow-mutations`.
 *
 * The body is the former `createFileEditTool` verbatim (regex/literal branch,
 * occurrence first/all, `E_FILE_EDIT_NO_MATCH`, replacement count), with the
 * name and prompt key changed to `agt_file_edit` and a `{ cfg, overlays }`
 * deps bag.
 */

import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import { resolveSandboxPath } from '../file/sandbox.js';
import { handleToolError } from '../types.js';
import { FileError } from '../../../errors.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import {
  getToolDescription,
  getParamDescription,
  type OverlayRegistry,
} from '../tool-prompt-overlay.js';
import { mergeProfileToolArgs, type ProfileToolArgsConfigurable } from '../profile-tool-args.js';

/** LangChain-visible tool name. Stable across catalog / prompt-block. */
export const AGT_FILE_EDIT_NAME = 'agt_file_edit' as const;

/** Canonical description (single literal per tool, via BUILTIN_TOOL_PROMPTS). */
export const AGT_FILE_EDIT_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_FILE_EDIT_NAME]!.description;

/** Dependency bag injected by the catalog builder (`group-builder.ts`). */
export interface AgtFileEditDeps {
  cfg: AgentConfig;
  /** Optional overlay registry; user-edited descriptions win when present. */
  overlays?: OverlayRegistry;
}

/** Build the LangChain tool. */
export function buildAgtFileEditTool(deps: AgtFileEditDeps): DynamicStructuredTool {
  const { cfg } = deps;
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
  };
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_FILE_EDIT_NAME]!;
  const reg = deps.overlays ?? cfg.toolPromptOverlays;
  const schema = z.object({
    path: z.string().min(1).describe(
      getParamDescription(reg, AGT_FILE_EDIT_NAME, 'path', BUILTIN.parameters['path']!),
    ),
    find: z.string().min(1).describe(
      getParamDescription(reg, AGT_FILE_EDIT_NAME, 'find', BUILTIN.parameters['find']!),
    ),
    replace: z.string().describe(
      getParamDescription(reg, AGT_FILE_EDIT_NAME, 'replace', BUILTIN.parameters['replace']!),
    ),
    occurrence: z.enum(['first', 'all']).optional().describe(
      getParamDescription(reg, AGT_FILE_EDIT_NAME, 'occurrence', BUILTIN.parameters['occurrence']!),
    ),
    use_regex: z.boolean().optional().describe(
      getParamDescription(reg, AGT_FILE_EDIT_NAME, 'use_regex', BUILTIN.parameters['use_regex']!),
    ),
    confirmed: z.boolean().describe(
      getParamDescription(reg, AGT_FILE_EDIT_NAME, 'confirmed', BUILTIN.parameters['confirmed']!),
    ),
  });

  return new DynamicStructuredTool({
    name: AGT_FILE_EDIT_NAME,
    description: getToolDescription(reg, AGT_FILE_EDIT_NAME, BUILTIN.description),
    schema,
    func: async (rawInput, _runManager, runConfig) => {
      const input = mergeProfileToolArgs(
        rawInput,
        runConfig?.configurable as ProfileToolArgsConfigurable | undefined,
        AGT_FILE_EDIT_NAME,
      );
      try {
        if (!input.confirmed) {
          return JSON.stringify({
            requires_confirmation: true,
            operation: 'agt_file_edit',
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
