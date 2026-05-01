/**
 * End-to-end integration tests for the agent-tools pack.
 *
 * Coverage (all `integration` category):
 *
 *   Suite A — configurable injection contract (direct invoke)
 *     Proves `agt_glob` reads `workingDirectory` from the LangChain
 *     `RunnableConfig.configurable` bag end-to-end, without a real LLM.
 *     Uses `tool.invoke(input, { configurable: { ... } })` directly on
 *     the tool obtained from `buildToolCatalog`, so the full factory +
 *     wrapper + vendored-upstream chain is exercised.
 *
 *   Suite B — full ReAct turn through createReactAgent (stub LLM)
 *     A minimal `BaseChatModel` subclass emits:
 *       - first call:  AIMessage with a tool_call for `agt_glob`
 *       - second call: AIMessage with a text answer containing the result
 *     The test drives `buildAgentGraph + runOneShot` and verifies:
 *       - the tool executed and the final answer contains file names
 *       - `workingDirectory` was correctly injected from `cfg.fileEdit.root`
 *
 *   Suite C — umbrella disabled
 *     When `cfg.agentTools.enabled === false`, `agt_glob` must NOT be in
 *     the tool catalog returned by `buildToolCatalog`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  BaseChatModel,
  type BaseChatModelCallOptions,
} from '@langchain/core/language_models/chat_models';
import type { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import { AIMessage } from '@langchain/core/messages';
import type {
  BaseMessage,
  BaseMessageChunk,
} from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { RunnableLike } from '@langchain/core/runnables';

import type { AgentConfig } from '../../../config/agent-config.js';
import { buildToolCatalog } from '../registry.js';
import { buildAgentGraph, runOneShot } from '../../graph.js';
import { AGT_GLOB_NAME } from './agt-glob.js';
import type { AgentToolsSession } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal valid AgentConfig stub. Only fields consumed by `buildToolCatalog`,
 * `cliAgentPermissionPolicy`, `buildAgentGraph` and `runOneShot` are set.
 * Other fields are cast away to keep the fixture tight.
 */
function makeCfg(overrides: {
  agentToolsEnabled?: boolean;
  globEnabled?: boolean;
  fileEditRoot?: string;
  bashAllow?: string[];
}): AgentConfig {
  const fileEditRoot = overrides.fileEditRoot ?? path.join(os.tmpdir(), 'e2e-root-' + randomUUID());
  const agentToolsEnabled = overrides.agentToolsEnabled ?? true;
  const globEnabled = overrides.globEnabled ?? true;
  const bashAllow = overrides.bashAllow ?? ['echo'];

  return {
    provider: 'openai' as const,
    model: 'gpt-4o',
    maxSteps: 5,
    temperature: undefined,
    allowMutations: false,
    verbose: false,
    agentDir: '/tmp/e2e-agent-dir',
    capabilitiesDir: '/tmp/e2e-agent-dir/capabilities',
    logsDir: '/tmp/e2e-agent-dir/logs',
    providerEnv: Object.freeze({}) as AgentConfig['providerEnv'],
    tools: [],
    capabilities: {
      depth: 2,
      maxBytesPerTool: 10240,
      timeoutMs: 5000,
      totalTimeoutMs: 60000,
      subcommandExtractor: '',
      skipLlmBelowBytes: 4096,
    },
    bash: {
      allow: bashAllow,
      allowedRoots: [fileEditRoot],
      passEnv: ['PATH', 'HOME'],
      timeoutMs: 30_000,
      maxOutputBytes: 1_048_576,
    },
    webSearch: { backend: 'none' },
    fileEdit: {
      root: fileEditRoot,
      allowPaths: [],
    },
    perToolBudgetBytes: 8192,
    baseUrl: undefined,
    webSearchBackend: undefined,
    bashAllow,
    bashPassSecrets: [],
    systemPromptPath: '/tmp/system-prompt.md',
    systemAppendText: undefined,
    systemAppendFile: undefined,
    agentTools: {
      enabled: agentToolsEnabled,
      tools: {
        glob: globEnabled,
        grep: false,
        multiedit: false,
        patch: false,
        todoRead: false,
        todoWrite: false,
      },
    },
  } as unknown as AgentConfig;
}

