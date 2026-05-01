/**
 * Unit tests for the `agt_multiedit` LangChain wrapper.
 *
 * Coverage extras (mutating tool):
 *   - denying policy → error string returned (NOT thrown).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  AGT_MULTIEDIT_NAME,
  AGT_MULTIEDIT_DESCRIPTION,
  buildAgtMultieditTool,
} from './agt-multiedit.js';
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

describe('agt_multiedit — wrapper metadata', () => {
  const tool = buildAgtMultieditTool({ permissions: allowAllPolicy });

  it('exposes the stable tool name', () => {
    expect(tool.name).toBe(AGT_MULTIEDIT_NAME);
    expect(tool.name).toBe('agt_multiedit');
  });

  it('embeds a non-empty description matching the exported constant', () => {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toBe(AGT_MULTIEDIT_DESCRIPTION);
    expect(tool.description.toLowerCase()).toContain('atomically');
  });
});

describe('agt_multiedit — execute()', () => {
  let workingDirectory: string;
  let target: string;

  beforeEach(() => {
    workingDirectory = freshTempDir('agt-multiedit-');
    target = path.join(workingDirectory, 'file.txt');
    fs.writeFileSync(target, 'alpha\nbeta\ngamma\n');
  });

  afterEach(() => {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  });

  it('returns a string for a valid invocation (happy path)', async () => {
    const tool = buildAgtMultieditTool({ permissions: allowAllPolicy });
    const result = await tool.invoke(
      {
        filePath: target,
        edits: [
          { oldString: 'alpha', newString: 'ALPHA' },
          { oldString: 'gamma', newString: 'GAMMA' },
        ],
      },
      { configurable: { workingDirectory } },
    );
    expect(typeof result).toBe('string');
    expect(result).toMatch(/Applied 2 edits/);
    const after = fs.readFileSync(target, 'utf8');
    expect(after).toBe('ALPHA\nbeta\nGAMMA\n');
  });

  it('throws when configurable.workingDirectory is missing', async () => {
    const tool = buildAgtMultieditTool({ permissions: allowAllPolicy });
    await expect(
      tool.invoke({
        filePath: target,
        edits: [{ oldString: 'alpha', newString: 'ALPHA' }],
      }),
    ).rejects.toThrow(/workingDirectory is required/);
  });

  it('surfaces a denying policy as an error string (no throw)', async () => {
    const tool = buildAgtMultieditTool({ permissions: denyAllPolicy });
    const result = await tool.invoke(
      {
        filePath: target,
        edits: [{ oldString: 'alpha', newString: 'ALPHA' }],
      },
      { configurable: { workingDirectory } },
    );
    expect(typeof result).toBe('string');
    expect(result).toMatch(/^\[agt_multiedit error\]/);
    expect(result.toLowerCase()).toContain('denied');
    // File on disk MUST be unchanged.
    const after = fs.readFileSync(target, 'utf8');
    expect(after).toBe('alpha\nbeta\ngamma\n');
  });
});
