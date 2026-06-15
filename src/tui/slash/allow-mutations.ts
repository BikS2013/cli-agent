/**
 * /allow-mutations <on|off> — flip the cfg.allowMutations gate; rebuilds the
 * tool catalog before the next user prompt. Currently-running mutating tool
 * calls are NOT aborted on flip-off.
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { buildAgentGraph } from '../../agent/graph.js';
import { createLLM } from '../../agent/providers/registry.js';
import { buildToolCatalog } from '../../agent/tools/registry.js';
import { composeCapabilitiesSystemPrompt } from '../../agent/capabilities/compose-system-prompt.js';
import { buildSystemPromptForCfg } from '../../agent/system-prompt.js';

const allowMutCmd: SlashCommand = {
  name: '/allow-mutations',
  summary: 'Toggle mutating tools (file_write/file_edit/file_append): on|off',
  async run(ctx, args): Promise<void> {
    const c = ctx.controller;
    const v = args[0]?.toLowerCase();
    if (v !== 'on' && v !== 'off') {
      ctx.printSystem(`current: ${c.cfg.allowMutations ? 'on' : 'off'}. Usage: /allow-mutations on|off`);
      return;
    }
    const newCfg = { ...c.cfg, allowMutations: v === 'on' };
    const llm = createLLM(newCfg);
    const { tools, agentToolsMeta } = buildToolCatalog(newCfg, c.logger);
    const capSection = await composeCapabilitiesSystemPrompt(
      newCfg.capabilitiesDir,
      newCfg.tools,
      newCfg.capabilities.maxBytesPerTool,
    );
    const systemPrompt = await buildSystemPromptForCfg(newCfg, capSection, agentToolsMeta, tools);
    c.cfg = newCfg;
    c.sessionAllowMutations = newCfg.allowMutations;
    c.agentGraph = buildAgentGraph(llm, tools, systemPrompt, newCfg.maxSteps, newCfg);
    ctx.printSystem(`mutations: ${v}.`);
  },
};

registerCommand(allowMutCmd);
export default allowMutCmd;
