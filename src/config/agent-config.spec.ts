/**
 * Unit tests for agent-config.ts
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  loadAgentConfig,
  SUPPORTED_PROVIDERS,
  AGENT_TOOL_NAME,
  resolveSystemPromptPath,
  SYSTEM_PROMPT_FILENAME,
  agentCapabilitiesDir,
  agentCompositeCapabilitiesDir,
  agentCompositeDistillDir,
  agentCompositesDir,
  agentDotEnvPath,
  agentToolAgentsDir,
  bootstrapAgentDir,
} from './agent-config.js';
import {
  BUILTIN_DEFAULT_SYSTEM_PROMPT,
  LEGACY_DEFAULT_SYSTEM_PROMPTS,
} from '../agent/system-prompt.js';

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
  // Plan-005: profile integration tests can register concrete file
  // contents here so loadProfile can read them. Bytes-keyed map; presence
  // also flips access() / accessSync() to "exists".
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
    // loadOverlayRegistry calls readdir on <agentDir>/tool-prompts/. Without
    // this mock, readdir falls through to the host filesystem — on a machine
    // that has used cli-agent, the dir has 17 real overlay files; readdir
    // returns them, then the mocked readFile rejects each with ENOENT and
    // loadOverlayRegistry throws. Returning [] keeps the test hermetic.
    readdir: vi.fn().mockImplementation(async (p: string) => {
      // Profile loader's listProfiles asks for <agentDir>/profiles/.
      // Synthesize the directory listing from `fileContents` so the
      // E1-diagnostic codepath works.
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
    // Test-only handle so individual tests can register profile bytes.
    __testHelpers: { fileContents, writtenPaths },
  };
});

// Profile codec uses fs.accessSync (sync) for ambiguity detection. Mock
// node:fs in lockstep with node:fs/promises so the same registered files
// appear present to both surfaces.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  // Re-import the promises mock to share its file map.
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

async function getTestFiles(): Promise<Map<string, Buffer>> {
  const mod = (await import('node:fs/promises')) as unknown as {
    __testHelpers: { fileContents: Map<string, Buffer> };
  };
  return mod.__testHelpers.fileContents;
}

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

  it('resolves web backend credentials and request budget from the layered agent .env snapshot', async () => {
    const files = await getTestFiles();
    const envPath = agentDotEnvPath();
    files.set(envPath, Buffer.from([
      'WEB_SEARCH_BACKEND=brave',
      'BRAVE_API_KEY=agent-env-brave-key',
      'TAVILY_API_KEY=agent-env-tavily-key',
      'SERPAPI_API_KEY=agent-env-serp-key',
      'WEB_SEARCH_URL=https://search.example/api',
      'WEB_SEARCH_API_KEY=agent-env-custom-key',
      'WEB_SEARCH_MAX_REQUESTS=7',
      '',
    ].join('\n'), 'utf8'));
    try {
      const cfg = await loadAgentConfig(
        { provider: 'openai' },
        { shellEnv: {}, cwd: '/tmp' },
      );
      expect(cfg.webSearch).toMatchObject({
        backend: 'brave',
        braveApiKey: 'agent-env-brave-key',
        tavilyApiKey: 'agent-env-tavily-key',
        serpApiKey: 'agent-env-serp-key',
        customHttpUrl: 'https://search.example/api',
        customHttpApiKey: 'agent-env-custom-key',
        maxRequests: 7,
      });
    } finally {
      files.delete(envPath);
    }
  });

  it('rejects an invalid WEB_SEARCH_MAX_REQUESTS value instead of silently weakening budget enforcement', async () => {
    const files = await getTestFiles();
    const envPath = agentDotEnvPath();
    files.set(envPath, Buffer.from('WEB_SEARCH_MAX_REQUESTS=not-a-number\n', 'utf8'));
    try {
      await expect(
        loadAgentConfig({ provider: 'openai' }, { shellEnv: {}, cwd: '/tmp' }),
      ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING' });
    } finally {
      files.delete(envPath);
    }
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
// Composite tool paths + bootstrap (plan-006 P3)
// ---------------------------------------------------------------------------

describe('composite path helpers (plan-006 P3)', () => {
  it('agentCompositeCapabilitiesDir → <agentDir>/capabilities/composite', () => {
    expect(agentCompositeCapabilitiesDir()).toBe(
      path.join(os.homedir(), '.tool-agents', AGENT_TOOL_NAME, 'capabilities', 'composite'),
    );
  });

  it('agentCompositeDistillDir → <agentDir>/capabilities/composite/_distill', () => {
    expect(agentCompositeDistillDir()).toBe(
      path.join(os.homedir(), '.tool-agents', AGENT_TOOL_NAME, 'capabilities', 'composite', '_distill'),
    );
  });

  it('agentCompositesDir → <agentDir>/composites', () => {
    expect(agentCompositesDir()).toBe(
      path.join(os.homedir(), '.tool-agents', AGENT_TOOL_NAME, 'composites'),
    );
  });

  it('bootstrapAgentDir creates the three composite directories at mode 0o700', async () => {
    const fsp = await import('node:fs/promises');
    const mkdir = fsp.mkdir as unknown as ReturnType<typeof vi.fn>;
    mkdir.mockClear();
    const chmod = fsp.chmod as unknown as ReturnType<typeof vi.fn>;
    chmod.mockClear();

    const agentDir = agentToolAgentsDir();
    await bootstrapAgentDir(agentDir);

    const compositeCapabilities = path.join(agentDir, 'capabilities', 'composite');
    const compositeDistill = path.join(agentDir, 'capabilities', 'composite', '_distill');
    const compositesRoot = path.join(agentDir, 'composites');

    const mkdirCalls = mkdir.mock.calls.map((c) => String(c[0]));
    expect(mkdirCalls).toContain(compositeCapabilities);
    expect(mkdirCalls).toContain(compositeDistill);
    expect(mkdirCalls).toContain(compositesRoot);

    // Each call carries the 0o700 mode flag (asserted on the second arg).
    for (const targetDir of [compositeCapabilities, compositeDistill, compositesRoot]) {
      const call = mkdir.mock.calls.find((c) => String(c[0]) === targetDir);
      expect(call).toBeDefined();
      expect(call![1]).toMatchObject({ recursive: true, mode: 0o700 });
    }
  });

  it('loadAgentConfig populates compositeCapabilitiesDir / compositeDistillDir / compositesDir', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.compositeCapabilitiesDir).toBe(
      path.join(agentCapabilitiesDir(), 'composite'),
    );
    expect(cfg.compositeDistillDir).toBe(
      path.join(agentCapabilitiesDir(), 'composite', '_distill'),
    );
    expect(cfg.compositesDir).toBe(agentCompositesDir());
  });
});

// ---------------------------------------------------------------------------
// bootstrapAgentDir — in-place system-prompt.md migration (plan-009)
//
// When system-prompt.md already exists, bootstrap upgrades it ONLY if its
// bytes byte-exactly equal a prior default (an entry in
// LEGACY_DEFAULT_SYSTEM_PROMPTS) — overwriting with the new slim
// BUILTIN_DEFAULT_SYSTEM_PROMPT. A user-modified or already-slim file is
// left byte-unchanged. This is NOT a runtime fallback.
//
// Harness: the system-prompt.md bytes are registered via getTestFiles()
// (the shared fileContents map the fs/promises mock reads through). The
// migration's writeFile call is observed on the writeFile mock's call list.
// ---------------------------------------------------------------------------

describe('bootstrapAgentDir — system-prompt.md migration (plan-009)', () => {
  const agentDir = agentToolAgentsDir();
  const systemPromptPath = path.join(agentDir, 'capabilities', SYSTEM_PROMPT_FILENAME);

  beforeEach(async () => {
    const files = await getTestFiles();
    files.delete(systemPromptPath);
    const fsp = await import('node:fs/promises');
    (fsp.writeFile as unknown as ReturnType<typeof vi.fn>).mockClear();
    (fsp.readFile as unknown as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(async () => {
    const files = await getTestFiles();
    files.delete(systemPromptPath);
  });

  /** All writeFile calls whose first arg is the system-prompt.md path. */
  async function systemPromptWrites(): Promise<Array<[string, string, unknown]>> {
    const fsp = await import('node:fs/promises');
    const writeFile = fsp.writeFile as unknown as ReturnType<typeof vi.fn>;
    return writeFile.mock.calls
      .filter((c) => String(c[0]) === systemPromptPath)
      .map((c) => [String(c[0]), String(c[1]), c[2]] as [string, string, unknown]);
  }

  it('upgrades an unmodified legacy default (bytes === LEGACY_DEFAULT_SYSTEM_PROMPTS[0]) to the slim default', async () => {
    const legacy = LEGACY_DEFAULT_SYSTEM_PROMPTS[0];
    if (legacy === undefined) throw new Error('LEGACY_DEFAULT_SYSTEM_PROMPTS[0] must exist');
    const files = await getTestFiles();
    files.set(systemPromptPath, Buffer.from(legacy, 'utf8'));

    await bootstrapAgentDir(agentDir);

    const writes = await systemPromptWrites();
    // Exactly one write to system-prompt.md: the migration overwrite.
    expect(writes.length).toBe(1);
    const write = writes[0];
    if (write === undefined) throw new Error('expected a migration write');
    expect(write[1]).toBe(BUILTIN_DEFAULT_SYSTEM_PROMPT);
    // Overwrite carries mode 0o600 (NOT flag:'wx' — that is the seed path).
    expect(write[2]).toMatchObject({ mode: 0o600 });
  });

  it('leaves a user-modified system-prompt.md byte-unchanged (no overwrite)', async () => {
    const userText = 'You are MY custom cli-agent. Do exactly what I say.\n';
    const files = await getTestFiles();
    files.set(systemPromptPath, Buffer.from(userText, 'utf8'));

    await bootstrapAgentDir(agentDir);

    const writes = await systemPromptWrites();
    expect(writes.length).toBe(0);
    // The registered bytes are still the user's text.
    expect(files.get(systemPromptPath)!.toString('utf8')).toBe(userText);
  });

  it('leaves an already-slim default system-prompt.md unchanged (no re-write)', async () => {
    const files = await getTestFiles();
    files.set(systemPromptPath, Buffer.from(BUILTIN_DEFAULT_SYSTEM_PROMPT, 'utf8'));

    await bootstrapAgentDir(agentDir);

    const writes = await systemPromptWrites();
    expect(writes.length).toBe(0);
    expect(files.get(systemPromptPath)!.toString('utf8')).toBe(BUILTIN_DEFAULT_SYSTEM_PROMPT);
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
        // plan-011: first-party web wrappers default ON (read-only).
        webSearch: true,
        webFetch: true,
        // plan-012: first-party file wrappers default ON (read/list read-only,
        // write/edit/append mutation-gated downstream in group-builder).
        fileRead: true,
        fileList: true,
        fileWrite: true,
        fileEdit: true,
        fileAppend: true,
      },
    });
  });
});

