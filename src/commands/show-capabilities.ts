/**
 * show-capabilities command: print cached capability doc for a tool.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { agentToolAgentsDir } from '../config/agent-config.js';
import { UsageError, CapabilityError } from '../errors.js';

export async function runShowCapabilities(tool: string | undefined): Promise<void> {
  if (!tool) {
    throw new UsageError('--tool <name> is required for show-capabilities.');
  }

  const capabilitiesDir = path.join(agentToolAgentsDir(), 'capabilities');
  const filePath = path.join(capabilitiesDir, `${tool}.md`);

  try {
    const content = await fsp.readFile(filePath, 'utf8');
    process.stdout.write(content);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      throw new CapabilityError(
        'E_CAPABILITY_NOT_FOUND',
        `No capability document for '${tool}'. Run: cli-agent refresh-capabilities --tool ${tool}`,
        { tool },
      );
    }
    throw e;
  }
}
