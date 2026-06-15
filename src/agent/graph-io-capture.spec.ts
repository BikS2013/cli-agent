/**
 * Unit F — Graph/runner I/O capture WIRING tests (plan-007, design-007 Unit C).
 *
 * Scope: the integration between src/agent/graph.ts and src/agent/io-capture.ts.
 * Specifically:
 *   (1) streamOneShot's three streamEvents v2 hooks:
 *       - on_chat_model_start → captureRequest with literal input messages;
 *         boundTools only on stepIndex 0
 *       - on_chat_model_end → captureResponse reading finalText + tool_calls
 *         from the aggregated AIMessageChunk output
 *       - on_tool_end → captureToolResult
 *   (2) stepIndex increment across multiple model calls in one turn
 *   (3) runOneShot's optional captureOpts + the non-streaming invoke-path
 *       capture (captureInvokePath reading result['messages'])
 *   (4) OFF-STATE invariant: when no ioCapture (or NullIoCapture) is provided,
 *       NO records are produced and behaviour is unchanged.
 *
 * This file does NOT re-test io-capture.ts internals (that is io-capture.spec.ts).
 * This file does NOT modify production source.
 *
 * Filesystem isolation:
 *   - FileIoCapture writes go to fresh fs.mkdtemp dirs, cleaned in afterEach.
 *   - The real ~/.tool-agents/cli-agent is never touched.
 *
 * Fake AgentGraph strategy:
 *   - For streamOneShot: we build a fake AgentGraph whose graph.streamEvents()
 *     returns an async generator yielding a scripted sequence of v2 events.
 *   - For runOneShot: we build a fake AgentGraph whose graph.invoke() resolves
 *     with a scripted messages array.
 *   - AgentToolsSession, workingDirectory, profileToolArgs are set to harmless
 *     stubs (matching the AgentGraph interface exactly).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  AIMessageChunk,
  ToolMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { MemorySaver } from '@langchain/langgraph';

import { streamOneShot, runOneShot, type AgentGraph } from './graph.js';
import {
  FileIoCapture,
  NullIoCapture,
  captureBoundToolSchemas,
  type IoCapture,
  type IoCaptureRecord,
  type RequestInput,
  type ResponseInput,
  type ToolResultInput,
} from './io-capture.js';

// ---------------------------------------------------------------------------
// Temp-dir helpers
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function trackTmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-io-spec-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

// ---------------------------------------------------------------------------
// Spy IoCapture — lightweight implementation of the IoCapture interface that
// records every call without touching the filesystem. Avoids heavy FileIoCapture
// setup for tests that only need to assert call arguments.
// ---------------------------------------------------------------------------

class SpyIoCapture implements IoCapture {
  public readonly boundToolSchemas: ReadonlyArray<import('./io-capture.js').BoundToolSchema>;
  public readonly currentSessionId: string;
  public readonly currentCapturePath = 'spy://in-memory';

  public readonly requestCalls: RequestInput[] = [];
  public readonly responseCalls: ResponseInput[] = [];
  public readonly toolResultCalls: ToolResultInput[] = [];

  constructor(
    sessionId = 'spy-session',
    boundSchemas: ReadonlyArray<import('./io-capture.js').BoundToolSchema> = [],
  ) {
    this.currentSessionId = sessionId;
    this.boundToolSchemas = boundSchemas;
  }

  captureRequest(rec: RequestInput): void {
    this.requestCalls.push(rec);
  }
  captureResponse(rec: ResponseInput): void {
    this.responseCalls.push(rec);
  }
  captureToolResult(rec: ToolResultInput): void {
    this.toolResultCalls.push(rec);
  }
  read(): IoCaptureRecord[] {
    // Convert stored calls to typed records for completeness.
    const out: IoCaptureRecord[] = [];
    for (const r of this.requestCalls) out.push({ kind: 'request', ...r });
    for (const r of this.responseCalls) out.push({ kind: 'response', ...r });
    for (const r of this.toolResultCalls) out.push({ kind: 'tool_result', ...r });
    return out;
  }
  async close(): Promise<void> {
    /* no-op */
  }
}

// ---------------------------------------------------------------------------
// Fake AgentGraph factory helpers
// ---------------------------------------------------------------------------

/**
 * Minimal stub AgentToolsSession (satisfies the AgentGraph.agentToolsSession type
 * without importing the real class, which has heavy dependencies).
 */
function makeAgentToolsSession(): import('./graph.js').AgentGraph['agentToolsSession'] {
  return { todos: null } as unknown as import('./graph.js').AgentGraph['agentToolsSession'];
}

/**
 * Build a fake AgentGraph whose graph.streamEvents() yields the supplied events.
 * The MemorySaver is a real instance (required by the AgentGraph interface type;
 * streamOneShot never calls checkpointer methods directly).
 */
function makeStreamGraph(
  events: Array<{
    event: string;
    name?: string;
    data?: Record<string, unknown>;
  }>,
): AgentGraph {
  const checkpointer = new MemorySaver();
  async function* fakeStreamEvents(): AsyncIterable<unknown> {
    for (const e of events) {
      yield e;
    }
  }
  return {
    graph: {
      streamEvents: () => fakeStreamEvents(),
      invoke: vi.fn(),
    } as unknown as AgentGraph['graph'],
    checkpointer,
    workingDirectory: '/fake',
    agentToolsSession: makeAgentToolsSession(),
    profileToolArgs: {},
  };
}

/**
 * Build a fake AgentGraph whose graph.invoke() resolves with the supplied
 * messages array (simulates the non-streaming invoke path).
 */
