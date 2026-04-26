import { ChatOpenAI } from '@langchain/openai';
import type { AgentConfig } from '../../config/agent-config.js';
import { requireProviderEnv } from '../../config/agent-config.js';
import type { BaseChatModel } from './types.js';

export function createOpenAIProvider(cfg: AgentConfig): BaseChatModel {
  const apiKey = requireProviderEnv(cfg.providerEnv, 'OPENAI_API_KEY', 'openai');
  const baseURL = cfg.baseUrl ?? cfg.providerEnv.OPENAI_BASE_URL;
  const orgId = cfg.providerEnv.OPENAI_ORG_ID;

  return new ChatOpenAI({
    model: cfg.model,
    apiKey,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
    configuration: {
      ...(baseURL ? { baseURL } : {}),
      ...(orgId ? { organization: orgId } : {}),
    },
  });
}
