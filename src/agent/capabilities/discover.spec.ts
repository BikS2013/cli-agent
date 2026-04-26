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

function makeCfg(capabilitiesDir: string, overrides: Record<string, unknown> = {}) {
  return {
    capabilitiesDir,
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
      'schemaVersion: 1',
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
      '---\ntool: x\nschemaVersion: 1\n---\nbody',
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
        'schemaVersion: 1', '---', '', 'body',
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
