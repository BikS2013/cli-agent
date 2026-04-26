/**
 * /memory — diagnostic view of the active thread's MemorySaver state.
 *
 * Reads agentGraph.checkpointer.get(...) for the current thread_id and prints
 * the message-history summary (count + last few message kinds).
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { BOLD, DIM, RESET } from '../ansi.js';

const memoryCmd: SlashCommand = {
  name: '/memory',
  summary: 'Diagnostic view of the active thread\'s MemorySaver state',
  async run(ctx): Promise<void> {
    const c = ctx.controller;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const checkpointer: any = c.agentGraph.checkpointer;
      const config = { configurable: { thread_id: c.threadId } };
      const cp = await checkpointer.get(config);
      if (!cp) {
        ctx.printSystem('no checkpoint stored yet for this thread.');
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const channelValues = (cp as any).channel_values ?? {};
      const messages = channelValues.messages ?? [];
      ctx.println(`${BOLD}MemorySaver state${RESET} ${DIM}thread=${c.threadId.slice(0, 8)}${RESET}`);
      ctx.println(`  messages: ${Array.isArray(messages) ? messages.length : 0}`);
      if (Array.isArray(messages)) {
        const tail = messages.slice(-5);
        for (const m of tail) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const mm = m as any;
          const kind = mm._getType?.() ?? mm.role ?? mm.constructor?.name ?? 'msg';
          const content = typeof mm.content === 'string' ? mm.content.slice(0, 80) : '';
          ctx.println(`    ${DIM}${kind}${RESET} ${content}`);
        }
      }
    } catch (e) {
      ctx.printSystem(`failed to read memory: ${e instanceof Error ? e.message : String(e)}`);
    }
  },
};

registerCommand(memoryCmd);
export default memoryCmd;
