/**
 * Co-located tests for `synthesizer.ts` (plan-006 Phase 6, U-SYNTH).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import { synthesizeComposite } from './synthesizer.js';
import type { AgentConfig } from '../../config/agent-config.js';
import type { Logger } from '../logging.js';
import type { SynthesisInputs } from './types.js';

let tmpDir: string;
let capabilitiesDir: string;
let distillDir: string;
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

function makeCfg(): AgentConfig {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    capabilitiesDir,
    compositeDistillDir: distillDir,
  } as unknown as AgentConfig;
}

const STAGE1_JSON_FILE = JSON.stringify({
  synopsis: 'A small CLI for files.',
  intents: ['list', 'read'],
  subcommands: [{ name: 'ls', purpose: 'list directory' }],
  flags: [{ name: '--long', purpose: 'long format' }],
  examples: [{ command: 'file-cli ls /tmp', explanation: 'list /tmp' }],
  constraints: ['no auth'],
});

const STAGE1_JSON_OUTLOOK = JSON.stringify({
  synopsis: 'Reads and sends email through Outlook.',
  intents: ['send', 'read'],
  subcommands: [{ name: 'send', purpose: 'send email' }],
  flags: [{ name: '--to', purpose: 'recipient address' }],
  examples: [{ command: 'outlook-cli send --to a@b.c', explanation: 'send empty email' }],
  constraints: ['requires outlook auth'],
});

const STAGE2_BODY = [
  '## Synopsis',
  'Composes file ops with email send.',
  '',
  '## Cross-tool intents',
  '- email a file',
  '',
  '## Parameter glossary',
  'path: filesystem path',
  '',
  '## Cross-tool recipes',
  '### email a file',
  'Use file-cli read + outlook-cli send.',
  '```sh',
  'file-cli read x | outlook-cli send --to <recipient>',
  '```',
  '',
  '## Constraints and notes',
  '- requires outlook auth',
].join('\n');

function makeStubLLM(): {
  invoke: (msgs: unknown[]) => Promise<AIMessage>;
  invocations: number;
  responses: string[];
} {
  let invocations = 0;
  // The stub returns Stage-1 JSON for the first N calls (one per
  // member) and Stage-2 markdown for the final call. The
  // synthesizer issues all Stage-1 calls in parallel via
  // Promise.all, then a single Stage-2 call.
  return {
    invocations: 0,
    responses: [],
    async invoke(msgs: unknown[]) {
      invocations += 1;
      this.invocations = invocations;
      // Probe the user message text to decide which stage we're in.
      const last = msgs[msgs.length - 1] as { content: unknown };
      const userText = typeof last.content === 'string'
        ? last.content
        : Array.isArray(last.content)
          ? last.content
              .map((b: unknown) => {
                const bb = b as { text?: unknown };
                return typeof bb.text === 'string' ? bb.text : '';
              })
              .join('')
          : '';
      let response: string;
      if (userText.includes('## Member tool: file-cli')) {
        response = STAGE1_JSON_FILE;
      } else if (userText.includes('## Member tool: outlook-cli')) {
        response = STAGE1_JSON_OUTLOOK;
      } else {
        response = STAGE2_BODY;
      }
      this.responses.push(response);
      return new AIMessage({
        content: response,
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 200,
          total_tokens: 300,
        } as unknown as AIMessage['usage_metadata'],
      });
    },
  };
}

const FILE_CLI_DOC = `---
schemaVersion: 2
toolName: file-cli
---

# file-cli — capability document

Manipulates files. Has subcommands ls, read, write.
`;

const OUTLOOK_CLI_DOC = `---
schemaVersion: 2
toolName: outlook-cli
---

# outlook-cli — capability document

Reads and sends email via Microsoft Outlook.
`;

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-synth-'));
  capabilitiesDir = path.join(tmpDir, 'capabilities');
  distillDir = path.join(tmpDir, 'capabilities', 'composite', '_distill');
  await fsp.mkdir(capabilitiesDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(distillDir, { recursive: true, mode: 0o700 });
  await fsp.writeFile(path.join(capabilitiesDir, 'file-cli.md'), FILE_CLI_DOC, 'utf8');
  await fsp.writeFile(path.join(capabilitiesDir, 'outlook-cli.md'), OUTLOOK_CLI_DOC, 'utf8');
  events.length = 0;
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

function makeInputs(overrides: Partial<SynthesisInputs> = {}): SynthesisInputs {
  const llm = makeStubLLM();
  return {
    cfg: makeCfg(),
    llm: llm as unknown as SynthesisInputs['llm'],
    members: ['file-cli', 'outlook-cli'],
    compositeName: 'email-assistant',
    dryRun: false,
    budgetTokens: 100_000,
    logger: makeLogger(),
    ...overrides,
  };
}

describe('synthesizeComposite', () => {
  it('executes Stage-1 + Stage-2 and produces a schema-3 doc', async () => {
    const result = await synthesizeComposite(makeInputs(), {
      nowIso: '2026-05-02T00:00:00.000Z',
    });

    expect(result.frontmatter.compositeName).toBe('email-assistant');
    expect(result.frontmatter.members).toEqual(['file-cli', 'outlook-cli']);
    expect(result.frontmatter.schemaVersion).toBe(3);
    expect(result.frontmatter.composite).toBe(true);
    expect(result.frontmatter.manRef).toBeNull();
    expect(result.frontmatter.manPagePath).toBeNull();
    expect(result.frontmatter.synthesizedAt).toBe('2026-05-02T00:00:00.000Z');

    // Doc bytes contain frontmatter, AUTO-GENERATED markers, USER-RECIPES,
    // USER-NOTES, and the composer-emitted body.
    expect(result.doc).toMatch(/^---\nschemaVersion: 3\n/);
    expect(result.doc).toContain('<!-- AUTO-GENERATED:START');
    expect(result.doc).toContain('<!-- AUTO-GENERATED:END -->');
    expect(result.doc).toContain('<!-- USER-RECIPES:START -->');
    expect(result.doc).toContain('<!-- USER-RECIPES:END -->');
    expect(result.doc).toContain('<!-- USER-NOTES:START -->');
    expect(result.doc).toContain('<!-- USER-NOTES:END -->');
    expect(result.doc).toContain('## Synopsis');

    // Tokens accumulated across all stages.
    expect(result.totalTokens).toBeGreaterThan(0);

    // Stage-1 cache files persisted.
    const cacheFiles = await fsp.readdir(distillDir);
    expect(cacheFiles).toHaveLength(2);
  });

  it('emits composite_synthesis_started JSONL event', async () => {
    await synthesizeComposite(makeInputs(), {
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    const startEvent = events.find((e) => e.kind === 'composite_synthesis_started');
    expect(startEvent).toBeDefined();
    expect(startEvent!['compositeName']).toBe('email-assistant');
    expect(startEvent!['members']).toEqual(['file-cli', 'outlook-cli']);
  });

  it('throws ConfigurationError when members is empty', async () => {
    const inputs = makeInputs({ members: [] });
    await expect(synthesizeComposite(inputs)).rejects.toMatchObject({
      exitCode: 3,
    });
  });

  it('throws ConfigurationError when a member doc is missing (E-5)', async () => {
    await fsp.unlink(path.join(capabilitiesDir, 'outlook-cli.md'));
    const inputs = makeInputs();
    await expect(synthesizeComposite(inputs)).rejects.toMatchObject({
      exitCode: 3,
    });
  });

  it('records synthesisModel as <provider>:<model>', async () => {
    const result = await synthesizeComposite(makeInputs(), {
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    expect(result.frontmatter.synthesisModel).toBe('anthropic:claude-sonnet-4-6');
  });

  it('records activeProfile=null when no profile is active', async () => {
    const result = await synthesizeComposite(makeInputs(), {
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    expect(result.frontmatter.activeProfile).toBeNull();
  });

  it('records activeProfile name from cfg.activeProfile', async () => {
    const cfgWithProfile = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      capabilitiesDir,
      compositeDistillDir: distillDir,
      activeProfile: { name: 'work', path: '/x', schemaVersion: 1, digest: 'abc' },
    } as unknown as AgentConfig;
    const inputs: SynthesisInputs = {
      cfg: cfgWithProfile,
      llm: makeStubLLM() as unknown as SynthesisInputs['llm'],
      members: ['file-cli', 'outlook-cli'],
      compositeName: 'email-assistant',
      dryRun: false,
      budgetTokens: 100_000,
      logger: makeLogger(),
    };
    const result = await synthesizeComposite(inputs, {
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    expect(result.frontmatter.activeProfile).toBe('work');
  });

  it('Stage-1 cache hit on second run: no LLM calls for members', async () => {
    // First run populates the cache.
    await synthesizeComposite(makeInputs(), {
      nowIso: '2026-05-02T00:00:00.000Z',
    });

    // Second run: a fresh stub LLM that ONLY returns the Stage-2
    // body (so we can verify no Stage-1 calls happen).
    const llm2 = makeStubLLM();
    const inputs2 = makeInputs({
      llm: llm2 as unknown as SynthesisInputs['llm'],
    });
    await synthesizeComposite(inputs2, { nowIso: '2026-05-02T00:00:00.000Z' });
    // Exactly 1 LLM call (the Stage-2 compose) — Stage-1 was cached.
    expect(llm2.invocations).toBe(1);
  });

  it('dryRun returns assembled prompts and writes nothing', async () => {
    const llm = makeStubLLM();
    const inputs: SynthesisInputs = {
      cfg: makeCfg(),
      llm: llm as unknown as SynthesisInputs['llm'],
      members: ['file-cli', 'outlook-cli'],
      compositeName: 'email-assistant',
      dryRun: true,
      budgetTokens: 100_000,
      logger: makeLogger(),
    };
    const result = await synthesizeComposite(inputs, {
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    expect(result.doc).toBe('');
    expect(result.totalTokens).toBe(0);
    expect(result.dryRun).toBeDefined();
    expect(result.dryRun!.stage1).toHaveLength(2);
    expect(result.dryRun!.stage2).toHaveLength(3);
    expect(llm.invocations).toBe(0);
    // No cache file written.
    const cacheFiles = await fsp.readdir(distillDir);
    expect(cacheFiles).toHaveLength(0);
  });

  it('sorts members deterministically in the frontmatter', async () => {
    const inputs = makeInputs({ members: ['outlook-cli', 'file-cli'] });
    const result = await synthesizeComposite(inputs, {
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    expect(result.frontmatter.members).toEqual(['file-cli', 'outlook-cli']);
  });

  it('produces a doc whose syntheticDigest is reproducible across runs (AC-4 hint)', async () => {
    const r1 = await synthesizeComposite(makeInputs(), {
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    const r2 = await synthesizeComposite(makeInputs(), {
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    // The frontmatter syntheticDigest is keyed only to canonical
    // inputs (members, memberDigests, version, model, name) — NOT
    // to LLM output bytes. So two independent runs against the same
    // inputs MUST produce the same digest.
    expect(r1.frontmatter.syntheticDigest).toBe(r2.frontmatter.syntheticDigest);
  });
});
