import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AgentConfig } from '../../config/agent-config.js';

export type { BaseChatModel };
export type ProviderFactory = (cfg: AgentConfig) => BaseChatModel;
