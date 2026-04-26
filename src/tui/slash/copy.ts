/**
 * /copy — copy the last assistant reply to the system clipboard.
 *
 * Uses the TUI's internal clipboard helper, which dispatches via bash/exec.ts
 * to a hard-coded TUI-internal allowlist (pbcopy / xclip / xsel / clip.exe).
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { copyToClipboard } from '../clipboard.js';

const copyCmd: SlashCommand = {
  name: '/copy',
  summary: 'Copy the last assistant reply to the system clipboard',
  async run(ctx): Promise<void> {
    const text = ctx.controller.lastAssistantText;
    if (!text) {
      ctx.printSystem('no assistant reply to copy.');
      return;
    }
    const result = await copyToClipboard(text);
    if (result.ok) {
      ctx.printSystem(`copied ${text.length} chars via ${result.binary}.`);
    } else {
      ctx.printSystem(`copy failed: ${result.message ?? 'unknown error'}`);
    }
  },
};

registerCommand(copyCmd);
export default copyCmd;
