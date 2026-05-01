/**
 * Unit tests for the `agt_glob` LangChain wrapper.
 *
 * Coverage:
 *   - tool name + description metadata
 *   - happy-path execution against a temp directory
 *   - hard failure when `configurable.workingDirectory` is missing
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import {
  AGT_GLOB_NAME,
  AGT_GLOB_DESCRIPTION,
  buildAgtGlobTool,
} from './agt-glob.js';
import type { PermissionPolicy } from '../agent-tools-vendored/upstream/src/types.js';

const stubPolicy: PermissionPolicy = {
  id: 'test',
  evaluateBash: () => ({ allow: true }),
  evaluateFsWrite: () => ({ allow: true }),
};

function freshTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return dir;
}

describe('agt_glob — wrapper metadata', () => {
  const tool = buildAgtGlobTool({ permissions: stubPolicy });

  it('exposes the stable tool name', () => {
    expect(tool.name).toBe(AGT_GLOB_NAME);
    expect(tool.name).toBe('agt_glob');
  });

  it('embeds a non-empty description matching the exported constant', () => {
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.description).toBe(AGT_GLOB_DESCRIPTION);
    expect(tool.description.toLowerCase()).toContain('glob');
  });
});

describe('agt_glob — execute()', () => {
  let workingDirectory: string;

  beforeEach(() => {
    workingDirectory = freshTempDir('agt-glob-');
    // Seed two files so glob has something to match.
    fs.writeFileSync(path.join(workingDirectory, 'one.ts'), 'export {};\n');
    fs.writeFileSync(path.join(workingDirectory, 'two.ts'), 'export {};\n');
  });

  afterEach(() => {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  });

  it('returns a string for a valid invocation (happy path)', async () => {
    const tool = buildAgtGlobTool({ permissions: stubPolicy });
    const result = await tool.invoke(
      { pattern: '**/*.ts' },
      { configurable: { workingDirectory } },
    );
    expect(typeof result).toBe('string');
    // glob output is one path per line; both seeded files should appear.
    expect(result).toContain('one.ts');
    expect(result).toContain('two.ts');
  });

  it('throws when configurable.workingDirectory is missing', async () => {
    const tool = buildAgtGlobTool({ permissions: stubPolicy });
    await expect(tool.invoke({ pattern: '**/*.ts' })).rejects.toThrow(
      /workingDirectory is required/,
    );
  });

  it('throws when configurable.workingDirectory is an empty string', async () => {
    const tool = buildAgtGlobTool({ permissions: stubPolicy });
    await expect(
      tool.invoke({ pattern: '**/*.ts' }, { configurable: { workingDirectory: '' } }),
    ).rejects.toThrow(/workingDirectory is required/);
  });
});
