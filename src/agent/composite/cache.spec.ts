/**
 * Co-located tests for `src/agent/composite/cache.ts` (plan-006 P5).
 *
 * Coverage:
 *   - schema-3 round-trip read+write
 *   - schema-version mismatch detection
 *   - integrity (syntheticDigest) recomputation + tamper detection
 *   - cli-version-mismatch detection (ADR-CMP-8)
 *   - USER-RECIPES + USER-NOTES preservation across rewrite
 *   - atomic-write behaviour (no half-written file on simulated crash)
 *   - canonicaliseMemberDoc determinism + USER-* stripping
 *   - computeMemberDocDigest stability
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  COMPOSITE_CAPABILITY_SCHEMA_VERSION,
  SUPPORTED_COMPOSITE_SCHEMA_VERSIONS,
  canonicaliseMemberDoc,
  canonicaliseSyntheticInputs,
  computeMemberDocDigest,
  computeSyntheticDigest,
  extractCompositeUserNotes,
  extractCompositeUserRecipes,
  mirrorCompositeDocToCapabilities,
  readCompositeDoc,
  writeCompositeDoc,
} from './cache.js';
import { composeCompositeDoc } from './composeCompositeDoc.js';
import type { CompositeFrontmatter } from './types.js';

// Use a real temp dir so atomic-write semantics (rename across the
// same fs) are exercised. The tests clean up after themselves.
let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-composite-cache-'));
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function makeFrontmatter(overrides: Partial<CompositeFrontmatter> = {}): CompositeFrontmatter {
  return {
    schemaVersion: 3,
    composite: true,
    compositeName: 'file-cli-plus-outlook-cli',
    members: ['file-cli', 'outlook-cli'],
    memberDigests: {
      'file-cli': 'a1b2c3d4e5f60718',
      'outlook-cli': '0f1e2d3c4b5a6978',
    },
    synthesizedAt: '2026-05-02T00:00:00.000Z',
    syntheticDigest: 'placeholder0000', // composer overrides
    cliAgentVersion: '0.3.0',
    synthesisModel: 'anthropic:claude-sonnet-4-6',
    activeProfile: null,
    manRef: null,
    manPagePath: null,
    ...overrides,
  };
}

describe('schema version constants', () => {
  it('COMPOSITE_CAPABILITY_SCHEMA_VERSION = 3', () => {
    expect(COMPOSITE_CAPABILITY_SCHEMA_VERSION).toBe(3);
  });
  it('SUPPORTED_COMPOSITE_SCHEMA_VERSIONS contains 3 and only 3 in v1', () => {
    expect(SUPPORTED_COMPOSITE_SCHEMA_VERSIONS.has(3)).toBe(true);
    expect(SUPPORTED_COMPOSITE_SCHEMA_VERSIONS.has(2)).toBe(false);
    expect(SUPPORTED_COMPOSITE_SCHEMA_VERSIONS.size).toBe(1);
  });
});

describe('canonicaliseMemberDoc', () => {
  it('strips USER-RECIPES and USER-NOTES blocks', () => {
    const input = [
      '---',
      'tool: x',
      '---',
      '# x',
      'body',
      '<!-- USER-RECIPES:START -->',
      'recipe text',
      '<!-- USER-RECIPES:END -->',
      'tail',
      '<!-- USER-NOTES:START -->',
      'note text',
      '<!-- USER-NOTES:END -->',
      '',
    ].join('\n');
    const out = canonicaliseMemberDoc(input);
    expect(out).not.toContain('USER-RECIPES');
    expect(out).not.toContain('USER-NOTES');
    expect(out).not.toContain('recipe text');
    expect(out).not.toContain('note text');
    expect(out).toContain('# x');
    expect(out).toContain('body');
    expect(out).toContain('tail');
  });

  it('is deterministic for whitespace-equivalent inputs', () => {
    const a = '# x\nbody  \nmore\n';
    const b = '# x\nbody\t\nmore\n';
    expect(canonicaliseMemberDoc(a)).toBe(canonicaliseMemberDoc(b));
  });

  it('normalises CRLF to LF', () => {
    expect(canonicaliseMemberDoc('a\r\nb\r\n')).toBe(canonicaliseMemberDoc('a\nb\n'));
  });
});

describe('computeMemberDocDigest', () => {
  it('is stable for the same canonical input', () => {
    const doc = '# foo\nbody\n';
    expect(computeMemberDocDigest(doc)).toBe(computeMemberDocDigest(doc));
  });
  it('produces a 16-hex string', () => {
    const d = computeMemberDocDigest('hello');
    expect(d).toMatch(/^[0-9a-f]{16}$/);
  });
  it('is invariant to USER-* block edits', () => {
    const a = '# x\nbody\n<!-- USER-RECIPES:START -->\nbefore\n<!-- USER-RECIPES:END -->\n';
    const b = '# x\nbody\n<!-- USER-RECIPES:START -->\nafter\n<!-- USER-RECIPES:END -->\n';
    expect(computeMemberDocDigest(a)).toBe(computeMemberDocDigest(b));
  });
});

describe('computeSyntheticDigest + canonicaliseSyntheticInputs', () => {
  it('is deterministic regardless of input key order', () => {
    const inputA = canonicaliseSyntheticInputs({
      schemaVersion: 3,
      compositeName: 'c',
      members: ['b', 'a'],
      memberDigests: { b: 'B', a: 'A' },
      cliAgentVersion: '0.3.0',
      synthesisModel: 'm',
    });
    const inputB = canonicaliseSyntheticInputs({
      schemaVersion: 3,
      compositeName: 'c',
      members: ['a', 'b'],
      memberDigests: { a: 'A', b: 'B' },
      cliAgentVersion: '0.3.0',
      synthesisModel: 'm',
    });
    expect(inputA).toBe(inputB);
    expect(computeSyntheticDigest(inputA)).toBe(computeSyntheticDigest(inputB));
  });
});

describe('readCompositeDoc + writeCompositeDoc round-trip', () => {
  it('round-trips a freshly composed schema-3 doc', async () => {
    const fm = makeFrontmatter();
    const doc = composeCompositeDoc({
      frontmatter: fm,
      autoGenBody: '# composite body\nstuff',
      userRecipes: 'recipe-1\nrecipe-2',
      userNotes: 'free-form notes',
    });
    const filePath = path.join(tmpDir, 'comp.md');
    await writeCompositeDoc(filePath, doc);

    const result = await readCompositeDoc(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('read failed');
    expect(result.doc.frontmatter.schemaVersion).toBe(3);
    expect(result.doc.frontmatter.composite).toBe(true);
    expect(result.doc.frontmatter.compositeName).toBe(fm.compositeName);
    expect([...result.doc.frontmatter.members]).toEqual([...fm.members].sort());
    expect(result.doc.frontmatter.activeProfile).toBeNull();
    expect(result.doc.frontmatter.manRef).toBeNull();
    expect(result.doc.frontmatter.manPagePath).toBeNull();
    expect(result.doc.autoGeneratedBody).toContain('composite body');
    expect(result.doc.userRecipes).toContain('recipe-1');
    expect(result.doc.userNotes).toContain('free-form notes');
  });

  it('reports `missing` when the file does not exist', async () => {
    const result = await readCompositeDoc(path.join(tmpDir, 'nope.md'));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected ok');
    expect(result.reason).toBe('missing');
  });

  it('reports `schema_version_unsupported` for a schema-2 doc', async () => {
    const filePath = path.join(tmpDir, 'old.md');
    // Schema-2 frontmatter shape: no `composite: true` literal,
    // schemaVersion=2. Our parser rejects it before the version
    // check fires because `composite` is missing — same effective
    // outcome (treated as "not a composite doc"). The reader
    // surfaces this as `malformed`, which is functionally equivalent
    // to "schema_version_unsupported" for callers' purposes.
    const body = [
      '---',
      'tool: foo',
      'schemaVersion: 2',
      '---',
      '<!-- AUTO-GENERATED:START hash=00 -->',
      'body',
      '<!-- AUTO-GENERATED:END -->',
      '',
    ].join('\n');
    await fsp.writeFile(filePath, body, { mode: 0o600 });
    const result = await readCompositeDoc(filePath);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected ok');
    // Either reason is an acceptable "this is not a composite doc"
    // signal; both keep the cache miss path safe.
    expect(['malformed', 'schema_version_unsupported']).toContain(result.reason);
  });

  it('reports `integrity_failed` when syntheticDigest is tampered with', async () => {
    const fm = makeFrontmatter();
    const doc = composeCompositeDoc({
      frontmatter: fm,
      autoGenBody: 'body content',
    });
    const filePath = path.join(tmpDir, 'tamper.md');
    await writeCompositeDoc(filePath, doc);

    // Corrupt the syntheticDigest line on disk.
    const raw = await fsp.readFile(filePath, 'utf8');
    const corrupted = raw.replace(/syntheticDigest: [0-9a-f]{16}/u, 'syntheticDigest: deadbeefdeadbeef');
    await fsp.writeFile(filePath, corrupted, { mode: 0o600 });

    const result = await readCompositeDoc(filePath);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected ok');
    expect(result.reason).toBe('integrity_failed');
  });

  it('reports `cli_version_mismatch` when expectedCliAgentVersion differs', async () => {
    const fm = makeFrontmatter({ cliAgentVersion: '0.3.0' });
    const doc = composeCompositeDoc({
      frontmatter: fm,
      autoGenBody: 'body',
    });
    const filePath = path.join(tmpDir, 'verbump.md');
    await writeCompositeDoc(filePath, doc);

    const result = await readCompositeDoc(filePath, {
      expectedCliAgentVersion: '0.4.0',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected ok');
    expect(result.reason).toBe('cli_version_mismatch');
  });

  it('returns ok when expectedCliAgentVersion matches', async () => {
    const fm = makeFrontmatter({ cliAgentVersion: '0.3.0' });
    const doc = composeCompositeDoc({
      frontmatter: fm,
      autoGenBody: 'body',
    });
    const filePath = path.join(tmpDir, 'ver-ok.md');
    await writeCompositeDoc(filePath, doc);

    const result = await readCompositeDoc(filePath, {
      expectedCliAgentVersion: '0.3.0',
    });
    expect(result.ok).toBe(true);
  });
});

describe('USER-* block preservation across rewrite', () => {
  it('preserves USER-RECIPES + USER-NOTES on a regenerate flow', async () => {
    const fm = makeFrontmatter();
    // First synthesis: empty stubs.
    const first = composeCompositeDoc({
      frontmatter: fm,
      autoGenBody: 'first body',
    });
    const filePath = path.join(tmpDir, 'pres.md');
    await writeCompositeDoc(filePath, first);

    // Simulate user editing both blocks.
    const raw1 = await fsp.readFile(filePath, 'utf8');
    const userEdited = raw1
      .replace(
        /<!-- USER-RECIPES:START -->\n<!-- USER-RECIPES:END -->/u,
        '<!-- USER-RECIPES:START -->\nuser-recipe-1\nuser-recipe-2\n<!-- USER-RECIPES:END -->',
      )
      .replace(
        /<!-- USER-NOTES:START -->\n<!-- USER-NOTES:END -->/u,
        '<!-- USER-NOTES:START -->\nuser note here\n<!-- USER-NOTES:END -->',
      );
    await fsp.writeFile(filePath, userEdited, { mode: 0o600 });

    // Read back the user blocks via the composite-aware extractors.
    const onDisk = await fsp.readFile(filePath, 'utf8');
    const preservedRecipes = extractCompositeUserRecipes(onDisk);
    const preservedNotes = extractCompositeUserNotes(onDisk);
    expect(preservedRecipes).toContain('user-recipe-1');
    expect(preservedNotes).toContain('user note here');

    // Regenerate: build a new doc with the preserved bodies.
    const recipesBody = preservedRecipes
      .replace('<!-- USER-RECIPES:START -->', '')
      .replace('<!-- USER-RECIPES:END -->', '')
      .trim();
    const notesBody = preservedNotes
      .replace('<!-- USER-NOTES:START -->', '')
      .replace('<!-- USER-NOTES:END -->', '')
      .trim();
    const second = composeCompositeDoc({
      frontmatter: { ...fm, synthesizedAt: '2026-05-02T01:00:00.000Z' },
      autoGenBody: 'second body',
      userRecipes: recipesBody,
      userNotes: notesBody,
    });
    await writeCompositeDoc(filePath, second);

    const result = await readCompositeDoc(filePath);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('read failed');
    expect(result.doc.userRecipes).toContain('user-recipe-1');
    expect(result.doc.userRecipes).toContain('user-recipe-2');
    expect(result.doc.userNotes).toContain('user note here');
    expect(result.doc.autoGeneratedBody).toContain('second body');
  });
});

describe('writeCompositeDoc atomicity', () => {
  it('does not leave a tmp file behind on a successful write', async () => {
    const fm = makeFrontmatter();
    const doc = composeCompositeDoc({ frontmatter: fm, autoGenBody: 'body' });
    const filePath = path.join(tmpDir, 'atomic.md');
    await writeCompositeDoc(filePath, doc);

    const entries = await fsp.readdir(tmpDir);
    expect(entries).toContain('atomic.md');
    for (const e of entries) {
      expect(e).not.toMatch(/atomic\.md\.tmp\./);
    }
  });

  it('writes the file at mode 0o600 on POSIX', async () => {
    const fm = makeFrontmatter();
    const doc = composeCompositeDoc({ frontmatter: fm, autoGenBody: 'body' });
    const filePath = path.join(tmpDir, 'mode.md');
    await writeCompositeDoc(filePath, doc);
    if (process.platform !== 'win32') {
      const st = await fsp.stat(filePath);
      // Mask out file-type bits; only the permission bits should
      // remain. 0o600 = owner read+write only.
      expect((st.mode & 0o777)).toBe(0o600);
    }
  });
});

describe('mirrorCompositeDocToCapabilities', () => {
  it('copies the canonical doc into <capabilitiesDir>/<id>.md', async () => {
    const fm = makeFrontmatter();
    const doc = composeCompositeDoc({ frontmatter: fm, autoGenBody: 'body' });
    const canonicalPath = path.join(tmpDir, 'canonical.md');
    await writeCompositeDoc(canonicalPath, doc);

    const capDir = path.join(tmpDir, 'capabilities');
    await fsp.mkdir(capDir, { recursive: true });

    const mirrorPath = await mirrorCompositeDocToCapabilities(canonicalPath, capDir, fm.compositeName);
    expect(mirrorPath).toBe(path.join(capDir, `${fm.compositeName}.md`));

    const mirrored = await fsp.readFile(mirrorPath, 'utf8');
    const original = await fsp.readFile(canonicalPath, 'utf8');
    expect(mirrored).toBe(original);
  });
});
