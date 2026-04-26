/**
 * Controller tests.
 *
 * Drives runTurn() with a mocked streamOneShot that yields a sequence of
 * AgentStreamEvent values, and asserts:
 *   - tokens are written to the supplied stdout
 *   - tool_call_start prints `↳ calling <name>(...)`
 *   - tool_call_end prints ` ✓` and the duration
 *   - the resulting messages array contains user + assistant
 *   - persistTurn writes to the history dir under HOME
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';

vi.mock('../agent/graph.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agent/graph.js')>();
  return {
    ...actual,
    // eslint-disable-next-line require-yield
    streamOneShot: vi.fn().mockImplementation(async function* () {
      yield { kind: 'token', text: 'Hello, ' };
      yield { kind: 'tool_call_start', toolName: 'bash_run', args: { command: 'ls' } };
      yield { kind: 'tool_call_end', toolName: 'bash_run', durationMs: 42, ok: true };
      yield { kind: 'token', text: 'world!' };
      return 'Hello, world!';
    }),
  };
});

import { TuiController } from './controller.js';

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-controller-'));
  savedHome = process.env['HOME'];
  process.env['HOME'] = tmpHome;
});

afterEach(async () => {
  if (savedHome === undefined) {
    delete process.env['HOME'];
  } else {
    process.env['HOME'] = savedHome;
  }
  try { await fsp.rm(tmpHome, { recursive: true, force: true }); } catch { /* tolerated */ }
});

describe('TuiController.runTurn', () => {
  it('streams tokens and renders tool-call summaries', async () => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const stdout = new PassThrough();
    stdout.on('data', (b: Buffer) => stdoutChunks.push(b.toString('utf8')));
    const stderr = new PassThrough();
    stderr.on('data', (b: Buffer) => stderrChunks.push(b.toString('utf8')));

    const ctl = new TuiController({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cfg: { provider: 'openai', model: 'gpt-4o', maxSteps: 10, tools: [], allowMutations: false } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agentGraph: {} as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger: {
        currentSessionId: 'sess-x',
        currentLogPath: '/tmp/x',
        log: vi.fn(),
        flush: vi.fn().mockResolvedValue(undefined),
        close: vi.fn().mockResolvedValue(undefined),
      } as any,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
    });

    const abort = new AbortController();
    await ctl.runTurn('hi', abort);

    const all = stdoutChunks.join('');
    expect(all).toContain('Hello, ');
    expect(all).toContain('world!');
    expect(all).toContain('↳');
    expect(all).toContain('bash_run');
    expect(all).toContain('✓');
    expect(all).toMatch(/42\s*ms/);

    expect(ctl.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(ctl.lastAssistantText).toBe('Hello, world!');

    // Regression: after tool_call_end the controller restarts the
    // spinner; the very next 'token' event must pause it BEFORE writing,
    // otherwise braille frames from the spinner timer race the token
    // output and produce corruption like "⠧ Processing tool result... :"
    // landing in the middle of streamed text. Assert that no braille
    // frame character appears inside the assembled assistant text
    // (the agent's actual reply must be clean).
    const BRAILLE_FRAMES = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    for (const frame of BRAILLE_FRAMES) {
      expect(ctl.lastAssistantText).not.toContain(frame);
    }
    // And the literal "Processing tool result..." spinner label must
    // not appear inside the assistant text either.
    expect(ctl.lastAssistantText).not.toContain('Processing tool result');

    // History file written
    const histDir = path.join(tmpHome, '.tool-agents', 'cli-agent', 'history');
    const files = await fsp.readdir(histDir);
    const threadFile = files.find((f) => f.startsWith('thread-') && f.endsWith('.jsonl'));
    expect(threadFile).toBeTruthy();
    const stat = fs.statSync(path.join(histDir, threadFile!));
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });
});
