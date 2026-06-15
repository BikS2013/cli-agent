/**
 * /tools <add|remove|list> [name] [--save]
 *
 * - add <name>      register a wrapped CLI tool, run capability discovery, rebuild
 *                   graph + bash allowlist
 * - remove <name>   drop the tool, rebuild
 * - list            print active tools (session vs persisted)
 * - --save          persist the change to ~/.tool-agents/cli-agent/config.json
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { registerCommand, type SlashCommand } from './registry.js';
import { buildAgentGraph } from '../../agent/graph.js';
import { createLLM } from '../../agent/providers/registry.js';
import { buildToolCatalog } from '../../agent/tools/registry.js';
import { discoverTool } from '../../agent/capabilities/discover.js';
import { composeCapabilitiesSystemPrompt } from '../../agent/capabilities/compose-system-prompt.js';
import { buildSystemPromptForCfg } from '../../agent/system-prompt.js';
import { agentToolAgentsDir } from '../../config/agent-config.js';
import { BOLD, DIM, RESET } from '../ansi.js';

async function persistToolsToConfig(tools: ReadonlyArray<string>): Promise<string> {
  const configPath = path.join(agentToolAgentsDir(), 'config.json');
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fsp.readFile(configPath, 'utf8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
    existing = { schemaVersion: 1 };
  }
  existing['tools'] = [...tools];
  await fsp.writeFile(configPath, JSON.stringify(existing, null, 2) + '\n', { mode: 0o600 });
  return configPath;
}

async function rebuildGraph(c: import('../controller.js').TuiController): Promise<void> {
  const newCfg = { ...c.cfg, tools: [...c.sessionTools] };
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
}

const toolsCmd: SlashCommand = {
  name: '/tools',
  summary: 'Manage the wrapped-CLI tool list (add|remove|list, --save to persist)',
  async run(ctx, args): Promise<void> {
    const c = ctx.controller;
    const sub = args[0] ?? 'list';
    const saveFlag = args.includes('--save');
    const positional = args.filter((a) => a !== '--save');

    if (sub === 'list') {
      ctx.println(`${BOLD}Active tools${RESET} ${DIM}(session)${RESET}`);
      if (c.sessionTools.length === 0) ctx.println('  (none)');
      for (const t of c.sessionTools) ctx.println(`  ${t}`);
      return;
    }
    if (sub === 'add') {
      const name = positional[1];
      if (!name) {
        ctx.printSystem('usage: /tools add <name> [--save]');
        return;
      }
      if (c.sessionTools.includes(name)) {
        ctx.printSystem(`tool '${name}' already active.`);
        return;
      }
      c.sessionTools.push(name);
      ctx.printSystem(`discovering capabilities for '${name}'…`);
      try {
        const llm = createLLM(c.cfg);
        const deadline = Date.now() + c.cfg.capabilities.totalTimeoutMs;
        const result = await discoverTool(name, c.cfg, llm, c.logger, true, deadline);
        ctx.printSystem(`discovery: ${result.status} (${result.bytes ?? 0} bytes, ${result.durationMs ?? 0}ms)`);
      } catch (e) {
        ctx.printSystem(`discovery failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      await rebuildGraph(c);
      ctx.printSystem(`tool '${name}' added.`);
      if (saveFlag) {
        const p = await persistToolsToConfig(c.sessionTools);
        ctx.printSystem(`persisted to ${p}.`);
      }
      return;
    }
    if (sub === 'remove') {
      const name = positional[1];
      if (!name) {
        ctx.printSystem('usage: /tools remove <name> [--save]');
        return;
      }
      const idx = c.sessionTools.indexOf(name);
      if (idx < 0) {
        ctx.printSystem(`tool '${name}' is not active.`);
        return;
      }
      c.sessionTools.splice(idx, 1);
      await rebuildGraph(c);
      ctx.printSystem(`tool '${name}' removed.`);
      if (saveFlag) {
        const p = await persistToolsToConfig(c.sessionTools);
        ctx.printSystem(`persisted to ${p}.`);
      }
      return;
    }
    ctx.printSystem(`unknown subcommand '${sub}'. Try add|remove|list.`);
  },
};

registerCommand(toolsCmd);
export default toolsCmd;
