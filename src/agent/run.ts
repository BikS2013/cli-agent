/**
 * Agent runners: one-shot and interactive (REPL) modes.
 */

import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../config/agent-config.js';
import { agentToolAgentsDir, isLoggingDisabledByEnv } from '../config/agent-config.js';
import { createLLM } from './providers/registry.js';
import { buildToolCatalog } from './tools/registry.js';
import { buildSystemPrompt, loadSystemPromptFile } from './system-prompt.js';
import { buildAgentGraph, runOneShot } from './graph.js';
import { createLogger, CLI_VERSION } from './logging.js';
import { discoverAllTools } from './capabilities/discover.js';
import { composeCapabilitiesSystemPrompt } from './capabilities/compose-system-prompt.js';
import { redactString } from '../util/redact.js';

export async function runOneShotAgent(cfg: AgentConfig, prompt: string): Promise<string> {
  const loggingEnabled = !isLoggingDisabledByEnv();
  const logger = createLogger({
    toolDir: agentToolAgentsDir(),
    enabled: loggingEnabled,
  });

  const sessionId = logger.currentSessionId;
  const threadId = randomUUID();

  const llm = createLLM(cfg);
  const tools = buildToolCatalog(cfg, logger);

  // Capability discovery
  if (cfg.tools.length > 0) {
    await discoverAllTools(cfg, llm, logger);
  }

  // Build system prompt
  const capSection = await composeCapabilitiesSystemPrompt(
    cfg.capabilitiesDir,
    cfg.tools,
    cfg.capabilities.maxBytesPerTool,
  );

  let customText: string | undefined;
  if (cfg.baseUrl === undefined) {
    // Check for system prompt flag — access via config if stored
  }

  const systemPrompt = await buildSystemPrompt(capSection);

  logger.log({
    kind: 'session_start',
    ts: new Date().toISOString(),
    sessionId,
    threadId,
    provider: cfg.provider,
    model: cfg.model,
    allowMutations: cfg.allowMutations,
    cliVersion: CLI_VERSION,
  });

  logger.log({
    kind: 'user_prompt',
    ts: new Date().toISOString(),
    sessionId,
    turnId: 'turn-0',
    prompt: prompt.length > 2048 ? `<prompt truncated, ${prompt.length} chars>` : prompt,
  });

  if (cfg.verbose) {
    process.stderr.write(
      redactString(`[cli-agent] provider=${cfg.provider} model=${cfg.model} tools=${tools.length} thread=${threadId}\n`),
    );
  }

  const agentGraph = buildAgentGraph(llm, tools, systemPrompt, cfg.maxSteps);

  let answer: string;
  let terminatedByError = false;
  try {
    answer = await runOneShot(agentGraph, prompt, threadId, cfg.maxSteps);
  } catch (e) {
    terminatedByError = true;
    logger.log({
      kind: 'error',
      ts: new Date().toISOString(),
      sessionId,
      code: (e instanceof Error ? e.constructor.name : 'E_UNKNOWN'),
      message: e instanceof Error ? e.message : String(e),
    });
    throw e;
  } finally {
    logger.log({
      kind: 'session_end',
      ts: new Date().toISOString(),
      sessionId,
      reason: terminatedByError ? 'crash' : 'quit',
    });
    await logger.close();
  }

  return answer;
}

export async function runInteractiveAgent(cfg: AgentConfig): Promise<void> {
  const loggingEnabled = !isLoggingDisabledByEnv();
  const logger = createLogger({
    toolDir: agentToolAgentsDir(),
    enabled: loggingEnabled,
  });

  const sessionId = logger.currentSessionId;
  let threadId = randomUUID();

  const llm = createLLM(cfg);
  const tools = buildToolCatalog(cfg, logger);

  if (cfg.tools.length > 0) {
    await discoverAllTools(cfg, llm, logger);
  }

  const capSection = await composeCapabilitiesSystemPrompt(
    cfg.capabilitiesDir,
    cfg.tools,
    cfg.capabilities.maxBytesPerTool,
  );
  const systemPrompt = await buildSystemPrompt(capSection);

  logger.log({
    kind: 'session_start',
    ts: new Date().toISOString(),
    sessionId,
    threadId,
    provider: cfg.provider,
    model: cfg.model,
    allowMutations: cfg.allowMutations,
    cliVersion: CLI_VERSION,
  });

  const agentGraph = buildAgentGraph(llm, tools, systemPrompt, cfg.maxSteps);

  process.stdout.write(`cli-agent interactive session (provider: ${cfg.provider}, model: ${cfg.model})\n`);
  process.stdout.write('Type your message, /exit to quit, /reset to start a new conversation.\n\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });

  let sigintReceived = false;

  process.on('SIGINT', () => {
    sigintReceived = true;
    rl.close();
    logger.log({
      kind: 'session_end',
      ts: new Date().toISOString(),
      sessionId,
      reason: 'sigint',
    });
    void logger.close().then(() => {
      process.exit(130);
    });
  });

  rl.on('line', async (line) => {
    if (sigintReceived) return;
    const input = line.trim();
    if (!input) return;

    if (input === '/exit' || input === '/quit') {
      rl.close();
      logger.log({ kind: 'session_end', ts: new Date().toISOString(), sessionId, reason: 'quit' });
      await logger.close();
      process.exit(0);
    }

    if (input === '/reset') {
      threadId = randomUUID();
      process.stdout.write('[Session reset]\n\n');
      return;
    }

    logger.log({
      kind: 'user_prompt',
      ts: new Date().toISOString(),
      sessionId,
      turnId: 'turn-interactive',
      prompt: input,
    });

    try {
      const answer = await runOneShot(agentGraph, input, threadId, cfg.maxSteps);
      process.stdout.write('\n' + answer + '\n\n');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(redactString(`Error: ${msg}\n`));
      logger.log({
        kind: 'error',
        ts: new Date().toISOString(),
        sessionId,
        code: 'E_AGENT_RUNTIME',
        message: msg,
      });
    }
  });

  rl.on('close', async () => {
    if (!sigintReceived) {
      logger.log({ kind: 'session_end', ts: new Date().toISOString(), sessionId, reason: 'quit' });
      await logger.close();
    }
  });
}
