/**
 * /tool-help <tool> [<subcommand>] — TUI equivalent of the runtime tool_help
 * LLM tool. Reads the same per-tool Markdown file via the same path resolver
 * (capabilitiesDir + `<tool>.md`).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { registerCommand, type SlashCommand } from './registry.js';
import { BOLD, DIM, RESET } from '../ansi.js';

const toolHelpCmd: SlashCommand = {
  name: '/tool-help',
  aliases: ['/help-tool'],
  summary: 'Print a wrapped tool\'s capability doc (full or single subcommand)',
  async run(ctx, args): Promise<void> {
    const c = ctx.controller;
    const tool = args[0];
    if (!tool) {
      ctx.printSystem('usage: /tool-help <tool> [<subcommand>]');
      return;
    }
    const subcommand = args[1];
    const file = path.join(c.cfg.capabilitiesDir, `${tool}.md`);
    let content: string;
    try {
      content = await fsp.readFile(file, 'utf8');
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') {
        ctx.printSystem(`no capability doc for '${tool}'. Try: /refresh-capabilities ${tool}`);
        return;
      }
      throw e;
    }

    if (!subcommand) {
      // Print full doc, soft-cap to keep TUI snappy
      const text = content.length > 8192 ? content.slice(0, 8192) + `\n${DIM}…(${content.length - 8192} more bytes — read the file directly)${RESET}` : content;
      ctx.println(`${BOLD}${tool}${RESET}`);
      ctx.println(text);
      return;
    }

    const re = new RegExp(`### ${subcommand}\\n([\\s\\S]*?)(?=\\n### |\\n## |<!-- |$)`);
    const match = content.match(re);
    if (!match) {
      ctx.printSystem(`subcommand '${subcommand}' not found in '${tool}'.`);
      return;
    }
    ctx.println(`${BOLD}${tool} ${subcommand}${RESET}`);
    ctx.println((match[1] ?? '').trim());
  },
};

registerCommand(toolHelpCmd);
export default toolHelpCmd;
