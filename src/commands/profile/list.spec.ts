/**
 * Tests for `profile-list` (U-CLI).
 *
 * Coverage:
 *   - happy path: enumerates profiles in the table format.
 *   - empty: prints "no profiles found" notice on stderr.
 *   - --json: emits JSON array.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

// Hermetic agent dir under the OS temp folder so the test never touches
// the real ~/.tool-agents/cli-agent/.
let TMP_HOME: string;

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const homedir = () => TMP_HOME;
  return {
    ...actual,
    homedir,
    default: { ...actual, homedir },
  };
});

let captured: { stdout: string[]; stderr: string[] };
let origStdout: typeof process.stdout.write;
let origStderr: typeof process.stderr.write;

beforeEach(async () => {
  const fsp = await import('node:fs/promises');
  TMP_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-list-'));
  captured = { stdout: [], stderr: [] };
  origStdout = process.stdout.write.bind(process.stdout);
  origStderr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (
    s: string,
  ) => {
    captured.stdout.push(s);
    return true;
  };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (
    s: string,
  ) => {
    captured.stderr.push(s);
    return true;
  };
});

afterEach(async () => {
  (process.stdout as unknown as { write: typeof origStdout }).write = origStdout;
  (process.stderr as unknown as { write: typeof origStderr }).write = origStderr;
  const fsp = await import('node:fs/promises');
  await fsp.rm(TMP_HOME, { recursive: true, force: true });
});

async function placeProfile(name: string, contents: string): Promise<void> {
  const fsp = await import('node:fs/promises');
  const dir = path.join(TMP_HOME, '.tool-agents', 'cli-agent', 'profiles');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${name}.yaml`), contents, { mode: 0o600 });
}

describe('profile-list', () => {
  it('prints aligned table with two profiles', async () => {
    await placeProfile('alpha', 'name: alpha\ndescription: First\n');
    await placeProfile('beta', 'name: beta\ndescription: Second\n');
    const { runProfileList } = await import('./list.js');
    await runProfileList();
    const out = captured.stdout.join('');
    expect(out).toMatch(/NAME/);
    expect(out).toMatch(/DESCRIPTION/);
    expect(out).toMatch(/alpha/);
    expect(out).toMatch(/beta/);
    expect(out).toMatch(/First/);
  });

  it('prints stderr notice when no profiles', async () => {
    // Ensure dir exists but is empty.
    const fsp = await import('node:fs/promises');
    await fsp.mkdir(
      path.join(TMP_HOME, '.tool-agents', 'cli-agent', 'profiles'),
      { recursive: true },
    );
    const { runProfileList } = await import('./list.js');
    await runProfileList();
    expect(captured.stderr.join('')).toMatch(/no profiles found/);
    expect(captured.stdout.join('')).toBe('');
  });

  it('--json emits JSON array', async () => {
    await placeProfile('demo', 'name: demo\ndescription: Demo\n');
    const { runProfileList } = await import('./list.js');
    await runProfileList({ json: true });
    const parsed = JSON.parse(captured.stdout.join('')) as Array<{
      name: string;
      description?: string;
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe('demo');
    expect(parsed[0]!.description).toBe('Demo');
  });
});
