/**
 * Tests for the /inspect slash command (src/tui/slash/inspect.ts).
 *
 * Strategy: construct a fake SlashContext with a stub IoCapture and capture
 * all output in an array. Assert on that array. Never touch production source.
 *
 * IoCapture stub covers two modes:
 *   activeStub  — currentCapturePath !== '' (FileIoCapture-like)
 *   inactiveStub — currentCapturePath === '' (NullIoCapture-like)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { findCommand, type SlashContext } from './registry.js';
// Side-effect import: /inspect registers itself once at module load.
// We deliberately do NOT _testReset() — doing so would wipe the registration
// without a clean way to re-trigger ESM-cached registration.
import './inspect.js';
import type { IoCapture, IoCaptureRecord } from '../../agent/io-capture.js';

// ---------------------------------------------------------------------------
// ANSI escape constants — must match src/tui/ansi.ts exactly so assertions
// against rendered output can be written portably.
// ---------------------------------------------------------------------------
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';

/** RENDER_BLOCK_MAX from inspect.ts — the clip threshold. */
const RENDER_BLOCK_MAX = 4000;

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * A minimal two-turn IoCaptureRecord set:
 *   Turn A (turnId 'T1'): request + response
 *   Turn B (turnId 'T2'): request + response + tool_result
 */
function makeTwoTurnRecords(): IoCaptureRecord[] {
  const envelope = (turnId: string, stepIndex: number): object => ({
    sessionId: 'session-1',
    threadId: 'thread-1',
    turnId,
    stepIndex,
    ts: '2026-06-13T10:00:00.000Z',
  });

  return [
    {
      ...envelope('T1', 0),
      kind: 'request',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'human', content: 'Hello, agent!' },
      ],
      boundTools: [
        {
          name: 'bash_run',
          description: 'Run a bash command',
          parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    },
    {
      ...envelope('T1', 0),
      kind: 'response',
      finalText: 'Hello! How can I help you today?',
      toolCalls: [],
    },
    {
      ...envelope('T2', 0),
      kind: 'request',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'human', content: 'Run ls for me' },
      ],
      boundTools: [],
    },
    {
      ...envelope('T2', 0),
      kind: 'response',
      finalText: '',
      toolCalls: [{ id: 'call-1', name: 'bash_run', args: { command: 'ls', args: [] } }],
    },
    {
      ...envelope('T2', 1),
      kind: 'tool_result',
      toolName: 'bash_run',
      ok: true,
      durationMs: 42,
      result: 'file1.txt\nfile2.txt',
    },
  ] as IoCaptureRecord[];
}

/** Stub IoCapture where capture IS active. */
function makeActiveStub(records?: IoCaptureRecord[]): IoCapture {
  const recs = records ?? makeTwoTurnRecords();
  return {
    boundToolSchemas: [],
    currentSessionId: 'session-1',
    currentCapturePath: '/tmp/io-captures/session-test.jsonl',
    captureRequest: () => {},
    captureResponse: () => {},
    captureToolResult: () => {},
    read: () => recs.slice(),
    close: async () => {},
  };
}

/** Stub IoCapture where capture is OFF (NullIoCapture-like). */
function makeInactiveStub(): IoCapture {
  return {
    boundToolSchemas: [],
    currentSessionId: 'disabled',
    currentCapturePath: '',
    captureRequest: () => {},
    captureResponse: () => {},
    captureToolResult: () => {},
    read: () => [],
    close: async () => {},
  };
}

/** Stub IoCapture whose read() throws a deterministic error. */
function makeThrowingStub(): IoCapture {
  return {
    boundToolSchemas: [],
    currentSessionId: 'session-err',
    currentCapturePath: '/tmp/io-captures/session-err.jsonl',
    captureRequest: () => {},
    captureResponse: () => {},
    captureToolResult: () => {},
    read: () => {
      throw new Error('disk read failure');
    },
    close: async () => {},
  };
}

/**
 * Build a fake SlashContext backed by the given ioCapture stub.
 * Returned `output` accumulates every call to println / printSystem.
 */
