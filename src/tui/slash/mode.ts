/**
 * /mode [chat|basic|tool|composite] — show or switch the agent mode
 * (plan-015); switching rebuilds the tool catalog before the next user
 * prompt, mirroring /allow-mutations. Switching to chat/basic while
 * wrapped CLIs are loaded is rejected (FR-MODE-5 parity: those modes have
 * no bash_run to execute the wrapped tools), with no state change.
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { buildAgentGraph } from '../../agent/graph.js';
import { createLLM } from '../../agent/providers/registry.js';
import { buildToolCatalog } from '../../agent/tools/registry.js';
import { composeCapabilitiesSystemPrompt } from '../../agent/capabilities/compose-system-prompt.js';
import { buildSystemPromptForCfg } from '../../agent/system-prompt.js';
import {
  AGENT_MODES,
  isAgentMode,
  modeToGroups,
  deriveModeFromGroups,
} from '../../config/mode.js';

const modeCmd: SlashCommand = {
  name: '/mode',
  summary: 'Show or switch the agent mode (chat|basic|tool|composite); rebuilds the tool catalog',
  async run(ctx, args): Promise<void> {
    const c = ctx.controller;
    const current = deriveModeFromGroups({
      builtinTools: c.cfg.builtinTools,
      composites: c.cfg.composites,
      agentToolsEnabled: c.cfg.agentTools.enabled,
    });

    const v = args[0]?.toLowerCase();
    if (v === undefined) {
      ctx.printSystem(`current mode: ${current}. Usage: /mode ${AGENT_MODES.join('|')}`);
      return;
    }
    if (!isAgentMode(v)) {
      ctx.printSystem(`invalid mode '${v}'. Valid modes: ${AGENT_MODES.join(', ')}.`);
      return;
    }
    if (v === current) {
      ctx.printSystem(`mode already ${current}.`);
      return;
    }
    if ((v === 'chat' || v === 'basic') && c.cfg.tools.length > 0) {
      ctx.printSystem(
        `cannot switch to '${v}': wrapped CLI tool(s) are loaded (${c.cfg.tools.join(', ')}) ` +
          `and run through bash_run, which '${v}' mode does not load. ` +
          `Use /mode tool or /mode composite, or restart without --tool.`,
      );
      return;
    }

    const groups = modeToGroups(v);
    const newCfg = {
      ...c.cfg,
      composites: groups.composites,
      builtinTools: groups.builtinTools,
      agentTools: { ...c.cfg.agentTools, enabled: groups.agentToolsEnabled },
    };
    const llm = createLLM(newCfg);
    const { tools, agentToolsMeta } = buildToolCatalog(newCfg, c.logger);
    const capSection = await composeCapabilitiesSystemPrompt(
      newCfg.capabilitiesDir,
      newCfg.tools,
      newCfg.capabilities.maxBytesPerTool,
    );
    const systemPrompt = await buildSystemPromptForCfg(newCfg, capSection, agentToolsMeta, tools);
    c.cfg = newCfg;
    c.agentGraph = buildAgentGraph(llm, tools, systemPrompt, newCfg.maxSteps, newCfg);
    ctx.printSystem(`mode: ${v}.`);
  },
};

registerCommand(modeCmd);
