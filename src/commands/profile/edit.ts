/**
 * `profile-edit <name>` — open a profile in `$EDITOR` and re-validate
 * after the editor exits.
 *
 * Editor selection (highest priority first):
 *   1. `$VISUAL`
 *   2. `$EDITOR`
 *   3. POSIX → `vi`; Windows → `notepad`
 *
 * Behaviour after editor exit (ADR-PROF-10): re-validate the file by
 * re-loading via `loadProfile`. The file on disk is NEVER rewritten by
 * this command; if validation fails, the file is left as-is for the
 * user to fix.
 *
 * Spec: plan-005 §5 U-CLI; FR-PROF-011.
 */

import { spawnSync } from 'node:child_process';
import { agentToolAgentsDir } from '../../config/agent-config.js';
import { UsageError, ConfigurationError } from '../../errors.js';
import {
  loadProfile,
  resolveProfilePath,
} from '../../config/profile-loader.js';

export interface ProfileEditDeps {
  /** Test seam: spawn the editor process. Defaults to `child_process.spawnSync`. */
  readonly spawn?: typeof spawnSync;
  /** Test seam: pick the editor binary. Defaults to env-var resolution. */
  readonly resolveEditor?: (env: NodeJS.ProcessEnv) => string;
}

export async function runProfileEdit(
  name: string,
  deps: ProfileEditDeps = {},
): Promise<void> {
  const agentDir = agentToolAgentsDir();
  const found = resolveProfilePath(name, agentDir);
  const filePath = found.yaml ?? found.json;
  if (!filePath) {
    throw new UsageError(
      `Profile '${name}' does not exist. ` +
        `Hint: cli-agent profile-create ${name}`,
      { profileName: name },
    );
  }

  const editor = (deps.resolveEditor ?? defaultResolveEditor)(process.env);
  const spawn = deps.spawn ?? spawnSync;

  process.stderr.write(`[cli-agent] launching ${editor} ${filePath}\n`);
  const res = spawn(editor, [filePath], { stdio: 'inherit' });

  if (res.error) {
    throw new UsageError(
      `Failed to launch editor '${editor}': ${res.error.message}`,
      { editor, filePath },
    );
  }
  if (typeof res.status === 'number' && res.status !== 0) {
    process.stderr.write(
      `[cli-agent] editor '${editor}' exited with status ${res.status}; re-validating file anyway\n`,
    );
  }

  // Re-validate by re-loading the profile. `loadProfile` surfaces every
  // error type (E2/E3/E4/E5/E11/E18) in a single ConfigurationError /
  // UsageError. The file stays on disk regardless of validation outcome.
  try {
    await loadProfile(name, agentDir);
    process.stdout.write(`Profile '${name}' validated cleanly.\n`);
  } catch (e) {
    // Surface the diagnostic and propagate the typed error so cli.ts
    // produces the right exit code (3 for ConfigurationError, 2 for
    // UsageError). The file is left untouched per ADR-PROF-10.
    if (e instanceof ConfigurationError || e instanceof UsageError) {
      process.stderr.write(
        `[cli-agent] profile '${name}' failed validation after edit. ` +
          `File left as-is at ${filePath}.\n`,
      );
    }
    throw e;
  }
}

function defaultResolveEditor(env: NodeJS.ProcessEnv): string {
  if (env['VISUAL'] && env['VISUAL'].length > 0) return env['VISUAL'];
  if (env['EDITOR'] && env['EDITOR'].length > 0) return env['EDITOR'];
  return process.platform === 'win32' ? 'notepad' : 'vi';
}