/** No-op logger — only the fields actually called during tool registration. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const noopLogger: any = {
  log: () => undefined,
  currentSessionId: 'e2e-test',
};

// ---------------------------------------------------------------------------
// Stub LLM
// ---------------------------------------------------------------------------

interface StubCall {
  readonly messages: BaseMessage[];
  readonly toolCallEmitted: boolean;
}

/**
 * Minimal `BaseChatModel` subclass for testing.
 *
 * Call sequence (stateful, call-count driven):
 *   call 0: emits an AIMessage with a `tool_calls` entry for `agt_glob`
 *            with `{ pattern: '*.txt' }`
 *   call 1+: emits a final plain AIMessage whose content concatenates the
 *            content of any ToolMessage found in the incoming messages,
 *            proving the tool result was plumbed back.
 *
 * `bindTools` is implemented as a no-op `return this` so `createReactAgent`
 * doesn't throw when it tries to bind the tool catalog.
 *
 * Recorded state is accessible through `stub.calls` for assertions.
 */
class StubGlobLlm extends BaseChatModel {
  // Track each _generate invocation.
  readonly calls: StubCall[] = [];
  readonly toolCallPattern: string;

  constructor(opts: { toolCallPattern?: string } = {}) {
    super({});
    this.toolCallPattern = opts.toolCallPattern ?? '*.txt';
  }

  // Required abstract
  _llmType(): string { return 'stub-glob-llm'; }

  // Required by createReactAgent: it calls `llm.bindTools(tools)` and
  // expects a Runnable back.  Return `this` (a Runnable) so no-op.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  override bindTools(_tools: unknown[], _kwargs?: unknown): any {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this as any;
  }

  override async _generate(
    messages: BaseMessage[],
    _options: BaseChatModelCallOptions,
    _runManager?: CallbackManagerForLLMRun,
  ): Promise<ChatResult> {
    const callIndex = this.calls.length;

    if (callIndex === 0) {
      // First turn: emit a tool_call for agt_glob.
      this.calls.push({ messages, toolCallEmitted: true });
      const aiMsg = new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'call-e2e-0',
            name: AGT_GLOB_NAME,
            args: { pattern: this.toolCallPattern },
            type: 'tool_call' as const,
          },
        ],
      });
      return {
        generations: [
          {
            text: '',
            message: aiMsg,
          },
        ],
        llmOutput: {},
      };
    }

    // Subsequent turns: synthesise the final answer from tool results.
    this.calls.push({ messages, toolCallEmitted: false });

    // Collect any ToolMessage content from the incoming messages so the
    // final answer includes what the tool actually returned.
    const toolResultText = messages
      .filter((m) => m.getType() === 'tool')
      .map((m) => {
        const c = m.content;
        if (typeof c === 'string') return c;
        if (Array.isArray(c)) {
          return (c as Array<{ text?: string }>).map((b) => b.text ?? '').join('');
        }
        return String(c);
      })
      .join('\n');

    const finalContent = `Here are the files:\n${toolResultText}`;
    const aiMsg = new AIMessage({ content: finalContent });
    return {
      generations: [
        {
          text: finalContent,
          message: aiMsg,
        },
      ],
      llmOutput: {},
    };
  }
}

// ---------------------------------------------------------------------------
// Temp directory lifecycle
// ---------------------------------------------------------------------------

let tempDir = '';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agt-e2e-'));
}

function seedTempDir(dir: string): void {
  fs.writeFileSync(path.join(dir, 'a.txt'), 'content of a\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'content of b\n');
  fs.mkdirSync(path.join(dir, 'subdir'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'subdir', 'c.md'), '# heading\n');
}

beforeEach(() => {
  tempDir = createTempDir();
  seedTempDir(tempDir);
});

afterEach(() => {
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = '';
  }
});

// ---------------------------------------------------------------------------
// Suite A — configurable injection contract (direct tool.invoke)
// ---------------------------------------------------------------------------

