/**
 * `agt_glob` — LangChain `DynamicStructuredTool` wrapper around the vendored
 * upstream `glob` tool (file-pattern search by mtime, ripgrep-backed with a JS
 * fallback).
 *
 * Per the U3 contract:
 *   - The wrapper reads `workingDirectory` and the optional `signal` /
 *     `agentToolsSession` keys out of LangChain's `RunnableConfig.configurable`.
 *   - Missing `workingDirectory` is a contract violation and is THROWN
 *     (no fallback). U5's catalog builder is responsible for always
 *     injecting it.
 *   - Any error coming out of the upstream `.execute()` is captured and
 *     surfaced as a `[agt_glob error] ...` string so the LangChain agent
 *     loop never crashes (LangChain adapter contract).
 *
 * `glob` is read-only — no permission gate is consulted by the upstream
 * implementation, but we still forward the policy so consumers running with
 * a strict policy retain a single source of truth.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { globTool } from '../agent-tools-vendored/upstream/src/tools/glob/index.js';
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

/** LangChain-visible tool name. Stable across U3 / U5 / checkpointer. */
export const AGT_GLOB_NAME = 'agt_glob' as const;

/**
 * Description handed both to LangChain (`DynamicStructuredTool.description`)
 * and to U5's prompt-block assembler. Sourced from the canonical
 * `BUILTIN_TOOL_PROMPTS` registry so there is a SINGLE literal per tool.
 * Trimmed from the upstream `glob.prompt.md` (~545 chars) to keep the
 * prompt-block under the per-tool budget — the original full prompt
 * remains preserved upstream at
 * `agent-tools-vendored/upstream/src/tools/glob/glob.prompt.md`.
 */
export const AGT_GLOB_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_GLOB_NAME]!.description;

/** Dependency bag injected by U5's catalog builder. */
export interface AgtGlobDeps {
  permissions: PermissionPolicy;
  /** Optional overlay registry; when present, user-edited descriptions
   * take precedence over the canonical built-in. */
  overlays?: OverlayRegistry;
}

/** Build the LangChain tool. */
export function buildAgtGlobTool(deps: AgtGlobDeps): DynamicStructuredTool {
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_GLOB_NAME]!;
  const reg = deps.overlays;
  const agtGlobSchema = z.object({
    pattern: z
      .string()
      .min(1)
      .describe(
        getParamDescription(reg, AGT_GLOB_NAME, 'pattern', BUILTIN.parameters['pattern']!),
      ),
    path: z
      .string()
      .optional()
      .describe(
        getParamDescription(reg, AGT_GLOB_NAME, 'path', BUILTIN.parameters['path']!),
      ),
  });
  return new DynamicStructuredTool({
    name: AGT_GLOB_NAME,
    description: getToolDescription(reg, AGT_GLOB_NAME, BUILTIN.description),
    schema: agtGlobSchema,
    func: async (rawInput, _runManager, config) => {
      const input = mergeProfileToolArgs(
        rawInput,
        config?.configurable as ProfileToolArgsConfigurable | undefined,
        AGT_GLOB_NAME,
      );
      const cfg = (config?.configurable ?? {}) as Partial<AgentToolsConfigurable>;
      if (typeof cfg.workingDirectory !== 'string' || cfg.workingDirectory.length === 0) {
        throw new Error(
          `${AGT_GLOB_NAME}: configurable.workingDirectory is required`,
        );
      }
      const ctx: ToolContext = {
        cwd: cfg.workingDirectory,
        permissions: deps.permissions,
        ...(cfg.signal !== undefined ? { signal: cfg.signal } : {}),
      };
      try {
        const result = await globTool.execute(input, ctx);
        if (result.ok) {
          return result.output;
        }
        return `[${AGT_GLOB_NAME} error] ${result.error.code}: ${result.error.message}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `[${AGT_GLOB_NAME} error] ${message}`;
      }
    },
  });
}
