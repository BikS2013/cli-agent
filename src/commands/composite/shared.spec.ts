/**
 * Tests for the U-CMD shared helpers (plan-006 P6).
 *
 * Coverage:
 *   - validateCompositeName: regex pass/fail.
 *   - deriveCompositeName: deterministic, regex-safe.
 *   - renderTable: padding + dash row.
 *   - regenerateCompositeDoc / deleteCompositeDocs (round-trip on tmp).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

import {
  COMPOSITE_NAME_RE,
  deriveCompositeName,
  emitJson,
  formatMtime,
  renderTable,
  validateCompositeName,
  deleteCompositeDocs,
  regenerateCompositeDoc,
  canonicalDocPathFor,
  mirrorDocPathFor,
} from './shared.js';
import { UsageError } from '../../errors.js';
import type { CompositeFrontmatter } from '../../agent/composite/types.js';

let TMP: string;
beforeEach(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-composite-shared-'));
});
afterEach(async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
});

describe('validateCompositeName', () => {
  it('accepts canonical lowercase names', () => {
    expect(validateCompositeName('demo')).toBe('demo');
    expect(validateCompositeName('a-b_c123')).toBe('a-b_c123');
  });
  it('rejects uppercase / leading digit / too-long', () => {
    expect(() => validateCompositeName('Demo')).toThrow(UsageError);
    expect(() => validateCompositeName('1demo')).toThrow(UsageError);
    expect(() => validateCompositeName('a'.repeat(64))).toThrow(UsageError);
    expect(() => validateCompositeName('a@b')).toThrow(UsageError);
    expect(() => validateCompositeName('')).toThrow(UsageError);
  });
  it('regex source matches §14.F', () => {
    expect(COMPOSITE_NAME_RE.source).toBe('^[a-z][a-z0-9_-]{0,62}$');
  });
});

describe('deriveCompositeName', () => {
  it('produces deterministic regex-safe output', () => {
    const a = deriveCompositeName(['file-cli', 'outlook-cli']);
    const b = deriveCompositeName(['outlook-cli', 'file-cli']);
    expect(a).toBe(b); // sort-invariant
    expect(COMPOSITE_NAME_RE.test(a)).toBe(true);
  });
  it('throws UsageError on empty member list', () => {
    expect(() => deriveCompositeName([])).toThrow(UsageError);
  });
});

describe('renderTable', () => {
  it('renders aligned columns with a dash row', () => {
    const out = renderTable(
      ['NAME', 'VAL'],
      [
        ['short', '1'],
        ['longer', '10'],
      ],
    );
    const lines = out.trim().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toMatch(/^-+\s+-+$/);
    expect(lines[2]).toMatch(/short\s+1$/);
  });
});

describe('formatMtime', () => {
  it('emits stable UTC YYYY-MM-DD HH:mm', () => {
    const d = new Date(Date.UTC(2024, 11, 31, 1, 2));
    expect(formatMtime(d)).toBe('2024-12-31 01:02');
  });
});

describe('emitJson', () => {
  it('writes pretty JSON terminated by newline', () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (s: string) => boolean }).write = (s) => {
      writes.push(s);
      return true;
    };
    try {
      emitJson({ x: 1 });
    } finally {
      (process.stdout as unknown as { write: typeof orig }).write = orig;
    }
    const out = writes.join('');
    expect(out.endsWith('\n')).toBe(true);
    expect(JSON.parse(out)).toEqual({ x: 1 });
  });
});

describe('regenerateCompositeDoc + deleteCompositeDocs round-trip', () => {
  function frontmatterFor(name: string): CompositeFrontmatter {
    return {
      schemaVersion: 3,
      composite: true,
      compositeName: name,
      members: ['a', 'b'],
      memberDigests: { a: 'aaaaaaaaaaaaaaaa', b: 'bbbbbbbbbbbbbbbb' },
      synthesizedAt: '2024-01-01T00:00:00Z',
      syntheticDigest: 'placeholder',
      cliAgentVersion: '0.3.0',
      synthesisModel: 'test:stub',
      activeProfile: null,
      manRef: null,
      manPagePath: null,
    };
  }

  it('writes the canonical doc + mirror, then deletes both', async () => {
    const compositeCapsDir = path.join(TMP, 'capabilities', 'composite');
    const capsDir = path.join(TMP, 'capabilities');
    await fsp.mkdir(compositeCapsDir, { recursive: true });
    await fsp.mkdir(capsDir, { recursive: true });

    const docPath = canonicalDocPathFor(compositeCapsDir, 'demo');
    const mirrorPath = mirrorDocPathFor(capsDir, 'demo');

    const reg = await regenerateCompositeDoc({
      frontmatter: frontmatterFor('demo'),
      autoGenBody: 'Composed body for demo composite.',
      compositeDocPath: docPath,
      capabilitiesDir: capsDir,
      compositeName: 'demo',
    });
    expect(reg.compositeDocPath).toBe(docPath);
    expect(reg.preservedUserBlocks).toBe(false);
    expect((await fsp.stat(docPath)).isFile()).toBe(true);
    expect((await fsp.stat(mirrorPath)).isFile()).toBe(true);

    const del = await deleteCompositeDocs({
      compositeDocPath: docPath,
      mirrorPath,
    });
    expect(del.removedCanonical).toBe(true);
    expect(del.removedMirror).toBe(true);
    await expect(fsp.stat(docPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fsp.stat(mirrorPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves USER-RECIPES / USER-NOTES on regenerate', async () => {
    const compositeCapsDir = path.join(TMP, 'capabilities', 'composite');
    const capsDir = path.join(TMP, 'capabilities');
    await fsp.mkdir(compositeCapsDir, { recursive: true });
    await fsp.mkdir(capsDir, { recursive: true });
    const docPath = canonicalDocPathFor(compositeCapsDir, 'demo');

    // First write: seed USER-RECIPES content.
    await regenerateCompositeDoc({
      frontmatter: frontmatterFor('demo'),
      autoGenBody: 'first body',
      userRecipes: 'recipe-one\nrecipe-two',
      userNotes: 'a personal note',
      compositeDocPath: docPath,
      capabilitiesDir: capsDir,
      compositeName: 'demo',
    });

    // Second write: omit USER-* fields → should preserve the prior text.
    const reg2 = await regenerateCompositeDoc({
      frontmatter: frontmatterFor('demo'),
      autoGenBody: 'second body',
      compositeDocPath: docPath,
      capabilitiesDir: capsDir,
      compositeName: 'demo',
    });
    expect(reg2.preservedUserBlocks).toBe(true);

    const finalText = await fsp.readFile(docPath, 'utf8');
    expect(finalText).toMatch(/recipe-one/);
    expect(finalText).toMatch(/a personal note/);
    expect(finalText).toMatch(/second body/);
  });
});

describe('deleteCompositeDocs idempotency', () => {
  it('tolerates missing files', async () => {
    const r = await deleteCompositeDocs({
      compositeDocPath: path.join(TMP, 'nope.md'),
      mirrorPath: path.join(TMP, 'also-nope.md'),
    });
    expect(r.removedCanonical).toBe(false);
    expect(r.removedMirror).toBe(false);
  });
});

// Silence unused-import warning under strict typing.
void vi;
