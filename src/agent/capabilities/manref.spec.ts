/**
 * Tests for the manref detector. The pure-function `parseSection` is
 * exercised directly; `detectManRef` is exercised via a `spawnCommand`
 * spy so we never depend on the host actually having `man` installed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseSection, detectManRef } from './manref.js';
import * as exec from '../tools/bash/exec.js';

describe('parseSection', () => {
  it('parses uncompressed man-page paths (macOS/BSD shape)', () => {
    expect(parseSection('/usr/share/man/man1/git.1')).toBe('1');
    expect(parseSection('/usr/share/man/man3/printf.3')).toBe('3');
  });

  it('parses gzip-compressed paths (typical Linux shape)', () => {
    expect(parseSection('/usr/share/man/man1/git.1.gz')).toBe('1');
    expect(parseSection('/usr/share/man/man8/cron.8.gz')).toBe('8');
  });

  it('parses other common compression suffixes', () => {
    expect(parseSection('/x/foo.1.bz2')).toBe('1');
    expect(parseSection('/x/foo.1.xz')).toBe('1');
    expect(parseSection('/x/foo.1.zst')).toBe('1');
  });

  it('keeps section letters (e.g. 3perl, 1p)', () => {
    expect(parseSection('/usr/share/man/man3/Foo.3perl.gz')).toBe('3perl');
    expect(parseSection('/usr/share/man/man1/printf.1p')).toBe('1p');
  });

  it('returns null when filename has no section component', () => {
    expect(parseSection('/usr/share/man/man1/no-section')).toBeNull();
    expect(parseSection('plain-name')).toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parseSection('')).toBeNull();
  });
});

describe('detectManRef', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the canonical pointer when man -w succeeds', async () => {
    vi.spyOn(exec, 'spawnCommand').mockResolvedValueOnce({
      command: 'man',
      args: ['-w', 'git'],
      stdout: '/usr/share/man/man1/git.1.gz\n',
      stderr: '',
      exitCode: 0,
      durationMs: 10,
    });
    const result = await detectManRef('git', 5000);
    expect(result.manRef).toBe('man:1 git');
    expect(result.manPagePath).toBe('/usr/share/man/man1/git.1.gz');
  });

  it('takes the first path when man -w prints multiple lines', async () => {
    // git, like many shells, has both an admin-page (1) and a user-page
    // (1) pointed at by the same name on some distros. Whichever `man`
    // prints first wins; second/third entries are ignored.
    vi.spyOn(exec, 'spawnCommand').mockResolvedValueOnce({
      command: 'man',
      args: ['-w', 'git'],
      stdout: '/usr/share/man/man1/git.1.gz\n/usr/share/man/man7/gitcli.7.gz\n',
      stderr: '',
      exitCode: 0,
      durationMs: 8,
    });
    const result = await detectManRef('git', 5000);
    expect(result.manRef).toBe('man:1 git');
  });

  it('returns null result when man exits non-zero', async () => {
    vi.spyOn(exec, 'spawnCommand').mockResolvedValueOnce({
      command: 'man',
      args: ['-w', 'no-such-binary-xyz'],
      stdout: '',
      stderr: 'No manual entry for no-such-binary-xyz\n',
      exitCode: 1,
      durationMs: 5,
    });
    const result = await detectManRef('no-such-binary-xyz', 5000);
    expect(result.manRef).toBeNull();
    expect(result.manPagePath).toBeNull();
  });

  it('returns null result when stdout is empty even on exit 0', async () => {
    vi.spyOn(exec, 'spawnCommand').mockResolvedValueOnce({
      command: 'man',
      args: ['-w', 'foo'],
      stdout: '',
      stderr: '',
      exitCode: 0,
      durationMs: 3,
    });
    const result = await detectManRef('foo', 5000);
    expect(result.manRef).toBeNull();
  });

  it('returns null when the path has no parseable section', async () => {
    vi.spyOn(exec, 'spawnCommand').mockResolvedValueOnce({
      command: 'man',
      args: ['-w', 'foo'],
      stdout: '/something/weird/no-section\n',
      stderr: '',
      exitCode: 0,
      durationMs: 3,
    });
    const result = await detectManRef('foo', 5000);
    expect(result.manRef).toBeNull();
  });

  it('returns null on spawn error (man not installed) without throwing', async () => {
    vi.spyOn(exec, 'spawnCommand').mockRejectedValueOnce(new Error('ENOENT'));
    const result = await detectManRef('git', 5000);
    expect(result.manRef).toBeNull();
    expect(result.manPagePath).toBeNull();
  });

  it('rejects suspicious binary names without spawning', async () => {
    const spy = vi.spyOn(exec, 'spawnCommand');
    const result = await detectManRef('git; rm -rf /', 5000);
    expect(result.manRef).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects empty binary name without spawning', async () => {
    const spy = vi.spyOn(exec, 'spawnCommand');
    const result = await detectManRef('', 5000);
    expect(result.manRef).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});
