/**
 * Tests for `profile-show` (U-CLI).
 *
 * Coverage:
 *   - happy path: section-headed output.
 *   - missing profile: UsageError exit 2.
 *   - --json: emits structured object.
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

let captured: { stdout: string[]; stderr: string[] };
let origStdout: typeof process.stdout.write;
let origStderr: typeof process.stderr.write;

beforeEach(async () => {
  const fsp = await import('node:fs/promises');
  TMP_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-show-'));
  captured = { stdout: [], stderr: [] };
  origStdout = process.stdout.write.bind(process.stdout);
  origStderr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (
    s: string,
  ) => { captured.stdout.push(s); return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (
    s: string,
  ) => { captured.stderr.push(s); return true; };
});

afterEach(async () => {
  (process.stdout as unknown as { write: typeof origStdout }).write = origStdout;
  (process.stderr as unknown as { write: typeof origStderr }).write = origStderr;
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

describe('profile-show', () => {
  it('prints section-headed output for a populated profile', async () => {
    await placeProfile(
      'review',
      [
        'name: review',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: openai',
        '  temperature: 0.7',
        'tools:',
        '  allow:',
        '    - bash_run',
        '',
      ].join('\n'),
    );
    const { runProfileShow } = await import('./show.js');
    await runProfileShow('review');
    const out = captured.stdout.join('');
    expect(out).toMatch(/Profile/);
    expect(out).toMatch(/name:\s+review/);
    expect(out).toMatch(/digest:\s+[0-9a-f]{16}/);
    expect(out).toMatch(/cliParams/);
    expect(out).toMatch(/provider: openai/);
    expect(out).toMatch(/tools/);
    expect(out).toMatch(/allow: \[bash_run\]/);
  });

  it('--json emits structured object with digest + cliParams', async () => {
    await placeProfile(
      'demo',
      'name: demo\nschemaVersion: 1\ncliParams:\n  model: gpt-4o\n',
    );
    const { runProfileShow } = await import('./show.js');
    await runProfileShow('demo', { json: true });
    const parsed = JSON.parse(captured.stdout.join('')) as {
      name: string;
      digest: string;
      cliParams: { model?: string };
    };
    expect(parsed.name).toBe('demo');
    expect(parsed.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(parsed.cliParams.model).toBe('gpt-4o');
  });

  it('missing profile -> UsageError exit 2', async () => {
    const { runProfileShow } = await import('./show.js');
    await expect(runProfileShow('missing')).rejects.toMatchObject({
      code: 'E_USAGE',
      exitCode: 2,
    });
  });
});
