/**
 * Unit tests for `agt_file_list` (plan-012).
 *
 * Covers:
 *   - identity: tool name constant and built tool name match
 *   - description: default built-in; overlay override
 *   - sandbox enforcement: path outside root throws E_FILE_PATH_OUTSIDE_ROOT
 *   - happy path: lists files and subdirectories with correct type labels
 *   - glob filtering: narrows results to matching names
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  AGT_FILE_LIST_NAME,
  AGT_FILE_LIST_DESCRIPTION,
  buildAgtFileListTool,
} from './agt-file-list.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import type { OverlayRegistry } from '../tool-prompt-overlay.js';

// ----- Helpers ---------------------------------------------------------------

let tmpDir: string;
let realTmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agt-file-list-'));
  realTmpDir = fs.realpathSync(tmpDir);
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function makeCfg(overlays?: OverlayRegistry): AgentConfig {
  return {
    fileEdit: { root: realTmpDir, allowPaths: [] },
    perToolBudgetBytes: 1024 * 1024,
    toolPromptOverlays: overlays,
  } as unknown as AgentConfig;
}

function makeOverlays(description: string): OverlayRegistry {
  return {
    get: (name: string) =>
      name === AGT_FILE_LIST_NAME
        ? {
            tool: name,
            description,
            parameters: new Map<string, string>(),
            source: 'test',
          }
        : undefined,
    list: () => [],
  } as unknown as OverlayRegistry;
}

// ----- Tests -----------------------------------------------------------------

describe('agt_file_list — identity', () => {
  it('exports the correct name constant', () => {
    expect(AGT_FILE_LIST_NAME).toBe('agt_file_list');
  });

  it('description constant equals the built-in entry', () => {
    expect(AGT_FILE_LIST_DESCRIPTION).toBe(
      BUILTIN_TOOL_PROMPTS['agt_file_list']!.description,
    );
  });

  it('built tool carries the agt_file_list name', () => {
    const tool = buildAgtFileListTool({ cfg: makeCfg() });
    expect(tool.name).toBe('agt_file_list');
  });

  it('built tool description equals the built-in when no overlay is registered', () => {
    const tool = buildAgtFileListTool({ cfg: makeCfg() });
    expect(tool.description).toBe(AGT_FILE_LIST_DESCRIPTION);
  });
});

describe('agt_file_list — overlay', () => {
  it('a registered overlay overrides the LLM-visible description', () => {
    const overlays = makeOverlays('OVERLAID list description');
    const tool = buildAgtFileListTool({ cfg: makeCfg(), overlays });
    expect(tool.description).toBe('OVERLAID list description');
  });
});

describe('agt_file_list — sandbox enforcement', () => {
  // handleToolError serialises CliAgentError (including FileError) to a JSON string.
  it('returns E_FILE_PATH_OUTSIDE_ROOT JSON when path escapes the sandbox root', async () => {
    const tool = buildAgtFileListTool({ cfg: makeCfg() });
    const raw = await tool.func({ path: '/tmp' }, undefined, undefined);
    const result = JSON.parse(raw) as { error?: { code?: string } };
    expect(result.error?.code).toBe('E_FILE_PATH_OUTSIDE_ROOT');
  });
});

describe('agt_file_list — happy path', () => {
  it('lists files and subdirectories with correct type labels', async () => {
    // Create two files and one sub-directory inside realTmpDir
    await fsp.writeFile(path.join(realTmpDir, 'alpha.ts'), 'a', 'utf8');
    await fsp.writeFile(path.join(realTmpDir, 'beta.txt'), 'b', 'utf8');
    await fsp.mkdir(path.join(realTmpDir, 'subdir'));

    const tool = buildAgtFileListTool({ cfg: makeCfg() });
    const raw = await tool.func({ path: realTmpDir }, undefined, undefined);
    const result = JSON.parse(raw) as {
      path: string;
      items: { name: string; type: string }[];
    };

    expect(result.path).toBe(realTmpDir);

    const names = result.items.map((i) => i.name);
    expect(names).toContain('alpha.ts');
    expect(names).toContain('beta.txt');
    expect(names).toContain('subdir');

    const alpha = result.items.find((i) => i.name === 'alpha.ts');
    expect(alpha?.type).toBe('file');

    const sub = result.items.find((i) => i.name === 'subdir');
    expect(sub?.type).toBe('directory');
  });
});

describe('agt_file_list — glob filtering', () => {
  it('narrows results to names matching the glob pattern', async () => {
    await fsp.writeFile(path.join(realTmpDir, 'index.ts'), '', 'utf8');
    await fsp.writeFile(path.join(realTmpDir, 'README.md'), '', 'utf8');
    await fsp.writeFile(path.join(realTmpDir, 'util.ts'), '', 'utf8');

    const tool = buildAgtFileListTool({ cfg: makeCfg() });
    const raw = await tool.func({ path: realTmpDir, glob: '*.ts' }, undefined, undefined);
    const result = JSON.parse(raw) as { items: { name: string }[] };

    const names = result.items.map((i) => i.name);
    expect(names).toContain('index.ts');
    expect(names).toContain('util.ts');
    expect(names).not.toContain('README.md');
  });

  it('returns all items when no glob is supplied', async () => {
    await fsp.writeFile(path.join(realTmpDir, 'a.ts'), '', 'utf8');
    await fsp.writeFile(path.join(realTmpDir, 'b.md'), '', 'utf8');

    const tool = buildAgtFileListTool({ cfg: makeCfg() });
    const raw = await tool.func({ path: realTmpDir }, undefined, undefined);
    const result = JSON.parse(raw) as { items: { name: string }[] };

    expect(result.items.length).toBe(2);
  });
});
