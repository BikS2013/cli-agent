/**
 * Tests for the tool-prompt overlay loader + parser.
 *
 * Coverage:
 *   - parseOverlayFile: round-trip via serializeOverlay; malformed inputs
 *     (missing H1, missing description, duplicate param); trim semantics.
 *   - loadOverlayRegistry: empty dir, malformed file (with file path in
 *     the error), filename-vs-H1 mismatch.
 *   - getToolDescription / getParamDescription: with overlay, without
 *     overlay, with overlay missing the requested param.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  parseOverlayFile,
  serializeOverlay,
  loadOverlayRegistry,
  getToolDescription,
  getParamDescription,
} from './tool-prompt-overlay.js';
import { ConfigurationError } from '../../errors.js';

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-overlay-'));
});
afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

describe('parseOverlayFile', () => {
  it('round-trips serializeOverlay output', () => {
    const builtin = {
      description: 'Hello world.\n\nSecond paragraph.',
      parameters: {
        path: 'A path.',
        glob: 'A glob.',
      },
    };
    const md = serializeOverlay('file_list', builtin);
    const parsed = parseOverlayFile('/tmp/file_list.md', md);
    expect(parsed.tool).toBe('file_list');
    expect(parsed.description).toBe(builtin.description);
    expect(parsed.parameters.get('path')).toBe('A path.');
    expect(parsed.parameters.get('glob')).toBe('A glob.');
    expect(parsed.source).toBe('/tmp/file_list.md');
  });

  it('parses overlay with no parameters section', () => {
    const md = '# bash_list_allowed\n\n## Description\n\nList allowed bash commands.\n';
    const parsed = parseOverlayFile('/tmp/bash_list_allowed.md', md);
    expect(parsed.tool).toBe('bash_list_allowed');
    expect(parsed.description).toBe('List allowed bash commands.');
    expect(parsed.parameters.size).toBe(0);
  });

  it('throws ConfigurationError on missing H1', () => {
    const md = '## Description\n\nbody\n';
    expect(() => parseOverlayFile('/tmp/x.md', md))
      .toThrow(ConfigurationError);
  });

  function captureDetail(fn: () => unknown): string {
    let caught: unknown;
    try { fn(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ConfigurationError);
    const detail = (caught as { details?: { detail?: string } }).details?.detail ?? '';
    return detail;
  }

  it('throws ConfigurationError on missing Description section', () => {
    const md = '# file_read\n\n## Parameters\n\n### path\n\nA path.\n';
    const detail = captureDetail(() => parseOverlayFile('/tmp/file_read.md', md));
    expect(detail).toMatch(/Missing "## Description"/);
  });

  it('throws ConfigurationError on empty Description body', () => {
    const md = '# file_read\n\n## Description\n\n\n## Parameters\n\n### path\n\nA path.\n';
    const detail = captureDetail(() => parseOverlayFile('/tmp/file_read.md', md));
    expect(detail).toMatch(/empty/i);
  });

  it('throws ConfigurationError on duplicate parameter names', () => {
    const md = [
      '# file_read',
      '',
      '## Description',
      '',
      'Read a file.',
      '',
      '## Parameters',
      '',
      '### path',
      '',
      'First.',
      '',
      '### path',
      '',
      'Second.',
      '',
    ].join('\n');
    const detail = captureDetail(() => parseOverlayFile('/tmp/file_read.md', md));
    expect(detail).toMatch(/Duplicate parameter/);
  });

  it('trims trailing whitespace per body but preserves internal whitespace', () => {
    const md = [
      '# file_read',
      '',
      '## Description',
      '',
      'line1',
      '',
      'line2  ',
      '   ',
      '',
      '## Parameters',
      '',
      '### path',
      '',
      'A path.    ',
      '',
    ].join('\n');
    const parsed = parseOverlayFile('/tmp/file_read.md', md);
    expect(parsed.description).toBe('line1\n\nline2');
    expect(parsed.parameters.get('path')).toBe('A path.');
  });

  it('includes the file path in the ConfigurationError message', () => {
    const md = '## Description\n\nbody\n';
    let caught: unknown;
    try {
      parseOverlayFile('/tmp/specific-file.md', md);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ConfigurationError);
    const msg = (caught as Error).message;
    expect(msg).toContain('/tmp/specific-file.md');
  });
});

describe('loadOverlayRegistry', () => {
  it('returns empty registry when directory does not exist', async () => {
    const reg = await loadOverlayRegistry(path.join(tmpDir, 'does-not-exist'));
    expect(reg.list().length).toBe(0);
    expect(reg.get('file_read')).toBeUndefined();
  });

  it('reads and parses every *.md file in the directory', async () => {
    const dir = path.join(tmpDir, 'tool-prompts');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'file_read.md'),
      serializeOverlay('file_read', {
        description: 'CUSTOM read description.',
        parameters: { path: 'CUSTOM path desc.' },
      }),
    );
    await fsp.writeFile(
      path.join(dir, 'file_list.md'),
      serializeOverlay('file_list', {
        description: 'CUSTOM list description.',
        parameters: { path: 'CUSTOM path desc.' },
      }),
    );
    const reg = await loadOverlayRegistry(dir);
    expect(reg.list().length).toBe(2);
    expect(reg.get('file_read')?.description).toBe('CUSTOM read description.');
    expect(reg.get('file_list')?.description).toBe('CUSTOM list description.');
  });

  it('throws ConfigurationError when filename does not match H1', async () => {
    const dir = path.join(tmpDir, 'mismatched');
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'wrong_name.md');
    await fsp.writeFile(
      filePath,
      serializeOverlay('file_read', {
        description: 'a',
        parameters: {},
      }),
    );
    let caught: unknown;
    try {
      await loadOverlayRegistry(dir);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as Error).message).toContain(filePath);
  });

  it('surfaces parser errors with the file path', async () => {
    const dir = path.join(tmpDir, 'malformed');
    await fsp.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, 'file_read.md');
    await fsp.writeFile(filePath, '## Description\n\nbody\n');
    let caught: unknown;
    try {
      await loadOverlayRegistry(dir);
    } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(ConfigurationError);
    expect((caught as Error).message).toContain(filePath);
  });

  it('skips non-.md files', async () => {
    const dir = path.join(tmpDir, 'mixed');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'README.txt'), 'hello');
    await fsp.writeFile(
      path.join(dir, 'file_read.md'),
      serializeOverlay('file_read', { description: 'd', parameters: {} }),
    );
    const reg = await loadOverlayRegistry(dir);
    expect(reg.list().length).toBe(1);
  });
});

describe('getToolDescription / getParamDescription', () => {
  it('returns built-in fallback when registry is undefined', () => {
    expect(getToolDescription(undefined, 'file_read', 'BUILTIN-DESC')).toBe('BUILTIN-DESC');
    expect(getParamDescription(undefined, 'file_read', 'path', 'BUILTIN-PARAM')).toBe('BUILTIN-PARAM');
  });

  it('returns built-in fallback when overlay missing for the tool', async () => {
    const dir = path.join(tmpDir, 'no-tool-match');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'file_read.md'),
      serializeOverlay('file_read', { description: 'OVERLAY-DESC', parameters: { path: 'OVERLAY-PATH' } }),
    );
    const reg = await loadOverlayRegistry(dir);
    expect(getToolDescription(reg, 'file_list', 'FALLBACK-DESC')).toBe('FALLBACK-DESC');
    expect(getParamDescription(reg, 'file_list', 'path', 'FALLBACK-PARAM')).toBe('FALLBACK-PARAM');
  });

  it('returns overlay value when present', async () => {
    const dir = path.join(tmpDir, 'with-overlay');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'file_read.md'),
      serializeOverlay('file_read', { description: 'OVERLAY-DESC', parameters: { path: 'OVERLAY-PATH' } }),
    );
    const reg = await loadOverlayRegistry(dir);
    expect(getToolDescription(reg, 'file_read', 'FALLBACK')).toBe('OVERLAY-DESC');
    expect(getParamDescription(reg, 'file_read', 'path', 'FALLBACK')).toBe('OVERLAY-PATH');
  });

  it('returns built-in fallback when overlay missing the requested param', async () => {
    const dir = path.join(tmpDir, 'partial');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(
      path.join(dir, 'file_read.md'),
      serializeOverlay('file_read', { description: 'OVERLAY-DESC', parameters: { path: 'OVERLAY-PATH' } }),
    );
    const reg = await loadOverlayRegistry(dir);
    expect(getParamDescription(reg, 'file_read', 'max_bytes', 'FALLBACK-MAX')).toBe('FALLBACK-MAX');
  });
});
