/**
 * Tests for the system-prompt composer extension that surfaces the
 * USER-RECIPES block + manRef pointer for each wrapped tool, and falls
 * back to a compact entry (with manRef + recipes-availability hint
 * preserved) when the per-tool byte budget is exceeded.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { composeCapabilityDoc } from './composeMarkdown.js';
import { composeCapabilitiesSystemPrompt } from './compose-system-prompt.js';

async function tmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-csp-'));
}

function seed(opts: {
  tool: string;
  manRef?: string | null;
  recipesBody?: string;
  notesBody?: string;
  topLevelHelp?: string;
}): string {
  const base = composeCapabilityDoc({
    tool: opts.tool,
    binaryPath: `/usr/bin/${opts.tool}`,
    binaryMtimeMs: 1,
    versionString: 'x',
    versionHash: 'sha256:h',
    introspectionDepth: 1,
    introspectionBytes: 50,
    topLevelHelp: opts.topLevelHelp ?? `usage: ${opts.tool}`,
    subcommands: [],
    manRef: opts.manRef ?? null,
    manPagePath: opts.manRef ? `/man/${opts.tool}.1.gz` : null,
  });
  let edited = base;
  if (opts.recipesBody) {
    edited = edited.replace(
      '<!-- USER-RECIPES:START -->\n<!-- USER-RECIPES:END -->',
      `<!-- USER-RECIPES:START -->\n${opts.recipesBody}\n<!-- USER-RECIPES:END -->`,
    );
  }
  if (opts.notesBody) {
    edited = edited.replace(
      '<!-- USER-NOTES:START -->\n<!-- USER-NOTES:END -->',
      `<!-- USER-NOTES:START -->\n${opts.notesBody}\n<!-- USER-NOTES:END -->`,
    );
  }
  return edited;
}

describe('composeCapabilitiesSystemPrompt — schema-2 extensions', () => {
  it('embeds the manRef inline section for tools with a man page', async () => {
    const dir = await tmp();
    await fsp.writeFile(
      path.join(dir, 'git.md'),
      seed({ tool: 'git', manRef: 'man:1 git' }),
      'utf8',
    );
    const prompt = await composeCapabilitiesSystemPrompt(dir, ['git'], 8192);
    expect(prompt).toContain('## Manual reference');
    expect(prompt).toContain('man 1 git');
  });

  it('embeds the User recipes block when present and within budget', async () => {
    const dir = await tmp();
    await fsp.writeFile(
      path.join(dir, 'git.md'),
      seed({
        tool: 'git',
        recipesBody: '### Commit\n```bash\ngit commit -m "msg"\n```',
      }),
      'utf8',
    );
    const prompt = await composeCapabilitiesSystemPrompt(dir, ['git'], 8192);
    expect(prompt).toContain('**User recipes:**');
    expect(prompt).toContain('git commit -m "msg"');
  });

  it('falls back to compact entry when over budget but keeps manRef + recipes hint', async () => {
    const dir = await tmp();
    // Make the help large to force the over-budget path.
    const big = 'BIG\n'.repeat(500);
    await fsp.writeFile(
      path.join(dir, 'git.md'),
      seed({
        tool: 'git',
        manRef: 'man:1 git',
        topLevelHelp: big,
        recipesBody: '### Commit\n```bash\ngit commit\n```',
      }),
      'utf8',
    );
    const prompt = await composeCapabilitiesSystemPrompt(dir, ['git'], 256);
    expect(prompt).toContain('**Manual:**');
    expect(prompt).toContain('man 1 git');
    expect(prompt).toContain('**User recipes:**');
    expect(prompt).toContain('section: "recipes"');
    // The full recipes body must NOT be embedded in the compact path.
    expect(prompt).not.toContain('git commit\n```');
  });

  it('does not emit recipes hint when recipes block is empty', async () => {
    const dir = await tmp();
    const big = 'BIG\n'.repeat(500);
    await fsp.writeFile(
      path.join(dir, 'git.md'),
      seed({ tool: 'git', topLevelHelp: big }),
      'utf8',
    );
    const prompt = await composeCapabilitiesSystemPrompt(dir, ['git'], 256);
    expect(prompt).not.toContain('**User recipes:**');
  });

  it('omits manRef line when no man page is recorded', async () => {
    const dir = await tmp();
    await fsp.writeFile(
      path.join(dir, 'mytool.md'),
      seed({ tool: 'mytool', manRef: null }),
      'utf8',
    );
    const prompt = await composeCapabilitiesSystemPrompt(dir, ['mytool'], 8192);
    expect(prompt).not.toContain('## Manual reference');
  });
});
