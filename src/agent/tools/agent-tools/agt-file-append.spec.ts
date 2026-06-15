/**
 * Unit tests for `agt_file_append` (plan-012).
 *
 * Covers:
 *   - identity: tool name constant and built tool name match
 *   - description: default built-in; overlay override
 *   - sandbox enforcement: path outside root returns E_FILE_PATH_OUTSIDE_ROOT JSON
 *   - confirmed:false → requires_confirmation response with agt_file_append operation name; file NOT written
 *   - confirmed:true  → content appended to existing file; final content = original + appended
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  AGT_FILE_APPEND_NAME,
  AGT_FILE_APPEND_DESCRIPTION,
  buildAgtFileAppendTool,
} from './agt-file-append.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import type { OverlayRegistry } from '../tool-prompt-overlay.js';

// ----- Helpers ---------------------------------------------------------------

let tmpDir: string;
let realTmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agt-file-append-'));
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
      name === AGT_FILE_APPEND_NAME
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

describe('agt_file_append — identity', () => {
  it('exports the correct name constant', () => {
    expect(AGT_FILE_APPEND_NAME).toBe('agt_file_append');
  });

  it('description constant equals the built-in entry', () => {
    expect(AGT_FILE_APPEND_DESCRIPTION).toBe(
      BUILTIN_TOOL_PROMPTS['agt_file_append']!.description,
    );
  });

  it('built tool carries the agt_file_append name', () => {
    const tool = buildAgtFileAppendTool({ cfg: makeCfg() });
    expect(tool.name).toBe('agt_file_append');
  });

  it('built tool description equals the built-in when no overlay is registered', () => {
    const tool = buildAgtFileAppendTool({ cfg: makeCfg() });
    expect(tool.description).toBe(AGT_FILE_APPEND_DESCRIPTION);
  });
});

describe('agt_file_append — overlay', () => {
  it('a registered overlay overrides the LLM-visible description', () => {
    const overlays = makeOverlays('OVERLAID append description');
    const tool = buildAgtFileAppendTool({ cfg: makeCfg(), overlays });
    expect(tool.description).toBe('OVERLAID append description');
  });
});

describe('agt_file_append — sandbox enforcement', () => {
  // handleToolError serialises FileError (a CliAgentError) to a JSON string.
  it('returns E_FILE_PATH_OUTSIDE_ROOT JSON when path escapes the sandbox root', async () => {
    const tool = buildAgtFileAppendTool({ cfg: makeCfg() });
    const raw = await tool.func(
      { path: '/etc/hosts', content: 'x', confirmed: true },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as { error?: { code?: string } };
    expect(result.error?.code).toBe('E_FILE_PATH_OUTSIDE_ROOT');
  });
});

describe('agt_file_append — confirmed:false', () => {
  it('returns requires_confirmation:true and does NOT modify the file', async () => {
    const filePath = path.join(realTmpDir, 'log.txt');
    await fsp.writeFile(filePath, 'line1\n', 'utf8');

    const tool = buildAgtFileAppendTool({ cfg: makeCfg() });
    const raw = await tool.func(
      { path: filePath, content: 'line2\n', confirmed: false },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as {
      requires_confirmation: boolean;
      operation: string;
      path: string;
    };

    expect(result.requires_confirmation).toBe(true);
    // Must use the NEW agt_ name, not file_append
    expect(result.operation).toBe('agt_file_append');
    expect(result.path).toBe(filePath);

    // File must remain unchanged
    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toBe('line1\n');
  });
});

describe('agt_file_append — confirmed:true', () => {
  it('appends content to an existing file; final content = original + appended', async () => {
    const original = 'first line\n';
    const appended = 'second line\n';
    const filePath = path.join(realTmpDir, 'journal.txt');
    await fsp.writeFile(filePath, original, 'utf8');

    const tool = buildAgtFileAppendTool({ cfg: makeCfg() });
    const raw = await tool.func(
      { path: filePath, content: appended, confirmed: true },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as {
      ok: boolean;
      path: string;
      bytesAppended: number;
    };

    expect(result.ok).toBe(true);
    expect(result.path).toBe(filePath);
    expect(result.bytesAppended).toBe(Buffer.byteLength(appended, 'utf8'));

    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toBe(original + appended);
  });

  it('appending to a non-existent file creates the file', async () => {
    const filePath = path.join(realTmpDir, 'new.txt');
    const tool = buildAgtFileAppendTool({ cfg: makeCfg() });

    await tool.func({ path: filePath, content: 'created', confirmed: true }, undefined, undefined);

    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toBe('created');
  });

  it('multiple consecutive appends accumulate content correctly', async () => {
    const filePath = path.join(realTmpDir, 'multi.txt');
    await fsp.writeFile(filePath, 'A', 'utf8');

    const tool = buildAgtFileAppendTool({ cfg: makeCfg() });
    await tool.func({ path: filePath, content: 'B', confirmed: true }, undefined, undefined);
    await tool.func({ path: filePath, content: 'C', confirmed: true }, undefined, undefined);

    const after = await fsp.readFile(filePath, 'utf8');
    expect(after).toBe('ABC');
  });
});
