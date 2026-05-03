/**
 * Co-located tests for `src/agent/composite/regen.ts` (plan-006 P6 / U-DOC).
 *
 * Covers:
 *   - regenerateCompositeDoc:
 *     • USER-RECIPES preserved byte-for-byte across regenerate.
 *     • USER-NOTES preserved byte-for-byte across regenerate.
 *     • Both preserved together when both present.
 *     • Empty/missing USER-* in old doc → empty USER-* in new doc.
 *     • Multi-line markdown-formatted USER-* preserved.
 *     • New AUTO-GENERATED block replaces the old one.
 *     • syntheticDigest changes from old to new.
 *     • Mirror copy stays in sync with canonical (post-regen).
 *     • First-synthesis path (no prior doc) works.
 *   - deleteCompositeDocs:
 *     • Removes canonical + mirror when mirror matches.
 *     • Preserves mirror when user-modified (content differs).
 *     • Never touches Stage-1 distill cache files.
 *     • Tolerates missing canonical / missing mirror.
 *
 * Tests follow the `cache.spec.ts` hermetic-fs convention: real
 * `fs.mkdtemp` per test, full `rm -rf` in afterEach.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  extractCompositeUserNotes,
  extractCompositeUserRecipes,
  readCompositeDoc,
  writeCompositeDoc,
} from './cache.js';
import { composeCompositeDoc } from './composeCompositeDoc.js';
import { deleteCompositeDocs, regenerateCompositeDoc } from './regen.js';
import type { CompositeFrontmatter } from './types.js';

let tmpDir: string;
let canonicalDir: string;
let capabilitiesDir: string;
let distillDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-composite-regen-'));
  canonicalDir = path.join(tmpDir, 'capabilities', 'composite');
  capabilitiesDir = path.join(tmpDir, 'capabilities');
  distillDir = path.join(tmpDir, 'capabilities', 'composite', '_distill');
  await fsp.mkdir(canonicalDir, { recursive: true });
  await fsp.mkdir(capabilitiesDir, { recursive: true });
  await fsp.mkdir(distillDir, { recursive: true });
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

const COMPOSITE_NAME = 'file-cli-plus-outlook-cli';

function makeFrontmatter(overrides: Partial<CompositeFrontmatter> = {}): CompositeFrontmatter {
  return {
    schemaVersion: 3,
    composite: true,
    compositeName: COMPOSITE_NAME,
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

function compositeDocPath(): string {
  return path.join(canonicalDir, `${COMPOSITE_NAME}.md`);
}

/**
 * Helper: write a "first synthesis" doc with the given USER-* bodies,
 * simulating the state on disk before a `--regenerate-capabilities` run.
 */
async function seedComposite(opts: {
  autoGenBody: string;
  userRecipes?: string;
  userNotes?: string;
  frontmatter?: Partial<CompositeFrontmatter>;
}): Promise<{ filePath: string; rawBytes: string }> {
  const fm = makeFrontmatter(opts.frontmatter ?? {});
  // Build via spread so we can satisfy `readonly` typing while still
  // making `userRecipes` / `userNotes` conditionally optional.
  const doc = composeCompositeDoc({
    frontmatter: fm,
    autoGenBody: opts.autoGenBody,
    ...(opts.userRecipes !== undefined ? { userRecipes: opts.userRecipes } : {}),
    ...(opts.userNotes !== undefined ? { userNotes: opts.userNotes } : {}),
  });
  const filePath = compositeDocPath();
  await writeCompositeDoc(filePath, doc);
  return { filePath, rawBytes: doc };
}

/* ------------------------------------------------------------------ */
/* regenerateCompositeDoc                                              */
/* ------------------------------------------------------------------ */

