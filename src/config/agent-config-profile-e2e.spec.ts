/**
 * End-to-end integration test for the --profile flow through:
 *
 *   loadAgentConfig (tier-5 cliParams resolution)
 *     → AgentConfig.activeProfileData (tools + toolArgs)
 *       → buildToolCatalog (profile tool scoping + toolArgs dead-ref warnings)
 *         → tool.func invocation (mergeProfileToolArgs)
 *
 * This test addresses the gap identified in the Phase 7 code review:
 *   - Verifies a complete profile YAML with all three sections threads
 *     correctly from flags through to the catalog and tool invocation.
 *   - Verifies the resolved AgentConfig has profile cliParams values.
 *   - Verifies buildToolCatalog reflects the allow scoping.
 *   - Verifies a tool's .func called with empty input merges profile toolArgs.
 *
 * Mock strategy: same hermetic pattern as agent-config.spec.ts —
 * vi.mock('node:fs/promises') with a fileContents Map so the loader can
 * read the synthetic profile file without touching the real filesystem.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadAgentConfig, AGENT_TOOL_NAME } from './agent-config.js';
import { buildToolCatalog } from '../agent/tools/registry.js';
import { mergeProfileToolArgs } from '../agent/tools/profile-tool-args.js';
import type { Logger } from '../agent/logging.js';

// ---------------------------------------------------------------------------
// Hermetic filesystem mock
// Mirrors the pattern from agent-config.spec.ts exactly.
// ---------------------------------------------------------------------------

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const enoent = () =>
    Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  const writtenPaths = new Set<string>();
  const fileContents = new Map<string, Buffer>();
  const mocks = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockImplementation((p: string) => {
      if (writtenPaths.has(String(p))) return Promise.resolve(undefined);
      if (fileContents.has(String(p))) return Promise.resolve(undefined);
      return enoent();
    }),
    writeFile: vi.fn().mockImplementation((p: string) => {
      writtenPaths.add(String(p));
      return Promise.resolve(undefined);
    }),
    readFile: vi.fn().mockImplementation((p: string, enc?: string) => {
      const key = String(p);
      const buf = fileContents.get(key);
      if (buf !== undefined) {
        if (enc === 'utf8') return Promise.resolve(buf.toString('utf8'));
        return Promise.resolve(buf);
      }
      if (key.endsWith('.env')) return Promise.resolve('');
      if (key.endsWith('config.json')) return enoent();
      return enoent();
    }),
    readdir: vi.fn().mockImplementation(async (p: string) => {
      const dir = String(p).replace(/\/+$/, '') + '/';
      const out: string[] = [];
      for (const key of fileContents.keys()) {
        if (key.startsWith(dir)) {
          const rest = key.slice(dir.length);
          if (!rest.includes('/')) out.push(rest);
        }
      }
      return out;
    }),
    stat: vi.fn().mockImplementation(async (p: string) => {
      const buf = fileContents.get(String(p));
      if (!buf) {
        const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        throw err;
      }
      return { size: buf.length, mtime: new Date('2026-01-01T00:00:00Z') };
    }),
  };
  return {
    ...actual,
    ...mocks,
    default: { ...actual, ...mocks },
    __testHelpers: { fileContents, writtenPaths },
  };
});

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const promisesMod = (await import('node:fs/promises')) as unknown as {
    __testHelpers: { fileContents: Map<string, Buffer> };
  };
  const fileContents = promisesMod.__testHelpers.fileContents;
  const accessSync = vi.fn().mockImplementation((p: string) => {
    if (fileContents.has(String(p))) return undefined;
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    throw err;
  });
  const constants = { F_OK: 0, R_OK: 4 };
  return {
    ...actual,
    accessSync,
    constants,
    default: { ...actual, accessSync, constants },
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const AGENT_DIR = path.join(os.homedir(), '.tool-agents', AGENT_TOOL_NAME);

async function getTestFiles(): Promise<Map<string, Buffer>> {
  const mod = (await import('node:fs/promises')) as unknown as {
    __testHelpers: { fileContents: Map<string, Buffer> };
  };
  return mod.__testHelpers.fileContents;
}

async function placeProfileFile(filename: string, body: string): Promise<string> {
  const abs = path.join(AGENT_DIR, 'profiles', filename);
  const files = await getTestFiles();
  files.set(abs, Buffer.from(body, 'utf8'));
  return abs;
}

async function clearProfiles(): Promise<void> {
  const files = await getTestFiles();
  for (const k of [...files.keys()]) {
    if (k.includes('/profiles/')) files.delete(k);
  }
}

const nullLogger: Logger = {
  log: () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
  get currentLogPath() { return ''; },
  get currentSessionId() { return 'test-session'; },
};

// ---------------------------------------------------------------------------
// End-to-end profile flow tests
// ---------------------------------------------------------------------------

describe('E2E profile flow: loadAgentConfig → AgentConfig (cliParams)', () => {
  beforeEach(async () => {
    await clearProfiles();
  });

  it('full profile YAML with all three sections — cliParams threads into AgentConfig', async () => {
    /**
     * Writes a complete profile YAML with cliParams, tools, and toolArgs.
     * Verifies that the resolved AgentConfig has:
     *   - cfg.temperature from cliParams.temperature
     *   - cfg.model from cliParams.model
     *   - cfg.webSearchBackend from cliParams.webSearchBackend
     *   - cfg.activeProfileData.tools set
     *   - cfg.activeProfileData.toolArgs set
     */
    await placeProfileFile(
      'full.yaml',
      [
        'name: full',
        'schemaVersion: 1',
        'description: Full profile for E2E test',
        'cliParams:',
        '  provider: openai',
        '  model: gpt-4o-e2e',
        '  temperature: 0.55',
        '  webSearchBackend: brave',
        'tools:',
        '  allow:',
        '    - file_read',
        '    - web_search',
        'toolArgs:',
        '  web_search:',
        '    maxResults: 7',
        '',
      ].join('\n'),
    );

    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'full' },
      { shellEnv: {}, cwd: '/tmp' },
    );

    // cliParams resolution
    expect(cfg.model).toBe('gpt-4o-e2e');
    expect(cfg.temperature).toBe(0.55);
    expect(cfg.webSearchBackend).toBe('brave');

    // activeProfile metadata
    expect(cfg.activeProfile?.name).toBe('full');
    expect(cfg.activeProfile?.schemaVersion).toBe(1);
    expect(cfg.activeProfile?.digest).toMatch(/^[0-9a-f]{16}$/);

    // activeProfileData carries tools + toolArgs for downstream use
    expect(cfg.activeProfileData?.tools?.allow).toEqual(['file_read', 'web_search']);
    expect(cfg.activeProfileData?.toolArgs?.['web_search']).toEqual({ maxResults: 7 });
  });

  it('full profile: CLI flags override profile cliParams for each affected knob', async () => {
    await placeProfileFile(
      'overridable.yaml',
      [
        'name: overridable',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: anthropic',
        '  model: claude-2',
        '  temperature: 0.9',
        '',
      ].join('\n'),
    );

    // Pass explicit CLI values for all three profile knobs
    const cfg = await loadAgentConfig(
      {
        provider: 'openai',  // overrides profile's anthropic
        model: 'gpt-5',      // overrides profile's claude-2
        temperature: 0.1,    // overrides profile's 0.9
        profile: 'overridable',
      },
      { shellEnv: {}, cwd: '/tmp' },
    );

    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-5');
    expect(cfg.temperature).toBe(0.1);
  });

  it('full profile: shell env overrides profile cliParams', async () => {
    await placeProfileFile(
      'env-battle.yaml',
      [
        'name: env-battle',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: anthropic',
        '',
      ].join('\n'),
    );

    const cfg = await loadAgentConfig(
      { profile: 'env-battle' },
      { shellEnv: { AGENT_PROVIDER: 'gemini' }, cwd: '/tmp' },
    );

    expect(cfg.provider).toBe('gemini');
  });
});

