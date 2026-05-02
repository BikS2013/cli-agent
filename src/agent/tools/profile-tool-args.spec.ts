/**
 * Tests for `mergeProfileToolArgs` — Unit U-ARGS of plan-005.
 *
 * Covers AC-11 (single arg merge), AC-12 (other args persist when one is
 * overridden), and the defensive identity paths (no configurable / no
 * profileToolArgs / unknown tool / empty preset record).
 */

import { describe, it, expect } from 'vitest';
import { mergeProfileToolArgs } from './profile-tool-args.js';

describe('mergeProfileToolArgs', () => {
  it('AC-11: applies a single preset arg when runtime input is empty', () => {
    const configurable = {
      profileToolArgs: {
        agt_grep: { pattern: '\\.ts$' },
      },
    };
    const merged = mergeProfileToolArgs<{ pattern?: string }>(
      {},
      configurable,
      'agt_grep',
    );
    expect(merged).toEqual({ pattern: '\\.ts$' });
  });

  it('AC-12: runtime override wins per-key while other preset args persist', () => {
    const configurable = {
      profileToolArgs: {
        agt_grep: { pattern: '\\.ts$', path: 'src' },
      },
    };
    const merged = mergeProfileToolArgs<{ pattern?: string; path?: string }>(
      { pattern: 'TODO' }, // runtime overrides pattern only
      configurable,
      'agt_grep',
    );
    expect(merged).toEqual({ pattern: 'TODO', path: 'src' });
  });

  it('returns the input unchanged when configurable is undefined', () => {
    const input = { foo: 1 };
    const merged = mergeProfileToolArgs(input, undefined, 'agt_grep');
    expect(merged).toEqual({ foo: 1 });
  });

  it('returns the input unchanged when configurable is null', () => {
    const input = { foo: 1 };
    // Helper tolerates null defensively.
    const merged = mergeProfileToolArgs(
      input,
      null as unknown as undefined,
      'agt_grep',
    );
    expect(merged).toEqual({ foo: 1 });
  });

  it('returns the input unchanged when profileToolArgs is missing', () => {
    const merged = mergeProfileToolArgs<{ foo: number }>(
      { foo: 1 },
      {},
      'agt_grep',
    );
    expect(merged).toEqual({ foo: 1 });
  });

  it('returns the input unchanged when the tool has no preset entry', () => {
    const configurable = {
      profileToolArgs: {
        bash_run: { timeout_ms: 30000 },
      },
    };
    const merged = mergeProfileToolArgs<{ pattern: string }>(
      { pattern: 'foo' },
      configurable,
      'agt_grep', // different tool — no preset
    );
    expect(merged).toEqual({ pattern: 'foo' });
  });

  it('returns the input unchanged when the preset record is empty', () => {
    const configurable = {
      profileToolArgs: {
        agt_grep: {},
      },
    };
    const merged = mergeProfileToolArgs<{ pattern: string }>(
      { pattern: 'foo' },
      configurable,
      'agt_grep',
    );
    expect(merged).toEqual({ pattern: 'foo' });
  });

  it('runtime input wins per-key (shallow merge semantics)', () => {
    const configurable = {
      profileToolArgs: {
        file_read: { path: '/a/preset.txt', max_bytes: 1024, binary: false },
      },
    };
    const merged = mergeProfileToolArgs<{
      path?: string;
      max_bytes?: number;
      binary?: boolean;
    }>(
      { path: '/runtime.txt', binary: true },
      configurable,
      'file_read',
    );
    expect(merged).toEqual({
      path: '/runtime.txt', // runtime
      max_bytes: 1024,      // preset
      binary: true,         // runtime
    });
  });

  it('treats null/undefined input as empty object', () => {
    const configurable = {
      profileToolArgs: { agt_grep: { pattern: 'x' } },
    };
    const merged = mergeProfileToolArgs(undefined, configurable, 'agt_grep');
    expect(merged).toEqual({ pattern: 'x' });

    const merged2 = mergeProfileToolArgs(
      null as unknown as undefined,
      configurable,
      'agt_grep',
    );
    expect(merged2).toEqual({ pattern: 'x' });
  });

  it('does not mutate the input object', () => {
    const input = { pattern: 'TODO' };
    const configurable = {
      profileToolArgs: { agt_grep: { path: 'src' } },
    };
    const merged = mergeProfileToolArgs(input, configurable, 'agt_grep');
    // Result is a NEW object when presets apply.
    expect(merged).not.toBe(input);
    expect(input).toEqual({ pattern: 'TODO' });
  });

  it('does not mutate the preset record', () => {
    const presets = { path: 'src' };
    const configurable = {
      profileToolArgs: { agt_grep: presets },
    };
    mergeProfileToolArgs({ pattern: 'TODO' }, configurable, 'agt_grep');
    expect(presets).toEqual({ path: 'src' });
  });

  it('returns the same input reference when no merge is needed (identity fast-path)', () => {
    const input = { foo: 1 };
    const configurable = { profileToolArgs: { other_tool: { x: 1 } } };
    const merged = mergeProfileToolArgs(input, configurable, 'agt_grep');
    expect(merged).toBe(input);
  });

  it('works for every registered tool name (per-tool integration smoke)', () => {
    const TOOL_NAMES = [
      'bash_run',
      'bash_list_allowed',
      'bash_which',
      'file_read',
      'file_list',
      'file_write',
      'file_edit',
      'file_append',
      'web_search',
      'web_fetch',
      'tool_help',
      'agt_glob',
      'agt_grep',
      'agt_multiedit',
      'agt_patch',
      'agt_todo_read',
      'agt_todo_write',
    ];
    for (const name of TOOL_NAMES) {
      const configurable = {
        profileToolArgs: { [name]: { _preset: 'value' } },
      };
      const merged = mergeProfileToolArgs<{ _preset?: string }>(
        {},
        configurable,
        name,
      );
      expect(merged._preset).toBe('value');
    }
  });
});
