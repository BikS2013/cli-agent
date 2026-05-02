/**
 * `profile-show <name>` — pretty-print a configuration profile.
 *
 * Default output: section-headed kubectl-config-view-style report
 * (Profile / cliParams / tools / toolArgs) plus the digest and
 * resolved file path. `--json` opts into JSON output.
 *
 * Spec: plan-005 §5 U-CLI; FR-PROF-009; AC-14.
 */

import { agentToolAgentsDir } from '../../config/agent-config.js';
import { loadProfile } from '../../config/profile-loader.js';

export interface ProfileShowOpts {
  readonly json?: boolean;
}

export async function runProfileShow(
  name: string,
  opts: ProfileShowOpts = {},
): Promise<void> {
  const agentDir = agentToolAgentsDir();
  const profile = await loadProfile(name, agentDir);

  if (opts.json) {
    const payload = {
      name: profile.name,
      path: profile.path,
      schemaVersion: profile.schemaVersion,
      digest: profile.digest,
      cliParams: profile.cliParams,
      tools: profile.tools,
      toolArgs: profile.toolArgs,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  const lines: string[] = [];
  lines.push('Profile');
  lines.push(`  name:          ${profile.name}`);
  lines.push(`  path:          ${profile.path}`);
  lines.push(`  schemaVersion: ${profile.schemaVersion}`);
  lines.push(`  digest:        ${profile.digest}`);
  lines.push('');

  if (profile.cliParams) {
    lines.push('cliParams');
    for (const [k, v] of Object.entries(profile.cliParams)) {
      lines.push(`  ${k}: ${formatScalar(v)}`);
    }
    lines.push('');
  } else {
    lines.push('cliParams: <none>');
    lines.push('');
  }

  if (profile.tools) {
    lines.push('tools');
    if (profile.tools.allow) {
      lines.push(`  allow: [${profile.tools.allow.join(', ')}]`);
    }
    if (profile.tools.deny) {
      lines.push(`  deny:  [${profile.tools.deny.join(', ')}]`);
    }
    if (profile.tools.order) {
      lines.push(`  order: [${profile.tools.order.join(', ')}]`);
    }
    lines.push('');
  } else {
    lines.push('tools: <none>');
    lines.push('');
  }

  if (profile.toolArgs && Object.keys(profile.toolArgs).length > 0) {
    lines.push('toolArgs');
    for (const [tool, args] of Object.entries(profile.toolArgs)) {
      lines.push(`  ${tool}:`);
      for (const [k, v] of Object.entries(args)) {
        lines.push(`    ${k}: ${formatScalar(v)}`);
      }
    }
    lines.push('');
  } else {
    lines.push('toolArgs: <none>');
    lines.push('');
  }

  process.stdout.write(lines.join('\n'));
}

function formatScalar(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '<unset>';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
