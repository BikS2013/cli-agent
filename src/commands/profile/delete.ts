/**
 * `profile-delete <name>` (alias `profile-rm`) — remove a profile file.
 *
 * Confirmation policy:
 *   - non-TTY (script / pipe): MUST pass `--yes`; otherwise refuse
 *     (ConfigurationError exit 3) so accidental scripted deletions are
 *     impossible.
 *   - TTY: prompt `delete <path>? [y/N] ` unless `--yes`.
 *
 * Spec: plan-005 §5 U-CLI; FR-PROF-012.
 */

import fsp from 'node:fs/promises';
import readline from 'node:readline';
import { agentToolAgentsDir } from '../../config/agent-config.js';
import { ConfigurationError, UsageError } from '../../errors.js';
import { resolveProfilePath } from '../../config/profile-loader.js';

export interface ProfileDeleteOpts {
  readonly yes?: boolean;
}

export interface ProfileDeleteDeps {
  /** Test seam: read user confirmation from a TTY. */
  readonly confirm?: (prompt: string) => Promise<boolean>;
  /** Test seam: report whether stdin/stdout are TTYs. */
  readonly isInteractive?: () => boolean;
}

export async function runProfileDelete(
  name: string,
  opts: ProfileDeleteOpts = {},
  deps: ProfileDeleteDeps = {},
): Promise<void> {
  const agentDir = agentToolAgentsDir();
  const found = resolveProfilePath(name, agentDir);
  const filePath = found.yaml ?? found.json;
  if (!filePath) {
    throw new UsageError(
      `Profile '${name}' does not exist; nothing to delete.`,
      { profileName: name },
    );
  }

  const isInteractive = (deps.isInteractive ?? defaultIsInteractive)();

  if (!opts.yes) {
    if (!isInteractive) {
      throw new ConfigurationError('profile-delete confirmation', [
        '--yes flag (required in non-interactive environments)',
      ], {
        detail:
          `Refusing to delete '${filePath}' without --yes in a non-interactive environment.`,
      });
    }
    const confirm = deps.confirm ?? defaultConfirm;
    const ok = await confirm(`delete ${filePath}? [y/N] `);
    if (!ok) {
      process.stderr.write(`[cli-agent] aborted; profile '${name}' not deleted\n`);
      return;
    }
  }

  await fsp.unlink(filePath);
  process.stdout.write(`Deleted profile '${name}' (${filePath}).\n`);
}

function defaultIsInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}

function defaultConfirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      const v = answer.trim().toLowerCase();
      resolve(v === 'y' || v === 'yes');
    });
  });
}
