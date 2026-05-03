/**
 * Co-located tests for `stage1.ts` (plan-006 Phase 6, U-SYNTH).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';
import {
  distillMember,
  readDistillCacheEntry,
  writeDistillCacheEntry,
} from './stage1.js';
import type { AgentConfig } from '../../config/agent-config.js';
import type { Logger } from '../logging.js';
import type { Stage1Distillation } from './types.js';

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

const CANNED_JSON = JSON.stringify({
  synopsis: 'A small CLI for files.',
  intents: ['list', 'read'],
  subcommands: [{ name: 'ls', purpose: 'list directory' }],
  flags: [{ name: '--long', purpose: 'long format' }],
  examples: [{ command: 'file-cli ls /tmp', explanation: 'list /tmp' }],
  constraints: ['no auth required'],
});

function makeStubLLM(responseText: string = CANNED_JSON): {
  invoke: (msgs: unknown[]) => Promise<AIMessage>;
  invocations: number;
} {
  let invocations = 0;
  return {
    invocations: 0,
    async invoke(_msgs: unknown[]) {
      invocations += 1;
      this.invocations = invocations;
      return new AIMessage({
        content: responseText,
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 200,
          total_tokens: 300,
        } as unknown as AIMessage['usage_metadata'],
      });
    },
  };
}

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-stage1-'));
  capabilitiesDir = path.join(tmpDir, 'capabilities');
  distillDir = path.join(tmpDir, 'capabilities', 'composite', '_distill');
  await fsp.mkdir(capabilitiesDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(distillDir, { recursive: true, mode: 0o700 });
  events.length = 0;
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

const MEMBER_DOC_BYTES =
  '---\nschemaVersion: 2\ntoolName: file-cli\n---\n\n# file-cli\n\nManipulates files.\n';

describe('distillMember', () => {
  it('writes a Stage-1 cache entry on miss and emits composite_stage1_run', async () => {
    const memberPath = path.join(capabilitiesDir, 'file-cli.md');
    await fsp.writeFile(memberPath, MEMBER_DOC_BYTES, 'utf8');

    const llm = makeStubLLM();
    const r = await distillMember({
      memberName: 'file-cli',
      memberDocPath: memberPath,
      cfg: makeCfg(),
      llm: llm as unknown as Parameters<typeof distillMember>[0]['llm'],
      logger: makeLogger(),
    });
    expect(r.cacheHit).toBe(false);
    expect(r.tokensInput).toBe(100);
    expect(r.tokensOutput).toBe(200);
    expect(r.distillation.memberName).toBe('file-cli');
    expect(r.distillation.modelId).toBe('claude-sonnet-4-6');
    expect(r.distillation.templateVersion).toBe('stage1-v1');
    expect(JSON.parse(r.distillation.content).synopsis).toBe('A small CLI for files.');

    const cacheFiles = await fsp.readdir(distillDir);
    expect(cacheFiles).toHaveLength(1);
    expect(cacheFiles[0]).toMatch(/^file-cli@[a-f0-9]{16}\.json$/);

    const stage1RunEvent = events.find((e) => e.kind === 'composite_stage1_run');
    expect(stage1RunEvent).toBeDefined();
    expect(stage1RunEvent!['member']).toBe('file-cli');
    expect(stage1RunEvent!['tokensInput']).toBe(100);
  });

  it('returns cached entry on hit without invoking the LLM', async () => {
    const memberPath = path.join(capabilitiesDir, 'file-cli.md');
    await fsp.writeFile(memberPath, MEMBER_DOC_BYTES, 'utf8');

    // First call populates the cache.
    const llm1 = makeStubLLM();
    await distillMember({
      memberName: 'file-cli',
      memberDocPath: memberPath,
      cfg: makeCfg(),
      llm: llm1 as unknown as Parameters<typeof distillMember>[0]['llm'],
      logger: makeLogger(),
    });
    expect(llm1.invocations).toBe(1);

    // Second call hits the cache.
    const llm2 = makeStubLLM();
    const r = await distillMember({
      memberName: 'file-cli',
      memberDocPath: memberPath,
      cfg: makeCfg(),
      llm: llm2 as unknown as Parameters<typeof distillMember>[0]['llm'],
      logger: makeLogger(),
    });
    expect(r.cacheHit).toBe(true);
    expect(llm2.invocations).toBe(0);
    expect(r.tokensInput).toBe(0);
    expect(r.tokensOutput).toBe(0);
    const stage1CachedEvent = events.find((e) => e.kind === 'composite_stage1_cached');
    expect(stage1CachedEvent).toBeDefined();
  });

  it('forceRegenerate=true bypasses the cache', async () => {
    const memberPath = path.join(capabilitiesDir, 'file-cli.md');
    await fsp.writeFile(memberPath, MEMBER_DOC_BYTES, 'utf8');

    const llm1 = makeStubLLM();
    await distillMember({
      memberName: 'file-cli',
      memberDocPath: memberPath,
      cfg: makeCfg(),
      llm: llm1 as unknown as Parameters<typeof distillMember>[0]['llm'],
      logger: makeLogger(),
    });

    const llm2 = makeStubLLM();
    const r = await distillMember({
      memberName: 'file-cli',
      memberDocPath: memberPath,
      cfg: makeCfg(),
      llm: llm2 as unknown as Parameters<typeof distillMember>[0]['llm'],
      logger: makeLogger(),
      forceRegenerate: true,
    });
    expect(r.cacheHit).toBe(false);
    expect(llm2.invocations).toBe(1);
  });

  it('throws ConfigurationError when the member doc is missing', async () => {
    const memberPath = path.join(capabilitiesDir, 'absent.md');
    const llm = makeStubLLM();
    await expect(
      distillMember({
        memberName: 'absent',
        memberDocPath: memberPath,
        cfg: makeCfg(),
        llm: llm as unknown as Parameters<typeof distillMember>[0]['llm'],
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  it('throws ConfigurationError when the LLM emits non-JSON', async () => {
    const memberPath = path.join(capabilitiesDir, 'file-cli.md');
    await fsp.writeFile(memberPath, MEMBER_DOC_BYTES, 'utf8');
    const llm = makeStubLLM('this is not json');
    await expect(
      distillMember({
        memberName: 'file-cli',
        memberDocPath: memberPath,
        cfg: makeCfg(),
        llm: llm as unknown as Parameters<typeof distillMember>[0]['llm'],
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  it('throws ConfigurationError when the LLM JSON fails schema', async () => {
    const memberPath = path.join(capabilitiesDir, 'file-cli.md');
    await fsp.writeFile(memberPath, MEMBER_DOC_BYTES, 'utf8');
    const llm = makeStubLLM(JSON.stringify({ wrong: 'shape' }));
    await expect(
      distillMember({
        memberName: 'file-cli',
        memberDocPath: memberPath,
        cfg: makeCfg(),
        llm: llm as unknown as Parameters<typeof distillMember>[0]['llm'],
        logger: makeLogger(),
      }),
    ).rejects.toMatchObject({ exitCode: 3 });
  });

  it('dryRun returns a synthetic distillation without invoking LLM or writing cache', async () => {
    const memberPath = path.join(capabilitiesDir, 'file-cli.md');
    await fsp.writeFile(memberPath, MEMBER_DOC_BYTES, 'utf8');
    const llm = makeStubLLM();
    const r = await distillMember({
      memberName: 'file-cli',
      memberDocPath: memberPath,
      cfg: makeCfg(),
      llm: llm as unknown as Parameters<typeof distillMember>[0]['llm'],
      logger: makeLogger(),
      dryRun: true,
    });
    expect(llm.invocations).toBe(0);
    expect(r.cacheHit).toBe(false);
    const cacheFiles = await fsp.readdir(distillDir);
    expect(cacheFiles).toHaveLength(0);
    const dryPayload = JSON.parse(r.distillation.content);
    expect(dryPayload.dryRun).toBe(true);
    expect(dryPayload.promptDigest16).toMatch(/^[a-f0-9]{16}$/);
  });

  it('cache is invalidated when the member doc bytes change', async () => {
    const memberPath = path.join(capabilitiesDir, 'file-cli.md');
    await fsp.writeFile(memberPath, MEMBER_DOC_BYTES, 'utf8');

    const llm1 = makeStubLLM();
    await distillMember({
      memberName: 'file-cli',
      memberDocPath: memberPath,
      cfg: makeCfg(),
      llm: llm1 as unknown as Parameters<typeof distillMember>[0]['llm'],
      logger: makeLogger(),
    });

    // Mutate the doc bytes.
    await fsp.writeFile(memberPath, MEMBER_DOC_BYTES + '\n## new section\n', 'utf8');

    const llm2 = makeStubLLM();
    const r = await distillMember({
      memberName: 'file-cli',
      memberDocPath: memberPath,
      cfg: makeCfg(),
      llm: llm2 as unknown as Parameters<typeof distillMember>[0]['llm'],
      logger: makeLogger(),
    });
    expect(r.cacheHit).toBe(false);
    expect(llm2.invocations).toBe(1);
    // Two separate cache files, one per digest.
    const cacheFiles = await fsp.readdir(distillDir);
    expect(cacheFiles).toHaveLength(2);
  });
});

describe('readDistillCacheEntry / writeDistillCacheEntry', () => {
  it('round-trips a Stage1Distillation through disk', async () => {
    const filePath = path.join(distillDir, 'foo@1234567890abcdef.json');
    const entry: Stage1Distillation = {
      memberName: 'foo',
      content: JSON.stringify({ x: 1 }),
      modelId: 'm',
      templateVersion: 'stage1-v1',
      createdAt: '2026-05-02T00:00:00.000Z',
    };
    await writeDistillCacheEntry(filePath, entry);
    const got = await readDistillCacheEntry(filePath);
    expect(got).toEqual(entry);
  });

  it('returns null on ENOENT', async () => {
    const got = await readDistillCacheEntry(path.join(distillDir, 'absent.json'));
    expect(got).toBeNull();
  });

  it('returns null on schema mismatch (treat-as-miss)', async () => {
    const filePath = path.join(distillDir, 'bad.json');
    await fsp.writeFile(filePath, JSON.stringify({ unrelated: 'shape' }), 'utf8');
    const got = await readDistillCacheEntry(filePath);
    expect(got).toBeNull();
  });
});

// Silence vitest noise on workers
vi.useRealTimers();
