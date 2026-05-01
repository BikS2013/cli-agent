/**
 * Unit tests for the `agt_patch` LangChain wrapper.
 *
 * Coverage extras (mutating tool):
 *   - denying policy → error string returned (NOT thrown).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  AGT_PATCH_NAME,
  AGT_PATCH_DESCRIPTION,
  buildAgtPatchTool,
} from './agt-patch.js';
import type { PermissionPolicy } from '../agent-tools-vendored/upstream/src/types.js';

const allowAllPolicy: PermissionPolicy = {
  id: 'test-allow',
  evaluateBash: () => ({ allow: true }),
  evaluateFsWrite: () => ({ allow: true }),
};

const denyAllPolicy: PermissionPolicy = {
  id: 'test-deny',
  evaluateBash: () => ({ allow: false, reason: 'denied by test' }),
  evaluateFsWrite: () => ({ allow: false, reason: 'denied by test' }),
};

function freshTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const ADD_PATCH = [
  '*** Begin Patch',
  '*** Add File: hello.txt',
  '+Hello world',
  '*** End Patch',
  '',
].join('\n');

describe('agt_patch — wrapper metadata', () => {
  const tool = buildAgtPatchTool({ permissions: allowAllPolicy });

  it('exposes the stable tool name', () => {
    expect(tool.name).toBe(AGT_PATCH_NAME);
    expect(tool.name).toBe('agt_patch');
  });

  it('embeds a non-empty description matching the exported constant', () => {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toBe(AGT_PATCH_DESCRIPTION);
    expect(tool.description).toContain('Begin Patch');
  });
});

describe('agt_patch — execute()', () => {
  let workingDirectory: string;

  beforeEach(() => {
    workingDirectory = freshTempDir('agt-patch-');
  });

  afterEach(() => {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  });

  it('returns a string for a valid invocation (happy path)', async () => {
    const tool = buildAgtPatchTool({ permissions: allowAllPolicy });
    const result = await tool.invoke(
      { patchText: ADD_PATCH },
      { configurable: { workingDirectory } },
    );
    expect(typeof result).toBe('string');
    expect(result).toMatch(/Success/);
    expect(result).toContain('hello.txt');
    expect(fs.existsSync(path.join(workingDirectory, 'hello.txt'))).toBe(true);
  });

  it('throws when configurable.workingDirectory is missing', async () => {
    const tool = buildAgtPatchTool({ permissions: allowAllPolicy });
    await expect(tool.invoke({ patchText: ADD_PATCH })).rejects.toThrow(
      /workingDirectory is required/,
    );
  });

  it('surfaces a denying policy as an error string (no throw)', async () => {
    const tool = buildAgtPatchTool({ permissions: denyAllPolicy });
    const result = await tool.invoke(
      { patchText: ADD_PATCH },
      { configurable: { workingDirectory } },
    );
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^\[agt_patch error\]/);
    expect(result.toLowerCase()).toContain('denied');
    // File MUST not have been created.
    expect(fs.existsSync(path.join(workingDirectory, 'hello.txt'))).toBe(false);
  });
});
