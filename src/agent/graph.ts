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
import type { AIMessage, AIMessageChunk, BaseMessage } from '@langchain/core/messages';
import type { Logger } from './logging.js';
import type { AgentConfig } from '../config/agent-config.js';
import type { AgentToolsSession } from './tools/agent-tools/index.js';
import type { IoCapture } from './io-capture.js';
import { extractStartMessages, toCaptureMessage } from './io-capture.js';

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
  /**
   * Profile-supplied tool-args bag (plan-005, U-ARGS). Outer key = tool name,
   * inner record = preset arg key/value pairs overlayed onto runtime input by
   * `mergeProfileToolArgs` at the top of every tool's `.func`. Threaded into
   * the LangChain `RunnableConfig.configurable` bag at every `runOneShot` /
   * `streamOneShot` call so the per-tool helper can consult it without a
   * back-reference into `cfg`. Empty object `{}` when no profile is active.
   */
  readonly profileToolArgs: Record<string, Record<string, unknown>>;
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
  // Profile tool-args bag (plan-005, U-ARGS). Frozen to defend against
  // accidental mutation by any tool factory; consumed via
  // `mergeProfileToolArgs(input, runConfig?.configurable, TOOL_NAME)`.
  const profileToolArgs: Record<string, Record<string, unknown>> =
    cfg.activeProfileData?.toolArgs ?? {};

  return { graph, checkpointer, workingDirectory, agentToolsSession, profileToolArgs };
}

export async function runOneShot(
  agentGraph: AgentGraph,
  prompt: string,
  threadId: string,
  maxSteps: number,
  captureOpts: { ioCapture?: IoCapture; sessionId?: string } = {},
): Promise<string> {
  // Minted once per invoke for correlation across the request/response/
  // tool-result records emitted on the non-streaming path (plan-007).
  const turnId = randomUUID();
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
      // Profile-supplied tool-args presets (plan-005, U-ARGS). Empty `{}`
      // when no profile is active.
      profileToolArgs: agentGraph.profileToolArgs,
    },
    recursionLimit: maxSteps * 2,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await agentGraph.graph.invoke(
    { messages: [new HumanMessage(prompt)] },
    invokeOptions,
  );

  const messages = result['messages'] as Array<{ content: unknown }>;

  // Invoke-path capture (plan-007, FR-4). `graph.invoke` emits NO streamEvents,
  // so the request/response are reconstructed from the final ordered message
  // list `result['messages']` (system + memory + human + ai + tool + ai…).
  // Guarded by `captureOpts.ioCapture` so the off path is byte-identical.
  const ioCapture = captureOpts.ioCapture;
  if (ioCapture) {
    const sessionId = captureOpts.sessionId ?? ioCapture.currentSessionId;
    captureInvokePath(ioCapture, messages as unknown as BaseMessage[], {
      sessionId,
      threadId,
      turnId,
    });
  }

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

/**
 * Reconstruct the request/response/tool-result capture records for the
 * non-streaming (`graph.invoke`) path from the final ordered message list
 * (plan-007, FR-4; research Q3 non-streaming block).
 *
 * Emits:
 *   - ONE `captureRequest` for the turn: every message up to and including the
 *     last human message (the request context the model received), with the
 *     bound tool schemas denormalized on (`stepIndex: 0`).
 *   - per AI message carrying non-empty `tool_calls`: a `captureResponse`
 *     (incrementing `stepIndex`), followed by a `captureToolResult` for each of
 *     the immediately-following `tool` messages that answer those calls.
 *   - a final `captureResponse` for the terminal AI text (the model's answer).
 *
 * Reads `_getType()` / `tool_calls` / `tool_call_id` through a permissive view
 * (the same surface `toCaptureMessage` reads); `tool_calls.args` is the parsed
 * object the adapter produced (research pitfall 3).
 */
