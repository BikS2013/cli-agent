/**
 * Unit tests for the `agt_grep` LangChain wrapper.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  AGT_GREP_NAME,
  AGT_GREP_DESCRIPTION,
  buildAgtGrepTool,
} from './agt-grep.js';
import type { PermissionPolicy } from '../agent-tools-vendored/upstream/src/types.js';

const stubPolicy: PermissionPolicy = {
  id: 'test',
  evaluateBash: () => ({ allow: true }),
  evaluateFsWrite: () => ({ allow: true }),
};

function freshTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('agt_grep — wrapper metadata', () => {
  const tool = buildAgtGrepTool({ permissions: stubPolicy });

  it('exposes the stable tool name', () => {
    expect(tool.name).toBe(AGT_GREP_NAME);
    expect(tool.name).toBe('agt_grep');
  });

  it('embeds a non-empty description matching the exported constant', () => {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toBe(AGT_GREP_DESCRIPTION);
    expect(tool.description.toLowerCase()).toContain('regex');
  });
});

describe('agt_grep — execute()', () => {
  let workingDirectory: string;

  beforeEach(() => {
    workingDirectory = freshTempDir('agt-grep-');
    fs.writeFileSync(
      path.join(workingDirectory, 'a.txt'),
      'hello world\nfoo bar\n',
    );
    fs.writeFileSync(
      path.join(workingDirectory, 'b.txt'),
      'goodbye world\n',
    );
  });

  afterEach(() => {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  });

  it('returns a string for a valid invocation (happy path)', async () => {
    const tool = buildAgtGrepTool({ permissions: stubPolicy });
    const result = await tool.invoke(
      { pattern: 'world', outputMode: 'files_with_matches' },
      { configurable: { workingDirectory } },
    );
    expect(typeof result).toBe('string');
    expect(result).toContain('a.txt');
    expect(result).toContain('b.txt');
  });

  it('throws when configurable.workingDirectory is missing', async () => {
    const tool = buildAgtGrepTool({ permissions: stubPolicy });
    await expect(tool.invoke({ pattern: 'world' })).rejects.toThrow(
      /workingDirectory is required/,
    );
  });
});
