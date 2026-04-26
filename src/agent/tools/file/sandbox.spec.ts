import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import { resolveSandboxPath } from './sandbox.js';

// Mock realpathSync to avoid real filesystem
vi.spyOn(fs, 'realpathSync').mockImplementation((p: fs.PathLike) => String(p));

describe('resolveSandboxPath', () => {
  it('allows absolute paths inside root', () => {
    const resolved = resolveSandboxPath('/tmp/myroot/file.txt', { root: '/tmp/myroot' });
    expect(resolved).toBe('/tmp/myroot/file.txt');
  });

  it('allows relative paths resolved inside root', () => {
    const resolved = resolveSandboxPath('file.txt', { root: '/tmp/myroot' });
    expect(resolved).toBe('/tmp/myroot/file.txt');
  });

  it('throws E_FILE_PATH_OUTSIDE_ROOT for paths outside root', () => {
    expect(() =>
      resolveSandboxPath('/etc/passwd', { root: '/tmp/myroot' }),
    ).toThrowError(/outside the allowed root/);
  });

  it('throws for path traversal attempts', () => {
    expect(() =>
      resolveSandboxPath('../../../etc/passwd', { root: '/tmp/myroot' }),
    ).toThrowError(/outside the allowed root/);
  });

  it('allows paths in explicit allowPaths', () => {
    const resolved = resolveSandboxPath('/allowed/special.txt', {
      root: '/tmp/myroot',
      allowPaths: ['/allowed'],
    });
    expect(resolved).toBe('/allowed/special.txt');
  });
});
