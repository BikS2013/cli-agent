/**
 * `agt_todo_write` — LangChain `DynamicStructuredTool` wrapper around the
 * vendored upstream `todowrite` tool. Replaces the in-process todo list for
 * the current logical session (full-list-replace semantics; previous list
 * is discarded entirely).
 *
 * Session sourcing & persistence: the upstream mutates `ctx.session.todos`
 * in place. Because the wrapper passes a NEW `SessionStore` literal to the
 * upstream on every call, we have to copy the resulting `todos` back onto
 * the caller-owned `AgentToolsSession` (`cfg.agentToolsSession`) so that
 * subsequent `agt_todo_read` calls (and re-entries into `agt_todo_write`)
 * see the mutation. This mirrors the design: the cli-agent `AgentToolsSession`
 * is the canonical store; the upstream `SessionStore` is a transient adapter.
 *
 * Contract:
 *   - `workingDirectory` is REQUIRED (consistency with all other agt_*
 *     wrappers; upstream `ToolContext.cwd` is non-optional);
 *   - `agentToolsSession` is REQUIRED — its absence is a contract
 *     violation. THROWS with a clear message in that case.
 *   - Upstream errors are caught and rendered as
 *     `[agt_todo_write error] ...` strings.
 */

import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';

import { todowriteTool } from '../agent-tools-vendored/upstream/src/tools/todowrite/index.js';
import type {
  PermissionPolicy,
  SessionStore,
  ToolContext,
} from '../agent-tools-vendored/upstream/src/types.js';
import type { AgentToolsConfigurable, AgentToolsSession, TodoItem } from './types.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import {
  getToolDescription,
  getParamDescription,
  type OverlayRegistry,
} from '../tool-prompt-overlay.js';
import { mergeProfileToolArgs, type ProfileToolArgsConfigurable } from '../profile-tool-args.js';

/** LangChain-visible tool name. */
export const AGT_TODO_WRITE_NAME = 'agt_todo_write' as const;

/**
 * Sourced from the canonical `BUILTIN_TOOL_PROMPTS` registry. Trimmed
 * from `todowrite.prompt.md` (~8.8 KiB upstream — the upstream embeds
 * extensive examples). The full prompt remains preserved upstream. The
 * shorter description preserves the upstream voice and the critical
 * "full-list-replace" + "one in_progress at a time" rules.
 */
export const AGT_TODO_WRITE_DESCRIPTION =
  BUILTIN_TOOL_PROMPTS[AGT_TODO_WRITE_NAME]!.description;

const todoItemSchema = z.object({
  id: z
    .string()
    .min(1)
    .describe('Stable identifier for the todo (e.g. "1", "task-3").'),
  content: z
    .string()
    .min(1)
    .describe('Human-readable description of what the item tracks.'),
  status: z
    .enum(['pending', 'in_progress', 'completed'])
    .describe(
      'Lifecycle state. Keep at most one item `in_progress` at any time.',
    ),
  priority: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe('Optional relative priority hint.'),
});

/** Dependency bag injected by U5. */
export interface AgtTodoWriteDeps {
  permissions: PermissionPolicy;
  overlays?: OverlayRegistry;
}

/** Build a transient upstream `SessionStore` from the wrapper-owned store. */
function toUpstreamSession(session: AgentToolsSession): SessionStore {
  return {
    todos: session.todos,
  };
}

/**
 * Copy the upstream-mutated `todos` back onto the caller-owned
 * `AgentToolsSession`, normalising the `ReadonlyArray<TodoItem>` upstream
 * shape to the mutable `TodoItem[]` the cli-agent type uses.
 */
function syncSessionFromUpstream(
  cliAgentSession: AgentToolsSession,
  upstream: SessionStore,
): void {
  const next = upstream.todos;
  cliAgentSession.todos = next === null ? null : ([...next] as TodoItem[]);
}

export function buildAgtTodoWriteTool(
  deps: AgtTodoWriteDeps,
): DynamicStructuredTool {
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_TODO_WRITE_NAME]!;
  const reg = deps.overlays;
  // Override the top-level `todos` describe via overlay; nested item
  // schema stays as the upstream-defined describe.
  const agtTodoWriteSchemaWithOverlay = z.object({
    todos: z
      .array(todoItemSchema)
      .describe(
        getParamDescription(reg, AGT_TODO_WRITE_NAME, 'todos', BUILTIN.parameters['todos']!),
      ),
  });
  return new DynamicStructuredTool({
    name: AGT_TODO_WRITE_NAME,
    description: getToolDescription(reg, AGT_TODO_WRITE_NAME, BUILTIN.description),
    schema: agtTodoWriteSchemaWithOverlay,
    func: async (rawInput, _runManager, config) => {
      const input = mergeProfileToolArgs(
        rawInput,
        config?.configurable as ProfileToolArgsConfigurable | undefined,
        AGT_TODO_WRITE_NAME,
      );
      const cfg = (config?.configurable ?? {}) as Partial<AgentToolsConfigurable>;
      if (typeof cfg.workingDirectory !== 'string' || cfg.workingDirectory.length === 0) {
        throw new Error(
          `${AGT_TODO_WRITE_NAME}: configurable.workingDirectory is required`,
        );
      }
      if (cfg.agentToolsSession === undefined || cfg.agentToolsSession === null) {
        throw new Error(
          `${AGT_TODO_WRITE_NAME}: configurable.agentToolsSession is required ` +
            '(U5 catalog must inject it whenever this tool is enabled)',
        );
      }
      const upstreamSession = toUpstreamSession(cfg.agentToolsSession);
      const ctx: ToolContext = {
        cwd: cfg.workingDirectory,
        permissions: deps.permissions,
        session: upstreamSession,
        ...(cfg.signal !== undefined ? { signal: cfg.signal } : {}),
      };
      try {
        const result = await todowriteTool.execute(input, ctx);
        // Sync regardless of ok/!ok: the upstream is conservative and
        // only mutates session on success, but this keeps the canonical
        // store aligned with whatever the upstream concluded.
        syncSessionFromUpstream(cfg.agentToolsSession, upstreamSession);
        if (result.ok) {
          return result.output;
        }
        return `[${AGT_TODO_WRITE_NAME} error] ${result.error.code}: ${result.error.message}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `[${AGT_TODO_WRITE_NAME} error] ${message}`;
      }
    },
  });
}
