/**
 * Unit tests for profile-schema.ts
 *
 * Coverage:
 *   - Valid stub round-trips through ProfileSchema.parse without warnings.
 *   - Unknown top-level key is rejected (E3).
 *   - Empty `tools.allow` array is rejected by `.min(1)` (E6).
 *   - Credential-shape key in `cliParams` is rejected by validateNoSecrets (E11).
 *   - Unknown `cliParams` key is preserved (passthrough) and shows up as a
 *     non-known entry vs. KNOWN_CLI_PARAMS (E20 — warn-pass, not error).
 */

import { describe, it, expect } from 'vitest';
import {
  ProfileSchema,
  KNOWN_CLI_PARAMS,
  CREDENTIAL_KEY_PATTERN,
  validateNoSecrets,
} from './profile-schema.js';

describe('ProfileSchema', () => {
  it('accepts a valid minimal profile (just schemaVersion)', () => {
    const result = ProfileSchema.safeParse({ schemaVersion: 1 });
    expect(result.success).toBe(true);
  });

  it('accepts a fully-populated valid profile stub', () => {
    const stub = {
      name: 'review',
      description: 'read-only code review',
      schemaVersion: 1,
      cliParams: {
        provider: 'anthropic',
        model: 'claude-3-5-sonnet-20241022',
        temperature: 0.7,
        maxIterations: 25,
        allowMutations: false,
      },
      tools: {
        allow: ['file_read', 'bash_run'],
        deny: ['file_write'],
        order: ['bash_run', 'file_read'],
      },
      toolArgs: {
        web_search: { maxResults: 10 },
      },
    };
    const result = ProfileSchema.safeParse(stub);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.cliParams?.provider).toBe('anthropic');
    }
  });

  it('defaults schemaVersion to 1 when missing', () => {
    const result = ProfileSchema.safeParse({ name: 'foo' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe(1);
    }
  });

  it('E3: rejects unknown top-level keys (.strict())', () => {
    const result = ProfileSchema.safeParse({
      schemaVersion: 1,
      unknownTopKey: 'bogus',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join(' | ');
      // zod surfaces unrecognized_keys
      expect(messages.toLowerCase()).toMatch(/unrecognized|unknown/);
    }
  });

  it('E6: rejects tools.allow: [] (empty array)', () => {
    const result = ProfileSchema.safeParse({
      schemaVersion: 1,
      tools: { allow: [] },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join('.'));
      expect(paths.some((p) => p.startsWith('tools.allow'))).toBe(true);
    }
  });

  it('E20: passes through unknown cliParams keys without rejecting', () => {
    const result = ProfileSchema.safeParse({
      schemaVersion: 1,
      cliParams: { provider: 'openai', futureKnob: 'mystery' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(
        (result.data.cliParams as Record<string, unknown> | undefined)?.['futureKnob'],
      ).toBe('mystery');
    }
  });

  it('rejects an invalid schemaVersion literal', () => {
    const result = ProfileSchema.safeParse({ schemaVersion: 2 });
    expect(result.success).toBe(false);
  });
});

describe('KNOWN_CLI_PARAMS', () => {
  it('includes the eight tier-5 pinnable knobs', () => {
    for (const knob of [
      'provider',
      'model',
      'temperature',
      'maxIterations',
      'workingDir',
      'logLevel',
      'webSearchBackend',
      'allowMutations',
    ]) {
      expect(KNOWN_CLI_PARAMS.has(knob)).toBe(true);
    }
  });

  it('does not contain mystery keys (used for warn-pass diff)', () => {
    expect(KNOWN_CLI_PARAMS.has('futureKnob')).toBe(false);
  });
});

describe('CREDENTIAL_KEY_PATTERN', () => {
  it.each([
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'MY_TOKEN',
    'github_token',
    'CLIENT_SECRET',
    'DB_PASSWORD',
  ])('matches credential-shape key %s', (key) => {
    expect(CREDENTIAL_KEY_PATTERN.test(key)).toBe(true);
  });

  it.each(['provider', 'model', 'temperature', 'tokenizer', 'apikeyish'])(
    'does NOT match non-credential key %s',
    (key) => {
      expect(CREDENTIAL_KEY_PATTERN.test(key)).toBe(false);
    },
  );
});

describe('validateNoSecrets (E11)', () => {
  it('returns void on a clean cliParams object', () => {
    expect(() =>
      validateNoSecrets({ provider: 'openai', model: 'gpt-4o' }),
    ).not.toThrow();
  });

  it('accepts an empty record', () => {
    expect(() => validateNoSecrets({})).not.toThrow();
  });

  it('throws ConfigurationError when a credential-shape key is present', () => {
    try {
      validateNoSecrets({ OPENAI_API_KEY: 'sk-leaked' });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
      const detail = String(
        (e as { details?: Record<string, unknown> }).details?.['detail'] ?? '',
      );
      expect(detail).toMatch(/credential-shape/);
    }
  });

  it('error carries E_CONFIG_MISSING code (exit 3)', () => {
    try {
      validateNoSecrets({ MY_TOKEN: 'x' });
      throw new Error('expected throw');
    } catch (e) {
      expect((e as { code?: string }).code).toBe('E_CONFIG_MISSING');
      expect((e as { exitCode?: number }).exitCode).toBe(3);
    }
  });

  it('reports all offending keys at once', () => {
    try {
      validateNoSecrets({
        provider: 'openai',
        OPENAI_API_KEY: 'x',
        DB_PASSWORD: 'y',
      });
      throw new Error('expected throw');
    } catch (e) {
      const details = (e as { details?: Record<string, unknown> }).details;
      const offenders = details?.['offendingKeys'] as string[] | undefined;
      expect(offenders).toEqual(
        expect.arrayContaining(['OPENAI_API_KEY', 'DB_PASSWORD']),
      );
    }
  });
});
