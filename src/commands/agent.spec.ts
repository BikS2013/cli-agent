/**
 * Command module tests.
 *
 * NOTE: With the TUI introduction, bare invocation (no prompt, no -i) drops
 * into the raw-mode TUI rather than throwing E_USAGE. The non-TTY guard inside
 * startTui() takes over instead. The streaming one-shot path replaces the
 * legacy runOneShotAgent for any positional prompt.
 */

import { describe, it, expect, vi } from 'vitest';

// Prevent real config loading
vi.mock('../config/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/agent-config.js')>();
  return {
    ...actual,
    loadAgentConfig: vi.fn().mockImplementation((flags: Record<string, unknown>) => {
      if (!flags['provider'] && !flags['tools']) {
        const err = Object.assign(new Error('Required configuration missing'), { code: 'E_CONFIG_MISSING', exitCode: 3 });
        return Promise.reject(err);
      }
      return Promise.resolve({
        provider: flags['provider'] ?? 'openai',
        model: 'gpt-4o',
        maxSteps: 10,
        temperature: 0,
        allowMutations: false,
        verbose: false,
        agentDir: '/tmp/.tool-agents/cli-agent',
        capabilitiesDir: '/tmp/.tool-agents/cli-agent/capabilities',
        logsDir: '/tmp/.tool-agents/cli-agent/logs',
        tools: [],
        capabilities: { depth: 2, maxBytesPerTool: 10240, timeoutMs: 5000, totalTimeoutMs: 60000, subcommandExtractor: '' },
        bash: { allow: [], allowedRoots: ['/tmp'], passEnv: ['PATH'], timeoutMs: 30000, maxOutputBytes: 1048576 },
        webSearch: { backend: 'tavily', maxRequests: 50 },
        fileEdit: { root: '/tmp', allowPaths: [] },
        perToolBudgetBytes: 8192,
        baseUrl: undefined,
        webSearchBackend: 'tavily',
        bashAllow: [],
        bashPassSecrets: [],
        providerEnv: {},
      });
    }),
    isLoggingDisabledByEnv: vi.fn().mockReturnValue(true),
    agentToolAgentsDir: vi.fn().mockReturnValue('/tmp/.tool-agents/cli-agent'),
    bootstrapAgentDir: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../agent/run.js', () => ({
  runInteractiveAgent: vi.fn().mockResolvedValue(undefined),
  // eslint-disable-next-line require-yield
  streamOneShotAgent: vi.fn().mockImplementation(async function* () {
    yield { kind: 'token', text: 'Test ' };
    yield { kind: 'token', text: 'answer' };
    return 'Test answer';
  }),
}));

vi.mock('../tui/index.js', () => ({
  startTui: vi.fn().mockResolvedValue(undefined),
  canHostTui: vi.fn().mockReturnValue(true),
}));

import { runAgentCommand } from './agent.js';

describe('runAgentCommand', () => {
  it('drops into the TUI when neither prompt nor --interactive is given', async () => {
    const { startTui } = await import('../tui/index.js');
    await runAgentCommand(null, { provider: 'openai' });
    expect(startTui).toHaveBeenCalled();
  });

  it('streams one-shot tokens when a positional prompt is provided', async () => {
    const { streamOneShotAgent } = await import('../agent/run.js');
    await runAgentCommand('hello', { provider: 'openai' });
    expect(streamOneShotAgent).toHaveBeenCalled();
  });

  it('routes --interactive to the legacy readline REPL', async () => {
    const { runInteractiveAgent } = await import('../agent/run.js');
    await runAgentCommand(null, { provider: 'openai', interactive: true });
    expect(runInteractiveAgent).toHaveBeenCalled();
  });
});
