import { AzureChatOpenAI } from '@langchain/openai';
import type { AgentConfig } from '../../config/agent-config.js';
import { requireProviderEnv } from '../../config/agent-config.js';
import type { BaseChatModel } from './types.js';

export function createAzureOpenAIProvider(cfg: AgentConfig): BaseChatModel {
  const apiKey = requireProviderEnv(cfg.providerEnv, 'AZURE_OPENAI_API_KEY', 'azure-openai');
  const endpoint = requireProviderEnv(cfg.providerEnv, 'AZURE_OPENAI_ENDPOINT', 'azure-openai');
  const deployment = requireProviderEnv(cfg.providerEnv, 'AZURE_OPENAI_DEPLOYMENT', 'azure-openai');
  const apiVersion = requireProviderEnv(cfg.providerEnv, 'AZURE_OPENAI_API_VERSION', 'azure-openai');

  // model can be the deployment name or explicitly provided via --model
  const model = cfg.model || deployment;

  return new AzureChatOpenAI({
    azureOpenAIApiKey: apiKey,
    azureOpenAIEndpoint: endpoint,
    azureOpenAIApiDeploymentName: deployment,
    azureOpenAIApiVersion: apiVersion,
    model,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
  });
}