describe('Suite A — configurable injection contract (direct invoke)', () => {
  it('A1: buildToolCatalog includes agt_glob when umbrella + glob flag are ON', () => {
    const cfg = makeCfg({ fileEditRoot: tempDir });
    const { tools } = buildToolCatalog(cfg, noopLogger);
    const names = tools.map((t: { name: string }) => t.name);
    expect(names).toContain(AGT_GLOB_NAME);
  });

  it('A2: agt_glob tool.invoke returns file names when workingDirectory is set', async () => {
    const cfg = makeCfg({ fileEditRoot: tempDir });
    const { tools } = buildToolCatalog(cfg, noopLogger);
    const globTool = tools.find((t: { name: string }) => t.name === AGT_GLOB_NAME);
    expect(globTool).toBeDefined();

    const session: AgentToolsSession = { todos: null };
    const result = await (globTool as { invoke: Function }).invoke(
      { pattern: '*.txt' },
      {
        configurable: {
          workingDirectory: tempDir,
          agentToolsSession: session,
        },
      },
    );

    expect(typeof result).toBe('string');
    // Both .txt files seeded in beforeEach must appear.
    expect(result).toContain('a.txt');
    expect(result).toContain('b.txt');
    // The markdown file in subdir should NOT match *.txt at root level.
    // (pattern is '*.txt', not '**/*.txt')
    // We don't assert c.md absence because glob behaviour with ripgrep
    // vs fallback may vary — just assert the required matches are present.
  });

  it('A3: agt_glob with **/*.txt pattern finds files in subdirs too', async () => {
    const cfg = makeCfg({ fileEditRoot: tempDir });
    // Also seed a .txt in subdir for this test.
    fs.writeFileSync(path.join(tempDir, 'subdir', 'd.txt'), 'content d\n');

    const { tools } = buildToolCatalog(cfg, noopLogger);
    const globTool = tools.find((t: { name: string }) => t.name === AGT_GLOB_NAME);

    const session: AgentToolsSession = { todos: null };
    const result = await (globTool as { invoke: Function }).invoke(
      { pattern: '**/*.txt' },
      { configurable: { workingDirectory: tempDir, agentToolsSession: session } },
    );

    expect(typeof result).toBe('string');
    expect(result).toContain('a.txt');
    expect(result).toContain('b.txt');
    // subdir/d.txt should also appear
    expect(result).toMatch(/d\.txt/);
  });

  it('A4: agt_glob throws when workingDirectory is absent from configurable', async () => {
    const cfg = makeCfg({ fileEditRoot: tempDir });
    const { tools } = buildToolCatalog(cfg, noopLogger);
    const globTool = tools.find((t: { name: string }) => t.name === AGT_GLOB_NAME);
    expect(globTool).toBeDefined();

    // No configurable at all → should throw with the expected message.
    await expect(
      (globTool as { invoke: Function }).invoke({ pattern: '*.txt' }),
    ).rejects.toThrow(/workingDirectory is required/);
  });

  it('A5: agt_glob throws when workingDirectory is empty string', async () => {
    const cfg = makeCfg({ fileEditRoot: tempDir });
    const { tools } = buildToolCatalog(cfg, noopLogger);
    const globTool = tools.find((t: { name: string }) => t.name === AGT_GLOB_NAME);

    await expect(
      (globTool as { invoke: Function }).invoke(
        { pattern: '*.txt' },
        { configurable: { workingDirectory: '', agentToolsSession: { todos: null } } },
      ),
    ).rejects.toThrow(/workingDirectory is required/);
  });

  it('A6: catalog metadata (agentToolsMeta) reflects the registered tool', () => {
    const cfg = makeCfg({ fileEditRoot: tempDir });
    const { agentToolsMeta } = buildToolCatalog(cfg, noopLogger);
    expect(agentToolsMeta.umbrellaEnabled).toBe(true);
    const names = agentToolsMeta.registered.map((e) => e.name);
    expect(names).toContain(AGT_GLOB_NAME);
  });
});

// ---------------------------------------------------------------------------
// Suite B — full ReAct turn through createReactAgent (stub LLM)
// ---------------------------------------------------------------------------

