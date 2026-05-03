/**
 * Tests for `composite-delete <name>` (plan-006 P6 / U-CMD).
 *
 * Coverage:
 *   - non-TTY without --yes → ConfigurationError (exit 3).
 *   - --yes deletes the canonical doc + mirror + shim + manifest.
 *   - already-absent composite → UsageError (no artifacts to delete).
 *   - invalid composite-name regex → UsageError.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

let TMP_HOME: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = (): string => TMP_HOME;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

beforeEach(async () => {
  TMP_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-comp-del-'));
});
afterEach(async () => {
  await fsp.rm(TMP_HOME, { recursive: true, force: true });
});

async function placeCompositeArtifacts(name: string): Promise<{
  docPath: string;
  mirrorPath: string;
  shimPath: string;
  manifestPath: string;
}> {
  const agentDir = path.join(TMP_HOME, '.tool-agents', 'cli-agent');
  const compositeCapsDir = path.join(agentDir, 'capabilities', 'composite');
  const capsDir = path.join(agentDir, 'capabilities');
  const composFolderRoot = path.join(agentDir, 'composites', name);
  await fsp.mkdir(compositeCapsDir, { recursive: true });
  await fsp.mkdir(capsDir, { recursive: true });
  await fsp.mkdir(composFolderRoot, { recursive: true });

  const { composeCompositeDoc } = await import('../../agent/composite/composeCompositeDoc.js');
  const doc = composeCompositeDoc({
    frontmatter: {
      schemaVersion: 3,
      composite: true,
      compositeName: name,
      members: ['m1'],
      memberDigests: { m1: 'd'.repeat(16) },
      synthesizedAt: '2024-05-01T00:00:00Z',
      syntheticDigest: 'placeholder',
      cliAgentVersion: '0.3.0',
      synthesisModel: 'test:stub',
      activeProfile: null,
      manRef: null,
      manPagePath: null,
    },
    autoGenBody: 'doc body',
  });
  const docPath = path.join(compositeCapsDir, `${name}.md`);
  const mirrorPath = path.join(capsDir, `${name}.md`);
  const shimPath = path.join(composFolderRoot, name);
  const manifestPath = path.join(composFolderRoot, 'manifest.json');
  await fsp.writeFile(docPath, doc, { mode: 0o600 });
  await fsp.writeFile(mirrorPath, doc, { mode: 0o600 });
  await fsp.writeFile(shimPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await fsp.writeFile(manifestPath, '{}\n', { mode: 0o600 });
  return { docPath, mirrorPath, shimPath, manifestPath };
}

describe('composite-delete', () => {
  it('refuses without --yes in non-TTY environments', async () => {
    await placeCompositeArtifacts('demo');
    const { runCompositeDelete } = await import('./delete.js');
    await expect(
      runCompositeDelete(
        'demo',
        {},
        { isInteractive: () => false },
      ),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING', exitCode: 3 });
  });

  it('deletes all artifacts with --yes', async () => {
    const a = await placeCompositeArtifacts('demo');
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s) => {
      writes.push(s);
      return true;
    };
    try {
      const { runCompositeDelete } = await import('./delete.js');
      await runCompositeDelete('demo', { yes: true });
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }

    await expect(fsp.stat(a.docPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(a.mirrorPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(a.shimPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(a.manifestPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(writes.join('')).toMatch(/Deleted composite 'demo'/);
  });

  it('UsageError when nothing to delete', async () => {
    const { runCompositeDelete } = await import('./delete.js');
    await expect(
      runCompositeDelete('nope', { yes: true }),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });

  it('rejects invalid composite-name regex', async () => {
    const { runCompositeDelete } = await import('./delete.js');
    await expect(
      runCompositeDelete('Bad-Name', { yes: true }),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });
});
