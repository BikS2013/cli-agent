/**
 * Unit tests for `agt_file_edit` (plan-012).
 *
 * Covers:
 *   - identity: tool name constant and built tool name match
 *   - description: default built-in; overlay override
 *   - sandbox enforcement: path outside root returns E_FILE_PATH_OUTSIDE_ROOT JSON
 *   - confirmed:false → requires_confirmation response with agt_file_edit operation name
 *   - literal find/replace (default, occurrence:'first')
 *   - use_regex:true — regex pattern matching
 *   - occurrence:'all' — replaces every match
 *   - no match → throws FileError with E_FILE_EDIT_NO_MATCH
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  AGT_FILE_EDIT_NAME,
  AGT_FILE_EDIT_DESCRIPTION,
  buildAgtFileEditTool,
} from './agt-file-edit.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import type { OverlayRegistry } from '../tool-prompt-overlay.js';

// ----- Helpers ---------------------------------------------------------------

let tmpDir: string;
let realTmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agt-file-edit-'));
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
      name === AGT_FILE_EDIT_NAME
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

async function writeFile(name: string, content: string): Promise<string> {
  const p = path.join(realTmpDir, name);
  await fsp.writeFile(p, content, 'utf8');
  return p;
}

// ----- Tests -----------------------------------------------------------------

describe('agt_file_edit — identity', () => {
  it('exports the correct name constant', () => {
    expect(AGT_FILE_EDIT_NAME).toBe('agt_file_edit');
  });

  it('description constant equals the built-in entry', () => {
    expect(AGT_FILE_EDIT_DESCRIPTION).toBe(
      BUILTIN_TOOL_PROMPTS['agt_file_edit']!.description,
    );
  });

  it('built tool carries the agt_file_edit name', () => {
    const tool = buildAgtFileEditTool({ cfg: makeCfg() });
    expect(tool.name).toBe('agt_file_edit');
  });

  it('built tool description equals the built-in when no overlay is registered', () => {
    const tool = buildAgtFileEditTool({ cfg: makeCfg() });
    expect(tool.description).toBe(AGT_FILE_EDIT_DESCRIPTION);
  });
});

describe('agt_file_edit — overlay', () => {
  it('a registered overlay overrides the LLM-visible description', () => {
    const overlays = makeOverlays('OVERLAID edit description');
    const tool = buildAgtFileEditTool({ cfg: makeCfg(), overlays });
    expect(tool.description).toBe('OVERLAID edit description');
  });
});

describe('agt_file_edit — sandbox enforcement', () => {
  // handleToolError serialises FileError (a CliAgentError) to a JSON string.
  it('returns E_FILE_PATH_OUTSIDE_ROOT JSON when path escapes the sandbox root', async () => {
    const tool = buildAgtFileEditTool({ cfg: makeCfg() });
    const raw = await tool.func(
      { path: '/etc/hosts', find: 'x', replace: 'y', confirmed: true },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as { error?: { code?: string } };
    expect(result.error?.code).toBe('E_FILE_PATH_OUTSIDE_ROOT');
  });
});

describe('agt_file_edit — confirmed:false', () => {
  it('returns requires_confirmation:true with agt_file_edit operation and does NOT edit', async () => {
    const filePath = await writeFile('orig.txt', 'original content');
    const tool = buildAgtFileEditTool({ cfg: makeCfg() });

    const raw = await tool.func(
      { path: filePath, find: 'original', replace: 'changed', confirmed: false },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as {
      requires_confirmation: boolean;
      operation: string;
      path: string;
      find: string;
    };

    expect(result.requires_confirmation).toBe(true);
    // Must use the NEW agt_ name
    expect(result.operation).toBe('agt_file_edit');
    expect(result.path).toBe(filePath);
    expect(result.find).toBe('original');

    // File must remain unchanged
    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toBe('original content');
  });
});

describe('agt_file_edit — literal find/replace', () => {
  it('replaces the first occurrence by default (no occurrence specified)', async () => {
    const filePath = await writeFile('multi.txt', 'aaa bbb aaa');
    const tool = buildAgtFileEditTool({ cfg: makeCfg() });

    const raw = await tool.func(
      { path: filePath, find: 'aaa', replace: 'XXX', confirmed: true },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as { ok: boolean; path: string };
    expect(result.ok).toBe(true);

    // Only the FIRST occurrence should be replaced
    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toBe('XXX bbb aaa');
  });

  it('replaces the first occurrence when occurrence:first is explicit', async () => {
    const filePath = await writeFile('first.txt', 'cat cat cat');
    const tool = buildAgtFileEditTool({ cfg: makeCfg() });

    await tool.func(
      { path: filePath, find: 'cat', replace: 'dog', occurrence: 'first', confirmed: true },
      undefined,
      undefined,
    );

    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toBe('dog cat cat');
  });
});

describe('agt_file_edit — use_regex:true', () => {
  it('applies a regex pattern find/replace (first occurrence)', async () => {
    const filePath = await writeFile('regex.txt', 'color colour');
    const tool = buildAgtFileEditTool({ cfg: makeCfg() });

    await tool.func(
      { path: filePath, find: 'colou?r', replace: 'color', use_regex: true, confirmed: true },
      undefined,
      undefined,
    );

    // Default occurrence is 'first', so only the first match is replaced
    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toBe('color colour');
  });

  it('with occurrence:all and use_regex:true replaces all regex matches', async () => {
    const filePath = await writeFile('regex-all.txt', 'foo1 bar2 foo3');
    const tool = buildAgtFileEditTool({ cfg: makeCfg() });

    await tool.func(
      {
        path: filePath,
        find: 'foo\\d',
        replace: 'baz',
        use_regex: true,
        occurrence: 'all',
        confirmed: true,
      },
      undefined,
      undefined,
    );

    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toBe('baz bar2 baz');
  });
});

describe('agt_file_edit — occurrence:all', () => {
  it('replaces every occurrence in the file', async () => {
    const filePath = await writeFile('all.txt', 'x x x');
    const tool = buildAgtFileEditTool({ cfg: makeCfg() });

    const raw = await tool.func(
      { path: filePath, find: 'x', replace: 'y', occurrence: 'all', confirmed: true },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as { ok: boolean; replacements: number };
    expect(result.ok).toBe(true);
    expect(result.replacements).toBe(3);

    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toBe('y y y');
  });
});

describe('agt_file_edit — no match', () => {
  it('throws FileError with E_FILE_EDIT_NO_MATCH when find text is absent', async () => {
    // E_FILE_EDIT_NO_MATCH is thrown as FileError; handleToolError serialises it to JSON.
    const filePath = await writeFile('no-match.txt', 'hello world');
    const tool = buildAgtFileEditTool({ cfg: makeCfg() });

    const raw = await tool.func(
      { path: filePath, find: 'DOES_NOT_EXIST', replace: 'anything', confirmed: true },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as { error?: { code?: string } };
    expect(result.error?.code).toBe('E_FILE_EDIT_NO_MATCH');
  });
});
