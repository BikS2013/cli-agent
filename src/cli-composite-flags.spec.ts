/**
 * Unit tests for U-FLAGS — composite-tool CLI flag plumbing.
 *
 * The matrix being exercised is the canonical §14.H table from
 * `docs/design/project-design.md`. Every row is covered by at least
 * one positive and one negative case (where applicable), plus the
 * regression identity for the "no `--treat-as-tool`" path
 * (NFR-CMP-001 byte-stability).
 *
 * The spec file deliberately avoids importing from `src/cli.ts`
 * because that module has a Commander parse side-effect at the
 * bottom (`program.parseAsync(process.argv)`) which would call
 * `process.exit` against vitest's argv. Instead it imports the pure
 * helpers `parseCompositeFlags` / `enforceCompositeFlagMatrix` from
 * `src/cli-composite-flags.ts`. The byte-stability concern for
 * `--help` is asserted in `src/cli-help-baseline.spec.ts`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  parseCompositeFlags,
  enforceCompositeFlagMatrix,
  DEFAULT_SYNTHESIS_BUDGET_TOKENS,
  type CompositeCliFlags,
} from './cli-composite-flags.js';
import { UsageError } from './errors.js';

/**
 * Build a `CompositeCliFlags` value with all booleans `false` and
 * the spec-default budget. Spec cases override the fields they
 * exercise. Centralising the "everything off" baseline keeps each
 * test focused on the cell under test.
 */
function flags(overrides: Partial<CompositeCliFlags> = {}): CompositeCliFlags {
  return {
    treatAsTool: false,
    compositeName: null,
    emitDoc: false,
    emitWrapper: false,
    emitWrapperOnPath: false,
    registerVirtual: false,
    regenerateCapabilities: false,
    dryRunSynthesis: false,
    synthesisBudgetTokens: DEFAULT_SYNTHESIS_BUDGET_TOKENS,
    forceOverwrite: false,
    ...overrides,
  };
}

describe('parseCompositeFlags', () => {
  const savedEnv = { ...process.env };
  afterEach(() => {
    // Restore env so the budget-resolution tests don't leak.
    process.env = { ...savedEnv };
  });

  it('returns all-false defaults when opts is empty', () => {
    const out = parseCompositeFlags({});
    expect(out.treatAsTool).toBe(false);
    expect(out.compositeName).toBeNull();
    expect(out.emitDoc).toBe(false); // default off when --treat-as-tool absent
    expect(out.emitWrapper).toBe(false);
    expect(out.emitWrapperOnPath).toBe(false);
    expect(out.registerVirtual).toBe(false);
    expect(out.regenerateCapabilities).toBe(false);
    expect(out.dryRunSynthesis).toBe(false);
    expect(out.forceOverwrite).toBe(false);
  });

  it('defaults emitDoc=true when --treat-as-tool is set', () => {
    const out = parseCompositeFlags({ treatAsTool: true });
    expect(out.emitDoc).toBe(true);
  });

  it('honours explicit --no-emit-doc over the implicit default', () => {
    const out = parseCompositeFlags({ treatAsTool: true, emitDoc: false });
    expect(out.emitDoc).toBe(false);
  });

  it('honours explicit --emit-doc when --treat-as-tool is set', () => {
    const out = parseCompositeFlags({ treatAsTool: true, emitDoc: true });
    expect(out.emitDoc).toBe(true);
  });

  it('reads compositeName as a string when supplied', () => {
    const out = parseCompositeFlags({ compositeName: 'my-composite' });
    expect(out.compositeName).toBe('my-composite');
  });

  it('returns null compositeName for empty string', () => {
    const out = parseCompositeFlags({ compositeName: '' });
    expect(out.compositeName).toBeNull();
  });

  it('uses CLI synthesisBudgetTokens when supplied (overrides env)', () => {
    process.env['CLI_AGENT_COMPOSITE_BUDGET'] = '99999';
    const out = parseCompositeFlags({ synthesisBudgetTokens: 4096 });
    expect(out.synthesisBudgetTokens).toBe(4096);
  });

  it('falls through to CLI_AGENT_COMPOSITE_BUDGET when no CLI flag', () => {
    process.env['CLI_AGENT_COMPOSITE_BUDGET'] = '16384';
    const out = parseCompositeFlags({});
    expect(out.synthesisBudgetTokens).toBe(16384);
  });

  it('falls through to spec default 32_768 when neither CLI nor env', () => {
    delete process.env['CLI_AGENT_COMPOSITE_BUDGET'];
    const out = parseCompositeFlags({});
    expect(out.synthesisBudgetTokens).toBe(DEFAULT_SYNTHESIS_BUDGET_TOKENS);
    expect(DEFAULT_SYNTHESIS_BUDGET_TOKENS).toBe(32_768);
  });

  it('falls through to default when env var is non-numeric', () => {
    process.env['CLI_AGENT_COMPOSITE_BUDGET'] = 'not-a-number';
    const out = parseCompositeFlags({});
    expect(out.synthesisBudgetTokens).toBe(DEFAULT_SYNTHESIS_BUDGET_TOKENS);
  });

  it('does not throw on any input combination (pure normaliser)', () => {
    expect(() =>
      parseCompositeFlags({
        treatAsTool: true,
        compositeName: 'x',
        emitDoc: false,
        emitWrapper: true,
        emitWrapperOnPath: true,
        registerVirtual: true,
        regenerateCapabilities: true,
        dryRunSynthesis: true,
        synthesisBudgetTokens: 1024,
        forceOverwrite: true,
      }),
    ).not.toThrow();
  });
});

