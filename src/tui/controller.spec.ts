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

import { TuiController, formatToolCallArgs } from './controller.js';
import { NullIoCapture } from '../agent/io-capture.js';

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
      ioCapture: new NullIoCapture(),
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
    // For bash_run, the wrapped binary is surfaced inside the parens
    // instead of `(...)` so the user can see which CLI is actually running.
    // ANSI escapes between the tool name and the open paren are tolerated.
    expect(all).toMatch(/bash_run\x1b\[[0-9;]*m\(ls\)/);
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

describe('formatToolCallArgs', () => {
  it('returns "..." for non-bash_run tools', () => {
    expect(formatToolCallArgs('file_read', { path: 'a.txt' })).toBe('...');
    expect(formatToolCallArgs('web_search', { query: 'x' })).toBe('...');
  });

  it('renders the wrapped binary when args is the parsed object', () => {
    expect(formatToolCallArgs('bash_run', { command: 'ls' })).toBe('ls');
    expect(formatToolCallArgs('bash_run', { command: 'git', args: ['status', '-s'] })).toBe('git status -s');
  });

  // Regression: LangChain v2 `streamEvents` delivers tool input as
  // `{ input: "<JSON string>" }` rather than the parsed object. If the
  // helper does not unwrap that shape, every real bash_run call falls
  // back to the placeholder `(...)` even though the binary name is
  // available in the payload.
  it('unwraps the LangChain { input: "<json>" } envelope', () => {
    const args = { input: JSON.stringify({ command: 'open', args: ['README.md'], confirmed: true }) };
    expect(formatToolCallArgs('bash_run', args)).toBe('open README.md');
  });

  it('clips long argv to keep the line on one row', () => {
    const args = { command: 'echo', args: ['x'.repeat(200)] };
    const rendered = formatToolCallArgs('bash_run', args);
    expect(rendered.length).toBeLessThanOrEqual(60);
    expect(rendered.endsWith('…')).toBe(true);
  });

  it('returns "..." when payload is malformed', () => {
    expect(formatToolCallArgs('bash_run', null)).toBe('...');
    expect(formatToolCallArgs('bash_run', { input: 'not-json' })).toBe('...');
    expect(formatToolCallArgs('bash_run', { args: ['x'] })).toBe('...');
  });
});
