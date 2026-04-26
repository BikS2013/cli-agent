/**
 * /history — paginated browser of past threads.
 *
 * MVP behavior: prints the most-recent N threads with their timestamp,
 * turn count, and first prompt. Selection (loading a thread as read-only
 * context) is not part of the MVP because it requires terminal-side
 * interaction beyond the simple slash dispatch and is registered as a
 * follow-up in Issues - Pending Items.md.
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { readIndex } from '../transcript/persist.js';
import { BOLD, DIM, RESET } from '../ansi.js';

const PAGE_SIZE = 20;

const historyCmd: SlashCommand = {
  name: '/history',
  summary: 'List the most recent threads (newest first)',
  async run(ctx, args): Promise<void> {
    const offset = args[0] ? Math.max(0, parseInt(args[0], 10) || 0) : 0;
    const entries = await readIndex();
    if (entries.length === 0) {
      ctx.printSystem('no thread history yet.');
      return;
    }
    // Newest first by lastTurnAt
    const sorted = [...entries].sort((a, b) => b.lastTurnAt.localeCompare(a.lastTurnAt));
    const slice = sorted.slice(offset, offset + PAGE_SIZE);
    ctx.println(`${BOLD}Recent threads${RESET} ${DIM}(${offset + 1}-${offset + slice.length} of ${sorted.length})${RESET}`);
    for (let i = 0; i < slice.length; i++) {
      const e = slice[i]!;
      const idx = offset + i + 1;
      ctx.println(`  ${idx}. ${e.threadId.slice(0, 8)}  ${DIM}${e.lastTurnAt}${RESET}  turns=${e.turnCount}`);
      ctx.println(`     ${DIM}${e.firstPrompt.slice(0, 120)}${RESET}`);
    }
    if (sorted.length > offset + slice.length) {
      ctx.printSystem(`use '/history ${offset + PAGE_SIZE}' for the next page.`);
    }
  },
};

registerCommand(historyCmd);
export default historyCmd;
