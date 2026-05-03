/**
 * Tests for `composite-synthesize` (plan-006 P6 / U-CMD).
 *
 * Coverage scope (constrained by the parallel-units status):
 *   - empty `--tool` list → UsageError.
 *   - missing member capability doc → ConfigurationError (exit 3).
 *   - dispatcher routing through `runComposite` (mode discriminant).
 *
 * The synthesizer pipeline (U-SYNTH) and manifest writer (U-VIRTUAL)
 * are owned by other parallel coders and may not be present at the
 * moment U-CMD lands. We exercise the handler's input-validation
 * surface — anything that actually requires the synthesizer is
 * deferred to the integration suite (`test_scripts/...`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
  TMP_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-comp-synth-'));
});
afterEach(async () => {
  await fsp.rm(TMP_HOME, { recursive: true, force: true });
});

describe('handleSynthesize — input validation', () => {
  it('throws UsageError for an empty tools list', async () => {
    const { handleSynthesize } = await import('./synthesize.js');
    await expect(
      handleSynthesize({
        mode: 'synthesize-cmd',
        tools: [],
        rawOpts: { treatAsTool: true },
      }),
    ).rejects.toMatchObject({ code: 'E_USAGE', exitCode: 2 });
  });

  it('reports a clear ConfigurationError when a member capability doc is missing', async () => {
    const { handleSynthesize } = await import('./synthesize.js');
    // `loadAgentConfig` runs but no member doc exists at
    // `<capabilitiesDir>/missing-cli.md`.
    await expect(
      handleSynthesize({
        mode: 'synthesize-cmd',
        tools: ['missing-cli'],
        rawOpts: { treatAsTool: true },
      }),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING', exitCode: 3 });
  });
});

describe('runComposite dispatcher', () => {
  it('rejects unknown modes', async () => {
    const { runComposite } = await import('../../agent/composite/run-composite.js');
    await expect(
      runComposite({ mode: 'bogus' as 'help-synthesis' }),
    ).rejects.toThrow(/unknown composite mode/);
  });
});
