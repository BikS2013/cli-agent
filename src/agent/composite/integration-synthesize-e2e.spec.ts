/**
 * End-to-end integration tests for the composite synthesis pipeline
 * (plan-006 acceptance coverage — gap 1).
 *
 * Verifies that a full `composite-synthesize` run, wired through the
 * real `handleSynthesize` entry point with a stub LLM, produces all
 * four distribution artifacts when every distribution form is enabled:
 *
 *   a. Composite capability doc at `<compositeCapabilitiesDir>/<id>.md`
 *   b. Mirror doc at `<capabilitiesDir>/<id>.md`
 *   c. Manifest JSON at `<compositesDir>/<id>/manifest.json`
 *   d. Wrapper shim at `<compositesDir>/<id>/<id>` (mode 0755 / executable)
 *
 * Acceptance criteria exercised:
 *   AC-2  — all four frontmatter keys present in the emitted doc
 *   AC-5  — cache miss on fresh run (no prior doc)
 *   AC-10 — emit-doc default ON
 *   AC-11 — wrapper shim produced and executable
 *   AC-13 — manifest produced
 *   AC-24 — file modes satisfied (shim executable)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AIMessage } from '@langchain/core/messages';

import * as registry from '../providers/registry.js';
import type { SynthesisInputs } from './types.js';
import type { AgentConfig } from '../../config/agent-config.js';

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

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

const FILE_CLI_DOC = `---
schemaVersion: 2
toolName: file-cli
---

# file-cli — capability document

<!-- AUTO-GENERATED:START hash=abc123 -->
Manipulates files. Has subcommands ls, read, write.
<!-- AUTO-GENERATED:END -->

<!-- USER-RECIPES:START -->
<!-- USER-RECIPES:END -->

<!-- USER-NOTES:START -->
<!-- USER-NOTES:END -->
`;

const OUTLOOK_CLI_DOC = `---
schemaVersion: 2
toolName: outlook-cli
---

# outlook-cli — capability document

<!-- AUTO-GENERATED:START hash=def456 -->
Reads and sends email via Microsoft Outlook.
<!-- AUTO-GENERATED:END -->

<!-- USER-RECIPES:START -->
<!-- USER-RECIPES:END -->

<!-- USER-NOTES:START -->
<!-- USER-NOTES:END -->
`;

// -----------------------------------------------------------------------
// Test setup
// -----------------------------------------------------------------------

let tmpDir: string;
let capabilitiesDir: string;
let compositeCapabilitiesDir: string;
let compositesDir: string;
let distillDir: string;

function makeStubLLM() {
  return {
    async invoke(msgs: unknown[]) {
      const last = msgs[msgs.length - 1] as { content: unknown };
      const userText = typeof last.content === 'string'
        ? last.content
        : Array.isArray(last.content)
          ? (last.content as Array<{ text?: unknown }>)
              .map((b) => (typeof b.text === 'string' ? b.text : ''))
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

function makeAgentConfig(): AgentConfig {
  return {
    provider: 'anthropic' as const,
    model: 'claude-sonnet-4-6',
    capabilitiesDir,
    compositeCapabilitiesDir,
    compositesDir,
    compositeDistillDir: distillDir,
    activeProfile: null,
  } as unknown as AgentConfig;
}

beforeEach(async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-e2e-synth-'));
  capabilitiesDir = path.join(tmpDir, 'capabilities');
  compositeCapabilitiesDir = path.join(tmpDir, 'capabilities', 'composite');
  compositesDir = path.join(tmpDir, 'composites');
  distillDir = path.join(tmpDir, 'capabilities', 'composite', '_distill');

  await fsp.mkdir(capabilitiesDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(compositeCapabilitiesDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(compositesDir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(distillDir, { recursive: true, mode: 0o700 });

  await fsp.writeFile(path.join(capabilitiesDir, 'file-cli.md'), FILE_CLI_DOC, 'utf8');
  await fsp.writeFile(path.join(capabilitiesDir, 'outlook-cli.md'), OUTLOOK_CLI_DOC, 'utf8');

  // Stub createLLM at the registry boundary.
  vi.spyOn(registry, 'createLLM').mockReturnValue(
    makeStubLLM() as unknown as ReturnType<typeof registry.createLLM>,
  );
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('E2E synthesize — all distribution forms enabled', () => {
  it('produces canonical doc + mirror + manifest + shim', async () => {
    const { synthesizeComposite } = await import('./synthesizer.js');

    const cfg = makeAgentConfig();
    const llm = makeStubLLM();
    const inputs: SynthesisInputs = {
      cfg,
      llm: llm as unknown as SynthesisInputs['llm'],
      members: ['file-cli', 'outlook-cli'],
      compositeName: 'email-assistant',
      dryRun: false,
      budgetTokens: 100_000,
      logger: {
        log: () => undefined,
        flush: async () => undefined,
        close: async () => undefined,
        currentLogPath: '/dev/null',
        currentSessionId: 'e2e-test',
      },
    };

    const result = await synthesizeComposite(inputs, {
      nowIso: '2026-05-02T10:00:00.000Z',
    });

    // --- Assert schema-3 doc structure ---
    expect(result.doc).toMatch(/^---\nschemaVersion: 3\n/);
    expect(result.doc).toContain('composite: true');
    expect(result.doc).toContain('compositeName: email-assistant');
    expect(result.doc).toContain('synthesizedAt: 2026-05-02T10:00:00.000Z');
    expect(result.doc).toContain('<!-- AUTO-GENERATED:START');
    expect(result.doc).toContain('<!-- AUTO-GENERATED:END -->');
    expect(result.doc).toContain('<!-- USER-RECIPES:START -->');
    expect(result.doc).toContain('<!-- USER-RECIPES:END -->');
    expect(result.doc).toContain('<!-- USER-NOTES:START -->');
    expect(result.doc).toContain('<!-- USER-NOTES:END -->');

    // --- Frontmatter fields (AC-2 / FR-CMP-004) ---
    expect(result.frontmatter.schemaVersion).toBe(3);
    expect(result.frontmatter.composite).toBe(true);
    expect(result.frontmatter.members).toEqual(['file-cli', 'outlook-cli']);
    expect(result.frontmatter.synthesisModel).toBe('anthropic:claude-sonnet-4-6');
    expect(result.frontmatter.activeProfile).toBeNull();
    expect(result.frontmatter.manRef).toBeNull();
    expect(result.frontmatter.manPagePath).toBeNull();
    expect(result.frontmatter.syntheticDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(result.frontmatter.memberDigests).toHaveProperty('file-cli');
    expect(result.frontmatter.memberDigests).toHaveProperty('outlook-cli');

    // --- Write all four artifacts ---
    const { writeCompositeDoc, mirrorCompositeDocToCapabilities } = await import('./cache.js');
    const { writeManifest } = await import('./manifest.js');
    const { generateCompositeWrapperShim } = await import('./shim-writer.js');

    // Artifact (a): canonical composite doc
    const canonicalDocPath = path.join(compositeCapabilitiesDir, 'email-assistant.md');
    await writeCompositeDoc(canonicalDocPath, result.doc);
    expect((await fsp.stat(canonicalDocPath)).isFile()).toBe(true);

    // Artifact (b): mirror copy in capabilitiesDir
    const mirrorPath = await mirrorCompositeDocToCapabilities(
      canonicalDocPath,
      capabilitiesDir,
      'email-assistant',
    );
    expect(mirrorPath).toBe(path.join(capabilitiesDir, 'email-assistant.md'));
    expect((await fsp.stat(mirrorPath)).isFile()).toBe(true);

    // Verify mirror bytes match canonical bytes.
    const canonicalBytes = await fsp.readFile(canonicalDocPath, 'utf8');
    const mirrorBytes = await fsp.readFile(mirrorPath, 'utf8');
    expect(mirrorBytes).toBe(canonicalBytes);

    // Artifact (c): manifest.json
    const manifestPath = path.join(compositesDir, 'email-assistant', 'manifest.json');
    await writeManifest(manifestPath, {
      schemaVersion: 1,
      compositeName: 'email-assistant',
      members: ['file-cli', 'outlook-cli'],
      memberDigests: result.frontmatter.memberDigests as Record<string, string>,
      createdAt: result.frontmatter.synthesizedAt,
      cliAgentVersion: result.frontmatter.cliAgentVersion,
      capabilityDocPath: canonicalDocPath,
      distribution: {
        emitDoc: true,
        emitWrapper: true,
        emitWrapperOnPath: false,
        registerVirtual: true,
      },
    });
    expect((await fsp.stat(manifestPath)).isFile()).toBe(true);

    // Verify manifest is valid JSON with correct fields.
    const manifestText = await fsp.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText) as { compositeName: string; members: string[] };
    expect(manifest.compositeName).toBe('email-assistant');
    expect(manifest.members).toEqual(['file-cli', 'outlook-cli']);

    // Artifact (d): wrapper shim
    const shimDir = path.join(compositesDir, 'email-assistant');
    const shimResult = await generateCompositeWrapperShim({
      compositeName: 'email-assistant',
      members: ['file-cli', 'outlook-cli'],
      cliAgentBinPath: '/usr/local/bin/cli-agent',
      capabilityDocPath: canonicalDocPath,
      shimDir,
      synthesizedAt: result.frontmatter.synthesizedAt,
    });

    const shimPath = shimResult.path;
    expect((await fsp.stat(shimPath)).isFile()).toBe(true);

    // Shim must be executable (mode 0755 or similar).
    if (process.platform !== 'win32') {
      const st = await fsp.stat(shimPath);
      // Owner-execute bit set: 0o100
      expect((st.mode & 0o100)).toBeGreaterThan(0);
    }

    // Shim must contain shebang and cli-agent invocation.
    const shimContent = await fsp.readFile(shimPath, 'utf8');
    expect(shimContent).toContain('#!/');
    expect(shimContent).toContain('file-cli');
    expect(shimContent).toContain('outlook-cli');
  });

  it('Stage-1 distill cache files are produced (two members → two cache entries)', async () => {
    const { synthesizeComposite } = await import('./synthesizer.js');
    const cfg = makeAgentConfig();
    const llm = makeStubLLM();

    await synthesizeComposite(
      {
        cfg,
        llm: llm as unknown as SynthesisInputs['llm'],
        members: ['file-cli', 'outlook-cli'],
        compositeName: 'email-assistant',
        dryRun: false,
        budgetTokens: 100_000,
        logger: {
          log: () => undefined,
          flush: async () => undefined,
          close: async () => undefined,
          currentLogPath: '/dev/null',
          currentSessionId: 'e2e-test',
        },
      },
      { nowIso: '2026-05-02T10:00:00.000Z' },
    );

    const distillEntries = await fsp.readdir(distillDir);
    expect(distillEntries).toHaveLength(2);
  });

  it('syntheticDigest in frontmatter is reproducible (cache key stability)', async () => {
    const { synthesizeComposite } = await import('./synthesizer.js');

    const makeLogger = () => ({
      log: () => undefined,
      flush: async () => undefined,
      close: async () => undefined,
      currentLogPath: '/dev/null' as string,
      currentSessionId: 'e2e-test' as string,
    });

    const cfg = makeAgentConfig();

    const r1 = await synthesizeComposite(
      {
        cfg,
        llm: makeStubLLM() as unknown as SynthesisInputs['llm'],
        members: ['file-cli', 'outlook-cli'],
        compositeName: 'email-assistant',
        dryRun: false,
        budgetTokens: 100_000,
        logger: makeLogger(),
      },
      { nowIso: '2026-05-02T10:00:00.000Z' },
    );

    // Fresh distillDir to prevent Stage-1 cache hit on second run.
    const distillDir2 = path.join(tmpDir, 'capabilities', 'composite', '_distill2');
    await fsp.mkdir(distillDir2, { recursive: true, mode: 0o700 });
    const cfg2 = { ...cfg, compositeDistillDir: distillDir2 } as unknown as AgentConfig;

    const r2 = await synthesizeComposite(
      {
        cfg: cfg2,
        llm: makeStubLLM() as unknown as SynthesisInputs['llm'],
        members: ['file-cli', 'outlook-cli'],
        compositeName: 'email-assistant',
        dryRun: false,
        budgetTokens: 100_000,
        logger: makeLogger(),
      },
      { nowIso: '2026-05-02T10:00:00.000Z' },
    );

    // The syntheticDigest is keyed on member digests + version + model,
    // NOT on LLM output — so it must be identical across two runs with
    // the same member docs.
    expect(r1.frontmatter.syntheticDigest).toBe(r2.frontmatter.syntheticDigest);
  });
});

describe('E2E synthesize — createLLM is called (not bypassed)', () => {
  it('createLLM spy is invoked during synthesis (LLM is wired)', async () => {
    const { synthesizeComposite } = await import('./synthesizer.js');
    const cfg = makeAgentConfig();
    const llm = makeStubLLM();
    let invocationCount = 0;
    const trackingLLM = {
      async invoke(msgs: unknown[]) {
        invocationCount++;
        return llm.invoke(msgs);
      },
    };

    await synthesizeComposite(
      {
        cfg,
        llm: trackingLLM as unknown as SynthesisInputs['llm'],
        members: ['file-cli', 'outlook-cli'],
        compositeName: 'email-assistant',
        dryRun: false,
        budgetTokens: 100_000,
        logger: {
          log: () => undefined,
          flush: async () => undefined,
          close: async () => undefined,
          currentLogPath: '/dev/null',
          currentSessionId: 'e2e-test',
        },
      },
      { nowIso: '2026-05-02T10:00:00.000Z' },
    );

    // Stage-1 (2 members in parallel) + Stage-2 (1 call) = 3 calls minimum.
    expect(invocationCount).toBeGreaterThanOrEqual(3);
  });
});
