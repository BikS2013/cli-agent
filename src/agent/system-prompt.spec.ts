/**
 * Tests for system-prompt.ts: buildSystemPrompt + buildSystemPromptForCfg.
 *
 * Locks in the externalized base-prompt contract:
 *   - buildSystemPrompt is a pure composer: base + capabilities + custom.
 *   - buildSystemPromptForCfg loads base from cfg.systemPromptPath and
 *     composes the inline (--system) and file (--system-file) addenda
 *     on top, in that order.
 *
 * Extended for agentToolsMeta parameter (agent-tools integration):
 *   - undefined agentToolsMeta → byte-stable with pre-integration output.
 *   - emptyMeta (umbrella off, no registered tools) → also byte-stable.
 *   - fullMeta (all six tools registered) → includes the agent-tools block.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, buildSystemPromptForCfg, BUILTIN_DEFAULT_SYSTEM_PROMPT } from './system-prompt.js';
import type { AgentToolsCatalogMeta } from './tools/agent-tools/group-builder.js';

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

// ---------------------------------------------------------------------------
// agentToolsMeta parameter — new tests for the agent-tools integration
// ---------------------------------------------------------------------------

describe('buildSystemPromptForCfg — agentToolsMeta parameter (agent-tools integration)', () => {
  let tmpDir: string;
  let basePath: string;

  // Shared catalog meta fixtures ──────────────────────────────────────────

  /** No umbrella, no registered tools — represents "agent-tools disabled". */
  const emptyMeta: AgentToolsCatalogMeta = {
    umbrellaEnabled: false,
    registered: [],
  };

  /** All six tools registered — represents "agent-tools fully enabled". */
  const fullMeta: AgentToolsCatalogMeta = {
    umbrellaEnabled: true,
    registered: [
      { name: 'agt_glob',       description: 'Fast file-pattern matching.' },
      { name: 'agt_grep',       description: 'Fast regex content search.' },
      { name: 'agt_multiedit',  description: 'Apply ordered edits atomically.' },
      { name: 'agt_patch',      description: 'Apply a patch envelope.' },
      { name: 'agt_todo_read',  description: 'Read the session todo list.' },
      { name: 'agt_todo_write', description: 'Replace the session todo list.' },
    ],
  };

  beforeAll(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-sysprompt-agttool-'));
    basePath = path.join(tmpDir, 'base.md');
    await fsp.writeFile(basePath, 'BASE PROMPT TEXT\n');
  });

  afterAll(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  // -- Regression: byte-stability when no agent-tools block is present ----

  it('regression: undefined agentToolsMeta produces same output as pre-integration (no agent-tools block)', async () => {
    // Call without agentToolsMeta (the optional third argument omitted).
    const withoutMeta = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined },
      '',
    );
    // Call with agentToolsMeta explicitly undefined — must be byte-identical.
    const withUndefined = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined },
      '',
      undefined,
    );
    expect(withUndefined).toBe(withoutMeta);
    expect(withoutMeta).toContain('BASE PROMPT TEXT');
    // Must NOT contain the agent-tools section header.
    expect(withoutMeta).not.toContain('Optional standard tools (agent-tools pack)');
  });

  it('regression: emptyMeta (umbrella OFF, registered=[]) produces byte-stable output identical to no-meta case', async () => {
    const withoutMeta = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined },
      '',
    );
    const withEmptyMeta = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined },
      '',
      emptyMeta,
    );
    // An empty meta must produce the same output as no meta at all.
    // The caller contract: when no tools are registered, the prompt is byte-identical
    // to the pre-integration prompt — the block assembler returns '' for empty meta.
    expect(withEmptyMeta).toBe(withoutMeta);
    expect(withEmptyMeta).not.toContain('Optional standard tools (agent-tools pack)');
  });

  // -- Unit: fullMeta injects the agent-tools block -----------------------

  it('unit: fullMeta (all 6 tools registered) includes the agent-tools section header', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined },
      '',
      fullMeta,
    );
    expect(out).toContain('## Optional standard tools (agent-tools pack)');
  });

  it('unit: fullMeta output contains all registered tool names', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined },
      '',
      fullMeta,
    );
    for (const entry of fullMeta.registered) {
      expect(out).toContain(`\`${entry.name}\``);
    }
  });

  it('unit: fullMeta agent-tools block appears AFTER the capabilities section', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined },
      'CAPS SECTION',
      fullMeta,
    );
    const capsPos = out.indexOf('CAPS SECTION');
    const blockPos = out.indexOf('## Optional standard tools (agent-tools pack)');
    expect(capsPos).toBeGreaterThan(-1);
    expect(blockPos).toBeGreaterThan(capsPos);
  });

  it('unit: fullMeta agent-tools block appears BEFORE the user-addendum (--system)', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: 'user rule X', systemAppendFile: undefined },
      '',
      fullMeta,
    );
    const blockPos = out.indexOf('## Optional standard tools (agent-tools pack)');
    const userPos  = out.indexOf('## User-provided instructions');
    expect(blockPos).toBeGreaterThan(-1);
    expect(userPos).toBeGreaterThan(blockPos);
  });
});
