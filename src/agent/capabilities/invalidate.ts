/**
 * Cache invalidation logic.
 *
 * Cache hit iff:
 *   1. binaryPath matches current realpath of binary
 *   2. binaryMtimeMs matches current statSync().mtimeMs
 *   3. versionHash matches sha256 of current <tool> --version output
 */

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { spawnCommand } from '../tools/bash/exec.js';
import type { CacheFrontmatter } from './cache.js';

export interface BinaryInfo {
  resolvedPath: string;
  mtimeMs: number;
  versionString: string;
  versionHash: string;
}

export async function getBinaryInfo(binaryName: string, timeoutMs: number): Promise<BinaryInfo | null> {
  // Resolve binary on PATH
  const resolved = resolveBinary(binaryName);
  if (!resolved) return null;

  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(resolved).mtimeMs;
  } catch {
    return null;
  }

  // Get version string
  let versionString = '';
  try {
    const result = await spawnCommand({
      command: resolved,
      args: ['--version'],
      timeoutMs,
      maxOutputBytes: 4096,
      passEnv: ['PATH', 'HOME', 'LANG', 'TERM'],
    });
    versionString = (result.stdout + result.stderr).trim().slice(0, 512);
  } catch {
    versionString = '';
  }

  const versionHash = 'sha256:' + crypto
    .createHash('sha256')
    .update(versionString)
    .digest('hex');

  return { resolvedPath: resolved, mtimeMs, versionString, versionHash };
}

export function isCacheValid(fm: CacheFrontmatter, info: BinaryInfo): boolean {
  return (
    fm.binaryPath === info.resolvedPath &&
    Math.abs(fm.binaryMtimeMs - info.mtimeMs) < 1000 && // 1s tolerance
    fm.versionHash === info.versionHash
  );
}

function resolveBinary(name: string): string | null {
  if (path.isAbsolute(name)) {
    try { fs.accessSync(name, fs.constants.X_OK); return name; } catch { return null; }
  }
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate; } catch { /* next */ }
  }
  return null;
}
