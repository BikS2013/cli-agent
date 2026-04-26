/**
 * /quit (alias /exit) — graceful shutdown.
 */

import { registerCommand, type SlashCommand } from './registry.js';

const quitCmd: SlashCommand = {
  name: '/quit',
  aliases: ['/exit'],
  summary: 'Exit the TUI (persists thread index, closes the session log)',
  async run(ctx): Promise<void> {
    const c = ctx.controller;
    await c.persistIndex();
    c.logger.log({
      kind: 'session_end',
      ts: new Date().toISOString(),
      sessionId: c.logger.currentSessionId,
      reason: 'quit',
    });
    await c.logger.close();
    ctx.printSystem('goodbye.');
    process.exit(0);
  },
};

registerCommand(quitCmd);
export default quitCmd;