describe('regenerateCompositeDoc — USER-* preservation', () => {
  it('preserves USER-RECIPES body byte-for-byte across regenerate', async () => {
    const recipes = 'recipe-1: do thing\nrecipe-2: do other thing';
    await seedComposite({ autoGenBody: 'first body', userRecipes: recipes });

    const result = await regenerateCompositeDoc({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      newFrontmatter: makeFrontmatter({ synthesizedAt: '2026-05-02T01:00:00.000Z' }),
      newAutoGenBody: 'second body — totally different',
      capabilitiesDir,
    });

    expect(result.preservedUserRecipes).toBe(true);
    const newRaw = await fsp.readFile(compositeDocPath(), 'utf8');
    const recipesBlock = extractCompositeUserRecipes(newRaw);
    expect(recipesBlock).toContain('recipe-1: do thing');
    expect(recipesBlock).toContain('recipe-2: do other thing');
    expect(newRaw).toContain('second body');
    expect(newRaw).not.toContain('first body');
  });

  it('preserves USER-NOTES body byte-for-byte across regenerate', async () => {
    const notes = 'Custom user note about quirky behaviour.';
    await seedComposite({ autoGenBody: 'first body', userNotes: notes });

    const result = await regenerateCompositeDoc({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      newFrontmatter: makeFrontmatter({ synthesizedAt: '2026-05-02T02:00:00.000Z' }),
      newAutoGenBody: 'second body',
      capabilitiesDir,
    });

    expect(result.preservedUserNotes).toBe(true);
    const newRaw = await fsp.readFile(compositeDocPath(), 'utf8');
    const notesBlock = extractCompositeUserNotes(newRaw);
    expect(notesBlock).toContain('Custom user note about quirky behaviour.');
  });

  it('preserves both USER-RECIPES and USER-NOTES together', async () => {
    const recipes = 'recipe-A\nrecipe-B';
    const notes = 'note-X';
    await seedComposite({ autoGenBody: 'first', userRecipes: recipes, userNotes: notes });

    const result = await regenerateCompositeDoc({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      newFrontmatter: makeFrontmatter({ synthesizedAt: '2026-05-02T03:00:00.000Z' }),
      newAutoGenBody: 'second',
      capabilitiesDir,
    });

    expect(result.preservedUserRecipes).toBe(true);
    expect(result.preservedUserNotes).toBe(true);
    const newRaw = await fsp.readFile(compositeDocPath(), 'utf8');
    expect(newRaw).toContain('recipe-A');
    expect(newRaw).toContain('recipe-B');
    expect(newRaw).toContain('note-X');
  });

  it('emits empty USER-* blocks when prior doc had empty USER-*', async () => {
    await seedComposite({ autoGenBody: 'first body' /* no user blocks */ });

    const result = await regenerateCompositeDoc({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      newFrontmatter: makeFrontmatter({ synthesizedAt: '2026-05-02T04:00:00.000Z' }),
      newAutoGenBody: 'second',
      capabilitiesDir,
    });

    expect(result.preservedUserRecipes).toBe(false);
    expect(result.preservedUserNotes).toBe(false);
    const newRaw = await fsp.readFile(compositeDocPath(), 'utf8');
    // Markers present but empty bodies (no inner content lines).
    expect(newRaw).toContain('<!-- USER-RECIPES:START -->\n<!-- USER-RECIPES:END -->');
    expect(newRaw).toContain('<!-- USER-NOTES:START -->\n<!-- USER-NOTES:END -->');
  });

  it('preserves multi-line USER-* with markdown formatting', async () => {
    const recipes = [
      '## Recipe 1: list inbox to file',
      '',
      '```sh',
      'outlook-cli inbox list --json | file-cli write inbox.json',
      '```',
      '',
      '## Recipe 2: bullets',
      '- step one',
      '- step two',
    ].join('\n');
    const notes = '# My Notes\n\n*italic* and **bold** survive.';

    await seedComposite({
      autoGenBody: 'first body',
      userRecipes: recipes,
      userNotes: notes,
    });

    await regenerateCompositeDoc({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      newFrontmatter: makeFrontmatter({ synthesizedAt: '2026-05-02T05:00:00.000Z' }),
      newAutoGenBody: 'second body',
      capabilitiesDir,
    });

    const newRaw = await fsp.readFile(compositeDocPath(), 'utf8');
    const recipesBlock = extractCompositeUserRecipes(newRaw);
    const notesBlock = extractCompositeUserNotes(newRaw);
    // Every formatted line must survive verbatim.
    for (const line of recipes.split('\n')) {
      if (line.length > 0) expect(recipesBlock).toContain(line);
    }
    expect(notesBlock).toContain('# My Notes');
    expect(notesBlock).toContain('*italic*');
    expect(notesBlock).toContain('**bold**');
  });

  it('replaces the AUTO-GENERATED block with the new body', async () => {
    await seedComposite({ autoGenBody: 'OLD AUTO BODY' });

    await regenerateCompositeDoc({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      newFrontmatter: makeFrontmatter({ synthesizedAt: '2026-05-02T06:00:00.000Z' }),
      newAutoGenBody: 'NEW AUTO BODY',
      capabilitiesDir,
    });

    const read = await readCompositeDoc(compositeDocPath());
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('post-regen read failed');
    expect(read.doc.autoGeneratedBody).toContain('NEW AUTO BODY');
    expect(read.doc.autoGeneratedBody).not.toContain('OLD AUTO BODY');
  });

  it('changes syntheticDigest when canonical inputs change', async () => {
    await seedComposite({
      autoGenBody: 'body',
      frontmatter: { memberDigests: { 'file-cli': 'aaaa111122223333', 'outlook-cli': 'bbbb444455556666' } },
    });

    const beforeRead = await readCompositeDoc(compositeDocPath());
    expect(beforeRead.ok).toBe(true);
    if (!beforeRead.ok) throw new Error('initial read failed');
    const oldDigest = beforeRead.doc.frontmatter.syntheticDigest;

    const result = await regenerateCompositeDoc({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      newFrontmatter: makeFrontmatter({
        // Different memberDigests ⇒ different canonical inputs ⇒ different digest.
        memberDigests: { 'file-cli': 'cccc777788889999', 'outlook-cli': 'ddddaaaabbbbcccc' },
        synthesizedAt: '2026-05-02T07:00:00.000Z',
      }),
      newAutoGenBody: 'body-v2',
      capabilitiesDir,
    });

    expect(result.previousSyntheticDigest).toBe(oldDigest);
    expect(result.newSyntheticDigest).not.toBe(oldDigest);
    // Verify on-disk frontmatter matches the result.
    const afterRead = await readCompositeDoc(compositeDocPath());
    expect(afterRead.ok).toBe(true);
    if (!afterRead.ok) throw new Error('post read failed');
    expect(afterRead.doc.frontmatter.syntheticDigest).toBe(result.newSyntheticDigest);
  });

  it('keeps the mirror copy in sync with the canonical doc', async () => {
    await seedComposite({ autoGenBody: 'first', userRecipes: 'r1' });

    const result = await regenerateCompositeDoc({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      newFrontmatter: makeFrontmatter({ synthesizedAt: '2026-05-02T08:00:00.000Z' }),
      newAutoGenBody: 'second',
      capabilitiesDir,
    });

    expect(result.mirrorPath).toBe(path.join(capabilitiesDir, `${COMPOSITE_NAME}.md`));
    const canonical = await fsp.readFile(compositeDocPath(), 'utf8');
    const mirror = await fsp.readFile(result.mirrorPath, 'utf8');
    expect(mirror).toBe(canonical);
    // And the user-recipe survived in the mirror too.
    expect(mirror).toContain('r1');
  });

  it('handles first-synthesis path (no prior doc on disk)', async () => {
    // No seed; canonical path does not exist.
    const result = await regenerateCompositeDoc({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      newFrontmatter: makeFrontmatter({ synthesizedAt: '2026-05-02T09:00:00.000Z' }),
      newAutoGenBody: 'first body',
      capabilitiesDir,
    });

    expect(result.preservedUserRecipes).toBe(false);
    expect(result.preservedUserNotes).toBe(false);
    expect(result.previousSyntheticDigest).toBeNull();
    expect(result.newSyntheticDigest).toMatch(/^[0-9a-f]{16}$/);

    const onDisk = await fsp.readFile(compositeDocPath(), 'utf8');
    expect(onDisk).toContain('first body');
    const mirror = await fsp.readFile(result.mirrorPath, 'utf8');
    expect(mirror).toBe(onDisk);
  });
});

