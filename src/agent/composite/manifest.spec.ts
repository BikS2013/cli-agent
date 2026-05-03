/**
 * Co-located tests for `manifest.ts` (plan-006 P6 / U-VIRTUAL).
 *
 * Categories:
 *   - happy-path     read/write round-trip
 *   - validation     malformed JSON, missing fields, schema mismatch
 *   - collision      FR-CMP-017 collision behaviour with/without --force
 *   - race           O_EXCL .lock semantics (ADR-CMP-13)
 *   - mode           file mode 0o600 enforcement
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { readManifest, writeManifest, readManifestSync } from './manifest.js';
import type { CompositeManifest } from './types.js';
import { ConfigurationError, FileError } from '../../errors.js';

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'manifest-spec-'));
});

afterEach(async () => {
  if (tmpDir) {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* tolerated */
    }
  }
});

function makeManifest(overrides: Partial<CompositeManifest> = {}): CompositeManifest {
  return {
    schemaVersion: 1,
    compositeName: 'foo-plus-bar',
    members: ['foo', 'bar'],
    memberDigests: { foo: 'a'.repeat(16), bar: 'b'.repeat(16) },
    createdAt: '2026-05-02T00:00:00.000Z',
    cliAgentVersion: '0.3.0',
    capabilityDocPath: '/tmp/cap.md',
    distribution: {
      emitDoc: true,
      emitWrapper: false,
      emitWrapperOnPath: false,
      registerVirtual: true,
    },
    ...overrides,
  };
}

describe('readManifest — happy path', () => {
  it('returns null when the file does not exist', async () => {
    const result = await readManifest(path.join(tmpDir, 'absent.json'));
    expect(result).toBeNull();
  });

  it('round-trips through writeManifest', async () => {
    const m = makeManifest();
    const p = path.join(tmpDir, 'manifest.json');
    await writeManifest(p, m);
    const back = await readManifest(p);
    expect(back).not.toBeNull();
    expect(back!.compositeName).toBe('foo-plus-bar');
    expect([...back!.members]).toEqual(['foo', 'bar']);
    expect(back!.distribution.emitDoc).toBe(true);
    expect(back!.distribution.registerVirtual).toBe(true);
  });
});

describe('readManifest — validation', () => {
  it('throws ConfigurationError on malformed JSON', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    await fsp.writeFile(p, '{not json}', 'utf8');
    await expect(readManifest(p)).rejects.toThrow(ConfigurationError);
  });

  it('throws ConfigurationError on schemaVersion mismatch', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    await fsp.writeFile(p, JSON.stringify({ ...makeManifest(), schemaVersion: 99 }), 'utf8');
    await expect(readManifest(p)).rejects.toThrow(/schemaVersion/);
  });

  it('throws ConfigurationError on missing members', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    const broken = JSON.parse(JSON.stringify(makeManifest())) as Record<string, unknown>;
    delete broken['members'];
    await fsp.writeFile(p, JSON.stringify(broken), 'utf8');
    await expect(readManifest(p)).rejects.toThrow(/members/);
  });

  it('throws ConfigurationError on non-absolute capabilityDocPath', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    await fsp.writeFile(
      p,
      JSON.stringify({ ...makeManifest(), capabilityDocPath: 'relative.md' }),
      'utf8',
    );
    await expect(readManifest(p)).rejects.toThrow(/capabilityDocPath/);
  });

  it('throws ConfigurationError on missing distribution sub-fields', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    const broken = makeManifest();
    const obj = JSON.parse(JSON.stringify(broken)) as Record<string, unknown>;
    (obj['distribution'] as Record<string, unknown>)['emitDoc'] = 'not-bool';
    await fsp.writeFile(p, JSON.stringify(obj), 'utf8');
    await expect(readManifest(p)).rejects.toThrow(/emitDoc/);
  });
});

describe('readManifestSync — parity with async readManifest', () => {
  it('returns null on missing file', () => {
    expect(readManifestSync(path.join(tmpDir, 'absent.json'))).toBeNull();
  });

  it('returns parsed manifest on valid file', async () => {
    const m = makeManifest();
    const p = path.join(tmpDir, 'manifest.json');
    await writeManifest(p, m);
    const sync = readManifestSync(p);
    expect(sync).not.toBeNull();
    expect(sync!.compositeName).toBe('foo-plus-bar');
  });

  it('throws ConfigurationError on malformed JSON', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    await fsp.writeFile(p, '{not json}', 'utf8');
    expect(() => readManifestSync(p)).toThrow(ConfigurationError);
  });
});

describe('writeManifest — collision policy (FR-CMP-017)', () => {
  it('refuses to overwrite a manifest with a different member set when force=false', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    await writeManifest(p, makeManifest({ members: ['foo', 'bar'] }));
    await expect(
      writeManifest(p, makeManifest({ members: ['baz', 'qux'] })),
    ).rejects.toThrow(ConfigurationError);
  });

  it('overwrites when force=true', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    await writeManifest(p, makeManifest({ members: ['foo', 'bar'] }));
    await writeManifest(
      p,
      makeManifest({ members: ['baz', 'qux'], compositeName: 'foo-plus-bar' }),
      { force: true },
    );
    const back = await readManifest(p);
    expect([...back!.members]).toEqual(['baz', 'qux']);
  });

  it('idempotent re-write succeeds when same name + same members', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    await writeManifest(p, makeManifest());
    await writeManifest(p, makeManifest({ createdAt: '2030-01-01T00:00:00.000Z' }));
    const back = await readManifest(p);
    expect(back!.createdAt).toBe('2030-01-01T00:00:00.000Z');
  });
});

describe('writeManifest — race protection (ADR-CMP-13)', () => {
  it('refuses to write when a stale .lock file is present', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    // Pre-create the lock file synchronously.
    fs.writeFileSync(`${p}.lock`, '', { mode: 0o600 });
    try {
      await expect(writeManifest(p, makeManifest())).rejects.toThrow(FileError);
    } finally {
      fs.unlinkSync(`${p}.lock`);
    }
  });

  it('removes the .lock file on successful write', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    await writeManifest(p, makeManifest());
    expect(fs.existsSync(`${p}.lock`)).toBe(false);
  });

  it('removes the .lock file on collision-rejection', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    await writeManifest(p, makeManifest({ members: ['foo', 'bar'] }));
    await expect(
      writeManifest(p, makeManifest({ members: ['baz', 'qux'] })),
    ).rejects.toThrow(ConfigurationError);
    expect(fs.existsSync(`${p}.lock`)).toBe(false);
  });
});

describe('writeManifest — file mode (NFR-CMP / FR-CMP)', () => {
  it('writes the manifest at mode 0o600', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    await writeManifest(p, makeManifest());
    const st = await fsp.stat(p);
    // On macOS / Linux: bottom 9 bits of mode reflect rwx*3.
    const perms = st.mode & 0o777;
    expect(perms).toBe(0o600);
  });
});

describe('writeManifest — schema version', () => {
  it('throws ConfigurationError if manifest.schemaVersion is not 1', async () => {
    const p = path.join(tmpDir, 'manifest.json');
    const m = { ...makeManifest(), schemaVersion: 2 } as unknown as CompositeManifest;
    await expect(writeManifest(p, m)).rejects.toThrow(/schemaVersion/);
  });
});