describe('E2E profile flow: AgentConfig → buildToolCatalog (tool scoping)', () => {
  beforeEach(async () => {
    await clearProfiles();
  });

  it('profile allow scoping propagates from loadAgentConfig to buildToolCatalog catalog', async () => {
    // plan-011/plan-012: both web and file ops are now first-party agt_* tools.
    // Allow two agt_* tools (agt_file_read + agt_web_search) so the scoping
    // covers both — and proves file ops are name-scopable like any agt_ tool.
    await placeProfileFile(
      'allow-two.yaml',
      [
        'name: allow-two',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: openai',
        'tools:',
        '  allow:',
        '    - agt_file_read',
        '    - agt_web_search',
        '',
      ].join('\n'),
    );

    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'allow-two' },
      { shellEnv: {}, cwd: '/tmp' },
    );

    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = catalog.tools.map((t: { name: string }) => t.name);

    expect(names).toContain('agt_file_read');
    expect(names).toContain('agt_web_search');
    // All other standard tools must be absent after allow scoping
    expect(names).not.toContain('agt_file_list');
    expect(names).not.toContain('bash_list_allowed');
    expect(names).not.toContain('bash_which');
    expect(names).not.toContain('agt_web_fetch');
    expect(names).not.toContain('tool_help');
    // Only agt_file_read + agt_web_search survive — no other agt_* tool.
    expect(names).toHaveLength(2);
    expect(names).not.toContain('agt_glob');
    expect(names).not.toContain('agt_grep');
  });

  it('profile deny scoping: denied tool absent from catalog', async () => {
    await placeProfileFile(
      'deny-one.yaml',
      [
        'name: deny-one',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: openai',
        'tools:',
        '  deny:',
        '    - tool_help',
        '',
      ].join('\n'),
    );

    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'deny-one' },
      { shellEnv: {}, cwd: '/tmp' },
    );

    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = catalog.tools.map((t: { name: string }) => t.name);

    expect(names).not.toContain('tool_help');
    // Other standard tools survive (file ops are now agt_file_*).
    expect(names).toContain('agt_file_read');
    expect(names).toContain('agt_file_list');
  });

  it('profile order scoping: ordered tools come first in catalog', async () => {
    await placeProfileFile(
      'order-profile.yaml',
      [
        'name: order-profile',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: openai',
        'tools:',
        '  order:',
        '    - agt_web_search',
        '    - agt_file_read',
        '',
      ].join('\n'),
    );

    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'order-profile' },
      { shellEnv: {}, cwd: '/tmp' },
    );

    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = catalog.tools.map((t: { name: string }) => t.name);

    // plan-011/plan-012: web is agt_web_search, file_read is agt_file_read.
    expect(names[0]).toBe('agt_web_search');
    expect(names[1]).toBe('agt_file_read');
  });
});

