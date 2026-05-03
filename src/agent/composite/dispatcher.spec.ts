/**
 * Co-located tests for `dispatcher.ts` (plan-006 P6 / U-VIRTUAL).
 *
 * Categories:
 *   - bin-resolution    cli-agent path resolution honours env / argv[1] / PATH
 *   - guard-dispatch    composite-of-composite at dispatch time → UsageError
 *   - subprocess        spawn happy path with a stub binary; env carries
 *                       CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1; argv
 *                       carries the recorded `--tool` flags
 *   - subprocess-error  non-zero exit / timeout propagate
 *   - in-process        depth guard refuses beyond 2 levels
 *
 * The subprocess tests use a tiny stub script (Node) installed into a
 * tmpdir at test time. The script echoes its argv + env back as JSON
 * so the test can assert the spawn invocation shape without coupling
 * to the real cli-agent binary.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { dispatchComposite, resolveCliAgentBinPath } from './dispatcher.js';
import type { AgentConfig } from '../../config/agent-config.js';
import type { CompositeManifest } from './types.js';
import type { Logger } from '../logging.js';
import { UsageError, AgentRuntimeError } from '../../errors.js';

let tmpRoot = '';
let stubBinPath = '';

const nullLogger: Logger = {
  log: () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
  get currentLogPath() {
    return '';
  },
  get currentSessionId() {
    return 'test-session';
  },
};

function makeManifest(members = ['foo', 'bar']): CompositeManifest {
  return {
    schemaVersion: 1,
    compositeName: 'foo-plus-bar',
    members,
    memberDigests: Object.fromEntries(members.map((m) => [m, m.repeat(16).slice(0, 16)])),
    createdAt: '2026-05-02T00:00:00.000Z',
    cliAgentVersion: '0.3.0',
    capabilityDocPath: '/tmp/cap.md',
    distribution: {
      emitDoc: true,
      emitWrapper: false,
      emitWrapperOnPath: false,
      registerVirtual: true,
    },
  };
}

function makeCfg(): AgentConfig {
  return {
    agentDir: tmpRoot,
    capabilitiesDir: path.join(tmpRoot, 'capabilities'),
    compositesDir: path.join(tmpRoot, 'composites'),
    tools: [],
  } as unknown as AgentConfig;
}

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'dispatcher-spec-'));
  // Build a stub cli-agent binary that echoes its invocation as JSON to
  // stdout. The stub uses Node's hashbang so it works on macOS/Linux.
  stubBinPath = path.join(tmpRoot, 'cli-agent-stub.mjs');
  const stubBody = `#!/usr/bin/env node
const argv = process.argv.slice(2);
const env = {
  CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD:
    process.env.CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD ?? null,
};
process.stdout.write(JSON.stringify({ argv, env }));
process.exit(Number(process.env.STUB_EXIT_CODE ?? '0'));
`;
  await fsp.writeFile(stubBinPath, stubBody, { mode: 0o755 });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env['CLI_AGENT_BIN'];
  delete process.env['STUB_EXIT_CODE'];
  delete process.env['CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD'];
  delete process.env['CLI_AGENT_VIRTUAL_DISPATCH_IN_PROCESS_DEPTH'];
  if (tmpRoot) {
    try {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
});

/* ------------------------------------------------------------------ */
/* resolveCliAgentBinPath                                              */
/* ------------------------------------------------------------------ */

describe('resolveCliAgentBinPath', () => {
  it('honours CLI_AGENT_BIN when it points to an existing file', () => {
    process.env['CLI_AGENT_BIN'] = stubBinPath;
    expect(resolveCliAgentBinPath()).toBe(stubBinPath);
  });

  it('falls back to process.argv[1] when CLI_AGENT_BIN is unset', () => {
    delete process.env['CLI_AGENT_BIN'];
    // Replace argv[1] with the stub path; the resolver should pick it up.
    const orig = process.argv[1];
    process.argv[1] = stubBinPath;
    try {
      expect(resolveCliAgentBinPath()).toBe(stubBinPath);
    } finally {
      process.argv[1] = orig as string;
    }
  });

  it('throws AgentRuntimeError when no candidate is resolvable', () => {
    delete process.env['CLI_AGENT_BIN'];
    const origArgv1 = process.argv[1];
    const origPath = process.env['PATH'];
    process.argv[1] = path.join(tmpRoot, 'nonexistent-cli-agent.js');
    process.env['PATH'] = path.join(tmpRoot, 'empty-path-dir');
    try {
      expect(() => resolveCliAgentBinPath()).toThrow(AgentRuntimeError);
    } finally {
      process.argv[1] = origArgv1 as string;
      if (origPath !== undefined) process.env['PATH'] = origPath;
    }
  });
});

