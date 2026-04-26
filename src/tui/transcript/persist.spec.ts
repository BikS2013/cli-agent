/**
 * History persistence tests — write-then-read via the same module.
 *
 * Uses a temp directory by overriding the HOME env var so the agentToolAgentsDir
 * helper resolves to an isolated location.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  appendTurn,
  threadFilePath,
  upsertIndexEntry,
  readIndex,
  writeCursor,
  readCursor,
  ensureHistoryDir,
  historyDir,
} from './persist.js';
import type { TurnRecord, ThreadIndexEntry } from './types.js';

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-tui-'));
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

describe('history persistence', () => {
  it('appendTurn creates a JSONL file with mode 0600', async () => {
    const tid = '11111111-2222-3333-4444-555555555555';
    const file = threadFilePath(tid, new Date('2026-04-26T12:00:00Z'));
    const turn: TurnRecord = {
      ts: '2026-04-26T12:00:01Z',
      threadId: tid,
      turnId: 'turn-a',
      role: 'user',
      content: 'hello',
    };
    await appendTurn(file, turn);
    const stat = fs.statSync(file);
    expect(stat.isFile()).toBe(true);
    if (process.platform !== 'win32') {
      expect(stat.mode & 0o777).toBe(0o600);
    }
    const raw = await fsp.readFile(file, 'utf8');
    expect(raw.trim()).toBe(JSON.stringify(turn));
  });

  it('appendTurn appends to an existing file', async () => {
    const tid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const file = threadFilePath(tid, new Date('2026-04-26T12:00:00Z'));
    const t1: TurnRecord = { ts: 'x1', threadId: tid, turnId: 'a', role: 'user', content: '1' };
    const t2: TurnRecord = { ts: 'x2', threadId: tid, turnId: 'b', role: 'assistant', content: '2' };
    await appendTurn(file, t1);
    await appendTurn(file, t2);
    const lines = (await fsp.readFile(file, 'utf8')).trim().split('\n');
    expect(lines.length).toBe(2);
  });

  it('upsertIndexEntry inserts then replaces atomically', async () => {
    const e1: ThreadIndexEntry = { threadId: 't1', startedAt: 'a', lastTurnAt: 'b', turnCount: 1, firstPrompt: 'p1' };
    const e2: ThreadIndexEntry = { threadId: 't2', startedAt: 'c', lastTurnAt: 'd', turnCount: 2, firstPrompt: 'p2' };
    await upsertIndexEntry(e1);
    await upsertIndexEntry(e2);
    let entries = await readIndex();
    expect(entries.length).toBe(2);
    // Replace t1
    await upsertIndexEntry({ ...e1, turnCount: 5 });
    entries = await readIndex();
    expect(entries.length).toBe(2);
    expect(entries.find((e) => e.threadId === 't1')!.turnCount).toBe(5);
  });

  it('writeCursor + readCursor round-trip', async () => {
    await writeCursor({ lastThreadId: 'abc', lastTurnAt: '2026-04-26T12:00:00Z' });
    const c = await readCursor();
    expect(c).toEqual({ lastThreadId: 'abc', lastTurnAt: '2026-04-26T12:00:00Z' });
  });

  it('ensureHistoryDir creates the directory under ~/.tool-agents/cli-agent/history', async () => {
    await ensureHistoryDir();
    const expected = path.join(tmpHome, '.tool-agents', 'cli-agent', 'history');
    expect(historyDir()).toBe(expected);
    const stat = fs.statSync(expected);
    expect(stat.isDirectory()).toBe(true);
  });
});
