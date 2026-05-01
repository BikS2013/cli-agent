/**
 * Unit tests for the `agt_todo_read` LangChain wrapper.
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';

import {
  AGT_TODO_READ_NAME,
  AGT_TODO_READ_DESCRIPTION,
  buildAgtTodoReadTool,
} from './agt-todo-read.js';
import type { AgentToolsSession } from './types.js';
import type { PermissionPolicy } from '../agent-tools-vendored/upstream/src/types.js';

const stubPolicy: PermissionPolicy = {
  id: 'test',
  evaluateBash: () => ({ allow: true }),
  evaluateFsWrite: () => ({ allow: true }),
};

describe('agt_todo_read — wrapper metadata', () => {
  const tool = buildAgtTodoReadTool({ permissions: stubPolicy });

  it('exposes the stable tool name', () => {
    expect(tool.name).toBe(AGT_TODO_READ_NAME);
    expect(tool.name).toBe('agt_todo_read');
  });

  it('embeds a non-empty description matching the exported constant', () => {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toBe(AGT_TODO_READ_DESCRIPTION);
    expect(tool.description.toLowerCase()).toContain('todo');
  });
});

describe('agt_todo_read — execute()', () => {
  it('returns "(no todos)" for a fresh session', async () => {
    const tool = buildAgtTodoReadTool({ permissions: stubPolicy });
    const session: AgentToolsSession = { todos: null };
    const result = await tool.invoke(
      {},
      {
        configurable: {
          workingDirectory: os.tmpdir(),
          agentToolsSession: session,
        },
      },
    );
    expect(typeof result).toBe('string');
    expect(result).toBe('(no todos)');
  });

  it('returns the formatted list when the session already has todos', async () => {
    const tool = buildAgtTodoReadTool({ permissions: stubPolicy });
    const session: AgentToolsSession = {
      todos: [
        { id: '1', content: 'first', status: 'pending' },
        { id: '2', content: 'second', status: 'in_progress', priority: 'high' },
      ],
    };
    const result = await tool.invoke(
      {},
      {
        configurable: {
          workingDirectory: os.tmpdir(),
          agentToolsSession: session,
        },
      },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('1. first');
    expect(result).toContain('2. second');
    expect(result).toContain('priority: high');
  });

  it('throws when configurable.workingDirectory is missing', async () => {
    const tool = buildAgtTodoReadTool({ permissions: stubPolicy });
    await expect(
      tool.invoke(
        {},
        { configurable: { agentToolsSession: { todos: null } } },
      ),
    ).rejects.toThrow(/workingDirectory is required/);
  });

  it('throws when configurable.agentToolsSession is missing', async () => {
    const tool = buildAgtTodoReadTool({ permissions: stubPolicy });
    await expect(
      tool.invoke({}, { configurable: { workingDirectory: os.tmpdir() } }),
    ).rejects.toThrow(/agentToolsSession is required/);
  });
});
