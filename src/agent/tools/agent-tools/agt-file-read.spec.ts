/**
 * Unit tests for `agt_file_read` (plan-012).
 *
 * Covers:
 *   - identity: tool name constant and built tool name match
 *   - description: default built-in description; overlay override
 *   - sandbox enforcement: path outside root throws E_FILE_PATH_OUTSIDE_ROOT
 *   - happy path: reads an existing file and returns utf-8 content
 *   - binary mode: returns base64 content when binary:true
 *   - missing file: throws FileError with code E_FILE_NOT_FOUND
 *   - max_bytes enforcement: returns E_FILE_TOO_LARGE error when file exceeds limit
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  AGT_FILE_READ_NAME,
  AGT_FILE_READ_DESCRIPTION,
  buildAgtFileReadTool,
} from './agt-file-read.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import type { OverlayRegistry } from '../tool-prompt-overlay.js';

// ----- Helpers ---------------------------------------------------------------

let tmpDir: string;
// realTmpDir is the fully-resolved path (resolves /var/folders symlink on macOS)
let realTmpDir: string;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agt-file-read-'));
  realTmpDir = fs.realpathSync(tmpDir);
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function makeCfg(overlays?: OverlayRegistry): AgentConfig {
  // Use realTmpDir as root so resolveSandboxPath's realpath check passes on macOS
  return {
    fileEdit: { root: realTmpDir, allowPaths: [] },
    perToolBudgetBytes: 1024 * 1024,
    toolPromptOverlays: overlays,
  } as unknown as AgentConfig;
}

function makeOverlays(description: string): OverlayRegistry {
  return {
    get: (name: string) =>
      name === AGT_FILE_READ_NAME
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

describe('agt_file_read — identity', () => {
  it('exports the correct name constant', () => {
    expect(AGT_FILE_READ_NAME).toBe('agt_file_read');
  });

  it('description constant equals the built-in entry', () => {
    expect(AGT_FILE_READ_DESCRIPTION).toBe(
      BUILTIN_TOOL_PROMPTS['agt_file_read']!.description,
    );
  });

  it('built tool carries the agt_file_read name', () => {
    const tool = buildAgtFileReadTool({ cfg: makeCfg() });
    expect(tool.name).toBe('agt_file_read');
  });

  it('built tool description equals the built-in when no overlay is registered', () => {
    const tool = buildAgtFileReadTool({ cfg: makeCfg() });
    expect(tool.description).toBe(AGT_FILE_READ_DESCRIPTION);
  });
});

describe('agt_file_read — overlay', () => {
  it('a registered overlay overrides the LLM-visible description', () => {
    const overlays = makeOverlays('OVERLAID read description');
    const tool = buildAgtFileReadTool({ cfg: makeCfg(), overlays });
    expect(tool.description).toBe('OVERLAID read description');
  });
});

describe('agt_file_read — sandbox enforcement', () => {
  // NOTE: resolveSandboxPath throws FileError (a CliAgentError), which handleToolError
  // serialises to a JSON string rather than re-throwing. Assert the JSON envelope.
  it('returns E_FILE_PATH_OUTSIDE_ROOT JSON when path escapes the sandbox root', async () => {
    const tool = buildAgtFileReadTool({ cfg: makeCfg() });
    // /etc/hosts is always outside the per-test tmpDir
    const raw = await tool.func({ path: '/etc/hosts' }, undefined, undefined);
    const result = JSON.parse(raw) as { error?: { code?: string } };
    expect(result.error?.code).toBe('E_FILE_PATH_OUTSIDE_ROOT');
  });

  it('returns E_FILE_PATH_OUTSIDE_ROOT JSON for a traversal attempt', async () => {
    const tool = buildAgtFileReadTool({ cfg: makeCfg() });
    const raw = await tool.func({ path: '../../etc/passwd' }, undefined, undefined);
    const result = JSON.parse(raw) as { error?: { code?: string } };
    expect(result.error?.code).toBe('E_FILE_PATH_OUTSIDE_ROOT');
  });
});

describe('agt_file_read — happy path', () => {
  it('reads a text file and returns the content as utf-8', async () => {
    // Use realTmpDir so the written path and sandbox root agree after realpath resolution
    const filePath = path.join(realTmpDir, 'hello.txt');
    await fsp.writeFile(filePath, 'hello world', 'utf8');

    const tool = buildAgtFileReadTool({ cfg: makeCfg() });
    const raw = await tool.func({ path: filePath }, undefined, undefined);
    const result = JSON.parse(raw) as { path: string; content: string; binary: boolean };

    expect(result.content).toBe('hello world');
    expect(result.binary).toBe(false);
    expect(result.path).toBe(filePath);
  });

  it('accepts a relative path (relative to the sandbox root)', async () => {
    const filePath = path.join(realTmpDir, 'rel.txt');
    await fsp.writeFile(filePath, 'relative', 'utf8');

    const tool = buildAgtFileReadTool({ cfg: makeCfg() });
    const raw = await tool.func({ path: 'rel.txt' }, undefined, undefined);
    const result = JSON.parse(raw) as { content: string };

    expect(result.content).toBe('relative');
  });
});

describe('agt_file_read — binary mode', () => {
  it('returns base64-encoded content when binary:true', async () => {
    const filePath = path.join(realTmpDir, 'data.bin');
    const original = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await fsp.writeFile(filePath, original);

    const tool = buildAgtFileReadTool({ cfg: makeCfg() });
    const raw = await tool.func({ path: filePath, binary: true }, undefined, undefined);
    const result = JSON.parse(raw) as { content: string; binary: boolean };

    expect(result.binary).toBe(true);
    expect(Buffer.from(result.content, 'base64').equals(original)).toBe(true);
  });
});

describe('agt_file_read — error paths', () => {
  it('throws FileError with E_FILE_NOT_FOUND for a missing file', async () => {
    // The agt_file_read catch block explicitly re-throws FileError for ENOENT,
    // so this is the one case that rejects instead of returning a JSON envelope.
    const tool = buildAgtFileReadTool({ cfg: makeCfg() });
    const missing = path.join(realTmpDir, 'nonexistent.txt');

    await expect(
      tool.func({ path: missing }, undefined, undefined),
    ).rejects.toMatchObject({
      code: 'E_FILE_NOT_FOUND',
    });
  });

  it('returns E_FILE_TOO_LARGE JSON when max_bytes is smaller than the file size', async () => {
    // assertMaxBytes throws FileError (a CliAgentError), which handleToolError
    // serialises to a JSON string (same as the sandbox-violation path).
    const filePath = path.join(realTmpDir, 'big.txt');
    await fsp.writeFile(filePath, 'A'.repeat(200), 'utf8');

    const tool = buildAgtFileReadTool({ cfg: makeCfg() });
    const raw = await tool.func({ path: filePath, max_bytes: 10 }, undefined, undefined);
    const result = JSON.parse(raw) as { error?: { code?: string } };
    expect(result.error?.code).toBe('E_FILE_TOO_LARGE');
  });
});