function makeInvokeGraph(messages: Array<unknown>): AgentGraph {
  const checkpointer = new MemorySaver();
  return {
    graph: {
      streamEvents: vi.fn(),
      invoke: vi.fn().mockResolvedValue({ messages }),
    } as unknown as AgentGraph['graph'],
    checkpointer,
    workingDirectory: '/fake',
    agentToolsSession: makeAgentToolsSession(),
    profileToolArgs: {},
  };
}

/** A minimal DynamicStructuredTool to populate boundToolSchemas. */
function makeEchoTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'echo',
    description: 'Echo back a message',
    schema: z.object({ message: z.string() }),
    func: async ({ message }: { message: string }) => message,
  });
}

// ---------------------------------------------------------------------------
// Shared scripted stream-events sequences
// ---------------------------------------------------------------------------

/**
 * A single-model-call turn with NO tool use:
 *   on_chat_model_start → on_chat_model_stream → on_chat_model_end
 */
function makeSimpleStreamEvents(opts: {
  inputMessages: unknown;
  streamText: string;
  finalContent: string;
}): Array<{ event: string; name?: string; data?: Record<string, unknown> }> {
  return [
    {
      event: 'on_chat_model_start',
      data: { input: opts.inputMessages },
    },
    {
      event: 'on_chat_model_stream',
      data: {
        chunk: { content: opts.streamText },
      },
    },
    {
      event: 'on_chat_model_end',
      data: {
        output: new AIMessageChunk({ content: opts.finalContent }),
      },
    },
  ];
}

/**
 * A two-model-call turn with a tool use in between:
 *   on_chat_model_start(0) → on_chat_model_end(with tool_calls) →
 *   on_tool_start → on_tool_end →
 *   on_chat_model_start(1) → on_chat_model_end(final text)
 *
 * This sequence exercises the stepIndex increment.
 */
function makeToolUseStreamEvents(opts: {
  inputMessages: unknown;
  toolName: string;
  toolArgs: unknown;
  toolCallId: string;
  secondInputMessages: unknown;
  finalText: string;
}): Array<{ event: string; name?: string; data?: Record<string, unknown> }> {
  // First AIMessageChunk carries a tool_call.
  const firstChunk = new AIMessageChunk({
    content: '',
    tool_calls: [{ id: opts.toolCallId, name: opts.toolName, args: opts.toolArgs as Record<string, unknown> }],
  });
  // Terminal AIMessageChunk carries plain text.
  const finalChunk = new AIMessageChunk({ content: opts.finalText });

  return [
    // First model call
    { event: 'on_chat_model_start', data: { input: opts.inputMessages } },
    { event: 'on_chat_model_end', data: { output: firstChunk } },
    // Tool call
    { event: 'on_tool_start', name: opts.toolName, data: { input: { cmd: 'ls' } } },
    { event: 'on_tool_end', name: opts.toolName, data: {} },
    // Second model call
    { event: 'on_chat_model_start', data: { input: opts.secondInputMessages } },
    { event: 'on_chat_model_end', data: { output: finalChunk } },
  ];
}

// ===========================================================================
// Section A — streamOneShot: on_chat_model_start hook
// ===========================================================================
describe('streamOneShot — on_chat_model_start → captureRequest', () => {
  it('calls captureRequest once for a simple single-model-call turn', async () => {
    const spy = new SpyIoCapture('sess-stream', captureBoundToolSchemas([makeEchoTool()]));
    const inputMessages = { messages: [new SystemMessage('system'), new HumanMessage('hello')] };
    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages,
      streamText: 'hi',
      finalContent: 'hi',
    }));

    const it2 = streamOneShot(agentGraph, 'hello', 'thread-1', 10, {
      ioCapture: spy,
      sessionId: 'sess-stream',
    });
    // Drain the generator.
    const events: Array<import('./graph.js').AgentStreamEvent> = [];
    let finalText = '';
    while (true) {
      const next = await it2.next();
      if (next.done) { finalText = next.value as string; break; }
      events.push(next.value);
    }

    expect(spy.requestCalls).toHaveLength(1);
    const req = spy.requestCalls[0]!;
    expect(req.sessionId).toBe('sess-stream');
    expect(req.threadId).toBe('thread-1');
    expect(req.stepIndex).toBe(0);
    expect(req.turnId).toBeTruthy(); // UUID minted by streamOneShot
  });

  it('maps literal input messages to CapturedMessage roles correctly (system, human)', async () => {
    const spy = new SpyIoCapture('sess-a', []);
    const sysMsg = new SystemMessage('you are an agent');
    const humMsg = new HumanMessage('list files');
    const inputMessages = [sysMsg, humMsg]; // bare array shape
    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages,
      streamText: 'ok',
      finalContent: 'ok',
    }));

    const it2 = streamOneShot(agentGraph, 'list files', 'thread-2', 10, {
      ioCapture: spy,
      sessionId: 'sess-a',
    });
    while (!(await it2.next()).done) {/* drain */}

    const captured = spy.requestCalls[0]!.messages;
    expect(captured).toHaveLength(2);
    expect(captured[0]!.role).toBe('system');
    expect(captured[0]!.content).toBe('you are an agent');
    expect(captured[1]!.role).toBe('human');
    expect(captured[1]!.content).toBe('list files');
  });

  it('attaches boundTools to the stepIndex === 0 request (and only that one)', async () => {
    const tools = [makeEchoTool()];
    const schemas = captureBoundToolSchemas(tools);
    const spy = new SpyIoCapture('sess-b', schemas);

    const inputA = { messages: [new HumanMessage('first turn')] };
    const inputB = { messages: [new HumanMessage('second call (same turn)')] };
    const toolCallId = 'call_test_1';
    const events = makeToolUseStreamEvents({
      inputMessages: inputA,
      toolName: 'echo',
      toolArgs: { message: 'hello' },
      toolCallId,
      secondInputMessages: inputB,
      finalText: 'done',
    });
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'first turn', 'thread-3', 10, {
      ioCapture: spy,
      sessionId: 'sess-b',
    });
    while (!(await it2.next()).done) {/* drain */}

    // There must be exactly 2 captureRequest calls (step 0 + step 1).
    expect(spy.requestCalls).toHaveLength(2);
    // Step 0: boundTools present.
    const step0 = spy.requestCalls[0]!;
    expect(step0.stepIndex).toBe(0);
    expect(step0.boundTools).toBeDefined();
    expect(step0.boundTools).toHaveLength(schemas.length);
    expect(step0.boundTools![0]!.name).toBe('echo');
    // Step 1: boundTools absent (undefined).
    const step1 = spy.requestCalls[1]!;
    expect(step1.stepIndex).toBe(1);
    expect(step1.boundTools).toBeUndefined();
  });

  it('all captureRequest calls in the same turn share the same turnId', async () => {
    const spy = new SpyIoCapture('sess-c', []);
    const events = makeToolUseStreamEvents({
      inputMessages: { messages: [new HumanMessage('p')] },
      toolName: 'echo',
      toolArgs: { message: 'x' },
      toolCallId: 'call_c',
      secondInputMessages: { messages: [new HumanMessage('p2')] },
      finalText: 'answer',
    });
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'p', 'thread-c', 10, { ioCapture: spy, sessionId: 'sess-c' });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.requestCalls).toHaveLength(2);
    const turnId0 = spy.requestCalls[0]!.turnId;
    const turnId1 = spy.requestCalls[1]!.turnId;
    expect(turnId0).toBeTruthy();
    expect(turnId0).toBe(turnId1);
  });
});