function makeCtx(ioCapture: IoCapture): {
  ctx: SlashContext;
  output: Array<{ kind: 'println' | 'printSystem'; text: string }>;
} {
  const output: Array<{ kind: 'println' | 'printSystem'; text: string }> = [];
  const ctx: SlashContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller: { ioCapture } as any,
    println: (text) => output.push({ kind: 'println', text }),
    printSystem: (text) => output.push({ kind: 'printSystem', text }),
  };
  return { ctx, output };
}

/** Strip ANSI escape sequences so text assertions are readable. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Concatenate all output lines into a single string (with newlines). */
function joined(output: Array<{ kind: string; text: string }>): string {
  return output.map((o) => o.text).join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('/inspect command registration', () => {
  it('is registered as /inspect', () => {
    const cmd = findCommand('/inspect');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('/inspect');
  });

  it('is registered with alias /inspect-io', () => {
    const cmd = findCommand('/inspect-io');
    expect(cmd).toBeDefined();
    expect(cmd!.name).toBe('/inspect');
  });

  it('has a summary string', () => {
    const cmd = findCommand('/inspect');
    expect(typeof cmd!.summary).toBe('string');
    expect(cmd!.summary.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// status sub-command
// ---------------------------------------------------------------------------

describe('/inspect status', () => {
  it('reports inactive when currentCapturePath is empty (no-arg default)', async () => {
    const { ctx, output } = makeCtx(makeInactiveStub());
    const cmd = findCommand('/inspect')!;
    // No args — should default to 'status'
    await cmd.run(ctx, []);
    const text = stripAnsi(joined(output));
    expect(text).toContain('LLM I/O capture');
    expect(text).toContain('inactive');
    expect(text).toMatch(/enabled.*no/i);
    expect(text).toContain('--inspect-io');
  });

  it('reports inactive when explicit "status" arg is passed with empty path', async () => {
    const { ctx, output } = makeCtx(makeInactiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['status']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('inactive');
    expect(text).toMatch(/enabled.*no/i);
  });

  it('reports active with path and record/turn counts', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['status']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('active');
    expect(text).toMatch(/enabled.*yes/i);
    expect(text).toContain('/tmp/io-captures/session-test.jsonl');
    // 5 records across 2 turns
    expect(text).toContain('5');
    expect(text).toContain('2');
    expect(text).toMatch(/turn/i);
  });

  it('shows singular "turn" when there is exactly one turn', async () => {
    // Only T1 records (first 2 records)
    const records = makeTwoTurnRecords().slice(0, 2);
    const { ctx, output } = makeCtx(makeActiveStub(records));
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['status']);
    const text = stripAnsi(joined(output));
    // "1 turn" not "1 turns"
    expect(text).toMatch(/\b1\b.*turn[^s]/i);
  });

  it('shows plural "turns" when there are multiple turns', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['status']);
    const text = stripAnsi(joined(output));
    expect(text).toMatch(/turns/i);
  });

  it('prints a failure line via printSystem when read() throws — does not crash', async () => {
    const { ctx, output } = makeCtx(makeThrowingStub());
    const cmd = findCommand('/inspect')!;
    // Must not throw
    await expect(cmd.run(ctx, ['status'])).resolves.toBeUndefined();
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    expect(systemMsgs.length).toBeGreaterThan(0);
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/failed.*read|disk read failure/i);
  });

  it('includes a hint to use /inspect show in the active status output', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['status']);
    const text = stripAnsi(joined(output));
    expect(text).toMatch(/inspect show/i);
  });
});

// ---------------------------------------------------------------------------
// on / off sub-commands
// ---------------------------------------------------------------------------

describe('/inspect on', () => {
  it('emits an informational [system] message when capture is active', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['on']);
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    expect(systemMsgs.length).toBeGreaterThan(0);
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/--inspect-io/i);
    // Should mention the current capture path
    expect(text).toContain('/tmp/io-captures/session-test.jsonl');
    expect(text).toMatch(/ACTIVE|active/i);
  });

  it('emits an informational [system] message when capture is inactive', async () => {
    const { ctx, output } = makeCtx(makeInactiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['on']);
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    expect(systemMsgs.length).toBeGreaterThan(0);
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/--inspect-io/i);
    expect(text).toMatch(/OFF|Restart|restart/i);
  });

  it('does NOT silently no-op — always prints something', async () => {
    const { ctx, output } = makeCtx(makeInactiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['on']);
    expect(output.length).toBeGreaterThan(0);
  });
});

