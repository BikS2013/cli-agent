/**
 * Provider registry tests.
 * No real network calls — asserts instance types.
 */

import { describe, it, expect } from 'vitest';
import { ChatOpenAI, AzureChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { REGISTRY } from './registry.js';
import type { AgentConfig } from '../../config/agent-config.js';

function makeBaseConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    maxSteps: 10,
    temperature: 0,
    allowMutations: false,
    verbose: false,
    agentDir: '/tmp/.tool-agents/cli-agent',
    capabilitiesDir: '/tmp/.tool-agents/cli-agent/capabilities',
    logsDir: '/tmp/.tool-agents/cli-agent/logs',
    compositeCapabilitiesDir: '/tmp/.tool-agents/cli-agent/capabilities/composite',
    compositeDistillDir: '/tmp/.tool-agents/cli-agent/capabilities/composite/_distill',
    compositesDir: '/tmp/.tool-agents/cli-agent/composites',
    tools: [],
    capabilities: { depth: 2, maxBytesPerTool: 10240, timeoutMs: 5000, totalTimeoutMs: 60000, subcommandExtractor: '', skipLlmBelowBytes: 4096 },
    bash: { allow: [], allowedRoots: ['/tmp'], passEnv: ['PATH', 'HOME', 'LANG', 'TERM'], timeoutMs: 30000, maxOutputBytes: 1048576 },
    webSearch: { backend: 'tavily' },
    fileEdit: { root: '/tmp', allowPaths: [] },
    agentTools: { enabled: true, tools: { glob: true, grep: true, multiedit: true, patch: true, todoRead: false, todoWrite: false } },
    perToolBudgetBytes: 8192,
    baseUrl: undefined,
    webSearchBackend: 'tavily',
    bashAllow: [],
    bashPassSecrets: [],
    systemPromptPath: '/tmp/.tool-agents/cli-agent/capabilities/system-prompt.md',
    systemAppendText: undefined,
    systemAppendFile: undefined,
    providerEnv: {
      OPENAI_API_KEY: 'sk-test',
      OPENAI_BASE_URL: undefined,
      OPENAI_ORG_ID: undefined,
      ANTHROPIC_API_KEY: 'ant-test',
      ANTHROPIC_BASE_URL: undefined,
      GOOGLE_API_KEY: 'gkey-test',
      GEMINI_API_KEY: undefined,
      AZURE_OPENAI_API_KEY: 'azkey-test',
      AZURE_OPENAI_ENDPOINT: 'https://my-resource.openai.azure.com',
      AZURE_OPENAI_DEPLOYMENT: 'gpt-4o',
      AZURE_OPENAI_API_VERSION: '2024-02-01',
      AZURE_AI_INFERENCE_KEY: 'azai-test',
      AZURE_AI_INFERENCE_ENDPOINT: 'https://my-foundry.azure.com',
      ANTHROPIC_FOUNDRY_API_KEY: undefined,
      ANTHROPIC_FOUNDRY_ENDPOINT: undefined,
      OLLAMA_HOST: 'http://localhost:11434',
      LITELLM_PROXY_URL: 'http://localhost:4000',
      LITELLM_MASTER_KEY: 'lk-test',
      LITELLM_API_BASE: undefined,
      LITELLM_API_KEY: undefined,
    },
    ...overrides,
  };
}

describe('Provider registry', () => {
  it('openai creates ChatOpenAI', () => {
    const cfg = makeBaseConfig({ provider: 'openai', model: 'gpt-4o' });
    const model = REGISTRY['openai'](cfg);
    expect(model).toBeInstanceOf(ChatOpenAI);
  });

  it('anthropic creates ChatAnthropic', () => {
    const cfg = makeBaseConfig({ provider: 'anthropic', model: 'claude-3-5-sonnet-20241022' });
    const model = REGISTRY['anthropic'](cfg);
    expect(model).toBeInstanceOf(ChatAnthropic);
  });

  it('gemini creates ChatGoogleGenerativeAI', () => {
    const cfg = makeBaseConfig({ provider: 'gemini', model: 'gemini-2.0-flash' });
    const model = REGISTRY['gemini'](cfg);
    expect(model).toBeInstanceOf(ChatGoogleGenerativeAI);
  });

  it('azure-openai creates AzureChatOpenAI', () => {
    const cfg = makeBaseConfig({ provider: 'azure-openai', model: 'gpt-4o' });
    const model = REGISTRY['azure-openai'](cfg);
    expect(model).toBeInstanceOf(AzureChatOpenAI);
  });

  it('azure-anthropic creates ChatAnthropic', () => {
    const cfg = makeBaseConfig({ provider: 'azure-anthropic', model: 'claude-3-5-sonnet-20241022' });
    const model = REGISTRY['azure-anthropic'](cfg);
    expect(model).toBeInstanceOf(ChatAnthropic);
  });

  it('ollama creates ChatOpenAI', () => {
    const cfg = makeBaseConfig({ provider: 'ollama', model: 'llama3.2' });
    const model = REGISTRY['ollama'](cfg);
    expect(model).toBeInstanceOf(ChatOpenAI);
  });

  it('litellm creates ChatOpenAI', () => {
    const cfg = makeBaseConfig({ provider: 'litellm', model: 'gpt-4o' });
    const model = REGISTRY['litellm'](cfg);
    expect(model).toBeInstanceOf(ChatOpenAI);
  });

  it('mlx creates ChatOpenAI', () => {
    const cfg = makeBaseConfig({
      provider: 'mlx',
      model: 'mlx-community/Llama-3.2',
      providerEnv: { ...makeBaseConfig().providerEnv, OPENAI_BASE_URL: 'http://localhost:8080/v1' },
    });
    const model = REGISTRY['mlx'](cfg);
    expect(model).toBeInstanceOf(ChatOpenAI);
  });

  it('openai throws ConfigurationError when OPENAI_API_KEY missing', () => {
    const cfg = makeBaseConfig({
      provider: 'openai',
      providerEnv: { ...makeBaseConfig().providerEnv, OPENAI_API_KEY: undefined },
    });
    expect(() => REGISTRY['openai'](cfg)).toThrowError(/E_CONFIG_MISSING|OPENAI_API_KEY/);
  });
});
