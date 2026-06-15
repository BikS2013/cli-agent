/**
 * Tests for buildAgentToolsGroup — gating matrix coverage.
 *
 * Asserts that every (umbrella, per-tool, allowMutations) combination
 * produces the expected registered tool list and matching meta entries
 * in registration order.
 *
 * Uses a hand-rolled minimal AgentConfig fixture rather than the full
 * config loader so the assertions stay tight on the gating decision.
 */

import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '../../../config/agent-config.js';
import type { PermissionPolicy } from '../agent-tools-vendored/upstream/src/types.js';
import { buildAgentToolsGroup } from './group-builder.js';
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
} from './index.js';

/**
 * No-op policy. None of the wrappers we construct in these tests run
 * `execute()`; they are merely instantiated, so the policy methods
 * never fire. We still satisfy the upstream PermissionPolicy interface.
 */
const noopPolicy: PermissionPolicy = {
  id: 'test-policy',
  evaluateBash: () => ({ allow: true }),
  evaluateFsWrite: () => ({ allow: true }),
};

interface Flags {
  glob?: boolean;
  grep?: boolean;
  multiedit?: boolean;
  patch?: boolean;
  todoRead?: boolean;
  todoWrite?: boolean;
  webSearch?: boolean;
  webFetch?: boolean;
  fileRead?: boolean;
  fileList?: boolean;
  fileWrite?: boolean;
  fileEdit?: boolean;
  fileAppend?: boolean;
}

function makeCfg(opts: {
  enabled?: boolean;
  allowMutations?: boolean;
  flags?: Flags;
}): AgentConfig {
  const enabled = opts.enabled ?? true;
  const allowMutations = opts.allowMutations ?? false;
  const flags = opts.flags ?? {};
  return {
    agentTools: {
      enabled,
      tools: {
        glob: flags.glob ?? false,
        grep: flags.grep ?? false,
        multiedit: flags.multiedit ?? false,
        patch: flags.patch ?? false,
        todoRead: flags.todoRead ?? false,
        todoWrite: flags.todoWrite ?? false,
        webSearch: flags.webSearch ?? false,
        webFetch: flags.webFetch ?? false,
        fileRead: flags.fileRead ?? false,
        fileList: flags.fileList ?? false,
        fileWrite: flags.fileWrite ?? false,
        fileEdit: flags.fileEdit ?? false,
        fileAppend: flags.fileAppend ?? false,
      },
    },
    allowMutations,
    // Consulted by the agt_file_* wrappers at construction (sandbox config).
    fileEdit: { root: '/tmp/test-sandbox', allowPaths: [] },
    perToolBudgetBytes: 8192,
    // Other fields are not consulted by buildAgentToolsGroup; the cast
    // keeps the fixture minimal and intentional.
  } as unknown as AgentConfig;
}

