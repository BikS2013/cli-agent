/**
 * /model [<id>] — swap the LLM model id mid-session.
 *
 * `/model` with no args prints the current provider + model and (provider-
 * specific) sensible suggestions. `/model <id>` rebuilds the LLM via the
 * existing provider factory and re-creates the agent graph in place. The
 * MemorySaver thread is reset (per the brief: graph is rebuilt; the previous
 * thread persists in the history JSONL).
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { buildAgentGraph } from '../../agent/graph.js';
import { createLLM } from '../../agent/providers/registry.js';
import { buildToolCatalog } from '../../agent/tools/registry.js';
import { composeCapabilitiesSystemPrompt } from '../../agent/capabilities/compose-system-prompt.js';
import { buildSystemPrompt } from '../../agent/system-prompt.js';
import { BOLD, DIM, RESET } from '../ansi.js';

const SUGGESTIONS: Record<string, ReadonlyArray<string>> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'o1-mini'],
  anthropic: ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
  gemini: ['gemini-2.0-flash', 'gemini-1.5-pro'],
  'azure-openai': ['<your-deployment-name>'],
  'azure-anthropic': ['<your-foundry-deployment>'],
  ollama: ['llama3.2', 'qwen2.5-coder'],
  litellm: ['<see-your-litellm-router>'],
  mlx: ['<local-mlx-model>'],
};

const modelCmd: SlashCommand = {
  name: '/model',
  summary: 'Show or swap the active LLM model id',
  async run(ctx, args): Promise<void> {
    const c = ctx.controller;
    if (args.length === 0) {
      ctx.println(`${BOLD}Current model${RESET}`);
      ctx.println(`  provider: ${c.cfg.provider}`);
      ctx.println(`  model:    ${c.cfg.model}`);
      const sug = SUGGESTIONS[c.cfg.provider] ?? [];
      if (sug.length > 0) {
        ctx.println(`${DIM}Suggestions for ${c.cfg.provider}:${RESET}`);
        for (const s of sug) ctx.println(`  ${s}`);
      }
      return;
    }
    const newId = args.join(' ').trim();
    if (!newId) {
      ctx.printSystem('usage: /model <id>');
      return;
    }
    const newCfg = { ...c.cfg, model: newId };
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
      // Note: thread continues; only the graph is swapped.
      ctx.printSystem(`model swapped to '${newId}'. Thread preserved.`);
    } catch (e) {
      ctx.printSystem(`model swap failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

registerCommand(modelCmd);
export default modelCmd;
