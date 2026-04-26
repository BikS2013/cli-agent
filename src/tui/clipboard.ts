/**
 * Cross-platform clipboard copy for the TUI.
 *
 * Per project invariants the TUI uses `bash/exec.ts` (the `execFile`-only spawn
 * helper) instead of a parallel child_process path. The internal allowlist here
 * is hard-coded and INDEPENDENT of the user-controlled `bash.allow` — it only
 * accepts `pbcopy`, `xclip`, `xsel`, and `clip.exe` (with WSL absolute-path
 * fallback). Per spec §13: never silent-fail; surface an error string.
 */

import os from 'node:os';
import path from 'node:path';
import { spawnCommand } from '../agent/tools/bash/exec.js';

interface PlatformBinary {
  command: string;
  args: string[];
}

/** Internal allowlist; not user-extensible. */
const ALLOWED: Record<string, true> = {
  pbcopy: true,
  xclip: true,
  xsel: true,
  'clip.exe': true,
  '/mnt/c/Windows/System32/clip.exe': true,
};

export function pickPlatformBinary(): PlatformBinary {
  const platform = os.platform();
  if (platform === 'darwin') {
    return { command: 'pbcopy', args: [] };
  }
  if (platform === 'win32') {
    return { command: 'clip.exe', args: [] };
  }
  // Linux and others — prefer xclip; xsel is a fallback the caller can try.
  // If running under WSL, fall back to clip.exe path on /mnt/c.
  if (platform === 'linux') {
    const isWsl = (() => {
      try {
        const release = os.release().toLowerCase();
        return release.includes('microsoft') || release.includes('wsl');
      } catch {
        return false;
      }
    })();
    if (isWsl) {
      return { command: '/mnt/c/Windows/System32/clip.exe', args: [] };
    }
    return { command: 'xclip', args: ['-selection', 'clipboard'] };
  }
  // Unsupported platforms — caller will handle the rejection.
  return { command: 'xsel', args: ['--clipboard', '--input'] };
}

export interface CopyResult {
  ok: boolean;
  binary: string;
  message?: string;
}

/**
 * Copy `text` to the system clipboard. On binary-not-found, returns
 * `{ ok: false, message }` rather than throwing — the TUI surfaces the
 * message via printSystem.
 */
export async function copyToClipboard(text: string): Promise<CopyResult> {
  const primary = pickPlatformBinary();
  const tried: string[] = [];

  const tryOne = async (bin: PlatformBinary): Promise<CopyResult> => {
    const cmd = bin.command;
    const baseName = path.basename(cmd);
    if (!ALLOWED[cmd] && !ALLOWED[baseName]) {
      return { ok: false, binary: cmd, message: `clipboard binary '${cmd}' not on TUI allowlist` };
    }
    tried.push(cmd);
    try {
      const result = await spawnCommand({
        command: cmd,
        args: bin.args,
        stdin: text,
        timeoutMs: 5000,
        maxOutputBytes: 65536,
        passEnv: ['PATH', 'HOME', 'LANG', 'TERM', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY'],
      });
      if (result.exitCode === 0) {
        return { ok: true, binary: cmd };
      }
      return { ok: false, binary: cmd, message: `'${cmd}' exited ${result.exitCode}: ${result.stderr.trim()}` };
    } catch (e) {
      return { ok: false, binary: cmd, message: e instanceof Error ? e.message : String(e) };
    }
  };

  const first = await tryOne(primary);
  if (first.ok) return first;

  // Linux fallback: try xsel if xclip failed
  if (os.platform() === 'linux' && primary.command === 'xclip') {
    const fb = await tryOne({ command: 'xsel', args: ['--clipboard', '--input'] });
    if (fb.ok) return fb;
    return { ok: false, binary: tried.join(','), message: `clipboard not available on this platform (tried ${tried.join(', ')})` };
  }

  return { ok: false, binary: primary.command, message: `clipboard not available on this platform (tried ${tried.join(', ')}): ${first.message ?? 'unknown'}` };
}
