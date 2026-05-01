/**
 * LangGraph ReAct agent graph builder.
 * Uses createReactAgent from @langchain/langgraph/prebuilt.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { DynamicStructuredTool } from '@langchain/core/tools';
import type { Logger } from './logging.js';
import type { AgentConfig } from '../config/agent-config.js';
import type { AgentToolsSession } from './tools/agent-tools/index.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGraph = ReturnType<typeof createReactAgent>;

export interface AgentGraph {
  readonly graph: AnyGraph;
  readonly checkpointer: MemorySaver;
  /**
   * Absolute working directory injected into every agent-tools wrapper
   * via `RunnableConfig.configurable.workingDirectory`. Sourced from
   * `cfg.fileEdit.root` at graph-build time so the value stays stable
   * across turns even if the process cwd later changes.
   */
  readonly workingDirectory: string;
  /**
   * Per-graph in-memory store backing the `agt_todo_read` /
   * `agt_todo_write` pair. Created exactly ONCE per graph so the todo
   * list survives across turns within the same conversation.
   */
  readonly agentToolsSession: AgentToolsSession;
}

/**
 * Streaming events surfaced to the TUI by streamOneShot().
 *
 * Mapped 1:1 from the underlying LangChain `streamEvents(version: 'v2')`
 * stream — see streamOneShot below for the translation table.
 */
export type AgentStreamEvent =
  | { kind: 'token'; text: string }
  | { kind: 'tool_call_start'; toolName: string; args: unknown }
  | { kind: 'tool_call_end'; toolName: string; durationMs: number; ok: boolean }
  | { kind: 'reasoning'; text: string }
  | { kind: 'error'; code: string; message: string };

export function buildAgentGraph(
  llm: BaseChatModel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: DynamicStructuredTool[],
  systemPrompt: string,
  _maxSteps: number,
  cfg: AgentConfig,
): AgentGraph {
  const checkpointer = new MemorySaver();

  const graph = createReactAgent({
    llm,
    tools,
    stateModifier: systemPrompt,
    checkpointSaver: checkpointer,
  });

  // Pin the working directory and create the per-graph session ONCE so
  // both survive across turns within the same conversation. The session
  // is shared by reference with every `agt_todo_*` invocation via
  // `RunnableConfig.configurable.agentToolsSession`.
  const workingDirectory = path.resolve(cfg.fileEdit.root);
  const agentToolsSession: AgentToolsSession = { todos: null };

  return { graph, checkpointer, workingDirectory, agentToolsSession };
}

export async function runOneShot(
  agentGraph: AgentGraph,
  prompt: string,
  threadId: string,
  maxSteps: number,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invokeOptions: Record<string, any> = {
    configurable: {
      thread_id: threadId,
      // Required by every agent-tools wrapper; resolved at graph-build
      // time from `cfg.fileEdit.root` so the value never drifts.
      workingDirectory: agentGraph.workingDirectory,
      // Per-graph store; shared by reference so todo state survives
      // across turns within the same conversation.
      agentToolsSession: agentGraph.agentToolsSession,
    },
    recursionLimit: maxSteps * 2,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await agentGraph.graph.invoke(
    { messages: [new HumanMessage(prompt)] },
    invokeOptions,
  );

  const messages = result['messages'] as Array<{ content: unknown }>;
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return '';

  const content = lastMessage.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((c) => typeof c === 'object' && c !== null && 'text' in c)
      .map((c) => c.text ?? '')
      .join('');
  }
  return JSON.stringify(content);
}

/* ---------- Streaming path used by the TUI ---------- */

interface StreamOneShotOptions {
  readonly logger?: Logger;
  readonly sessionId?: string;
  readonly abortSignal?: AbortSignal;
}

/**
 * Async generator over `agentGraph.graph.streamEvents(input, { version: 'v2' })`.
 *
 * Translation table (LangChain v2 → AgentStreamEvent):
 *   on_chat_model_stream  → { kind: 'token', text: chunk.content }
 *   on_chat_model_end     → emits llm_final log line; no TUI event
 *   on_tool_start         → { kind: 'tool_call_start', toolName, args }
 *   on_tool_end           → { kind: 'tool_call_end', toolName, durationMs, ok }
 *
 * Side effect: emits `llm_chunk` and `llm_final` JSONL log lines via the
 * supplied logger when present (closes the standing pending item from
 * Issues - Pending Items.md).
 *
 * Returns the assembled assistant text. Throws AbortError if the abort
 * signal fires.
 */
