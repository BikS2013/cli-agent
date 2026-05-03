/**
 * Tests for `composite-list` (plan-006 P6 / U-CMD).
 *
 * Coverage:
 *   - happy path: enumerates composite docs in the table format.
 *   - empty: prints "no composites found" notice on stderr.
 *   - --json: emits JSON array of composites.
 *
 * The handler resolves the agent dir via `loadAgentConfig` →
 * `agentToolAgentsDir` → `os.homedir()`. We mock `node:os` so the
 * test's hermetic temp dir is the resolved home, mirroring
 * `src/commands/profile/list.spec.ts`.
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
  TMP_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-comp-list-'));
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

async function placeCompositeDoc(name: string, members: string[]): Promise<void> {
  const dir = path.join(TMP_HOME, '.tool-agents', 'cli-agent', 'capabilities', 'composite');
  await fsp.mkdir(dir, { recursive: true });
  const { composeCompositeDoc } = await import('../../agent/composite/composeCompositeDoc.js');
  const memberDigests: Record<string, string> = {};
  for (const m of members) memberDigests[m] = 'd'.repeat(16);
  const doc = composeCompositeDoc({
    frontmatter: {
      schemaVersion: 3,
      composite: true,
      compositeName: name,
      members,
      memberDigests,
      synthesizedAt: '2024-05-01T00:00:00Z',
      syntheticDigest: 'will-be-recomputed',
      cliAgentVersion: '0.3.0',
      synthesisModel: 'test:stub',
      activeProfile: null,
      manRef: null,
      manPagePath: null,
    },
    autoGenBody: `Body for ${name}.`,
  });
  await fsp.writeFile(path.join(dir, `${name}.md`), doc, { mode: 0o600 });
}

describe('composite-list — short-circuit: no LLM config required', () => {
  /**
   * AC-21 / plan-006 gap 8: `composite-list` must NOT call `loadAgentConfig`
   * because it is a read-only filesystem walk. This verifies the "read-only
   * short-circuit" documented in the U-CMD report.
   *
   * The spy on `loadAgentConfig` ensures the import was not invoked —
   * a key safety property so users can list composites without a configured
   * LLM provider.
   */
  it('does NOT call loadAgentConfig (read-only short-circuit)', async () => {
    // Use the compositeCapabilitiesDirOverride seam so the handler
    // never needs to resolve the home directory / agent config.
    const overrideDir = path.join(TMP_HOME, 'capabilities', 'composite');
    await fsp.mkdir(overrideDir, { recursive: true });

    // Spy on agent-config to ensure it's never called.
    const agentConfigMod = await import('../../config/agent-config.js');
    const loadAgentConfigSpy = vi.spyOn(agentConfigMod, 'loadAgentConfig');

    const { runCompositeList } = await import('./list.js');
    await runCompositeList({ compositeCapabilitiesDirOverride: overrideDir });

    // loadAgentConfig must NEVER have been called.
    expect(loadAgentConfigSpy).not.toHaveBeenCalled();

    loadAgentConfigSpy.mockRestore();
  });

  it('does NOT throw when no LLM provider env vars are set', async () => {
    const overrideDir = path.join(TMP_HOME, 'capabilities-no-llm');
    await fsp.mkdir(overrideDir, { recursive: true });

    // Unset all provider-related env vars to simulate an unconfigured machine.
    const savedAnthropicKey = process.env['ANTHROPIC_API_KEY'];
    const savedOpenaiKey = process.env['OPENAI_API_KEY'];
    delete process.env['ANTHROPIC_API_KEY'];
    delete process.env['OPENAI_API_KEY'];

    try {
      const { runCompositeList } = await import('./list.js');
      // Must complete without throwing ConfigurationError.
      await expect(
        runCompositeList({ compositeCapabilitiesDirOverride: overrideDir }),
      ).resolves.toBeUndefined();
    } finally {
      if (savedAnthropicKey !== undefined) process.env['ANTHROPIC_API_KEY'] = savedAnthropicKey;
      if (savedOpenaiKey !== undefined) process.env['OPENAI_API_KEY'] = savedOpenaiKey;
    }
  });
});

describe('composite-list', () => {
  it('prints aligned table when composites exist', async () => {
    await placeCompositeDoc('demo', ['a', 'b']);
    await placeCompositeDoc('alpha', ['x']);
    const { runCompositeList } = await import('./list.js');
    await runCompositeList();
    const out = captured.stdout.join('');
    expect(out).toMatch(/NAME/);
    expect(out).toMatch(/MEMBERS/);
    expect(out).toMatch(/SYNTHESIZED_AT/);
    expect(out).toMatch(/DIGEST/);
    expect(out).toMatch(/alpha/);
    expect(out).toMatch(/demo/);
    // Sort order: alpha before demo.
    const idxAlpha = out.indexOf('alpha');
    const idxDemo = out.indexOf('demo');
    expect(idxAlpha).toBeLessThan(idxDemo);
  });

  it('prints stderr notice when no composites', async () => {
    const { runCompositeList } = await import('./list.js');
    await runCompositeList();
    expect(captured.stderr.join('')).toMatch(/no composites found/);
    expect(captured.stdout.join('')).toBe('');
  });

  it('--json emits JSON array', async () => {
    await placeCompositeDoc('demo', ['a', 'b']);
    const { runCompositeList } = await import('./list.js');
    await runCompositeList({ json: true });
    const parsed = JSON.parse(captured.stdout.join('')) as Array<{
      name: string;
      members: string[];
    }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe('demo');
    expect(parsed[0]!.members).toEqual(['a', 'b']);
  });
});
