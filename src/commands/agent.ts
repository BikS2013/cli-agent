/**
 * Main agent command handler.
 *
 * Dispatch:
 *   - `--interactive`/`-i`     → readline REPL (legacy lightweight fallback)
 *   - bare invocation, no prompt → raw-mode TUI
 *   - positional prompt          → streaming one-shot (tokens written as they arrive)
 */

import type { AgentCliFlags } from '../config/agent-config.js';
import { loadAgentConfig } from '../config/agent-config.js';
import { runInteractiveAgent, streamOneShotAgent } from '../agent/run.js';
import { startTui } from '../tui/index.js';

export interface AgentCommandOptions extends AgentCliFlags {
  interactive?: boolean;
  tools?: string[];
  /**
   * `--resume`/`-r` flag. `true` means "resume last active thread from
   * cursor.json"; a string means "resume that specific threadId".
   * `undefined` means no resume requested.
   */
  resume?: boolean | string;
}

export async function runAgentCommand(
  prompt: string | null,
  opts: AgentCommandOptions,
): Promise<void> {
  const cfg = await loadAgentConfig(opts);

  if (opts.interactive) {
    if (opts.resume !== undefined) {
      throw new Error('cli-agent: --resume is supported only in TUI mode (omit --interactive).');
    }
    await runInteractiveAgent(cfg);
    return;
  }

  if (!prompt) {
    // Bare invocation drops into the TUI
    await startTui(cfg, { resume: opts.resume });
    return;
  }

  if (opts.resume !== undefined) {
    throw new Error('cli-agent: --resume is supported only in TUI mode (drop the positional prompt).');
  }

  // One-shot mode: stream tokens to stdout as they arrive
  let assembled = '';
  const it = streamOneShotAgent(cfg, prompt);
  while (true) {
    const next = await it.next();
    if (next.done) {
      assembled = next.value ?? assembled;
      break;
    }
    const ev = next.value;
    if (ev.kind === 'token') {
      process.stdout.write(ev.text);
      assembled += ev.text;
    }
    // tool_call_start/end and other channels are not surfaced in plain
    // one-shot output to keep the bytes pipe-clean.
  }
  if (!assembled.endsWith('\n')) process.stdout.write('\n');
}
