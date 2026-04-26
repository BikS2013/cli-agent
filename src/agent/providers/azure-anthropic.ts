import { ChatAnthropic } from '@langchain/anthropic';
import type { AgentConfig } from '../../config/agent-config.js';
import { requireProviderEnv, AGENT_TOOL_NAME } from '../../config/agent-config.js';
import { ConfigurationError } from '../../errors.js';
import { normalizeFoundryEndpoint } from './util.js';
import type { BaseChatModel } from './types.js';

export function createAzureAnthropicProvider(cfg: AgentConfig): BaseChatModel {
  // Canonical: AZURE_AI_INFERENCE_KEY; alias: ANTHROPIC_FOUNDRY_API_KEY
  const apiKey =
    cfg.providerEnv.AZURE_AI_INFERENCE_KEY ??
    cfg.providerEnv.ANTHROPIC_FOUNDRY_API_KEY;

  if (!apiKey) {
    requireProviderEnv(cfg.providerEnv, 'AZURE_AI_INFERENCE_KEY', 'azure-anthropic');
  }

  // Canonical: AZURE_AI_INFERENCE_ENDPOINT; alias: ANTHROPIC_FOUNDRY_ENDPOINT
  const rawEndpoint =
    cfg.providerEnv.AZURE_AI_INFERENCE_ENDPOINT ??
    cfg.providerEnv.ANTHROPIC_FOUNDRY_ENDPOINT;

  if (!rawEndpoint) {
    requireProviderEnv(cfg.providerEnv, 'AZURE_AI_INFERENCE_ENDPOINT', 'azure-anthropic');
  }

  const baseURL = normalizeFoundryEndpoint(rawEndpoint!);

  if (!cfg.model) {
    throw new ConfigurationError(
      'model (required for azure-anthropic)',
      [`CLI --model`, `~/.tool-agents/${AGENT_TOOL_NAME}/config.json model`],
    );
  }

  return new ChatAnthropic({
    model: cfg.model,
    apiKey: apiKey!,
    anthropicApiUrl: baseURL,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
  });
}
