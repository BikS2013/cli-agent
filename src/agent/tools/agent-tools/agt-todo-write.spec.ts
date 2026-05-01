/**
 * Unit tests for the `agt_todo_write` LangChain wrapper.
 *
 * Coverage extras:
 *   - round-trip: write then read shares the same `agentToolsSession`.
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';

import {
  AGT_TODO_WRITE_NAME,
  AGT_TODO_WRITE_DESCRIPTION,
  buildAgtTodoWriteTool,
} from './agt-todo-write.js';
import { buildAgtTodoReadTool } from './agt-todo-read.js';
import type { AgentToolsSession } from './types.js';
import type { PermissionPolicy } from '../agent-tools-vendored/upstream/src/types.js';

const stubPolicy: PermissionPolicy = {
  id: 'test',
  evaluateBash: () => ({ allow: true }),
  evaluateFsWrite: () => ({ allow: true }),
};

describe('agt_todo_write — wrapper metadata', () => {
  const tool = buildAgtTodoWriteTool({ permissions: stubPolicy });

  it('exposes the stable tool name', () => {
    expect(tool.name).toBe(AGT_TODO_WRITE_NAME);
    expect(tool.name).toBe('agt_todo_write');
  });

  it('embeds a non-empty description matching the exported constant', () => {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toBe(AGT_TODO_WRITE_DESCRIPTION);
    expect(tool.description.toLowerCase()).toContain('todo');
  });
});

describe('agt_todo_write — execute()', () => {
  it('returns a string for a valid invocation (happy path) and persists todos', async () => {
    const tool = buildAgtTodoWriteTool({ permissions: stubPolicy });
    const session: AgentToolsSession = { todos: null };
    const result = await tool.invoke(
      {
        todos: [
          { id: '1', content: 'first', status: 'pending' },
          { id: '2', content: 'second', status: 'in_progress', priority: 'high' },
        ],
      },
      {
        configurable: {
          workingDirectory: os.tmpdir(),
          agentToolsSession: session,
        },
      },
    );
    expect(typeof result).toBe('string');
    expect(result).toMatch(/Todo list updated/);
    expect(session.todos).not.toBeNull();
    expect(session.todos).toHaveLength(2);
  });

  it('round-trips with agt_todo_read on the same session', async () => {
    const writeTool = buildAgtTodoWriteTool({ permissions: stubPolicy });
    const readTool = buildAgtTodoReadTool({ permissions: stubPolicy });
    const session: AgentToolsSession = { todos: null };
    const configurable = {
      workingDirectory: os.tmpdir(),
      agentToolsSession: session,
    };

    await writeTool.invoke(
      {
        todos: [{ id: '42', content: 'round-trip', status: 'pending' }],
      },
      { configurable },
    );

    const readBack = await readTool.invoke({}, { configurable });
    expect(typeof readBack).toBe('string');
    expect(readBack).toContain('42. round-trip');
  });

  it('throws when configurable.workingDirectory is missing', async () => {
    const tool = buildAgtTodoWriteTool({ permissions: stubPolicy });
    await expect(
      tool.invoke(
        { todos: [] },
        { configurable: { agentToolsSession: { todos: null } } },
      ),
    ).rejects.toThrow(/workingDirectory is required/);
  });

  it('throws when configurable.agentToolsSession is missing', async () => {
    const tool = buildAgtTodoWriteTool({ permissions: stubPolicy });
    await expect(
      tool.invoke(
        { todos: [] },
        { configurable: { workingDirectory: os.tmpdir() } },
      ),
    ).rejects.toThrow(/agentToolsSession is required/);
  });
});