describe('enforceCompositeFlagMatrix — §14.H canonical matrix', () => {
  /* ====================================================================
   * Row group 0 — bare invocation / identity (NFR-CMP-001)
   * ==================================================================== */
  describe('row 0: bare invocation', () => {
    it('no-op when no composite flags are present (identity)', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags(), { tools: [], argv: [] }),
      ).not.toThrow();
    });

    it('no-op when only unrelated argv tokens are present', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags(), {
          tools: ['ls'],
          argv: ['--tool', 'ls', 'do something'],
        }),
      ).not.toThrow();
    });

    it('no-op for normal --help (no --treat-as-tool)', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags(), {
          tools: [],
          help: true,
          argv: ['--help'],
        }),
      ).not.toThrow();
    });
  });

  /* ====================================================================
   * Row 1 — catch-all "<flag> requires --treat-as-tool"
   * ==================================================================== */
  describe('row 1: catch-all "<flag> requires --treat-as-tool"', () => {
    it('--composite-name without --treat-as-tool → ERR-2', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags({ compositeName: 'foo' }), {
          tools: [],
          argv: ['--composite-name', 'foo'],
        }),
      ).toThrow(UsageError);
    });

    it('--composite-name error message is actionable', () => {
      try {
        enforceCompositeFlagMatrix(flags({ compositeName: 'foo' }), {
          tools: [],
          argv: ['--composite-name', 'foo'],
        });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        expect((e as UsageError).message).toBe(
          '--composite-name requires --treat-as-tool',
        );
        expect((e as UsageError).exitCode).toBe(2);
      }
    });

    it('--emit-doc without --treat-as-tool → ERR-2', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags({ emitDoc: true }), {
          tools: [],
          argv: ['--emit-doc'],
        }),
      ).toThrow(/--emit-doc requires --treat-as-tool/);
    });

    it('--no-emit-doc without --treat-as-tool → ERR-2', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags({ emitDoc: false }), {
          tools: [],
          argv: ['--no-emit-doc'],
        }),
      ).toThrow(/--no-emit-doc requires --treat-as-tool/);
    });

    it('--emit-wrapper without --treat-as-tool → ERR-2', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags({ emitWrapper: true }), {
          tools: [],
          argv: ['--emit-wrapper'],
        }),
      ).toThrow(/--emit-wrapper requires --treat-as-tool/);
    });

    it('--emit-wrapper-on-path without --treat-as-tool → ERR-2', () => {
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({ emitWrapperOnPath: true, emitWrapper: true }),
          { tools: [], argv: ['--emit-wrapper-on-path', '--emit-wrapper'] },
        ),
      ).toThrow(/--emit-wrapper requires --treat-as-tool/);
    });

    it('--register-virtual without --treat-as-tool → ERR-2', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags({ registerVirtual: true }), {
          tools: [],
          argv: ['--register-virtual'],
        }),
      ).toThrow(/--register-virtual requires --treat-as-tool/);
    });

    it('--dry-run-synthesis without --treat-as-tool → ERR-2', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags({ dryRunSynthesis: true }), {
          tools: [],
          argv: ['--dry-run-synthesis'],
        }),
      ).toThrow(/--dry-run-synthesis requires --treat-as-tool/);
    });

    it('--force-overwrite without --treat-as-tool → ERR-2', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags({ forceOverwrite: true }), {
          tools: [],
          argv: ['--force-overwrite'],
        }),
      ).toThrow(/--force-overwrite requires --treat-as-tool/);
    });
  });

  /* ====================================================================
   * Row 2 — ADR-CMP-3 / OQ-7 deviation: --regenerate-capabilities
   * ==================================================================== */
  describe('row 2: ADR-CMP-3 deviation for --regenerate-capabilities', () => {
    it('--regenerate-capabilities without --treat-as-tool → ERR-2 with OQ-7 message', () => {
      try {
        enforceCompositeFlagMatrix(flags({ regenerateCapabilities: true }), {
          tools: [],
          argv: ['--regenerate-capabilities'],
        });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        expect((e as UsageError).message).toBe(
          '--regenerate-capabilities requires --treat-as-tool; use --refresh-capabilities for member-tool discovery refresh',
        );
        expect((e as UsageError).exitCode).toBe(2);
      }
    });

    it('--regenerate-capabilities WITH --treat-as-tool → OK', () => {
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({ treatAsTool: true, regenerateCapabilities: true, emitDoc: true }),
          { tools: ['foo'], argv: ['--treat-as-tool', '--regenerate-capabilities'] },
        ),
      ).not.toThrow();
    });
  });

  /* ====================================================================
   * Row 3 — --synthesis-budget-tokens permitted without --treat-as-tool
   * ==================================================================== */
  describe('row 3: --synthesis-budget-tokens is OK without --treat-as-tool', () => {
    it('does NOT throw (no-op; ignored without synth)', () => {
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({ synthesisBudgetTokens: 8192 }),
          { tools: [], argv: ['--synthesis-budget-tokens', '8192'] },
        ),
      ).not.toThrow();
    });

    it('still permitted alongside other valid flags', () => {
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({ synthesisBudgetTokens: 4096, treatAsTool: true, emitDoc: true }),
          {
            tools: ['foo'],
            argv: ['--treat-as-tool', '--synthesis-budget-tokens', '4096'],
          },
        ),
      ).not.toThrow();
    });
  });

  /* ====================================================================
   * Row 4 — --treat-as-tool + --help + empty members → ERR-2 (AC-3 / E-1)
   * ==================================================================== */
  describe('row 4: empty member list', () => {
    it('--treat-as-tool --help with no members → ERR-2', () => {
      try {
        enforceCompositeFlagMatrix(flags({ treatAsTool: true, emitDoc: true }), {
          tools: [],
          help: true,
          argv: ['--treat-as-tool', '--help'],
        });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        expect((e as UsageError).message).toBe(
          'composite synthesis requires at least one --tool argument',
        );
      }
    });

    it('--treat-as-tool --help with one member → OK', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags({ treatAsTool: true, emitDoc: true }), {
          tools: ['ls'],
          help: true,
          argv: ['--treat-as-tool', '--help', '--tool', 'ls'],
        }),
      ).not.toThrow();
    });

    it('--treat-as-tool ALONE (no --help, no members) → OK (metadata-only)', () => {
      // Per §14.H second column "With --treat-as-tool (no --help)":
      // (none) row = "Treated as a normal run; flag is metadata".
      expect(() =>
        enforceCompositeFlagMatrix(flags({ treatAsTool: true, emitDoc: true }), {
          tools: [],
          argv: ['--treat-as-tool'],
        }),
      ).not.toThrow();
    });
  });

  /* ====================================================================
   * Row 5 — Zero distribution forms
   * ==================================================================== */
  describe('row 5: zero distribution forms', () => {
    it('--treat-as-tool + --no-emit-doc + no --emit-wrapper + no --register-virtual → ERR-2', () => {
      try {
        enforceCompositeFlagMatrix(
          flags({ treatAsTool: true, emitDoc: false }),
          {
            tools: ['ls'],
            help: true,
            argv: ['--treat-as-tool', '--no-emit-doc', '--help'],
          },
        );
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        expect((e as UsageError).message).toBe(
          'composite must emit at least one of: --emit-doc, --emit-wrapper, --register-virtual',
        );
      }
    });

    it('--no-emit-doc + --emit-wrapper → OK (one form remains)', () => {
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({ treatAsTool: true, emitDoc: false, emitWrapper: true }),
          {
            tools: ['ls'],
            help: true,
            argv: ['--treat-as-tool', '--no-emit-doc', '--emit-wrapper', '--help'],
          },
        ),
      ).not.toThrow();
    });

    it('--no-emit-doc + --register-virtual → OK', () => {
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({ treatAsTool: true, emitDoc: false, registerVirtual: true }),
          {
            tools: ['ls'],
            help: true,
            argv: [
              '--treat-as-tool',
              '--no-emit-doc',
              '--register-virtual',
              '--help',
            ],
          },
        ),
      ).not.toThrow();
    });

    it('does NOT trigger when --no-emit-doc was NOT supplied (default-true OK)', () => {
      // Implicit default emitDoc=true keeps the bare --treat-as-tool
      // --help path operational; the rule must NOT misfire on it.
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({ treatAsTool: true, emitDoc: true }),
          { tools: ['ls'], help: true, argv: ['--treat-as-tool', '--help'] },
        ),
      ).not.toThrow();
    });
  });

  /* ====================================================================
   * Row 6 — --emit-wrapper-on-path requires --emit-wrapper
   * ==================================================================== */
  describe('row 6: --emit-wrapper-on-path requires --emit-wrapper', () => {
    it('--emit-wrapper-on-path WITHOUT --emit-wrapper → ERR-2', () => {
      try {
        enforceCompositeFlagMatrix(
          flags({ treatAsTool: true, emitDoc: true, emitWrapperOnPath: true }),
          {
            tools: ['ls'],
            help: true,
            argv: ['--treat-as-tool', '--emit-wrapper-on-path', '--help'],
          },
        );
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        expect((e as UsageError).message).toBe(
          '--emit-wrapper-on-path requires --emit-wrapper',
        );
      }
    });

    it('--emit-wrapper-on-path WITH --emit-wrapper → OK', () => {
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({
            treatAsTool: true,
            emitDoc: true,
            emitWrapper: true,
            emitWrapperOnPath: true,
          }),
          {
            tools: ['ls'],
            help: true,
            argv: [
              '--treat-as-tool',
              '--emit-wrapper',
              '--emit-wrapper-on-path',
              '--help',
            ],
          },
        ),
      ).not.toThrow();
    });
  });

  /* ====================================================================
   * Row 7 — --treat-as-tool + --resume incompatible
   * ==================================================================== */
  describe('row 7: --treat-as-tool + --resume', () => {
    it('--treat-as-tool + --resume (boolean) → ERR-2', () => {
      try {
        enforceCompositeFlagMatrix(flags({ treatAsTool: true, emitDoc: true }), {
          tools: ['ls'],
          resume: true,
          argv: ['--treat-as-tool', '--resume', '--tool', 'ls'],
        });
        throw new Error('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(UsageError);
        expect((e as UsageError).message).toBe(
          '--treat-as-tool is incompatible with --resume',
        );
      }
    });

    it('--treat-as-tool + --resume <threadId> (string) → ERR-2', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags({ treatAsTool: true, emitDoc: true }), {
          tools: ['ls'],
          resume: 'thread-42',
          argv: ['--treat-as-tool', '--resume', 'thread-42', '--tool', 'ls'],
        }),
      ).toThrow(/incompatible with --resume/);
    });

    it('--treat-as-tool + --resume detected via argv only → ERR-2', () => {
      // Programmatic caller did not set opts.resume, but argv has -r.
      expect(() =>
        enforceCompositeFlagMatrix(flags({ treatAsTool: true, emitDoc: true }), {
          tools: ['ls'],
          argv: ['--treat-as-tool', '-r', '--tool', 'ls'],
        }),
      ).toThrow(/incompatible with --resume/);
    });

    it('--treat-as-tool WITHOUT --resume → OK', () => {
      expect(() =>
        enforceCompositeFlagMatrix(flags({ treatAsTool: true, emitDoc: true }), {
          tools: ['ls'],
          argv: ['--treat-as-tool', '--tool', 'ls'],
        }),
      ).not.toThrow();
    });
  });

  /* ====================================================================
   * Permitted cells — guard against accidental over-enforcement
   * ==================================================================== */
  describe('permitted cells (do NOT throw)', () => {
    it('--dry-run-synthesis + --emit-wrapper + --register-virtual → OK', () => {
      // §14.H "--dry-run-synthesis" cell with --treat-as-tool says
      // "Print stage prompts + digests; do NOT call LLM; do NOT
      // write cache" — does NOT forbid the emit flags. The dry-run
      // contract is enforced inside the synthesis pipeline.
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({
            treatAsTool: true,
            emitDoc: true,
            emitWrapper: true,
            registerVirtual: true,
            dryRunSynthesis: true,
          }),
          {
            tools: ['ls'],
            help: true,
            argv: [
              '--treat-as-tool',
              '--dry-run-synthesis',
              '--emit-wrapper',
              '--register-virtual',
              '--help',
            ],
          },
        ),
      ).not.toThrow();
    });

    it('--treat-as-tool + emit/register without --help → OK (deferred to next synthesis)', () => {
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({
            treatAsTool: true,
            emitDoc: true,
            emitWrapper: true,
            emitWrapperOnPath: true,
            registerVirtual: true,
            forceOverwrite: true,
          }),
          {
            tools: ['ls'],
            argv: [
              '--treat-as-tool',
              '--emit-wrapper',
              '--emit-wrapper-on-path',
              '--register-virtual',
              '--force-overwrite',
            ],
          },
        ),
      ).not.toThrow();
    });

    it('--treat-as-tool + --composite-name → OK', () => {
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({ treatAsTool: true, emitDoc: true, compositeName: 'demo' }),
          {
            tools: ['ls'],
            argv: ['--treat-as-tool', '--composite-name', 'demo'],
          },
        ),
      ).not.toThrow();
    });

    it('--treat-as-tool + --force-overwrite → OK', () => {
      expect(() =>
        enforceCompositeFlagMatrix(
          flags({ treatAsTool: true, emitDoc: true, forceOverwrite: true }),
          {
            tools: ['ls'],
            argv: ['--treat-as-tool', '--force-overwrite'],
          },
        ),
      ).not.toThrow();
    });
  });

  /* ====================================================================
   * Identity for non-composite invocations (NFR-CMP-001)
   * ==================================================================== */
  describe('NFR-CMP-001 identity for normal cli-agent invocations', () => {
    it('all baseline-style argvs are no-ops', () => {
      const baselineArgvs: readonly (readonly string[])[] = [
        [],
        ['--help'],
        ['-h'],
        ['--tool', 'ls'],
        ['-i', '--tool', 'ls'],
        ['-r'],
        ['--resume', 'thread-1'],
        ['--profile', 'dev', '--tool', 'ls'],
        ['--refresh-capabilities'],
      ];
      for (const argv of baselineArgvs) {
        expect(
          () =>
            enforceCompositeFlagMatrix(flags(), {
              tools: [],
              help: argv.includes('--help') || argv.includes('-h'),
              resume: argv.includes('--resume') ? true : undefined,
              argv,
            }),
          `argv=${JSON.stringify(argv)}`,
        ).not.toThrow();
      }
    });
  });
});
