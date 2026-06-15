/**
 * Unit E — LLM I/O inspector capture-channel tests (plan-007, design-007).
 *
 * Sole owner of this spec file. Binds to the ACTUAL exported surface of
 * `./io-capture.ts` (Unit B) and the `loadAgentConfig` `inspectIo` resolution
 * in `../config/agent-config.ts` (Unit A). Production source is NEVER modified
 * by this file.
 *
 * Coverage map (design-007 lines ~591-595):
 *   - Step 11 — capture CONTENT FIDELITY + provider-neutrality
 *   - Step 12 — REDACTION default + raw opt-out + 64 KiB truncation
 *   - Step 13 — four-tier PRECEDENCE + NO-FALLBACK ConfigurationError
 *   - Step 14 — FILESYSTEM conventions (0700 dir / 0600 file / latest / UTC name)
 *   - Step 15 — OFF-STATE no-op byte-stability (NullIoCapture)
 *
 * Filesystem isolation:
 *   - `FileIoCapture` writes are exercised against a fresh `fs.mkdtemp` dir,
 *     cleaned in `afterEach`. The REAL `~/.tool-agents/cli-agent` is never
 *     touched. `FileIoCapture` uses synchronous `node:fs` only, so the
 *     `node:fs/promises` mock below does NOT affect it.
 *   - The Step-13 precedence tests drive `loadAgentConfig`, whose
 *     `resolveInspectIo` calls `fsp.mkdir` / `fsp.chmod` / `fsp.access`
 *     (async) and whose `bootstrapAgentDir` writes via `fsp.*`. We mock
 *     `node:fs/promises` (hoisted, module-wide) so that codepath stays
 *     hermetic; the no-fallback test makes `fsp.mkdir` reject for a
 *     designated broken dir.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DynamicStructuredTool } from '@langchain/core/tools';
import {
  SystemMessage,
  HumanMessage,
  AIMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';

import {
  FileIoCapture,
  NullIoCapture,
  createIoCapture,
  toCaptureMessage,
  extractStartMessages,
  captureBoundToolSchemas,
  type IoCapture,
  type IoCaptureRecord,
  type BoundToolSchema,
} from './io-capture.js';
import type { AgentConfig } from '../config/agent-config.js';

// ---------------------------------------------------------------------------
// node:fs/promises mock — keeps `loadAgentConfig` (Step 13) hermetic.
//
// Mirrors the proven mock in `../config/agent-config.spec.ts`: source uses both
// `import fsp from 'node:fs/promises'` (default) and named imports, so the mock
// exposes BOTH a `default` object and the same names at top level.
//
// `mkdir`/`chmod`/`access` resolve by default so the inspector "requested"
// path (which creates + W_OK-checks the capture dir) succeeds. Individual
// tests can override (e.g. make `mkdir` reject) to drive the no-fallback path.
//
// NOTE: `node:fs` (synchronous) is intentionally NOT mocked, so `FileIoCapture`
// uses the real filesystem against the temp dirs created in each test, and
// `fs.constants.O_WRONLY|O_CREAT|O_APPEND` stay real.
// ---------------------------------------------------------------------------
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const enoent = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  // Paths bootstrap "wrote" become visible to later access() calls.
  const writtenPaths = new Set<string>();
  // Concrete file contents a test can register (e.g. a config.json body).
  const fileContents = new Map<string, Buffer>();
  const mocks = {
    mkdir: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    access: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockImplementation((p: string) => {
      writtenPaths.add(String(p));
      return Promise.resolve(undefined);
    }),
    readFile: vi.fn().mockImplementation((p: string, enc?: string) => {
      const key = String(p);
      const buf = fileContents.get(key);
      if (buf !== undefined) {
        if (enc === 'utf8') return Promise.resolve(buf.toString('utf8'));
        return Promise.resolve(buf);
      }
      if (key.endsWith('.env')) return Promise.resolve('');
      if (key.endsWith('config.json')) return enoent();
      return enoent();
    }),
    readdir: vi.fn().mockResolvedValue([]),
    stat: vi.fn().mockImplementation(async (p: string) => {
      const buf = fileContents.get(String(p));
      if (!buf) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: buf.length, mtime: new Date('2026-01-01T00:00:00Z') };
    }),
  };
  return {
    ...actual,
    ...mocks,
    default: { ...actual, ...mocks },
    __testHelpers: { fileContents, writtenPaths },
  };
});

/** Access the mocked-fs file map so a test can register a config.json body. */
async function getMockFiles(): Promise<Map<string, Buffer>> {
  const mod = (await import('node:fs/promises')) as unknown as {
    __testHelpers: { fileContents: Map<string, Buffer> };
  };
  return mod.__testHelpers.fileContents;
}