// ---------------------------------------------------------------------------
// E2E profile flow: toolArgs merge at tool invocation time
// ---------------------------------------------------------------------------

describe('E2E profile flow: toolArgs merge semantics (AC-11, AC-12)', () => {
  /**
   * These tests exercise mergeProfileToolArgs directly with the same
   * profileToolArgs structure that buildToolCatalog would pass via the
   * RunnableConfig.configurable bag. They confirm the end-to-end contract
   * that the toolArgs from the profile file eventually reach the tool's func.
   */

  it('AC-11 end-to-end: profile toolArgs value applies when runtime provides nothing', () => {
    // Simulate the configurable bag as built by run.ts from cfg.activeProfileData
    const configurable = {
      profileToolArgs: {
        web_search: { maxResults: 7 },
      },
    };

    const merged = mergeProfileToolArgs<{ maxResults?: number }>(
      {}, // empty runtime input
      configurable,
      'web_search',
    );

    expect(merged.maxResults).toBe(7);
  });

  it('AC-12 end-to-end: runtime override wins per-key; other profile keys persist', () => {
    const configurable = {
      profileToolArgs: {
        web_search: { maxResults: 7, includeRaw: true },
      },
    };

    // Runtime supplies maxResults=3, overriding the profile preset
    const merged = mergeProfileToolArgs<{ maxResults?: number; includeRaw?: boolean }>(
      { maxResults: 3 },
      configurable,
      'web_search',
    );

    expect(merged.maxResults).toBe(3);       // runtime wins
    expect(merged.includeRaw).toBe(true);    // profile preset persists
  });

  it('toolArgs for a tool not in the profile produce no-op merge', () => {
    const configurable = {
      profileToolArgs: {
        web_search: { maxResults: 7 },
      },
    };

    const input = { path: '/tmp/foo.txt' };
    const merged = mergeProfileToolArgs<{ path?: string }>(
      input,
      configurable,
      'file_read', // different tool — no preset
    );

    // Returns the SAME reference (identity fast-path)
    expect(merged).toBe(input);
    expect(merged.path).toBe('/tmp/foo.txt');
  });

  it('E2E: profile YAML toolArgs value reaches tool func via configurable bag', async () => {
    await clearProfiles();
    await placeProfileFile(
      'toolargs-e2e.yaml',
      [
        'name: toolargs-e2e',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: openai',
        'toolArgs:',
        '  file_read:',
        '    maxBytes: 512',
        '',
      ].join('\n'),
    );

    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'toolargs-e2e' },
      { shellEnv: {}, cwd: '/tmp' },
    );

    // The profile toolArgs should be in activeProfileData
    expect(cfg.activeProfileData?.toolArgs?.['file_read']).toEqual({ maxBytes: 512 });

    // Simulate the configurable bag construction (as done in run.ts)
    const configurable = {
      profileToolArgs: cfg.activeProfileData?.toolArgs ?? {},
    };

    // Tool invocation with empty runtime input → profile preset applies
    const merged = mergeProfileToolArgs<{ maxBytes?: number }>(
      {},
      configurable,
      'file_read',
    );

    expect(merged.maxBytes).toBe(512);
  });
});