/* ------------------------------------------------------------------ */
/* deleteCompositeDocs                                                  */
/* ------------------------------------------------------------------ */

describe('deleteCompositeDocs — canonical + mirror lifecycle', () => {
  async function seedAndMirror(opts: { autoGenBody: string }): Promise<{
    canonical: string;
    mirror: string;
  }> {
    const fm = makeFrontmatter();
    const doc = composeCompositeDoc({ frontmatter: fm, autoGenBody: opts.autoGenBody });
    const canonical = compositeDocPath();
    await writeCompositeDoc(canonical, doc);
    const mirror = path.join(capabilitiesDir, `${COMPOSITE_NAME}.md`);
    await fsp.writeFile(mirror, doc, { mode: 0o600 });
    return { canonical, mirror };
  }

  it('removes canonical + mirror when mirror matches canonical', async () => {
    const { canonical, mirror } = await seedAndMirror({ autoGenBody: 'body' });

    const result = await deleteCompositeDocs({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: canonical,
      capabilitiesDir,
      distillDir,
    });

    expect(result.deleted).toContain(canonical);
    expect(result.deleted).toContain(mirror);
    expect(result.warnings).toEqual([]);
    await expect(fsp.access(canonical)).rejects.toThrow();
    await expect(fsp.access(mirror)).rejects.toThrow();
  });

  it('preserves a user-modified mirror copy and warns', async () => {
    const { canonical, mirror } = await seedAndMirror({ autoGenBody: 'body' });
    // Simulate a user edit to the mirror (out-of-band hand-edit).
    await fsp.writeFile(mirror, 'TOTALLY DIFFERENT CONTENT BY USER', { mode: 0o600 });

    const result = await deleteCompositeDocs({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: canonical,
      capabilitiesDir,
      distillDir,
    });

    expect(result.deleted).toContain(canonical);
    expect(result.deleted).not.toContain(mirror);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('user modifications detected');
    // Mirror still on disk, unchanged.
    const mirrorAfter = await fsp.readFile(mirror, 'utf8');
    expect(mirrorAfter).toBe('TOTALLY DIFFERENT CONTENT BY USER');
  });

  it('never touches Stage-1 distill cache files', async () => {
    const { canonical } = await seedAndMirror({ autoGenBody: 'body' });
    // Drop a fake distill cache entry that mentions one of the members.
    const distillEntry = path.join(distillDir, 'file-cli@a1b2c3d4e5f60718.json');
    const distillBytes = JSON.stringify({
      memberName: 'file-cli',
      content: 'distilled intent surface',
      modelId: 'anthropic:claude-sonnet-4-6',
      templateVersion: 'stage1-v1',
      createdAt: '2026-05-02T00:00:00.000Z',
    });
    await fsp.writeFile(distillEntry, distillBytes, { mode: 0o600 });

    await deleteCompositeDocs({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: canonical,
      capabilitiesDir,
      distillDir,
    });

    // Distill cache survives by design (shared across composites).
    const distillStillThere = await fsp.readFile(distillEntry, 'utf8');
    expect(distillStillThere).toBe(distillBytes);
  });

  it('tolerates a missing canonical doc (returns no warnings, deletes nothing)', async () => {
    // Don't seed at all — both canonical and mirror absent.
    const result = await deleteCompositeDocs({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      capabilitiesDir,
      distillDir,
    });

    expect(result.deleted).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('preserves the mirror with a warning when canonical is missing', async () => {
    // Mirror exists but canonical is gone (rare partial-cleanup state).
    const mirror = path.join(capabilitiesDir, `${COMPOSITE_NAME}.md`);
    await fsp.writeFile(mirror, 'orphan mirror content', { mode: 0o600 });

    const result = await deleteCompositeDocs({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      capabilitiesDir,
      distillDir,
    });

    expect(result.deleted).toEqual([]);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('canonical doc was missing');
    // Mirror still on disk.
    const mirrorAfter = await fsp.readFile(mirror, 'utf8');
    expect(mirrorAfter).toBe('orphan mirror content');
  });

  it('round-trip: regenerate then delete leaves no canonical or mirror', async () => {
    await regenerateCompositeDoc({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      newFrontmatter: makeFrontmatter(),
      newAutoGenBody: 'body',
      capabilitiesDir,
    });

    const result = await deleteCompositeDocs({
      compositeName: COMPOSITE_NAME,
      compositeDocPath: compositeDocPath(),
      capabilitiesDir,
      distillDir,
    });

    expect(result.deleted.length).toBe(2);
    expect(result.warnings).toEqual([]);
  });
});
