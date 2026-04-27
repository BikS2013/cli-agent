/**
 * /refresh-capabilities [<tool>] — TUI equivalent of the existing
 * `cli-agent refresh-capabilities` subcommand. Shares the underlying
 * discoverTool() implementation.
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { discoverTool, type DiscoveryProgress } from '../../agent/capabilities/discover.js';
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
      const spinner = createSpinner(`discovering '${tool}'…`);
      spinner.start();
      // Update the spinner label as discovery progresses so the user can
      // see which phase is running — the LLM extraction is almost always
      // the dominant cost.
      const reporter: DiscoveryProgress = (e) => {
        switch (e.kind) {
          case 'start':         spinner.setLabel(`discovering '${e.tool}'…`); break;
          case 'probe':         spinner.setLabel(`'${e.tool}': probed binary`); break;
          case 'help':          spinner.setLabel(`'${e.tool}': read --help (${e.bytes}B)`); break;
          case 'extract_start': spinner.setLabel(`'${e.tool}': asking LLM to extract subcommands…`); break;
          case 'extract_end':   spinner.setLabel(`'${e.tool}': extracted ${e.subcommandCount} subcommands`); break;
          case 'extract_skipped': spinner.setLabel(`'${e.tool}': skipped LLM (small help, ${e.helpBytes}B)`); break;
          case 'subcommands':   spinner.setLabel(`'${e.tool}': fetched ${e.count} subcommand --helps`); break;
          default: break;
        }
      };
      let result;
      try {
        // forceFullInvestigation=true → bypass the skipLlmBelowBytes
        // fast path so the LLM extractor always runs. /refresh-capabilities
        // is the user's explicit "redo everything" knob; partial discovery
        // here would defeat its purpose.
        result = await discoverTool(tool, c.cfg, llm, c.logger, true, deadline, reporter, true);
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
