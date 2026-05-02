/**
 * `profile-list` (alias `profiles`) — enumerate profiles under
 * `<agentDir>/profiles/`.
 *
 * Default output is a kubectl-style aligned table (NAME / DESCRIPTION /
 * SIZE / MTIME). `--json` opts into machine-readable output.
 *
 * Spec: plan-005 §5 U-CLI; FR-PROF-008; AC-13.
 */

import { agentToolAgentsDir } from '../../config/agent-config.js';
import { listProfiles } from '../../config/profile-loader.js';
import { renderProfileListTable } from './shared.js';

export interface ProfileListOpts {
  readonly json?: boolean;
}

export async function runProfileList(opts: ProfileListOpts = {}): Promise<void> {
  const agentDir = agentToolAgentsDir();
  const entries = await listProfiles(agentDir);

  if (opts.json) {
    // Always emit JSON, even when empty — callers piping into `jq`
    // expect a parsable array.
    const payload = entries.map((e) => ({
      name: e.name,
      description: e.description,
      size: e.size,
      mtime: e.mtime.toISOString(),
      path: e.path,
    }));
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  if (entries.length === 0) {
    process.stderr.write(
      `no profiles found under ${agentDir}/profiles/\n` +
        `Hint: cli-agent profile-create <name>\n`,
    );
    return;
  }

  process.stdout.write(renderProfileListTable(entries));
}
