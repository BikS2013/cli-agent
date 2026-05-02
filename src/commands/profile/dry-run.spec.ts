/**
 * Tests for `profile-dry-run` (U-CLI).
 *
 * The dry-run handler ALSO calls `loadAgentConfig` to derive the tool
 * catalog. That code path needs `provider`+`model` resolved, which in
 * turn needs API-key env vars on certain providers. To keep the spec
 * hermetic we set a minimal env (provider=ollama → no key needed) and
 * a stubbed homedir.
 *
 * Coverage:
 *   - profile-less dry-run: trace lists every knob with built-in/env source.
 *   - --profile dry-run: profile cliParams show up in the trace.
 *   - --json: structured output.
 *   - missing profile -> UsageError exit 2.
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
let origEnv: NodeJS.ProcessEnv;

beforeEach(async () => {
  const fsp = await import('node:fs/promises');
  TMP_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-dry-'));
  captured = { stdout: [], stderr: [] };
  origStdout = process.stdout.write.bind(process.stdout);
  origStderr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (s: string) => boolean }).write = (
    s: string,
  ) => { captured.stdout.push(s); return true; };
  (process.stderr as unknown as { write: (s: string) => boolean }).write = (
    s: string,
  ) => { captured.stderr.push(s); return true; };

  // Minimal env that lets agent-config resolve.
  origEnv = { ...process.env };
  delete process.env['CLI_AGENT_PROFILE'];
  process.env['AGENT_PROVIDER'] = 'ollama';
  process.env['AGENT_MODEL'] = 'llama3';
});

afterEach(async () => {
  (process.stdout as unknown as { write: typeof origStdout }).write = origStdout;
  (process.stderr as unknown as { write: typeof origStderr }).write = origStderr;
  // Restore env.
  for (const k of Object.keys(process.env)) {
    if (!(k in origEnv)) delete process.env[k];
  }
  for (const [k, v] of Object.entries(origEnv)) {
    if (v !== undefined) process.env[k] = v;
  }
  const fsp = await import('node:fs/promises');
  await fsp.rm(TMP_HOME, { recursive: true, force: true });
});

async function placeProfile(name: string, contents: string): Promise<void> {
  const fsp = await import('node:fs/promises');
  const dir = path.join(TMP_HOME, '.tool-agents', 'cli-agent', 'profiles');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${name}.yaml`), contents, { mode: 0o600 });
}

describe('profile-dry-run', () => {
  it('prints trace + catalog for no-profile invocation', async () => {
    const { runProfileDryRun } = await import('./dry-run.js');
    await runProfileDryRun();
    const out = captured.stdout.join('');
    expect(out).toMatch(/Active profile: <none>/);
    expect(out).toMatch(/Resolved configuration/);
    expect(out).toMatch(/KNOB/);
    expect(out).toMatch(/SOURCE/);
    expect(out).toMatch(/provider/);
    // env:AGENT_PROVIDER should be the source for provider.
    expect(out).toMatch(/provider\s+ollama\s+env:AGENT_PROVIDER/);
  });

  it('--profile attributes cliParams to profile:<name>', async () => {
    await placeProfile(
      'review',
      [
        'name: review',
        'schemaVersion: 1',
        'cliParams:',
        '  temperature: 0.42',
        '',
      ].join('\n'),
    );
    const { runProfileDryRun } = await import('./dry-run.js');
    await runProfileDryRun({ profile: 'review' });
    const out = captured.stdout.join('');
    expect(out).toMatch(/Active profile: review/);
    expect(out).toMatch(/temperature\s+0\.42\s+profile:review/);
  });

  it('--json emits structured payload with knobs + catalog', async () => {
    await placeProfile(
      'demo',
      'name: demo\nschemaVersion: 1\ncliParams:\n  temperature: 0.1\n',
    );
    const { runProfileDryRun } = await import('./dry-run.js');
    await runProfileDryRun({ profile: 'demo', json: true });
    const parsed = JSON.parse(captured.stdout.join('')) as {
      profile: { name: string; digest: string };
      knobs: Array<{ knob: string; value: unknown; source: string }>;
      catalog: string[];
    };
    expect(parsed.profile.name).toBe('demo');
    expect(parsed.profile.digest).toMatch(/^[0-9a-f]{16}$/);
    const tempEntry = parsed.knobs.find((k) => k.knob === 'temperature');
    expect(tempEntry).toBeDefined();
    expect(tempEntry!.value).toBe(0.1);
    expect(tempEntry!.source).toBe('profile:demo');
    // The catalog should be a string[] (built from the registry).
    expect(Array.isArray(parsed.catalog)).toBe(true);
  });

  it('missing profile -> UsageError exit 2', async () => {
    const { runProfileDryRun } = await import('./dry-run.js');
    await expect(
      runProfileDryRun({ profile: 'does-not-exist' }),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });
});
