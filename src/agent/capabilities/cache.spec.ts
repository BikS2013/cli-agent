/**
 * Cache read/write tests, with USER-NOTES + USER-RECIPES preservation
 * and the schema-1 → schema-2 migration path.
 */

import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import {
  CAPABILITY_SCHEMA_VERSION,
  composeCapabilityDoc,
  extractUserNotes,
  extractUserRecipes,
  extractUserRecipesBody,
  extractManualReferenceBody,
} from '../capabilities/composeMarkdown.js';
import { readCacheEntry, writeCacheEntry } from '../capabilities/cache.js';

const SAMPLE_DOC = `---
tool: git
binaryPath: /usr/bin/git
binaryMtimeMs: 1000000
versionString: "git version 2.45.0"
versionHash: sha256:abc123
introspectedAt: 2026-04-26T00:00:00Z
introspectionDepth: 2
introspectionBytes: 1000
schemaVersion: 1
---

<!-- AUTO-GENERATED:START hash=test123 -->
# git — capability document

## Top-level synopsis

\`\`\`
usage: git [options] <command>
\`\`\`
<!-- AUTO-GENERATED:END -->

<!-- USER-NOTES:START -->
- We use git switch not git checkout
- All pushes require --force-with-lease
<!-- USER-NOTES:END -->
`;

describe('extractUserNotes', () => {
  it('extracts USER-NOTES section verbatim', () => {
    const notes = extractUserNotes(SAMPLE_DOC);
    expect(notes).toContain('We use git switch not git checkout');
    expect(notes).toContain('USER-NOTES:START');
    expect(notes).toContain('USER-NOTES:END');
  });

  it('returns empty string when no USER-NOTES present', () => {
    const notes = extractUserNotes('# Some doc\n\nNo notes here.');
    expect(notes).toBe('');
  });
});

describe('composeCapabilityDoc', () => {
  it('preserves USER-NOTES across regeneration', () => {
    const newDoc = composeCapabilityDoc(
      {
        tool: 'git',
        binaryPath: '/usr/bin/git',
        binaryMtimeMs: 2000000,
        versionString: 'git version 2.46.0',
        versionHash: 'sha256:newhhash',
        introspectionDepth: 2,
        introspectionBytes: 1200,
        topLevelHelp: 'usage: git [options]',
        subcommands: [],
      },
      SAMPLE_DOC,
    );

    expect(newDoc).toContain('We use git switch not git checkout');
    expect(newDoc).toContain('All pushes require --force-with-lease');
  });

  it('includes AUTO-GENERATED markers', () => {
    const doc = composeCapabilityDoc({
      tool: 'git',
      binaryPath: '/usr/bin/git',
      binaryMtimeMs: 1000,
      versionString: 'git 2.45',
      versionHash: 'sha256:hash',
      introspectionDepth: 1,
      introspectionBytes: 100,
      topLevelHelp: 'usage: git',
      subcommands: [],
    });
    expect(doc).toContain('AUTO-GENERATED:START');
    expect(doc).toContain('AUTO-GENERATED:END');
  });

  it('includes YAML frontmatter with schemaVersion', () => {
    const doc = composeCapabilityDoc({
      tool: 'test',
      binaryPath: '/usr/bin/test',
      binaryMtimeMs: 1000,
      versionString: '1.0',
      versionHash: 'sha256:hash',
      introspectionDepth: 1,
      introspectionBytes: 50,
      topLevelHelp: 'usage: test',
      subcommands: [],
    });
    expect(doc).toContain(`schemaVersion: ${CAPABILITY_SCHEMA_VERSION}`);
    expect(doc).toContain('tool: test');
  });

  it('emits an empty USER-RECIPES marker pair on a fresh document', () => {
    const doc = composeCapabilityDoc({
      tool: 'test',
      binaryPath: '/usr/bin/test',
      binaryMtimeMs: 1,
      versionString: '1.0',
      versionHash: 'sha256:h',
      introspectionDepth: 1,
      introspectionBytes: 10,
      topLevelHelp: 'usage: test',
      subcommands: [],
    });
    expect(doc).toContain('<!-- USER-RECIPES:START -->');
    expect(doc).toContain('<!-- USER-RECIPES:END -->');
    // USER-RECIPES must appear before USER-NOTES.
    expect(doc.indexOf('<!-- USER-RECIPES:START -->'))
      .toBeLessThan(doc.indexOf('<!-- USER-NOTES:START -->'));
  });

  it('preserves USER-RECIPES content across regeneration', () => {
    const seeded = composeCapabilityDoc({
      tool: 'git',
      binaryPath: '/usr/bin/git',
      binaryMtimeMs: 1,
      versionString: 'git 2.45',
      versionHash: 'sha256:h',
      introspectionDepth: 2,
      introspectionBytes: 100,
      topLevelHelp: 'usage: git',
      subcommands: [],
    });
    const userEdited = seeded.replace(
      '<!-- USER-RECIPES:START -->\n<!-- USER-RECIPES:END -->',
      [
        '<!-- USER-RECIPES:START -->',
        '### Commit staged changes',
        '```bash',
        'git commit -m "<message>"',
        '```',
        '<!-- USER-RECIPES:END -->',
      ].join('\n'),
    );

    const refreshed = composeCapabilityDoc(
      {
        tool: 'git',
        binaryPath: '/usr/bin/git',
        binaryMtimeMs: 2,
        versionString: 'git 2.46',
        versionHash: 'sha256:h2',
        introspectionDepth: 2,
        introspectionBytes: 120,
        topLevelHelp: 'usage: git',
        subcommands: [],
      },
      userEdited,
    );

    expect(refreshed).toContain('### Commit staged changes');
    expect(refreshed).toContain('git commit -m "<message>"');
    expect(extractUserRecipesBody(refreshed)).toContain('Commit staged changes');
  });

  it('emits manRef frontmatter and inline section when manRef provided', () => {
    const doc = composeCapabilityDoc({
      tool: 'git',
      binaryPath: '/usr/bin/git',
      binaryMtimeMs: 1,
      versionString: 'git 2.45',
      versionHash: 'sha256:h',
      introspectionDepth: 2,
      introspectionBytes: 100,
      topLevelHelp: 'usage: git',
      subcommands: [],
      manRef: 'man:1 git',
      manPagePath: '/usr/share/man/man1/git.1.gz',
    });
    expect(doc).toContain('manRef: man:1 git');
    expect(doc).toContain('manPagePath: /usr/share/man/man1/git.1.gz');
    expect(doc).toContain('## Manual reference');
    expect(doc).toContain('man 1 git');
    expect(extractManualReferenceBody(doc)).toContain('man 1 git');
  });

  it('omits manRef artifacts entirely when manRef is null', () => {
    const doc = composeCapabilityDoc({
      tool: 'mytool',
      binaryPath: '/x/mytool',
      binaryMtimeMs: 1,
      versionString: '0.1',
      versionHash: 'sha256:h',
      introspectionDepth: 1,
      introspectionBytes: 10,
      topLevelHelp: 'usage: mytool',
      subcommands: [],
      manRef: null,
    });
    expect(doc).not.toContain('manRef:');
    expect(doc).not.toContain('manPagePath:');
    expect(doc).not.toContain('## Manual reference');
    expect(extractManualReferenceBody(doc)).toBe('');
  });
});

