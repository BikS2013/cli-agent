/**
 * Mode-knob tests (plan-015).
 *
 * Covers: the five-tier pinnable resolution of `mode` (CLI > env
 * CLI_AGENT_MODE > profile cliParams.mode > config.json mode > default
 * 'composite'), the mode→groups expansion, the `--tool` × chat/basic
 * conflict across every mode source, and the legacy-surface rejection
 * matrix (removed env vars / config.json keys). The fs mock harness
 * mirrors `agent-config.spec.ts` — see the IMPORTANT note there on why
 * both `default` and named exports must be mocked.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadAgentConfig, AGENT_TOOL_NAME } from './agent-config.js';
import {
  AGENT_MODES,
  modeToGroups,
  deriveModeFromGroups,
  parseModeFlag,
  isAgentMode,
} from './mode.js';

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
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
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
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  const constants = { F_OK: 0, R_OK: 4 };
  return {
    ...actual,
    accessSync,
    constants,
    default: { ...actual, accessSync, constants },
  };
});

const AGENT_DIR = path.join(os.homedir(), '.tool-agents', AGENT_TOOL_NAME);

async function getTestFiles(): Promise<Map<string, Buffer>> {
  const mod = (await import('node:fs/promises')) as unknown as {
    __testHelpers: { fileContents: Map<string, Buffer> };
  };
  return mod.__testHelpers.fileContents;
}

async function placeConfigJson(body: Record<string, unknown>): Promise<void> {
  const files = await getTestFiles();
  files.set(
    path.join(AGENT_DIR, 'config.json'),
    Buffer.from(JSON.stringify(body), 'utf8'),
  );
}

async function placeProfile(name: string, body: string): Promise<void> {
  const files = await getTestFiles();
  files.set(path.join(AGENT_DIR, 'profiles', `${name}.yaml`), Buffer.from(body, 'utf8'));
}

beforeEach(async () => {
  const files = await getTestFiles();
  files.clear();
});

/* ---------- Pure mapping helpers (src/config/mode.ts) ---------- */

describe('mode.ts — pure helpers', () => {
  it('modeToGroups implements the four-row mapping table', () => {
    expect(modeToGroups('chat')).toEqual({ builtinTools: false, composites: false, agentToolsEnabled: false });
    expect(modeToGroups('basic')).toEqual({ builtinTools: false, composites: false, agentToolsEnabled: true });
    expect(modeToGroups('tool')).toEqual({ builtinTools: true, composites: false, agentToolsEnabled: true });
    expect(modeToGroups('composite')).toEqual({ builtinTools: true, composites: true, agentToolsEnabled: true });
  });

  it('deriveModeFromGroups is the exact inverse of modeToGroups', () => {
    for (const mode of AGENT_MODES) {
      expect(deriveModeFromGroups(modeToGroups(mode))).toBe(mode);
    }
  });

  it('deriveModeFromGroups throws on an unreachable combination', () => {
    expect(() =>
      deriveModeFromGroups({ builtinTools: true, composites: true, agentToolsEnabled: false }),
    ).toThrow(/internal invariant violation/);
  });

  it('parseModeFlag passes undefined through and validates values', () => {
    expect(parseModeFlag(undefined)).toBeUndefined();
    expect(parseModeFlag('tool')).toBe('tool');
    expect(() => parseModeFlag('bogus')).toThrow(/Valid modes: chat, basic, tool, composite/);
    try {
      parseModeFlag('bogus');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_USAGE');
      expect((e as { exitCode?: number }).exitCode).toBe(2);
    }
  });

  it('isAgentMode accepts exactly the four modes', () => {
    for (const mode of AGENT_MODES) expect(isAgentMode(mode)).toBe(true);
    expect(isAgentMode('shell')).toBe(false);
    expect(isAgentMode(1)).toBe(false);
    expect(isAgentMode(undefined)).toBe(false);
  });
});

/* ---------- Mode → groups expansion through loadAgentConfig ---------- */

describe('loadAgentConfig — mode expansion (AC-1..AC-3)', () => {
  it.each([
    ['chat', false, false, false],
    ['basic', false, false, true],
    ['tool', true, false, true],
    ['composite', true, true, true],
  ])('--mode %s expands to builtin=%s composites=%s agentTools=%s', async (mode, builtin, composites, agt) => {
    const cfg = await loadAgentConfig(
      { provider: 'openai', mode },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.builtinTools).toBe(builtin);
    expect(cfg.composites).toBe(composites);
    expect(cfg.agentTools.enabled).toBe(agt);
  });

  it('flagless invocation defaults to composite (all groups on) — AC-1', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(deriveModeFromGroups({
      builtinTools: cfg.builtinTools,
      composites: cfg.composites,
      agentToolsEnabled: cfg.agentTools.enabled,
    })).toBe('composite');
  });
});

/* ---------- Five-tier resolution order (AC-4) ---------- */

