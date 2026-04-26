/**
 * Smoke test: drive streamOneShot with a fake graph and assert that
 * llm_chunk and llm_final log events are emitted.
 *
 * Run with: npx tsx test_scripts/smoke-streaming-llm-events.ts
 */

import { streamOneShot } from '../src/agent/graph.js';
import type { Logger, LogEvent } from '../src/agent/logging.js';

const captured: LogEvent[] = [];
const fakeLogger: Logger = {
  currentLogPath: '/dev/null',
  currentSessionId: 'smoke-1',
  log: (e: LogEvent) => captured.push(e),
  flush: async () => {},
  close: async () => {},
};

// Fake LangChain v2 stream: yields a few token chunks, then on_chat_model_end.
async function* fakeStream(): AsyncIterable<{ event: string; name?: string; data?: { chunk?: { content?: unknown }; output?: unknown; input?: unknown } }> {
  yield { event: 'on_chat_model_stream', data: { chunk: { content: 'Hello, ' } } };
  yield { event: 'on_chat_model_stream', data: { chunk: { content: 'world!' } } };
  yield { event: 'on_chat_model_end', data: {} };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fakeGraph: any = {
  graph: {
    streamEvents: () => fakeStream(),
  },
  checkpointer: {},
};

(async (): Promise<void> => {
  const it = streamOneShot(fakeGraph, 'hi', 'thread-x', 5, { logger: fakeLogger, sessionId: 'smoke-1' });
  let final = '';
  while (true) {
    const next = await it.next();
    if (next.done) {
      final = next.value ?? final;
      break;
    }
    if (next.value.kind === 'token') process.stdout.write(`[token] "${next.value.text}"\n`);
  }
  console.log(`[final] "${final}"`);

  const chunkEvents = captured.filter((e) => e.kind === 'llm_chunk');
  const finalEvents = captured.filter((e) => e.kind === 'llm_final');
  console.log(`captured ${chunkEvents.length} llm_chunk and ${finalEvents.length} llm_final events`);
  if (chunkEvents.length === 0) {
    console.error('FAIL: expected llm_chunk events');
    process.exit(1);
  }
  if (finalEvents.length === 0) {
    console.error('FAIL: expected llm_final event');
    process.exit(1);
  }
  if (final !== 'Hello, world!') {
    console.error(`FAIL: expected final="Hello, world!", got "${final}"`);
    process.exit(1);
  }
  console.log('PASS');
})();
