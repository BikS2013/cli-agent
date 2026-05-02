/**
 * Tests for `profile-delete` (U-CLI).
 *
 * Coverage:
 *   - happy path with --yes: file removed, exit 0.
 *   - non-TTY without --yes -> ConfigurationError exit 3.
 *   - missing profile -> UsageError exit 2.
 *   - TTY confirm declined -> file remains.
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
  TMP_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-del-'));
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

describe('profile-delete', () => {
  it('--yes removes the file', async () => {
    const filePath = await placeProfile('demo', 'name: demo\n');
    const { runProfileDelete } = await import('./delete.js');
    await runProfileDelete('demo', { yes: true });
    const fsp = await import('node:fs/promises');
    await expect(fsp.access(filePath)).rejects.toThrow();
  });

  it('non-TTY without --yes throws ConfigurationError', async () => {
    await placeProfile('demo', 'name: demo\n');
    const { runProfileDelete } = await import('./delete.js');
    await expect(
      runProfileDelete('demo', {}, { isInteractive: () => false }),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING', exitCode: 3 });
  });

  it('missing profile -> UsageError', async () => {
    const { runProfileDelete } = await import('./delete.js');
    await expect(
      runProfileDelete('missing', { yes: true }),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });

  it('interactive decline preserves the file', async () => {
    const filePath = await placeProfile('demo', 'name: demo\n');
    const { runProfileDelete } = await import('./delete.js');
    await runProfileDelete(
      'demo',
      {},
      {
        isInteractive: () => true,
        confirm: async () => false,
      },
    );
    const fsp = await import('node:fs/promises');
    await expect(fsp.access(filePath)).resolves.toBeUndefined();
  });

  it('interactive accept removes the file', async () => {
    const filePath = await placeProfile('demo', 'name: demo\n');
    const { runProfileDelete } = await import('./delete.js');
    await runProfileDelete(
      'demo',
      {},
      {
        isInteractive: () => true,
        confirm: async () => true,
      },
    );
    const fsp = await import('node:fs/promises');
    await expect(fsp.access(filePath)).rejects.toThrow();
  });
});
