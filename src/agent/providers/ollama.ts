import { ChatOpenAI } from '@langchain/openai';
import type { AgentConfig } from '../../config/agent-config.js';
import { AGENT_TOOL_NAME } from '../../config/agent-config.js';
import { ConfigurationError } from '../../errors.js';
import { normalizeOllamaBaseUrl } from './util.js';
import type { BaseChatModel } from './types.js';

export function createOllamaProvider(cfg: AgentConfig): BaseChatModel {
  if (!cfg.model) {
    throw new ConfigurationError(
      'model (required for ollama — e.g. llama3.2)',
      ['CLI --model', `~/.tool-agents/${AGENT_TOOL_NAME}/config.json model`],
    );
  }

  const host = cfg.baseUrl ?? cfg.providerEnv.OLLAMA_HOST;
  if (!host) {
    throw new ConfigurationError(
      'OLLAMA_HOST',
      ['env:OLLAMA_HOST', `~/.tool-agents/${AGENT_TOOL_NAME}/.env`, 'CLI --base-url'],
    );
  }

  const baseURL = normalizeOllamaBaseUrl(host);

  return new ChatOpenAI({
    model: cfg.model,
    apiKey: 'not-needed',
    configuration: { baseURL },
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
  });
}
