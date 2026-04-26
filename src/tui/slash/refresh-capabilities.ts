/**
 * /refresh-capabilities [<tool>] — TUI equivalent of the existing
 * `cli-agent refresh-capabilities` subcommand. Shares the underlying
 * discoverTool() implementation.
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { discoverTool } from '../../agent/capabilities/discover.js';
import { createLLM } from '../../agent/providers/registry.js';
import { createSpinner } from '../spinner.js';
import { BOLD, DIM, RESET } from '../ansi.js';

const refreshCmd: SlashCommand = {
  name: '/refresh-capabilities',
  aliases: ['/refresh-caps'],
  summary: 'Re-run capability discovery (single tool or all configured)',
  async run(ctx, args): Promise<void> {
    const c = ctx.controller;
    const targets = args[0] ? [args[0]] : [...c.sessionTools];
    if (targets.length === 0) {
      ctx.printSystem('no tools to refresh. Configure with /tools add <name>.');
      return;
    }
    const llm = createLLM(c.cfg);
    const deadline = Date.now() + c.cfg.capabilities.totalTimeoutMs;
    ctx.println(`${BOLD}Refreshing capabilities${RESET} ${DIM}(${targets.length})${RESET}`);
    for (const tool of targets) {
      const spinner = createSpinner(`discovering ${tool}…`);
      spinner.start();
      let result;
      try {
        result = await discoverTool(tool, c.cfg, llm, c.logger, true, deadline);
      } catch (e) {
        spinner.stop();
        ctx.printSystem(`'${tool}' failed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      spinner.stop();
      ctx.println(`  ${tool.padEnd(20)} ${result.status.padEnd(10)} ${String(result.bytes ?? 0).padStart(6)} bytes  ${result.durationMs ?? 0}ms`);
    }
  },
};

registerCommand(refreshCmd);
export default refreshCmd;