describe('buildAgentToolsGroup — gating matrix', () => {
  it('umbrella OFF returns empty group regardless of per-tool flags', () => {
    const cfg = makeCfg({
      enabled: false,
      allowMutations: true,
      flags: {
        glob: true,
        grep: true,
        multiedit: true,
        patch: true,
        todoRead: true,
        todoWrite: true,
      },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.tools).toHaveLength(0);
    expect(group.meta.umbrellaEnabled).toBe(false);
    expect(group.meta.registered).toHaveLength(0);
  });

  it('umbrella ON, every flag OFF → empty registered list (umbrella still on)', () => {
    const cfg = makeCfg({ enabled: true, allowMutations: true, flags: {} });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.tools).toHaveLength(0);
    expect(group.meta.umbrellaEnabled).toBe(true);
    expect(group.meta.registered).toHaveLength(0);
  });

  it('all flags ON with allowMutations=true → all six tools registered in canonical order', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: true,
      flags: {
        glob: true,
        grep: true,
        multiedit: true,
        patch: true,
        todoRead: true,
        todoWrite: true,
      },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.tools).toHaveLength(6);
    expect(group.meta.registered.map((e) => e.name)).toEqual([
      AGT_GLOB_NAME,
      AGT_GREP_NAME,
      AGT_MULTIEDIT_NAME,
      AGT_PATCH_NAME,
      AGT_TODO_READ_NAME,
      AGT_TODO_WRITE_NAME,
    ]);
    // tool[i].name lockstep with meta[i].name (invariant).
    for (let i = 0; i < group.tools.length; i++) {
      expect(group.tools[i]!.name).toBe(group.meta.registered[i]!.name);
    }
  });

  it('mutations OFF drops multiedit and patch even when their flags are ON', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: false,
      flags: {
        glob: true,
        grep: true,
        multiedit: true, // requested but mutations off → DROPPED
        patch: true,     // requested but mutations off → DROPPED
        todoRead: true,
        todoWrite: true,
      },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    const names = group.meta.registered.map((e) => e.name);
    expect(names).toEqual([
      AGT_GLOB_NAME,
      AGT_GREP_NAME,
      AGT_TODO_READ_NAME,
      AGT_TODO_WRITE_NAME,
    ]);
    expect(names).not.toContain(AGT_MULTIEDIT_NAME);
    expect(names).not.toContain(AGT_PATCH_NAME);
  });

  it('todo pair only', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: false,
      flags: { todoRead: true, todoWrite: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.meta.registered.map((e) => e.name)).toEqual([
      AGT_TODO_READ_NAME,
      AGT_TODO_WRITE_NAME,
    ]);
  });

  it('grep only', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: false,
      flags: { grep: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.tools).toHaveLength(1);
    expect(group.meta.registered).toEqual([
      { name: AGT_GREP_NAME, description: expect.any(String) as unknown as string },
    ]);
  });

  it('mutations ON, only patch enabled → patch registered', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: true,
      flags: { patch: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.meta.registered.map((e) => e.name)).toEqual([AGT_PATCH_NAME]);
  });

  // -- plan-011: first-party web wrappers (read-only, no mutation gate) ----

  it('web wrappers register WITHOUT allowMutations (read-only)', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: false,
      flags: { webSearch: true, webFetch: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.meta.registered.map((e) => e.name)).toEqual([
      AGT_WEB_SEARCH_NAME,
      AGT_WEB_FETCH_NAME,
    ]);
    // tool[i] ↔ meta[i] lockstep.
    for (let i = 0; i < group.tools.length; i++) {
      expect(group.tools[i]!.name).toBe(group.meta.registered[i]!.name);
    }
  });

  it('web wrappers register AFTER grep in canonical order', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: false,
      flags: { glob: true, grep: true, webSearch: true, webFetch: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.meta.registered.map((e) => e.name)).toEqual([
      AGT_GLOB_NAME,
      AGT_GREP_NAME,
      AGT_WEB_SEARCH_NAME,
      AGT_WEB_FETCH_NAME,
    ]);
  });

  it('umbrella OFF drops the web wrappers even with their flags on', () => {
    const cfg = makeCfg({
      enabled: false,
      flags: { webSearch: true, webFetch: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.tools).toHaveLength(0);
    expect(group.meta.registered).toHaveLength(0);
  });

  it('webSearch on, webFetch off → only agt_web_search registers', () => {
    const cfg = makeCfg({
      enabled: true,
      flags: { webSearch: true, webFetch: false },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.meta.registered.map((e) => e.name)).toEqual([AGT_WEB_SEARCH_NAME]);
  });

  it('every meta entry carries a non-empty description', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: true,
      flags: {
        glob: true,
        grep: true,
        multiedit: true,
        patch: true,
        todoRead: true,
        todoWrite: true,
      },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    for (const entry of group.meta.registered) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  // -- plan-012: first-party file wrappers -------------------------------
  // read/list are read-only; write/edit/append are mutation-gated (require
  // cfg.allowMutations), mirroring agt_multiedit / agt_patch.

  it('file read/list register WITHOUT allowMutations (read-only)', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: false,
      flags: { fileRead: true, fileList: true, fileWrite: true, fileEdit: true, fileAppend: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    const names = group.meta.registered.map((e) => e.name);
    expect(names).toContain(AGT_FILE_READ_NAME);
    expect(names).toContain(AGT_FILE_LIST_NAME);
    // The three mutators are dropped because allowMutations is off.
    expect(names).not.toContain(AGT_FILE_WRITE_NAME);
    expect(names).not.toContain(AGT_FILE_EDIT_NAME);
    expect(names).not.toContain(AGT_FILE_APPEND_NAME);
  });

  it('file write/edit/append register ONLY when allowMutations=true', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: true,
      flags: { fileWrite: true, fileEdit: true, fileAppend: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    const names = group.meta.registered.map((e) => e.name);
    expect(names).toContain(AGT_FILE_WRITE_NAME);
    expect(names).toContain(AGT_FILE_EDIT_NAME);
    expect(names).toContain(AGT_FILE_APPEND_NAME);
  });

  it('all file flags ON + allowMutations=true → five file tools in canonical order, lockstep holds', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: true,
      flags: { fileRead: true, fileList: true, fileWrite: true, fileEdit: true, fileAppend: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.meta.registered.map((e) => e.name)).toEqual([
      AGT_FILE_READ_NAME,
      AGT_FILE_LIST_NAME,
      AGT_FILE_WRITE_NAME,
      AGT_FILE_EDIT_NAME,
      AGT_FILE_APPEND_NAME,
    ]);
    // tools.length === meta.registered.length, and tool[i] ↔ meta[i].
    expect(group.tools).toHaveLength(group.meta.registered.length);
    for (let i = 0; i < group.tools.length; i++) {
      expect(group.tools[i]!.name).toBe(group.meta.registered[i]!.name);
    }
  });

  it('file wrappers register AFTER the web wrappers in canonical order', () => {
    const cfg = makeCfg({
      enabled: true,
      allowMutations: false,
      flags: { glob: true, grep: true, webSearch: true, webFetch: true, fileRead: true, fileList: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.meta.registered.map((e) => e.name)).toEqual([
      AGT_GLOB_NAME,
      AGT_GREP_NAME,
      AGT_WEB_SEARCH_NAME,
      AGT_WEB_FETCH_NAME,
      AGT_FILE_READ_NAME,
      AGT_FILE_LIST_NAME,
    ]);
  });

  it('umbrella OFF drops the file wrappers even with their flags on', () => {
    const cfg = makeCfg({
      enabled: false,
      allowMutations: true,
      flags: { fileRead: true, fileList: true, fileWrite: true, fileEdit: true, fileAppend: true },
    });
    const group = buildAgentToolsGroup(cfg, noopPolicy);
    expect(group.tools).toHaveLength(0);
    expect(group.meta.registered).toHaveLength(0);
  });
});
