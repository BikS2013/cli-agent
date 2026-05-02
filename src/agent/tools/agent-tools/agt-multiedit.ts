/**
 * `agt_multiedit` — LangChain `DynamicStructuredTool` wrapper around the
 * vendored upstream `multiedit` tool (atomic ordered string-replace over a
 * single file).
 *
 * Mutating tool: the upstream calls `ctx.permissions.evaluateFsWrite({...,
 * operation: 'edit' })` ONCE up front before reading the file. Whatever
 * `PermissionPolicy` the catalog (U5) wires in via `deps.permissions` is
 * therefore the gate. Wrappers do NOT re-evaluate the policy here.
 *
 * Same wrapping conventions as the other `agt_*` tools:
 *   - reads `workingDirectory` (REQUIRED) + `signal` from
 *     `RunnableConfig.configurable`;
 *   - throws on missing `workingDirectory`;
 *   - swallows upstream errors (including `PermissionDeniedError`) into
 *     `[agt_multiedit error] ...` strings — never throws across the
 *     LangChain adapter boundary.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { multieditTool } from '../agent-tools-vendored/upstream/src/tools/multiedit/index.js';
import type {
  PermissionPolicy,
  ToolContext,
} from '../agent-tools-vendored/upstream/src/types.js';
import type { AgentToolsConfigurable } from './types.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import {
  getToolDescription,
  getParamDescription,
  type OverlayRegistry,
} from '../tool-prompt-overlay.js';
import { mergeProfileToolArgs, type ProfileToolArgsConfigurable } from '../profile-tool-args.js';

/** LangChain-visible tool name. */
export const AGT_MULTIEDIT_NAME = 'agt_multiedit' as const;

/**
 * Sourced from the canonical `BUILTIN_TOOL_PROMPTS` registry. Trimmed
 * from `multiedit.prompt.md` (~2.6 KiB upstream). The original full
 * prompt remains preserved upstream.
 */
export const AGT_MULTIEDIT_DESCRIPTION =
  BUILTIN_TOOL_PROMPTS[AGT_MULTIEDIT_NAME]!.description;

const editEntrySchema = z.object({
  oldString: z
    .string()
    .describe('Exact text to find. Must not be empty.'),
  newString: z
    .string()
    .describe('Replacement text. Must differ from `oldString`.'),
  replaceAll: z
    .boolean()
    .optional()
    .describe(
      'When true, every occurrence of `oldString` in the current buffer ' +
        'is replaced. Default: false (single occurrence; ambiguous matches ' +
        'are rejected).',
    ),
});

/** Dependency bag injected by U5. */
export interface AgtMultieditDeps {
  permissions: PermissionPolicy;
  overlays?: OverlayRegistry;
}

export function buildAgtMultieditTool(
  deps: AgtMultieditDeps,
): DynamicStructuredTool {
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_MULTIEDIT_NAME]!;
  const reg = deps.overlays;
  const agtMultieditSchema = z.object({
    filePath: z
      .string()
      .min(1)
      .describe(
        getParamDescription(reg, AGT_MULTIEDIT_NAME, 'filePath', BUILTIN.parameters['filePath']!),
      ),
    edits: z
      .array(editEntrySchema)
      .min(1)
      .describe(
        getParamDescription(reg, AGT_MULTIEDIT_NAME, 'edits', BUILTIN.parameters['edits']!),
      ),
  });
  return new DynamicStructuredTool({
    name: AGT_MULTIEDIT_NAME,
    description: getToolDescription(reg, AGT_MULTIEDIT_NAME, BUILTIN.description),
    schema: agtMultieditSchema,
    func: async (rawInput, _runManager, config) => {
      const input = mergeProfileToolArgs(
        rawInput,
        config?.configurable as ProfileToolArgsConfigurable | undefined,
        AGT_MULTIEDIT_NAME,
      );
      const cfg = (config?.configurable ?? {}) as Partial<AgentToolsConfigurable>;
      if (typeof cfg.workingDirectory !== 'string' || cfg.workingDirectory.length === 0) {
        throw new Error(
          `${AGT_MULTIEDIT_NAME}: configurable.workingDirectory is required`,
        );
      }
      const ctx: ToolContext = {
        cwd: cfg.workingDirectory,
        permissions: deps.permissions,
        ...(cfg.signal !== undefined ? { signal: cfg.signal } : {}),
      };
      try {
        const result = await multieditTool.execute(input, ctx);
        if (result.ok) {
          return result.output;
        }
        return `[${AGT_MULTIEDIT_NAME} error] ${result.error.code}: ${result.error.message}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `[${AGT_MULTIEDIT_NAME} error] ${message}`;
      }
    },
  });
}
