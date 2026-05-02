/**
 * Tests for the `--profile` CLI flag handling (plan-005 edge cases E13, E14).
 *
 * These tests rebuild a minimal Commander.js program topology mirroring the
 * `--profile <name>` declaration in `src/cli.ts` — the same pattern used by
 * `src/cli-subcommand-tool-flag.spec.ts` for the `--tool` shadowing regression.
 * We never import `src/cli.ts` directly (to avoid its module-level
 * `program.parseAsync(process.argv)` side-effect).
 *
 * Edge cases covered:
 *   E13 — `--profile foo --profile bar` → last-wins; Commander's default
 *          behavior for non-variadic options is to record the last seen value.
 *          This is documented behavior, not a bug; no error is thrown.
 *   E14 — `--profile` with no argument → Commander error (process.exit(1) by
 *          default in Commander v12, or throws if exitOverride() is set).
 *
 * Both tests are hermetic — no real config loading, no network, no shell.
 */

import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Minimal program that mirrors the --profile declaration in cli.ts.
// Using exitOverride() so Commander throws instead of calling process.exit,
// which lets our tests catch Commander's usage errors without killing the
// test process.
// ---------------------------------------------------------------------------

interface ProfileCapture {
  profileName: string | undefined;
}

function buildProfileProgram(captureRef: { current: ProfileCapture | null }): Command {
  const program = new Command();

  program
    .name('cli-agent')
    // Commander's `.exitOverride()` makes it throw a `CommanderError` instead
    // of calling `process.exit` when it encounters a usage error (E14).
    .exitOverride()
    .argument('[prompt]', 'One-shot prompt')
    .option(
      '--profile <name>',
      'Activate a named configuration profile (env: CLI_AGENT_PROFILE)',
    )
    .action((prompt: string | undefined, opts: Record<string, unknown>) => {
      captureRef.current = {
        profileName: opts['profile'] as string | undefined,
      };
    });

  return program;
}

// ---------------------------------------------------------------------------
// E13: --profile repeated → Commander last-wins, no error thrown
// ---------------------------------------------------------------------------

describe('E13: --profile flag repeated on the command line', () => {
  it('last value wins when --profile is supplied twice', async () => {
    const captureRef: { current: ProfileCapture | null } = { current: null };
    const program = buildProfileProgram(captureRef);

    await program.parseAsync([
      'node',
      'cli-agent',
      '--profile',
      'first-profile',
      '--profile',
      'last-profile',
    ]);

    expect(captureRef.current?.profileName).toBe('last-profile');
  });

  it('last value wins when --profile is supplied three times', async () => {
    const captureRef: { current: ProfileCapture | null } = { current: null };
    const program = buildProfileProgram(captureRef);

    await program.parseAsync([
      'node',
      'cli-agent',
      '--profile',
      'alpha',
      '--profile',
      'beta',
      '--profile',
      'gamma',
    ]);

    expect(captureRef.current?.profileName).toBe('gamma');
  });

  it('no error is thrown when --profile is repeated (last-wins is silent)', async () => {
    const captureRef: { current: ProfileCapture | null } = { current: null };
    const program = buildProfileProgram(captureRef);

    await expect(
      program.parseAsync([
        'node',
        'cli-agent',
        '--profile',
        'a',
        '--profile',
        'b',
      ]),
    ).resolves.not.toThrow();
  });

  it('single --profile value is captured correctly (baseline)', async () => {
    const captureRef: { current: ProfileCapture | null } = { current: null };
    const program = buildProfileProgram(captureRef);

    await program.parseAsync(['node', 'cli-agent', '--profile', 'review']);

    expect(captureRef.current?.profileName).toBe('review');
  });
});

// ---------------------------------------------------------------------------
// E14: --profile with no argument → Commander usage error (exit 2 / throw)
// ---------------------------------------------------------------------------

describe('E14: --profile with no argument', () => {
  it('Commander throws a CommanderError when --profile has no value', async () => {
    const captureRef: { current: ProfileCapture | null } = { current: null };
    const program = buildProfileProgram(captureRef);

    // --profile requires a <name> argument; if omitted Commander emits a
    // "option '--profile <name>' argument missing" error and exits (or throws
    // with exitOverride()).
    let thrown: unknown;
    try {
      await program.parseAsync([
        'node',
        'cli-agent',
        '--profile', // no value follows
        // next arg looks like a flag, not a value → Commander sees missing arg
      ]);
    } catch (e) {
      thrown = e;
    }
    // Commander's exit-override produces a CommanderError with code
    // 'commander.optionMissingArgument' and exitCode 1.
    expect(thrown).toBeDefined();
    const err = thrown as { code?: string; exitCode?: number };
    expect(err.code).toMatch(/optionMissingArgument|commander\./);
  });

  it('Commander throws when --profile is the last argument (no value possible)', async () => {
    const captureRef: { current: ProfileCapture | null } = { current: null };
    const program = buildProfileProgram(captureRef);

    let thrown: unknown;
    try {
      await program.parseAsync([
        'node',
        'cli-agent',
        '--profile', // end of argv — no value available
      ]);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
  });

  it('action handler is NOT invoked when --profile argument is missing', async () => {
    const captureRef: { current: ProfileCapture | null } = { current: null };
    const program = buildProfileProgram(captureRef);

    try {
      await program.parseAsync(['node', 'cli-agent', '--profile']);
    } catch {
      // ignore the thrown error
    }

    // The action must not have been called
    expect(captureRef.current).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// E12 (cli-layer confirmation): --profile flag takes precedence over env var
//
// The precedence is already exercised end-to-end in agent-config.spec.ts, but
// here we confirm that the CLI layer itself correctly wires the flag into
// opts['profile'], regardless of what environment variables might carry.
// ---------------------------------------------------------------------------

describe('E12 (CLI layer): --profile flag value is captured in opts', () => {
  it('opts.profile reflects the --profile flag value supplied at the CLI', async () => {
    const captureRef: { current: ProfileCapture | null } = { current: null };
    const program = buildProfileProgram(captureRef);

    await program.parseAsync(['node', 'cli-agent', '--profile', 'cli-wins']);

    expect(captureRef.current?.profileName).toBe('cli-wins');
  });

  it('opts.profile is undefined when --profile is not supplied', async () => {
    const captureRef: { current: ProfileCapture | null } = { current: null };
    const program = buildProfileProgram(captureRef);

    await program.parseAsync(['node', 'cli-agent']);

    expect(captureRef.current?.profileName).toBeUndefined();
  });
});
