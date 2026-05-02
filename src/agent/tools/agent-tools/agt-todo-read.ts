/**
 * `agt_todo_read` — LangChain `DynamicStructuredTool` wrapper around the
 * vendored upstream `todoread` tool. Reads the in-process todo list for the
 * current logical session.
 *
 * Session sourcing: the upstream `todoread` reads `ctx.session.todos`. For
 * the cli-agent integration, the per-session `SessionStore` lives on the
 * `RunnableConfig.configurable.agentToolsSession` field — populated by U5's
 * catalog builder and threaded through every `graph.invoke` /
 * `streamEvents` call (see plan-003 §Phase 3).
 *
 * Contract:
 *   - `workingDirectory` is REQUIRED (consistency with all other agt_*
 *     wrappers — even though `todoread` does not need it, the upstream
 *     `ToolContext.cwd` field is non-optional);
 *   - `agentToolsSession` is REQUIRED — its absence is a contract violation
 *     because the catalog builder must always inject it whenever this tool
 *     is enabled. THROWS with a clear message in that case.
 *   - Upstream errors are caught and rendered as
 *     `[agt_todo_read error] ...` strings.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { todoreadTool } from '../agent-tools-vendored/upstream/src/tools/todoread/index.js';
import type {
  PermissionPolicy,
  SessionStore,
  ToolContext,
} from '../agent-tools-vendored/upstream/src/types.js';
import type { AgentToolsConfigurable, AgentToolsSession } from './types.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import {
  getToolDescription,
  type OverlayRegistry,
} from '../tool-prompt-overlay.js';
import { mergeProfileToolArgs, type ProfileToolArgsConfigurable } from '../profile-tool-args.js';

/** LangChain-visible tool name. */
export const AGT_TODO_READ_NAME = 'agt_todo_read' as const;

/**
 * Sourced from the canonical `BUILTIN_TOOL_PROMPTS` registry. Trimmed
 * from `todoread.prompt.md` (~1.2 KiB upstream). The original full
 * prompt remains preserved upstream.
 */
export const AGT_TODO_READ_DESCRIPTION =
  BUILTIN_TOOL_PROMPTS[AGT_TODO_READ_NAME]!.description;

/** Empty input schema — matches upstream. */
const agtTodoReadSchema = z.object({});

/** Dependency bag injected by U5. */
export interface AgtTodoReadDeps {
  permissions: PermissionPolicy;
  overlays?: OverlayRegistry;
}

/**
 * Coerce the cli-agent `AgentToolsSession` shape into the upstream's
 * `SessionStore`. Keys align (`todos: ReadonlyArray<TodoItem> | null`); we
 * widen the wrapper-side `null` initial state without copying the array.
 */
function toUpstreamSession(session: AgentToolsSession): SessionStore {
  return {
    todos: session.todos,
  };
}

export function buildAgtTodoReadTool(
  deps: AgtTodoReadDeps,
): DynamicStructuredTool {
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_TODO_READ_NAME]!;
  const reg = deps.overlays;
  return new DynamicStructuredTool({
    name: AGT_TODO_READ_NAME,
    description: getToolDescription(reg, AGT_TODO_READ_NAME, BUILTIN.description),
    schema: agtTodoReadSchema,
    func: async (rawInput, _runManager, config) => {
      const input = mergeProfileToolArgs(
        rawInput,
        config?.configurable as ProfileToolArgsConfigurable | undefined,
        AGT_TODO_READ_NAME,
      );
      const cfg = (config?.configurable ?? {}) as Partial<AgentToolsConfigurable>;
      if (typeof cfg.workingDirectory !== 'string' || cfg.workingDirectory.length === 0) {
        throw new Error(
          `${AGT_TODO_READ_NAME}: configurable.workingDirectory is required`,
        );
      }
      if (cfg.agentToolsSession === undefined || cfg.agentToolsSession === null) {
        throw new Error(
          `${AGT_TODO_READ_NAME}: configurable.agentToolsSession is required ` +
            '(U5 catalog must inject it whenever this tool is enabled)',
        );
      }
      const ctx: ToolContext = {
        cwd: cfg.workingDirectory,
        permissions: deps.permissions,
        session: toUpstreamSession(cfg.agentToolsSession),
        ...(cfg.signal !== undefined ? { signal: cfg.signal } : {}),
      };
      try {
        const result = await todoreadTool.execute(input, ctx);
        if (result.ok) {
          return result.output;
        }
        return `[${AGT_TODO_READ_NAME} error] ${result.error.code}: ${result.error.message}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `[${AGT_TODO_READ_NAME} error] ${message}`;
      }
    },
  });
}
