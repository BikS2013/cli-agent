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

/** LangChain-visible tool name. */
export const AGT_MULTIEDIT_NAME = 'agt_multiedit' as const;

/**
 * Trimmed from `multiedit.prompt.md` (~2.6 KiB upstream). The original
 * full prompt remains preserved upstream.
 */
export const AGT_MULTIEDIT_DESCRIPTION =
  'Apply an ordered list of exact string replacements to one file atomically. ' +
  'All edits succeed or none are applied (the file on disk is left unchanged ' +
  'on any failure). Each edit is `{oldString, newString, replaceAll?}`; later ' +
  'edits operate on the result of earlier ones, so a rename can be followed ' +
  'by updates to text it introduced. Use this instead of multiple single-edit ' +
  'calls when the changes belong together; one diff, one permission check.';

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

const agtMultieditSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .describe(
      'Path to the file to modify. Resolved against the working directory ' +
        'when not absolute.',
    ),
  edits: z
    .array(editEntrySchema)
    .min(1)
    .describe('Non-empty list of edits applied in order.'),
});

/** Dependency bag injected by U5. */
export interface AgtMultieditDeps {
  permissions: PermissionPolicy;
}

export function buildAgtMultieditTool(
  deps: AgtMultieditDeps,
): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: AGT_MULTIEDIT_NAME,
    description: AGT_MULTIEDIT_DESCRIPTION,
    schema: agtMultieditSchema,
    func: async (input, _runManager, config) => {
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
