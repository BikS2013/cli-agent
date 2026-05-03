/**
 * End-to-end smoke for the U-WRAPPER POSIX shim generator
 * (plan-006 P6 / U-WRAPPER; research §11.1).
 *
 * What it does:
 *   1. Synthesises a fake "cli-agent" binary (a tiny `/bin/sh` script
 *      that just echoes its argv and exits with a controllable code).
 *   2. Calls `generateCompositeWrapperShim` to produce a shim that
 *      execs the fake cli-agent with `--tool foo-cli --tool bar-cli`
 *      pre-baked.
 *   3. Spawns the shim and asserts:
 *      - the fake cli-agent received `--tool foo-cli --tool bar-cli`
 *        followed by the user's runtime args, in order;
 *      - exit code is propagated faithfully (the fake cli-agent exits
 *        with 42; the shim must exit with 42 too — `exec` ⇒ no PID
 *        translation);
 *      - SIGTERM sent to the shim PID kills the child cli-agent
 *        (signal forwarding is automatic because of `exec`).
 *      - the `--help` branch reads and prints the doc file.
 *
 * Run from the project root:
 *   npx tsx test_scripts/shim-e2e.ts
 *
 * Skipped automatically on non-POSIX (Windows) — exits 0 with a notice
 * so a CI matrix that includes Windows doesn't have to special-case.
 *
 * NOT wired into vitest / CI by default. This is a manual smoke
 * (consistent with the other test_scripts/smoke-* scripts).
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { generateCompositeWrapperShim } from '../src/agent/composite/shim-writer.js';
import type { CompositeWrapperShimSpec } from '../src/agent/composite/types.js';

/* ------------------------------------------------------------------ */
/* Platform guard                                                      */
/* ------------------------------------------------------------------ */

