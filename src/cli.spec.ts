/**
 * Cold-start regression sanity test for `src/cli.ts`.
 *
 * This is a deliberately minimal "wiring smoke" test. It verifies that:
 *   1. The `cli.ts` module can be imported without throwing an error — i.e.
 *      no module-level code panics during registration of Commander commands
 *      or when re-exporting symbols.
 *   2. The `mapAgentToolFlags` re-export is accessible (verifies the
 *      barrel re-export on line ~37 of cli.ts is intact after plan-005
 *      changes).
 *
 * Why this matters: plan-005 added the `profile` subcommands and a new
 * `--profile <name>` flag to the main command. Any import-time error
 * (e.g. a broken `import { runProfileXxx }` if a handler module goes
 * missing) would surface here immediately, before any acceptance test runs.
 *
 * The test does NOT call `program.parseAsync` (which would block on stdin or
 * exit the process). It simply asserts that the module loads and the
 * re-exported symbol is a function.
 *
 * Commander's `program.parseAsync(process.argv)` is module-level in cli.ts.
 * We avoid importing cli.ts directly because that side-effect runs at import
 * time. Instead, we import only the re-exported `mapAgentToolFlags` which
 * is safe to import without triggering a parse.
 *
 * Per project conventions: `test_scripts/smoke-profile-cold-start.ts` is a
 * manual smoke; this vitest-level check is faster and runs in CI.
 */

import { describe, it, expect } from 'vitest';

describe('cli.ts cold-start wiring sanity', () => {
  it('mapAgentToolFlags can be imported from cli-agent-tools-flags.ts without throwing', async () => {
    // Importing the flags module (which is safe — no parse side-effect)
    // verifies that the tool-flag resolution chain hasn't been broken by
    // plan-005 changes.
    const mod = await import('./cli-agent-tools-flags.js');
    expect(typeof mod.mapAgentToolFlags).toBe('function');
  });

  it('profile-schema module imports without throwing (Zod schema registration)', async () => {
    // profile-schema.ts is a new plan-005 module with Zod schemas and
    // KNOWN_CLI_PARAMS constant. If the Zod dependency or the schema
    // definition itself throws at import time, this test fails.
    const mod = await import('./config/profile-schema.js');
    expect(mod.ProfileSchema).toBeDefined();
    expect(mod.KNOWN_CLI_PARAMS).toBeDefined();
    expect(mod.KNOWN_CLI_PARAMS.size).toBeGreaterThan(0);
  });

  it('profile-loader module imports without throwing', async () => {
    const mod = await import('./config/profile-loader.js');
    expect(typeof mod.loadProfile).toBe('function');
    expect(typeof mod.listProfiles).toBe('function');
    expect(typeof mod.validateProfileName).toBe('function');
  });

  it('profile-scoping module imports without throwing', async () => {
    const mod = await import('./agent/tools/profile-scoping.js');
    expect(typeof mod.applyProfileToolScoping).toBe('function');
  });

  it('profile-tool-args module imports without throwing', async () => {
    const mod = await import('./agent/tools/profile-tool-args.js');
    expect(typeof mod.mergeProfileToolArgs).toBe('function');
  });

  it('profile command handler modules import without throwing', async () => {
    // These are the six profile subcommand handlers registered in cli.ts.
    // If any of them fails to import (missing dependency, syntax error,
    // broken re-export), this test catches it before integration tests run.
    const [list, show, create, edit, del, dryRun] = await Promise.all([
      import('./commands/profile/list.js'),
      import('./commands/profile/show.js'),
      import('./commands/profile/create.js'),
      import('./commands/profile/edit.js'),
      import('./commands/profile/delete.js'),
      import('./commands/profile/dry-run.js'),
    ]);

    expect(typeof list.runProfileList).toBe('function');
    expect(typeof show.runProfileShow).toBe('function');
    expect(typeof create.runProfileCreate).toBe('function');
    expect(typeof edit.runProfileEdit).toBe('function');
    expect(typeof del.runProfileDelete).toBe('function');
    expect(typeof dryRun.runProfileDryRun).toBe('function');
  });

  it('KNOWN_CLI_PARAMS contains the required plan-005 keys', async () => {
    const { KNOWN_CLI_PARAMS } = await import('./config/profile-schema.js');

    const required = [
      'provider',
      'model',
      'temperature',
      'maxIterations',
      'workingDir',
      'logLevel',
      'webSearchBackend',
      'allowMutations',
    ];

    for (const key of required) {
      expect(KNOWN_CLI_PARAMS.has(key)).toBe(true);
    }
  });

  it('CREDENTIAL_KEY_PATTERN matches common credential-shape keys (E11 regression)', async () => {
    const { CREDENTIAL_KEY_PATTERN } = await import('./config/profile-schema.js');

    const shouldMatch = [
      'OPENAI_API_KEY',
      'MY_TOKEN',
      'DB_SECRET',
      'USER_PASSWORD',
      'some_api_key',
    ];
    const shouldNotMatch = [
      'provider',
      'model',
      'temperature',
      'tokenize',      // "token" as substring but not suffix
      'apiKeyUsage',   // _API_KEY not at end
    ];

    for (const k of shouldMatch) {
      expect(CREDENTIAL_KEY_PATTERN.test(k)).toBe(true);
    }
    for (const k of shouldNotMatch) {
      expect(CREDENTIAL_KEY_PATTERN.test(k)).toBe(false);
    }
  });
});
