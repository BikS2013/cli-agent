import { ChatOpenAI } from '@langchain/openai';
import type { AgentConfig } from '../../config/agent-config.js';
import { requireProviderEnv, AGENT_TOOL_NAME } from '../../config/agent-config.js';
import { ConfigurationError } from '../../errors.js';
import type { BaseChatModel } from './types.js';

export function createMLXProvider(cfg: AgentConfig): BaseChatModel {
  if (!cfg.model) {
    throw new ConfigurationError(
      'model (required for mlx — e.g. mlx-community/Llama-3.2-3B-Instruct-4bit)',
      ['CLI --model', `~/.tool-agents/${AGENT_TOOL_NAME}/config.json model`],
    );
  }

  // MLX-LM reuses OPENAI_BASE_URL; --base-url overrides
  const baseURL = cfg.baseUrl ?? cfg.providerEnv.OPENAI_BASE_URL;
  if (!baseURL) {
    requireProviderEnv(cfg.providerEnv, 'OPENAI_BASE_URL', 'mlx');
  }

  const apiKey = cfg.providerEnv.OPENAI_API_KEY ?? 'not-needed';

  return new ChatOpenAI({
    model: cfg.model,
    apiKey,
    configuration: { baseURL: baseURL! },
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
  });
}
