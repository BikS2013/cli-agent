/**
 * /new (alias /reset) — start a fresh thread; preserve provider/model and tool catalog.
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { buildAgentGraph } from '../../agent/graph.js';
import { createLLM } from '../../agent/providers/registry.js';
import { buildToolCatalog } from '../../agent/tools/registry.js';
import { composeCapabilitiesSystemPrompt } from '../../agent/capabilities/compose-system-prompt.js';
import { buildSystemPromptForCfg } from '../../agent/system-prompt.js';

const newCmd: SlashCommand = {
  name: '/new',
  aliases: ['/reset'],
  summary: 'Start a new thread (fresh MemorySaver namespace; same provider/model/tools)',
  async run(ctx): Promise<void> {
    const c = ctx.controller;
    await c.resetThread();
    // Rebuild the agent graph so the MemorySaver namespace is reset
    const llm = createLLM(c.cfg);
    const tools = buildToolCatalog(c.cfg, c.logger);
    const capSection = await composeCapabilitiesSystemPrompt(
      c.cfg.capabilitiesDir,
      c.cfg.tools,
      c.cfg.capabilities.maxBytesPerTool,
    );
    const systemPrompt = await buildSystemPromptForCfg(c.cfg, capSection);
    c.agentGraph = buildAgentGraph(llm, tools, systemPrompt, c.cfg.maxSteps);
    ctx.printSystem(`new thread started: ${c.threadId.slice(0, 8)}…`);
  },
};

registerCommand(newCmd);
export default newCmd;
