/**
 * History persistence for the TUI.
 *
 * Layout (per the brief):
 *   ~/.tool-agents/cli-agent/history/      mode 0700
 *     thread-<UTC-iso>-<threadId>.jsonl   mode 0600 — one line per turn
 *     index.jsonl                          mode 0600 — one line per thread
 *     cursor.json                          mode 0600 — { lastThreadId, lastTurnAt }
 *
 * Per-turn JSONL only carries the user prompt and the assistant final text
 * (no chunks). Chunks live in ~/.tool-agents/cli-agent/logs/.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { agentToolAgentsDir } from '../../config/agent-config.js';
import type { TurnRecord, ThreadIndexEntry, CursorState } from './types.js';

export const HISTORY_DIRNAME = 'history';

export function historyDir(): string {
  return path.join(agentToolAgentsDir(), HISTORY_DIRNAME);
}

export function threadFilePath(threadId: string, startedAt: Date): string {
  const utc = formatUtc(startedAt);
  return path.join(historyDir(), `thread-${utc}-${threadId}.jsonl`);
}

export function indexFilePath(): string {
  return path.join(historyDir(), 'index.jsonl');
}

export function cursorFilePath(): string {
  return path.join(historyDir(), 'cursor.json');
}

function formatUtc(d: Date): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}-${pad(d.getUTCMinutes())}-${pad(d.getUTCSeconds())}`
  );
}

export async function ensureHistoryDir(): Promise<void> {
  const dir = historyDir();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(dir, 0o700); } catch { /* tolerated on Windows */ }
}

/**
 * Append a single turn to its thread file. Creates the file on first write.
 */
export async function appendTurn(filePath: string, turn: TurnRecord): Promise<void> {
  await ensureHistoryDir();
  // Ensure parent directory exists
  await fsp.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const line = JSON.stringify(turn) + '\n';
  // Open with O_APPEND, create if missing, mode 0600
  const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
  try {
    fs.writeSync(fd, line);
    try { fs.fchmodSync(fd, 0o600); } catch { /* tolerated */ }
  } finally {
    try { fs.closeSync(fd); } catch { /* tolerated */ }
  }
}

/**
 * Read all index entries (most-recent-last). Returns [] if the file is missing.
 */
export async function readIndex(): Promise<ThreadIndexEntry[]> {
  const file = indexFilePath();
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const out: ThreadIndexEntry[] = [];
    for (const l of lines) {
      try {
        out.push(JSON.parse(l) as ThreadIndexEntry);
      } catch { /* skip malformed line */ }
    }
    return out;
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * Update the index entry for a thread (insert if absent, replace if present).
 * Atomic: write tmp + rename. Mode 0600.
 */
export async function upsertIndexEntry(entry: ThreadIndexEntry): Promise<void> {
  await ensureHistoryDir();
  const existing = await readIndex();
  const filtered = existing.filter((e) => e.threadId !== entry.threadId);
  filtered.push(entry);
  const body = filtered.map((e) => JSON.stringify(e)).join('\n') + '\n';
  const target = indexFilePath();
  const tmp = path.join(historyDir(), `.index.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, body, { mode: 0o600 });
  await fsp.rename(tmp, target);
  try { await fsp.chmod(target, 0o600); } catch { /* tolerated */ }
}

/**
 * Read the cursor (last active thread). Returns null if missing.
 */
export async function readCursor(): Promise<CursorState | null> {
  try {
    const raw = await fsp.readFile(cursorFilePath(), 'utf8');
    return JSON.parse(raw) as CursorState;
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
}

/** Write the cursor file (mode 0600). */
export async function writeCursor(cursor: CursorState): Promise<void> {
  await ensureHistoryDir();
  const target = cursorFilePath();
  const tmp = path.join(historyDir(), `.cursor.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(cursor), { mode: 0o600 });
  await fsp.rename(tmp, target);
  try { await fsp.chmod(target, 0o600); } catch { /* tolerated */ }
}

/** Read all turns of a thread (used by /history selection). */
export async function readThreadTurns(filePath: string): Promise<TurnRecord[]> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const out: TurnRecord[] = [];
    for (const l of lines) {
      try { out.push(JSON.parse(l) as TurnRecord); } catch { /* skip */ }
    }
    return out;
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return [];
    throw e;
  }
}

/** Returns the absolute path that `thread-*` files for `threadId` would use, if findable. */
export async function findThreadFile(threadId: string): Promise<string | null> {
  await ensureHistoryDir();
  let entries: string[];
  try {
    entries = await fsp.readdir(historyDir());
  } catch {
    return null;
  }
  const match = entries.find((e) => e.endsWith(`-${threadId}.jsonl`) && e.startsWith('thread-'));
  return match ? path.join(historyDir(), match) : null;
}

/** Convenience helper unused outside tests / debugging. */
export function _testHomeOverride(): string {
  return os.homedir();
}
