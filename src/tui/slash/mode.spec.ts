/**
 * /mode slash-command tests (plan-015).
 *
 * Registration + dispatch behavior only, with the heavy rebuild seams
 * (LLM factory, tool catalog, system prompt, agent graph) mocked — the
 * structural precedent is registry.spec.ts / resume.spec.ts. The real
 * mode→groups semantics are covered by agent-config-mode.spec.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { findCommand, dispatchSlash, type SlashContext } from './registry.js';
// Side-effect import: /mode registers itself once at module load.
import './mode.js';

vi.mock('../../agent/graph.js', () => ({
  buildAgentGraph: vi.fn(() => ({ rebuilt: true })),
}));
vi.mock('../../agent/providers/registry.js', () => ({
  createLLM: vi.fn(() => ({ llm: true })),
}));
vi.mock('../../agent/tools/registry.js', () => ({
  buildToolCatalog: vi.fn(() => ({
    tools: [],
    agentToolsMeta: { umbrellaEnabled: false, registered: [] },
  })),
}));
vi.mock('../../agent/capabilities/compose-system-prompt.js', () => ({
  composeCapabilitiesSystemPrompt: vi.fn(async () => ''),
}));
vi.mock('../../agent/system-prompt.js', () => ({
  buildSystemPromptForCfg: vi.fn(async () => 'system prompt'),
}));

interface TestController {
  cfg: {
    tools: string[];
    builtinTools: boolean;
    composites: boolean;
    agentTools: { enabled: boolean; tools: Record<string, boolean> };
    capabilitiesDir: string;
    capabilities: { maxBytesPerTool: number };
    maxSteps: number;
  };
  logger: unknown;
  agentGraph: unknown;
}

function makeController(overrides?: Partial<TestController['cfg']>): TestController {
  return {
    cfg: {
      tools: [],
      builtinTools: true,
      composites: true,
      agentTools: { enabled: true, tools: { glob: true } },
      capabilitiesDir: '/tmp/caps',
      capabilities: { maxBytesPerTool: 10240 },
      maxSteps: 25,
      ...(overrides ?? {}),
    },
    logger: { info: () => {} },
    agentGraph: { original: true },
  };
}

function makeCtx(controller: TestController): { ctx: SlashContext; messages: string[] } {
  const messages: string[] = [];
  const ctx: SlashContext = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller: controller as any,
    printSystem: (s) => messages.push(s),
    println: (s) => messages.push(s),
  };
  return { ctx, messages };
}

describe('/mode', () => {
  it('is registered as a slash command', () => {
    const cmd = findCommand('/mode');
    expect(cmd).toBeDefined();
    expect(cmd?.summary).toMatch(/mode/i);
  });

  it('no-arg reports the current mode derived from the group booleans', async () => {
    const c = makeController();
    const { ctx, messages } = makeCtx(c);
    await dispatchSlash('/mode', ctx);
    expect(messages.join('\n')).toMatch(/current mode: composite/);
    expect(c.agentGraph).toEqual({ original: true }); // no rebuild
  });

  it('/mode basic swaps the group booleans and rebuilds the catalog in place', async () => {
    const c = makeController();
    const { ctx, messages } = makeCtx(c);
    await dispatchSlash('/mode basic', ctx);
    expect(c.cfg.builtinTools).toBe(false);
    expect(c.cfg.composites).toBe(false);
    expect(c.cfg.agentTools.enabled).toBe(true);
    // Per-tool flags survive the switch untouched.
    expect(c.cfg.agentTools.tools).toEqual({ glob: true });
    expect(c.agentGraph).toEqual({ rebuilt: true });
    expect(messages.join('\n')).toMatch(/mode: basic\./);
  });

  it('invalid value → error message, no state change (AC-8)', async () => {
    const c = makeController();
    const cfgBefore = c.cfg;
    const { ctx, messages } = makeCtx(c);
    await dispatchSlash('/mode turbo', ctx);
    expect(messages.join('\n')).toMatch(/invalid mode 'turbo'/);
    expect(c.cfg).toBe(cfgBefore);
    expect(c.agentGraph).toEqual({ original: true });
  });

  it('switching to chat with wrapped tools loaded is rejected, no state change', async () => {
    const c = makeController({ tools: ['git', 'gh'] });
    const cfgBefore = c.cfg;
    const { ctx, messages } = makeCtx(c);
    await dispatchSlash('/mode chat', ctx);
    expect(messages.join('\n')).toMatch(/cannot switch to 'chat'.*git, gh/s);
    expect(c.cfg).toBe(cfgBefore);
    expect(c.agentGraph).toEqual({ original: true });
  });

  it('switching to the current mode is a friendly no-op', async () => {
    const c = makeController();
    const { ctx, messages } = makeCtx(c);
    await dispatchSlash('/mode composite', ctx);
    expect(messages.join('\n')).toMatch(/already composite/);
    expect(c.agentGraph).toEqual({ original: true });
  });

  it('tool → composite switch is allowed with wrapped tools loaded', async () => {
    const c = makeController({ tools: ['git'], composites: false });
    const { ctx, messages } = makeCtx(c);
    await dispatchSlash('/mode composite', ctx);
    expect(c.cfg.composites).toBe(true);
    expect(messages.join('\n')).toMatch(/mode: composite\./);
  });
});
