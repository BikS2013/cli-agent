/**
 * Co-located tests for `composeCompositeDoc.ts` (plan-006 P5).
 */

import { describe, it, expect } from 'vitest';
import { composeCompositeDoc } from './composeCompositeDoc.js';
import {
  canonicaliseSyntheticInputs,
  computeSyntheticDigest,
} from './cache.js';
import type { CompositeFrontmatter } from './types.js';

function makeFrontmatter(): CompositeFrontmatter {
  return {
    schemaVersion: 3,
    composite: true,
    compositeName: 'foo-plus-bar',
    members: ['foo', 'bar'],
    memberDigests: { foo: 'aaaaaaaaaaaaaaaa', bar: 'bbbbbbbbbbbbbbbb' },
    synthesizedAt: '2026-05-02T00:00:00.000Z',
    syntheticDigest: 'IGNORED_BY_COMPOSER',
    cliAgentVersion: '0.3.0',
    synthesisModel: 'anthropic:claude-sonnet-4-6',
    activeProfile: null,
    manRef: null,
    manPagePath: null,
  };
}

describe('composeCompositeDoc', () => {
  it('emits the schema-3 frontmatter in canonical key order', () => {
    const fm = makeFrontmatter();
    const doc = composeCompositeDoc({
      frontmatter: fm,
      autoGenBody: '## body',
    });
    const fmMatch = doc.match(/^---\n([\s\S]*?)\n---/);
    expect(fmMatch).not.toBeNull();
    const yaml = fmMatch![1]!;
    const lines = yaml.split('\n');
    // First non-list lines must follow the canonical order.
    const flatKeys = lines
      .filter((l) => /^[a-zA-Z][a-zA-Z0-9_]*:/.test(l))
      .map((l) => l.split(':')[0]!);
    // Spot-check key prefixes: schemaVersion appears first; manPagePath last.
    expect(flatKeys[0]).toBe('schemaVersion');
    expect(flatKeys.at(-1)).toBe('manPagePath');
    // composite must be the second top-level key.
    expect(flatKeys[1]).toBe('composite');
  });

  it('overwrites caller-supplied syntheticDigest with the canonical recompute', () => {
    const fm = makeFrontmatter();
    const expected = computeSyntheticDigest(
      canonicaliseSyntheticInputs({
        schemaVersion: fm.schemaVersion,
        compositeName: fm.compositeName,
        members: fm.members,
        memberDigests: fm.memberDigests,
        cliAgentVersion: fm.cliAgentVersion,
        synthesisModel: fm.synthesisModel,
      }),
    );
    const doc = composeCompositeDoc({
      frontmatter: fm,
      autoGenBody: 'body',
    });
    expect(doc).toContain(`syntheticDigest: ${expected}`);
    expect(doc).not.toContain('IGNORED_BY_COMPOSER');
  });

  it('emits all required AUTO-GEN / USER-RECIPES / USER-NOTES markers', () => {
    const doc = composeCompositeDoc({
      frontmatter: makeFrontmatter(),
      autoGenBody: 'body',
    });
    expect(doc).toContain('<!-- AUTO-GENERATED:START hash=');
    expect(doc).toContain('<!-- AUTO-GENERATED:END -->');
    expect(doc).toContain('<!-- USER-RECIPES:START -->');
    expect(doc).toContain('<!-- USER-RECIPES:END -->');
    expect(doc).toContain('<!-- USER-NOTES:START -->');
    expect(doc).toContain('<!-- USER-NOTES:END -->');
  });

  it('throws ConfigurationError on empty autoGenBody', () => {
    expect(() =>
      composeCompositeDoc({
        frontmatter: makeFrontmatter(),
        autoGenBody: '   \n  \n',
      }),
    ).toThrow(/autoGenBody/);
  });

  it('emits manRef and manPagePath as literal `null`', () => {
    const doc = composeCompositeDoc({
      frontmatter: makeFrontmatter(),
      autoGenBody: 'body',
    });
    expect(doc).toContain('\nmanRef: null');
    expect(doc).toContain('\nmanPagePath: null');
  });

  it('emits members as a sorted block list', () => {
    const fm: CompositeFrontmatter = {
      ...makeFrontmatter(),
      members: ['zzz', 'aaa', 'mmm'],
      memberDigests: {
        zzz: 'a'.repeat(16),
        aaa: 'b'.repeat(16),
        mmm: 'c'.repeat(16),
      },
    };
    const doc = composeCompositeDoc({ frontmatter: fm, autoGenBody: 'body' });
    const memberMatch = doc.match(/members:\n((?:  - [^\n]+\n)+)/u);
    expect(memberMatch).not.toBeNull();
    const items = memberMatch![1]!
      .split('\n')
      .filter((l) => l.startsWith('  - '))
      .map((l) => l.slice(4));
    expect(items).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('writes USER-RECIPES body when supplied', () => {
    const doc = composeCompositeDoc({
      frontmatter: makeFrontmatter(),
      autoGenBody: 'body',
      userRecipes: 'r1\nr2',
    });
    expect(doc).toContain('<!-- USER-RECIPES:START -->\nr1\nr2\n<!-- USER-RECIPES:END -->');
  });

  it('preserves empty USER-* blocks when bodies are omitted', () => {
    const doc = composeCompositeDoc({
      frontmatter: makeFrontmatter(),
      autoGenBody: 'body',
    });
    expect(doc).toContain('<!-- USER-RECIPES:START -->\n<!-- USER-RECIPES:END -->');
    expect(doc).toContain('<!-- USER-NOTES:START -->\n<!-- USER-NOTES:END -->');
  });
});
