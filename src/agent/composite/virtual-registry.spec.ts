/**
 * Co-located tests for `virtual-registry.ts` (plan-006 P6 / U-VIRTUAL).
 *
 * Categories:
 *   - happy-path        scan picks up a valid composite
 *   - guard-dispatch    CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1 → []
 *   - guard-register    composite-of-composite at registration → skip + warn
 *   - missing-doc       absent capability doc → skip + warn
 *   - missing-member    absent member capability doc → skip + warn
 *   - malformed         malformed manifest → skip + warn (boot must succeed)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadVirtualTools, loadVirtualToolsSync } from './virtual-registry.js';
import { writeManifest } from './manifest.js';
import type { AgentConfig } from '../../config/agent-config.js';
import type { CompositeManifest } from './types.js';

let tmpRoot = '';

function makeCfg(): AgentConfig {
  return {
    agentDir: tmpRoot,
    capabilitiesDir: path.join(tmpRoot, 'capabilities'),
    compositesDir: path.join(tmpRoot, 'composites'),
    compositeCapabilitiesDir: path.join(tmpRoot, 'capabilities', 'composite'),
    compositeDistillDir: path.join(tmpRoot, 'capabilities', 'composite', '_distill'),
    perToolBudgetBytes: 8192,
    tools: [],
    // Other AgentConfig fields are not consulted by loadVirtualTools.
  } as unknown as AgentConfig;
}

async function ensureMemberDoc(cfg: AgentConfig, name: string): Promise<void> {
  await fsp.mkdir(cfg.capabilitiesDir, { recursive: true });
  await fsp.writeFile(path.join(cfg.capabilitiesDir, `${name}.md`), `# ${name}\n`, 'utf8');
}

async function writeCapabilityDoc(p: string, body: string): Promise<void> {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, body, 'utf8');
}

function makeManifest(overrides: Partial<CompositeManifest> & { compositeName: string; members: string[]; capabilityDocPath: string }): CompositeManifest {
  return {
    schemaVersion: 1,
    memberDigests: Object.fromEntries(overrides.members.map((m) => [m, m.repeat(16).slice(0, 16)])),
    createdAt: '2026-05-02T00:00:00.000Z',
    cliAgentVersion: '0.3.0',
    distribution: {
      emitDoc: true,
      emitWrapper: false,
      emitWrapperOnPath: false,
      registerVirtual: true,
    },
    ...overrides,
  };
}

beforeEach(async () => {
  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'virtual-registry-spec-'));
  // Suppress stderr noise from the warning emitter while keeping spy access.
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env['CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD'];
  if (tmpRoot) {
    try {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
});

describe('loadVirtualTools — happy path', () => {
  it('returns one handle per validly-registered composite', async () => {
    const cfg = makeCfg();
    await ensureMemberDoc(cfg, 'foo');
    await ensureMemberDoc(cfg, 'bar');
    const docPath = path.join(cfg.compositeCapabilitiesDir, 'foo-plus-bar.md');
    await writeCapabilityDoc(
      docPath,
      `---\nschemaVersion: 3\n---\n<!-- AUTO-GEN-START -->\nA composite tool aggregating foo and bar.\n<!-- AUTO-GEN-END -->\n`,
    );
    const m = makeManifest({
      compositeName: 'foo-plus-bar',
      members: ['foo', 'bar'],
      capabilityDocPath: docPath,
    });
    await writeManifest(
      path.join(cfg.compositesDir, 'foo-plus-bar', 'manifest.json'),
      m,
    );

    const handles = await loadVirtualTools(cfg);
    expect(handles).toHaveLength(1);
    expect(handles[0]!.name).toBe('foo-plus-bar');
    expect(handles[0]!.description).toContain('A composite tool aggregating foo and bar.');
    expect(handles[0]!.langchainTool.name).toBe('foo-plus-bar');
  });

  it('returns [] when compositesDir is absent', async () => {
    const cfg = makeCfg();
    const handles = await loadVirtualTools(cfg);
    expect(handles).toHaveLength(0);
  });

  it('sync variant matches async variant', async () => {
    const cfg = makeCfg();
    await ensureMemberDoc(cfg, 'a');
    await ensureMemberDoc(cfg, 'b');
    const docPath = path.join(cfg.compositeCapabilitiesDir, 'a-plus-b.md');
    await writeCapabilityDoc(docPath, '---\nschemaVersion: 3\n---\nbody\n');
    await writeManifest(
      path.join(cfg.compositesDir, 'a-plus-b', 'manifest.json'),
      makeManifest({ compositeName: 'a-plus-b', members: ['a', 'b'], capabilityDocPath: docPath }),
    );

    const sync = loadVirtualToolsSync(cfg);
    const asyncHandles = await loadVirtualTools(cfg);
    expect(sync.map((h) => h.name)).toEqual([...asyncHandles].map((h) => h.name));
  });
});

describe('loadVirtualTools — dispatch-time recursion guard', () => {
  it('returns [] when CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1 is set', async () => {
    const cfg = makeCfg();
    await ensureMemberDoc(cfg, 'foo');
    await ensureMemberDoc(cfg, 'bar');
    const docPath = path.join(cfg.compositeCapabilitiesDir, 'foo-plus-bar.md');
    await writeCapabilityDoc(docPath, '---\nschemaVersion: 3\n---\nbody\n');
    await writeManifest(
      path.join(cfg.compositesDir, 'foo-plus-bar', 'manifest.json'),
      makeManifest({ compositeName: 'foo-plus-bar', members: ['foo', 'bar'], capabilityDocPath: docPath }),
    );

    process.env['CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD'] = '1';
    const handles = await loadVirtualTools(cfg);
    expect(handles).toHaveLength(0);
  });
});

describe('loadVirtualTools — register-time recursion guard', () => {
  it('skips a composite whose member is itself a registered composite', async () => {
    const cfg = makeCfg();
    // Register an inner composite "inner".
    await ensureMemberDoc(cfg, 'a');
    await ensureMemberDoc(cfg, 'b');
    const innerDoc = path.join(cfg.compositeCapabilitiesDir, 'inner.md');
    await writeCapabilityDoc(innerDoc, '---\nschemaVersion: 3\n---\nbody\n');
    await writeManifest(
      path.join(cfg.compositesDir, 'inner', 'manifest.json'),
      makeManifest({ compositeName: 'inner', members: ['a', 'b'], capabilityDocPath: innerDoc }),
    );

    // The inner composite's id "inner" is now a registered composite.
    // Register an outer composite that lists "inner" as a member —
    // this should be rejected at boot with a warning.
    await ensureMemberDoc(cfg, 'inner');
    const outerDoc = path.join(cfg.compositeCapabilitiesDir, 'outer.md');
    await writeCapabilityDoc(outerDoc, '---\nschemaVersion: 3\n---\nbody\n');
    await writeManifest(
      path.join(cfg.compositesDir, 'outer', 'manifest.json'),
      makeManifest({ compositeName: 'outer', members: ['inner', 'a'], capabilityDocPath: outerDoc }),
    );

    const handles = await loadVirtualTools(cfg);
    const names = handles.map((h) => h.name);
    expect(names).toContain('inner');
    expect(names).not.toContain('outer');

    // Stderr emits the FR-CMP-016 warning.
    const writeMock = process.stderr.write as unknown as ReturnType<typeof vi.fn>;
    const calls = writeMock.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((c) => c.includes('composite-of-composite'))).toBe(true);
  });
});

describe('loadVirtualTools — robustness', () => {
  it('skips a composite whose capability doc is missing', async () => {
    const cfg = makeCfg();
    await ensureMemberDoc(cfg, 'foo');
    await ensureMemberDoc(cfg, 'bar');
    // Capability doc path is referenced but never created.
    const docPath = path.join(cfg.compositeCapabilitiesDir, 'foo-plus-bar.md');
    await writeManifest(
      path.join(cfg.compositesDir, 'foo-plus-bar', 'manifest.json'),
      makeManifest({ compositeName: 'foo-plus-bar', members: ['foo', 'bar'], capabilityDocPath: docPath }),
    );

    const handles = await loadVirtualTools(cfg);
    expect(handles).toHaveLength(0);
  });

  it('skips a composite whose member capability doc is missing', async () => {
    const cfg = makeCfg();
    // Only "foo" exists; "bar" is missing.
    await ensureMemberDoc(cfg, 'foo');
    const docPath = path.join(cfg.compositeCapabilitiesDir, 'foo-plus-bar.md');
    await writeCapabilityDoc(docPath, '---\nschemaVersion: 3\n---\nbody\n');
    await writeManifest(
      path.join(cfg.compositesDir, 'foo-plus-bar', 'manifest.json'),
      makeManifest({ compositeName: 'foo-plus-bar', members: ['foo', 'bar'], capabilityDocPath: docPath }),
    );

    const handles = await loadVirtualTools(cfg);
    expect(handles).toHaveLength(0);
  });

  it('boots successfully when one composite is malformed (skips it, keeps others)', async () => {
    const cfg = makeCfg();
    await ensureMemberDoc(cfg, 'foo');
    await ensureMemberDoc(cfg, 'bar');

    // Composite #1 is valid.
    const goodDoc = path.join(cfg.compositeCapabilitiesDir, 'good.md');
    await writeCapabilityDoc(goodDoc, '---\nschemaVersion: 3\n---\nbody\n');
    await writeManifest(
      path.join(cfg.compositesDir, 'good', 'manifest.json'),
      makeManifest({ compositeName: 'good', members: ['foo', 'bar'], capabilityDocPath: goodDoc }),
    );

    // Composite #2 has a malformed manifest.
    const badDir = path.join(cfg.compositesDir, 'bad');
    await fsp.mkdir(badDir, { recursive: true });
    await fsp.writeFile(path.join(badDir, 'manifest.json'), '{not json}', 'utf8');

    const handles = await loadVirtualTools(cfg);
    expect(handles).toHaveLength(1);
    expect(handles[0]!.name).toBe('good');
  });

  it('skips a composite whose manifest.compositeName mismatches the directory name', async () => {
    const cfg = makeCfg();
    await ensureMemberDoc(cfg, 'foo');
    await ensureMemberDoc(cfg, 'bar');
    const docPath = path.join(cfg.compositeCapabilitiesDir, 'mismatch.md');
    await writeCapabilityDoc(docPath, '---\nschemaVersion: 3\n---\nbody\n');
    // Directory is "expected" but manifest says "actual".
    await writeManifest(
      path.join(cfg.compositesDir, 'expected', 'manifest.json'),
      makeManifest({ compositeName: 'actual', members: ['foo', 'bar'], capabilityDocPath: docPath }),
    );

    const handles = await loadVirtualTools(cfg);
    expect(handles).toHaveLength(0);
  });
});