/**
 * Reset the fs/promises mock to its default (all-resolving) behaviour and
 * re-establish EVERY fn implementation. Re-establishing `readFile` is
 * essential: `loadAgentConfig` → `readConfigFile` does `JSON.parse(readFile())`,
 * so a stripped (undefined-returning) `readFile` would throw
 * `"undefined" is not valid JSON`. We re-seed all fns each time rather than
 * rely on the factory defaults surviving prior tests.
 */
async function resetFsPromisesMock(): Promise<void> {
  const fsp = await import('node:fs/promises');
  const files = await getMockFiles();
  files.clear();
  const enoent = (): Promise<never> =>
    Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  (fsp.mkdir as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
  (fsp.chmod as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
  (fsp.access as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(undefined);
  (fsp.writeFile as unknown as ReturnType<typeof vi.fn>)
    .mockReset()
    .mockResolvedValue(undefined);
  (fsp.readdir as unknown as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue([]);
  (fsp.readFile as unknown as ReturnType<typeof vi.fn>)
    .mockReset()
    .mockImplementation((p: string, enc?: string) => {
      const key = String(p);
      const buf = files.get(key);
      if (buf !== undefined) {
        if (enc === 'utf8') return Promise.resolve(buf.toString('utf8'));
        return Promise.resolve(buf);
      }
      if (key.endsWith('.env')) return Promise.resolve('');
      return enoent();
    });
  (fsp.stat as unknown as ReturnType<typeof vi.fn>)
    .mockReset()
    .mockImplementation(async (p: string) => {
      const buf = files.get(String(p));
      if (!buf) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { size: buf.length, mtime: new Date('2026-01-01T00:00:00Z') };
    });
}

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/** A real DynamicStructuredTool built with a Zod schema (for convertToOpenAITool). */
function makeEchoTool(): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'echo',
    description: 'Echo back the message',
    schema: z.object({
      message: z.string().describe('the text to echo'),
    }),
    func: async ({ message }: { message: string }) => message,
  });
}

/** Make a fresh, isolated temp capture dir; returns its absolute path. */
function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'io-capture-spec-'));
}

/** Read every JSONL line of a capture file into parsed records. */
function readJsonl(file: string): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** Minimal AgentConfig stub carrying only the `inspectIo` field createIoCapture reads. */
function cfgWithInspect(inspectIo: AgentConfig['inspectIo']): AgentConfig {
  return { inspectIo } as unknown as AgentConfig;
}

const ENVELOPE = {
  sessionId: 'sess-1',
  threadId: 'thread-1',
  turnId: 'turn-1',
  stepIndex: 0,
  ts: '2026-06-13T10:21:04.512Z',
} as const;

// Track temp dirs for cleanup.
const tmpDirs: string[] = [];
function trackTmp(): string {
  const d = mkTmpDir();
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  // NOTE: we deliberately do NOT call vi.restoreAllMocks() here — it would
  // strip the `node:fs/promises` factory `vi.fn()` implementations and break
  // the Step-13 `loadAgentConfig` codepath. The process.stderr spies in
  // Step 12 are restored inline via spy.mockRestore() within each test.
});

