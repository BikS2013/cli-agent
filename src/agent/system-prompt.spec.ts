/**
 * Tests for system-prompt.ts: buildSystemPrompt + buildSystemPromptForCfg.
 *
 * Locks in the externalized base-prompt contract:
 *   - buildSystemPrompt is a pure composer: base + capabilities + custom.
 *   - buildSystemPromptForCfg loads base from cfg.systemPromptPath and
 *     composes the inline (--system) and file (--system-file) addenda
 *     on top, in that order.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, buildSystemPromptForCfg, BUILTIN_DEFAULT_SYSTEM_PROMPT } from './system-prompt.js';

describe('buildSystemPrompt (pure composer)', () => {
  it('returns baseText alone when capabilities and custom are empty', async () => {
    const out = await buildSystemPrompt('BASE', '');
    expect(out).toBe('BASE');
  });

  it('appends capabilities section after a blank line', async () => {
    const out = await buildSystemPrompt('BASE', 'CAPS');
    expect(out).toBe('BASE\n\nCAPS');
  });

  it('appends custom text under a User-provided instructions header', async () => {
    const out = await buildSystemPrompt('BASE', '', 'rule X');
    expect(out).toBe('BASE\n\n## User-provided instructions\n\nrule X');
  });

  it('composes base + capabilities + custom in that order', async () => {
    const out = await buildSystemPrompt('B', 'C', 'U');
    expect(out).toBe('B\n\nC\n\n## User-provided instructions\n\nU');
  });

  it('built-in default constant is exported and non-empty', () => {
    expect(BUILTIN_DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    expect(BUILTIN_DEFAULT_SYSTEM_PROMPT).toContain('cli-agent');
  });
});

describe('buildSystemPromptForCfg (loads from disk + composes)', () => {
  let tmpDir: string;
  let basePath: string;
  let appendPath: string;

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-sysprompt-'));
    basePath = path.join(tmpDir, 'base.md');
    appendPath = path.join(tmpDir, 'append.md');
    await fsp.writeFile(basePath, 'CUSTOM BASE\n');
    await fsp.writeFile(appendPath, 'FILE APPEND\n');
  });

  afterAll(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('AC-2 byte-equivalence: with no addenda, output is exactly baseText + capSection', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined },
      'CAPS',
    );
    expect(out).toBe('CUSTOM BASE\n\n\nCAPS');
  });

  it('AC-8: --system inline text is appended under the User-provided header', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: 'extra rule', systemAppendFile: undefined },
      '',
    );
    expect(out).toContain('## User-provided instructions');
    expect(out).toContain('extra rule');
    expect(out.startsWith('CUSTOM BASE')).toBe(true);
  });

  it('--system-file contents are appended', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: appendPath },
      '',
    );
    expect(out).toContain('FILE APPEND');
  });

  it('--system-file + --system are concatenated (file first, then inline)', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: 'inline part', systemAppendFile: appendPath },
      '',
    );
    const filePos = out.indexOf('FILE APPEND');
    const inlinePos = out.indexOf('inline part');
    expect(filePos).toBeGreaterThan(0);
    expect(inlinePos).toBeGreaterThan(filePos);
  });

  it('throws when systemPromptPath does not exist (no silent fallback)', async () => {
    await expect(
      buildSystemPromptForCfg(
        { systemPromptPath: '/nonexistent/path/foo.md', systemAppendText: undefined, systemAppendFile: undefined },
        '',
      ),
    ).rejects.toThrow();
  });
});
