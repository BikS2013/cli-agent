/**
 * /last (alias /raw) — re-render the last assistant reply.
 */

import { registerCommand, type SlashCommand } from './registry.js';

const lastCmd: SlashCommand = {
  name: '/last',
  aliases: ['/raw'],
  summary: 'Re-render the last assistant reply',
  async run(ctx): Promise<void> {
    const text = ctx.controller.lastAssistantText;
    if (!text) {
      ctx.printSystem('no assistant reply yet.');
      return;
    }
    ctx.println(text);
  },
};

registerCommand(lastCmd);
export default lastCmd;
