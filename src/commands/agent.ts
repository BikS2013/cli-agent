/**
 * Main agent command handler.
 */

import type { AgentCliFlags } from '../config/agent-config.js';
import { loadAgentConfig } from '../config/agent-config.js';
import { runOneShotAgent, runInteractiveAgent } from '../agent/run.js';
import { UsageError } from '../errors.js';

export interface AgentCommandOptions extends AgentCliFlags {
  interactive?: boolean;
  tools?: string[];
}

export async function runAgentCommand(
  prompt: string | null,
  opts: AgentCommandOptions,
): Promise<void> {
  if (!opts.interactive && !prompt) {
    throw new UsageError(
      'A prompt is required unless --interactive/-i is passed. Usage: cli-agent "<prompt>" or cli-agent --interactive',
    );
  }

  const cfg = await loadAgentConfig(opts);

  if (opts.interactive) {
    await runInteractiveAgent(cfg);
  } else {
    const answer = await runOneShotAgent(cfg, prompt!);
    process.stdout.write(answer + '\n');
  }
}