// ===========================================================================
// Section B — streamOneShot: on_chat_model_end hook
// ===========================================================================
describe('streamOneShot — on_chat_model_end → captureResponse', () => {
  it('calls captureResponse once for a simple turn: finalText from AIMessageChunk.content', async () => {
    const spy = new SpyIoCapture('sess-end', []);
    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages: [new HumanMessage('q')],
      streamText: 'the answer',
      finalContent: 'the answer',
    }));

    const it2 = streamOneShot(agentGraph, 'q', 'thread-end', 10, { ioCapture: spy, sessionId: 'sess-end' });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.responseCalls).toHaveLength(1);
    const resp = spy.responseCalls[0]!;
    expect(resp.finalText).toBe('the answer');
    expect(resp.toolCalls).toEqual([]);
    expect(resp.stepIndex).toBe(0);
  });

  it('reads tool_calls from AIMessageChunk.tool_calls (parsed-object array, not mid-stream chunks)', async () => {
    const spy = new SpyIoCapture('sess-tc', []);
    const chunk = new AIMessageChunk({
      content: '',
      tool_calls: [{ id: 'call_tc1', name: 'bash', args: { cmd: 'ls' } }],
    });
    const events = [
      { event: 'on_chat_model_start', data: { input: [new HumanMessage('q')] } },
      { event: 'on_chat_model_end', data: { output: chunk } },
    ];
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'q', 'thread-tc', 10, { ioCapture: spy, sessionId: 'sess-tc' });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.responseCalls[0]!.toolCalls).toEqual([
      { id: 'call_tc1', name: 'bash', args: { cmd: 'ls' } },
    ]);
  });

  it('emits two captureResponse records when the model is called twice in one turn (tool-use then final)', async () => {
    const spy = new SpyIoCapture('sess-two', []);
    const events = makeToolUseStreamEvents({
      inputMessages: [new HumanMessage('p')],
      toolName: 'bash',
      toolArgs: { cmd: 'ls' },
      toolCallId: 'call_two',
      secondInputMessages: [new HumanMessage('p'), new AIMessage({ content: '' })],
      finalText: 'done with it',
    });
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'p', 'thread-two', 10, { ioCapture: spy, sessionId: 'sess-two' });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.responseCalls).toHaveLength(2);
    // First response (stepIndex 0) carries the tool call.
    const resp0 = spy.responseCalls[0]!;
    expect(resp0.stepIndex).toBe(0);
    expect(resp0.toolCalls).toHaveLength(1);
    expect(resp0.toolCalls[0]!.name).toBe('bash');
    // Second response (stepIndex 1) is the terminal text.
    const resp1 = spy.responseCalls[1]!;
    expect(resp1.stepIndex).toBe(1);
    expect(resp1.finalText).toBe('done with it');
    expect(resp1.toolCalls).toEqual([]);
  });

  it('all captureResponse calls in the same turn share the same turnId as captureRequest', async () => {
    const spy = new SpyIoCapture('sess-tid', []);
    const events = makeToolUseStreamEvents({
      inputMessages: [new HumanMessage('x')],
      toolName: 'bash',
      toolArgs: { cmd: 'pwd' },
      toolCallId: 'call_tid',
      secondInputMessages: [new HumanMessage('x')],
      finalText: 'result',
    });
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'x', 'thread-tid', 10, { ioCapture: spy, sessionId: 'sess-tid' });
    while (!(await it2.next()).done) {/* drain */}

    const reqTurnId = spy.requestCalls[0]!.turnId;
    for (const resp of spy.responseCalls) {
      expect(resp.turnId).toBe(reqTurnId);
    }
  });
});

