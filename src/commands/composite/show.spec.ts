/**
 * Tests for `composite-show <name>` (plan-006 P6 / U-CMD).
 *
 * Coverage:
 *   - happy path: prints raw markdown body.
 *   - --json: emits structured payload.
 *   - missing composite → UsageError (exit 2).
 *   - invalid composite-name regex → UsageError (exit 2).
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

let captured: { stdout: string[]; stderr: string[] };
let origStdout: typeof process.stdout.write;
let origStderr: typeof process.stderr.write;

beforeEach(async () => {
  TMP_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-comp-show-'));
  captured = { stdout: [], stderr: [] };
  origStdout = process.stdout.write.bind(process.stdout);
  origStderr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (s) => {
    captured.stdout.push(s);
    return true;
  };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (s) => {
    captured.stderr.push(s);
    return true;
  };
});

afterEach(async () => {
  (process.stdout as unknown as { write: typeof origStdout }).write = origStdout;
  (process.stderr as unknown as { write: typeof origStderr }).write = origStderr;
  await fsp.rm(TMP_HOME, { recursive: true, force: true });
});

async function placeCompositeDoc(name: string): Promise<void> {
  const dir = path.join(TMP_HOME, '.tool-agents', 'cli-agent', 'capabilities', 'composite');
  await fsp.mkdir(dir, { recursive: true });
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
    autoGenBody: `Body for ${name}.`,
    userRecipes: 'recipe-x',
    userNotes: '',
  });
  await fsp.writeFile(path.join(dir, `${name}.md`), doc, { mode: 0o600 });
}

describe('composite-show', () => {
  it('prints raw doc by default', async () => {
    await placeCompositeDoc('demo');
    const { runCompositeShow } = await import('./show.js');
    await runCompositeShow('demo');
    const out = captured.stdout.join('');
    expect(out).toMatch(/# demo — capability document/);
    expect(out).toMatch(/Body for demo/);
    expect(out).toMatch(/recipe-x/);
  });

  it('--json emits structured payload', async () => {
    await placeCompositeDoc('demo');
    const { runCompositeShow } = await import('./show.js');
    await runCompositeShow('demo', { json: true });
    const parsed = JSON.parse(captured.stdout.join('')) as {
      compositeName: string;
      body: string;
      recipes: string;
      frontmatter: { schemaVersion: number };
    };
    expect(parsed.compositeName).toBe('demo');
    expect(parsed.frontmatter.schemaVersion).toBe(3);
    expect(parsed.recipes).toBe('recipe-x');
  });

  it('throws UsageError when composite is missing', async () => {
    const { runCompositeShow } = await import('./show.js');
    await expect(runCompositeShow('nope')).rejects.toMatchObject({
      code: 'E_USAGE',
      exitCode: 2,
    });
  });

  it('rejects invalid composite-name regex', async () => {
    const { runCompositeShow } = await import('./show.js');
    await expect(runCompositeShow('Bad-Name')).rejects.toMatchObject({
      code: 'E_USAGE',
      exitCode: 2,
    });
  });
});