describe('/inspect off', () => {
  it('emits an informational [system] message (mirrors /inspect on) when active', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['off']);
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    expect(systemMsgs.length).toBeGreaterThan(0);
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/--inspect-io/i);
  });

  it('emits an informational [system] message when inactive', async () => {
    const { ctx, output } = makeCtx(makeInactiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['off']);
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    expect(systemMsgs.length).toBeGreaterThan(0);
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/--inspect-io/i);
  });

  it('does NOT silently no-op — always prints something', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['off']);
    expect(output.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// show sub-command — precondition guards
// ---------------------------------------------------------------------------

describe('/inspect show — precondition guards', () => {
  it('emits system message when capture is OFF', async () => {
    const { ctx, output } = makeCtx(makeInactiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show']);
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    expect(systemMsgs.length).toBeGreaterThan(0);
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/capture is OFF|OFF/i);
    expect(text).toMatch(/--inspect-io/i);
  });

  it('emits system message when no turns have been recorded yet', async () => {
    const { ctx, output } = makeCtx(makeActiveStub([]));
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show']);
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    expect(systemMsgs.length).toBeGreaterThan(0);
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/no captured turns/i);
  });

  it('emits system message for out-of-range turn number (too high)', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '99']);
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    expect(systemMsgs.length).toBeGreaterThan(0);
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/invalid turn/i);
    expect(text).toContain('99');
  });

  it('emits system message for out-of-range turn number (zero)', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '0']);
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/invalid turn/i);
  });

  it('emits system message for non-numeric turn arg', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', 'abc']);
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/invalid turn/i);
  });

  it('prints a failure line via printSystem when read() throws — does not crash', async () => {
    const { ctx, output } = makeCtx(makeThrowingStub());
    const cmd = findCommand('/inspect')!;
    await expect(cmd.run(ctx, ['show'])).resolves.toBeUndefined();
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    expect(systemMsgs.length).toBeGreaterThan(0);
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/failed.*read|disk read failure/i);
  });
});

// ---------------------------------------------------------------------------
// show sub-command — rendering: no arg → latest turn
// ---------------------------------------------------------------------------

describe('/inspect show — no arg renders latest turn', () => {
  it('renders Turn header for the LAST (2nd) turn when no arg given', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show']);
    const text = stripAnsi(joined(output));
    // Should render "Turn 2" (latest), not "Turn 1"
    expect(text).toContain('Turn 2');
  });

  it('renders the REQUEST section header for the latest turn', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('── REQUEST');
  });

  it('renders the RESPONSE section header for the latest turn', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('── RESPONSE');
  });

  it('renders the TOOL RESULT section header for the latest turn', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('── TOOL RESULT');
    expect(text).toContain('bash_run');
  });

  it('renders the user message content in the REQUEST section', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('Run ls for me');
  });

  it('renders the system message role label in the REQUEST section', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('system');
  });

  it('renders tool-call name in the RESPONSE section', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('bash_run');
    expect(text).toContain('tool-call');
  });
});

// ---------------------------------------------------------------------------
// show sub-command — rendering: explicit turn 1
// ---------------------------------------------------------------------------

describe('/inspect show <N> — explicit turn rendering', () => {
  it('renders Turn 1 when arg "1" is passed', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('Turn 1');
  });

  it('renders the user content from turn 1', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('Hello, agent!');
  });

  it('renders bound tool schemas when present in turn 1 REQUEST', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('Bound tool schemas');
    expect(text).toContain('bash_run');
    expect(text).toContain('Run a bash command');
  });

  it('renders the response finalText from turn 1', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('Hello! How can I help you today?');
  });

  it('renders turn 2 when arg "2" is passed (1-based indexing)', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '2']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('Turn 2');
    expect(text).toContain('Run ls for me');
  });

  it('includes the turn timestamp from the first record', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('2026-06-13T10:00:00.000Z');
  });

  it('includes tool_result ok status and duration', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '2']);
    const text = stripAnsi(joined(output));
    // The tool result shows ok / durationMs
    expect(text).toMatch(/ok|42ms/i);
  });
});

