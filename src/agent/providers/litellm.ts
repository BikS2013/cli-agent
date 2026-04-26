import { ChatOpenAI } from '@langchain/openai';
import type { AgentConfig } from '../../config/agent-config.js';
import { requireProviderEnv, AGENT_TOOL_NAME } from '../../config/agent-config.js';
import { ConfigurationError } from '../../errors.js';
import type { BaseChatModel } from './types.js';

export function createLiteLLMProvider(cfg: AgentConfig): BaseChatModel {
  if (!cfg.model) {
    throw new ConfigurationError(
      'model (required for litellm)',
      ['CLI --model', `~/.tool-agents/${AGENT_TOOL_NAME}/config.json model`],
    );
  }

  // Canonical: LITELLM_PROXY_URL; alias: LITELLM_API_BASE
  const baseURL =
    cfg.baseUrl ??
    cfg.providerEnv.LITELLM_PROXY_URL ??
    cfg.providerEnv.LITELLM_API_BASE;

  if (!baseURL) {
    requireProviderEnv(cfg.providerEnv, 'LITELLM_PROXY_URL', 'litellm');
  }

  // Canonical: LITELLM_MASTER_KEY; alias: LITELLM_API_KEY
  const apiKey =
    cfg.providerEnv.LITELLM_MASTER_KEY ??
    cfg.providerEnv.LITELLM_API_KEY ??
    'not-needed';

  return new ChatOpenAI({
    model: cfg.model,
    apiKey,
    configuration: { baseURL: baseURL! },
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
  });
}