describe('loadAgentConfig — agentTools env vars', () => {
  // plan-015: the CLI_AGENT_DISABLE_AGENT_TOOLS umbrella env var was
  // hard-removed — any set value is rejected with a migration hint. The
  // full legacy-surface rejection matrix lives in agent-config-mode.spec.ts;
  // this file keeps the per-tool CLI_AGENT_AGT_* tier, which is unchanged.
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

  it('CLI_AGENT_AGT_WEB_SEARCH=0 disables the default-on web-search tool (plan-011)', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_AGT_WEB_SEARCH: '0' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.webSearch).toBe(false);
  });

  it('CLI_AGENT_AGT_WEB_FETCH=off disables the default-on web-fetch tool (plan-011)', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_AGT_WEB_FETCH: 'off' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.webFetch).toBe(false);
  });

  // plan-012: the five first-party file wrappers default ON and each is
  // governed by its own CLI_AGENT_AGT_FILE_* env key (same tri-state parsing).
  it.each([
    ['CLI_AGENT_AGT_FILE_READ', 'fileRead'],
    ['CLI_AGENT_AGT_FILE_LIST', 'fileList'],
    ['CLI_AGENT_AGT_FILE_WRITE', 'fileWrite'],
    ['CLI_AGENT_AGT_FILE_EDIT', 'fileEdit'],
    ['CLI_AGENT_AGT_FILE_APPEND', 'fileAppend'],
  ] as const)('%s=0 disables the default-on %s tool (plan-012)', async (envKey, key) => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { [envKey]: '0' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools[key]).toBe(false);
  });

  it('CLI_AGENT_AGT_FILE_WRITE=1 keeps the default-on file-write flag set (plan-012)', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_AGT_FILE_WRITE: '1' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.fileWrite).toBe(true);
  });

  it('throws ConfigurationError when an agent-tools env var is set but unparseable', async () => {
    await expect(
      loadAgentConfig(
        { provider: 'openai' },
        { shellEnv: { CLI_AGENT_AGT_GREP: 'maybe' }, cwd: '/tmp' },
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
  // plan-015: the umbrella has no CLI/env/config surface anymore — the
  // pack's presence comes from the mode knob (see agent-config-mode.spec.ts).
  // The per-tool chain below is unchanged (FR-TOOLFLAG-3).
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

  it('web per-tool: CLI flag wins over env var (plan-011)', async () => {
    // CLI says webSearch=true; env says webSearch=false. CLI must win.
    const cfg = await loadAgentConfig(
      { provider: 'openai', agentTools: { tools: { webSearch: true } } },
      { shellEnv: { CLI_AGENT_AGT_WEB_SEARCH: '0' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.webSearch).toBe(true);
  });

  it('web per-tool: env wins over the default-on starting value (plan-011)', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_AGT_WEB_FETCH: 'false' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.webFetch).toBe(false);
  });

  // plan-012 / AC10 / OQ-3: the five CLI_AGENT_AGT_FILE_* keys participate in
  // the precedence chain (CLI flag > env > config.json > default). The first
  // arg to loadAgentConfig is the CLI tier; shellEnv is the env tier.
  it('file per-tool: CLI flag wins over env var (plan-012)', async () => {
    // CLI says fileWrite=true; env says fileWrite=false. CLI must win.
    const cfg = await loadAgentConfig(
      { provider: 'openai', agentTools: { tools: { fileWrite: true } } },
      { shellEnv: { CLI_AGENT_AGT_FILE_WRITE: '0' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.fileWrite).toBe(true);
  });

  it('file per-tool: CLI flag (false) wins over env var (true) (plan-012)', async () => {
    // CLI says fileRead=false; env says fileRead=true. CLI must win.
    const cfg = await loadAgentConfig(
      { provider: 'openai', agentTools: { tools: { fileRead: false } } },
      { shellEnv: { CLI_AGENT_AGT_FILE_READ: '1' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.fileRead).toBe(false);
  });

  it('file per-tool: env wins over the default-on starting value (plan-012)', async () => {
    // No CLI tier set; env disables the otherwise default-on tool.
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_AGT_FILE_APPEND: 'false' }, cwd: '/tmp' },
    );
    expect(cfg.agentTools.tools.fileAppend).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mapAgentToolFlags (the CLI-tier gatekeeper for the generic
// --enable-tool/--disable-tool pair, plan-015) is tested in its dedicated
// spec file `src/cli-agent-tools-flags.spec.ts`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Configuration profiles (plan-005) — tier-5 integration tests.
// ---------------------------------------------------------------------------

const AGENT_DIR_FOR_TESTS = path.join(os.homedir(), '.tool-agents', AGENT_TOOL_NAME);

async function placeProfileFile(filename: string, body: string): Promise<string> {
  const abs = path.join(AGENT_DIR_FOR_TESTS, 'profiles', filename);
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

describe('loadAgentConfig — profile activation (plan-005)', () => {
  beforeEach(async () => {
    await clearProfiles();
  });

  it('AC-21 invariant: no profile activation when neither flag nor env set', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.activeProfile).toBeUndefined();
    expect(cfg.activeProfileData).toBeUndefined();
  });

  it('AC-2: --profile <name> activates and threads cliParams.temperature into tier 5', async () => {
    await placeProfileFile(
      'review.yaml',
      [
        'name: review',
        'schemaVersion: 1',
        'cliParams:',
        '  temperature: 0.42',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'review' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.activeProfile?.name).toBe('review');
    expect(cfg.activeProfile?.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(cfg.temperature).toBe(0.42);
  });

  it('AC-3: CLI_AGENT_PROFILE env var activates the same way as --profile', async () => {
    await placeProfileFile(
      'envprof.yaml',
      [
        'name: envprof',
        'schemaVersion: 1',
        'cliParams:',
        '  temperature: 0.21',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_PROFILE: 'envprof' }, cwd: '/tmp' },
    );
    expect(cfg.activeProfile?.name).toBe('envprof');
    expect(cfg.temperature).toBe(0.21);
  });

  it('AC-4: explicit CLI flag wins over profile cliParams (temperature)', async () => {
    await placeProfileFile(
      'p.yaml',
      [
        'name: p',
        'schemaVersion: 1',
        'cliParams:',
        '  temperature: 0.7',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'p', temperature: 0.05 },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.temperature).toBe(0.05);
  });

  it('AC-4: explicit CLI flag wins over profile (provider)', async () => {
    await placeProfileFile(
      'p.yaml',
      [
        'name: p',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: anthropic',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'p' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.provider).toBe('openai');
  });

  it('AC-5: shell env beats profile cliParams.provider (AGENT_PROVIDER wins)', async () => {
    await placeProfileFile(
      'p.yaml',
      [
        'name: p',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: anthropic',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { profile: 'p' },
      { shellEnv: { AGENT_PROVIDER: 'gemini' }, cwd: '/tmp' },
    );
    expect(cfg.provider).toBe('gemini');
  });

  it('AC-6: profile beats config.json — provider falls through layered to profile', async () => {
    // No layered['AGENT_PROVIDER'], no flag — only the profile sets the
    // value; this confirms tier-5 is consulted before configFile would have
    // been (no config.json present in this hermetic test).
    await placeProfileFile(
      'p.yaml',
      [
        'name: p',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: anthropic',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { profile: 'p' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.provider).toBe('anthropic');
  });

  it('E12: --profile beats CLI_AGENT_PROFILE when both are set', async () => {
    await placeProfileFile(
      'cli-wins.yaml',
      [
        'name: cli-wins',
        'schemaVersion: 1',
        'cliParams:',
        '  temperature: 0.11',
        '',
      ].join('\n'),
    );
    await placeProfileFile(
      'env-loses.yaml',
      [
        'name: env-loses',
        'schemaVersion: 1',
        'cliParams:',
        '  temperature: 0.99',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'cli-wins' },
      { shellEnv: { CLI_AGENT_PROFILE: 'env-loses' }, cwd: '/tmp' },
    );
    expect(cfg.activeProfile?.name).toBe('cli-wins');
    expect(cfg.temperature).toBe(0.11);
  });

  it('E19: profile sets allowMutations: true with no flag → profile applies', async () => {
    await placeProfileFile(
      'mut.yaml',
      [
        'name: mut',
        'schemaVersion: 1',
        'cliParams:',
        '  allowMutations: true',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'mut' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.allowMutations).toBe(true);
  });

  it('AC-2 (model): profile cliParams.model threads into tier 5', async () => {
    await placeProfileFile(
      'mp.yaml',
      [
        'name: mp',
        'schemaVersion: 1',
        'cliParams:',
        '  model: gpt-5-pro',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'mp' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.model).toBe('gpt-5-pro');
  });

  it('webSearchBackend: profile cliParams threads into tier 5', async () => {
    await placeProfileFile(
      'wsb.yaml',
      [
        'name: wsb',
        'schemaVersion: 1',
        'cliParams:',
        '  webSearchBackend: brave',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'wsb' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.webSearchBackend).toBe('brave');
  });

  it('maxIterations (maxSteps) profile cliParams threads into tier 5', async () => {
    await placeProfileFile(
      'mi.yaml',
      [
        'name: mi',
        'schemaVersion: 1',
        'cliParams:',
        '  maxIterations: 7',
        '',
      ].join('\n'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'mi' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.maxSteps).toBe(7);
  });

  it('E1: --profile <missing> raises UsageError exit 2', async () => {
    await expect(
      loadAgentConfig(
        { provider: 'openai', profile: 'definitely-missing' },
        { shellEnv: {}, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });

  it('activeProfile carries name + path + digest + schemaVersion', async () => {
    const abs = await placeProfileFile('rich.yaml', 'name: rich\nschemaVersion: 1\n');
    const cfg = await loadAgentConfig(
      { provider: 'openai', profile: 'rich' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.activeProfile?.name).toBe('rich');
    expect(cfg.activeProfile?.path).toBe(abs);
    expect(cfg.activeProfile?.schemaVersion).toBe(1);
    expect(cfg.activeProfile?.digest).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ---------------------------------------------------------------------------
// Tool-loading group toggles (plan-008) — composites + builtinTools.
// Uniform precedence: CLI flag > env(CLI_AGENT_DISABLE_*) > config.json >
// profile(tools.*) > default(load=true). Also covers the new agentTools
// profile tier added to resolveAgentTools.
// ---------------------------------------------------------------------------

async function placeConfigJson(body: Record<string, unknown>): Promise<void> {
  const abs = path.join(AGENT_DIR_FOR_TESTS, 'config.json');
  const files = await getTestFiles();
  files.set(abs, Buffer.from(JSON.stringify(body), 'utf8'));
}

async function clearConfigJson(): Promise<void> {
  const files = await getTestFiles();
  for (const k of [...files.keys()]) {
    if (k.endsWith('config.json')) files.delete(k);
  }
}

describe('loadAgentConfig — mode default expansion (plan-015)', () => {
  beforeEach(async () => {
    await clearProfiles();
    await clearConfigJson();
  });

  it('flagless invocation defaults to composite: all three groups on', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.composites).toBe(true);
    expect(cfg.builtinTools).toBe(true);
    expect(cfg.agentTools.enabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The plan-008 per-group toggle chains (composites / builtinTools /
// agentTools umbrella across CLI/env/config/profile) were hard-removed by
// plan-015. The mode knob's five-tier resolution, the mode→groups mapping,
// the --tool × mode conflict, and the legacy-surface rejection matrix are
// covered in `src/config/agent-config-mode.spec.ts`.
// ---------------------------------------------------------------------------
