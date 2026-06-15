/**
 * Tests for system-prompt.ts: buildSystemPrompt + buildSystemPromptForCfg.
 *
 * Locks in the externalized base-prompt contract:
 *   - buildSystemPrompt is a pure composer: base + built-in-tools block +
 *     capabilities + agent-tools block + custom.
 *   - buildSystemPromptForCfg loads base from cfg.systemPromptPath and
 *     composes the inline (--system) and file (--system-file) addenda
 *     on top, in that order, forwarding cfg.builtinTools.
 *
 * Plan-009 (tool-loading-aware system prompt): the built-in cross-cutting
 * toolkit's instructions (bash_run framing, CORE RULES, OUT-OF-SCOPE, the
 * available-tools list) are NO LONGER baked into the base prompt. They are
 * injected at runtime by buildBuiltinToolsPromptBlock, gated on the umbrella
 * toggle, mirroring the agent-tools (agt_*) block. The base default is now
 * slim + tool-agnostic.
 *
 * Plan-010 (adaptive built-in block): buildBuiltinToolsPromptBlock takes a
 * presence object { builtinTools, bashRun } and assembles the block from
 * composable, gated sections so the prose describes EXACTLY the registered
 * built-in tools — the bash_run framing only when bash_run is bound.
 * buildSystemPromptForCfg derives that presence from the registeredTools arg
 * (the post-scoping tools array). Plan-012 removed file operations from the
 * built-in toolkit (they moved to the agt_ pack as agt_file_*), so there is
 * no longer a mutating-file built-in gate and the built-in block names no
 * file tools — only bash_* + tool_help. These specs were re-recorded.
 *
 * Composition order (when everything is present):
 *   base → built-in-tools block (if builtinTools) → capabilities →
 *   agent-tools block (if agentToolsMeta registers tools) → custom.
 *
 * Extended for agentToolsMeta parameter (agent-tools integration):
 *   - undefined agentToolsMeta → no agent-tools block.
 *   - emptyMeta (umbrella off, no registered tools) → no agent-tools block.
 *   - fullMeta (all six tools registered) → includes the agent-tools block.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildSystemPrompt,
  buildSystemPromptForCfg,
  buildBuiltinToolsPromptBlock,
  BUILTIN_DEFAULT_SYSTEM_PROMPT,
  LEGACY_DEFAULT_SYSTEM_PROMPTS,
} from './system-prompt.js';
import type { AgentToolsCatalogMeta } from './tools/agent-tools/group-builder.js';

/** Full built-in presence (umbrella + bashRun on). */
const FULL_PRESENCE = { builtinTools: true, bashRun: true } as const;
/** Umbrella off — built-in block suppressed entirely. */
const OFF_PRESENCE = { builtinTools: false, bashRun: false } as const;

