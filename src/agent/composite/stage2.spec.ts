/**
 * Co-located tests for `stage2.ts` (plan-006 Phase 6, U-SYNTH).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { composeStage } from './stage2.js';
import { STAGE2_TEMPLATE_VERSION } from './prompts.js';
import type { AgentConfig } from '../../config/agent-config.js';
import type { Logger } from '../logging.js';
import type { Stage1Distillation } from './types.js';

const events: Array<{ kind: string; [k: string]: unknown }> = [];

function makeLogger(): Logger {
  return {
    log: (e: unknown) => {
      events.push(e as { kind: string; [k: string]: unknown });
    },
    flush: async () => {},
    close: async () => {},
    currentLogPath: '/dev/null',
    currentSessionId: 'test-session',
  };
}

function makeCfg(provider = 'anthropic', model = 'claude-sonnet-4-6'): AgentConfig {
  return { provider, model } as unknown as AgentConfig;
}

function makeDistillation(name: string, body: string): Stage1Distillation {
  return {
    memberName: name,
    content: body,
    modelId: 'anthropic:claude-sonnet-4-6',
    templateVersion: 'stage1-v1',
    createdAt: '2026-05-02T00:00:00.000Z',
  };
}

const VALID_BODY = [
  '## Synopsis',
  'Composes file ops with email send.',
  '',
  '## Cross-tool intents',
  '- send a file via email',
  '',
  '## Parameter glossary',
  'path: filesystem path',
  '',
  '## Cross-tool recipes',
  '### email a file',
  'Use file-cli to read, outlook-cli to send.',
  '```sh',
  'file-cli read x | outlook-cli send --to <recipient>',
  '```',
  '',
  '## Constraints and notes',
  '- requires outlook auth',
].join('\n');

function makeStubLLM(responseText: string = VALID_BODY): {
  invoke: (msgs: unknown[]) => Promise<AIMessage>;
  invocations: number;
  lastMessages: unknown[] | null;
} {
  let invocations = 0;
  let lastMessages: unknown[] | null = null;
  return {
    invocations: 0,
    lastMessages: null,
    async invoke(msgs: unknown[]) {
      invocations += 1;
      this.invocations = invocations;
      lastMessages = msgs;
      this.lastMessages = msgs;
      return new AIMessage({
        content: responseText,
        usage_metadata: {
          input_tokens: 500,
          output_tokens: 800,
          total_tokens: 1300,
          input_token_details: { cache_read: 100, cache_creation: 200 },
        } as unknown as AIMessage['usage_metadata'],
      });
    },
  };
}

beforeEach(() => {
  events.length = 0;
});

describe('composeStage', () => {
  const baseInputs = {
    compositeName: 'email-assistant',
    members: [
      { name: 'file-cli', distillation: makeDistillation('file-cli', '{"synopsis": "files"}') },
      { name: 'outlook-cli', distillation: makeDistillation('outlook-cli', '{"synopsis": "email"}') },
    ],
    cliAgentVersion: '0.3.0',
    synthesisModel: 'anthropic:claude-sonnet-4-6',
    activeProfile: null,
    nowIso: '2026-05-02T00:00:00.000Z',
  } as const;

  it('returns a validated body, locked template version, and provider family', async () => {
    const llm = makeStubLLM();
    const result = await composeStage({
      ...baseInputs,
      cfg: makeCfg(),
      llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
      logger: makeLogger(),
    });
    expect(result.markdownBody).toContain('## Synopsis');
    expect(result.markdownBody).toContain('## Cross-tool recipes');
    expect(result.templateVersion).toBe(STAGE2_TEMPLATE_VERSION);
    expect(result.providerFamily).toBe('anthropic');
    expect(result.tokenUsage.inputTokens).toBe(500);
    expect(result.tokenUsage.outputTokens).toBe(800);
    expect(result.tokenUsage.cachedTokens).toBe(100);
    expect(result.tokenUsage.cacheCreationTokens).toBe(200);
    expect(result.promptDigest16).toMatch(/^[a-f0-9]{16}$/);
  });

  it('emits composite_stage2_run JSONL event', async () => {
    const llm = makeStubLLM();
    await composeStage({
      ...baseInputs,
      cfg: makeCfg(),
      llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
      logger: makeLogger(),
    });
    const ev = events.find((e) => e.kind === 'composite_stage2_run');
    expect(ev).toBeDefined();
    expect(ev!['compositeName']).toBe('email-assistant');
    expect(ev!['providerFamily']).toBe('anthropic');
    expect(ev!['providerCacheRead']).toBe(100);
    expect(ev!['providerCacheCreation']).toBe(200);
  });

  it('rejects an LLM body that is missing the Synopsis section', async () => {
    const llm = makeStubLLM('## Other section\nbody');
    await expect(
      composeStage({
        ...baseInputs,
        cfg: makeCfg(),
        llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  it('rejects an LLM body containing AUTO-GENERATED markers', async () => {
    const bad = `<!-- AUTO-GENERATED:START hash=x -->\n## Synopsis\nbody\n<!-- AUTO-GENERATED:END -->`;
    const llm = makeStubLLM(bad);
    await expect(
      composeStage({
        ...baseInputs,
        cfg: makeCfg(),
        llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  it('rejects an empty LLM body', async () => {
    const llm = makeStubLLM('');
    await expect(
      composeStage({
        ...baseInputs,
        cfg: makeCfg(),
        llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  it('throws UsageError exit 2 on pre-call budget overrun', async () => {
    const llm = makeStubLLM();
    await expect(
      composeStage({
        ...baseInputs,
        cfg: makeCfg(),
        llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
        logger: makeLogger(),
        budgetTokens: 1, // absurdly small — pre-call estimate exceeds it
      }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(llm.invocations).toBe(0);
  });

  it('throws UsageError exit 2 on post-call budget overrun', async () => {
    const llm = makeStubLLM();
    // Pre-call estimate is small (~hundreds of tokens). Set budget
    // such that pre-call passes but post-call (input 500 + output
    // 800) trips it.
    await expect(
      composeStage({
        ...baseInputs,
        cfg: makeCfg(),
        llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
        logger: makeLogger(),
        budgetTokens: 800,
      }),
    ).rejects.toMatchObject({ exitCode: 2 });
    expect(llm.invocations).toBe(1);
  });

  it('dryRun returns assembled messages and never invokes the LLM', async () => {
    const llm = makeStubLLM();
    const r = await composeStage({
      ...baseInputs,
      cfg: makeCfg(),
      llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
      logger: makeLogger(),
      dryRun: true,
    });
    expect(r.markdownBody).toBe('');
    expect(r.dryRunMessages).toBeDefined();
    expect(r.dryRunMessages).toHaveLength(3);
    expect(llm.invocations).toBe(0);
  });

  it('counts tokensAlreadyConsumed against the budget', async () => {
    const llm = makeStubLLM();
    await expect(
      composeStage({
        ...baseInputs,
        cfg: makeCfg(),
        llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
        logger: makeLogger(),
        budgetTokens: 100, // already consumed dwarfs cap
        tokensAlreadyConsumed: 1_000,
      }),
    ).rejects.toMatchObject({ exitCode: 2 });
  });

  it('passes through messages with anthropic cache_control on prefix when provider is anthropic', async () => {
    const llm = makeStubLLM();
    await composeStage({
      ...baseInputs,
      cfg: makeCfg('anthropic', 'claude-sonnet-4-6'),
      llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
      logger: makeLogger(),
    });
    const sent = llm.lastMessages as Array<{ content: unknown }>;
    expect(sent).toHaveLength(3);
    // System message — cache marker on its (sole) content block.
    const sysContent = sent[0]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(sysContent)).toBe(true);
    expect(sysContent[0]!['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
    // Members message — cache marker on the members block.
    const memContent = sent[1]!.content as Array<Record<string, unknown>>;
    expect(memContent[0]!['cache_control']).toEqual({ type: 'ephemeral', ttl: '1h' });
    // Compose-instruction message — NOT marked.
    const composeContent = sent[2]!.content as Array<Record<string, unknown>>;
    expect(composeContent[0]!['cache_control']).toBeUndefined();
  });

  it('does not add cache markers for openai providers', async () => {
    const llm = makeStubLLM();
    await composeStage({
      ...baseInputs,
      cfg: makeCfg('openai', 'gpt-4o'),
      llm: llm as unknown as Parameters<typeof composeStage>[0]['llm'],
      logger: makeLogger(),
    });
    const sent = llm.lastMessages as Array<{ content: unknown }>;
    // System content remains a plain string for openai (no
    // mutation by withSynthesisCache).
    expect(typeof sent[0]!.content).toBe('string');
  });
});
