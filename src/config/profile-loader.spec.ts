/**
 * Unit tests for profile-loader.ts
 *
 * Coverage:
 *   - AC-1 / loadProfile happy path: returns ActiveProfile with digest + name.
 *   - E1: profile not found -> UsageError with diagnostic.
 *   - E4: name/stem mismatch -> ConfigurationError exit 3.
 *   - E5: empty profile -> stderr notice, loads inert.
 *   - E16: illegal name characters -> UsageError.
 *   - E18: yaml + json both present -> ConfigurationError.
 *   - listProfiles: empty + populated.
 *   - validateProfileName direct.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import {
  loadProfile,
  listProfiles,
  resolveProfilePath,
  validateProfileName,
} from './profile-loader.js';

// In-memory fs/promises mock so the loader does not touch the host disk.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const files = new Map<string, Buffer>();
  const readFile = vi.fn().mockImplementation(async (p: string, enc?: string) => {
    const key = String(p);
    const buf = files.get(key);
    if (!buf) {
      const err = Object.assign(new Error(`ENOENT: ${key}`), { code: 'ENOENT' });
      throw err;
    }
    if (enc === 'utf8') return buf.toString('utf8');
    return buf;
  });
  const stat = vi.fn().mockImplementation(async (p: string) => {
    const buf = files.get(String(p));
    if (!buf) {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    }
    return { size: buf.length, mtime: new Date('2026-01-01T00:00:00Z') };
  });
  const readdir = vi.fn().mockImplementation(async (p: string) => {
    const dir = String(p).replace(/\/+$/, '') + '/';
    const out: string[] = [];
    for (const key of files.keys()) {
      if (key.startsWith(dir)) {
        const rest = key.slice(dir.length);
        if (!rest.includes('/')) out.push(rest);
      }
    }
    if (out.length === 0) {
      // Decide whether the dir itself exists by checking sentinel marker.
      // For tests we always treat non-existent dirs as ENOENT; mark a dir
      // as existing by adding a `<dir>/.keep` file (or any file).
      // If no files match, throw ENOENT to simulate a missing profiles dir.
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    }
    return out;
  });
  const mocks = { readFile, stat, readdir };
  return {
    ...actual,
    ...mocks,
    default: { ...actual, ...mocks },
    __files: files,
  };
});

// In-memory fs (sync) mock for codec.detectAmbiguity.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const present = new Set<string>();
  const accessSync = vi.fn().mockImplementation((p: string) => {
    if (present.has(String(p))) return undefined;
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    throw err;
  });
  const constants = { F_OK: 0 };
  return {
    ...actual,
    accessSync,
    constants,
    default: { ...actual, accessSync, constants },
    __present: present,
  };
});

async function getFiles(): Promise<Map<string, Buffer>> {
  const mod = (await import('node:fs/promises')) as unknown as {
    __files: Map<string, Buffer>;
  };
  return mod.__files;
}

async function getPresentSet(): Promise<Set<string>> {
  const mod = (await import('node:fs')) as unknown as { __present: Set<string> };
  return mod.__present;
}

async function placeProfile(
  agentDir: string,
  filename: string,
  contents: string,
): Promise<string> {
  const abs = path.join(agentDir, 'profiles', filename);
  const files = await getFiles();
  files.set(abs, Buffer.from(contents, 'utf8'));
  const present = await getPresentSet();
  present.add(abs);
  return abs;
}

beforeEach(async () => {
  const files = await getFiles();
  files.clear();
  const present = await getPresentSet();
  present.clear();
});

const AGENT_DIR = '/agent';

describe('validateProfileName (E16)', () => {
  it('accepts simple names', () => {
    expect(() => validateProfileName('review')).not.toThrow();
    expect(() => validateProfileName('my-profile_v2')).not.toThrow();
  });

  it('rejects empty', () => {
    expect(() => validateProfileName('')).toThrowError(/non-empty/);
  });

  it('rejects names containing /', () => {
    expect(() => validateProfileName('a/b')).toThrowError(/illegal character/);
  });

  it('rejects names containing \\', () => {
    expect(() => validateProfileName('a\\b')).toThrowError(/illegal character/);
  });

  it('rejects names starting with dot', () => {
    expect(() => validateProfileName('.hidden')).toThrowError(/dot/);
  });

  it('rejects "." and ".."', () => {
    expect(() => validateProfileName('.')).toThrowError(/dot|reserved/);
    expect(() => validateProfileName('..')).toThrowError(/dot|reserved/);
  });

  it('UsageError carries E_USAGE / exit 2', () => {
    try {
      validateProfileName('a/b');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_USAGE');
      expect((e as { exitCode?: number }).exitCode).toBe(2);
    }
  });
});

describe('resolveProfilePath', () => {
  it('returns yaml when only yaml exists', async () => {
    const abs = await placeProfile(AGENT_DIR, 'demo.yaml', 'name: demo\n');
    expect(resolveProfilePath('demo', AGENT_DIR)).toEqual({ yaml: abs });
  });

  it('E18: throws ConfigurationError when both yaml and json exist', async () => {
    await placeProfile(AGENT_DIR, 'demo.yaml', 'name: demo\n');
    await placeProfile(AGENT_DIR, 'demo.json', '{"name":"demo"}');
    try {
      resolveProfilePath('demo', AGENT_DIR);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
      expect((e as { exitCode?: number }).exitCode).toBe(3);
    }
  });
});

describe('loadProfile — happy path', () => {
  it('AC-1: returns ActiveProfile with digest and resolved fields', async () => {
    const abs = await placeProfile(
      AGENT_DIR,
      'review.yaml',
      [
        'name: review',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: openai',
        '  model: gpt-4o',
        'tools:',
        '  allow:',
        '    - bash_run',
        '',
      ].join('\n'),
    );
    const profile = await loadProfile('review', AGENT_DIR);
    expect(profile.name).toBe('review');
    expect(profile.path).toBe(abs);
    expect(profile.schemaVersion).toBe(1);
    expect(profile.digest).toMatch(/^[0-9a-f]{16}$/);
    expect(profile.cliParams?.provider).toBe('openai');
    expect(profile.tools?.allow).toEqual(['bash_run']);
  });

  it('digest is stable across loads of the same bytes', async () => {
    await placeProfile(AGENT_DIR, 'demo.yaml', 'name: demo\nschemaVersion: 1\n');
    const a = await loadProfile('demo', AGENT_DIR);
    const b = await loadProfile('demo', AGENT_DIR);
    expect(a.digest).toBe(b.digest);
  });
});

describe('loadProfile — error matrix', () => {
  it('E1: profile not found -> UsageError', async () => {
    try {
      await loadProfile('missing', AGENT_DIR);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_USAGE');
      expect((e as { exitCode?: number }).exitCode).toBe(2);
    }
  });

  it('E1 diagnostic enumerates existing profiles when present', async () => {
    await placeProfile(AGENT_DIR, 'one.yaml', 'name: one\n');
    await placeProfile(AGENT_DIR, 'two.yaml', 'name: two\n');
    try {
      await loadProfile('three', AGENT_DIR);
      throw new Error('expected throw');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/Existing profiles:/);
      expect(msg).toMatch(/one/);
      expect(msg).toMatch(/two/);
    }
  });

  it('E4: name field disagreeing with stem -> ConfigurationError exit 3', async () => {
    await placeProfile(
      AGENT_DIR,
      'review.yaml',
      'name: NOT-review\nschemaVersion: 1\n',
    );
    try {
      await loadProfile('review', AGENT_DIR);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
      expect((e as { exitCode?: number }).exitCode).toBe(3);
    }
  });

  it('E5: empty profile loads + emits stderr notice', async () => {
    await placeProfile(AGENT_DIR, 'empty.yaml', 'name: empty\nschemaVersion: 1\n');
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ) => {
      writes.push(s);
      return true;
    };
    try {
      const profile = await loadProfile('empty', AGENT_DIR);
      expect(profile.cliParams).toBeUndefined();
      expect(profile.tools).toBeUndefined();
      expect(profile.toolArgs).toBeUndefined();
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    expect(writes.join('')).toMatch(/profile empty is empty/);
  });

  it('E16: illegal name -> UsageError before any fs touch', async () => {
    try {
      await loadProfile('a/b', AGENT_DIR);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_USAGE');
    }
  });

  it('E18: both yaml and json -> ConfigurationError', async () => {
    await placeProfile(AGENT_DIR, 'demo.yaml', 'name: demo\nschemaVersion: 1\n');
    await placeProfile(AGENT_DIR, 'demo.json', '{"name":"demo","schemaVersion":1}');
    try {
      await loadProfile('demo', AGENT_DIR);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
    }
  });

  it('E11: credential-shape key in cliParams -> ConfigurationError', async () => {
    await placeProfile(
      AGENT_DIR,
      'leak.yaml',
      [
        'name: leak',
        'schemaVersion: 1',
        'cliParams:',
        '  provider: openai',
        '  OPENAI_API_KEY: sk-leaked',
        '',
      ].join('\n'),
    );
    try {
      await loadProfile('leak', AGENT_DIR);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
      expect((e as { exitCode?: number }).exitCode).toBe(3);
    }
  });
});

describe('listProfiles', () => {
  it('returns [] when profiles dir is missing', async () => {
    const entries = await listProfiles(AGENT_DIR);
    expect(entries).toEqual([]);
  });

  it('lists multiple profiles alphabetically', async () => {
    await placeProfile(AGENT_DIR, 'beta.yaml', 'name: beta\ndescription: B\n');
    await placeProfile(AGENT_DIR, 'alpha.yaml', 'name: alpha\ndescription: A\n');
    const entries = await listProfiles(AGENT_DIR);
    expect(entries.map((e) => e.name)).toEqual(['alpha', 'beta']);
    expect(entries[0]!.description).toBe('A');
  });

  it('skips non-profile files in the dir', async () => {
    await placeProfile(AGENT_DIR, 'real.yaml', 'name: real\n');
    await placeProfile(AGENT_DIR, 'README.txt', 'not a profile');
    const entries = await listProfiles(AGENT_DIR);
    expect(entries.map((e) => e.name)).toEqual(['real']);
  });
});
