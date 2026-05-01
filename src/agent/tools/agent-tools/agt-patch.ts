/**
 * `agt_patch` — LangChain `DynamicStructuredTool` wrapper around the vendored
 * upstream `patch` tool. Applies a `*** Begin Patch ... *** End Patch`
 * envelope describing add/update/delete/move operations across multiple
 * files, atomically (pre-flight verification + best-effort rollback).
 *
 * Mutating tool: the upstream evaluates `ctx.permissions.evaluateFsWrite`
 * for every target path BEFORE any disk write — denying any one path
 * aborts the whole patch with `PermissionDeniedError`. The wrapper just
 * forwards the policy.
 *
 * Same wrapping conventions as the other `agt_*` tools:
 *   - reads `workingDirectory` (REQUIRED) + `signal`;
 *   - throws on missing `workingDirectory`;
 *   - swallows upstream errors into `[agt_patch error] ...` strings.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { patchTool } from '../agent-tools-vendored/upstream/src/tools/patch/index.js';
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
export const AGT_PATCH_NAME = 'agt_patch' as const;

/**
 * Sourced from the canonical `BUILTIN_TOOL_PROMPTS` registry. Trimmed
 * from `patch.prompt.md` (~1.1 KiB upstream). The original full prompt
 * — which includes the worked example envelope — remains preserved
 * upstream at `agent-tools-vendored/upstream/src/tools/patch/patch.prompt.md`.
 */
export const AGT_PATCH_DESCRIPTION =
  BUILTIN_TOOL_PROMPTS[AGT_PATCH_NAME]!.description;

/** Dependency bag injected by U5. */
export interface AgtPatchDeps {
  permissions: PermissionPolicy;
  overlays?: OverlayRegistry;
}

export function buildAgtPatchTool(deps: AgtPatchDeps): DynamicStructuredTool {
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_PATCH_NAME]!;
  const reg = deps.overlays;
  const agtPatchSchema = z.object({
    patchText: z
      .string()
      .min(1)
      .describe(
        getParamDescription(reg, AGT_PATCH_NAME, 'patchText', BUILTIN.parameters['patchText']!),
      ),
  });
  return new DynamicStructuredTool({
    name: AGT_PATCH_NAME,
    description: getToolDescription(reg, AGT_PATCH_NAME, BUILTIN.description),
    schema: agtPatchSchema,
    func: async (input, _runManager, config) => {
      const cfg = (config?.configurable ?? {}) as Partial<AgentToolsConfigurable>;
      if (typeof cfg.workingDirectory !== 'string' || cfg.workingDirectory.length === 0) {
        throw new Error(
          `${AGT_PATCH_NAME}: configurable.workingDirectory is required`,
        );
      }
      const ctx: ToolContext = {
        cwd: cfg.workingDirectory,
        permissions: deps.permissions,
        ...(cfg.signal !== undefined ? { signal: cfg.signal } : {}),
      };
      try {
        const result = await patchTool.execute(input, ctx);
        if (result.ok) {
          return result.output;
        }
        return `[${AGT_PATCH_NAME} error] ${result.error.code}: ${result.error.message}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `[${AGT_PATCH_NAME} error] ${message}`;
      }
    },
  });
}
