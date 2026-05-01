/**
 * `todoread` — return the agent's in-process todo list for the current
 * session.
 *
 * Synthesised tool: opencode merges read+write into a single tool;
 * we split for ergonomics. No upstream source file. The companion
 * mutating tool is `todowrite`.
 *
 * Reads `ctx.session.todos`. If the caller did not pass a session, or
 * if `todowrite` has not yet populated the list (`todos === null`), the
 * tool returns the string `(no todos)` and a structured `data.todos: []`.
 *
 * No permission gate (read-only over in-memory state). Errors are
 * returned in `ToolResult`, never thrown.
 */

import { z } from 'zod';
import type { AgentTool, ToolContext, ToolResult, TodoItem } from '../../types.js';
import { ToolExecutionError } from '../../errors.js';
import { loadPromptFile } from '../../prompts/loader.js';
import { registerPrompt } from '../../prompts/registry.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/**
 * `todoread` takes no inputs. The schema is intentionally an empty
 * object so the LLM-visible JSON Schema is `{ "type": "object" }`.
 */
const inputSchema = z.object({});

type TodoreadInput = z.infer<typeof inputSchema>;

/** Structured payload returned to direct callers. */
export interface TodoreadOutput {
  readonly todos: ReadonlyArray<TodoItem>;
}

// ---------------------------------------------------------------------------
// Module init: prompt + registry
// ---------------------------------------------------------------------------

const DESCRIPTION =
  "Read the in-process todo list for the current session. Returns the list as a human-readable checklist; empty when no todos have been written.";

const PROMPT_FRAGMENT: string = loadPromptFile(import.meta.url, 'todoread.prompt.md');

registerPrompt('todoread', DESCRIPTION, PROMPT_FRAGMENT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Render the status as a checkbox glyph. */
function statusGlyph(status: TodoItem['status']): string {
  switch (status) {
    case 'completed':
      return '[x]';
    case 'in_progress':
      return '[~]';
    case 'pending':
      return '[ ]';
    default:
      // Defensive: an unknown status should still render readably.
      return '[?]';
  }
}

/** Render a single todo as one line of human-readable output. */
function formatTodo(todo: TodoItem): string {
  const glyph = statusGlyph(todo.status);
  const head = `${glyph} ${todo.id}. ${todo.content}`;
  return todo.priority !== undefined
    ? `${head} (priority: ${todo.priority})`
    : head;
}

/** Render an entire list, one todo per line. */
function formatTodos(todos: ReadonlyArray<TodoItem>): string {
  return todos.map(formatTodo).join('\n');
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

async function executeTodoread(
  _input: TodoreadInput,
  ctx: ToolContext,
): Promise<ToolResult<TodoreadOutput>> {
  try {
    const session = ctx.session;
    const todos =
      session === undefined || session.todos === null ? null : session.todos;

    if (todos === null || todos.length === 0) {
      return {
        ok: true,
        output: '(no todos)',
        data: { todos: [] },
      };
    }

    return {
      ok: true,
      output: formatTodos(todos),
      data: { todos },
    };
  } catch (err) {
    // Defensive: read paths are pure but we never want to throw out of
    // a tool. Wrap any unexpected error in the standard envelope.
    const wrapped =
      err instanceof ToolExecutionError
        ? err
        : new ToolExecutionError(
            err instanceof Error ? err.message : 'todoread failed',
            { cause: err },
          );
    return { ok: false, error: wrapped };
  }
}

/**
 * The exported `todoread` tool. Read-only; never mutates session state.
 */
export const todoreadTool: AgentTool<typeof inputSchema, TodoreadOutput> = {
  id: 'todoread',
  description: DESCRIPTION,
  category: 'todo',
  mutating: false,
  parameters: inputSchema,
  prompt: PROMPT_FRAGMENT,
  execute: executeTodoread,
};
