/**
 * /provider [<name>] — swap the entire provider mid-session.
 *
 * Validates the name against SUPPORTED_PROVIDERS. On config error during
 * factory construction, surfaces the missing-vars list and refuses the swap.
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { SUPPORTED_PROVIDERS, type ProviderName } from '../../config/agent-config.js';
import { ConfigurationError } from '../../errors.js';
import { buildAgentGraph } from '../../agent/graph.js';
import { createLLM } from '../../agent/providers/registry.js';
import { buildToolCatalog } from '../../agent/tools/registry.js';
import { composeCapabilitiesSystemPrompt } from '../../agent/capabilities/compose-system-prompt.js';
import { buildSystemPrompt } from '../../agent/system-prompt.js';
import { BOLD, DIM, RESET } from '../ansi.js';

const providerCmd: SlashCommand = {
  name: '/provider',
  summary: 'Show or swap the active LLM provider (one of the 8 standard names)',
  async run(ctx, args): Promise<void> {
    const c = ctx.controller;
    if (args.length === 0) {
      ctx.println(`${BOLD}Current provider${RESET}`);
      ctx.println(`  ${c.cfg.provider}`);
      ctx.println(`${DIM}Available:${RESET}`);
      for (const p of SUPPORTED_PROVIDERS) {
        ctx.println(`  ${p === c.cfg.provider ? '*' : ' '} ${p}`);
      }
      return;
    }
    const name = args[0]!;
    if (!SUPPORTED_PROVIDERS.includes(name as ProviderName)) {
      ctx.printSystem(`unknown provider '${name}'. Valid: ${SUPPORTED_PROVIDERS.join(', ')}`);
      return;
    }
    const newCfg = { ...c.cfg, provider: name as ProviderName };
    try {
      const llm = createLLM(newCfg);
      const tools = buildToolCatalog(newCfg, c.logger);
      const capSection = await composeCapabilitiesSystemPrompt(
        newCfg.capabilitiesDir,
        newCfg.tools,
        newCfg.capabilities.maxBytesPerTool,
      );
      const systemPrompt = await buildSystemPrompt(capSection);
      const newGraph = buildAgentGraph(llm, tools, systemPrompt, newCfg.maxSteps);
      c.cfg = newCfg;
      c.agentGraph = newGraph;
      ctx.printSystem(`provider swapped to '${name}'.`);
    } catch (e) {
      if (e instanceof ConfigurationError) {
        ctx.printSystem(`provider swap rejected: ${e.message}`);
      } else {
        ctx.printSystem(`provider swap failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  },
};

registerCommand(providerCmd);
export default providerCmd;