// ---------------------------------------------------------------------------
// show sub-command — truncation
// ---------------------------------------------------------------------------

describe('/inspect show — truncation of long blocks', () => {
  it('clips content longer than RENDER_BLOCK_MAX and shows … [truncated] marker', async () => {
    const longContent = 'X'.repeat(RENDER_BLOCK_MAX + 100);
    const records: IoCaptureRecord[] = [
      {
        sessionId: 'session-1',
        threadId: 'thread-1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'request',
        messages: [
          { role: 'system', content: longContent },
          { role: 'human', content: 'Short user content' },
        ],
        boundTools: [],
      },
      {
        sessionId: 'session-1',
        threadId: 'thread-1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'response',
        finalText: 'Short response',
        toolCalls: [],
      },
    ] as IoCaptureRecord[];

    const { ctx, output } = makeCtx(makeActiveStub(records));
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('… [truncated]');
    // The long content should be sliced to RENDER_BLOCK_MAX chars
    expect(text).toContain('X'.repeat(RENDER_BLOCK_MAX));
    // But NOT the full +100 overshoot
    expect(text).not.toContain('X'.repeat(RENDER_BLOCK_MAX + 1));
  });

  it('clips long finalText in a RESPONSE section', async () => {
    const longResponse = 'R'.repeat(RENDER_BLOCK_MAX + 50);
    const records: IoCaptureRecord[] = [
      {
        sessionId: 's1',
        threadId: 't1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'request',
        messages: [{ role: 'human', content: 'hi' }],
        boundTools: [],
      },
      {
        sessionId: 's1',
        threadId: 't1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'response',
        finalText: longResponse,
        toolCalls: [],
      },
    ] as IoCaptureRecord[];

    const { ctx, output } = makeCtx(makeActiveStub(records));
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('… [truncated]');
    expect(text).toContain('R'.repeat(RENDER_BLOCK_MAX));
    expect(text).not.toContain('R'.repeat(RENDER_BLOCK_MAX + 1));
  });

  it('does NOT show truncation marker for content at exactly RENDER_BLOCK_MAX', async () => {
    const exactContent = 'E'.repeat(RENDER_BLOCK_MAX);
    const records: IoCaptureRecord[] = [
      {
        sessionId: 's1',
        threadId: 't1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'request',
        messages: [{ role: 'human', content: exactContent }],
        boundTools: [],
      },
      {
        sessionId: 's1',
        threadId: 't1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'response',
        finalText: 'ok',
        toolCalls: [],
      },
    ] as IoCaptureRecord[];

    const { ctx, output } = makeCtx(makeActiveStub(records));
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = stripAnsi(joined(output));
    expect(text).not.toContain('… [truncated]');
  });
});

// ---------------------------------------------------------------------------
// show sub-command — tool-call detail in RESPONSE
// ---------------------------------------------------------------------------

describe('/inspect show — tool-call rendering in RESPONSE', () => {
  it('renders tool-call id when present', async () => {
    const records: IoCaptureRecord[] = [
      {
        sessionId: 's1',
        threadId: 't1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'request',
        messages: [{ role: 'human', content: 'call a tool' }],
        boundTools: [],
      },
      {
        sessionId: 's1',
        threadId: 't1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'response',
        finalText: '',
        toolCalls: [{ id: 'my-call-id', name: 'some_tool', args: { x: 1 } }],
      },
    ] as IoCaptureRecord[];

    const { ctx, output } = makeCtx(makeActiveStub(records));
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = joined(output); // keep ANSI to check DIM markers
    const plain = stripAnsi(text);
    expect(plain).toContain('some_tool');
    // The id should be rendered somewhere (possibly with DIM prefix #)
    expect(plain).toContain('my-call-id');
  });

  it('renders tool-call args as JSON', async () => {
    const records: IoCaptureRecord[] = [
      {
        sessionId: 's1',
        threadId: 't1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'request',
        messages: [{ role: 'human', content: 'call' }],
        boundTools: [],
      },
      {
        sessionId: 's1',
        threadId: 't1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'response',
        finalText: '',
        toolCalls: [{ name: 'my_tool', args: { alpha: 'beta', count: 3 } }],
      },
    ] as IoCaptureRecord[];

    const { ctx, output } = makeCtx(makeActiveStub(records));
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = stripAnsi(joined(output));
    expect(text).toContain('"alpha"');
    expect(text).toContain('"beta"');
  });
});

