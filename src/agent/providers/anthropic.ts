import { ChatAnthropic } from '@langchain/anthropic';
import type { AgentConfig } from '../../config/agent-config.js';
import { requireProviderEnv } from '../../config/agent-config.js';
import type { BaseChatModel } from './types.js';

export function createAnthropicProvider(cfg: AgentConfig): BaseChatModel {
  const apiKey = requireProviderEnv(cfg.providerEnv, 'ANTHROPIC_API_KEY', 'anthropic');
  const baseURL = cfg.baseUrl ?? cfg.providerEnv.ANTHROPIC_BASE_URL;

  return new ChatAnthropic({
    model: cfg.model,
    apiKey,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    ...(baseURL ? { anthropicApiUrl: baseURL } : {}),
  });
}