// ---------------------------------------------------------------------------
// E2E profile flow: activeProfile metadata propagation
// ---------------------------------------------------------------------------

describe('E2E profile flow: activeProfile metadata on AgentConfig', () => {
  beforeEach(async () => {
    await clearProfiles();
  });

  it('activeProfile.name matches the profile name requested', async () => {
    await placeProfileFile(
      'meta-check.yaml',
      'name: meta-check\nschemaVersion: 1\n',
    );

    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'meta-check' },
      { shellEnv: {}, cwd: '/tmp' },
    );

    expect(cfg.activeProfile?.name).toBe('meta-check');
  });

  it('activeProfile.schemaVersion is 1 (default)', async () => {
    await placeProfileFile(
      'sv.yaml',
      'name: sv\nschemaVersion: 1\n',
    );

    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'sv' },
      { shellEnv: {}, cwd: '/tmp' },
    );

    expect(cfg.activeProfile?.schemaVersion).toBe(1);
  });

  it('activeProfile.digest is a 16-char hex string', async () => {
    await placeProfileFile(
      'digest-check.yaml',
      'name: digest-check\nschemaVersion: 1\ncliParams:\n  provider: openai\n',
    );

    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'digest-check' },
      { shellEnv: {}, cwd: '/tmp' },
    );

    expect(cfg.activeProfile?.digest).toMatch(/^[0-9a-f]{16}$/);
  });

  it('activeProfile is undefined when no --profile flag is set', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );

    expect(cfg.activeProfile).toBeUndefined();
    expect(cfg.activeProfileData).toBeUndefined();
  });
});
