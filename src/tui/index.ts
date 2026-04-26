/**
 * TUI entry point — wires the line-editor, controller, slash registry,
 * and abort plumbing together.
 *
 * Bare `cli-agent` invocation (no positional prompt, no -i flag) drops here.
 */

import type { AgentConfig } from '../config/agent-config.js';
import { TuiController } from './controller.js';
import { buildTuiAgentRuntime } from '../agent/run.js';
import { readInput, DEFAULT_PROMPT, DEFAULT_CONTINUATION } from './input/line-editor.js';
import { BOLD, CYAN, DIM, GREEN, RESET, YELLOW } from './ansi.js';
import { readCursor } from './transcript/persist.js';

// Importing each slash module registers its command in the registry.
import './slash/help.js';
import './slash/quit.js';
import './slash/new.js';
import './slash/clear.js';
import './slash/history.js';
import './slash/last.js';
import './slash/copy.js';
import './slash/memory.js';
import './slash/model.js';
import './slash/provider.js';
import './slash/tools.js';
import './slash/allow-mutations.js';
import './slash/capabilities.js';
import './slash/refresh-capabilities.js';
import './slash/tool-help.js';

export interface StartTuiOptions {
  /** Override stdin/stdout for tests. */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

/**
 * Returns true if the current environment can host the raw-mode TUI.
 *
 * Refuses gracefully on non-TTY contexts (pipes, scripts), TERM=dumb, or
 * the explicit CLI_AGENT_NO_TUI=1 escape hatch documented in
 * configuration-guide.md.
 */
export function canHostTui(env: NodeJS.ProcessEnv = process.env, stream: NodeJS.WriteStream = process.stdout): boolean {
  if (env['CLI_AGENT_NO_TUI'] === '1') return false;
  if (env['TERM'] === 'dumb') return false;
  // Permit even when isTTY is undefined; the line-editor degrades gracefully.
  return stream.isTTY === true;
}

export async function startTui(cfg: AgentConfig, opts: StartTuiOptions = {}): Promise<void> {
  const stdin = opts.stdin ?? (process.stdin as NodeJS.ReadStream);
  const stdout = opts.stdout ?? (process.stdout as NodeJS.WriteStream);
  const stderr = opts.stderr ?? (process.stderr as NodeJS.WriteStream);

  if (!canHostTui(process.env, stdout)) {
    const isExplicitOptOut = process.env['CLI_AGENT_NO_TUI'] === '1';
    if (isExplicitOptOut) {
      stderr.write(
        `cli-agent: CLI_AGENT_NO_TUI=1 is set — refusing to enter the TUI. ` +
        `Re-run with --interactive for the readline REPL or pass a positional prompt for one-shot mode.\n`,
      );
    } else {
      stderr.write(
        `cli-agent: TUI requires a TTY (stdout.isTTY=true and TERM != dumb). ` +
        `Re-run with --interactive for the readline REPL or pass a positional prompt for one-shot mode.\n`,
      );
    }
    process.exit(2);
  }

  const runtime = await buildTuiAgentRuntime(cfg);
  const controller = new TuiController({
    cfg,
    agentGraph: runtime.agentGraph,
    logger: runtime.logger,
    stdout,
    stderr,
  });

  // Banner
  stdout.write(`${BOLD}cli-agent TUI (LangGraph)${RESET}\n`);
  stdout.write(`${DIM}LLM: ${cfg.provider} / ${cfg.model || '(default)'}${RESET}\n`);
  stdout.write(`${DIM}Logs: ${runtime.logger.currentLogPath}${RESET}\n`);
  stdout.write(`${DIM}Session: ${controller.threadId.slice(0, 8)}${RESET}\n`);
  stdout.write(`${DIM}Commands: /help /history /memory /new /last /quit  (try /help for the full list)${RESET}\n`);
  stdout.write(`${DIM}Shift+Enter or Ctrl+J for newline; Enter to send; ESC during a turn aborts.${RESET}\n`);

  // Resume prompt
  try {
    const cursor = await readCursor();
    if (cursor) {
      stdout.write(`${YELLOW}Last thread: ${cursor.lastThreadId.slice(0, 8)} (${cursor.lastTurnAt})${RESET}\n`);
    }
  } catch { /* tolerated */ }

  const inputHistory: string[] = [];

  // Global unhandledRejection handler — silently recover from streaming
  // provider errors per spec §2.6, rethrow everything else.
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (/Error reading from the stream|GoogleGenerativeAI|aborted/i.test(msg)) {
      stderr.write(`${DIM}[unhandled stream error swallowed: ${msg.slice(0, 200)}]${RESET}\n`);
      return;
    }
    throw reason;
  });

  // Main loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    let line: string;
    try {
      line = await readInput({
        prompt: DEFAULT_PROMPT,
        continuationPrompt: DEFAULT_CONTINUATION,
        inputHistory,
        stdin,
        stdout,
      });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      if (m === 'SIGINT') {
        stdout.write(`${DIM}(use /quit or Ctrl+D on an empty line to exit)${RESET}\n`);
        continue;
      }
      if (m === 'EOF') {
        controller.logger.log({
          kind: 'session_end',
          ts: new Date().toISOString(),
          sessionId: controller.logger.currentSessionId,
          reason: 'quit',
        });
        await controller.persistIndex();
        await controller.logger.close();
        stdout.write(`${DIM}goodbye.${RESET}\n`);
        process.exit(0);
      }
      throw e;
    }

    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (inputHistory[inputHistory.length - 1] !== trimmed) {
      inputHistory.push(trimmed);
    }

    if (trimmed.startsWith('/')) {
      try {
        await controller.handleSlash(trimmed);
      } catch (e) {
        stderr.write(`${DIM}slash command error: ${e instanceof Error ? e.message : String(e)}${RESET}\n`);
      }
      continue;
    }

    // Run an agent turn with abort support
    const abort = new AbortController();
    const onSig = (): void => abort.abort();
    process.once('SIGINT', onSig);
    // ESC while running -- the line-editor isn't the input source here, so
    // we install a temporary raw-mode reader to detect ESC bytes.
    let rawHandler: ((data: Buffer) => void) | null = null;
    if (typeof stdin.setRawMode === 'function' && stdin.isTTY) {
      try { stdin.setRawMode(true); } catch { /* tolerated */ }
      stdin.resume();
      rawHandler = (data: Buffer): void => {
        for (const b of data) {
          if (b === 0x1b || b === 0x03) {
            abort.abort();
            return;
          }
        }
      };
      stdin.on('data', rawHandler);
    }
    try {
      await controller.runTurn(trimmed, abort);
    } finally {
      process.off('SIGINT', onSig);
      if (rawHandler) stdin.off('data', rawHandler);
      if (typeof stdin.setRawMode === 'function' && stdin.isTTY) {
        try { stdin.setRawMode(false); } catch { /* tolerated */ }
        stdin.pause();
      }
    }
  }
}