function captureInvokePath(
  ioCapture: IoCapture,
  messages: BaseMessage[],
  envelope: { sessionId: string; threadId: string; turnId: string },
): void {
  const { sessionId, threadId, turnId } = envelope;
  const typeOf = (m: BaseMessage): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mm = m as any;
    return mm._getType?.() ?? mm.role ?? 'msg';
  };

  // Request context = messages up to AND including the last human message.
  let lastHumanIdx = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (typeOf(messages[i] as BaseMessage) === 'human') {
      lastHumanIdx = i;
      break;
    }
  }
  const requestMessages = (lastHumanIdx >= 0 ? messages.slice(0, lastHumanIdx + 1) : messages).map(
    toCaptureMessage,
  );
  ioCapture.captureRequest({
    sessionId,
    threadId,
    turnId,
    stepIndex: 0,
    ts: new Date().toISOString(),
    messages: requestMessages,
    boundTools: [...ioCapture.boundToolSchemas],
  });

  // Walk the post-request messages, emitting a response per tool-calling AI
  // message plus the paired tool results, and a terminal response for the
  // final AI text.
  const tail = lastHumanIdx >= 0 ? messages.slice(lastHumanIdx + 1) : [];
  let stepIndex = 1;
  for (let i = 0; i < tail.length; i += 1) {
    const m = tail[i] as BaseMessage;
    if (typeOf(m) !== 'ai') continue;
    const ai = m as AIMessage;
    const toolCalls = (ai.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
    }));
    if (toolCalls.length === 0) continue;
    ioCapture.captureResponse({
      sessionId,
      threadId,
      turnId,
      stepIndex,
      ts: new Date().toISOString(),
      finalText: normalizeContent(ai.content),
      toolCalls,
    });
    // Pair the immediately-following `tool` messages with this AI step.
    for (let j = i + 1; j < tail.length && typeOf(tail[j] as BaseMessage) === 'tool'; j += 1) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tm = tail[j] as any;
      ioCapture.captureToolResult({
        sessionId,
        threadId,
        turnId,
        stepIndex,
        ts: new Date().toISOString(),
        toolName: tm.name ?? 'unknown',
        ok: true,
        durationMs: 0,
        result: tm.content,
      });
    }
    stepIndex += 1;
  }

  // Terminal AI text (the model's final answer for the turn).
  const last = messages[messages.length - 1] as BaseMessage | undefined;
  if (last && typeOf(last) === 'ai') {
    const ai = last as AIMessage;
    const terminalToolCalls = (ai.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.name,
      args: tc.args,
    }));
    // Only emit a terminal record when the last AI message is NOT one already
    // captured above as a tool-calling step (avoids a duplicate record when the
    // turn ends on a tool request rather than a text answer).
    if (terminalToolCalls.length === 0) {
      ioCapture.captureResponse({
        sessionId,
        threadId,
        turnId,
        stepIndex,
        ts: new Date().toISOString(),
        finalText: normalizeContent(ai.content),
        toolCalls: [],
      });
    }
  }
}

/* ---------- Streaming path used by the TUI ---------- */

interface StreamOneShotOptions {
  readonly logger?: Logger;
  readonly sessionId?: string;
  readonly abortSignal?: AbortSignal;
  /**
   * Optional parallel LLM-I/O capture channel (plan-007). When provided,
   * `streamOneShot` records the provider-normalized request on
   * `on_chat_model_start`, the response on `on_chat_model_end`, and tool
   * results on `on_tool_end`. ADDITIVE — when undefined, the off path is
   * byte-identical to before (NFR-1): no yielded `AgentStreamEvent`, no
   * `logger.log` call, and no `assembledText` value changes.
   */
  readonly ioCapture?: IoCapture;
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
  const ioCapture = opts.ioCapture;

  let assembledText = '';
  let toolCallsObserved: Array<{ name: string; args: unknown }> = [];
  // Distinguishes the N ReAct model calls within this single turn (FR-4c).
  // Incremented after each `on_chat_model_end` capture; the bound-tool schema
  // snapshot is denormalized onto the first request (stepIndex === 0) only.
  let stepIndex = 0;
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
      // Profile-supplied tool-args presets (plan-005, U-ARGS). Empty `{}`
      // when no profile is active.
      profileToolArgs: agentGraph.profileToolArgs,
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
        case 'on_chat_model_start': {
          // Request capture (plan-007, FR-3). The start-event input is the
          // authoritative provider-normalized snapshot: it already contains
          // the SystemMessage, the full in-thread memory, and the current
          // user content in one literal array (research §"Deviation from scan
          // 2"). Bound tool schemas are denormalized onto the first request
          // of the turn only (research best-practice 4).
          if (ioCapture) {
            ioCapture.captureRequest({
              sessionId,
              threadId,
              turnId,
              stepIndex,
              ts: new Date().toISOString(),
              messages: extractStartMessages(event.data?.input).map(toCaptureMessage),
              boundTools: stepIndex === 0 ? [...ioCapture.boundToolSchemas] : undefined,
            });
          }
          break;
        }
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
          // Response capture (plan-007, FR-4). Read tool_calls EXCLUSIVELY from
          // the aggregated end-event output (`AIMessageChunk.tool_calls`, a
          // parsed-object array) — NEVER from mid-stream chunks, whose
          // `tool_calls` is empty/partial (research pitfalls 2/3). `finalText`
          // reuses the same `normalizeContent` the streaming path uses, falling
          // back to the assembled text when the output is absent.
          if (ioCapture) {
            const out = event.data?.output as AIMessageChunk | undefined;
            const finalText = out ? normalizeContent(out.content) : assembledText;
            const toolCalls = (out?.tool_calls ?? []).map((tc) => ({
              id: tc.id,
              name: tc.name,
              args: tc.args,
            }));
            ioCapture.captureResponse({
              sessionId,
              threadId,
              turnId,
              stepIndex,
              ts: new Date().toISOString(),
              finalText,
              toolCalls,
            });
          }
          stepIndex += 1;
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
          // Tool-result capture (plan-007, FR-4c) so the request→tool-result
          // chain is inspectable. The `stepIndex` here is the value AFTER the
          // model call that requested the tool (incremented in
          // `on_chat_model_end`), correlating the result with its turn.
          if (ioCapture) {
            ioCapture.captureToolResult({
              sessionId,
              threadId,
              turnId,
              stepIndex,
              ts: new Date().toISOString(),
              toolName,
              ok: true,
              durationMs,
            });
          }
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
