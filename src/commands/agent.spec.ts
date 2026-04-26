/**
 * Command module tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Prevent real config loading
vi.mock('../config/agent-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/agent-config.js')>();
  return {
    ...actual,
    loadAgentConfig: vi.fn().mockImplementation((flags: Record<string, unknown>) => {
      if (!flags['provider'] && !flags['tools']) {
        // Simulate missing provider
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
        webSearch: { backend: 'tavily' },
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
  runOneShotAgent: vi.fn().mockResolvedValue('Test answer from agent'),
  runInteractiveAgent: vi.fn().mockResolvedValue(undefined),
}));

import { runAgentCommand } from './agent.js';

describe('runAgentCommand', () => {
  it('throws UsageError when prompt is null and not interactive', async () => {
    await expect(runAgentCommand(null, {})).rejects.toMatchObject({
      code: 'E_USAGE',
    });
  });

  it('calls runOneShotAgent when prompt provided', async () => {
    const { runOneShotAgent } = await import('../agent/run.js');
    await runAgentCommand('hello', { provider: 'openai' });
    expect(runOneShotAgent).toHaveBeenCalled();
  });
});
