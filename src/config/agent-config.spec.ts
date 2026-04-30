/**
 * Unit tests for agent-config.ts
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import { loadAgentConfig, SUPPORTED_PROVIDERS, AGENT_TOOL_NAME, resolveSystemPromptPath, SYSTEM_PROMPT_FILENAME, agentCapabilitiesDir } from './agent-config.js';

// Prevent actual filesystem bootstrap during tests.
// IMPORTANT: source code uses both `import fsp from 'node:fs/promises'` (default
// import) and `import { fn } from 'node:fs/promises'` (named imports). vi.mock
// must therefore expose BOTH a `default` object and the same names at the top
// level, otherwise default-import sites silently bypass the mock and hit the
// real filesystem (e.g. the user's ~/.tool-agents/cli-agent/.env).
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const enoent = () =>
    Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  // Track which paths bootstrap "wrote" so subsequent access() calls
  // observe them as present. Without this, the readability check inside
  // loadAgentConfig (for system-prompt.md) would fail even though the
  // bootstrap routine "seeded" it.
  const writtenPaths = new Set<string>();
  const mocks = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockImplementation((p: string) => {
      if (writtenPaths.has(String(p))) return Promise.resolve(undefined);
      return enoent();
    }),
    writeFile: vi.fn().mockImplementation((p: string) => {
      writtenPaths.add(String(p));
      return Promise.resolve(undefined);
    }),
    readFile: vi.fn().mockImplementation((p: string) => {
      if (String(p).endsWith('.env')) return Promise.resolve('');
      if (String(p).endsWith('config.json')) return enoent();
      return enoent();
    }),
  };
  return {
    ...actual,
    ...mocks,
    default: { ...actual, ...mocks },
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

  // --- System prompt selection (AC-2..AC-11 from refined spec) ---

  it('AC-2: defaults systemPromptPath to <capabilitiesDir>/system-prompt.md when no flag/env/config', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.systemPromptPath).toBe(path.join(agentCapabilitiesDir(), SYSTEM_PROMPT_FILENAME));
    expect(cfg.systemAppendText).toBeUndefined();
    expect(cfg.systemAppendFile).toBeUndefined();
  });

  it('AC-4: --system-prompt with absolute path is used verbatim', async () => {
    // Use a path that the mock has "written" so the readability check passes.
    // The bootstrap step writes the default; we add an additional pre-existing
    // path by simulating it via a writeFile call BEFORE loadAgentConfig.
    const fsp = await import('node:fs/promises');
    await fsp.writeFile('/tmp/my-prompt.md', 'fake', { mode: 0o600 });
    const cfg = await loadAgentConfig(
      { provider: 'openai', systemPromptFile: '/tmp/my-prompt.md' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.systemPromptPath).toBe('/tmp/my-prompt.md');
  });

  it('AC-5: --system-prompt with bare filename resolves under capabilitiesDir', async () => {
    const fsp = await import('node:fs/promises');
    const expected = path.join(agentCapabilitiesDir(), 'alt.md');
    await fsp.writeFile(expected, 'fake', { mode: 0o600 });
    const cfg = await loadAgentConfig(
      { provider: 'openai', systemPromptFile: 'alt.md' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.systemPromptPath).toBe(expected);
  });

  it('AC-6: --system-prompt with relative path resolves against cwd', async () => {
    const fsp = await import('node:fs/promises');
    const expected = path.resolve('/tmp', './prompts/x.md');
    await fsp.writeFile(expected, 'fake', { mode: 0o600 });
    const cfg = await loadAgentConfig(
      { provider: 'openai', systemPromptFile: './prompts/x.md' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.systemPromptPath).toBe(expected);
  });

  it('AC-7: --system-prompt with non-existent file raises UsageError (no silent fallback)', async () => {
    await expect(
      loadAgentConfig(
        { provider: 'openai', systemPromptFile: 'does-not-exist.md' },
        { shellEnv: {}, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({
      code: 'E_USAGE',
      exitCode: 2,
    });
  });

  it('AC-9: CLI_AGENT_SYSTEM_PROMPT env var selects the file when no CLI flag', async () => {
    const fsp = await import('node:fs/promises');
    const expected = path.join(agentCapabilitiesDir(), 'env-selected.md');
    await fsp.writeFile(expected, 'fake', { mode: 0o600 });
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_SYSTEM_PROMPT: 'env-selected.md' }, cwd: '/tmp' },
    );
    expect(cfg.systemPromptPath).toBe(expected);
  });

  it('AC-10: CLI flag overrides CLI_AGENT_SYSTEM_PROMPT env var', async () => {
    const fsp = await import('node:fs/promises');
    const flagPath = path.join(agentCapabilitiesDir(), 'flag-wins.md');
    await fsp.writeFile(flagPath, 'fake', { mode: 0o600 });
    // env target deliberately not pre-created — if precedence is wrong, the
    // resolver would try to validate it and fail with UsageError.
    const cfg = await loadAgentConfig(
      { provider: 'openai', systemPromptFile: 'flag-wins.md' },
      { shellEnv: { CLI_AGENT_SYSTEM_PROMPT: 'env-loses.md' }, cwd: '/tmp' },
    );
    expect(cfg.systemPromptPath).toBe(flagPath);
  });

  it('--system text is captured in cfg.systemAppendText for downstream composition', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai', system: 'extra rule' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.systemAppendText).toBe('extra rule');
  });

  it('--system-file path is captured in cfg.systemAppendFile for downstream composition', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai', systemFile: '/tmp/append.md' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.systemAppendFile).toBe('/tmp/append.md');
  });
});

describe('resolveSystemPromptPath', () => {
  it('treats absolute paths verbatim', () => {
    expect(resolveSystemPromptPath('/abs/path/foo.md', '/caps', '/cwd')).toBe('/abs/path/foo.md');
  });

  it('joins bare filenames onto capabilitiesDir', () => {
    expect(resolveSystemPromptPath('alt.md', '/caps', '/cwd')).toBe(path.join('/caps', 'alt.md'));
  });

  it('joins relative paths with separators onto cwd', () => {
    expect(resolveSystemPromptPath('./sub/x.md', '/caps', '/cwd')).toBe(path.resolve('/cwd', './sub/x.md'));
    expect(resolveSystemPromptPath('sub/x.md', '/caps', '/cwd')).toBe(path.resolve('/cwd', 'sub/x.md'));
  });

  it('treats Windows-style separators as relative paths (not bare filenames)', () => {
    // Even on POSIX, a value containing `\\` should be treated as having a
    // separator so we do not mis-resolve a Windows-style relative path
    // against capabilitiesDir.
    expect(resolveSystemPromptPath('sub\\x.md', '/caps', '/cwd')).toBe(path.resolve('/cwd', 'sub\\x.md'));
  });
});