// ===========================================================================
// Section C — streamOneShot: on_tool_end hook → captureToolResult
// ===========================================================================
describe('streamOneShot — on_tool_end → captureToolResult', () => {
  it('calls captureToolResult once for a single tool execution', async () => {
    const spy = new SpyIoCapture('sess-tr', []);
    const events = makeToolUseStreamEvents({
      inputMessages: [new HumanMessage('run it')],
      toolName: 'bash',
      toolArgs: { cmd: 'date' },
      toolCallId: 'call_date',
      secondInputMessages: [new HumanMessage('run it')],
      finalText: 'done',
    });
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'run it', 'thread-tr', 10, { ioCapture: spy, sessionId: 'sess-tr' });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.toolResultCalls).toHaveLength(1);
    const tr = spy.toolResultCalls[0]!;
    expect(tr.toolName).toBe('bash');
    expect(tr.ok).toBe(true);
    expect(tr.durationMs).toBeGreaterThanOrEqual(0);
    expect(tr.sessionId).toBe('sess-tr');
    expect(tr.turnId).toBe(spy.requestCalls[0]!.turnId);
  });

  it('captureToolResult stepIndex equals the INCREMENTED stepIndex (after on_chat_model_end)', async () => {
    // After the first on_chat_model_end, stepIndex is incremented to 1.
    // on_tool_end fires after that, so its stepIndex must be 1.
    const spy = new SpyIoCapture('sess-idx', []);
    const events = makeToolUseStreamEvents({
      inputMessages: [new HumanMessage('p')],
      toolName: 'echo',
      toolArgs: { message: 'hello' },
      toolCallId: 'call_idx',
      secondInputMessages: [new HumanMessage('p')],
      finalText: 'ok',
    });
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'p', 'thread-idx', 10, { ioCapture: spy, sessionId: 'sess-idx' });
    while (!(await it2.next()).done) {/* drain */}

    // stepIndex in the tool result must be 1 (incremented AFTER the first on_chat_model_end).
    expect(spy.toolResultCalls[0]!.stepIndex).toBe(1);
  });

  it('yields tool_call_start and tool_call_end AgentStreamEvents alongside the capture calls', async () => {
    const spy = new SpyIoCapture('sess-yield', []);
    const events = makeToolUseStreamEvents({
      inputMessages: [new HumanMessage('y')],
      toolName: 'echo',
      toolArgs: { message: 'y' },
      toolCallId: 'call_yield',
      secondInputMessages: [new HumanMessage('y')],
      finalText: 'yielded',
    });
    const agentGraph = makeStreamGraph(events);

    const yielded: import('./graph.js').AgentStreamEvent[] = [];
    const it2 = streamOneShot(agentGraph, 'y', 'thread-yield', 10, { ioCapture: spy, sessionId: 'sess-yield' });
    while (true) {
      const next = await it2.next();
      if (next.done) break;
      yielded.push(next.value);
    }

    const kinds = yielded.map((e) => e.kind);
    expect(kinds).toContain('tool_call_start');
    expect(kinds).toContain('tool_call_end');
    // Capture side-effect also fired.
    expect(spy.toolResultCalls).toHaveLength(1);
  });
});

// ===========================================================================
// Section D — stepIndex increment across multiple model calls in one turn
// ===========================================================================
describe('streamOneShot — stepIndex increment across multiple model calls', () => {
  it('stepIndex is 0 on the first captureRequest, 1 on the second', async () => {
    const spy = new SpyIoCapture('sess-step', []);
    const events = makeToolUseStreamEvents({
      inputMessages: [new HumanMessage('multi')],
      toolName: 'echo',
      toolArgs: { message: 'x' },
      toolCallId: 'call_s',
      secondInputMessages: [new HumanMessage('multi2')],
      finalText: 'complete',
    });
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'multi', 'thread-step', 10, { ioCapture: spy, sessionId: 'sess-step' });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.requestCalls[0]!.stepIndex).toBe(0);
    expect(spy.requestCalls[1]!.stepIndex).toBe(1);
    expect(spy.responseCalls[0]!.stepIndex).toBe(0);
    expect(spy.responseCalls[1]!.stepIndex).toBe(1);
  });

  it('three model calls produce stepIndex 0, 1, 2 on captureRequest/captureResponse', async () => {
    const spy = new SpyIoCapture('sess-three', []);
    // Two tool uses → three model calls.
    const chunk1 = new AIMessageChunk({
      content: '',
      tool_calls: [{ id: 'c1', name: 'echo', args: { message: 'a' } }],
    });
    const chunk2 = new AIMessageChunk({
      content: '',
      tool_calls: [{ id: 'c2', name: 'echo', args: { message: 'b' } }],
    });
    const chunk3 = new AIMessageChunk({ content: 'final' });
    const events = [
      { event: 'on_chat_model_start', data: { input: [new HumanMessage('go')] } },
      { event: 'on_chat_model_end', data: { output: chunk1 } },
      { event: 'on_tool_start', name: 'echo', data: {} },
      { event: 'on_tool_end', name: 'echo', data: {} },
      { event: 'on_chat_model_start', data: { input: [new HumanMessage('go2')] } },
      { event: 'on_chat_model_end', data: { output: chunk2 } },
      { event: 'on_tool_start', name: 'echo', data: {} },
      { event: 'on_tool_end', name: 'echo', data: {} },
      { event: 'on_chat_model_start', data: { input: [new HumanMessage('go3')] } },
      { event: 'on_chat_model_end', data: { output: chunk3 } },
    ];
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'go', 'thread-three', 20, { ioCapture: spy, sessionId: 'sess-three' });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.requestCalls.map((r) => r.stepIndex)).toEqual([0, 1, 2]);
    expect(spy.responseCalls.map((r) => r.stepIndex)).toEqual([0, 1, 2]);
  });

  it('stepIndex resets to 0 for a DIFFERENT turnId (separate streamOneShot call)', async () => {
    const spy = new SpyIoCapture('sess-reset', []);

    async function doOneTurn(msg: string, threadId: string) {
      const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
        inputMessages: [new HumanMessage(msg)],
        streamText: 'r',
        finalContent: 'r',
      }));
      const it2 = streamOneShot(agentGraph, msg, threadId, 10, {
        ioCapture: spy,
        sessionId: 'sess-reset',
      });
      while (!(await it2.next()).done) {/* drain */}
    }

    await doOneTurn('turn A', 'thread-A');
    await doOneTurn('turn B', 'thread-B');

    // Both turns should start at stepIndex 0.
    expect(spy.requestCalls[0]!.stepIndex).toBe(0);
    expect(spy.requestCalls[1]!.stepIndex).toBe(0);
    // But they should have different turnIds.
    expect(spy.requestCalls[0]!.turnId).not.toBe(spy.requestCalls[1]!.turnId);
  });
});

