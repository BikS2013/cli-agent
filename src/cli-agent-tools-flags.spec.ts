/**
 * Tests for the generic --enable-tool/--disable-tool mapper (plan-015).
 *
 * mapAgentToolFlags lives in its own module (`src/cli-agent-tools-flags.ts`)
 * — separate from cli.ts — so these tests can import it WITHOUT triggering
 * cli.ts's module-level Commander parse side-effect.
 */

import { describe, it, expect } from 'vitest';
import { mapAgentToolFlags, AGT_TOOL_NAME_TO_KEY } from './cli-agent-tools-flags.js';
import {
  AGT_GLOB_NAME,
  AGT_GREP_NAME,
  AGT_MULTIEDIT_NAME,
  AGT_PATCH_NAME,
  AGT_TODO_READ_NAME,
  AGT_TODO_WRITE_NAME,
  AGT_WEB_SEARCH_NAME,
  AGT_WEB_FETCH_NAME,
  AGT_FILE_READ_NAME,
  AGT_FILE_LIST_NAME,
  AGT_FILE_WRITE_NAME,
  AGT_FILE_EDIT_NAME,
  AGT_FILE_APPEND_NAME,
} from './agent/tools/agent-tools/index.js';

describe('AGT_TOOL_NAME_TO_KEY — canonical-name drift guard', () => {
  it('covers exactly the 13 registered agt_* tool names', () => {
    const registered = [
      AGT_GLOB_NAME,
      AGT_GREP_NAME,
      AGT_MULTIEDIT_NAME,
      AGT_PATCH_NAME,
      AGT_TODO_READ_NAME,
      AGT_TODO_WRITE_NAME,
      AGT_WEB_SEARCH_NAME,
      AGT_WEB_FETCH_NAME,
      AGT_FILE_READ_NAME,
      AGT_FILE_LIST_NAME,
      AGT_FILE_WRITE_NAME,
      AGT_FILE_EDIT_NAME,
      AGT_FILE_APPEND_NAME,
    ].sort();
    expect(Object.keys(AGT_TOOL_NAME_TO_KEY).sort()).toEqual(registered);
  });
});

describe('mapAgentToolFlags — generic pair semantics (AC-6)', () => {
  it('returns undefined when neither flag was passed (empty arrays)', () => {
    expect(mapAgentToolFlags({ enableTool: [], disableTool: [] })).toBeUndefined();
    expect(mapAgentToolFlags({})).toBeUndefined();
  });

  it('maps enable/disable names to the correct camelCase keys', () => {
    const out = mapAgentToolFlags({
      enableTool: ['agt_todo_read', 'agt_todo_write'],
      disableTool: ['agt_grep', 'agt_web_fetch', 'agt_file_append'],
    });
    expect(out).toEqual({
      tools: {
        todoRead: true,
        todoWrite: true,
        grep: false,
        webFetch: false,
        fileAppend: false,
      },
    });
  });

  it('duplicates within one array are harmless (idempotent)', () => {
    const out = mapAgentToolFlags({ enableTool: ['agt_glob', 'agt_glob'], disableTool: [] });
    expect(out).toEqual({ tools: { glob: true } });
  });

  it('unknown name raises UsageError listing all 13 valid names', () => {
    try {
      mapAgentToolFlags({ enableTool: ['agt_bogus'], disableTool: [] });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_USAGE');
      expect((e as { exitCode?: number }).exitCode).toBe(2);
      const msg = (e as Error).message;
      for (const name of Object.keys(AGT_TOOL_NAME_TO_KEY)) {
        expect(msg).toContain(name);
      }
    }
  });

  it('unknown name on --disable-tool names the offending flag', () => {
    expect(() =>
      mapAgentToolFlags({ enableTool: [], disableTool: ['grep'] }),
    ).toThrow(/Unknown tool name 'grep' for --disable-tool/);
  });

  it('the same name in both flags raises UsageError', () => {
    try {
      mapAgentToolFlags({ enableTool: ['agt_patch'], disableTool: ['agt_patch'] });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_USAGE');
      expect((e as { exitCode?: number }).exitCode).toBe(2);
      expect((e as Error).message).toMatch(/agt_patch.*both --enable-tool and --disable-tool/);
    }
  });

  it('never emits an enabled/umbrella member (plan-015 shape)', () => {
    const out = mapAgentToolFlags({ enableTool: ['agt_glob'], disableTool: [] });
    expect(out).not.toHaveProperty('enabled');
    expect(Object.keys(out ?? {})).toEqual(['tools']);
  });
});