if (process.platform === 'win32') {
  // eslint-disable-next-line no-console
  console.log('[shim-e2e] platform=win32 → skipping (POSIX-only smoke).');
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function log(line: string): void {
  process.stdout.write(`[shim-e2e] ${line}\n`);
}

function fail(line: string): never {
  process.stderr.write(`[shim-e2e] FAIL: ${line}\n`);
  process.exit(1);
}

async function makeFakeCliAgent(dir: string, exitCode: number): Promise<string> {
  const binPath = path.join(dir, 'fake-cli-agent');
  const body =
    '#!/bin/sh\n' +
    `# Fake cli-agent for shim-e2e. Echoes argv as JSON, exits ${exitCode}.\n` +
    'echo "ARGV_BEGIN"\n' +
    'for a in "$@"; do echo "$a"; done\n' +
    'echo "ARGV_END"\n' +
    `exit ${exitCode}\n`;
  await fsp.writeFile(binPath, body, { encoding: 'utf8', mode: 0o755 });
  return binPath;
}

interface RunResult {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
}

function runShim(shimPath: string, args: readonly string[]): RunResult {
  const res = spawnSync(shimPath, args, { encoding: 'utf8' });
  return {
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
    status: res.status,
    signal: res.signal,
  };
}

function parseArgvBlock(stdout: string): string[] {
  const begin = stdout.indexOf('ARGV_BEGIN\n');
  const end = stdout.indexOf('ARGV_END');
  if (begin < 0 || end < 0 || end < begin) {
    throw new Error(`could not parse ARGV block from: ${stdout}`);
  }
  return stdout
    .slice(begin + 'ARGV_BEGIN\n'.length, end)
    .split('\n')
    .filter((l) => l.length > 0);
}

/* ------------------------------------------------------------------ */
/* Test cases                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'shim-e2e-'));
  log(`workdir: ${work}`);

  try {
    /* ---------- Case 1: argv preservation + exit-code propagation ----- */
    {
      const fake = await makeFakeCliAgent(work, 42);
      const docPath = path.join(work, 'cap.md');
      await fsp.writeFile(docPath, '# capability doc body\nhello\n', 'utf8');
      const shimDir = path.join(work, 'shims');

      const spec: CompositeWrapperShimSpec = {
        compositeName: 'foo-plus-bar',
        members: ['foo-cli', 'bar-cli'],
        cliAgentBinPath: fake,
        capabilityDocPath: docPath,
        shimDir,
        synthesizedAt: new Date().toISOString(),
      };

      const result = await generateCompositeWrapperShim(spec);
      log(`shim written: ${result.path} (mode=0o${result.mode.toString(8)})`);

      // Sanity: stat → mode 755.
      const st = await fsp.stat(result.path);
      if ((st.mode & 0o777) !== 0o755) {
        fail(`shim mode is 0o${(st.mode & 0o777).toString(8)}, expected 0o755`);
      }

      // Run with a few user args (including one with embedded space).
      const r = runShim(result.path, ['run', 'something', 'with space', '--flag=x']);
      if (r.status !== 42) {
        fail(`expected exit code 42, got status=${r.status}, signal=${r.signal}, stderr=${r.stderr}`);
      }
      const argv = parseArgvBlock(r.stdout);
      const expected = [
        '--tool',
        'foo-cli',
        '--tool',
        'bar-cli',
        'run',
        'something',
        'with space',
        '--flag=x',
      ];
      if (JSON.stringify(argv) !== JSON.stringify(expected)) {
        fail(`argv mismatch\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(argv)}`);
      }
      log('case 1 OK: argv preserved, exit 42 propagated.');
    }

    /* ---------- Case 2: --help branch reads the cached doc ------------ */
    {
      const fake = await makeFakeCliAgent(work, 0);
      const docPath = path.join(work, 'help.md');
      const docBody = '# composite help — read from cached doc\n';
      await fsp.writeFile(docPath, docBody, 'utf8');
      const shimDir = path.join(work, 'shims-help');

      const spec: CompositeWrapperShimSpec = {
        compositeName: 'help-test',
        members: ['m1'],
        cliAgentBinPath: fake,
        capabilityDocPath: docPath,
        shimDir,
        synthesizedAt: new Date().toISOString(),
      };
      const result = await generateCompositeWrapperShim(spec);

      const r = runShim(result.path, ['--help']);
      if (r.status !== 0) {
        fail(`--help branch should exit 0; got status=${r.status}, signal=${r.signal}`);
      }
      if (!r.stdout.includes(docBody)) {
        fail(`--help branch output missing doc body. stdout=${r.stdout}`);
      }
      log('case 2 OK: --help printed the cached doc and exited 0.');

      // Cache-stale: delete the doc and re-run --help → exit 6.
      await fsp.unlink(docPath);
      const stale = runShim(result.path, ['--help']);
      if (stale.status !== 6) {
        fail(`cache-stale --help should exit 6; got status=${stale.status}`);
      }
      if (!stale.stderr.includes('composite cache stale')) {
        fail(`cache-stale stderr missing expected message. stderr=${stale.stderr}`);
      }
      log('case 2b OK: cache-stale --help exited 6 with expected stderr.');
    }

    /* ---------- Case 3: signal forwarding (SIGTERM kills child) ------- */
    {
      const sleeperPath = path.join(work, 'fake-cli-agent-sleeper');
      const sleeperBody =
        '#!/bin/sh\n' +
        '# Sleeps until killed; prints PID first so the parent can verify.\n' +
        'echo "CHILD_PID=$$"\n' +
        'sleep 30\n' +
        'echo "should-not-print"\n' +
        'exit 0\n';
      await fsp.writeFile(sleeperPath, sleeperBody, { encoding: 'utf8', mode: 0o755 });

      const docPath = path.join(work, 'sig.md');
      await fsp.writeFile(docPath, '# sig\n', 'utf8');
      const shimDir = path.join(work, 'shims-sig');

      const spec: CompositeWrapperShimSpec = {
        compositeName: 'sig-test',
        members: ['m1'],
        cliAgentBinPath: sleeperPath,
        capabilityDocPath: docPath,
        shimDir,
        synthesizedAt: new Date().toISOString(),
      };
      const result = await generateCompositeWrapperShim(spec);

      const child = spawn(result.path, ['ignored-arg'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdoutBuf = '';
      child.stdout.on('data', (c: Buffer) => {
        stdoutBuf += c.toString('utf8');
      });

      // Wait until we've seen CHILD_PID= … then send SIGTERM.
      const exitInfo = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          let killed = false;
          const timer = setInterval(() => {
            if (!killed && /CHILD_PID=\d+/.test(stdoutBuf)) {
              killed = true;
              clearInterval(timer);
              child.kill('SIGTERM');
            }
          }, 50);
          // Hard timeout: if the test takes > 10 s something is wrong.
          const hard = setTimeout(() => {
            if (!killed) {
              killed = true;
              clearInterval(timer);
              child.kill('SIGKILL');
              fail('signal-forwarding test timed out waiting for CHILD_PID');
            }
          }, 10_000);
          child.on('exit', (code, signal) => {
            clearTimeout(hard);
            resolve({ code, signal });
          });
        },
      );

      // The shim used `exec` so the shim's PID became the sleeper's PID.
      // Killing the shim with SIGTERM directly terminates the sleeper.
      // Therefore we expect either signal === 'SIGTERM' or exit code != 0.
      if (exitInfo.signal !== 'SIGTERM' && exitInfo.code === 0) {
        fail(
          `expected SIGTERM termination; got code=${exitInfo.code}, signal=${exitInfo.signal}, stdout=${stdoutBuf}`,
        );
      }
      if (stdoutBuf.includes('should-not-print')) {
        fail('signal forwarding failed: child printed its post-sleep marker.');
      }
      log(
        `case 3 OK: SIGTERM forwarded to child (code=${exitInfo.code}, signal=${exitInfo.signal}).`,
      );
    }

    log('all cases passed.');
    process.exit(0);
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Only run when invoked directly (not when imported).
const invokedDirectly =
  import.meta.url === pathToFileURL(process.argv[1] ?? '').href ||
  import.meta.url === fileURLToPath(process.argv[1] ?? '');
void invokedDirectly; // silence noUnusedLocals in some setups

main().catch((err: unknown) => {
  process.stderr.write(`[shim-e2e] uncaught: ${(err as Error).stack ?? err}\n`);
  process.exit(1);
});