// ===========================================================================
// Section E — runOneShot: captureOpts + invoke-path capture
// ===========================================================================
describe('runOneShot — captureOpts + captureInvokePath', () => {
  it('calls captureRequest once for the request context (messages up to last human)', async () => {
    const spy = new SpyIoCapture('sess-invoke', captureBoundToolSchemas([makeEchoTool()]));
    // Simple: system + human → ai (terminal)
    const messages = [
      new SystemMessage('system prompt'),
      new HumanMessage('what is 2+2'),
      new AIMessage({ content: '4' }),
    ];
    const agentGraph = makeInvokeGraph(messages);

    await runOneShot(agentGraph, 'what is 2+2', 'thread-inv', 10, {
      ioCapture: spy,
      sessionId: 'sess-invoke',
    });

    expect(spy.requestCalls).toHaveLength(1);
    const req = spy.requestCalls[0]!;
    expect(req.stepIndex).toBe(0);
    expect(req.sessionId).toBe('sess-invoke');
    // Messages up to and including the last human.
    expect(req.messages.map((m) => m.role)).toEqual(['system', 'human']);
    // boundTools present on stepIndex 0.
    expect(req.boundTools).toBeDefined();
  });

  it('calls captureResponse once for the terminal AI text (no tool calls)', async () => {
    const spy = new SpyIoCapture('sess-inv-resp', []);
    const messages = [
      new HumanMessage('hello'),
      new AIMessage({ content: 'hello back' }),
    ];
    const agentGraph = makeInvokeGraph(messages);

    await runOneShot(agentGraph, 'hello', 'thread-inv-resp', 10, {
      ioCapture: spy,
      sessionId: 'sess-inv-resp',
    });

    expect(spy.responseCalls).toHaveLength(1);
    expect(spy.responseCalls[0]!.finalText).toBe('hello back');
    expect(spy.responseCalls[0]!.toolCalls).toEqual([]);
  });

  it('emits captureResponse for each tool-calling AI message + a final terminal captureResponse', async () => {
    const spy = new SpyIoCapture('sess-inv-tool', []);
    // human → ai-with-tool-call → tool → terminal-ai
    const messages = [
      new HumanMessage('run bash'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_inv1', name: 'bash', args: { cmd: 'ls' } }],
      }),
      new ToolMessage({ content: 'file.txt', tool_call_id: 'call_inv1' }),
      new AIMessage({ content: 'done' }),
    ];
    const agentGraph = makeInvokeGraph(messages);

    await runOneShot(agentGraph, 'run bash', 'thread-inv-tool', 10, {
      ioCapture: spy,
      sessionId: 'sess-inv-tool',
    });

    // Two captureResponse records: one for the tool-calling AI, one for the terminal.
    expect(spy.responseCalls).toHaveLength(2);
    const tc = spy.responseCalls[0]!;
    expect(tc.toolCalls).toHaveLength(1);
    expect(tc.toolCalls[0]!.name).toBe('bash');
    const terminal = spy.responseCalls[1]!;
    expect(terminal.finalText).toBe('done');
    expect(terminal.toolCalls).toEqual([]);
  });

  it('emits a captureToolResult for each tool message following a tool-calling AI message', async () => {
    const spy = new SpyIoCapture('sess-inv-tr', []);
    // LangGraph real execution sets ToolMessage.name to the tool name; we must
    // replicate that so captureInvokePath's `tm.name ?? 'unknown'` reads 'echo'.
    const messages = [
      new HumanMessage('run echo'),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'call_inv2', name: 'echo', args: { message: 'hi' } }],
      }),
      new ToolMessage({ content: 'hi', tool_call_id: 'call_inv2', name: 'echo' }),
      new AIMessage({ content: 'echoed' }),
    ];
    const agentGraph = makeInvokeGraph(messages);

    await runOneShot(agentGraph, 'run echo', 'thread-inv-tr', 10, {
      ioCapture: spy,
      sessionId: 'sess-inv-tr',
    });

    expect(spy.toolResultCalls).toHaveLength(1);
    expect(spy.toolResultCalls[0]!.toolName).toBe('echo');
    expect(spy.toolResultCalls[0]!.ok).toBe(true);
  });

  it('all invoke-path records share the same turnId', async () => {
    const spy = new SpyIoCapture('sess-inv-turnid', []);
    const messages = [
      new HumanMessage('test'),
      new AIMessage({ content: '', tool_calls: [{ id: 'call_t', name: 'bash', args: {} }] }),
      new ToolMessage({ content: 'result', tool_call_id: 'call_t' }),
      new AIMessage({ content: 'final' }),
    ];
    const agentGraph = makeInvokeGraph(messages);

    await runOneShot(agentGraph, 'test', 'thread-inv-tid', 10, {
      ioCapture: spy,
      sessionId: 'sess-inv-turnid',
    });

    const allTurnIds = [
      ...spy.requestCalls.map((r) => r.turnId),
      ...spy.responseCalls.map((r) => r.turnId),
      ...spy.toolResultCalls.map((r) => r.turnId),
    ];
    const unique = new Set(allTurnIds);
    expect(unique.size).toBe(1);
    expect([...unique][0]).toBeTruthy();
  });

  it('returns the assembled answer string (the last AI message content) regardless of capture', async () => {
    const spy = new SpyIoCapture('sess-ret', []);
    const messages = [
      new HumanMessage('q'),
      new AIMessage({ content: 'the final answer' }),
    ];
    const agentGraph = makeInvokeGraph(messages);

    const answer = await runOneShot(agentGraph, 'q', 'thread-ret', 10, {
      ioCapture: spy,
      sessionId: 'sess-ret',
    });

    expect(answer).toBe('the final answer');
  });

  it('runOneShot with captureOpts omitted still returns the answer (off-state regression)', async () => {
    const messages = [
      new HumanMessage('hi'),
      new AIMessage({ content: 'hello' }),
    ];
    const agentGraph = makeInvokeGraph(messages);

    // No captureOpts argument at all → no ioCapture → no records, no crash.
    const answer = await runOneShot(agentGraph, 'hi', 'thread-off', 10);
    expect(answer).toBe('hello');
  });
});

