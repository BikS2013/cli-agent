/**
 * Unit tests for agent-config.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
    // loadOverlayRegistry calls readdir on <agentDir>/tool-prompts/. Without
    // this mock, readdir falls through to the host filesystem — on a machine
    // that has used cli-agent, the dir has 17 real overlay files; readdir
    // returns them, then the mocked readFile rejects each with ENOENT and
    // loadOverlayRegistry throws. Returning [] keeps the test hermetic.
    readdir: vi.fn().mockResolvedValue([]),
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

// ---------------------------------------------------------------------------
// Agent-tools pack — config surface (U4)
// ---------------------------------------------------------------------------

describe('loadAgentConfig — agentTools defaults', () => {
  it('applies starting-value defaults when nothing is configured', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.agentTools).toEqual({
      enabled: true,
      tools: {
        glob: true,
        grep: true,
        multiedit: true,
        patch: true,
        todoRead: false,
        todoWrite: false,
      },
    });
  });
});

describe('loadAgentConfig — agentTools env vars', () => {
  it('CLI_AGENT_DISABLE_AGENT_TOOLS=1 disables the umbrella', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_DISABLE_AGENT_TOOLS: '1' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.enabled).toBe(false);
  });

  it('CLI_AGENT_DISABLE_AGENT_TOOLS=0 keeps the umbrella on (default true)', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_DISABLE_AGENT_TOOLS: '0' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.enabled).toBe(true);
  });

  it.each([
    ['true', true], ['1', true], ['yes', true], ['on', true], ['TRUE', true],
    ['false', false], ['0', false], ['no', false], ['off', false], ['FALSE', false],
  ])('CLI_AGENT_AGT_GLOB=%s parses as %s', async (raw, expected) => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_AGT_GLOB: raw }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.glob).toBe(expected);
  });

  it('CLI_AGENT_AGT_TODO_READ=1 enables the default-off todo-read tool', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_AGT_TODO_READ: '1' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.todoRead).toBe(true);
  });

  it('throws ConfigurationError when an agent-tools env var is set but unparseable', async () => {
    await expect(
      loadAgentConfig(
        { provider: 'openai' },
        { shellEnv: { CLI_AGENT_AGT_GREP: 'maybe' }, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING' });
  });

  it('throws ConfigurationError when CLI_AGENT_DISABLE_AGENT_TOOLS is unparseable', async () => {
    await expect(
      loadAgentConfig(
        { provider: 'openai' },
        { shellEnv: { CLI_AGENT_DISABLE_AGENT_TOOLS: 'maybe' }, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING' });
  });

  it('treats empty-string env var as unset (defers to default)', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_AGT_PATCH: '' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.patch).toBe(true);
  });
});

describe('loadAgentConfig — agentTools precedence (CLI > env > default)', () => {
  it('umbrella: CLI flag wins over env var', async () => {
    // CLI says enabled=false; env says umbrella should be on (DISABLE=0)
    const cfg = await loadAgentConfig(
      { provider: 'openai', agentTools: { enabled: false } },
      { shellEnv: { CLI_AGENT_DISABLE_AGENT_TOOLS: '0' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.enabled).toBe(false);
  });

  it('umbrella: env wins over default when CLI is silent', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_DISABLE_AGENT_TOOLS: '1' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.enabled).toBe(false);
  });

  it('per-tool: CLI flag wins over env var', async () => {
    // CLI says glob=true; env says glob=false. CLI must win.
    const cfg = await loadAgentConfig(
      { provider: 'openai', agentTools: { tools: { glob: true } } },
      { shellEnv: { CLI_AGENT_AGT_GLOB: '0' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.glob).toBe(true);
  });

  it('per-tool: env var wins over default when CLI is silent', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_AGT_TODO_WRITE: '1' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.todoWrite).toBe(true);
  });

  it('per-tool: default wins when nothing else is set', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.multiedit).toBe(true);
    expect(cfg.agentTools.tools.todoRead).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapAgentToolFlags is the CLI-tier gatekeeper for agent-tools flags. It lives
// in its own module (`src/cli-agent-tools-flags.ts`) — separate from cli.ts —
// precisely so tests can import it WITHOUT triggering cli.ts's module-level
// Commander parse side-effect. See the JSDoc on mapAgentToolFlags for the
// conflict-detection contract.
// ---------------------------------------------------------------------------
import { mapAgentToolFlags } from '../cli-agent-tools-flags.js';

describe('mapAgentToolFlags — CLI conflict detection', () => {
  let originalArgv: string[];

  beforeEach(() => {
    originalArgv = process.argv;
  });

  afterEach(() => {
    process.argv = originalArgv;
  });

  it('returns undefined when no agent-tools flags are present', () => {
    process.argv = ['node', 'cli.js'];
    expect(mapAgentToolFlags({})).toBeUndefined();
  });

  it('returns { enabled: false } when --no-agent-tools is parsed', () => {
    process.argv = ['node', 'cli.js', '--no-agent-tools'];
    // Commander would parse `--no-agent-tools` to `agentTools: false`.
    const out = mapAgentToolFlags({ agentTools: false });
    expect(out).toEqual({ enabled: false });
  });

  it('throws UsageError when both --agent-tools and --no-agent-tools are passed', () => {
    process.argv = ['node', 'cli.js', '--agent-tools', '--no-agent-tools'];
    // Commander records the LAST one (false), but mapAgentToolFlags must
    // still detect the umbrella conflict from argv and throw.
    expect(() => mapAgentToolFlags({ agentTools: false })).toThrow(/cannot be used together/);
  });

  it('throws UsageError when --enable-agt-grep and --disable-agt-grep are both passed', () => {
    process.argv = ['node', 'cli.js', '--enable-agt-grep', '--disable-agt-grep'];
    expect(() =>
      mapAgentToolFlags({ enableAgtGrep: true, disableAgtGrep: true }),
    ).toThrow(/--enable-agt-grep and --disable-agt-grep cannot be used together/);
  });

  it('extracts per-tool enable/disable into the partial shape', () => {
    process.argv = ['node', 'cli.js', '--enable-agt-todo-read', '--disable-agt-grep'];
    const out = mapAgentToolFlags({ enableAgtTodoRead: true, disableAgtGrep: true });
    expect(out).toEqual({ tools: { todoRead: true, grep: false } });
  });

  it('UsageError carries E_USAGE code (exit 2)', () => {
    process.argv = ['node', 'cli.js', '--enable-agt-glob', '--disable-agt-glob'];
    try {
      mapAgentToolFlags({ enableAgtGlob: true, disableAgtGlob: true });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_USAGE');
      expect((e as { exitCode?: number }).exitCode).toBe(2);
    }
  });
});
