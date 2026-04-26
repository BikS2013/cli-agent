import { describe, it, expect } from 'vitest';
import { parseAllowlistEntries, buildAllowlistMatcher } from './allowlist.js';

describe('parseAllowlistEntries', () => {
  it('parses binary name entries', () => {
    const entries = parseAllowlistEntries(['git', 'gh', 'kubectl']);
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ kind: 'binary', name: 'git' });
  });

  it('parses argv-regex entries', () => {
    const entries = parseAllowlistEntries(['argv-regex:^git status$']);
    expect(entries[0]).toMatchObject({ kind: 'argv-regex' });
  });
});

describe('buildAllowlistMatcher', () => {
  it('matches binary by name', () => {
    const entries = parseAllowlistEntries(['git']);
    const matcher = buildAllowlistMatcher(entries);
    expect(matcher.test('git', [])).toBe(true);
    expect(matcher.test('gh', [])).toBe(false);
  });

  it('matches binary by basename when full path given', () => {
    const entries = parseAllowlistEntries(['git']);
    const matcher = buildAllowlistMatcher(entries);
    // The matcher extracts the basename ('git') from '/usr/bin/git', so it matches
    expect(matcher.test('/usr/bin/git', [])).toBe(true);
    expect(matcher.test('git', ['status'])).toBe(true);
    // A different binary should not match
    expect(matcher.test('/usr/bin/curl', [])).toBe(false);
  });

  it('matches argv-regex entry', () => {
    const entries = parseAllowlistEntries(['argv-regex:^git (status|diff)( .*)?$']);
    const matcher = buildAllowlistMatcher(entries);
    expect(matcher.test('git', ['status'])).toBe(true);
    expect(matcher.test('git', ['push'])).toBe(false);
  });

  it('isEmpty returns true for empty allowlist', () => {
    const matcher = buildAllowlistMatcher([]);
    expect(matcher.isEmpty()).toBe(true);
  });

  it('getBinaryNames excludes argv-regex patterns', () => {
    const entries = parseAllowlistEntries(['git', 'argv-regex:^kubectl get .*$']);
    const matcher = buildAllowlistMatcher(entries);
    const names = matcher.getBinaryNames();
    expect(names).toContain('git');
    expect(names).not.toContain('argv-regex:^kubectl get .*$');
  });
});
