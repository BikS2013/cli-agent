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

/** LangChain-visible tool name. Stable across U3 / U5 / checkpointer. */
export const AGT_GLOB_NAME = 'agt_glob' as const;

/**
 * Description handed both to LangChain (`DynamicStructuredTool.description`)
 * and to U5's prompt-block assembler. Trimmed from the upstream
 * `glob.prompt.md` (~545 chars) to keep the prompt-block under the per-tool
 * budget — the original full prompt remains preserved upstream at
 * `agent-tools-vendored/upstream/src/tools/glob/glob.prompt.md`.
 */
export const AGT_GLOB_DESCRIPTION =
  'Fast file-pattern matching across the working directory. ' +
  'Supports glob patterns like "**/*.ts" or "src/**/*.{ts,tsx}". ' +
  'Returns matching file paths sorted by modification time (newest first). ' +
  'Use this when you need to find files by name patterns; prefer running ' +
  'multiple searches in parallel when the queries are independent.';

/** Schema mirrors the upstream `inputSchema` for `glob`. */
const agtGlobSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('The glob pattern to match files against (e.g. "**/*.ts").'),
  path: z
    .string()
    .optional()
    .describe(
      'Optional directory to search in. Defaults to the working directory; ' +
        'resolved relative to it when not absolute.',
    ),
});

/** Dependency bag injected by U5's catalog builder. */
export interface AgtGlobDeps {
  permissions: PermissionPolicy;
}

/** Build the LangChain tool. */
export function buildAgtGlobTool(deps: AgtGlobDeps): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: AGT_GLOB_NAME,
    description: AGT_GLOB_DESCRIPTION,
    schema: agtGlobSchema,
    func: async (input, _runManager, config) => {
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