export async function* streamOneShot(
  agentGraph: AgentGraph,
  prompt: string,
  threadId: string,
  maxSteps: number,
  opts: StreamOneShotOptions = {},
): AsyncGenerator<AgentStreamEvent, string, void> {
  const turnId = randomUUID();
  const sessionId = opts.sessionId ?? opts.logger?.currentSessionId ?? 'streaming';
  const logger = opts.logger;

  let assembledText = '';
  let toolCallsObserved: Array<{ name: string; args: unknown }> = [];
  // toolName -> startTs (ms)
  const toolTimings = new Map<string, number>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamConfig: Record<string, any> = {
    configurable: {
      thread_id: threadId,
      // Same wiring as `runOneShot` — every agent-tools wrapper reads
      // `workingDirectory` and (todo pair) `agentToolsSession` from the
      // configurable bag; the abort `signal` propagates from the
      // streaming options below.
      workingDirectory: agentGraph.workingDirectory,
      agentToolsSession: agentGraph.agentToolsSession,
      ...(opts.abortSignal ? { signal: opts.abortSignal } : {}),
    },
    version: 'v2',
    recursionLimit: maxSteps * 2,
  };
  if (opts.abortSignal) streamConfig['signal'] = opts.abortSignal;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = agentGraph.graph.streamEvents(
    { messages: [new HumanMessage(prompt)] },
    streamConfig,
  );

  try {
    for await (const event of stream as AsyncIterable<{
      event: string;
      name?: string;
      data?: { chunk?: { content?: unknown }; output?: unknown; input?: unknown };
    }>) {
      if (opts.abortSignal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }

      switch (event.event) {
        case 'on_chat_model_stream': {
          const raw = event.data?.chunk?.content;
          const text = normalizeContent(raw);
          if (text.length > 0) {
            assembledText += text;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const toolCalls = (event.data?.chunk as any)?.tool_calls as
              | ReadonlyArray<{ id?: string; name: string; args: unknown }>
              | undefined;
            if (logger) {
              logger.log({
                kind: 'llm_chunk',
                ts: new Date().toISOString(),
                sessionId,
                turnId,
                messageType: 'ai_chunk',
                content: text,
                ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
              });
            }
            yield { kind: 'token', text };
          }
          break;
        }
        case 'on_chat_model_end': {
          if (logger) {
            const finalText = assembledText;
            logger.log({
              kind: 'llm_final',
              ts: new Date().toISOString(),
              sessionId,
              turnId,
              finalText,
              toolCallsObserved,
            });
          }
          break;
        }
        case 'on_tool_start': {
          const toolName = event.name ?? 'unknown';
          toolTimings.set(toolName, Date.now());
          const args = event.data?.input ?? null;
          toolCallsObserved.push({ name: toolName, args });
          yield { kind: 'tool_call_start', toolName, args };
          break;
        }
        case 'on_tool_end': {
          const toolName = event.name ?? 'unknown';
          const start = toolTimings.get(toolName) ?? Date.now();
          const durationMs = Date.now() - start;
          toolTimings.delete(toolName);
          yield { kind: 'tool_call_end', toolName, durationMs, ok: true };
          break;
        }
        default:
          // Ignore everything else (on_chain_*, on_prompt_*, etc.)
          break;
      }
    }
  } catch (e) {
    const code = e instanceof Error ? e.constructor.name : 'E_UNKNOWN';
    const message = e instanceof Error ? e.message : String(e);
    yield { kind: 'error', code, message };
    throw e;
  }

  return assembledText;
}

function normalizeContent(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return (raw as Array<{ type?: string; text?: string }>)
      .filter((c) => typeof c === 'object' && c !== null && 'text' in c)
      .map((c) => c.text ?? '')
      .join('');
  }
  if (raw == null) return '';
  if (typeof raw === 'object') {
    const t = (raw as { text?: unknown }).text;
    if (typeof t === 'string') return t;
  }
  return '';
}
