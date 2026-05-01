/**
 * `agt_grep` — LangChain `DynamicStructuredTool` wrapper around the vendored
 * upstream `grep` tool (regex content search; ripgrep-backed with a JS
 * fallback). Read-only.
 *
 * Same wrapping conventions as `agt_glob`:
 *   - reads `workingDirectory` (REQUIRED) + `signal` from
 *     `RunnableConfig.configurable`;
 *   - throws on missing `workingDirectory` (no fallback);
 *   - swallows upstream errors into `[agt_grep error] ...` strings.
 *
 * The upstream tool caps results at 100 matches and renders one of
 * three output modes; both behaviours are forwarded verbatim.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { grepTool } from '../agent-tools-vendored/upstream/src/tools/grep/index.js';
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

/** LangChain-visible tool name. */
export const AGT_GREP_NAME = 'agt_grep' as const;

/**
 * Sourced from the canonical `BUILTIN_TOOL_PROMPTS` registry. Trimmed
 * from the upstream `grep.prompt.md` (~689 chars). The original full
 * prompt remains preserved upstream.
 */
export const AGT_GREP_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_GREP_NAME]!.description;

/** Dependency bag injected by U5. */
export interface AgtGrepDeps {
  permissions: PermissionPolicy;
  overlays?: OverlayRegistry;
}

export function buildAgtGrepTool(deps: AgtGrepDeps): DynamicStructuredTool {
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_GREP_NAME]!;
  const reg = deps.overlays;
  const agtGrepSchema = z.object({
    pattern: z
      .string()
      .min(1)
      .describe(
        getParamDescription(reg, AGT_GREP_NAME, 'pattern', BUILTIN.parameters['pattern']!),
      ),
    path: z
      .string()
      .optional()
      .describe(
        getParamDescription(reg, AGT_GREP_NAME, 'path', BUILTIN.parameters['path']!),
      ),
    include: z
      .string()
      .optional()
      .describe(
        getParamDescription(reg, AGT_GREP_NAME, 'include', BUILTIN.parameters['include']!),
      ),
    outputMode: z
      .enum(['content', 'files_with_matches', 'count'])
      .optional()
      .describe(
        getParamDescription(reg, AGT_GREP_NAME, 'outputMode', BUILTIN.parameters['outputMode']!),
      ),
  });
  return new DynamicStructuredTool({
    name: AGT_GREP_NAME,
    description: getToolDescription(reg, AGT_GREP_NAME, BUILTIN.description),
    schema: agtGrepSchema,
    func: async (input, _runManager, config) => {
      const cfg = (config?.configurable ?? {}) as Partial<AgentToolsConfigurable>;
      if (typeof cfg.workingDirectory !== 'string' || cfg.workingDirectory.length === 0) {
        throw new Error(
          `${AGT_GREP_NAME}: configurable.workingDirectory is required`,
        );
      }
      const ctx: ToolContext = {
        cwd: cfg.workingDirectory,
        permissions: deps.permissions,
        ...(cfg.signal !== undefined ? { signal: cfg.signal } : {}),
      };
      try {
        const result = await grepTool.execute(input, ctx);
        if (result.ok) {
          return result.output.length === 0 ? '(no matches)' : result.output;
        }
        return `[${AGT_GREP_NAME} error] ${result.error.code}: ${result.error.message}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `[${AGT_GREP_NAME} error] ${message}`;
      }
    },
  });
}
