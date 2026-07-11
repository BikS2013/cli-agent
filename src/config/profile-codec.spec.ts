/**
 * Unit tests for profile-codec.ts
 *
 * Coverage:
 *   - Round-trip stub parses + stringifies cleanly.
 *   - Malformed YAML throws ConfigurationError with line/col diagnostic (E2).
 *   - Aliases rejected (ADR-PROF-8).
 *   - Both <name>.yaml and <name>.json present -> detectAmbiguity returns
 *     both paths (E18 — loader is responsible for raising the error).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import {
  parseProfile,
  stringifyProfile,
  createProfileStub,
  detectAmbiguity,
} from './profile-codec.js';

// Hermetic in-memory fs for detectAmbiguity (uses fs.accessSync).
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const present = new Set<string>();
  const accessSync = vi.fn().mockImplementation((p: string) => {
    if (present.has(String(p))) return undefined;
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    throw err;
  });
  const constants = { F_OK: 0 };
  // Expose `present` for tests via a custom property.
  return {
    ...actual,
    accessSync,
    constants,
    default: { ...actual, accessSync, constants },
    __present: present,
  };
});

async function getPresentSet(): Promise<Set<string>> {
  const mod = (await import('node:fs')) as unknown as { __present: Set<string> };
  return mod.__present;
}

describe('createProfileStub + parseProfile (round-trip)', () => {
  it('emits a YAML stub with name + schemaVersion + commented sections', () => {
    const text = createProfileStub('review');
    expect(text).toMatch(/name: review/);
    expect(text).toMatch(/schemaVersion: 1/);
    expect(text).toMatch(/# cliParams:/);
    expect(text).toMatch(/# tools:/);
    expect(text).toMatch(/# toolArgs:/);
  });

  it('parseProfile accepts the stub output', () => {
    const text = createProfileStub('demo');
    const profile = parseProfile(text, '/fake/path/demo.yaml');
    expect(profile.name).toBe('demo');
    expect(profile.schemaVersion).toBe(1);
    expect(profile.cliParams).toBeUndefined();
    expect(profile.tools).toBeUndefined();
    expect(profile.toolArgs).toBeUndefined();
  });
});

describe('stringifyProfile', () => {
  it('round-trips a populated profile through parse', () => {
    const original = {
      name: 'demo',
      schemaVersion: 1 as const,
      cliParams: { provider: 'openai', model: 'gpt-4o', temperature: 0.5 },
      tools: { allow: ['bash_run'] },
    };
    const text = stringifyProfile(original);
    const parsed = parseProfile(text, '/fake/demo.yaml');
    expect(parsed.name).toBe('demo');
    expect(parsed.cliParams?.provider).toBe('openai');
    expect(parsed.tools?.allow).toEqual(['bash_run']);
  });
});

describe('parseProfile — error handling', () => {
  it('E2: malformed YAML throws ConfigurationError with line/col diagnostic', () => {
    // Bad indentation: the value is at the wrong level relative to its key.
    const bad = [
      'name: foo',
      'cliParams:',
      '  provider: openai',
      ' model: gpt-4o', // odd indent -> indentation error
    ].join('\n');
    try {
      parseProfile(bad, '/fake/bad.yaml');
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
      expect((e as { exitCode?: number }).exitCode).toBe(3);
      const details = (e as { details?: Record<string, unknown> }).details;
      const detail = String(details?.['detail'] ?? '');
      // The detail message should mention "line N, column M".
      expect(detail).toMatch(/line \d+, column \d+/);
    }
  });

  it('rejects YAML alias nodes (ADR-PROF-8)', () => {
    const aliased = [
      'name: foo',
      'common: &common',
      '  provider: openai',
      'cliParams: *common',
    ].join('\n');
    try {
      parseProfile(aliased, '/fake/aliased.yaml');
      throw new Error('expected throw');
    } catch (e) {
      const detail = String(
        (e as { details?: Record<string, unknown> }).details?.['detail'] ?? '',
      );
      expect(detail).toMatch(/alias/i);
    }
  });

  it('surfaces all Zod issues at once for schema failures', () => {
    const bad = [
      'name: foo',
      'schemaVersion: 1',
      'tools:',
      '  allow: []', // E6
      'cliParams:',
      '  temperature: "hot"', // type error
    ].join('\n');
    try {
      parseProfile(bad, '/fake/bad.yaml');
      throw new Error('expected throw');
    } catch (e) {
      const detail = String(
        (e as { details?: Record<string, unknown> }).details?.['detail'] ?? '',
      );
      expect(detail).toMatch(/Schema validation failed/);
      expect(detail).toMatch(/tools\.allow|cliParams\.temperature/);
    }
  });
});

describe('detectAmbiguity (E18)', () => {
  beforeEach(async () => {
    const present = await getPresentSet();
    present.clear();
  });

  it('returns empty when no extension exists', () => {
    expect(detectAmbiguity('/agent', 'missing')).toEqual({});
  });

  it('returns yaml-only when only the yaml file exists', async () => {
    const present = await getPresentSet();
    present.add(path.join('/agent', 'profiles', 'demo.yaml'));
    expect(detectAmbiguity('/agent', 'demo')).toEqual({
      yaml: path.join('/agent', 'profiles', 'demo.yaml'),
    });
  });

  it('returns yml when only the .yml file exists', async () => {
    const present = await getPresentSet();
    present.add(path.join('/agent', 'profiles', 'demo.yml'));
    expect(detectAmbiguity('/agent', 'demo')).toEqual({
      yaml: path.join('/agent', 'profiles', 'demo.yml'),
    });
  });

  it('returns BOTH yaml and json paths when both exist (caller raises E18)', async () => {
    const present = await getPresentSet();
    present.add(path.join('/agent', 'profiles', 'demo.yaml'));
    present.add(path.join('/agent', 'profiles', 'demo.json'));
    const out = detectAmbiguity('/agent', 'demo');
    expect(out.yaml).toBe(path.join('/agent', 'profiles', 'demo.yaml'));
    expect(out.json).toBe(path.join('/agent', 'profiles', 'demo.json'));
  });

  it('prefers .yaml over .yml when both yaml-style files exist', async () => {
    const present = await getPresentSet();
    present.add(path.join('/agent', 'profiles', 'demo.yaml'));
    present.add(path.join('/agent', 'profiles', 'demo.yml'));
    expect(detectAmbiguity('/agent', 'demo').yaml).toBe(
      path.join('/agent', 'profiles', 'demo.yaml'),
    );
  });
});

describe('parseProfile — legacy group-toggle keys (plan-015)', () => {
  it.each(['composites', 'builtin', 'agentTools'])(
    "throws ConfigurationError with the cliParams.mode migration hint for tools.%s",
    (key) => {
      const text = `name: p\nschemaVersion: 1\ntools:\n  ${key}: true\n`;
      try {
        parseProfile(text, '/agent/profiles/p.yaml');
        throw new Error('expected throw');
      } catch (e) {
        expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
        // The actionable hint must be in the user-visible MESSAGE …
        expect((e as Error).message).toMatch(/removed \(plan-015\)/);
        expect((e as Error).message).toContain('cliParams.mode');
        expect((e as Error).message).toContain(`tools.${key}`);
        // … and mirrored in details.detail per this codec's convention.
        const detail = String(
          (e as { details?: Record<string, unknown> }).details?.['detail'] ?? '',
        );
        expect(detail).toContain('cliParams.mode');
      }
    },
  );

  it('a profile pinning cliParams.mode round-trips', () => {
    const text = 'name: p\nschemaVersion: 1\ncliParams:\n  mode: basic\n';
    const profile = parseProfile(text, '/agent/profiles/p.yaml');
    expect(profile.cliParams?.mode).toBe('basic');
    const rendered = stringifyProfile(profile);
    expect(parseProfile(rendered, '/agent/profiles/p.yaml').cliParams?.mode).toBe('basic');
  });
});
