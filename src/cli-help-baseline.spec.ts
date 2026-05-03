/**
 * NFR-CMP-001 byte-stability regression test (plan-006 P4).
 *
 * The captured baseline `test_scripts/baselines/help-no-treat-as-tool.txt`
 * represents the canonical `cli-agent --help` output at the moment
 * Commander v12's auto `-h, --help` was migrated to a manual flag.
 * Any future change that drifts the help byte stream — including
 * adding/removing/reordering flags or subcommands — is caught here so
 * the maintainer must consciously re-record the baseline.
 *
 * The test spawns `node dist/cli.js --help` rather than re-importing
 * `src/cli.ts` because Commander's help formatting is computed at the
 * point of `outputHelp()` from the live registration state — running
 * the compiled binary is the closest analogue to what users see.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve repo root from this spec file's location. `src/` is one level
// deep, so two `..` hops land on the project root.
const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const cliPath = path.join(repoRoot, 'dist', 'cli.js');
const baselinePath = path.join(
  repoRoot,
  'test_scripts',
  'baselines',
  'help-no-treat-as-tool.txt',
);
const subBaselinePath = path.join(
  repoRoot,
  'test_scripts',
  'baselines',
  'help-show-capabilities.txt',
);

describe('NFR-CMP-001: cli-agent --help byte stability', () => {
  it('matches the captured baseline byte-for-byte', () => {
    if (!fs.existsSync(cliPath)) {
      // Build artefact missing — flag the precondition explicitly so
      // a maintainer running a single test file doesn't get a confused
      // "help text differs" message instead.
      throw new Error(
        `dist/cli.js not found at ${cliPath}; run \`npm run build\` before this test.`,
      );
    }
    const baseline = fs.readFileSync(baselinePath, 'utf8');
    const proc = spawnSync('node', [cliPath, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toBe(baseline);
  });

  it('show-capabilities --help matches the captured subcommand baseline', () => {
    if (!fs.existsSync(cliPath)) {
      throw new Error(`dist/cli.js not found at ${cliPath}; run \`npm run build\` first.`);
    }
    const baseline = fs.readFileSync(subBaselinePath, 'utf8');
    const proc = spawnSync('node', [cliPath, 'show-capabilities', '--help'], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    expect(proc.status).toBe(0);
    expect(proc.stdout).toBe(baseline);
  });
});