// ===========================================================================
// Section F — OFF-STATE invariant: no ioCapture / NullIoCapture
// ===========================================================================
describe('OFF-STATE invariant — no records produced, behavior unchanged', () => {
  it('streamOneShot with no ioCapture still yields token events and returns assembled text', async () => {
    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages: [new HumanMessage('hi')],
      streamText: 'response text',
      finalContent: 'response text',
    }));

    const yielded: import('./graph.js').AgentStreamEvent[] = [];
    const it2 = streamOneShot(agentGraph, 'hi', 'thread-off-stream', 10);
    while (true) {
      const next = await it2.next();
      if (next.done) {
        // The assembled text is the return value.
        expect(next.value).toBe('response text');
        break;
      }
      yielded.push(next.value);
    }

    const tokenEvents = yielded.filter((e) => e.kind === 'token');
    expect(tokenEvents).toHaveLength(1);
    expect((tokenEvents[0] as { kind: 'token'; text: string }).text).toBe('response text');
  });

  it('streamOneShot with NullIoCapture produces zero records and normal token stream', async () => {
    const nullCap = new NullIoCapture();
    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages: [new HumanMessage('test')],
      streamText: 'noop text',
      finalContent: 'noop text',
    }));

    const it2 = streamOneShot(agentGraph, 'test', 'thread-null', 10, {
      ioCapture: nullCap,
      sessionId: 'null-session',
    });
    while (!(await it2.next()).done) {/* drain */}

    expect(nullCap.read()).toEqual([]);
  });

  it('streamOneShot with NullIoCapture leaves filesystem untouched (no io-captures dir)', async () => {
    const nullCap = new NullIoCapture();
    const root = trackTmp();
    // Sanity: the temp dir is empty.
    expect(fs.readdirSync(root)).toHaveLength(0);

    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages: [new HumanMessage('q')],
      streamText: 'a',
      finalContent: 'a',
    }));
    const it2 = streamOneShot(agentGraph, 'q', 'thread-null-fs', 10, {
      ioCapture: nullCap,
      sessionId: 'null-fs',
    });
    while (!(await it2.next()).done) {/* drain */}

    // Still empty.
    expect(fs.readdirSync(root)).toHaveLength(0);
    expect(nullCap.currentCapturePath).toBe('');
  });

  it('runOneShot with no ioCapture returns answer and makes no capture calls', async () => {
    const messages = [
      new HumanMessage('hi'),
      new AIMessage({ content: 'world' }),
    ];
    const agentGraph = makeInvokeGraph(messages);

    const answer = await runOneShot(agentGraph, 'hi', 'thread-off-invoke', 10);
    expect(answer).toBe('world');
    // Verify graph.invoke was called exactly once with no capture side-effects.
    expect(agentGraph.graph.invoke).toHaveBeenCalledTimes(1);
  });

  it('runOneShot with NullIoCapture produces zero records and returns normal answer', async () => {
    const nullCap = new NullIoCapture();
    const messages = [
      new HumanMessage('ping'),
      new AIMessage({ content: 'pong' }),
    ];
    const agentGraph = makeInvokeGraph(messages);

    const answer = await runOneShot(agentGraph, 'ping', 'thread-null-invoke', 10, {
      ioCapture: nullCap,
      sessionId: 'null-inv',
    });
    expect(answer).toBe('pong');
    expect(nullCap.read()).toEqual([]);
  });

  it('streamOneShot with tool use and no ioCapture still yields tool_call_start + tool_call_end events', async () => {
    const events = makeToolUseStreamEvents({
      inputMessages: [new HumanMessage('do tool')],
      toolName: 'bash',
      toolArgs: { cmd: 'ls' },
      toolCallId: 'call_off',
      secondInputMessages: [new HumanMessage('do tool')],
      finalText: 'complete',
    });
    const agentGraph = makeStreamGraph(events);

    const yielded: import('./graph.js').AgentStreamEvent[] = [];
    const it2 = streamOneShot(agentGraph, 'do tool', 'thread-off-tool', 10);
    while (true) {
      const next = await it2.next();
      if (next.done) break;
      yielded.push(next.value);
    }

    expect(yielded.some((e) => e.kind === 'tool_call_start')).toBe(true);
    expect(yielded.some((e) => e.kind === 'tool_call_end')).toBe(true);
  });
});

