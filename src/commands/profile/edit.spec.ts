/**
 * Tests for `profile-edit` (U-CLI).
 *
 * Coverage:
 *   - happy path: spawns editor, validates, returns clean.
 *   - missing profile -> UsageError exit 2.
 *   - post-edit validation failure surfaces ConfigurationError exit 3.
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
  TMP_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-edit-'));
});

afterEach(async () => {
  const fsp = await import('node:fs/promises');
  await fsp.rm(TMP_HOME, { recursive: true, force: true });
});

async function placeProfile(name: string, contents: string): Promise<string> {
  const fsp = await import('node:fs/promises');
  const dir = path.join(TMP_HOME, '.tool-agents', 'cli-agent', 'profiles');
  await fsp.mkdir(dir, { recursive: true });
  const p = path.join(dir, `${name}.yaml`);
  await fsp.writeFile(p, contents, { mode: 0o600 });
  return p;
}

describe('profile-edit', () => {
  it('happy path: spawns editor and re-validates cleanly', async () => {
    await placeProfile('demo', 'name: demo\nschemaVersion: 1\n');
    const { runProfileEdit } = await import('./edit.js');
    const spawn = vi.fn().mockReturnValue({ status: 0, error: undefined });
    await runProfileEdit('demo', {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      spawn: spawn as any,
      resolveEditor: () => 'true',
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn.mock.calls[0]![0]).toBe('true');
  });

  it('rejects when profile does not exist', async () => {
    const { runProfileEdit } = await import('./edit.js');
    await expect(
      runProfileEdit('missing', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        spawn: vi.fn() as any,
        resolveEditor: () => 'true',
      }),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });

  it('post-edit validation failure surfaces ConfigurationError', async () => {
    // Place a malformed file. The "editor" stub does nothing — file is
    // left malformed and re-validation fails.
    await placeProfile('broken', '{ this is not yaml: [');
    const { runProfileEdit } = await import('./edit.js');
    await expect(
      runProfileEdit('broken', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        spawn: vi.fn().mockReturnValue({ status: 0 }) as any,
        resolveEditor: () => 'true',
      }),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING', exitCode: 3 });
  });
});
