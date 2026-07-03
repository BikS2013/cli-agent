import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../config/agent-config.js';

const mocks = vi.hoisted(() => {
  const logger = {
    log: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    currentLogPath: '/tmp/session.jsonl',
    currentSessionId: 'session-123',
  };
  const ioCapture = {
    boundToolSchemas: [],
    currentSessionId: 'session-123',
    currentCapturePath: '/tmp/capture.jsonl',
    captureRequest: vi.fn(),
    captureResponse: vi.fn(),
    captureToolResult: vi.fn(),
    read: vi.fn(() => []),
    close: vi.fn().mockResolvedValue(undefined),
  };
  const llm = { id: 'llm' };
  const tools = [{ name: 'bash_list_allowed' }, { name: 'tool_help' }];
  const agentToolsMeta = { umbrellaEnabled: false, registered: [] };
  const agentGraph = { id: 'agent-graph' };

  return {
    logger,
    ioCapture,
    llm,
    tools,
    agentToolsMeta,
    agentGraph,
    isLoggingDisabledByEnv: vi.fn(() => true),
    agentToolAgentsDir: vi.fn(() => '/tmp/.tool-agents/cli-agent'),
    createLogger: vi.fn(() => logger),
    createLLM: vi.fn(() => llm),
    buildToolCatalog: vi.fn(() => ({ tools, agentToolsMeta })),
    createIoCapture: vi.fn(() => ioCapture),
    discoverAllTools: vi.fn().mockResolvedValue(undefined),
    defaultDiscoveryReporter: vi.fn(() => ({ kind: 'reporter' })),
    composeCapabilitiesSystemPrompt: vi.fn().mockResolvedValue('CAPS'),
    buildSystemPromptForCfg: vi.fn().mockResolvedValue('SYSTEM'),
    buildAgentGraph: vi.fn(() => agentGraph),
  };
});

vi.mock('../config/agent-config.js', () => ({
  agentToolAgentsDir: mocks.agentToolAgentsDir,
  isLoggingDisabledByEnv: mocks.isLoggingDisabledByEnv,
}));

vi.mock('./providers/registry.js', () => ({
  createLLM: mocks.createLLM,
}));

vi.mock('./tools/registry.js', () => ({
  buildToolCatalog: mocks.buildToolCatalog,
}));

vi.mock('./system-prompt.js', () => ({
  buildSystemPromptForCfg: mocks.buildSystemPromptForCfg,
}));

vi.mock('./graph.js', () => ({
  buildAgentGraph: mocks.buildAgentGraph,
  runOneShot: vi.fn(),
  streamOneShot: vi.fn(),
}));

vi.mock('./logging.js', () => ({
  CLI_VERSION: '0.1.0-test',
  createLogger: mocks.createLogger,
}));

vi.mock('./io-capture.js', () => ({
  createIoCapture: mocks.createIoCapture,
}));

vi.mock('./capabilities/discover.js', () => ({
  discoverAllTools: mocks.discoverAllTools,
  defaultDiscoveryReporter: mocks.defaultDiscoveryReporter,
}));

vi.mock('./capabilities/compose-system-prompt.js', () => ({
  composeCapabilitiesSystemPrompt: mocks.composeCapabilitiesSystemPrompt,
}));

function makeCfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    maxSteps: 8,
    temperature: undefined,
    allowMutations: false,
    verbose: false,
    agentDir: '/tmp/.tool-agents/cli-agent',
    capabilitiesDir: '/tmp/.tool-agents/cli-agent/capabilities',
    logsDir: '/tmp/.tool-agents/cli-agent/logs',
    compositeCapabilitiesDir: '/tmp/.tool-agents/cli-agent/capabilities/composite',
    compositeDistillDir: '/tmp/.tool-agents/cli-agent/capabilities/composite/_distill',
    compositesDir: '/tmp/.tool-agents/cli-agent/composites',
    inspectIo: null,
    providerEnv: {} as AgentConfig['providerEnv'],
    tools: ['git'],
    capabilities: {
      depth: 2,
      maxBytesPerTool: 1024,
      timeoutMs: 5000,
      totalTimeoutMs: 60000,
      subcommandExtractor: '',
      skipLlmBelowBytes: 4096,
    },
    bash: {
      allow: [],
      allowedRoots: ['/tmp'],
      passEnv: ['PATH'],
      timeoutMs: 30000,
      maxOutputBytes: 1024,
    },
    webSearch: { backend: 'none', maxRequests: 50 },
    fileEdit: { root: '/tmp', allowPaths: [] },
    perToolBudgetBytes: 8192,
    baseUrl: undefined,
    webSearchBackend: undefined,
    bashAllow: [],
    bashPassSecrets: [],
    systemPromptPath: '/tmp/system-prompt.md',
    systemAppendText: undefined,
    systemAppendFile: undefined,
    agentTools: {
      enabled: true,
      tools: {
        glob: false,
        grep: false,
        multiedit: false,
        patch: false,
        todoRead: false,
        todoWrite: false,
        webSearch: false,
        webFetch: false,
        fileRead: false,
        fileList: false,
        fileWrite: false,
        fileEdit: false,
        fileAppend: false,
      },
    },
    composites: false,
    builtinTools: true,
    ...overrides,
  } as AgentConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('assembleAgentRuntime', () => {
  it('centralizes logger, LLM, catalog, discovery, prompt, capture, session logging, and graph assembly', async () => {
    const { assembleAgentRuntime } = await import('./run.js');
    const cfg = makeCfg({
      activeProfile: {
        name: 'ops',
        path: '/tmp/ops.yaml',
        schemaVersion: 1,
        digest: 'abc123',
      },
    });

    const runtime = await assembleAgentRuntime(cfg, { threadId: 'thread-fixed' });

    expect(mocks.isLoggingDisabledByEnv).toHaveBeenCalledTimes(1);
    expect(mocks.agentToolAgentsDir).toHaveBeenCalledTimes(1);
    expect(mocks.createLogger).toHaveBeenCalledWith({
      toolDir: '/tmp/.tool-agents/cli-agent',
      enabled: false,
    });
    expect(mocks.createLLM).toHaveBeenCalledWith(cfg);
    expect(mocks.buildToolCatalog).toHaveBeenCalledWith(cfg, mocks.logger);
    expect(mocks.createIoCapture).toHaveBeenCalledWith(cfg, 'session-123', mocks.tools);
    expect(mocks.defaultDiscoveryReporter).toHaveBeenCalledTimes(1);
    expect(mocks.discoverAllTools).toHaveBeenCalledWith(
      cfg,
      mocks.llm,
      mocks.logger,
      false,
      { kind: 'reporter' },
    );
    expect(mocks.composeCapabilitiesSystemPrompt).toHaveBeenCalledWith(
      cfg.capabilitiesDir,
      cfg.tools,
      cfg.capabilities.maxBytesPerTool,
    );
    expect(mocks.buildSystemPromptForCfg).toHaveBeenCalledWith(
      cfg,
      'CAPS',
      mocks.agentToolsMeta,
      mocks.tools,
    );
    expect(mocks.buildAgentGraph).toHaveBeenCalledWith(
      mocks.llm,
      mocks.tools,
      'SYSTEM',
      cfg.maxSteps,
      cfg,
    );

    expect(mocks.logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'session_start',
        sessionId: 'session-123',
        threadId: 'thread-fixed',
        provider: 'openai',
        model: 'gpt-4o',
        allowMutations: false,
        cliVersion: '0.1.0-test',
      }),
    );
    expect(mocks.logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'profile_active',
        sessionId: 'session-123',
        profileName: 'ops',
        profilePath: '/tmp/ops.yaml',
        schemaVersion: 1,
        digest: 'abc123',
      }),
    );

    expect(runtime).toMatchObject({
      agentGraph: mocks.agentGraph,
      logger: mocks.logger,
      sessionId: 'session-123',
      threadId: 'thread-fixed',
      ioCapture: mocks.ioCapture,
      tools: mocks.tools,
    });
  });

  it('skips wrapped-tool discovery when no wrapped CLI tools are configured', async () => {
    const { assembleAgentRuntime } = await import('./run.js');
    const cfg = makeCfg({ tools: [] });

    await assembleAgentRuntime(cfg, { threadId: 'thread-empty-tools' });

    expect(mocks.defaultDiscoveryReporter).not.toHaveBeenCalled();
    expect(mocks.discoverAllTools).not.toHaveBeenCalled();
    expect(mocks.composeCapabilitiesSystemPrompt).toHaveBeenCalledWith(
      cfg.capabilitiesDir,
      [],
      cfg.capabilities.maxBytesPerTool,
    );
  });
});

describe('buildTuiAgentRuntime', () => {
  it('uses the centralized runtime assembly with the TUI bootstrap thread id', async () => {
    const { buildTuiAgentRuntime } = await import('./run.js');
    const cfg = makeCfg();

    const runtime = await buildTuiAgentRuntime(cfg);

    expect(mocks.logger.log).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'session_start',
        threadId: 'tui-bootstrap',
      }),
    );
    expect(runtime).toEqual({
      agentGraph: mocks.agentGraph,
      logger: mocks.logger,
      sessionId: 'session-123',
      ioCapture: mocks.ioCapture,
    });
  });
});
