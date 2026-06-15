/**
 * TUI entry point — wires the line-editor, controller, slash registry,
 * and abort plumbing together.
 *
 * Bare `cli-agent` invocation (no positional prompt, no -i flag) drops here.
 */

import type { AgentConfig } from '../config/agent-config.js';
import { TuiController, type TuiAssistantMessage, type TuiMessage, type TuiUserMessage } from './controller.js';
import { buildTuiAgentRuntime } from '../agent/run.js';
import { readInput, DEFAULT_PROMPT, DEFAULT_CONTINUATION } from './input/line-editor.js';
import { BOLD, CYAN, DIM, GREEN, RESET, YELLOW } from './ansi.js';
import {
  readCursor,
  readIndex,
  findThreadFile,
  readThreadTurns,
} from './transcript/persist.js';
import { loadCheckpoint, hasCheckpoint } from '../agent/checkpoint-store.js';

// Importing each slash module registers its command in the registry.
import './slash/help.js';
import './slash/quit.js';
import './slash/new.js';
import './slash/clear.js';
import './slash/history.js';
import './slash/last.js';
import './slash/copy.js';
import './slash/memory.js';
import './slash/inspect.js';
import './slash/model.js';
import './slash/provider.js';
import './slash/tools.js';
import './slash/allow-mutations.js';
import './slash/capabilities.js';
import './slash/refresh-capabilities.js';
import './slash/tool-help.js';
import './slash/resume.js';

export interface StartTuiOptions {
  /** Override stdin/stdout for tests. */
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
  /**
   * Optional resume request (mirrors the CLI `--resume` flag):
   *   - `true`         → resume the last thread from cursor.json
   *   - `<threadId>`   → resume the specified thread
   *   - undefined      → start a fresh thread (default)
   *
   * If a resume is requested but no matching checkpoint or transcript
   * exists, startTui throws — surface the error to the user as a
   * UsageError; do not silently fall back to a fresh thread.
   */
  readonly resume?: boolean | string;
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

/**
 * Translate the `--resume`/`-r` flag value into a concrete threadId.
 *
 *   - `true`        → the last active thread recorded in cursor.json
 *   - `<threadId>`  → that exact thread
 *
 * Throws (process.exit 2) when the requested thread cannot be located.
 */
async function resolveResumeThreadId(value: boolean | string): Promise<string> {
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  const cursor = await readCursor();
  if (!cursor) {
    process.stderr.write(
      `cli-agent: --resume requested but no prior session was found ` +
      `(expected ~/.tool-agents/cli-agent/history/cursor.json).\n`,
    );
    process.exit(2);
  }
  return cursor.lastThreadId;
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

  // If --resume was passed, resolve the target threadId BEFORE building the
  // runtime so we can hydrate the checkpointer in-place after construction.
  let resumeTargetThreadId: string | null = null;
  if (opts.resume !== undefined) {
    resumeTargetThreadId = await resolveResumeThreadId(opts.resume);
  }

  const runtime = await buildTuiAgentRuntime(cfg);

  // Hydrate the checkpointer with the prior LangGraph state, if requested.
  // This MUST happen before the first turn so the LLM sees the prior
  // conversation as part of its checkpointed messages.
  let resumedTurns: import('./transcript/types.js').TurnRecord[] = [];
  let resumedStartedAt: Date | null = null;
  if (resumeTargetThreadId) {
    const ok = await loadCheckpoint(resumeTargetThreadId, runtime.agentGraph.checkpointer);
    if (!ok) {
      stderr.write(
        `cli-agent: no checkpoint snapshot found for thread ${resumeTargetThreadId} ` +
        `(expected ~/.tool-agents/cli-agent/history/checkpoint-${resumeTargetThreadId}.json).\n`,
      );
      process.exit(2);
    }

    const file = await findThreadFile(resumeTargetThreadId);
    if (file) {
      resumedTurns = await readThreadTurns(file);
    }
    const idx = await readIndex();
    const entry = idx.find((e) => e.threadId === resumeTargetThreadId);
    resumedStartedAt = entry ? new Date(entry.startedAt) : new Date();
  }

  const controller = new TuiController({
    cfg,
    agentGraph: runtime.agentGraph,
    logger: runtime.logger,
    ioCapture: runtime.ioCapture,
    stdout,
    stderr,
  });

  if (resumeTargetThreadId && resumedStartedAt) {
    const messages: TuiMessage[] = resumedTurns.map((t): TuiMessage => {
      if (t.role === 'user') {
        const m: TuiUserMessage = { role: 'user', text: t.content, ts: t.ts };
        return m;
      }
      const m: TuiAssistantMessage = {
        role: 'assistant', text: t.content, ts: t.ts, toolCalls: [],
      };
      return m;
    });
    controller.applyResume(resumeTargetThreadId, resumedStartedAt, messages);
  }

  // Banner
  stdout.write(`${BOLD}cli-agent TUI (LangGraph)${RESET}\n`);
  stdout.write(`${DIM}LLM: ${cfg.provider} / ${cfg.model || '(default)'}${RESET}\n`);
  stdout.write(`${DIM}Logs: ${runtime.logger.currentLogPath}${RESET}\n`);
  stdout.write(`${DIM}Session: ${controller.threadId.slice(0, 8)}${RESET}\n`);
  stdout.write(`${DIM}Commands: /help /history /memory /new /last /resume /quit  (try /help for the full list)${RESET}\n`);
  stdout.write(`${DIM}Shift+Enter or Ctrl+J for newline; Enter to send; ESC during a turn aborts; double Ctrl+C exits.${RESET}\n`);

  if (resumeTargetThreadId) {
    const userTurns = resumedTurns.filter((t) => t.role === 'user').length;
    stdout.write(
      `${GREEN}Resumed thread ${resumeTargetThreadId.slice(0, 8)} ` +
      `(${userTurns} prior turn${userTurns === 1 ? '' : 's'} restored)${RESET}\n`,
    );
  } else {
    // Standard "last thread" hint for non-resume launches.
    try {
      const cursor = await readCursor();
      if (cursor) {
        const has = await hasCheckpoint(cursor.lastThreadId);
        const hint = has ? ' — pass --resume to continue' : '';
        stdout.write(
          `${YELLOW}Last thread: ${cursor.lastThreadId.slice(0, 8)} ` +
          `(${cursor.lastTurnAt})${hint}${RESET}\n`,
        );
      }
    } catch { /* tolerated */ }
  }

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

  // Double Ctrl+C debounce: a second SIGINT received within this window of
  // the first triggers the same graceful shutdown as Ctrl+D / /quit. The
  // first press only emits a hint and continues the input loop. Reset
  // implicitly: any real input on the next iteration is irrelevant — the
  // timestamp comparison is what matters, not a flag.
  const DOUBLE_SIGINT_WINDOW_MS = 1500;
  let lastSigintAt = 0;

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
        const now = Date.now();
        if (now - lastSigintAt < DOUBLE_SIGINT_WINDOW_MS) {
          // Treat the second Ctrl+C inside the window as a graceful exit.
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
        lastSigintAt = now;
        const seconds = Math.round(DOUBLE_SIGINT_WINDOW_MS / 1000);
        stdout.write(
          `${DIM}(press Ctrl+C again within ${seconds}s to exit, or use /quit / Ctrl+D)${RESET}\n`,
        );
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