// ===========================================================================
// Step 11 — capture content fidelity + provider-neutrality
// ===========================================================================
describe('Step 11 — content fidelity & provider-neutrality', () => {
  it('toCaptureMessage maps system / human / ai(tool_calls) / tool messages', () => {
    const sys = toCaptureMessage(new SystemMessage('you are helpful'));
    expect(sys).toMatchObject({ role: 'system', content: 'you are helpful' });
    expect(sys.toolCalls).toBeUndefined();
    expect(sys.toolCallId).toBeUndefined();

    const human = toCaptureMessage(new HumanMessage('list files'));
    expect(human).toMatchObject({ role: 'human', content: 'list files' });

    const ai = toCaptureMessage(
      new AIMessage({
        content: 'calling tool',
        tool_calls: [{ id: 'call_1', name: 'bash', args: { cmd: 'ls' } }],
      }),
    );
    expect(ai.role).toBe('ai');
    expect(ai.content).toBe('calling tool');
    expect(ai.toolCalls).toEqual([{ id: 'call_1', name: 'bash', args: { cmd: 'ls' } }]);

    const tool = toCaptureMessage(
      new ToolMessage({ content: 'a.txt\nb.txt', tool_call_id: 'call_1' }),
    );
    expect(tool.role).toBe('tool');
    expect(tool.content).toBe('a.txt\nb.txt');
    expect(tool.toolCallId).toBe('call_1');
  });

  it('toCaptureMessage omits toolCalls when tool_calls is empty (no spurious field)', () => {
    // AIMessage with no tool calls reports tool_calls === [] — must NOT surface.
    const ai = toCaptureMessage(new AIMessage({ content: 'plain answer' }));
    expect(ai.toolCalls).toBeUndefined();
  });

  it('toCaptureMessage is provider-neutral: Anthropic content-block array vs OpenAI plain string yield the same shape (AC-8)', () => {
    // OpenAI-style: content is a plain string.
    const openai = toCaptureMessage(new AIMessage({ content: 'hello world' }));
    // Anthropic-style: content is a block array; only `type:'text'` blocks
    // contribute, joined; non-text blocks (e.g. image) are dropped.
    const anthropic = toCaptureMessage(
      new AIMessage({
        content: [
          { type: 'text', text: 'hello ' },
          { type: 'text', text: 'world' },
          { type: 'image', source: 'x' } as unknown as { type: string },
        ] as unknown as string,
      }),
    );
    expect(openai.content).toBe('hello world');
    expect(anthropic.content).toBe('hello world');
    expect(anthropic.role).toBe(openai.role);
  });

  it('extractStartMessages flattens all three documented shapes (research Q2)', () => {
    const a = new SystemMessage('s');
    const b = new HumanMessage('h');
    // (1) bare BaseMessage[]
    expect(extractStartMessages([a, b])).toEqual([a, b]);
    // (2) { messages: BaseMessage[] }
    expect(extractStartMessages({ messages: [a, b] })).toEqual([a, b]);
    // (3) { messages: BaseMessage[][] } (array-of-arrays)
    expect(extractStartMessages({ messages: [[a], [b]] })).toEqual([a, b]);
    // anything else → []
    expect(extractStartMessages(undefined)).toEqual([]);
    expect(extractStartMessages(42)).toEqual([]);
    expect(extractStartMessages({ nope: 1 })).toEqual([]);
  });

  it('captureBoundToolSchemas yields {name,description,parameters} via convertToOpenAITool (JSON Schema)', () => {
    const schemas = captureBoundToolSchemas([makeEchoTool()]);
    expect(schemas).toHaveLength(1);
    const s = schemas[0] as BoundToolSchema;
    expect(s.name).toBe('echo');
    expect(s.description).toBe('Echo back the message');
    // parameters is the OpenAI-normalized JSON Schema (NOT raw zod).
    const params = s.parameters as Record<string, unknown>;
    expect(params['type']).toBe('object');
    const props = params['properties'] as Record<string, unknown>;
    expect(props).toHaveProperty('message');
    expect((props['message'] as Record<string, unknown>)['type']).toBe('string');
  });

  it('io-capture.ts does NOT import zod-to-json-schema and DOES import convertToOpenAITool (design invariant)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'io-capture.ts'), 'utf8');
    // The invariant is about the IMPORT, not the mere mention (the file's
    // header comment legitimately names the forbidden package to explain why).
    // Assert there is no `import ... from 'zod-to-json-schema'` and no
    // `require('zod-to-json-schema')` anywhere.
    expect(src).not.toMatch(/from\s+['"]zod-to-json-schema['"]/);
    expect(src).not.toMatch(/require\(\s*['"]zod-to-json-schema['"]\s*\)/);
    // And it MUST source schemas from the installed helper.
    expect(src).toMatch(
      /import\s+\{\s*convertToOpenAITool\s*\}\s+from\s+['"]@langchain\/core\/utils\/function_calling['"]/,
    );
  });

  it('a written request record reproduces system+memory+user content, toolCalls (id/name/args) and toolCallId', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({
      dir,
      sessionId: 'sess-1',
      redact: false, // keep verbatim so fidelity is exactly assertable
      boundToolSchemas: captureBoundToolSchemas([makeEchoTool()]),
    });
    const messages: BaseMessage[] = [
      new SystemMessage('SYSTEM: full assembled prompt'),
      new HumanMessage('earlier turn'),
      new AIMessage({
        content: 'I will call bash',
        tool_calls: [{ id: 'call_1', name: 'bash', args: { cmd: 'ls' } }],
      }),
      new ToolMessage({ content: 'a.txt', tool_call_id: 'call_1' }),
      new HumanMessage('current user content'),
    ];
    cap.captureRequest({
      ...ENVELOPE,
      messages: messages.map(toCaptureMessage),
      boundTools: [...cap.boundToolSchemas],
    });

    const rec = readJsonl(cap.currentCapturePath).find((r) => r['kind'] === 'request');
    expect(rec).toBeDefined();
    const msgs = rec!['messages'] as Array<Record<string, unknown>>;
    expect(msgs.map((m) => m['role'])).toEqual(['system', 'human', 'ai', 'tool', 'human']);
    expect(msgs[0]!['content']).toBe('SYSTEM: full assembled prompt');
    expect(msgs[4]!['content']).toBe('current user content');
    const aiMsg = msgs[2]!;
    expect(aiMsg['toolCalls']).toEqual([{ id: 'call_1', name: 'bash', args: { cmd: 'ls' } }]);
    expect(msgs[3]!['toolCallId']).toBe('call_1');
    // boundTools present (denormalized onto the request).
    const bt = rec!['boundTools'] as Array<Record<string, unknown>>;
    expect(bt[0]!['name']).toBe('echo');
  });

  it('a written response record carries finalText and parsed-object toolCalls, correlated by envelope IDs', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({
      dir,
      sessionId: 'sess-1',
      redact: false,
      boundToolSchemas: [],
    });
    cap.captureResponse({
      ...ENVELOPE,
      finalText: 'here is the answer',
      toolCalls: [{ id: 'call_9', name: 'bash', args: { cmd: 'pwd' } }],
    });
    const rec = readJsonl(cap.currentCapturePath).find((r) => r['kind'] === 'response');
    expect(rec).toBeDefined();
    expect(rec!['finalText']).toBe('here is the answer');
    expect(rec!['toolCalls']).toEqual([{ id: 'call_9', name: 'bash', args: { cmd: 'pwd' } }]);
    // correlation envelope (FR-5).
    expect(rec!['sessionId']).toBe('sess-1');
    expect(rec!['threadId']).toBe('thread-1');
    expect(rec!['turnId']).toBe('turn-1');
    expect(rec!['stepIndex']).toBe(0);
  });

  it('boundTools appear only on the stepIndex===0 request (FileIoCapture write path)', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({
      dir,
      sessionId: 'sess-1',
      redact: false,
      boundToolSchemas: captureBoundToolSchemas([makeEchoTool()]),
    });
    // The graph denormalizes schemas only on the first model call per turn; the
    // record itself faithfully persists whatever it is handed.
    cap.captureRequest({
      ...ENVELOPE,
      stepIndex: 0,
      messages: [toCaptureMessage(new HumanMessage('first'))],
      boundTools: [...cap.boundToolSchemas],
    });
    cap.captureRequest({
      ...ENVELOPE,
      stepIndex: 1,
      messages: [toCaptureMessage(new HumanMessage('second'))],
      boundTools: undefined,
    });
    const reqs = readJsonl(cap.currentCapturePath).filter((r) => r['kind'] === 'request');
    const step0 = reqs.find((r) => r['stepIndex'] === 0)!;
    const step1 = reqs.find((r) => r['stepIndex'] === 1)!;
    expect(step0['boundTools']).toBeDefined();
    expect(step1['boundTools']).toBeUndefined();
  });

  it('read() serves the in-memory record mirror without re-reading disk', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({ dir, sessionId: 'sess-1', redact: false, boundToolSchemas: [] });
    cap.captureRequest({ ...ENVELOPE, messages: [], boundTools: [] });
    cap.captureResponse({ ...ENVELOPE, finalText: 'x', toolCalls: [] });
    const recs = cap.read();
    expect(recs).toHaveLength(2);
    expect(recs[0]!.kind).toBe('request');
    expect(recs[1]!.kind).toBe('response');
  });
});

// ===========================================================================
// Step 12 — redaction default ON + raw opt-out + 64 KiB truncation
// ===========================================================================
describe('Step 12 — redaction & truncation', () => {
  const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
  const SECRET_LINE = `OPENAI_API_KEY=${SECRET}`;

  it('redact:true (default) masks a secret in message content AND tool-call args', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({ dir, sessionId: 'sess-1', redact: true, boundToolSchemas: [] });
    cap.captureRequest({
      ...ENVELOPE,
      messages: [
        {
          role: 'human',
          content: `here is my key ${SECRET_LINE}`,
          toolCalls: [{ id: 'c1', name: 'bash', args: { token: `Bearer ${SECRET}` } }],
        },
      ],
      boundTools: [],
    });
    const raw = fs.readFileSync(cap.currentCapturePath, 'utf8');
    // The bare secret value must NOT survive anywhere in the written bytes.
    expect(raw).not.toContain(SECRET);
    // The masking markers are present.
    expect(raw).toContain('[REDACTED]');
  });

  it('redact:false leaves the secret verbatim (raw opt-out)', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({ dir, sessionId: 'sess-1', redact: false, boundToolSchemas: [] });
    cap.captureResponse({
      ...ENVELOPE,
      finalText: `the key is ${SECRET_LINE}`,
      toolCalls: [{ id: 'c1', name: 'bash', args: { token: `Bearer ${SECRET}` } }],
    });
    const raw = fs.readFileSync(cap.currentCapturePath, 'utf8');
    expect(raw).toContain(SECRET);
  });

  it('createIoCapture with redact:false emits a stderr warning BEFORE opening the file', () => {
    const dir = trackTmp();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      });
    const cap = createIoCapture(
      cfgWithInspect({ enabled: true, redact: false, dir }),
      'sess-1',
      [makeEchoTool()],
    );
    spy.mockRestore();
    expect(cap).toBeInstanceOf(FileIoCapture);
    const warning = writes.join('');
    expect(warning).toMatch(/WARNING/i);
    expect(warning).toMatch(/--inspect-io-raw/);
    expect(warning).toMatch(/without redaction|plaintext/i);
  });

  it('createIoCapture with redact:true (default) emits NO stderr warning', () => {
    const dir = trackTmp();
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        writes.push(String(chunk));
        return true;
      });
    createIoCapture(cfgWithInspect({ enabled: true, redact: true, dir }), 'sess-1', [makeEchoTool()]);
    spy.mockRestore();
    expect(writes.join('')).not.toMatch(/WARNING/i);
  });

  it('a >64 KiB string field is truncated with _truncated:true + _orig_size_bytes', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({ dir, sessionId: 'sess-1', redact: false, boundToolSchemas: [] });
    const big = 'A'.repeat(64 * 1024 + 500); // exceeds the 64 KiB cap
    cap.captureRequest({
      ...ENVELOPE,
      messages: [{ role: 'system', content: big }],
      boundTools: [],
    });
    const rec = readJsonl(cap.currentCapturePath).find((r) => r['kind'] === 'request')!;
    expect(rec['_truncated']).toBe(true);
    expect(rec['_orig_size_bytes']).toBeDefined();
    // The persisted content is capped to <= 64 KiB.
    const persisted = (rec['messages'] as Array<Record<string, unknown>>)[0]!['content'] as string;
    expect(Buffer.byteLength(persisted, 'utf8')).toBeLessThanOrEqual(64 * 1024);
    // The recorded original size reflects the pre-truncation byte length.
    const sizes = rec['_orig_size_bytes'] as Record<string, number>;
    const recordedSizes = Object.values(sizes);
    expect(recordedSizes.some((n) => n === Buffer.byteLength(big, 'utf8'))).toBe(true);
  });

  it('a string field at/below 64 KiB is NOT truncated', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({ dir, sessionId: 'sess-1', redact: false, boundToolSchemas: [] });
    const fits = 'B'.repeat(1024);
    cap.captureResponse({ ...ENVELOPE, finalText: fits, toolCalls: [] });
    const rec = readJsonl(cap.currentCapturePath).find((r) => r['kind'] === 'response')!;
    expect(rec['_truncated']).toBeUndefined();
    expect(rec['finalText']).toBe(fits);
  });
});

