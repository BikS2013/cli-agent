/**
 * Checkpoint snapshot round-trip tests.
 *
 * Strategy: drive a real MemorySaver through put + putWrites with the same
 * RunnableConfig shape that LangGraph uses, snapshot it via saveCheckpoint,
 * load it into a fresh saver via loadCheckpoint, and assert the byte-level
 * state matches.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import {
  saveCheckpoint,
  loadCheckpoint,
  hasCheckpoint,
  checkpointFilePath,
  SNAPSHOT_VERSION,
} from './checkpoint-store.js';

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-ckpt-'));
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

function makeCheckpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: '2026-05-02T10:00:00Z',
    channel_values: { messages: ['hello'] },
    channel_versions: { messages: 1 },
    versions_seen: {},
  } as unknown as Checkpoint;
}

const META: CheckpointMetadata = { source: 'input', step: 0, parents: {} };

describe('checkpoint-store', () => {
  it('hasCheckpoint returns false when no snapshot exists', async () => {
    expect(await hasCheckpoint('missing-thread')).toBe(false);
  });

  it('saveCheckpoint is a no-op when the saver has no entries for the thread', async () => {
    const saver = new MemorySaver();
    await saveCheckpoint('absent', saver);
    expect(await hasCheckpoint('absent')).toBe(false);
  });

  it('round-trips a populated MemorySaver through save + load', async () => {
    const tid = 'thread-aaa';
    const src = new MemorySaver();
    const cfg = { configurable: { thread_id: tid, checkpoint_ns: '' } };
    await src.put(cfg, makeCheckpoint('cp-1'), META);
    await src.put(cfg, makeCheckpoint('cp-2'), META);

    // Add a pending write (LangGraph uses these for in-flight tool results).
    await src.putWrites(
      { configurable: { thread_id: tid, checkpoint_ns: '', checkpoint_id: 'cp-2' } },
      [['tool_outputs', 'fake-tool-result-payload']],
      'task-x',
    );

    await saveCheckpoint(tid, src);

    // Snapshot file is on disk under the temp HOME.
    const file = checkpointFilePath(tid);
    const raw = await fsp.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as { version: number; threadId: string; checkpointerKind: string };
    expect(parsed.version).toBe(SNAPSHOT_VERSION);
    expect(parsed.threadId).toBe(tid);
    expect(parsed.checkpointerKind).toBe('MemorySaver');

    // Hydrate a fresh saver and assert structural equality.
    const dst = new MemorySaver();
    const ok = await loadCheckpoint(tid, dst);
    expect(ok).toBe(true);
    expect(Object.keys(dst.storage[tid] ?? {})).toEqual(Object.keys(src.storage[tid] ?? {}));
    const srcNs = src.storage[tid]?.[''] ?? {};
    const dstNs = dst.storage[tid]?.[''] ?? {};
    expect(Object.keys(dstNs).sort()).toEqual(Object.keys(srcNs).sort());
    for (const cpId of Object.keys(srcNs)) {
      const s = srcNs[cpId]!;
      const d = dstNs[cpId]!;
      expect(Buffer.from(d[0]).equals(Buffer.from(s[0]))).toBe(true);
      expect(Buffer.from(d[1]).equals(Buffer.from(s[1]))).toBe(true);
      expect(d[2]).toEqual(s[2]);
    }
    // Pending writes survive too.
    expect(Object.keys(dst.writes).length).toBeGreaterThan(0);
  });

  it('loadCheckpoint returns false when no snapshot file exists', async () => {
    const saver = new MemorySaver();
    expect(await loadCheckpoint('nope', saver)).toBe(false);
  });

  it('loadCheckpoint throws on schema-version mismatch', async () => {
    const tid = 'thread-bbb';
    const file = checkpointFilePath(tid);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({
      version: 999, threadId: tid, savedAt: '', checkpointerKind: 'MemorySaver',
      storage: {}, writes: {},
    }));
    const saver = new MemorySaver();
    await expect(loadCheckpoint(tid, saver)).rejects.toThrow(/version 999/);
  });

  it('loadCheckpoint throws on threadId mismatch', async () => {
    const tid = 'thread-ccc';
    const file = checkpointFilePath(tid);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({
      version: SNAPSHOT_VERSION, threadId: 'someone-else', savedAt: '',
      checkpointerKind: 'MemorySaver', storage: {}, writes: {},
    }));
    const saver = new MemorySaver();
    await expect(loadCheckpoint(tid, saver)).rejects.toThrow(/threadId/);
  });
});
