/**
 * Cold-start smoke (plan-005 AC-22 / NFR-PROF-001).
 *
 * Measures the wall-clock cost of `cli-agent --help` with the config-profiles
 * feature compiled in but no profile active. Three iterations are run from a
 * cold node process each time; min/median/max are reported in milliseconds.
 *
 * Budget: ≤ 50 ms regression vs the pre-feature baseline. This smoke is
 * INFORMATIONAL only — it is NOT wired into CI and does not gate any check.
 * Run it manually after major refactors of the loader / scoping / merge
 * paths to catch unintended start-up cost regressions.
 *
 * Usage:
 *   npm run build
 *   npx tsx test_scripts/smoke-profile-cold-start.ts
 *   # or:
 *   node --loader tsx test_scripts/smoke-profile-cold-start.ts
 *
 * The script spawns `node dist/cli.js --help` as a fresh child process per
 * iteration so module-load time is included in the measurement (the whole
 * point of "cold-start").
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ITERATIONS = 3;

function projectRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..');
}

function measureOnce(cliPath: string): number {
  const t0 = process.hrtime.bigint();
  const res = spawnSync(process.execPath, [cliPath, '--help'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const t1 = process.hrtime.bigint();
  if (res.status !== 0) {
    const stderr = res.stderr?.toString('utf8') ?? '';
    throw new Error(`cli-agent --help exited with status ${res.status}: ${stderr}`);
  }
  return Number(t1 - t0) / 1_000_000; // ns → ms
}

function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1]! + sorted[mid]!) / 2;
  }
  return sorted[mid]!;
}

function main(): void {
  const root = projectRoot();
  const cliPath = path.join(root, 'dist', 'cli.js');

  // Pre-flight check: dist/cli.js must exist (run `npm run build` first).
  const probe = spawnSync(process.execPath, [cliPath, '--help'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  if (probe.status !== 0) {
    process.stderr.write(
      `[smoke-profile-cold-start] dist/cli.js not built or --help failed. ` +
        `Run \`npm run build\` first.\n`,
    );
    process.exit(2);
  }

  const samples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const ms = measureOnce(cliPath);
    samples.push(ms);
    process.stdout.write(`iteration ${i + 1}: ${ms.toFixed(2)} ms\n`);
  }

  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const med = median(samples);

  process.stdout.write('\n--- cli-agent --help cold-start (plan-005 AC-22) ---\n');
  process.stdout.write(`iterations: ${ITERATIONS}\n`);
  process.stdout.write(`min:    ${min.toFixed(2)} ms\n`);
  process.stdout.write(`median: ${med.toFixed(2)} ms\n`);
  process.stdout.write(`max:    ${max.toFixed(2)} ms\n`);
  process.stdout.write(
    'budget: <= 50 ms regression vs pre-feature baseline (informational; ' +
      'not gated by CI)\n',
  );
}

main();