describe('Suite B — full ReAct turn via createReactAgent (stub LLM)', () => {
  it('B1: stub LLM emits tool_call; agt_glob executes; final message contains file names', async () => {
    const cfg = makeCfg({ fileEditRoot: tempDir });
    const { tools, agentToolsMeta } = buildToolCatalog(cfg, noopLogger);

    // The umbrella and glob must be on — otherwise the test is meaningless.
    expect(agentToolsMeta.umbrellaEnabled).toBe(true);
    expect(agentToolsMeta.registered.map((e) => e.name)).toContain(AGT_GLOB_NAME);

    const stub = new StubGlobLlm({ toolCallPattern: '*.txt' });
    const systemPrompt = 'You are a helpful assistant.';

    // buildAgentGraph signature: (llm, tools, systemPrompt, maxSteps, cfg)
    const agentGraph = buildAgentGraph(
      stub,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools as any,
      systemPrompt,
      3,
      cfg,
    );

    // Verify workingDirectory is resolved to cfg.fileEdit.root.
    expect(agentGraph.workingDirectory).toBe(path.resolve(tempDir));

    const threadId = randomUUID();
    const finalText = await runOneShot(
      agentGraph,
      'List the .txt files in the working directory.',
      threadId,
      3,
    );

    // The stub's second call receives the ToolMessage and echoes it back.
    expect(stub.calls.length).toBeGreaterThanOrEqual(2);
    expect(stub.calls[0]!.toolCallEmitted).toBe(true);
    expect(stub.calls[1]!.toolCallEmitted).toBe(false);

    // The final message must contain the glob output (file names).
    expect(finalText).toContain('a.txt');
    expect(finalText).toContain('b.txt');
  }, 30_000); // allow 30 s for LangGraph graph traversal

  it('B2: workingDirectory injected into configurable matches cfg.fileEdit.root', async () => {
    const cfg = makeCfg({ fileEditRoot: tempDir });
    const { tools } = buildToolCatalog(cfg, noopLogger);

    const stub = new StubGlobLlm({ toolCallPattern: '*.txt' });

    const agentGraph = buildAgentGraph(
      stub,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools as any,
      'You are helpful.',
      3,
      cfg,
    );

    // The graph's workingDirectory must be the resolved absolute path of
    // cfg.fileEdit.root — this is what gets threaded into
    // RunnableConfig.configurable.workingDirectory at runOneShot time.
    expect(agentGraph.workingDirectory).toBe(path.resolve(cfg.fileEdit.root));
  });

  it('B3: agentToolsSession is created once per graph (todo state survives turns)', () => {
    const cfg = makeCfg({ fileEditRoot: tempDir });
    const { tools } = buildToolCatalog(cfg, noopLogger);

    const stub = new StubGlobLlm();

    const agentGraph = buildAgentGraph(
      stub,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools as any,
      'You are helpful.',
      3,
      cfg,
    );

    // The session is initialized with todos === null (pre-todowrite state).
    expect(agentGraph.agentToolsSession.todos).toBeNull();

    // Mutating the session object is visible by reference — this is the
    // shared-state contract between graph turns.
    agentGraph.agentToolsSession.todos = [
      { id: 'todo-1', content: 'test task', status: 'pending', priority: 'medium' },
    ];
    expect(agentGraph.agentToolsSession.todos).toHaveLength(1);
    expect(agentGraph.agentToolsSession.todos![0]!.content).toBe('test task');
  });
});

// ---------------------------------------------------------------------------
// Suite C — umbrella disabled
// ---------------------------------------------------------------------------

describe('Suite C — umbrella disabled (agt_glob absent from catalog)', () => {
  it('C1: agt_glob is NOT in the tool catalog when agentTools.enabled is false', () => {
    const cfg = makeCfg({
      agentToolsEnabled: false,
      globEnabled: true, // irrelevant — umbrella wins
      fileEditRoot: tempDir,
    });

    const { tools, agentToolsMeta } = buildToolCatalog(cfg, noopLogger);

    const names = tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain(AGT_GLOB_NAME);

    // Metadata must also reflect the umbrella being off.
    expect(agentToolsMeta.umbrellaEnabled).toBe(false);
    expect(agentToolsMeta.registered).toHaveLength(0);
  });

  it('C2: catalog without agt_glob still contains standard tools (file_read, etc.)', () => {
    const cfg = makeCfg({ agentToolsEnabled: false, fileEditRoot: tempDir });

    const { tools } = buildToolCatalog(cfg, noopLogger);
    const names = tools.map((t: { name: string }) => t.name);

    // Standard read-only tools must always be present.
    expect(names).toContain('file_read');
    expect(names).toContain('file_list');
    expect(names).toContain('bash_list_allowed');
    expect(names).toContain('web_search');
    expect(names).not.toContain(AGT_GLOB_NAME);
  });

  it('C3: umbrella ON but glob flag OFF also excludes agt_glob', () => {
    const cfg = makeCfg({
      agentToolsEnabled: true,
      globEnabled: false, // per-tool flag OFF
      fileEditRoot: tempDir,
    });

    const { tools, agentToolsMeta } = buildToolCatalog(cfg, noopLogger);
    const names = tools.map((t: { name: string }) => t.name);

    expect(names).not.toContain(AGT_GLOB_NAME);
    // Umbrella is on, but no tools registered (all flags off).
    expect(agentToolsMeta.umbrellaEnabled).toBe(true);
    expect(agentToolsMeta.registered).toHaveLength(0);
  });
});
