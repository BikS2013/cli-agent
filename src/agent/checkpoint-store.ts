/**
 * JSON-snapshot persistence for LangGraph's MemorySaver.
 *
 * Layout:
 *   ~/.tool-agents/cli-agent/history/
 *     checkpoint-<threadId>.json   mode 0600
 *
 * Why this exists: MemorySaver keeps state in-process. Without this module,
 * `cli-agent` loses every LLM-side conversation as soon as the process
 * exits. This module captures the saver's `storage` and `writes` fields
 * — both already serialized by langgraph's internal JsonPlusSerializer —
 * encodes the Uint8Array blobs as base64, and writes one snapshot file per
 * thread. On `--resume`, we read the snapshot and re-populate a fresh
 * MemorySaver before the agent graph is constructed.
 *
 * Design rationale: see docs/design/plan-005-tui-exit-and-resume.md.
 *
 * No fallbacks: schema-version mismatch or malformed JSON throws. Callers
 * are expected to surface the error to the user (UsageError exit code 2).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { MemorySaver } from '@langchain/langgraph';
import { historyDir, ensureHistoryDir } from '../tui/transcript/persist.js';

export const SNAPSHOT_VERSION = 1;

/**
 * Serialised storage entry: [serialisedCheckpoint, serialisedMetadata, parentCheckpointId|null].
 * Leaves of MemorySaver.storage are tuples of two Uint8Arrays plus an
 * optional parent id; we encode the byte arrays as base64 strings.
 */
type StorageEntry = readonly [string, string, string | null];

/** Serialised writes entry: [taskId, channel, serialisedValue]. */
type WritesEntry = readonly [string, string, string];

/** Snapshot schema (version 1). */
export interface CheckpointSnapshot {
  readonly version: 1;
  readonly threadId: string;
  readonly savedAt: string;
  readonly checkpointerKind: 'MemorySaver';
  /** storage[threadId][checkpoint_ns][checkpoint_id] = StorageEntry */
  readonly storage: Record<string, Record<string, Record<string, StorageEntry>>>;
  /** writes[outerKey][innerKey] = WritesEntry; outerKey = JSON.stringify([threadId, ns, checkpointId]) */
  readonly writes: Record<string, Record<string, WritesEntry>>;
}

export function checkpointFilePath(threadId: string): string {
  return path.join(historyDir(), `checkpoint-${threadId}.json`);
}

/**
 * Snapshot the MemorySaver state for a single thread to disk.
 *
 * Atomic write: tmp file + rename. Mode 0600. The previous snapshot is
 * replaced wholesale — we always persist the latest in-memory state for
 * the thread, never an append-only log.
 *
 * No-op if the saver has no entries for `threadId` (e.g. a fresh thread
 * that hasn't yet completed a turn).
 */
export async function saveCheckpoint(threadId: string, saver: MemorySaver): Promise<void> {
  await ensureHistoryDir();

  const threadStorage = saver.storage[threadId];
  if (!threadStorage) return;

  // Filter writes by parsing each outer key (JSON-stringified [threadId, ns, checkpointId]).
  const filteredWrites: Record<string, Record<string, WritesEntry>> = {};
  for (const outerKey of Object.keys(saver.writes)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(outerKey);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed) || parsed[0] !== threadId) continue;
    const inner: Record<string, WritesEntry> = {};
    const innerSrc = saver.writes[outerKey] ?? {};
    for (const innerKey of Object.keys(innerSrc)) {
      const tuple = innerSrc[innerKey] as readonly [string, string, Uint8Array] | undefined;
      if (!tuple) continue;
      inner[innerKey] = [tuple[0], tuple[1], bytesToBase64(tuple[2])] as const;
    }
    filteredWrites[outerKey] = inner;
  }

  const snapshotStorage: Record<string, Record<string, Record<string, StorageEntry>>> = {};
  snapshotStorage[threadId] = {};
  for (const ns of Object.keys(threadStorage)) {
    const nsRecord = threadStorage[ns] ?? {};
    snapshotStorage[threadId][ns] = {};
    for (const cpId of Object.keys(nsRecord)) {
      const tuple = nsRecord[cpId];
      if (!tuple) continue;
      snapshotStorage[threadId][ns][cpId] = [
        bytesToBase64(tuple[0]),
        bytesToBase64(tuple[1]),
        tuple[2] ?? null,
      ] as const;
    }
  }

  const snapshot: CheckpointSnapshot = {
    version: SNAPSHOT_VERSION,
    threadId,
    savedAt: new Date().toISOString(),
    checkpointerKind: 'MemorySaver',
    storage: snapshotStorage,
    writes: filteredWrites,
  };

  const target = checkpointFilePath(threadId);
  const tmp = path.join(historyDir(), `.checkpoint-${threadId}.${process.pid}.${Date.now()}.tmp`);
  await fsp.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 });
  await fsp.rename(tmp, target);
  try { await fsp.chmod(target, 0o600); } catch { /* tolerated on Windows */ }
}