describe('loadAgentConfig — mode resolution order (AC-4)', () => {
  it('CLI flag beats env, profile, and config.json', async () => {
    await placeProfile('p', 'name: p\nschemaVersion: 1\ncliParams:\n  mode: basic\n');
    await placeConfigJson({ schemaVersion: 1, mode: 'basic' });
    const cfg = await loadAgentConfig(
      { provider: 'openai', mode: 'chat', profile: 'p' },
      { shellEnv: { CLI_AGENT_MODE: 'tool' }, cwd: '/tmp' },
    );
    expect(cfg.builtinTools).toBe(false);
    expect(cfg.agentTools.enabled).toBe(false); // chat
  });

  it('env CLI_AGENT_MODE beats profile and config.json', async () => {
    await placeProfile('p', 'name: p\nschemaVersion: 1\ncliParams:\n  mode: composite\n');
    await placeConfigJson({ schemaVersion: 1, mode: 'composite' });
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'p' },
      { shellEnv: { CLI_AGENT_MODE: 'basic' }, cwd: '/tmp' },
    );
    expect(cfg.builtinTools).toBe(false);
    expect(cfg.agentTools.enabled).toBe(true); // basic
  });

  it('profile cliParams.mode beats config.json', async () => {
    await placeProfile('p', 'name: p\nschemaVersion: 1\ncliParams:\n  mode: basic\n');
    await placeConfigJson({ schemaVersion: 1, mode: 'composite' });
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'p' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.builtinTools).toBe(false);
    expect(cfg.agentTools.enabled).toBe(true); // basic
  });

  it('config.json mode beats the composite default', async () => {
    await placeConfigJson({ schemaVersion: 1, mode: 'chat' });
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.builtinTools).toBe(false);
    expect(cfg.agentTools.enabled).toBe(false); // chat
  });
});

/* ---------- Invalid values (FR-MODE-1 / FR-MODE-3) ---------- */

describe('loadAgentConfig — invalid mode values', () => {
  it('invalid CLI-tier mode raises UsageError (exit 2)', async () => {
    await expect(
      loadAgentConfig({ provider: 'openai', mode: 'bogus' }, { shellEnv: {}, cwd: '/tmp' }),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });

  it('invalid CLI_AGENT_MODE raises ConfigurationError (no fallback)', async () => {
    await expect(
      loadAgentConfig(
        { provider: 'openai' },
        { shellEnv: { CLI_AGENT_MODE: 'everything' }, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING', exitCode: 3 });
  });

  it('invalid config.json mode raises ConfigurationError (no fallback)', async () => {
    await placeConfigJson({ schemaVersion: 1, mode: 'turbo' });
    await expect(
      loadAgentConfig({ provider: 'openai' }, { shellEnv: {}, cwd: '/tmp' }),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING', exitCode: 3 });
  });
});

/* ---------- --tool × chat/basic conflict (FR-MODE-5 / AC-5) ---------- */

describe('loadAgentConfig — --tool × mode conflict (AC-5)', () => {
  it.each(['chat', 'basic'])('CLI-sourced mode %s with --tool raises UsageError', async (mode) => {
    await expect(
      loadAgentConfig(
        { provider: 'openai', mode, tools: ['git'] },
        { shellEnv: {}, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });

  it('env-sourced chat mode with --tool raises UsageError', async () => {
    await expect(
      loadAgentConfig(
        { provider: 'openai', tools: ['git'] },
        { shellEnv: { CLI_AGENT_MODE: 'chat' }, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });

  it('profile-sourced basic mode with --tool raises UsageError', async () => {
    await placeProfile('p', 'name: p\nschemaVersion: 1\ncliParams:\n  mode: basic\n');
    await expect(
      loadAgentConfig(
        { provider: 'openai', profile: 'p', tools: ['git'] },
        { shellEnv: {}, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });

  it('config-sourced chat mode conflicts with config-sourced tools too', async () => {
    await placeConfigJson({ schemaVersion: 1, mode: 'chat', tools: ['git'] });
    await expect(
      loadAgentConfig({ provider: 'openai' }, { shellEnv: {}, cwd: '/tmp' }),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });

  it('the conflict message directs to --mode tool / --mode composite', async () => {
    await expect(
      loadAgentConfig(
        { provider: 'openai', mode: 'chat', tools: ['git'] },
        { shellEnv: {}, cwd: '/tmp' },
      ),
    ).rejects.toThrow(/--mode tool or --mode composite/);
  });

  it.each(['tool', 'composite'])('mode %s accepts wrapped tools', async (mode) => {
    const cfg = await loadAgentConfig(
      { provider: 'openai', mode, tools: ['git'] },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.tools).toEqual(['git']);
    expect(cfg.builtinTools).toBe(true);
  });
});

/* ---------- Legacy-surface rejection (Resolution 2 / AC-10) ---------- */

describe('loadAgentConfig — legacy tool-group surface rejection (plan-015)', () => {
  it.each([
    'CLI_AGENT_DISABLE_COMPOSITES',
    'CLI_AGENT_DISABLE_BUILTIN_TOOLS',
    'CLI_AGENT_DISABLE_AGENT_TOOLS',
  ])('a set %s env var (any value) raises ConfigurationError with the migration hint', async (envKey) => {
    await expect(
      loadAgentConfig(
        { provider: 'openai' },
        { shellEnv: { [envKey]: '1' }, cwd: '/tmp' },
      ),
    ).rejects.toThrow(/was removed \(plan-015\).*--mode/s);
    await expect(
      loadAgentConfig(
        { provider: 'openai' },
        { shellEnv: { [envKey]: '0' }, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING', exitCode: 3 });
  });

  it.each([
    [{ schemaVersion: 1, composites: true }, 'composites'],
    [{ schemaVersion: 1, builtinTools: false }, 'builtinTools'],
    [{ schemaVersion: 1, agentTools: { enabled: true } }, 'agentTools.enabled'],
  ] as const)('a present legacy config.json key raises ConfigurationError naming %s', async (body, keyName) => {
    await placeConfigJson(body as unknown as Record<string, unknown>);
    await expect(
      loadAgentConfig({ provider: 'openai' }, { shellEnv: {}, cwd: '/tmp' }),
    ).rejects.toThrow(new RegExp(`${keyName.replace('.', '\\.')}.*removed \\(plan-015\\)`, 's'));
  });

  it('agentTools.tools.* config keys are NOT legacy — still honored', async () => {
    await placeConfigJson({ schemaVersion: 1, agentTools: { tools: { glob: false } } });
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.glob).toBe(false);
    expect(cfg.agentTools.enabled).toBe(true); // composite default
  });
});