describe('extractUserRecipes / extractUserRecipesBody', () => {
  it('returns empty string when markers absent', () => {
    expect(extractUserRecipes('# no markers')).toBe('');
    expect(extractUserRecipesBody('# no markers')).toBe('');
  });

  it('returns body trimmed when markers present', () => {
    const doc = [
      '<!-- USER-RECIPES:START -->',
      '### Recipe one',
      '```bash',
      'echo hi',
      '```',
      '<!-- USER-RECIPES:END -->',
    ].join('\n');
    expect(extractUserRecipesBody(doc)).toContain('Recipe one');
    expect(extractUserRecipesBody(doc)).not.toContain('USER-RECIPES:START');
  });
});

describe('readCacheEntry — schema migration', () => {
  it('treats schema-1 docs as cache miss (forces re-discovery)', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cache-'));
    const v1Doc = [
      '---',
      'tool: git',
      'binaryPath: /usr/bin/git',
      'binaryMtimeMs: 1',
      'versionString: ""',
      'versionHash: x',
      'introspectedAt: 2026-04-26T00:00:00Z',
      'introspectionDepth: 2',
      'introspectionBytes: 10',
      'schemaVersion: 1',
      '---',
      '',
      '<!-- AUTO-GENERATED:START hash=h -->',
      '# git',
      '<!-- AUTO-GENERATED:END -->',
      '',
      '<!-- USER-NOTES:START -->',
      'legacy notes',
      '<!-- USER-NOTES:END -->',
    ].join('\n');
    await fsp.writeFile(path.join(tmp, 'git.md'), v1Doc, 'utf8');

    const entry = await readCacheEntry(tmp, 'git');
    expect(entry).toBeNull();
  });

  it('reads schema-2 docs and surfaces userRecipes + manRef fields', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-cache-'));
    const doc = composeCapabilityDoc({
      tool: 'git',
      binaryPath: '/usr/bin/git',
      binaryMtimeMs: 1,
      versionString: 'git 2.45',
      versionHash: 'sha256:h',
      introspectionDepth: 2,
      introspectionBytes: 100,
      topLevelHelp: 'usage: git',
      subcommands: [],
      manRef: 'man:1 git',
      manPagePath: '/usr/share/man/man1/git.1.gz',
    });
    const userEdited = doc.replace(
      '<!-- USER-RECIPES:START -->\n<!-- USER-RECIPES:END -->',
      '<!-- USER-RECIPES:START -->\n### Recipe\n<!-- USER-RECIPES:END -->',
    );
    await writeCacheEntry(tmp, 'git', userEdited);

    const entry = await readCacheEntry(tmp, 'git');
    expect(entry).not.toBeNull();
    expect(entry!.frontmatter.schemaVersion).toBe(CAPABILITY_SCHEMA_VERSION);
    expect(entry!.frontmatter.manRef).toBe('man:1 git');
    expect(entry!.frontmatter.manPagePath).toBe('/usr/share/man/man1/git.1.gz');
    expect(entry!.userRecipes).toContain('### Recipe');
  });
});