/**
 * Hydrate a fresh MemorySaver instance with the contents of a snapshot file.
 *
 * Returns true if a snapshot was loaded; false if no file exists for the
 * thread (caller can decide whether that's acceptable). Throws on schema
 * mismatch or malformed JSON — no silent fallback per project policy.
 */
export async function loadCheckpoint(threadId: string, saver: MemorySaver): Promise<boolean> {
  const file = checkpointFilePath(threadId);
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return false;
    throw e;
  }

  const parsed = JSON.parse(raw) as CheckpointSnapshot;
  if (parsed.version !== SNAPSHOT_VERSION) {
    throw new Error(
      `[checkpoint-store] snapshot ${file} has version ${parsed.version}; expected ${SNAPSHOT_VERSION}.`,
    );
  }
  if (parsed.checkpointerKind !== 'MemorySaver') {
    throw new Error(
      `[checkpoint-store] snapshot ${file} was produced for ${parsed.checkpointerKind}; only MemorySaver is supported.`,
    );
  }
  if (parsed.threadId !== threadId) {
    throw new Error(
      `[checkpoint-store] snapshot ${file} carries threadId ${parsed.threadId} but was loaded under ${threadId}.`,
    );
  }

  // Hydrate storage[threadId]
  saver.storage[threadId] ??= {};
  const tgtThread = saver.storage[threadId]!;
  const srcThread = parsed.storage[threadId] ?? {};
  for (const ns of Object.keys(srcThread)) {
    tgtThread[ns] ??= {};
    const tgtNs = tgtThread[ns]!;
    const srcNs = srcThread[ns] ?? {};
    for (const cpId of Object.keys(srcNs)) {
      const entry = srcNs[cpId];
      if (!entry) continue;
      tgtNs[cpId] = [
        base64ToBytes(entry[0]),
        base64ToBytes(entry[1]),
        entry[2] ?? undefined,
      ];
    }
  }

  // Hydrate writes (only those whose outer key references our threadId)
  for (const outerKey of Object.keys(parsed.writes)) {
    let parsedKey: unknown;
    try {
      parsedKey = JSON.parse(outerKey);
    } catch {
      continue;
    }
    if (!Array.isArray(parsedKey) || parsedKey[0] !== threadId) continue;
    saver.writes[outerKey] ??= {};
    const tgtInner = saver.writes[outerKey]!;
    const srcInner = parsed.writes[outerKey] ?? {};
    for (const innerKey of Object.keys(srcInner)) {
      const tuple = srcInner[innerKey];
      if (!tuple) continue;
      tgtInner[innerKey] = [tuple[0], tuple[1], base64ToBytes(tuple[2])];
    }
  }

  return true;
}

/** True if a snapshot file exists for the given thread. Read-only. */
export async function hasCheckpoint(threadId: string): Promise<boolean> {
  try {
    await fsp.access(checkpointFilePath(threadId));
    return true;
  } catch {
    return false;
  }
}

function bytesToBase64(b: Uint8Array): string {
  return Buffer.from(b).toString('base64');
}

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