/* ------------------------------------------------------------------ */
/* Recursion guard at dispatch time                                    */
/* ------------------------------------------------------------------ */

describe('dispatchComposite — recursion guard', () => {
  it('throws UsageError when a member is itself a registered composite', async () => {
    const cfg = makeCfg();
    // Register an inner composite manifest at composites/inner/manifest.json.
    const innerDir = path.join(cfg.compositesDir, 'inner');
    await fsp.mkdir(innerDir, { recursive: true });
    await fsp.writeFile(
      path.join(innerDir, 'manifest.json'),
      JSON.stringify({ schemaVersion: 1 }),
      'utf8',
    );

    const manifest = makeManifest(['inner', 'foo']);
    process.env['CLI_AGENT_BIN'] = stubBinPath;
    await expect(
      dispatchComposite({
        manifest,
        invocationArgs: ['hello'],
        mode: 'child-process',
        cfg,
        logger: nullLogger,
      }),
    ).rejects.toThrow(UsageError);
  });
});

/* ------------------------------------------------------------------ */
/* Subprocess dispatch happy path                                      */
/* ------------------------------------------------------------------ */

describe('dispatchComposite — subprocess', () => {
  it('spawns the resolved binary with --tool flags + recursion guard env', async () => {
    process.env['CLI_AGENT_BIN'] = stubBinPath;
    const cfg = makeCfg();
    const manifest = makeManifest(['foo', 'bar']);
    const result = await dispatchComposite({
      manifest,
      invocationArgs: ['Do the thing'],
      mode: 'child-process',
      cfg,
      logger: nullLogger,
    });
    expect(result.exitCode).toBe(0);
    const echoed = JSON.parse(result.stdout) as {
      argv: string[];
      env: { CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD: string | null };
    };
    expect(echoed.argv).toEqual(['--tool', 'foo', '--tool', 'bar', 'Do the thing']);
    expect(echoed.env.CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD).toBe('1');
  });

  it('propagates a non-zero exit code from the child', async () => {
    process.env['CLI_AGENT_BIN'] = stubBinPath;
    process.env['STUB_EXIT_CODE'] = '7';
    const cfg = makeCfg();
    const result = await dispatchComposite({
      manifest: makeManifest(),
      invocationArgs: ['fail please'],
      mode: 'child-process',
      cfg,
      logger: nullLogger,
    });
    expect(result.exitCode).toBe(7);
  });

  it('returns a non-zero exit + stderr when the binary cannot be found', async () => {
    process.env['CLI_AGENT_BIN'] = path.join(tmpRoot, 'definitely-not-here');
    // The fallback to argv[1] / PATH may still succeed, so override
    // those too to a non-existent file.
    const origArgv1 = process.argv[1];
    const origPath = process.env['PATH'];
    process.argv[1] = path.join(tmpRoot, 'also-not-here');
    process.env['PATH'] = path.join(tmpRoot, 'empty');
    try {
      const cfg = makeCfg();
      await expect(
        dispatchComposite({
          manifest: makeManifest(),
          invocationArgs: ['x'],
          mode: 'child-process',
          cfg,
          logger: nullLogger,
        }),
      ).rejects.toThrow(AgentRuntimeError);
    } finally {
      process.argv[1] = origArgv1 as string;
      if (origPath !== undefined) process.env['PATH'] = origPath;
    }
  });
});

/* ------------------------------------------------------------------ */
/* In-process dispatch depth guard                                     */
/* ------------------------------------------------------------------ */

describe('dispatchComposite — in-process depth guard', () => {
  it('refuses beyond depth=2', async () => {
    process.env['CLI_AGENT_VIRTUAL_DISPATCH_IN_PROCESS_DEPTH'] = '2';
    const cfg = makeCfg();
    await expect(
      dispatchComposite({
        manifest: makeManifest(),
        invocationArgs: ['hello'],
        mode: 'in-process',
        cfg,
        logger: nullLogger,
      }),
    ).rejects.toThrow(UsageError);
  });

  it('refuses when invocationArgs has no positional prompt', async () => {
    const cfg = makeCfg();
    await expect(
      dispatchComposite({
        manifest: makeManifest(),
        invocationArgs: ['--flag-only'],
        mode: 'in-process',
        cfg,
        logger: nullLogger,
      }),
    ).rejects.toThrow(UsageError);
  });
});
