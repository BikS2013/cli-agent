/**
 * Regression test for the Commander v12 option-shadowing bug where the
 * parent program's `--tool <name>` (a repeatable aggregator) silently
 * captures the value supplied to a subcommand's same-named option, leaving
 * the subcommand's local `opts.tool` undefined.
 *
 * The bug surfaced as:
 *   `cli-agent refresh-capabilities --tool <name>`
 *     → Error [E_USAGE]: No tools configured. ...
 *
 * This spec rebuilds the same parent/subcommand topology used in `src/cli.ts`
 * and asserts that the recovery pattern (`cmd.optsWithGlobals()` + first-of-
 * array extraction) reliably surfaces the user-supplied tool name in both
 * subcommand action handlers.
 */
import { describe, it, expect } from 'vitest';
import { Command } from 'commander';

function collectTool(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function pickFirstTool(v: unknown): string | undefined {
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') return v[0];
  if (typeof v === 'string' && v.length > 0) return v;
  return undefined;
}

interface Capture {
  toolName: string | undefined;
  localOpts: Record<string, unknown>;
  mergedOpts: Record<string, unknown>;
}

function buildProgram(captureRef: { current: Capture | null }): Command {
  const program = new Command();
  program
    .name('cli-agent')
    .argument('[prompt]')
    .option('--tool <name>', 'parent tool (repeatable)', collectTool, [])
    .action(() => {
      // The agent root command — never invoked in these tests because we
      // always target a subcommand.
    });

  program
    .command('refresh-capabilities')
    .option('--tool <name>', 'Tool to refresh')
    .action(function (this: Command, opts: Record<string, unknown>) {
      const merged = this.optsWithGlobals();
      const toolName =
        (opts['tool'] as string | undefined) ?? pickFirstTool(merged['tool']);
      captureRef.current = { toolName, localOpts: opts, mergedOpts: merged };
    });

  program
    .command('show-capabilities')
    .option('--tool <name>', 'Tool name to show')
    .action(function (this: Command, opts: { tool?: string }) {
      const merged = this.optsWithGlobals();
      const toolName = opts.tool ?? pickFirstTool(merged['tool']);
      captureRef.current = {
        toolName,
        localOpts: opts as Record<string, unknown>,
        mergedOpts: merged,
      };
    });
  return program;
}

describe('subcommand --tool flag (regression: parent shadowing)', () => {
  it('refresh-capabilities --tool <name> is captured even though the parent shadows it', async () => {
    const captureRef: { current: Capture | null } = { current: null };
    const program = buildProgram(captureRef);
    await program.parseAsync(
      ['node', 'cli-agent', 'refresh-capabilities', '--tool', 'telegram-cli'],
    );
    expect(captureRef.current?.toolName).toBe('telegram-cli');
  });

  it('show-capabilities --tool <name> is captured even though the parent shadows it', async () => {
    const captureRef: { current: Capture | null } = { current: null };
    const program = buildProgram(captureRef);
    await program.parseAsync(
      ['node', 'cli-agent', 'show-capabilities', '--tool', 'telegram-cli'],
    );
    expect(captureRef.current?.toolName).toBe('telegram-cli');
  });

  it('subcommand-local opts.tool is undefined while the parent receives the value (locks the bug topology)', async () => {
    // This guards against a future Commander upgrade silently changing
    // behavior. If this assertion ever fails, the recovery code in cli.ts
    // is no longer needed and the spec should be updated.
    const captureRef: { current: Capture | null } = { current: null };
    const program = buildProgram(captureRef);
    await program.parseAsync(
      ['node', 'cli-agent', 'refresh-capabilities', '--tool', 'foo'],
    );
    expect(captureRef.current?.localOpts['tool']).toBeUndefined();
    expect(captureRef.current?.mergedOpts['tool']).toEqual(['foo']);
  });

  it('omitting --tool yields toolName = undefined (no spurious match from parent default `[]`)', async () => {
    const captureRef: { current: Capture | null } = { current: null };
    const program = buildProgram(captureRef);
    await program.parseAsync(['node', 'cli-agent', 'refresh-capabilities']);
    expect(captureRef.current?.toolName).toBeUndefined();
  });

  it('multiple --tool values: pickFirstTool selects the first (single-tool subcommands ignore the rest)', async () => {
    const captureRef: { current: Capture | null } = { current: null };
    const program = buildProgram(captureRef);
    await program.parseAsync([
      'node',
      'cli-agent',
      'refresh-capabilities',
      '--tool',
      'first',
      '--tool',
      'second',
    ]);
    expect(captureRef.current?.toolName).toBe('first');
  });
});

describe('pickFirstTool helper', () => {
  it('returns the first element of a string array', () => {
    expect(pickFirstTool(['a', 'b'])).toBe('a');
  });

  it('returns a bare string unchanged', () => {
    expect(pickFirstTool('foo')).toBe('foo');
  });

  it('returns undefined for empty array', () => {
    expect(pickFirstTool([])).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(pickFirstTool('')).toBeUndefined();
  });

  it('returns undefined for non-string array element', () => {
    expect(pickFirstTool([42])).toBeUndefined();
  });

  it('returns undefined for null/undefined', () => {
    expect(pickFirstTool(null)).toBeUndefined();
    expect(pickFirstTool(undefined)).toBeUndefined();
  });
});