// ---------------------------------------------------------------------------
// show sub-command — REQUEST message with tool calls (ai message with tool_calls)
// ---------------------------------------------------------------------------

describe('/inspect show — REQUEST messages with toolCalls field', () => {
  it('renders tool-call entries from message.toolCalls in the REQUEST section', async () => {
    const records: IoCaptureRecord[] = [
      {
        sessionId: 's1',
        threadId: 't1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'request',
        messages: [
          {
            role: 'ai',
            content: '',
            toolCalls: [{ id: 'tc-1', name: 'bash_run', args: { command: 'pwd' } }],
          },
          {
            role: 'tool',
            content: '/home/user',
            toolCallId: 'tc-1',
          },
        ],
        boundTools: [],
      },
      {
        sessionId: 's1',
        threadId: 't1',
        turnId: 'T1',
        stepIndex: 0,
        ts: '2026-06-13T10:00:00.000Z',
        kind: 'response',
        finalText: 'Done',
        toolCalls: [],
      },
    ] as IoCaptureRecord[];

    const { ctx, output } = makeCtx(makeActiveStub(records));
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const text = stripAnsi(joined(output));
    // ai message should show its tool-call name
    expect(text).toContain('bash_run');
    // tool message should show its toolCallId
    expect(text).toContain('tc-1');
  });
});

// ---------------------------------------------------------------------------
// unknown subcommand
// ---------------------------------------------------------------------------

describe('/inspect unknown subcommand', () => {
  it('emits a system message for an unrecognised sub-command', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['bogus']);
    const systemMsgs = output.filter((o) => o.kind === 'printSystem');
    expect(systemMsgs.length).toBeGreaterThan(0);
    const text = stripAnsi(systemMsgs.map((o) => o.text).join('\n'));
    expect(text).toMatch(/unknown subcommand/i);
    expect(text).toContain('bogus');
  });

  it('suggests valid subcommands in the unknown error message', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['xyz']);
    const text = stripAnsi(output.map((o) => o.text).join('\n'));
    expect(text).toMatch(/status|show/i);
  });
});

// ---------------------------------------------------------------------------
// ANSI rendering — verify that key sections carry expected escape codes
// (smoke-check that BOLD/CYAN are used for section headers)
// ---------------------------------------------------------------------------

describe('/inspect show — ANSI markup on section headers', () => {
  it('uses BOLD in the Turn header line', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const raw = joined(output);
    // The Turn header should contain the BOLD escape
    const turnLine = raw.split('\n').find((l) => stripAnsi(l).includes('Turn 1'));
    expect(turnLine).toBeDefined();
    expect(turnLine).toContain(BOLD);
  });

  it('uses CYAN in the REQUEST section header line', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const raw = joined(output);
    const reqLine = raw.split('\n').find((l) => stripAnsi(l).includes('── REQUEST'));
    expect(reqLine).toBeDefined();
    expect(reqLine).toContain(CYAN);
  });

  it('uses CYAN in the RESPONSE section header line', async () => {
    const { ctx, output } = makeCtx(makeActiveStub());
    const cmd = findCommand('/inspect')!;
    await cmd.run(ctx, ['show', '1']);
    const raw = joined(output);
    const respLine = raw.split('\n').find((l) => stripAnsi(l).includes('── RESPONSE'));
    expect(respLine).toBeDefined();
    expect(respLine).toContain(CYAN);
  });
});
