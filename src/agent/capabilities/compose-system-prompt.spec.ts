/**
 * Tests for the system-prompt composer extension that surfaces the
 * USER-RECIPES block + manRef pointer for each wrapped tool, and falls
 * back to a compact entry (with manRef + recipes-availability hint
 * preserved) when the per-tool byte budget is exceeded.
 *
 * Extended in plan-006 integration gap 6: schema-3 (composite) docs
 * mirrored to capabilitiesDir are consumed transparently by the existing
 * composeCapabilitiesSystemPrompt reader without any code change.
 */
import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { composeCapabilityDoc } from './composeMarkdown.js';
import { composeCapabilitiesSystemPrompt } from './compose-system-prompt.js';
import { composeCompositeDoc } from '../composite/composeCompositeDoc.js';
import { mirrorCompositeDocToCapabilities, writeCompositeDoc } from '../composite/cache.js';
import type { CompositeFrontmatter } from '../composite/types.js';

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

// -----------------------------------------------------------------------
// plan-006 gap 6: schema-3 composite doc mirror consumed by system-prompt
// -----------------------------------------------------------------------

describe('composeCapabilitiesSystemPrompt — schema-3 composite doc transparency', () => {
  /**
   * Build a minimal schema-3 composite doc and mirror it into a
   * capabilitiesDir, then assert that composeCapabilitiesSystemPrompt
   * picks it up and surfaces its USER-RECIPES content (when within budget).
   *
   * This test exercises ADR-CMP-12 end-to-end:
   *   mirrorCompositeDocToCapabilities writes <capabilitiesDir>/<id>.md
   *   composeCapabilitiesSystemPrompt reads <capabilitiesDir>/<id>.md
   *   → the composite's synopsis appears in the generated system prompt.
   */

  function makeCompositeFrontmatter(name: string): CompositeFrontmatter {
    return {
      schemaVersion: 3,
      composite: true,
      compositeName: name,
      members: ['file-cli', 'outlook-cli'],
      memberDigests: {
        'file-cli': 'a1b2c3d4e5f60718',
        'outlook-cli': '0f1e2d3c4b5a6978',
      },
      synthesizedAt: '2026-05-02T00:00:00.000Z',
      syntheticDigest: 'placeholder', // composer recomputes
      cliAgentVersion: '0.3.0',
      synthesisModel: 'anthropic:claude-sonnet-4-6',
      activeProfile: null,
      manRef: null,
      manPagePath: null,
    };
  }

  it('reads a mirrored schema-3 composite doc as a regular tool capability', async () => {
    const dir = await tmp();
    const compositeCapDir = path.join(dir, 'composite');
    await fsp.mkdir(compositeCapDir, { recursive: true });

    const fm = makeCompositeFrontmatter('email-assistant');
    const autoGenBody = [
      '## Synopsis',
      'Combines file-cli and outlook-cli for email workflows.',
      '',
      '## Cross-tool intents',
      '- email a file',
      '- batch file-to-email workflows',
    ].join('\n');

    const compositeDoc = composeCompositeDoc({
      frontmatter: fm,
      autoGenBody,
      userRecipes: 'Recipe: email a file\nUse file-cli read + outlook-cli send.',
    });

    // Write canonical composite doc.
    const canonicalPath = path.join(compositeCapDir, 'email-assistant.md');
    await writeCompositeDoc(canonicalPath, compositeDoc);

    // Mirror into capabilitiesDir (the path composeCapabilitiesSystemPrompt reads from).
    await mirrorCompositeDocToCapabilities(canonicalPath, dir, 'email-assistant');

    // Assert the mirrored file exists.
    const mirrorPath = path.join(dir, 'email-assistant.md');
    expect((await fsp.stat(mirrorPath)).isFile()).toBe(true);

    // Now call composeCapabilitiesSystemPrompt — it should find the mirrored doc.
    const prompt = await composeCapabilitiesSystemPrompt(dir, ['email-assistant'], 65536);

    // The system prompt must contain the composite's synopsis.
    expect(prompt).toContain('email-assistant');
    expect(prompt).toContain('Combines file-cli and outlook-cli for email workflows.');
  });

  it('embeds USER-RECIPES content from a schema-3 composite doc (within budget)', async () => {
    const dir = await tmp();
    const compositeCapDir = path.join(dir, 'composite');
    await fsp.mkdir(compositeCapDir, { recursive: true });

    const fm = makeCompositeFrontmatter('workflow-tool');
    const compositeDoc = composeCompositeDoc({
      frontmatter: fm,
      autoGenBody: '## Synopsis\nA multi-tool workflow orchestrator.',
      userRecipes: [
        '### Step 1: Read file',
        '```sh',
        'file-cli read report.txt',
        '```',
        '',
        '### Step 2: Send email',
        '```sh',
        'outlook-cli send --to recipient@example.com',
        '```',
      ].join('\n'),
    });

    const canonicalPath = path.join(compositeCapDir, 'workflow-tool.md');
    await writeCompositeDoc(canonicalPath, compositeDoc);
    await mirrorCompositeDocToCapabilities(canonicalPath, dir, 'workflow-tool');

    const prompt = await composeCapabilitiesSystemPrompt(dir, ['workflow-tool'], 65536);

    // USER-RECIPES must be embedded in the system prompt (within budget).
    expect(prompt).toContain('**User recipes:**');
    expect(prompt).toContain('Read file');
    expect(prompt).toContain('file-cli read report.txt');
  });

  it('schema-3 composite doc listed alongside a schema-2 member doc — both appear', async () => {
    const dir = await tmp();
    const compositeCapDir = path.join(dir, 'composite');
    await fsp.mkdir(compositeCapDir, { recursive: true });

    // Place a schema-2 doc for 'file-cli'.
    await fsp.writeFile(
      path.join(dir, 'file-cli.md'),
      seed({ tool: 'file-cli', topLevelHelp: 'usage: file-cli [sub]' }),
      'utf8',
    );

    // Place a schema-3 composite mirrored as 'email-assistant'.
    const fm = makeCompositeFrontmatter('email-assistant');
    const compositeDoc = composeCompositeDoc({
      frontmatter: fm,
      autoGenBody: '## Synopsis\nComposite of file-cli and outlook-cli.',
    });
    const canonicalPath = path.join(compositeCapDir, 'email-assistant.md');
    await writeCompositeDoc(canonicalPath, compositeDoc);
    await mirrorCompositeDocToCapabilities(canonicalPath, dir, 'email-assistant');

    // Both tools in one prompt call.
    const prompt = await composeCapabilitiesSystemPrompt(
      dir,
      ['file-cli', 'email-assistant'],
      65536,
    );

    // Both tools must appear in the assembled system prompt.
    expect(prompt).toContain('file-cli');
    expect(prompt).toContain('email-assistant');
    expect(prompt).toContain('Composite of file-cli and outlook-cli.');
  });
});
