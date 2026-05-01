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

/** LangChain-visible tool name. */
export const AGT_GREP_NAME = 'agt_grep' as const;

/**
 * Trimmed from the upstream `grep.prompt.md` (~689 chars). The original
 * full prompt remains preserved upstream.
 */
export const AGT_GREP_DESCRIPTION =
  'Fast regex content search across the working directory. ' +
  'Supports full regex syntax (e.g. "log.*Error", "function\\\\s+\\\\w+"). ' +
  'Filter files by glob with the `include` parameter (e.g. "*.ts", "*.{ts,tsx}"). ' +
  'Returns matching files (or lines, depending on `outputMode`) sorted by mtime ' +
  'descending. Capped at 100 matches. Use when you need to find files containing ' +
  'specific patterns; prefer this over a manual `bash rg` invocation.';

/** Schema mirrors the upstream `grepInputSchema`. */
const agtGrepSchema = z.object({
  pattern: z
    .string()
    .min(1)
    .describe('Regular expression to search for inside file contents.'),
  path: z
    .string()
    .optional()
    .describe(
      'Optional file or directory to search. Defaults to the working ' +
        'directory; resolved relative to it when not absolute.',
    ),
  include: z
    .string()
    .optional()
    .describe(
      'Optional include glob restricting which files are searched ' +
        '(e.g. "*.ts", "*.{ts,tsx}").',
    ),
  outputMode: z
    .enum(['content', 'files_with_matches', 'count'])
    .optional()
    .describe(
      'Result shape: "files_with_matches" (default) lists paths only, ' +
        '"count" reports per-file match counts, "content" emits ' +
        'path:line:matched-text per match.',
    ),
});

/** Dependency bag injected by U5. */
export interface AgtGrepDeps {
  permissions: PermissionPolicy;
}

export function buildAgtGrepTool(deps: AgtGrepDeps): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: AGT_GREP_NAME,
    description: AGT_GREP_DESCRIPTION,
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