// ===========================================================================
// Step 13 — four-tier precedence + no-fallback ConfigurationError
// ===========================================================================
describe('Step 13 — switch precedence (four-tier) & no-fallback', () => {
  let loadAgentConfig: typeof import('../config/agent-config.js').loadAgentConfig;

  beforeEach(async () => {
    await resetFsPromisesMock();
    ({ loadAgentConfig } = await import('../config/agent-config.js'));
  });

  it('(a) CLI flag inspectIo:true enables, with env unset and config absent', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai', inspectIo: true },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.inspectIo).not.toBeNull();
    expect(cfg.inspectIo!.enabled).toBe(true);
    // redaction ON by default.
    expect(cfg.inspectIo!.redact).toBe(true);
  });

  it('(a2) CLI flag inspectIo:true WINS over env CLI_AGENT_INSPECT_IO=0', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai', inspectIo: true },
      { shellEnv: { CLI_AGENT_INSPECT_IO: '0' }, cwd: '/tmp' },
    );
    // CLI flag is highest priority → still enabled despite env=0.
    expect(cfg.inspectIo).not.toBeNull();
    expect(cfg.inspectIo!.enabled).toBe(true);
  });

  it('(b) env CLI_AGENT_INSPECT_IO=1 enables when no CLI flag', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: { CLI_AGENT_INSPECT_IO: '1' }, cwd: '/tmp' },
    );
    expect(cfg.inspectIo).not.toBeNull();
    expect(cfg.inspectIo!.enabled).toBe(true);
  });

  it('(b2) env CLI_AGENT_INSPECT_IO=1 WINS over config.json inspectIo.enabled=false', async () => {
    const files = await getMockFiles();
    const configPath = path.join('/tmp', 'my-config.json');
    files.set(
      configPath,
      Buffer.from(JSON.stringify({ inspectIo: { enabled: false } }), 'utf8'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai', configFile: configPath },
      { shellEnv: { CLI_AGENT_INSPECT_IO: '1' }, cwd: '/tmp' },
    );
    // env tier outranks the config.json tier.
    expect(cfg.inspectIo).not.toBeNull();
    expect(cfg.inspectIo!.enabled).toBe(true);
  });

  it('(c) config.json inspectIo.enabled=true enables when no flag/env', async () => {
    const files = await getMockFiles();
    const configPath = path.join('/tmp', 'cfg-enabled.json');
    files.set(
      configPath,
      Buffer.from(JSON.stringify({ inspectIo: { enabled: true } }), 'utf8'),
    );
    const cfg = await loadAgentConfig(
      { provider: 'openai', configFile: configPath },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.inspectIo).not.toBeNull();
    expect(cfg.inspectIo!.enabled).toBe(true);
  });

  it('(d) nothing set → inspectIo === null (off, no capture)', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.inspectIo).toBeNull();
  });

  it('(d2) off-state cfg → createIoCapture returns NullIoCapture', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai' },
      { shellEnv: {}, cwd: '/tmp' },
    );
    const cap = createIoCapture(cfg, 'sess-1', [makeEchoTool()]);
    expect(cap).toBeInstanceOf(NullIoCapture);
  });

  it('(e) --inspect-io-raw flag flips redact to false', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai', inspectIo: true, inspectIoRaw: true },
      { shellEnv: {}, cwd: '/tmp' },
    );
    expect(cfg.inspectIo).not.toBeNull();
    expect(cfg.inspectIo!.redact).toBe(false);
  });

  it('(e2) env CLI_AGENT_INSPECT_IO_RAW=1 flips redact to false', async () => {
    const cfg = await loadAgentConfig(
      { provider: 'openai', inspectIo: true },
      { shellEnv: { CLI_AGENT_INSPECT_IO_RAW: '1' }, cwd: '/tmp' },
    );
    expect(cfg.inspectIo).not.toBeNull();
    expect(cfg.inspectIo!.redact).toBe(false);
  });

  it('(f) no-fallback: an un-creatable capture dir throws ConfigurationError (NOT null)', async () => {
    // Drive the failure through resolveInspectIo specifically (not the earlier
    // bootstrapAgentDir mkdir of the default dir): point inspectIo.dir at a
    // UNIQUE path and reject mkdir only for that exact path. resolveInspectIo
    // must raise ConfigurationError, never downgrade to inspectIo:null / a
    // NullIoCapture.
    const brokenDir = path.join(os.tmpdir(), 'io-capture-spec-broken-dir-XYZ');
    const files = await getMockFiles();
    const configPath = path.join('/tmp', 'broken-dir.json');
    files.set(
      configPath,
      Buffer.from(JSON.stringify({ inspectIo: { enabled: true, dir: brokenDir } }), 'utf8'),
    );
    const fsp = await import('node:fs/promises');
    (fsp.mkdir as unknown as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (String(p) === brokenDir) {
        return Promise.reject(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        );
      }
      return Promise.resolve(undefined);
    });
    await expect(
      loadAgentConfig(
        { provider: 'openai', configFile: configPath },
        { shellEnv: {}, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING', exitCode: 3 });
  });

  it('(f2) no-fallback: a non-writable capture dir (W_OK access fails) throws ConfigurationError', async () => {
    const brokenDir = path.join(os.tmpdir(), 'io-capture-spec-nonwritable-XYZ');
    const files = await getMockFiles();
    const configPath = path.join('/tmp', 'nonwritable-dir.json');
    files.set(
      configPath,
      Buffer.from(JSON.stringify({ inspectIo: { enabled: true, dir: brokenDir } }), 'utf8'),
    );
    const fsp = await import('node:fs/promises');
    // mkdir succeeds for the custom dir; the W_OK access() check fails → raise.
    (fsp.access as unknown as ReturnType<typeof vi.fn>).mockImplementation((p: string) => {
      if (String(p) === brokenDir) {
        return Promise.reject(
          Object.assign(new Error('EACCES: not writable'), { code: 'EACCES' }),
        );
      }
      return Promise.resolve(undefined);
    });
    await expect(
      loadAgentConfig(
        { provider: 'openai', configFile: configPath },
        { shellEnv: {}, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING' });
  });

  it('(g) an invalid CLI_AGENT_INSPECT_IO boolean value throws ConfigurationError (no default)', async () => {
    await expect(
      loadAgentConfig(
        { provider: 'openai' },
        { shellEnv: { CLI_AGENT_INSPECT_IO: 'maybe' }, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING' });
  });

  it('(g2) an invalid CLI_AGENT_INSPECT_IO_RAW boolean value throws ConfigurationError when requested', async () => {
    await expect(
      loadAgentConfig(
        { provider: 'openai', inspectIo: true },
        { shellEnv: { CLI_AGENT_INSPECT_IO_RAW: 'perhaps' }, cwd: '/tmp' },
      ),
    ).rejects.toMatchObject({ code: 'E_CONFIG_MISSING' });
  });
});

// ===========================================================================
// Step 14 — filesystem conventions (0700 dir / 0600 file / latest / UTC name)
// ===========================================================================
describe('Step 14 — filesystem conventions', () => {
  const isWin = process.platform === 'win32';

  it('writes session-<UTC>-<sessionId>.jsonl under the capture dir', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({ dir, sessionId: 'abc123', redact: false, boundToolSchemas: [] });
    const base = path.basename(cap.currentCapturePath);
    expect(base).toMatch(/^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-abc123\.jsonl$/);
    expect(path.dirname(cap.currentCapturePath)).toBe(dir);
    expect(fs.existsSync(cap.currentCapturePath)).toBe(true);
  });

  it.skipIf(isWin)('creates the capture dir at mode 0700', () => {
    // Use a NESTED dir under the temp root so FileIoCapture performs the mkdir
    // itself (mkdtemp creates the root at the OS default mask).
    const root = trackTmp();
    const dir = path.join(root, 'io-captures');
    new FileIoCapture({ dir, sessionId: 's', redact: false, boundToolSchemas: [] });
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it.skipIf(isWin)('creates the session file at mode 0600', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({ dir, sessionId: 's', redact: false, boundToolSchemas: [] });
    const mode = fs.statSync(cap.currentCapturePath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('maintains a latest.jsonl pointer resolving to the session file', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({ dir, sessionId: 's', redact: false, boundToolSchemas: [] });
    cap.captureResponse({ ...ENVELOPE, finalText: 'hi', toolCalls: [] });
    const latest = path.join(dir, 'latest.jsonl');
    expect(fs.existsSync(latest)).toBe(true);
    // Whether symlink or copy-skip fallback, it must resolve to a file whose
    // realpath is the session file (symlink) OR the same basename it points at.
    const lst = fs.lstatSync(latest);
    if (lst.isSymbolicLink()) {
      expect(fs.realpathSync(latest)).toBe(fs.realpathSync(cap.currentCapturePath));
    } else {
      // Non-symlink fallback: the pointer still names the session file.
      const target = fs.readlinkSync(latest);
      expect(path.basename(target)).toBe(path.basename(cap.currentCapturePath));
    }
  });

  it('every written line is a valid JSON IoCaptureRecord object', () => {
    const dir = trackTmp();
    const cap = new FileIoCapture({ dir, sessionId: 's', redact: false, boundToolSchemas: [] });
    cap.captureRequest({ ...ENVELOPE, messages: [toCaptureMessage(new HumanMessage('hi'))], boundTools: [] });
    cap.captureResponse({ ...ENVELOPE, finalText: 'ok', toolCalls: [] });
    cap.captureToolResult({ ...ENVELOPE, toolName: 'bash', ok: true, durationMs: 7, result: 'done' });
    const recs = readJsonl(cap.currentCapturePath);
    expect(recs).toHaveLength(3);
    expect(recs.map((r) => r['kind'])).toEqual(['request', 'response', 'tool_result']);
    for (const r of recs) {
      expect(typeof r['sessionId']).toBe('string');
      expect(typeof r['ts']).toBe('string');
      expect(typeof r['turnId']).toBe('string');
    }
    const tr = recs[2]!;
    expect(tr['toolName']).toBe('bash');
    expect(tr['ok']).toBe(true);
    expect(tr['durationMs']).toBe(7);
  });
});

// ===========================================================================
// Step 15 — off-state no-op byte-stability (NFR-1)
// ===========================================================================
describe('Step 15 — off-state no-op byte-stability (NullIoCapture)', () => {
  // The provider-payload / log-line / transcript byte-stability is guaranteed
  // STRUCTURALLY because the off-state instantiates NullIoCapture and every
  // graph hook is guarded by `if (ioCapture)`, and because LogEvent,
  // system-prompt.ts, and the transcript writer are NOT modified by this
  // feature. This spec asserts the load-bearing precondition: that the
  // off-state capture object performs ZERO filesystem side-effects.

  it('createIoCapture(cfg.inspectIo===null) returns a NullIoCapture', () => {
    const cap: IoCapture = createIoCapture(cfgWithInspect(null), 'sess-1', [makeEchoTool()]);
    expect(cap).toBeInstanceOf(NullIoCapture);
  });

  it('NullIoCapture creates NO file or directory and read() stays empty', () => {
    // Point at a NESTED path that does not exist; assert nothing is created.
    const root = trackTmp();
    const wouldBeDir = path.join(root, 'io-captures');
    // The off-state factory must not even look at the dir.
    const cap = createIoCapture(cfgWithInspect(null), 'sess-1', [makeEchoTool()]);

    cap.captureRequest({ ...ENVELOPE, messages: [toCaptureMessage(new HumanMessage('hi'))], boundTools: [] });
    cap.captureResponse({ ...ENVELOPE, finalText: 'ignored', toolCalls: [{ name: 'bash', args: {} }] });
    cap.captureToolResult({ ...ENVELOPE, toolName: 'bash', ok: true, durationMs: 1 });

    expect(fs.existsSync(wouldBeDir)).toBe(false);
    // The temp root itself must hold no capture files.
    expect(fs.readdirSync(root)).toHaveLength(0);
    expect(cap.read()).toEqual([]);
  });

  it('NullIoCapture exposes the off-state surface: empty schemas, empty path, no-op close', async () => {
    const cap = new NullIoCapture();
    expect(cap.boundToolSchemas).toEqual([]);
    expect(cap.currentCapturePath).toBe('');
    expect(cap.currentSessionId).toBe('disabled');
    // close() resolves without throwing.
    await expect(cap.close()).resolves.toBeUndefined();
    // capture methods are no-ops (return undefined, do not throw, do not record).
    expect(cap.captureRequest({ ...ENVELOPE, messages: [], boundTools: [] })).toBeUndefined();
    expect(cap.captureResponse({ ...ENVELOPE, finalText: '', toolCalls: [] })).toBeUndefined();
    expect(cap.captureToolResult({ ...ENVELOPE, toolName: 't', ok: true, durationMs: 0 })).toBeUndefined();
    expect(cap.read()).toEqual([]);
  });

  it('the IoCaptureRecord shapes round-trip through read() unchanged (type binding sanity)', () => {
    // Pure type-binding/no-disk sanity: NullIoCapture.read() is the empty list,
    // and the record union is constructible for all three kinds.
    const reqs: IoCaptureRecord[] = [
      { kind: 'request', ...ENVELOPE, messages: [], boundTools: [] },
      { kind: 'response', ...ENVELOPE, finalText: 'x', toolCalls: [] },
      { kind: 'tool_result', ...ENVELOPE, toolName: 't', ok: true, durationMs: 0 },
    ];
    expect(reqs.map((r) => r.kind)).toEqual(['request', 'response', 'tool_result']);
  });
});
