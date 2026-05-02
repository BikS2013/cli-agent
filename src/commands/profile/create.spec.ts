/**
 * Tests for `profile-create` (U-CLI).
 *
 * Coverage:
 *   - happy path: writes stub at mode 0600.
 *   - refuses to overwrite without --force.
 *   - --force allows overwrite.
 *   - illegal name -> UsageError exit 2.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

let TMP_HOME: string;
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => TMP_HOME;
  return { ...actual, homedir, default: { ...actual, homedir } };
});

beforeEach(async () => {
  const fsp = await import('node:fs/promises');
  TMP_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-create-'));
});

afterEach(async () => {
  const fsp = await import('node:fs/promises');
  await fsp.rm(TMP_HOME, { recursive: true, force: true });
});

describe('profile-create', () => {
  it('writes a YAML stub for a fresh name', async () => {
    const { runProfileCreate } = await import('./create.js');
    await runProfileCreate('demo');
    const fsp = await import('node:fs/promises');
    const filePath = path.join(
      TMP_HOME, '.tool-agents', 'cli-agent', 'profiles', 'demo.yaml',
    );
    const content = await fsp.readFile(filePath, 'utf8');
    expect(content).toMatch(/^# cli-agent profile: demo/);
    expect(content).toMatch(/name: demo/);
    expect(content).toMatch(/schemaVersion: 1/);
    // mode check (skipped on Windows where fs ignores mode)
    if (process.platform !== 'win32') {
      const stat = await fsp.stat(filePath);
      // eslint-disable-next-line no-bitwise
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it('refuses to overwrite without --force', async () => {
    const { runProfileCreate } = await import('./create.js');
    await runProfileCreate('demo');
    await expect(runProfileCreate('demo')).rejects.toMatchObject({
      code: 'E_CONFIG_MISSING',
    });
  });

  it('--force overwrites', async () => {
    const { runProfileCreate } = await import('./create.js');
    await runProfileCreate('demo', { description: 'first' });
    await runProfileCreate('demo', { description: 'second', force: true });
    const fsp = await import('node:fs/promises');
    const content = await fsp.readFile(
      path.join(TMP_HOME, '.tool-agents', 'cli-agent', 'profiles', 'demo.yaml'),
      'utf8',
    );
    expect(content).toMatch(/description: second/);
    expect(content).not.toMatch(/description: first/);
  });

  it('rejects illegal name with UsageError', async () => {
    const { runProfileCreate } = await import('./create.js');
    await expect(runProfileCreate('a/b')).rejects.toMatchObject({
      code: 'E_USAGE',
      exitCode: 2,
    });
  });

  it('writes description into the stub when provided', async () => {
    const { runProfileCreate } = await import('./create.js');
    await runProfileCreate('demo', { description: 'plan-005 smoke' });
    const fsp = await import('node:fs/promises');
    const content = await fsp.readFile(
      path.join(TMP_HOME, '.tool-agents', 'cli-agent', 'profiles', 'demo.yaml'),
      'utf8',
    );
    expect(content).toMatch(/description: plan-005 smoke/);
  });
});
