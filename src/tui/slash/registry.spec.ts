/**
 * Slash registry + dispatch tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { registerCommand, findCommand, parseSlashLine, dispatchSlash, _testReset, type SlashCommand, type SlashContext } from './registry.js';

beforeEach(() => {
  _testReset();
});

describe('parseSlashLine', () => {
  it('splits whitespace and preserves quoted segments', () => {
    expect(parseSlashLine('/model "gpt 4o"')).toEqual({ name: '/model', args: ['gpt 4o'] });
    expect(parseSlashLine('/help')).toEqual({ name: '/help', args: [] });
  });
});

describe('findCommand', () => {
  it('matches by name and by alias', () => {
    const cmd: SlashCommand = { name: '/quit', aliases: ['/exit'], summary: 's', async run() {} };
    registerCommand(cmd);
    expect(findCommand('/quit')).toBe(cmd);
    expect(findCommand('/exit')).toBe(cmd);
    expect(findCommand('/Quit')).toBeUndefined(); // case-sensitive
  });
});

describe('dispatchSlash', () => {
  it('invokes the matched command with parsed args', async () => {
    let invokedWith: string[] | null = null;
    const cmd: SlashCommand = { name: '/test', summary: 's', async run(_ctx, args) { invokedWith = args; } };
    registerCommand(cmd);
    const ctx: SlashContext = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller: {} as any,
      printSystem: () => {},
      println: () => {},
    };
    const handled = await dispatchSlash('/test foo "bar baz"', ctx);
    expect(handled).toBe(true);
    expect(invokedWith).toEqual(['foo', 'bar baz']);
  });

  it('reports unknown commands without throwing', async () => {
    const messages: string[] = [];
    const ctx: SlashContext = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller: {} as any,
      printSystem: (s) => messages.push(s),
      println: () => {},
    };
    const handled = await dispatchSlash('/nosuch', ctx);
    expect(handled).toBe(true);
    expect(messages.join('')).toContain('unknown command');
  });
});
