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

function makeCfg(capabilitiesDir: string) {
  return {
    capabilitiesDir,
    capabilities: {
      depth: 2,
      maxBytesPerTool: 10240,
      timeoutMs: 5000,
      totalTimeoutMs: 60000,
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
});
