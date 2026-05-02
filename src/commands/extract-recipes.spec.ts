/**
 * Smoke tests for extract-recipes argument validation and the
 * stdout/--write contract. The LLM call itself is not exercised here —
 * that requires real provider credentials. The pure splice helpers are
 * exported via the test boundary.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { runExtractRecipes } from './extract-recipes.js';
import { UsageError, CapabilityError } from '../errors.js';
import * as registry from '../agent/providers/registry.js';

afterEach(() => vi.restoreAllMocks());

describe('runExtractRecipes — input validation', () => {
  it('throws UsageError when --tool is omitted', async () => {
    await expect(runExtractRecipes(undefined, {})).rejects.toBeInstanceOf(UsageError);
  });

  it('throws UsageError when --max-recipes is non-positive', async () => {
    await expect(runExtractRecipes('git', { maxRecipes: 0 })).rejects.toBeInstanceOf(UsageError);
    await expect(runExtractRecipes('git', { maxRecipes: -3 })).rejects.toBeInstanceOf(UsageError);
  });

  it('throws UsageError when default-write encounters a doc with no USER-RECIPES markers', async () => {
    const agentRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-er-'));
    const capDir = path.join(agentRoot, '.tool-agents', 'cli-agent', 'capabilities');
    await fsp.mkdir(capDir, { recursive: true });
    // Seed a doc that has no USER-RECIPES markers (simulates a stale v1
    // doc that someone hand-edited before upgrading).
    await fsp.writeFile(path.join(capDir, 'cat.md'), '# stale doc with no markers\n', 'utf8');
    // Provide a minimal system-prompt.md so loadAgentConfig succeeds.
    await fsp.writeFile(path.join(capDir, 'system-prompt.md'), 'You are a test.\n', 'utf8');

    const origHome = process.env['HOME'];
    process.env['HOME'] = agentRoot;
    process.env['AGENT_PROVIDER'] = 'openai';
    process.env['OPENAI_API_KEY'] = 'sk-test';
    // Stub the LLM so the test never makes a real network call.
    vi.spyOn(registry, 'createLLM').mockReturnValue({
      invoke: async () => ({ content: '### My recipe\n```bash\ncat <file>\n```' }),
    } as unknown as ReturnType<typeof registry.createLLM>);

    try {
      await expect(
        runExtractRecipes('cat', {}),
      ).rejects.toBeInstanceOf(UsageError);
    } finally {
      if (origHome !== undefined) process.env['HOME'] = origHome;
      else delete process.env['HOME'];
      delete process.env['AGENT_PROVIDER'];
      delete process.env['OPENAI_API_KEY'];
    }
  });

  it('default replaces inner USER-RECIPES content', async () => {
    const agentRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-er-'));
    const capDir = path.join(agentRoot, '.tool-agents', 'cli-agent', 'capabilities');
    await fsp.mkdir(capDir, { recursive: true });
    await fsp.writeFile(
      path.join(capDir, 'cat.md'),
      [
        '---', 'tool: cat', 'schemaVersion: 2', '---',
        '<!-- AUTO-GENERATED:START hash=h --><!-- AUTO-GENERATED:END -->',
        '<!-- USER-RECIPES:START -->',
        '### Old recipe',
        '```bash', 'cat -old', '```',
        '<!-- USER-RECIPES:END -->',
        '<!-- USER-NOTES:START -->',
        '<!-- USER-NOTES:END -->',
      ].join('\n'),
      'utf8',
    );
    await fsp.writeFile(path.join(capDir, 'system-prompt.md'), 'You are a test.\n', 'utf8');

    const origHome = process.env['HOME'];
    process.env['HOME'] = agentRoot;
    process.env['AGENT_PROVIDER'] = 'openai';
    process.env['OPENAI_API_KEY'] = 'sk-test';
    vi.spyOn(registry, 'createLLM').mockReturnValue({
      invoke: async () => ({ content: '### Show with line numbers\n```bash\ncat -n <file>\n```' }),
    } as unknown as ReturnType<typeof registry.createLLM>);

    try {
      await runExtractRecipes('cat', {});
      const after = await fsp.readFile(path.join(capDir, 'cat.md'), 'utf8');
      expect(after).toContain('### Show with line numbers');
      expect(after).toContain('cat -n <file>');
      expect(after).not.toContain('### Old recipe');
      expect(after).toContain('<!-- USER-RECIPES:START -->');
      expect(after).toContain('<!-- USER-RECIPES:END -->');
    } finally {
      if (origHome !== undefined) process.env['HOME'] = origHome;
      else delete process.env['HOME'];
      delete process.env['AGENT_PROVIDER'];
      delete process.env['OPENAI_API_KEY'];
    }
  });

  it('--append keeps existing recipes and appends new ones', async () => {
    const agentRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-er-'));
    const capDir = path.join(agentRoot, '.tool-agents', 'cli-agent', 'capabilities');
    await fsp.mkdir(capDir, { recursive: true });
    await fsp.writeFile(
      path.join(capDir, 'cat.md'),
      [
        '---', 'tool: cat', 'schemaVersion: 2', '---',
        '<!-- AUTO-GENERATED:START hash=h --><!-- AUTO-GENERATED:END -->',
        '<!-- USER-RECIPES:START -->',
        '### Original',
        '```bash', 'cat <file>', '```',
        '<!-- USER-RECIPES:END -->',
        '<!-- USER-NOTES:START -->',
        '<!-- USER-NOTES:END -->',
      ].join('\n'),
      'utf8',
    );
    await fsp.writeFile(path.join(capDir, 'system-prompt.md'), 'You are a test.\n', 'utf8');

    const origHome = process.env['HOME'];
    process.env['HOME'] = agentRoot;
    process.env['AGENT_PROVIDER'] = 'openai';
    process.env['OPENAI_API_KEY'] = 'sk-test';
    vi.spyOn(registry, 'createLLM').mockReturnValue({
      invoke: async () => ({ content: '### Number lines\n```bash\ncat -n <file>\n```' }),
    } as unknown as ReturnType<typeof registry.createLLM>);

    try {
      await runExtractRecipes('cat', { append: true });
      const after = await fsp.readFile(path.join(capDir, 'cat.md'), 'utf8');
      expect(after).toContain('### Original');
      expect(after).toContain('### Number lines');
    } finally {
      if (origHome !== undefined) process.env['HOME'] = origHome;
      else delete process.env['HOME'];
      delete process.env['AGENT_PROVIDER'];
      delete process.env['OPENAI_API_KEY'];
    }
  });

  it('throws CapabilityError when capability doc missing', async () => {
    // Point at an empty agent dir so the capability doc lookup fails
    // BEFORE we ever try to instantiate the LLM (which would otherwise
    // require provider credentials in this test env).
    const agentRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-er-'));
    await fsp.mkdir(path.join(agentRoot, 'capabilities'), { recursive: true });

    // The helper resolves capabilities under the user's home agent dir;
    // override HOME to redirect to our temp tree so the lookup is
    // self-contained.
    const origHome = process.env['HOME'];
    process.env['HOME'] = agentRoot;
    process.env['CLI_AGENT_HOME'] = agentRoot; // tolerated even if unused
    try {
      // Stash an absolute capabilitiesDir override via config.json so
      // loadAgentConfig points at the empty tree we just created.
      // (`loadAgentConfig` reads `<HOME>/.tool-agents/cli-agent/...`
      // — but here we provide an explicit `configFile` flag if needed.)
      // Provide minimum env so loadAgentConfig succeeds.
      process.env['AGENT_PROVIDER'] = 'openai';
      process.env['OPENAI_API_KEY'] = 'sk-test';

      await expect(
        runExtractRecipes('does-not-exist', {}),
      ).rejects.toBeInstanceOf(CapabilityError);
    } finally {
      if (origHome !== undefined) process.env['HOME'] = origHome;
      else delete process.env['HOME'];
      delete process.env['CLI_AGENT_HOME'];
      delete process.env['AGENT_PROVIDER'];
      delete process.env['OPENAI_API_KEY'];
    }
  });
});