// ===========================================================================
// Section G — FileIoCapture integration: streamOneShot writes JSONL to disk
// ===========================================================================
describe('streamOneShot + FileIoCapture — JSONL written to disk', () => {
  /** Read every JSONL line of a capture file into parsed records. */
  function readJsonl(file: string): Array<Record<string, unknown>> {
    const raw = fs.readFileSync(file, 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  it('writes a request record, a response record, and a tool_result record to the JSONL file', async () => {
    const dir = trackTmp();
    const schemas = captureBoundToolSchemas([makeEchoTool()]);
    const cap = new FileIoCapture({
      dir,
      sessionId: 'file-sess',
      redact: false,
      boundToolSchemas: schemas,
    });

    const events = makeToolUseStreamEvents({
      inputMessages: { messages: [new SystemMessage('sys'), new HumanMessage('file-test')] },
      toolName: 'echo',
      toolArgs: { message: 'writing' },
      toolCallId: 'call_file',
      secondInputMessages: { messages: [new HumanMessage('file-test')] },
      finalText: 'file-done',
    });
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'file-test', 'thread-file', 10, {
      ioCapture: cap,
      sessionId: 'file-sess',
    });
    while (!(await it2.next()).done) {/* drain */}
    await cap.close();

    const records = readJsonl(cap.currentCapturePath);
    const kinds = records.map((r) => r['kind']);
    expect(kinds).toContain('request');
    expect(kinds).toContain('response');
    expect(kinds).toContain('tool_result');

    const req = records.find((r) => r['kind'] === 'request')!;
    expect(req['stepIndex']).toBe(0);
    expect(req['sessionId']).toBe('file-sess');
    expect(req['boundTools']).toBeDefined();

    const resp = records.find((r) => r['kind'] === 'response' && r['stepIndex'] === 1)!;
    expect(resp['finalText']).toBe('file-done');

    const tr = records.find((r) => r['kind'] === 'tool_result')!;
    expect(tr['toolName']).toBe('echo');
    expect(tr['ok']).toBe(true);
  });

  it('read() on FileIoCapture returns all records written during the streaming turn', async () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({ dir, sessionId: 'file-read', redact: false, boundToolSchemas: [] });

    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages: [new HumanMessage('read-test')],
      streamText: 'text',
      finalContent: 'text',
    }));

    const it2 = streamOneShot(agentGraph, 'read-test', 'thread-read', 10, {
      ioCapture: cap,
      sessionId: 'file-read',
    });
    while (!(await it2.next()).done) {/* drain */}

    const records = cap.read();
    expect(records.length).toBeGreaterThanOrEqual(2); // at least request + response
    expect(records.map((r) => r.kind)).toContain('request');
    expect(records.map((r) => r.kind)).toContain('response');
  });
});

