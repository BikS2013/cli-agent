/**
 * tool_help section dispatch tests, focused on the new schema-2
 * sections (`recipes`, `manref`).
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { createToolHelpTool } from './tool-help-tool.js';
import { composeCapabilityDoc } from '../capabilities/composeMarkdown.js';
import type { AgentConfig } from '../../config/agent-config.js';

async function tmpDirWith(toolName: string, opts: {
  manRef?: string | null;
  recipesBody?: string;
} = {}): Promise<{ dir: string; cfg: AgentConfig }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-th-'));
  let doc = composeCapabilityDoc({
    tool: toolName,
    binaryPath: `/usr/bin/${toolName}`,
    binaryMtimeMs: 1,
    versionString: 'x',
    versionHash: 'sha256:h',
    introspectionDepth: 1,
    introspectionBytes: 50,
    topLevelHelp: `usage: ${toolName}`,
    subcommands: [],
    manRef: opts.manRef ?? null,
    manPagePath: opts.manRef ? `/man/${toolName}.1.gz` : null,
  });
  if (opts.recipesBody) {
    doc = doc.replace(
      '<!-- USER-RECIPES:START -->\n<!-- USER-RECIPES:END -->',
      `<!-- USER-RECIPES:START -->\n${opts.recipesBody}\n<!-- USER-RECIPES:END -->`,
    );
  }
  await fsp.writeFile(path.join(dir, `${toolName}.md`), doc, 'utf8');
  const cfg = { capabilitiesDir: dir, perToolBudgetBytes: 8192 } as unknown as AgentConfig;
  return { dir, cfg };
}

async function callSection(
  cfg: AgentConfig,
  tool: string,
  section: 'recipes' | 'manref',
): Promise<{ content: string }> {
  const t = createToolHelpTool(cfg);
  const out = (await t.func({ tool, section } as never, undefined as never)) as string;
  return JSON.parse(out) as { content: string };
}

describe('tool_help — new sections', () => {
  it('section=recipes returns user-recipes body when present', async () => {
    const { cfg } = await tmpDirWith('git', {
      recipesBody: '### Commit\n```bash\ngit commit\n```',
    });
    const result = await callSection(cfg, 'git', 'recipes');
    expect(result.content).toContain('### Commit');
    expect(result.content).toContain('git commit');
  });

  it('section=recipes returns empty string when block is empty', async () => {
    const { cfg } = await tmpDirWith('git');
    const result = await callSection(cfg, 'git', 'recipes');
    expect(result.content).toBe('');
  });

  it('section=manref returns manual-reference body when manRef present', async () => {
    const { cfg } = await tmpDirWith('git', { manRef: 'man:1 git' });
    const result = await callSection(cfg, 'git', 'manref');
    expect(result.content).toContain('man 1 git');
    expect(result.content).toContain('man:1 git');
  });

  it('section=manref returns empty string when no man page recorded', async () => {
    const { cfg } = await tmpDirWith('mytool');
    const result = await callSection(cfg, 'mytool', 'manref');
    expect(result.content).toBe('');
  });
});
