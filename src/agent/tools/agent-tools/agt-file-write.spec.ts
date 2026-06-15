/**
 * Unit tests for `agt_file_write` (plan-012).
 *
 * Covers:
 *   - identity: tool name constant and built tool name match
 *   - description: default built-in; overlay override
 *   - sandbox enforcement: path outside root throws E_FILE_PATH_OUTSIDE_ROOT
 *   - confirmed:false → requires_confirmation response; operation uses agt_file_write name; file NOT written
 *   - confirmed:true  → file created with the correct content; ok:true + bytesWritten in response
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  AGT_FILE_WRITE_NAME,
  AGT_FILE_WRITE_DESCRIPTION,
  buildAgtFileWriteTool,
} from './agt-file-write.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import type { OverlayRegistry } from '../tool-prompt-overlay.js';

// ----- Helpers ---------------------------------------------------------------

let tmpDir: string;
let realTmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agt-file-write-'));
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
      name === AGT_FILE_WRITE_NAME
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

describe('agt_file_write — identity', () => {
  it('exports the correct name constant', () => {
    expect(AGT_FILE_WRITE_NAME).toBe('agt_file_write');
  });

  it('description constant equals the built-in entry', () => {
    expect(AGT_FILE_WRITE_DESCRIPTION).toBe(
      BUILTIN_TOOL_PROMPTS['agt_file_write']!.description,
    );
  });

  it('built tool carries the agt_file_write name', () => {
    const tool = buildAgtFileWriteTool({ cfg: makeCfg() });
    expect(tool.name).toBe('agt_file_write');
  });

  it('built tool description equals the built-in when no overlay is registered', () => {
    const tool = buildAgtFileWriteTool({ cfg: makeCfg() });
    expect(tool.description).toBe(AGT_FILE_WRITE_DESCRIPTION);
  });
});

describe('agt_file_write — overlay', () => {
  it('a registered overlay overrides the LLM-visible description', () => {
    const overlays = makeOverlays('OVERLAID write description');
    const tool = buildAgtFileWriteTool({ cfg: makeCfg(), overlays });
    expect(tool.description).toBe('OVERLAID write description');
  });
});

describe('agt_file_write — sandbox enforcement', () => {
  // handleToolError serialises FileError to a JSON string (not a rejection).
  it('returns E_FILE_PATH_OUTSIDE_ROOT JSON when path escapes the sandbox root', async () => {
    const tool = buildAgtFileWriteTool({ cfg: makeCfg() });
    const raw = await tool.func(
      { path: '/etc/hosts', content: 'x', confirmed: true },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as { error?: { code?: string } };
    expect(result.error?.code).toBe('E_FILE_PATH_OUTSIDE_ROOT');
  });
});

describe('agt_file_write — confirmed:false', () => {
  it('returns requires_confirmation:true and does NOT write the file', async () => {
    const filePath = path.join(realTmpDir, 'output.txt');
    const tool = buildAgtFileWriteTool({ cfg: makeCfg() });

    const raw = await tool.func(
      { path: filePath, content: 'should not appear', confirmed: false },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as {
      requires_confirmation: boolean;
      operation: string;
      path: string;
    };

    expect(result.requires_confirmation).toBe(true);
    // Must use the NEW agt_ name, not the old file_write
    expect(result.operation).toBe('agt_file_write');
    expect(result.path).toBe(filePath);

    // File must NOT have been created
    await expect(fsp.access(filePath)).rejects.toThrow();
  });
});

describe('agt_file_write — confirmed:true', () => {
  it('creates the file with the specified content and returns ok:true + bytesWritten', async () => {
    const filePath = path.join(realTmpDir, 'result.txt');
    const content = 'hello from agt_file_write';
    const tool = buildAgtFileWriteTool({ cfg: makeCfg() });

    const raw = await tool.func(
      { path: filePath, content, confirmed: true },
      undefined,
      undefined,
    );
    const result = JSON.parse(raw) as {
      ok: boolean;
      path: string;
      bytesWritten: number;
    };

    expect(result.ok).toBe(true);
    expect(result.path).toBe(filePath);
    expect(result.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'));

    const written = await fsp.readFile(filePath, 'utf8');
    expect(written).toBe(content);
  });

  it('overwrites existing content', async () => {
    const filePath = path.join(realTmpDir, 'overwrite.txt');
    await fsp.writeFile(filePath, 'original', 'utf8');

    const tool = buildAgtFileWriteTool({ cfg: makeCfg() });
    await tool.func({ path: filePath, content: 'replaced', confirmed: true }, undefined, undefined);

    const written = await fsp.readFile(filePath, 'utf8');
    expect(written).toBe('replaced');
  });
});
