import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import type { AgentConfig } from '../../config/agent-config.js';
import { requireProviderEnv } from '../../config/agent-config.js';
import type { BaseChatModel } from './types.js';

export function createGeminiProvider(cfg: AgentConfig): BaseChatModel {
  // Canonical: GOOGLE_API_KEY; alias: GEMINI_API_KEY
  const apiKey =
    cfg.providerEnv.GOOGLE_API_KEY ??
    cfg.providerEnv.GEMINI_API_KEY;

  if (!apiKey) {
    requireProviderEnv(cfg.providerEnv, 'GOOGLE_API_KEY', 'gemini');
    throw new Error('unreachable'); // requireProviderEnv throws
  }

  return new ChatGoogleGenerativeAI({
    model: cfg.model,
    apiKey,
    ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
  });
}