describe('buildSystemPrompt (pure composer)', () => {
  // With the umbrella off the built-in block is suppressed, so the composer
  // reduces to the historical base + capabilities + custom shape.
  it('returns baseText alone when capabilities/custom empty and umbrella off', async () => {
    const out = await buildSystemPrompt('BASE', '', undefined, undefined, OFF_PRESENCE);
    expect(out).toBe('BASE');
  });

  it('appends capabilities section after a blank line (umbrella off)', async () => {
    const out = await buildSystemPrompt('BASE', 'CAPS', undefined, undefined, OFF_PRESENCE);
    expect(out).toBe('BASE\n\nCAPS');
  });

  it('appends custom text under a User-provided instructions header (umbrella off)', async () => {
    const out = await buildSystemPrompt('BASE', '', 'rule X', undefined, OFF_PRESENCE);
    expect(out).toBe('BASE\n\n## User-provided instructions\n\nrule X');
  });

  it('composes base + capabilities + custom in that order (umbrella off)', async () => {
    const out = await buildSystemPrompt('B', 'C', 'U', undefined, OFF_PRESENCE);
    expect(out).toBe('B\n\nC\n\n## User-provided instructions\n\nU');
  });

  // -- Built-in-tools block gating (plan-009 umbrella) --------------------

  it('umbrella off ⇒ assembled prompt contains NONE of the built-in tool instructions', async () => {
    const out = await buildSystemPrompt(BUILTIN_DEFAULT_SYSTEM_PROMPT, '', undefined, undefined, OFF_PRESENCE);
    expect(out).not.toContain('bash_run');
    expect(out).not.toContain('file_read');
    expect(out).not.toContain('web_search');
    expect(out).not.toContain('## Built-in tools');
  });

  it('umbrella on (full presence) ⇒ the built-in-tools block IS present', async () => {
    const out = await buildSystemPrompt(BUILTIN_DEFAULT_SYSTEM_PROMPT, '', undefined, undefined, FULL_PRESENCE);
    expect(out).toContain('## Built-in tools');
    expect(out).toContain('bash_run');
    expect(out).toContain('tool_help');
    // plan-012: file tools are no longer built-in.
    expect(out).not.toContain('file_read');
  });

  it('builtinPresence omitted ⇒ defaults to full presence ⇒ the built-in-tools block IS present', async () => {
    const out = await buildSystemPrompt(BUILTIN_DEFAULT_SYSTEM_PROMPT, '');
    expect(out).toContain('## Built-in tools');
    expect(out).toContain('bash_run');
  });

  it('built-in block is injected AFTER the base and BEFORE the capabilities section', async () => {
    const out = await buildSystemPrompt('BASE TEXT', 'CAPS SECTION', undefined, undefined, FULL_PRESENCE);
    const basePos = out.indexOf('BASE TEXT');
    const blockPos = out.indexOf('## Built-in tools');
    const capsPos = out.indexOf('CAPS SECTION');
    expect(basePos).toBe(0);
    expect(blockPos).toBeGreaterThan(basePos);
    expect(capsPos).toBeGreaterThan(blockPos);
  });

  // -- buildBuiltinToolsPromptBlock unit (plan-010 adaptive) --------------

  it('umbrella off ⇒ buildBuiltinToolsPromptBlock returns ""', () => {
    expect(buildBuiltinToolsPromptBlock(OFF_PRESENCE)).toBe('');
    expect(buildBuiltinToolsPromptBlock({ builtinTools: false, bashRun: true })).toBe('');
  });

  it('full presence ⇒ self-framed block with bash_run framing + tool_help, NO file tools (plan-012)', () => {
    const block = buildBuiltinToolsPromptBlock(FULL_PRESENCE);
    expect(block.startsWith('\n\n')).toBe(true);
    expect(block).toContain('## Built-in tools');
    // bash_run framing present.
    expect(block).toContain('bash_run');
    expect(block).toContain('confirmed: true');
    // bash inspection tools + tool_help always present.
    expect(block).toContain('bash_list_allowed');
    expect(block).toContain('tool_help');
    // plan-012: file operations are NO LONGER built-in — the block must not
    // mention any file tool (they live in the agent-tools block as agt_file_*).
    expect(block).not.toContain('file_read');
    expect(block).not.toContain('file_list');
    expect(block).not.toContain('file_write');
    expect(block).not.toContain('file_edit');
    expect(block).not.toContain('file_append');
    // plan-011: web is NOT a built-in tool either.
    expect(block).not.toContain('web_search');
    expect(block).not.toContain('web_fetch');
  });

  it('bashRun OFF ⇒ no bash_run framing, but bash inspection + tool_help + "not available" note', () => {
    const block = buildBuiltinToolsPromptBlock({ builtinTools: true, bashRun: false });
    expect(block).toContain('## Built-in tools');
    // No bash_run framing.
    expect(block).not.toContain('bash_run');
    // bash inspection tools + tool_help ARE described.
    expect(block).toContain('bash_list_allowed');
    expect(block).toContain('tool_help');
    // plan-012: no file tools anywhere.
    expect(block).not.toContain('file_read');
    expect(block).not.toContain('file_write');
    // plan-011: web is not built-in.
    expect(block).not.toContain('web_search');
    // Explicit note that no commands are allow-listed.
    expect(block).toContain('No local commands are allow-listed');
    // plan-012: the built-in block no longer carries an --allow-mutations
    // / file-mutation OUT-OF-SCOPE line (file ops left the toolkit).
    expect(block).not.toContain('--allow-mutations');
  });

  it('bashRun ON ⇒ bash_run framing + OUT-OF-SCOPE shell-features line, still NO file tools', () => {
    const block = buildBuiltinToolsPromptBlock({ builtinTools: true, bashRun: true });
    expect(block).toContain('bash_run');
    expect(block).toContain('confirmed: true');
    // OUT-OF-SCOPE shell-features caveat is present when bash_run is bound.
    expect(block).toContain('OUT-OF-SCOPE');
    expect(block).toContain('shell features');
    // No file tools.
    expect(block).not.toContain('file_read');
    expect(block).not.toContain('file_write');
    // tool_help still described.
    expect(block).toContain('tool_help');
  });

  it('bashRun OFF ⇒ no OUT-OF-SCOPE section (nothing left to scope once file ops moved out)', () => {
    const block = buildBuiltinToolsPromptBlock({ builtinTools: true, bashRun: false });
    expect(block).not.toContain('bash_run');
    // With no bash_run and no file tools, the OUT-OF-SCOPE header is omitted
    // entirely rather than left dangling.
    expect(block).not.toContain('OUT-OF-SCOPE');
  });

  // -- Slim default + legacy migration constant ---------------------------

  it('built-in default constant is exported, slim, tool-agnostic, and non-empty', () => {
    expect(BUILTIN_DEFAULT_SYSTEM_PROMPT.length).toBeGreaterThan(100);
    expect(BUILTIN_DEFAULT_SYSTEM_PROMPT).toContain('cli-agent');
    // The slim default must NOT carry any tool-specific prose — that now
    // lives in the runtime built-in-tools block.
    expect(BUILTIN_DEFAULT_SYSTEM_PROMPT).not.toContain('bash_run');
    expect(BUILTIN_DEFAULT_SYSTEM_PROMPT).not.toContain('file_read');
    expect(BUILTIN_DEFAULT_SYSTEM_PROMPT).not.toContain('web_search');
    expect(BUILTIN_DEFAULT_SYSTEM_PROMPT).not.toContain('CORE RULES');
  });

  it('LEGACY_DEFAULT_SYSTEM_PROMPTS[0] is the pre-plan-009 default (carries the moved tool prose)', () => {
    expect(LEGACY_DEFAULT_SYSTEM_PROMPTS.length).toBeGreaterThanOrEqual(1);
    const legacy = LEGACY_DEFAULT_SYSTEM_PROMPTS[0];
    expect(legacy).toContain('bash_run');
    expect(legacy).toContain('three general-purpose tools');
    // The legacy default is distinct from the new slim default.
    expect(legacy).not.toBe(BUILTIN_DEFAULT_SYSTEM_PROMPT);
  });

  // -- No-tools safety notice (toolless-session fabrication guard) ---------
  // When NO tools are registered (every group disabled, or scoped to nothing)
  // the base identity still says the agent "invokes external CLI tools", yet
  // the model has no tools. Without an explicit notice the model fabricates
  // tool output (e.g. a directory listing). The notice forbids that.

  it('noToolsAvailable=true ⇒ injects the no-tools / anti-fabrication notice right after the base', async () => {
    const out = await buildSystemPrompt('BASE', '', undefined, undefined, OFF_PRESENCE, true);
    expect(out.startsWith('BASE')).toBe(true);
    expect(out).toContain('No tools are enabled');
    expect(out).toContain('NEVER fabricate');
  });

  it('noToolsAvailable=false (default) ⇒ no notice even with the umbrella off', async () => {
    const out = await buildSystemPrompt('BASE', '', undefined, undefined, OFF_PRESENCE);
    expect(out).not.toContain('No tools are enabled');
    expect(out).not.toContain('NEVER fabricate');
  });

  it('noToolsAvailable=true with tools present (defensive) still injects the notice exactly once', async () => {
    const out = await buildSystemPrompt('BASE', '', undefined, undefined, FULL_PRESENCE, true);
    const occurrences = out.split('No tools are enabled').length - 1;
    expect(occurrences).toBe(1);
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

  it('AC-2: builtinTools=false + a registered tool ⇒ base + capSection (no built-in block, no no-tools notice)', async () => {
    // Byte-equivalence of base+caps holds when there IS a tool but no built-in
    // block (e.g. an agt_* tool keeps the session non-toolless). Passing one
    // registered tool keeps `registeredTools` non-empty so the no-tools notice
    // is not injected, isolating the "no built-in block" contract.
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
      'CAPS',
      undefined,
      [{ name: 'agt_glob' }],
    );
    expect(out).toBe('CUSTOM BASE\n\n\nCAPS');
  });

  it('empty registered toolset ⇒ injects the no-tools / anti-fabrication notice', async () => {
    // Reproduces the --no-builtin-tools --no-agent-tools --no-composites case:
    // zero registered tools. The model must be told it has no tools and must
    // not fabricate command/file output.
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
      '',
      { umbrellaEnabled: false, registered: [] },
      [],
    );
    expect(out).toContain('No tools are enabled');
    expect(out).toContain('NEVER fabricate');
    expect(out).not.toContain('## Built-in tools');
  });

  it('non-empty registered toolset ⇒ NO no-tools notice', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: true },
      '',
      undefined,
      [{ name: 'tool_help' }],
    );
    expect(out).not.toContain('No tools are enabled');
    expect(out).not.toContain('NEVER fabricate');
  });

  it('umbrella on ⇒ built-in block present; umbrella off ⇒ absent', async () => {
    // builtinTools:true ⇒ the block IS present (its content adapts to the
    // registeredTools). Pass a realistic non-empty catalog so the no-tools
    // notice (toolless guard) is not triggered.
    const withTools = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: true },
      '',
      undefined,
      [{ name: 'bash_list_allowed' }, { name: 'bash_which' }, { name: 'tool_help' }],
    );
    expect(withTools).toContain('## Built-in tools');

    const withoutTools = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
      '',
    );
    expect(withoutTools).not.toContain('## Built-in tools');
    expect(withoutTools).not.toContain('bash_run');
  });

  // -- plan-010: presence derived from the registeredTools arg ------------

  it('registeredTools WITHOUT bash_run ⇒ no bash_run framing; bash inspection + tool_help present', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: true },
      '',
      undefined,
      [
        { name: 'bash_list_allowed' },
        { name: 'bash_which' },
        { name: 'tool_help' },
      ],
    );
    expect(out).toContain('## Built-in tools');
    expect(out).not.toContain('bash_run');
    // plan-012: file tools are not built-in, so even when the (now agt_)
    // file tools are registered elsewhere, the built-in block never names them.
    expect(out).not.toContain('file_read');
    expect(out).not.toContain('file_write');
    // bash inspection tools + tool_help + the "not available" note are present.
    expect(out).toContain('bash_list_allowed');
    expect(out).toContain('tool_help');
    expect(out).toContain('No local commands are allow-listed');
  });

  it('registeredTools INCLUDING bash_run ⇒ bash_run framing present, still NO file tools', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: true },
      '',
      undefined,
      [
        { name: 'bash_list_allowed' },
        { name: 'bash_which' },
        { name: 'bash_run' },
        { name: 'tool_help' },
      ],
    );
    expect(out).toContain('## Built-in tools');
    expect(out).toContain('bash_run');
    expect(out).toContain('confirmed: true');
    // plan-012: no file tools in the built-in block.
    expect(out).not.toContain('file_write');
    expect(out).not.toContain('file_read');
    expect(out).not.toContain('No local commands are allow-listed');
  });

  it('AC-8: --system inline text is appended under the User-provided header', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: 'extra rule', systemAppendFile: undefined, builtinTools: false },
      '',
    );
    expect(out).toContain('## User-provided instructions');
    expect(out).toContain('extra rule');
    expect(out.startsWith('CUSTOM BASE')).toBe(true);
  });

  it('--system-file contents are appended', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: appendPath, builtinTools: false },
      '',
    );
    expect(out).toContain('FILE APPEND');
  });

  it('--system-file + --system are concatenated (file first, then inline)', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: 'inline part', systemAppendFile: appendPath, builtinTools: false },
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
        { systemPromptPath: '/nonexistent/path/foo.md', systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
        '',
      ),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// agentToolsMeta parameter — tests for the agent-tools integration
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

  // -- Regression: no agent-tools block when no tools are registered ------
  // builtinTools=false isolates these to the agent-tools block specifically.

  it('regression: undefined agentToolsMeta adds no agent-tools block', async () => {
    const withoutMeta = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
      '',
    );
    const withUndefined = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
      '',
      undefined,
    );
    expect(withUndefined).toBe(withoutMeta);
    expect(withoutMeta).toContain('BASE PROMPT TEXT');
    expect(withoutMeta).not.toContain('Optional standard tools (agent-tools pack)');
  });

  it('regression: emptyMeta (umbrella OFF, registered=[]) produces output identical to no-meta case', async () => {
    const withoutMeta = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
      '',
    );
    const withEmptyMeta = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
      '',
      emptyMeta,
    );
    expect(withEmptyMeta).toBe(withoutMeta);
    expect(withEmptyMeta).not.toContain('Optional standard tools (agent-tools pack)');
  });

  // -- Unit: fullMeta injects the agent-tools block -----------------------

  it('unit: fullMeta (all 6 tools registered) includes the agent-tools section header', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
      '',
      fullMeta,
    );
    expect(out).toContain('## Optional standard tools (agent-tools pack)');
  });

  it('unit: fullMeta output contains all registered tool names', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
      '',
      fullMeta,
    );
    for (const entry of fullMeta.registered) {
      expect(out).toContain(`\`${entry.name}\``);
    }
  });

  it('plan-011: agt_web_search / agt_web_fetch render in the agent-tools block (not the built-in block)', async () => {
    const webMeta: AgentToolsCatalogMeta = {
      umbrellaEnabled: true,
      registered: [
        { name: 'agt_web_search', description: 'Search the public internet. Never fabricate URLs.' },
        { name: 'agt_web_fetch', description: 'Fetch a URL and return readable text. Never fabricate URLs.' },
      ],
    };
    // builtinTools:true so the built-in block IS present — proving web text
    // appears only via the agent-tools block, never the built-in one.
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: true },
      '',
      webMeta,
    );
    expect(out).toContain('## Optional standard tools (agent-tools pack)');
    expect(out).toContain('`agt_web_search`');
    expect(out).toContain('`agt_web_fetch`');
    // The "never fabricate URLs" guidance now rides on the agt_web_* descriptions.
    expect(out).toContain('Never fabricate URLs');
    // The built-in block is present but mentions NO web tool.
    expect(out).toContain('## Built-in tools');
    const builtinBlock = out.slice(
      out.indexOf('## Built-in tools'),
      out.indexOf('## Optional standard tools (agent-tools pack)'),
    );
    expect(builtinBlock).not.toContain('web_search');
    expect(builtinBlock).not.toContain('web_fetch');
  });

  it('plan-012: agt_file_* render in the agent-tools block, never the built-in block', async () => {
    const fileMeta: AgentToolsCatalogMeta = {
      umbrellaEnabled: true,
      registered: [
        { name: 'agt_file_read', description: 'Read the contents of a plain-text file on disk inside the allowed file root.' },
        { name: 'agt_file_list', description: 'List files in a directory inside the allowed file root.' },
        { name: 'agt_file_write', description: '[MUTATING] Overwrite a file with new content. Requires confirmed: true.' },
        { name: 'agt_file_edit', description: '[MUTATING] Find and replace text in a file. Requires confirmed: true.' },
        { name: 'agt_file_append', description: '[MUTATING] Append content to an existing file. Requires confirmed: true.' },
      ],
    };
    // builtinTools:true so the built-in block IS present — proving file text
    // appears only via the agent-tools block, never the built-in one.
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: true },
      '',
      fileMeta,
    );
    expect(out).toContain('## Optional standard tools (agent-tools pack)');
    expect(out).toContain('`agt_file_read`');
    expect(out).toContain('`agt_file_list`');
    expect(out).toContain('`agt_file_write`');
    expect(out).toContain('`agt_file_edit`');
    expect(out).toContain('`agt_file_append`');
    // The built-in block is present but mentions NO file tool — neither the
    // old file_* names nor the new agt_file_* names.
    expect(out).toContain('## Built-in tools');
    const builtinBlock = out.slice(
      out.indexOf('## Built-in tools'),
      out.indexOf('## Optional standard tools (agent-tools pack)'),
    );
    expect(builtinBlock).not.toContain('file_read');
    expect(builtinBlock).not.toContain('file_write');
    expect(builtinBlock).not.toContain('file_edit');
    expect(builtinBlock).not.toContain('file_append');
  });

  it('unit: fullMeta agent-tools block appears AFTER the capabilities section', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: undefined, systemAppendFile: undefined, builtinTools: false },
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
      { systemPromptPath: basePath, systemAppendText: 'user rule X', systemAppendFile: undefined, builtinTools: false },
      '',
      fullMeta,
    );
    const blockPos = out.indexOf('## Optional standard tools (agent-tools pack)');
    const userPos  = out.indexOf('## User-provided instructions');
    expect(blockPos).toBeGreaterThan(-1);
    expect(userPos).toBeGreaterThan(blockPos);
  });

  // -- Full composition order with builtin block on -----------------------

  it('full order: base → built-in block → capabilities → agent-tools → custom', async () => {
    const out = await buildSystemPromptForCfg(
      { systemPromptPath: basePath, systemAppendText: 'user rule X', systemAppendFile: undefined, builtinTools: true },
      'CAPS SECTION',
      fullMeta,
    );
    const basePos    = out.indexOf('BASE PROMPT TEXT');
    const builtinPos = out.indexOf('## Built-in tools');
    const capsPos    = out.indexOf('CAPS SECTION');
    const agtPos     = out.indexOf('## Optional standard tools (agent-tools pack)');
    const userPos    = out.indexOf('## User-provided instructions');
    expect(basePos).toBe(0);
    expect(builtinPos).toBeGreaterThan(basePos);
    expect(capsPos).toBeGreaterThan(builtinPos);
    expect(agtPos).toBeGreaterThan(capsPos);
    expect(userPos).toBeGreaterThan(agtPos);
  });
});
