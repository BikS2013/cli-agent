/**
 * Agent runners: one-shot and interactive (REPL) modes.
 */

import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';
import type { AgentConfig } from '../config/agent-config.js';
import { agentToolAgentsDir, isLoggingDisabledByEnv } from '../config/agent-config.js';
import { createLLM } from './providers/registry.js';
import { buildToolCatalog } from './tools/registry.js';
import { buildSystemPromptForCfg } from './system-prompt.js';
import { buildAgentGraph, runOneShot, streamOneShot, type AgentStreamEvent, type AgentGraph } from './graph.js';
import { createLogger, CLI_VERSION } from './logging.js';
import { discoverAllTools, defaultDiscoveryReporter } from './capabilities/discover.js';
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
  const { tools, agentToolsMeta } = buildToolCatalog(cfg, logger);

  // Capability discovery
  if (cfg.tools.length > 0) {
    await discoverAllTools(cfg, llm, logger, false, defaultDiscoveryReporter());
  }

  // Build system prompt (base loaded from cfg.systemPromptPath; --system /
  // --system-file additions composed on top by buildSystemPromptForCfg).
  const capSection = await composeCapabilitiesSystemPrompt(
    cfg.capabilitiesDir,
    cfg.tools,
    cfg.capabilities.maxBytesPerTool,
  );

  const systemPrompt = await buildSystemPromptForCfg(cfg, capSection, agentToolsMeta);

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

  const agentGraph = buildAgentGraph(llm, tools, systemPrompt, cfg.maxSteps, cfg);

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

/**
 * Streaming sibling of runOneShotAgent — yields AgentStreamEvent values as
 * they arrive and returns the assembled assistant text. Used by:
 *   - the new TUI (src/tui/) for live token rendering
 *   - the one-shot CLI path (src/commands/agent.ts) so prompts stream too
 *
 * Reuses the existing setup helpers (createLLM / buildToolCatalog /
 * discoverAllTools / composeCapabilitiesSystemPrompt / buildSystemPrompt /
 * buildAgentGraph). The session lifecycle (logger, session_start, user_prompt,
 * session_end) mirrors runOneShotAgent.
 */
export async function* streamOneShotAgent(
  cfg: AgentConfig,
  prompt: string,
  abortSignal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent, string, void> {
  const loggingEnabled = !isLoggingDisabledByEnv();
  const logger = createLogger({
    toolDir: agentToolAgentsDir(),
    enabled: loggingEnabled,
  });

  const sessionId = logger.currentSessionId;
  const threadId = randomUUID();

  const llm = createLLM(cfg);
  const { tools, agentToolsMeta } = buildToolCatalog(cfg, logger);

  if (cfg.tools.length > 0) {
    await discoverAllTools(cfg, llm, logger, false, defaultDiscoveryReporter());
  }

  const capSection = await composeCapabilitiesSystemPrompt(
    cfg.capabilitiesDir,
    cfg.tools,
    cfg.capabilities.maxBytesPerTool,
  );
  const systemPrompt = await buildSystemPromptForCfg(cfg, capSection, agentToolsMeta);

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
    turnId: 'turn-stream-0',
    prompt: prompt.length > 2048 ? `<prompt truncated, ${prompt.length} chars>` : prompt,
  });

  if (cfg.verbose) {
    process.stderr.write(
      redactString(`[cli-agent] streaming provider=${cfg.provider} model=${cfg.model} tools=${tools.length} thread=${threadId}\n`),
    );
  }

  const agentGraph = buildAgentGraph(llm, tools, systemPrompt, cfg.maxSteps, cfg);

  let assembled = '';
  let terminatedByError = false;
  try {
    const opts: { logger: typeof logger; sessionId: string; abortSignal?: AbortSignal } = {
      logger,
      sessionId,
    };
    if (abortSignal) opts.abortSignal = abortSignal;
    const it = streamOneShot(agentGraph, prompt, threadId, cfg.maxSteps, opts);
    while (true) {
      const next = await it.next();
      if (next.done) {
        assembled = next.value ?? assembled;
        break;
      }
      yield next.value;
    }
  } catch (e) {
    terminatedByError = true;
    logger.log({
      kind: 'error',
      ts: new Date().toISOString(),
      sessionId,
      code: e instanceof Error ? e.constructor.name : 'E_UNKNOWN',
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

  return assembled;
}

/**
 * Build everything a TUI needs from a single AgentConfig: the LLM, the tool
 * catalog, the agent graph, and a logger. Re-exported helper used by
 * src/tui/controller.ts so the TUI doesn't reach into private setup paths.
 */
export interface TuiAgentRuntime {
  agentGraph: AgentGraph;
  logger: ReturnType<typeof createLogger>;
  sessionId: string;
}

export async function buildTuiAgentRuntime(cfg: AgentConfig): Promise<TuiAgentRuntime> {
  const loggingEnabled = !isLoggingDisabledByEnv();
  const logger = createLogger({
    toolDir: agentToolAgentsDir(),
    enabled: loggingEnabled,
  });
  const sessionId = logger.currentSessionId;

  const llm = createLLM(cfg);
  const { tools, agentToolsMeta } = buildToolCatalog(cfg, logger);

  if (cfg.tools.length > 0) {
    await discoverAllTools(cfg, llm, logger, false, defaultDiscoveryReporter());
  }

  const capSection = await composeCapabilitiesSystemPrompt(
    cfg.capabilitiesDir,
    cfg.tools,
    cfg.capabilities.maxBytesPerTool,
  );
  const systemPrompt = await buildSystemPromptForCfg(cfg, capSection, agentToolsMeta);

  logger.log({
    kind: 'session_start',
    ts: new Date().toISOString(),
    sessionId,
    threadId: 'tui-bootstrap',
    provider: cfg.provider,
    model: cfg.model,
    allowMutations: cfg.allowMutations,
    cliVersion: CLI_VERSION,
  });

  const agentGraph = buildAgentGraph(llm, tools, systemPrompt, cfg.maxSteps, cfg);
  return { agentGraph, logger, sessionId };
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
  const { tools, agentToolsMeta } = buildToolCatalog(cfg, logger);

  if (cfg.tools.length > 0) {
    await discoverAllTools(cfg, llm, logger, false, defaultDiscoveryReporter());
  }

  const capSection = await composeCapabilitiesSystemPrompt(
    cfg.capabilitiesDir,
    cfg.tools,
    cfg.capabilities.maxBytesPerTool,
  );
  const systemPrompt = await buildSystemPromptForCfg(cfg, capSection, agentToolsMeta);

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

  const agentGraph = buildAgentGraph(llm, tools, systemPrompt, cfg.maxSteps, cfg);

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
