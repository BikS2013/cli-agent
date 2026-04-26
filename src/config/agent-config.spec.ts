/**
 * Unit tests for agent-config.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadAgentConfig, SUPPORTED_PROVIDERS, AGENT_TOOL_NAME } from './agent-config.js';

// Prevent actual filesystem bootstrap during tests
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    writeFile: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockImplementation((p: string) => {
      if (String(p).endsWith('.env')) return Promise.resolve('');
      if (String(p).endsWith('config.json')) {
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      }
      return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    }),
  };
});

describe('loadAgentConfig', () => {
  it('throws ConfigurationError when provider is missing', async () => {
    await expect(
      loadAgentConfig({}, { shellEnv: {}, cwd: '/tmp' }),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING' });
  });

  it('throws ProviderNotSupportedError for unknown provider', async () => {
    await expect(
      loadAgentConfig({ provider: 'bogus' }, { shellEnv: {}, cwd: '/tmp' }),
    ).rejects.toMatchObject({ code: 'E_PROVIDER_NOT_SUPPORTED' });
  });

  it('accepts all 8 supported providers from CLI flags', async () => {
    for (const provider of SUPPORTED_PROVIDERS) {
      const cfg = await loadAgentConfig({ provider }, { shellEnv: {}, cwd: '/tmp' });
      expect(cfg.provider).toBe(provider);
    }
  });

  it('reads provider from shell env AGENT_PROVIDER', async () => {
    const cfg = await loadAgentConfig(
      {},
      { shellEnv: { AGENT_PROVIDER: 'openai' }, cwd: '/tmp' },
    );
    expect(cfg.provider).toBe('openai');
  });

  it('CLI flag provider overrides shell env', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'anthropic' },
      { shellEnv: { AGENT_PROVIDER: 'openai' }, cwd: '/tmp' },
    );
    expect(cfg.provider).toBe('anthropic');
  });

  it('merges tools from CLI flags additive over config (empty config)', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai', tools: ['git', 'gh'] },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.tools).toContain('git');
    expect(cfg.tools).toContain('gh');
  });

  it('deduplicates tools', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai', tools: ['git', 'git', 'gh'] },
      { shellEnv: {}, cwd: '/tmp' },
    );
    const gitCount = cfg.tools.filter((t) => t === 'git').length;
    expect(gitCount).toBe(1);
  });

  it('defaults allowMutations to false', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.allowMutations).toBe(false);
  });

  it('OPENAI_API_KEY from shell env is captured in providerEnv', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { OPENAI_API_KEY: 'sk-test' }, cwd: '/tmp' },
    );
    expect(cfg.providerEnv.OPENAI_API_KEY).toBe('sk-test');
  });

  it('GEMINI_API_KEY alias is captured in providerEnv', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'gemini' },
      { shellEnv: { GEMINI_API_KEY: 'gk-test' }, cwd: '/tmp' },
    );
    expect(cfg.providerEnv.GEMINI_API_KEY).toBe('gk-test');
  });

  it('agentDir is under ~/.tool-agents/cli-agent', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.agentDir).toBe(path.join(os.homedir(), '.tool-agents', AGENT_TOOL_NAME));
  });
});
