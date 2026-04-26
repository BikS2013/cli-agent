/**
 * /clear — clear the visible transcript (in-memory only; history files untouched).
 */

import { registerCommand, type SlashCommand } from './registry.js';

const clearCmd: SlashCommand = {
  name: '/clear',
  summary: 'Clear the visible transcript (does not affect persistent history)',
  async run(ctx): Promise<void> {
    // ANSI: clear screen + move cursor to home
    process.stdout.write('\x1b[2J\x1b[H');
    ctx.printSystem('transcript cleared.');
  },
};

registerCommand(clearCmd);
export default clearCmd;
