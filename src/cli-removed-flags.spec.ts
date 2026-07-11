/**
 * Tests for the legacy-flag argv pre-scan (plan-015, AC-10).
 *
 * Every one of the 32 flags removed by plan-015 must throw UsageError
 * (exit 2) with a migration hint; a clean argv (including the replacement
 * surface) must pass through untouched.
 */

import { describe, it, expect } from 'vitest';
import { rejectRemovedLegacyFlags } from './cli-removed-flags.js';

const REMOVED_GROUP_FLAGS = [
  '--composites',
  '--no-composites',
  '--builtin-tools',
  '--no-builtin-tools',
  '--agent-tools',
  '--no-agent-tools',
];

const REMOVED_PER_TOOL_FLAGS = [
  'glob',
  'grep',
  'multiedit',
  'patch',
  'todo-read',
  'todo-write',
  'web-search',
  'web-fetch',
  'file-read',
  'file-list',
  'file-write',
  'file-edit',
  'file-append',
].flatMap((s) => [`--enable-agt-${s}`, `--disable-agt-${s}`]);

describe('rejectRemovedLegacyFlags', () => {
  it('covers all 32 removed flags', () => {
    expect(REMOVED_GROUP_FLAGS.length + REMOVED_PER_TOOL_FLAGS.length).toBe(32);
  });

  it.each(REMOVED_GROUP_FLAGS)('%s throws UsageError with a --mode hint', (flag) => {
    try {
      rejectRemovedLegacyFlags(['x', flag, 'y']);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_USAGE');
      expect((e as { exitCode?: number }).exitCode).toBe(2);
      const msg = (e as Error).message;
      expect(msg).toContain(flag);
      expect(msg).toMatch(/removed \(plan-015\)/);
      expect(msg).toContain('--mode');
    }
  });

  it.each(REMOVED_PER_TOOL_FLAGS)('%s throws UsageError with an --enable-tool hint', (flag) => {
    try {
      rejectRemovedLegacyFlags([flag]);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_USAGE');
      expect((e as { exitCode?: number }).exitCode).toBe(2);
      const msg = (e as Error).message;
      expect(msg).toContain(flag);
      expect(msg).toMatch(/removed \(plan-015\)/);
      expect(msg).toContain('--enable-tool');
    }
  });

  it('a clean argv with the replacement surface does not throw', () => {
    expect(() =>
      rejectRemovedLegacyFlags([
        '--mode', 'tool',
        '--enable-tool', 'agt_glob',
        '--disable-tool', 'agt_web_fetch',
        '--tool', 'git',
        '--allow-mutations',
        'summarize the repo',
      ]),
    ).not.toThrow();
  });

  it('an empty argv does not throw', () => {
    expect(() => rejectRemovedLegacyFlags([])).not.toThrow();
  });
});
