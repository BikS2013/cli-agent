/**
 * `todowrite` — replace the in-process todo list for the current session.
 *
 * Full-list-replace semantics: the supplied `todos` array becomes the new
 * `ctx.session.todos`; the previous list is discarded entirely. This
 * matches upstream behaviour — the agent always rewrites the full list.
 *
 * The tool is "mutating" because it changes session state, but it never
 * touches the filesystem or network, so no permission gate is consulted.
 * The consumer owns the {@link SessionStore} instance handed in via
 * `ctx.session`; if absent, the tool lazily attaches a fresh store onto
 * the context object so subsequent `todoread` / `todowrite` calls share
 * it.
 */

import { z } from 'zod';
import type { AgentTool, SessionStore, TodoItem, ToolContext } from '../../types.js';
import { InputValidationError } from '../../errors.js';
import { registerPrompt } from '../../prompts/registry.js';
import { loadPromptFile } from '../../prompts/loader.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_ID = 'todowrite' as const;
const TOOL_DESCRIPTION =
  'Replace the in-process todo list for the current session. Full-list-replace semantics; previous list is discarded.';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const todoItemSchema = z.object({
  id: z.string().min(1, 'id is required'),
  content: z.string().min(1, 'content is required'),
  status: z.enum(['pending', 'in_progress', 'completed']),
  priority: z.enum(['high', 'medium', 'low']).optional(),
});

const todowriteParameters = z.object({
  todos: z
    .array(todoItemSchema)
    .describe(
      'The complete updated todo list. Replaces any previously stored list in full.',
    ),
});

export type TodowriteInput = z.infer<typeof todowriteParameters>;

export interface TodowriteOutput {
  readonly todos: ReadonlyArray<TodoItem>;
}

// ---------------------------------------------------------------------------
// Prompt registration (synchronous, at module init)
// ---------------------------------------------------------------------------

const promptText = loadPromptFile(import.meta.url, 'todowrite.prompt.md');
registerPrompt(TOOL_ID, TOOL_DESCRIPTION, promptText);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render the todo list for the LLM-visible `output` string.
 *
 * The format mirrors upstream: a leading confirmation line followed by a
 * pretty-printed JSON dump. Empty list still produces `"[]"` so callers
 * can rely on `JSON.parse` round-tripping.
 */
function renderOutput(todos: ReadonlyArray<TodoItem>): string {
  const count = todos.length;
  const remaining = todos.filter((t) => t.status !== 'completed').length;
  const headline =
    count === 0
      ? 'Todo list cleared.'
      : `Todo list updated (${count} item${count === 1 ? '' : 's'}, ${remaining} remaining).`;
  return `${headline}\n${JSON.stringify(todos, null, 2)}`;
}

/**
 * Resolve (or lazily attach) the session store on `ctx`.
 *
 * Mutates the context object — the documented contract is that the
 * caller owns `ctx.session`, and that subsequent `todoread`/`todowrite`
 * calls in the same logical session share the same `ToolContext`.
 */
function ensureSession(ctx: ToolContext): SessionStore {
  if (ctx.session !== undefined) return ctx.session;
  const fresh: SessionStore = { todos: null, _internal: {} };
  // Mutate by assignment — the caller knows the contract (see `SessionStore` doc).
  (ctx as { session?: SessionStore }).session = fresh;
  return fresh;
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export const todowriteTool: AgentTool<typeof todowriteParameters, TodowriteOutput> = {
  id: TOOL_ID,
  description: TOOL_DESCRIPTION,
  category: 'todo',
  mutating: true,
  parameters: todowriteParameters,
  prompt: promptText,

  async execute(input, ctx) {
    // Validate via Zod safeParse so we never throw on bad input.
    const parsed = todowriteParameters.safeParse(input);
    if (!parsed.success) {
      const err = new InputValidationError(
        'todowrite: invalid input',
        parsed.error,
      );
      return { ok: false, error: err };
    }

    const session = ensureSession(ctx);
    // Freeze each item so consumers cannot mutate via the returned data.
    const newTodos: ReadonlyArray<TodoItem> = parsed.data.todos.map((t) => {
      const item: TodoItem = {
        id: t.id,
        content: t.content,
        status: t.status,
        ...(t.priority !== undefined ? { priority: t.priority } : {}),
      };
      return Object.freeze(item);
    });
    const frozenList = Object.freeze(newTodos);

    // Replace the list entirely — full-list-replace semantics.
    session.todos = frozenList;

    return {
      ok: true,
      output: renderOutput(frozenList),
      data: { todos: frozenList },
    };
  },
};
