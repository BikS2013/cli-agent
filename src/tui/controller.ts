/**
 * TUI controller — owns the live session state, the AbortController for the
 * in-flight LLM call, the rendering loop, and slash-command dispatch.
 *
 * The controller is intentionally backend-agnostic about the streaming source:
 * it consumes any AsyncGenerator<AgentStreamEvent>. The default factory wires
 * it to streamOneShot on the active AgentGraph.
 */

import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../config/agent-config.js';
import type { Logger } from '../agent/logging.js';
import type { AgentGraph, AgentStreamEvent } from '../agent/graph.js';
import { streamOneShot } from '../agent/graph.js';
import { createSpinner, type Spinner } from './spinner.js';
import { CLEAR_LINE, BOLD, CYAN, DIM, GREEN, RED, RESET, YELLOW } from './ansi.js';
import {
  appendTurn,
  ensureHistoryDir,
  threadFilePath,
  upsertIndexEntry,
  writeCursor,
} from './transcript/persist.js';
import type { TurnRecord } from './transcript/types.js';
import { dispatchSlash, type SlashContext } from './slash/registry.js';

export interface TuiAssistantMessage {
  readonly role: 'assistant';
  readonly text: string;
  readonly ts: string;
  readonly toolCalls: ReadonlyArray<{ toolName: string; durationMs: number; ok: boolean }>;
}
export interface TuiUserMessage {
  readonly role: 'user';
  readonly text: string;
  readonly ts: string;
}
export type TuiMessage = TuiUserMessage | TuiAssistantMessage;

export interface TuiControllerOptions {
  readonly cfg: AgentConfig;
  readonly agentGraph: AgentGraph;
  readonly logger: Logger;
  readonly stdout?: NodeJS.WriteStream;
  readonly stderr?: NodeJS.WriteStream;
}

export class TuiController {
  public cfg: AgentConfig;
  public agentGraph: AgentGraph;
  public logger: Logger;
  public threadId: string;
  public threadStartedAt: Date;
  public messages: TuiMessage[] = [];
  public lastAssistantText: string = '';
  /** Mutable in-session bash allowlist / tool list overrides — applied via /tools. */
  public sessionTools: string[];
  public sessionAllowMutations: boolean;

  private readonly stdout: NodeJS.WriteStream;
  private readonly stderr: NodeJS.WriteStream;

  public constructor(opts: TuiControllerOptions) {
    this.cfg = opts.cfg;
    this.agentGraph = opts.agentGraph;
    this.logger = opts.logger;
    this.stdout = opts.stdout ?? (process.stdout as NodeJS.WriteStream);
    this.stderr = opts.stderr ?? (process.stderr as NodeJS.WriteStream);
    this.threadId = randomUUID();
    this.threadStartedAt = new Date();
    this.sessionTools = [...opts.cfg.tools];
    this.sessionAllowMutations = opts.cfg.allowMutations;
  }

  /** Append a [system]-prefixed dim message line. */
  public printSystem(text: string): void {
    this.stdout.write(`${CLEAR_LINE}${YELLOW}${DIM}[system]${RESET} ${DIM}${text}${RESET}\n`);
  }

  public println(text: string): void {
    this.stdout.write(`${CLEAR_LINE}${text}\n`);
  }

  /** Construct a SlashContext bound to this controller. */
  public makeSlashContext(): SlashContext {
    return {
      controller: this,
      printSystem: (s) => this.printSystem(s),
      println: (s) => this.println(s),
    };
  }

  /** Reset to a fresh thread (used by /new and /model and /provider). */
  public async resetThread(): Promise<void> {
    // Persist the previous thread's index entry first
    await this.persistIndex();
    this.threadId = randomUUID();
    this.threadStartedAt = new Date();
    this.messages = [];
    this.lastAssistantText = '';
  }

  /** Persist a TurnRecord to the active thread's JSONL file. */
  public async persistTurn(role: 'user' | 'assistant', text: string, turnId: string): Promise<void> {
    const turn: TurnRecord = {
      ts: new Date().toISOString(),
      threadId: this.threadId,
      turnId,
      role,
      content: text,
    };
    const file = threadFilePath(this.threadId, this.threadStartedAt);
    await ensureHistoryDir();
    await appendTurn(file, turn);
    await writeCursor({ lastThreadId: this.threadId, lastTurnAt: turn.ts });
  }

