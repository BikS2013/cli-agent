/**
 * Clipboard dispatch tests — mock the bash/exec.ts spawnCommand and assert
 * the right binary is invoked per process.platform.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';

vi.mock('../agent/tools/bash/exec.js', () => ({
  spawnCommand: vi.fn(),
}));

import { spawnCommand } from '../agent/tools/bash/exec.js';
import { copyToClipboard, pickPlatformBinary } from './clipboard.js';

describe('pickPlatformBinary', () => {
  it('returns pbcopy on darwin', () => {
    const orig = os.platform;
    (os as unknown as { platform: () => NodeJS.Platform }).platform = () => 'darwin';
    try {
      expect(pickPlatformBinary().command).toBe('pbcopy');
    } finally {
      (os as unknown as { platform: typeof orig }).platform = orig;
    }
  });
  it('returns clip.exe on win32', () => {
    const orig = os.platform;
    (os as unknown as { platform: () => NodeJS.Platform }).platform = () => 'win32';
    try {
      expect(pickPlatformBinary().command).toBe('clip.exe');
    } finally {
      (os as unknown as { platform: typeof orig }).platform = orig;
    }
  });
  it('returns xclip on linux (non-WSL)', () => {
    const platOrig = os.platform;
    const relOrig = os.release;
    (os as unknown as { platform: () => NodeJS.Platform }).platform = () => 'linux';
    (os as unknown as { release: () => string }).release = () => '6.6.0-arch1-1';
    try {
      expect(pickPlatformBinary().command).toBe('xclip');
    } finally {
      (os as unknown as { platform: typeof platOrig }).platform = platOrig;
      (os as unknown as { release: typeof relOrig }).release = relOrig;
    }
  });
});

describe('copyToClipboard', () => {
  beforeEach(() => {
    vi.mocked(spawnCommand).mockReset();
  });

  it('returns ok when spawnCommand exits 0', async () => {
    vi.mocked(spawnCommand).mockResolvedValue({
      command: 'pbcopy',
      args: [],
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 5,
    });
    const orig = os.platform;
    (os as unknown as { platform: () => NodeJS.Platform }).platform = () => 'darwin';
    try {
      const r = await copyToClipboard('hello');
      expect(r.ok).toBe(true);
      expect(r.binary).toBe('pbcopy');
    } finally {
      (os as unknown as { platform: typeof orig }).platform = orig;
    }
    expect(spawnCommand).toHaveBeenCalledWith(expect.objectContaining({ command: 'pbcopy', stdin: 'hello' }));
  });

  it('returns failure message when spawnCommand exits non-zero', async () => {
    vi.mocked(spawnCommand).mockResolvedValue({
      command: 'pbcopy',
      args: [],
      stdout: '',
      stderr: 'oops',
      exitCode: 1,
      durationMs: 5,
    });
    const orig = os.platform;
    (os as unknown as { platform: () => NodeJS.Platform }).platform = () => 'darwin';
    try {
      const r = await copyToClipboard('hello');
      expect(r.ok).toBe(false);
      expect(r.message).toContain('oops');
    } finally {
      (os as unknown as { platform: typeof orig }).platform = orig;
    }
  });
});
