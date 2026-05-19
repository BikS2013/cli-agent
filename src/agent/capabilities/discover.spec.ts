/**
 * discoverTool — doc-exists shortcut tests.
 *
 * Locks in the optimization that skips every probe (which, --version,
 * --help, LLM call) when a capability document already exists for the
 * tool and the user has not forced a refresh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discoverTool } from './discover.js';
import * as invalidate from './invalidate.js';

vi.mock('./invalidate.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./invalidate.js')>();
  return {
    ...actual,
    getBinaryInfo: vi.fn(actual.getBinaryInfo),
  };
});

// Keep tests hermetic: never spawn the real `man -w` against the test
// host. The detector returns the no-man state by default; tests that
// want to assert manRef-emission set their own mock per-test.
vi.mock('./manref.js', () => ({
  detectManRef: vi.fn().mockResolvedValue({ manRef: null, manPagePath: null }),
}));

function makeCfg(capabilitiesDir: string, overrides: Record<string, unknown> = {}) {
  return {
    capabilitiesDir,
    compositesDir: path.join(capabilitiesDir, '..', 'composites'),
    capabilities: {
      depth: 2,
      maxBytesPerTool: 10240,
      timeoutMs: 5000,
      totalTimeoutMs: 60000,
      skipLlmBelowBytes: 4096,
      ...overrides,
    },
    // Other fields are unused on the cache-hit path
  } as unknown as Parameters<typeof discoverTool>[1];
}

const FAKE_LOGGER = {
  currentSessionId: 'sess-test',
  log: vi.fn(),
  close: vi.fn().mockResolvedValue(undefined),
} as unknown as Parameters<typeof discoverTool>[3];

const FAKE_MODEL = {} as unknown as Parameters<typeof discoverTool>[2];

describe('discoverTool — doc-exists shortcut', () => {
  beforeEach(() => {
    vi.mocked(invalidate.getBinaryInfo).mockClear();
  });

  it('returns "cached" without probing the binary when the .md exists', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));
    const cachedDoc = [
      '---',
      'tool: git',
      'binaryPath: /usr/bin/git',
      'binaryMtimeMs: 1000000',
      'versionString: "git version 2.45.0"',
      'versionHash: sha256:abc123',
      'introspectedAt: 2026-04-26T00:00:00Z',
      'introspectionDepth: 2',
      'introspectionBytes: 100',
      'schemaVersion: 2',
      '---',
      '',
      '<!-- AUTO-GENERATED:START hash=h -->',
      '# git',
      '<!-- AUTO-GENERATED:END -->',
      '',
      '<!-- USER-NOTES:START -->',
      '<!-- USER-NOTES:END -->',
    ].join('\n');
    await fsp.writeFile(path.join(tmpDir, 'git.md'), cachedDoc, 'utf8');

    const result = await discoverTool(
      'git',
      makeCfg(tmpDir),
      FAKE_MODEL,
      FAKE_LOGGER,
      false, // forceRefresh
      Date.now() + 60000,
    );

    expect(result.status).toBe('cached');
    expect(result.bytes).toBe(cachedDoc.length);
    expect(invalidate.getBinaryInfo).not.toHaveBeenCalled();
  });

  it('still probes the binary when forceRefresh=true even if the .md exists', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));
    await fsp.writeFile(
      path.join(tmpDir, 'nonexistent-binary-xyz.md'),
      '---\ntool: x\nschemaVersion: 2\n---\nbody',
      'utf8',
    );

    // forceRefresh=true → must call getBinaryInfo (which will return null
    // for a binary that doesn't exist on PATH and we'll get not-found).
    const result = await discoverTool(
      'nonexistent-binary-xyz',
      makeCfg(tmpDir),
      FAKE_MODEL,
      FAKE_LOGGER,
      true, // forceRefresh
      Date.now() + 60000,
    );

    expect(invalidate.getBinaryInfo).toHaveBeenCalledOnce();
    expect(result.status).toBe('not-found');
  });

  it('falls through to probe + discover when the .md is absent', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));
    // No file written → cache miss → must probe.
    await discoverTool(
      'nonexistent-binary-abc',
      makeCfg(tmpDir),
      FAKE_MODEL,
      FAKE_LOGGER,
      false,
      Date.now() + 60000,
    );
    expect(invalidate.getBinaryInfo).toHaveBeenCalledOnce();
  });

  it('emits start + cache_hit phase events on the cache-hit path', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));
    await fsp.writeFile(
      path.join(tmpDir, 'git.md'),
      [
        '---', 'tool: git', 'binaryPath: /usr/bin/git',
        'binaryMtimeMs: 1', 'versionString: ""', 'versionHash: x',
        'introspectedAt: 2026-04-26T00:00:00Z',
        'introspectionDepth: 2', 'introspectionBytes: 100',
        'schemaVersion: 2', '---', '', 'body',
      ].join('\n'),
      'utf8',
    );
    const events: Array<{ kind: string; tool?: string }> = [];
    await discoverTool(
      'git',
      makeCfg(tmpDir),
      FAKE_MODEL,
      FAKE_LOGGER,
      false,
      Date.now() + 60000,
      (e) => events.push({ kind: e.kind, tool: 'tool' in e ? e.tool : undefined }),
    );
    expect(events.map((e) => e.kind)).toEqual(['start', 'cache_hit']);
    expect(events[0]?.tool).toBe('git');
  });

  it('emits not_found phase event when binary missing', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));
    const events: string[] = [];
    await discoverTool(
      'definitely-not-a-real-binary-xyz',
      makeCfg(tmpDir),
      FAKE_MODEL,
      FAKE_LOGGER,
      false,
      Date.now() + 60000,
      (e) => events.push(e.kind),
    );
    expect(events).toContain('start');
    expect(events).toContain('not_found');
  });

  // --- skipLlmBelowBytes optimization (small-tool fast path) ---

  it('skipLlmBelowBytes=4096 (default): a short --help skips the LLM call', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));

    // Mock runHelp to return a tiny help text (2 KiB), and assert that
    // extractSubcommands is NEVER called.
    const runHelpMod = await import('./runHelp.js');
    const extractMod = await import('./extractSubcommands.js');
    const runHelpSpy = vi.spyOn(runHelpMod, 'runHelp').mockResolvedValue({
      text: 'short help text — only flags here, no subcommands\n'.repeat(20),
      truncated: false,
    } as unknown as Awaited<ReturnType<typeof runHelpMod.runHelp>>);
    const extractSpy = vi.spyOn(extractMod, 'extractSubcommands').mockResolvedValue([]);

    // getBinaryInfo returns a real-looking object so we proceed past the probe.
    vi.mocked(invalidate.getBinaryInfo).mockResolvedValueOnce({
      resolvedPath: '/fake/bin/zip',
      mtimeMs: 1000000,
      versionString: 'zip 3.0',
      versionHash: 'sha256:fake',
    });

    const events: string[] = [];
    await discoverTool(
      'zip',
      makeCfg(tmpDir),
      FAKE_MODEL,
      FAKE_LOGGER,
      true, // forceRefresh — bypass doc-exists shortcut
      Date.now() + 60000,
      (e) => events.push(e.kind),
    );

    expect(runHelpSpy).toHaveBeenCalled();          // --help still read
    expect(extractSpy).not.toHaveBeenCalled();      // ← optimization fires
    expect(events).toContain('extract_skipped');
    expect(events).not.toContain('extract_start');
    expect(events).not.toContain('extract_end');

    runHelpSpy.mockRestore();
    extractSpy.mockRestore();
  });

  it('forceFullInvestigation=true: bypasses skipLlmBelowBytes even for tiny --help', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));

    // Same setup as the "default skip" test (tiny help, threshold=4096),
    // but pass forceFullInvestigation=true to assert the LLM still runs.
    const runHelpMod = await import('./runHelp.js');
    const extractMod = await import('./extractSubcommands.js');
    const runHelpSpy = vi.spyOn(runHelpMod, 'runHelp').mockResolvedValue({
      text: 'short help text — only flags here, no subcommands\n'.repeat(20),
      truncated: false,
    } as unknown as Awaited<ReturnType<typeof runHelpMod.runHelp>>);
    const extractSpy = vi.spyOn(extractMod, 'extractSubcommands').mockResolvedValue([]);

    vi.mocked(invalidate.getBinaryInfo).mockResolvedValueOnce({
      resolvedPath: '/fake/bin/zip',
      mtimeMs: 1000000,
      versionString: 'zip 3.0',
      versionHash: 'sha256:fake',
    });

    const events: string[] = [];
    await discoverTool(
      'zip',
      makeCfg(tmpDir),                  // default skipLlmBelowBytes=4096
      FAKE_MODEL,
      FAKE_LOGGER,
      true,                             // forceRefresh
      Date.now() + 60000,
      (e) => events.push(e.kind),
      true,                             // forceFullInvestigation ← under test
    );

    expect(extractSpy).toHaveBeenCalled();
    expect(events).toContain('extract_start');
    expect(events).toContain('extract_end');
    expect(events).not.toContain('extract_skipped');

    runHelpSpy.mockRestore();
    extractSpy.mockRestore();
  });

  it('emits manRef into the cached doc when detectManRef returns a hit', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));

    const runHelpMod = await import('./runHelp.js');
    const extractMod = await import('./extractSubcommands.js');
    const manrefMod = await import('./manref.js');
    const runHelpSpy = vi.spyOn(runHelpMod, 'runHelp').mockResolvedValue({
      text: 'usage: git ...',
      truncated: false,
    } as unknown as Awaited<ReturnType<typeof runHelpMod.runHelp>>);
    vi.spyOn(extractMod, 'extractSubcommands').mockResolvedValue([]);
    vi.mocked(manrefMod.detectManRef).mockResolvedValueOnce({
      manRef: 'man:1 git',
      manPagePath: '/usr/share/man/man1/git.1.gz',
    });

    vi.mocked(invalidate.getBinaryInfo).mockResolvedValueOnce({
      resolvedPath: '/usr/bin/git',
      mtimeMs: 1,
      versionString: 'git 2.45',
      versionHash: 'sha256:fake',
    });

    await discoverTool(
      'git',
      makeCfg(tmpDir, { skipLlmBelowBytes: 0 }),
      FAKE_MODEL,
      FAKE_LOGGER,
      true,
      Date.now() + 60000,
    );

    const written = await fsp.readFile(path.join(tmpDir, 'git.md'), 'utf8');
    expect(written).toContain('manRef: man:1 git');
    expect(written).toContain('## Manual reference');
    expect(written).toContain('<!-- USER-RECIPES:START -->');
    runHelpSpy.mockRestore();
  });

  it('skipLlmBelowBytes=0: even a tiny --help runs the LLM call', async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));

    const runHelpMod = await import('./runHelp.js');
    const extractMod = await import('./extractSubcommands.js');
    const runHelpSpy = vi.spyOn(runHelpMod, 'runHelp').mockResolvedValue({
      text: 'tiny',
      truncated: false,
    } as unknown as Awaited<ReturnType<typeof runHelpMod.runHelp>>);
    const extractSpy = vi.spyOn(extractMod, 'extractSubcommands').mockResolvedValue([]);

    vi.mocked(invalidate.getBinaryInfo).mockResolvedValueOnce({
      resolvedPath: '/fake/bin/zip',
      mtimeMs: 1,
      versionString: 'zip 3.0',
      versionHash: 'sha256:fake',
    });

    const events: string[] = [];
    await discoverTool(
      'zip',
      makeCfg(tmpDir, { skipLlmBelowBytes: 0 }),
      FAKE_MODEL,
      FAKE_LOGGER,
      true,
      Date.now() + 60000,
      (e) => events.push(e.kind),
    );

    expect(extractSpy).toHaveBeenCalled();
    expect(events).toContain('extract_start');
    expect(events).toContain('extract_end');
    expect(events).not.toContain('extract_skipped');

    runHelpSpy.mockRestore();
    extractSpy.mockRestore();
  });
});

describe('discoverTool — preserves user-curated sections', () => {
  beforeEach(() => {
    vi.mocked(invalidate.getBinaryInfo).mockClear();
  });

  it('preserves USER-NOTES when re-introspecting a schema-1 doc (forceRefresh)', async () => {
    // A pre-existing schema-1 doc is a cache miss for `readCacheEntry`,
    // so the previous code path passed `existing?.fullContent =
    // undefined` to the composer and silently dropped the user's notes.
    // The raw-file preservation path must keep them.
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));
    const v1Doc = [
      '---',
      'tool: git',
      'binaryPath: /usr/bin/git',
      'binaryMtimeMs: 1',
      'versionString: ""',
      'versionHash: x',
      'introspectedAt: 2026-04-26T00:00:00Z',
      'introspectionDepth: 2',
      'introspectionBytes: 10',
      'schemaVersion: 1',
      '---',
      '',
      '<!-- AUTO-GENERATED:START hash=h -->',
      '# git',
      '<!-- AUTO-GENERATED:END -->',
      '',
      '<!-- USER-NOTES:START -->',
      '- IMPORTANT: We use git switch not git checkout',
      '- All pushes require --force-with-lease',
      '<!-- USER-NOTES:END -->',
    ].join('\n');
    await fsp.writeFile(path.join(tmpDir, 'git.md'), v1Doc, 'utf8');

    const runHelpMod = await import('./runHelp.js');
    const extractMod = await import('./extractSubcommands.js');
    const runHelpSpy = vi.spyOn(runHelpMod, 'runHelp').mockResolvedValue({
      text: 'usage: git ...',
      truncated: false,
    } as unknown as Awaited<ReturnType<typeof runHelpMod.runHelp>>);
    vi.spyOn(extractMod, 'extractSubcommands').mockResolvedValue([]);

    vi.mocked(invalidate.getBinaryInfo).mockResolvedValueOnce({
      resolvedPath: '/usr/bin/git',
      mtimeMs: 1,
      versionString: 'git 2.45',
      versionHash: 'sha256:fake',
    });

    await discoverTool(
      'git',
      makeCfg(tmpDir, { skipLlmBelowBytes: 0 }),
      FAKE_MODEL,
      FAKE_LOGGER,
      true, // forceRefresh
      Date.now() + 60000,
    );

    const written = await fsp.readFile(path.join(tmpDir, 'git.md'), 'utf8');
    expect(written).toContain('IMPORTANT: We use git switch not git checkout');
    expect(written).toContain('All pushes require --force-with-lease');
    runHelpSpy.mockRestore();
  });

  it('preserves USER-NOTES + USER-RECIPES when binary becomes not-found', async () => {
    // Originally, the binary-not-found placeholder write blew away any
    // existing user content. A user who carefully curated notes/recipes
    // for `git` should NOT lose them just because PATH is misconfigured
    // for one invocation. The placeholder must keep them verbatim.
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));
    const existingDoc = [
      '---',
      'tool: git',
      'binaryPath: /usr/bin/git',
      'binaryMtimeMs: 1',
      'versionString: "git 2.45"',
      'versionHash: sha256:abc',
      'introspectedAt: 2026-04-26T00:00:00Z',
      'introspectionDepth: 2',
      'introspectionBytes: 100',
      'schemaVersion: 2',
      '---',
      '',
      '<!-- AUTO-GENERATED:START hash=h -->',
      '# git',
      '<!-- AUTO-GENERATED:END -->',
      '',
      '<!-- USER-RECIPES:START -->',
      '### Commit staged changes',
      '```bash',
      'git commit -m "<message>"',
      '```',
      '<!-- USER-RECIPES:END -->',
      '',
      '<!-- USER-NOTES:START -->',
      '- IMPORTANT: never push --force without --force-with-lease',
      '<!-- USER-NOTES:END -->',
    ].join('\n');
    await fsp.writeFile(path.join(tmpDir, 'git.md'), existingDoc, 'utf8');

    // Binary not found on PATH.
    vi.mocked(invalidate.getBinaryInfo).mockResolvedValueOnce(null);

    const result = await discoverTool(
      'git',
      makeCfg(tmpDir),
      FAKE_MODEL,
      FAKE_LOGGER,
      true, // forceRefresh — bypass doc-exists shortcut to reach probe
      Date.now() + 60000,
    );

    expect(result.status).toBe('not-found');
    const written = await fsp.readFile(path.join(tmpDir, 'git.md'), 'utf8');
    // Auto-gen block must be the not-found placeholder.
    expect(written).toContain('BINARY NOT FOUND');
    // ...but the user-curated sections must be preserved verbatim.
    expect(written).toContain('### Commit staged changes');
    expect(written).toContain('git commit -m "<message>"');
    expect(written).toContain('IMPORTANT: never push --force without --force-with-lease');
    // The placeholder must include the USER-RECIPES markers (the old
    // version omitted them entirely, which broke `extract-recipes` on
    // any tool that had ever been not-found).
    expect(written).toContain('<!-- USER-RECIPES:START -->');
    expect(written).toContain('<!-- USER-RECIPES:END -->');
    // Schema must NOT downgrade to 1.
    expect(written).toContain('schemaVersion: 2');
  });

  it('binary-not-found on a fresh capability dir still emits both marker pairs', async () => {
    // Even when there is no pre-existing doc to preserve from, the
    // placeholder must still seed both USER-RECIPES and USER-NOTES
    // markers so subsequent `extract-recipes` calls work without a
    // "missing markers" error.
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cap-'));
    vi.mocked(invalidate.getBinaryInfo).mockResolvedValueOnce(null);

    await discoverTool(
      'nonexistent-tool-xyz',
      makeCfg(tmpDir),
      FAKE_MODEL,
      FAKE_LOGGER,
      true,
      Date.now() + 60000,
    );

    const written = await fsp.readFile(
      path.join(tmpDir, 'nonexistent-tool-xyz.md'),
      'utf8',
    );
    expect(written).toContain('<!-- USER-RECIPES:START -->');
    expect(written).toContain('<!-- USER-RECIPES:END -->');
    expect(written).toContain('<!-- USER-NOTES:START -->');
    expect(written).toContain('<!-- USER-NOTES:END -->');
    expect(written).toContain('schemaVersion: 2');
  });
});

describe('discoverTool — virtual-composite shortcut (plan-006 patch)', () => {
  beforeEach(() => {
    vi.mocked(invalidate.getBinaryInfo).mockClear();
  });

  it('returns "cached" without probing the binary when a virtual-composite manifest + mirror exist', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-vc-'));
    const capabilitiesDir = path.join(tmpRoot, 'capabilities');
    const compositesDir = path.join(tmpRoot, 'composites');
    await fsp.mkdir(capabilitiesDir, { recursive: true });
    await fsp.mkdir(path.join(compositesDir, 'email-assistant'), { recursive: true });

    const schema3Mirror = [
      '---',
      'schemaVersion: 3',
      'composite: true',
      'compositeName: email-assistant',
      '---',
      '',
      '# email-assistant',
      'body bytes',
    ].join('\n');
    await fsp.writeFile(path.join(capabilitiesDir, 'email-assistant.md'), schema3Mirror, 'utf8');
    await fsp.writeFile(
      path.join(compositesDir, 'email-assistant', 'manifest.json'),
      JSON.stringify({ schemaVersion: 1, compositeName: 'email-assistant' }),
      'utf8',
    );

    const cfg = {
      capabilitiesDir,
      compositesDir,
      capabilities: { depth: 2, maxBytesPerTool: 10240, timeoutMs: 5000, totalTimeoutMs: 60000, skipLlmBelowBytes: 4096 },
    } as unknown as Parameters<typeof discoverTool>[1];

    const events: string[] = [];
    const result = await discoverTool(
      'email-assistant',
      cfg,
      FAKE_MODEL,
      FAKE_LOGGER,
      false,
      Date.now() + 60000,
      (e) => events.push(e.kind),
    );

    expect(result.status).toBe('cached');
    expect(result.bytes).toBe(schema3Mirror.length);
    expect(invalidate.getBinaryInfo).not.toHaveBeenCalled();
    expect(events).toEqual(['start', 'cache_hit']);
  });

  it('falls through to binary probe when manifest exists but mirror is missing', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-vc-'));
    const capabilitiesDir = path.join(tmpRoot, 'capabilities');
    const compositesDir = path.join(tmpRoot, 'composites');
    await fsp.mkdir(capabilitiesDir, { recursive: true });
    await fsp.mkdir(path.join(compositesDir, 'orphan'), { recursive: true });
    await fsp.writeFile(
      path.join(compositesDir, 'orphan', 'manifest.json'),
      JSON.stringify({ schemaVersion: 1 }),
      'utf8',
    );

    const cfg = {
      capabilitiesDir,
      compositesDir,
      capabilities: { depth: 2, maxBytesPerTool: 10240, timeoutMs: 5000, totalTimeoutMs: 60000, skipLlmBelowBytes: 4096 },
    } as unknown as Parameters<typeof discoverTool>[1];

    const result = await discoverTool('orphan', cfg, FAKE_MODEL, FAKE_LOGGER, false, Date.now() + 60000);

    expect(invalidate.getBinaryInfo).toHaveBeenCalledOnce();
    expect(result.status).toBe('not-found');
  });

  it('forceRefresh=true bypasses the virtual-composite shortcut', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-vc-'));
    const capabilitiesDir = path.join(tmpRoot, 'capabilities');
    const compositesDir = path.join(tmpRoot, 'composites');
    await fsp.mkdir(capabilitiesDir, { recursive: true });
    await fsp.mkdir(path.join(compositesDir, 'forced'), { recursive: true });
    await fsp.writeFile(path.join(capabilitiesDir, 'forced.md'), '---\nschemaVersion: 3\ncomposite: true\n---\nbody', 'utf8');
    await fsp.writeFile(path.join(compositesDir, 'forced', 'manifest.json'), '{}', 'utf8');

    const cfg = {
      capabilitiesDir,
      compositesDir,
      capabilities: { depth: 2, maxBytesPerTool: 10240, timeoutMs: 5000, totalTimeoutMs: 60000, skipLlmBelowBytes: 4096 },
    } as unknown as Parameters<typeof discoverTool>[1];

    await discoverTool('forced', cfg, FAKE_MODEL, FAKE_LOGGER, true, Date.now() + 60000);

    expect(invalidate.getBinaryInfo).toHaveBeenCalledOnce();
  });
});