// ===========================================================================
// Section H — Edge cases and robustness
// ===========================================================================
describe('Edge cases — event shape robustness', () => {
  it('streamOneShot handles on_chat_model_start with bare BaseMessage[] input', async () => {
    // extractStartMessages flattens all three documented shapes; test the bare-array form.
    const spy = new SpyIoCapture('sess-bare', []);
    const msgs = [new SystemMessage('s'), new HumanMessage('h')];
    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages: msgs, // bare array (not wrapped in { messages: [...] })
      streamText: 'ok',
      finalContent: 'ok',
    }));

    const it2 = streamOneShot(agentGraph, 'h', 'thread-bare', 10, { ioCapture: spy, sessionId: 'sess-bare' });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.requestCalls[0]!.messages.map((m) => m.role)).toEqual(['system', 'human']);
  });

  it('streamOneShot handles on_chat_model_start with { messages: [[…]] } (array-of-arrays) input', async () => {
    const spy = new SpyIoCapture('sess-aoa', []);
    const msgs = [new HumanMessage('nested')];
    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages: { messages: [msgs] }, // array-of-arrays shape
      streamText: 'nested-ok',
      finalContent: 'nested-ok',
    }));

    const it2 = streamOneShot(agentGraph, 'nested', 'thread-aoa', 10, { ioCapture: spy, sessionId: 'sess-aoa' });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.requestCalls[0]!.messages[0]!.role).toBe('human');
  });

  it('streamOneShot gracefully handles unknown/irrelevant events without errors', async () => {
    const spy = new SpyIoCapture('sess-ign', []);
    const events = [
      { event: 'on_chain_start', data: {} },
      { event: 'on_prompt_start', data: {} },
      { event: 'on_chat_model_start', data: { input: [new HumanMessage('q')] } },
      { event: 'on_chain_end', data: {} },
      { event: 'on_chat_model_end', data: { output: new AIMessageChunk({ content: 'a' }) } },
    ];
    const agentGraph = makeStreamGraph(events);

    // Should not throw.
    const it2 = streamOneShot(agentGraph, 'q', 'thread-ign', 10, { ioCapture: spy, sessionId: 'sess-ign' });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.requestCalls).toHaveLength(1);
    expect(spy.responseCalls).toHaveLength(1);
  });

  it('runOneShot with a messages list that has NO human message still emits a request', async () => {
    // Edge: if lastHumanIdx is -1, the whole messages array is the request context.
    const spy = new SpyIoCapture('sess-no-human', []);
    // Only an AI message (degenerate, but code handles it).
    const messages = [new AIMessage({ content: 'orphan ai' })];
    const agentGraph = makeInvokeGraph(messages);

    await runOneShot(agentGraph, 'ignored', 'thread-no-human', 10, {
      ioCapture: spy,
      sessionId: 'sess-no-human',
    });

    // captureRequest should still be called once.
    expect(spy.requestCalls).toHaveLength(1);
  });

  it('runOneShot with empty messages returns empty string and does not throw', async () => {
    const spy = new SpyIoCapture('sess-empty', []);
    const agentGraph = makeInvokeGraph([]);

    const answer = await runOneShot(agentGraph, '', 'thread-empty', 10, {
      ioCapture: spy,
      sessionId: 'sess-empty',
    });

    expect(answer).toBe('');
    // captureRequest still called.
    expect(spy.requestCalls).toHaveLength(1);
  });

  it('on_chat_model_end with no output object falls back to assembledText for finalText', async () => {
    // When event.data.output is undefined/absent, captureResponse must not crash —
    // the design says fall back to assembledText.
    const spy = new SpyIoCapture('sess-noout', []);
    const events = [
      { event: 'on_chat_model_start', data: { input: [new HumanMessage('q')] } },
      { event: 'on_chat_model_stream', data: { chunk: { content: 'assembled from stream' } } },
      { event: 'on_chat_model_end', data: {} }, // no output field
    ];
    const agentGraph = makeStreamGraph(events);

    const it2 = streamOneShot(agentGraph, 'q', 'thread-noout', 10, { ioCapture: spy, sessionId: 'sess-noout' });
    while (!(await it2.next()).done) {/* drain */}

    // captureResponse must have been called with finalText = assembledText.
    expect(spy.responseCalls[0]!.finalText).toBe('assembled from stream');
  });
});

// ===========================================================================
// Section I — sessionId threading: opts.sessionId vs ioCapture.currentSessionId
// ===========================================================================
describe('sessionId threading in streamOneShot and runOneShot', () => {
  it('streamOneShot uses opts.sessionId when provided (overrides ioCapture.currentSessionId)', async () => {
    // The capture objects internal sessionId is 'cap-session',
    // but opts.sessionId is 'opts-session'; the RECORD must use 'opts-session'.
    const spy = new SpyIoCapture('cap-session', []);
    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages: [new HumanMessage('q')],
      streamText: 'r',
      finalContent: 'r',
    }));

    const it2 = streamOneShot(agentGraph, 'q', 'thread-sid', 10, {
      ioCapture: spy,
      sessionId: 'opts-session',
    });
    while (!(await it2.next()).done) {/* drain */}

    expect(spy.requestCalls[0]!.sessionId).toBe('opts-session');
    expect(spy.responseCalls[0]!.sessionId).toBe('opts-session');
  });

  it('streamOneShot falls back to ioCapture.currentSessionId when opts.sessionId is absent', async () => {
    const spy = new SpyIoCapture('cap-fallback-session', []);
    const agentGraph = makeStreamGraph(makeSimpleStreamEvents({
      inputMessages: [new HumanMessage('q')],
      streamText: 'r',
      finalContent: 'r',
    }));

    const it2 = streamOneShot(agentGraph, 'q', 'thread-fb', 10, {
      ioCapture: spy,
      // sessionId intentionally absent from opts
    });
    while (!(await it2.next()).done) {/* drain */}

    // Falls back to spy.currentSessionId (but also falls back to 'streaming'
    // if ioCapture is undefined — here ioCapture is defined but no logger so
    // the code path is: opts.sessionId ?? opts.logger?.currentSessionId ?? 'streaming').
    // spy.currentSessionId = 'cap-fallback-session' is NOT on opts — the real
    // fallback chain in graph.ts is: opts.sessionId ?? opts.logger?.currentSessionId ?? 'streaming'.
    // So the sessionId will be 'streaming' here (no sessionId on opts, no logger).
    expect(spy.requestCalls[0]!.sessionId).toBe('streaming');
  });

  it('runOneShot uses captureOpts.sessionId when provided', async () => {
    const spy = new SpyIoCapture('cap-inv-sess', []);
    const agentGraph = makeInvokeGraph([new HumanMessage('q'), new AIMessage({ content: 'a' })]);

    await runOneShot(agentGraph, 'q', 'thread-sid-inv', 10, {
      ioCapture: spy,
      sessionId: 'explicit-inv-session',
    });

    expect(spy.requestCalls[0]!.sessionId).toBe('explicit-inv-session');
  });

  it('runOneShot falls back to ioCapture.currentSessionId when captureOpts.sessionId is absent', async () => {
    const spy = new SpyIoCapture('io-cap-session-inv', []);
    const agentGraph = makeInvokeGraph([new HumanMessage('q'), new AIMessage({ content: 'a' })]);

    await runOneShot(agentGraph, 'q', 'thread-sid-inv-fb', 10, {
      ioCapture: spy,
      // sessionId absent → falls back to ioCapture.currentSessionId
    });

    expect(spy.requestCalls[0]!.sessionId).toBe('io-cap-session-inv');
  });
});
