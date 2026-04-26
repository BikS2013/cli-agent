/**
 * LangGraph ReAct agent graph builder.
 * Uses createReactAgent from @langchain/langgraph/prebuilt.
 */

import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { HumanMessage } from '@langchain/core/messages';
import { MemorySaver } from '@langchain/langgraph';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { DynamicStructuredTool } from '@langchain/core/tools';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyGraph = ReturnType<typeof createReactAgent>;

export interface AgentGraph {
  readonly graph: AnyGraph;
  readonly checkpointer: MemorySaver;
}

export function buildAgentGraph(
  llm: BaseChatModel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: DynamicStructuredTool[],
  systemPrompt: string,
  maxSteps: number,
): AgentGraph {
  const checkpointer = new MemorySaver();

  const graph = createReactAgent({
    llm,
    tools,
    stateModifier: systemPrompt,
    checkpointSaver: checkpointer,
  });

  return { graph, checkpointer };
}

export async function runOneShot(
  agentGraph: AgentGraph,
  prompt: string,
  threadId: string,
  maxSteps: number,
): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invokeOptions: Record<string, any> = {
    configurable: { thread_id: threadId },
    recursionLimit: maxSteps * 2,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await agentGraph.graph.invoke(
    { messages: [new HumanMessage(prompt)] },
    invokeOptions,
  );

  const messages = result['messages'] as Array<{ content: unknown }>;
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage) return '';

  const content = lastMessage.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter((c) => typeof c === 'object' && c !== null && 'text' in c)
      .map((c) => c.text ?? '')
      .join('');
  }
  return JSON.stringify(content);
}
