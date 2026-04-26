/**
 * Cache read/write tests, with USER-NOTES preservation.
 */

import { describe, it, expect, vi } from 'vitest';
import { extractUserNotes } from '../capabilities/composeMarkdown.js';
import { composeCapabilityDoc } from '../capabilities/composeMarkdown.js';

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
    expect(doc).toContain('schemaVersion: 1');
    expect(doc).toContain('tool: test');
  });
});
