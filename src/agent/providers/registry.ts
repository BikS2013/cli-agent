import type { AgentConfig, ProviderName } from '../../config/agent-config.js';
import { ProviderNotSupportedError } from '../../errors.js';
import { createOpenAIProvider } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createGeminiProvider } from './gemini.js';
import { createAzureOpenAIProvider } from './azure-openai.js';
import { createAzureAnthropicProvider } from './azure-anthropic.js';
import { createOllamaProvider } from './ollama.js';
import { createLiteLLMProvider } from './litellm.js';
import { createMLXProvider } from './mlx.js';
import type { BaseChatModel } from './types.js';

const REGISTRY: Record<ProviderName, (cfg: AgentConfig) => BaseChatModel> = {
  openai: createOpenAIProvider,
  anthropic: createAnthropicProvider,
  gemini: createGeminiProvider,
  'azure-openai': createAzureOpenAIProvider,
  'azure-anthropic': createAzureAnthropicProvider,
  ollama: createOllamaProvider,
  litellm: createLiteLLMProvider,
  mlx: createMLXProvider,
};

export function createLLM(cfg: AgentConfig): BaseChatModel {
  const factory = REGISTRY[cfg.provider];
  if (!factory) {
    throw new ProviderNotSupportedError(cfg.provider);
  }
  return factory(cfg);
}

export { REGISTRY };
