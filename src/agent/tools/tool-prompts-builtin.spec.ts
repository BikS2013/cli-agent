/**
 * Registry-completeness invariant for `BUILTIN_TOOL_PROMPTS`.
 *
 * Every tool name returned by `buildToolCatalog` for a representative
 * "everything-on" config MUST have an entry in `BUILTIN_TOOL_PROMPTS`.
 * This catches the case where someone adds a new tool factory but
 * forgets to register the canonical description / parameter help in
 * the built-in registry.
 *
 * Also asserts that every entry has a non-empty description and that
 * each parameter description is non-empty.
 */

import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '../../config/agent-config.js';
import type { Logger } from '../logging.js';
import { buildToolCatalog } from './registry.js';
import { BUILTIN_TOOL_PROMPTS } from './tool-prompts-builtin.js';

const nullLogger: Logger = {
  log: () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
  get currentLogPath() { return ''; },
  get currentSessionId() { return 'test-session'; },
};

function makeMaximalCfg(): AgentConfig {
  return {
    fileEdit: { root: '/tmp/x', allowPaths: [] },
    perToolBudgetBytes: 8192,
    capabilitiesDir: '/tmp/x/capabilities',
    bash: {
      allow: ['git'],
      allowedRoots: ['/tmp/x'],
      passEnv: ['PATH'],
      timeoutMs: 5000,
      maxOutputBytes: 1048576,
    },
    bashAllow: ['git'],
    bashPassSecrets: [],
    allowMutations: true,
    webSearch: { backend: 'tavily' },
    webSearchBackend: 'tavily',
    agentTools: {
      enabled: true,
      tools: { glob: true, grep: true, multiedit: true, patch: true, todoRead: true, todoWrite: true, webSearch: true, webFetch: true, fileRead: true, fileList: true, fileWrite: true, fileEdit: true, fileAppend: true },
    },
    provider: 'openai',
    model: 'gpt-4o',
    maxSteps: 25,
    temperature: undefined,
    verbose: false,
    agentDir: '/tmp/x',
    logsDir: '/tmp/x/logs',
    providerEnv: {
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_ORG_ID: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      GOOGLE_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      AZURE_OPENAI_API_KEY: undefined,
      AZURE_OPENAI_ENDPOINT: undefined,
      AZURE_OPENAI_DEPLOYMENT: undefined,
      AZURE_OPENAI_API_VERSION: undefined,
      AZURE_AI_INFERENCE_KEY: undefined,
      AZURE_AI_INFERENCE_ENDPOINT: undefined,
      ANTHROPIC_FOUNDRY_API_KEY: undefined,
      ANTHROPIC_FOUNDRY_ENDPOINT: undefined,
      OLLAMA_HOST: undefined,
      LITELLM_PROXY_URL: undefined,
      LITELLM_MASTER_KEY: undefined,
      LITELLM_API_BASE: undefined,
      LITELLM_API_KEY: undefined,
    },
    tools: [],
    capabilities: {
      depth: 2,
      maxBytesPerTool: 10240,
      timeoutMs: 5000,
      totalTimeoutMs: 60000,
      subcommandExtractor: '',
      skipLlmBelowBytes: 4096,
    },
    baseUrl: undefined,
    systemPromptPath: '/tmp/x/system-prompt.md',
    systemAppendText: undefined,
    systemAppendFile: undefined,
  } as unknown as AgentConfig;
}

describe('BUILTIN_TOOL_PROMPTS — registry-completeness', () => {
  it('contains an entry for every tool returned by buildToolCatalog', () => {
    const cfg = makeMaximalCfg();
    const catalog = buildToolCatalog(cfg, nullLogger);
    const toolNames = catalog.tools.map((t: { name: string }) => t.name);
    for (const name of toolNames) {
      expect(BUILTIN_TOOL_PROMPTS[name], `missing built-in prompt for ${name}`).toBeDefined();
    }
  });

  it('contains exactly the 17 documented tools', () => {
    // plan-011: web_search / web_fetch left the built-in set and re-entered as
    // the first-party agt_web_search / agt_web_fetch members of the agt_* pack.
    // plan-012: file_read/list/write/edit/append likewise re-entered as the
    // first-party agt_file_* members. Count stays 17 (5 renamed in place).
    const expected = [
      'agt_file_read', 'agt_file_list', 'agt_file_write', 'agt_file_edit', 'agt_file_append',
      'bash_run', 'bash_list_allowed', 'bash_which',
      'tool_help',
      'agt_glob', 'agt_grep', 'agt_multiedit', 'agt_patch', 'agt_todo_read', 'agt_todo_write',
      'agt_web_search', 'agt_web_fetch',
    ].sort();
    const actual = Object.keys(BUILTIN_TOOL_PROMPTS).sort();
    expect(actual).toEqual(expected);
  });

  it('every entry has a non-empty description', () => {
    for (const [name, builtin] of Object.entries(BUILTIN_TOOL_PROMPTS)) {
      expect(builtin.description.length, `${name} description must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('every parameter description is non-empty', () => {
    for (const [name, builtin] of Object.entries(BUILTIN_TOOL_PROMPTS)) {
      for (const [param, desc] of Object.entries(builtin.parameters)) {
        expect(desc.length, `${name}.${param} must have a non-empty description`).toBeGreaterThan(0);
      }
    }
  });
});