  /** Update index.jsonl for the current thread. */
  public async persistIndex(): Promise<void> {
    if (this.messages.length === 0) return;
    const userMsgs = this.messages.filter((m): m is TuiUserMessage => m.role === 'user');
    if (userMsgs.length === 0) return;
    await upsertIndexEntry({
      threadId: this.threadId,
      startedAt: this.threadStartedAt.toISOString(),
      lastTurnAt: this.messages[this.messages.length - 1]!.ts,
      turnCount: userMsgs.length,
      firstPrompt: userMsgs[0]!.text.slice(0, 200),
    });
  }

  /**
   * Run a single turn against the agent. Streams tokens directly to stdout;
   * renders tool-call summaries; honors AbortSignal.
   */
  public async runTurn(prompt: string, abort: AbortController): Promise<void> {
    const turnId = randomUUID();
    const userTs = new Date().toISOString();
    const userMsg: TuiUserMessage = { role: 'user', text: prompt, ts: userTs };
    this.messages.push(userMsg);
    await this.persistTurn('user', prompt, turnId);

    const spinner: Spinner = createSpinner('Thinking...', { stream: this.stdout });
    spinner.start();

    let assembled = '';
    let headerPrinted = false;
    const toolCallTimes = new Map<string, number>();
    const toolCalls: Array<{ toolName: string; durationMs: number; ok: boolean }> = [];

    const ensureHeader = (): void => {
      if (headerPrinted) return;
      spinner.stop();
      this.stdout.write(`${BOLD}${CYAN}Agent${RESET} `);
      headerPrinted = true;
    };

    try {
      const it = streamOneShot(this.agentGraph, prompt, this.threadId, this.cfg.maxSteps, {
        logger: this.logger,
        sessionId: this.logger.currentSessionId,
        abortSignal: abort.signal,
      });
      while (true) {
        if (abort.signal.aborted) break;
        const next = await it.next();
        if (next.done) {
          assembled = next.value ?? assembled;
          break;
        }
        const ev: AgentStreamEvent = next.value;
        switch (ev.kind) {
          case 'token':
            ensureHeader();
            this.stdout.write(ev.text);
            assembled += ev.text;
            break;
          case 'tool_call_start':
            ensureHeader();
            this.stdout.write(`\n  ${CYAN}↳${RESET} calling ${BOLD}${ev.toolName}${RESET}(...)`);
            toolCallTimes.set(ev.toolName, Date.now());
            break;
          case 'tool_call_end': {
            this.stdout.write(` ${GREEN}✓${RESET} ${DIM}(${ev.durationMs}ms)${RESET}`);
            toolCalls.push({ toolName: ev.toolName, durationMs: ev.durationMs, ok: ev.ok });
            spinner.setLabel('Processing tool result...');
            spinner.start();
            break;
          }
          case 'reasoning':
            // optional channel — render dim
            ensureHeader();
            this.stdout.write(`${DIM}${ev.text}${RESET}`);
            break;
          case 'error':
            this.stderr.write(`\n${RED}error[${ev.code}]:${RESET} ${ev.message}\n`);
            break;
        }
      }

      spinner.stop();
      if (abort.signal.aborted) {
        this.stdout.write(`\n${YELLOW}${DIM}[aborted]${RESET}\n`);
      } else {
        this.stdout.write('\n');
      }

      this.lastAssistantText = assembled;
      const assistantMsg: TuiAssistantMessage = {
        role: 'assistant',
        text: assembled,
        ts: new Date().toISOString(),
        toolCalls,
      };
      this.messages.push(assistantMsg);
      if (assembled.length > 0) {
        await this.persistTurn('assistant', assembled, turnId);
      }
    } catch (e) {
      spinner.stop();
      const message = e instanceof Error ? e.message : String(e);
      if (abort.signal.aborted || /abort/i.test(message)) {
        this.stdout.write(`\n${YELLOW}${DIM}[aborted]${RESET}\n`);
      } else {
        this.stderr.write(`\n${RED}Error:${RESET} ${message}\n`);
      }
    } finally {
      await this.persistIndex();
    }
  }

  /** Slash dispatch entry point. */
  public async handleSlash(line: string): Promise<void> {
    await dispatchSlash(line, this.makeSlashContext());
  }
}
