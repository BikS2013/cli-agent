/**
 * /help — list registered commands and keybindings.
 */

import { listCommands, registerCommand, type SlashCommand } from './registry.js';
import { KEYBINDINGS } from '../input/keybindings.js';
import { BOLD, DIM, RESET } from '../ansi.js';

const helpCmd: SlashCommand = {
  name: '/help',
  aliases: ['/?'],
  summary: 'List slash commands and keybindings',
  async run(ctx): Promise<void> {
    ctx.println(`${BOLD}Slash commands${RESET}`);
    for (const c of listCommands()) {
      const aliases = c.aliases && c.aliases.length > 0 ? ` ${DIM}(aliases: ${c.aliases.join(', ')})${RESET}` : '';
      ctx.println(`  ${c.name}${aliases}`);
      ctx.println(`    ${DIM}${c.summary}${RESET}`);
    }
    ctx.println('');
    ctx.println(`${BOLD}Keybindings${RESET}`);
    for (const kb of KEYBINDINGS) {
      ctx.println(`  ${kb.keys}`);
      ctx.println(`    ${DIM}${kb.action}${RESET}`);
    }
  },
};

registerCommand(helpCmd);
export default helpCmd;
