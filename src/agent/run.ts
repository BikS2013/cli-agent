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
import { createLogger, CLI_VERSION, type Logger } from './logging.js';
import { createIoCapture } from './io-capture.js';
import type { IoCapture } from './io-capture.js';
import { discoverAllTools, defaultDiscoveryReporter } from './capabilities/discover.js';
import { composeCapabilitiesSystemPrompt } from './capabilities/compose-system-prompt.js';
import { redactString } from '../util/redact.js';

export interface AgentRuntime {
  agentGraph: AgentGraph;
  logger: Logger;
  sessionId: string;
  threadId: string;
  /**
   * Parallel LLM-I/O capture channel (plan-007). Callers that finish a
   * session own closing it alongside the logger. Long-lived callers such as
   * the TUI hand ownership to their controller.
   */
  ioCapture: IoCapture;
  tools: ReadonlyArray<{ name: string }>;
}

export interface AssembleAgentRuntimeOptions {
  /** Initial thread id to record in session_start and use for first graph calls. */
  threadId?: string;
}

function logSessionStart(logger: Logger, cfg: AgentConfig, sessionId: string, threadId: string): void {
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
}

function logActiveProfile(logger: Logger, cfg: AgentConfig, sessionId: string): void {
  if (!cfg.activeProfile) return;
  logger.log({
    kind: 'profile_active',
    ts: new Date().toISOString(),
    sessionId,
    profileName: cfg.activeProfile.name,
    profilePath: cfg.activeProfile.path,
    schemaVersion: cfg.activeProfile.schemaVersion,
    digest: cfg.activeProfile.digest,
  });
}

export async function assembleAgentRuntime(
  cfg: AgentConfig,
  opts: AssembleAgentRuntimeOptions = {},
): Promise<AgentRuntime> {
  const loggingEnabled = !isLoggingDisabledByEnv();
  const logger = createLogger({
    toolDir: agentToolAgentsDir(),
    enabled: loggingEnabled,
  });

  const sessionId = logger.currentSessionId;
  const threadId = opts.threadId ?? randomUUID();

  const llm = createLLM(cfg);
  const { tools, agentToolsMeta } = buildToolCatalog(cfg, logger);

  // Parallel LLM-I/O capture channel (plan-007). `NullIoCapture` (no-op) when
  // `cfg.inspectIo === null`; a `FileIoCapture` when `--inspect-io` is set. A
  // dir/file that cannot be created raises `ConfigurationError` (no fallback).
  const ioCapture = createIoCapture(cfg, sessionId, tools);

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

  const systemPrompt = await buildSystemPromptForCfg(cfg, capSection, agentToolsMeta, tools);

  logSessionStart(logger, cfg, sessionId, threadId);
  logActiveProfile(logger, cfg, sessionId);

  const agentGraph = buildAgentGraph(llm, tools, systemPrompt, cfg.maxSteps, cfg);

  return { agentGraph, logger, sessionId, threadId, ioCapture, tools };
}

export async function runOneShotAgent(cfg: AgentConfig, prompt: string): Promise<string> {
  const runtime = await assembleAgentRuntime(cfg);
  const { agentGraph, logger, sessionId, threadId, ioCapture, tools } = runtime;

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

  let answer: string;
  let terminatedByError = false;
  try {
    answer = await runOneShot(agentGraph, prompt, threadId, cfg.maxSteps, { ioCapture, sessionId });
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
    await ioCapture.close();
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
  const runtime = await assembleAgentRuntime(cfg);
  const { agentGraph, logger, sessionId, threadId, ioCapture, tools } = runtime;

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

  let assembled = '';
  let terminatedByError = false;
  try {
    const opts: {
      logger: typeof logger;
      sessionId: string;
      ioCapture: IoCapture;
      abortSignal?: AbortSignal;
    } = {
      logger,
      sessionId,
      ioCapture,
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
    await ioCapture.close();
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
  /**
   * Parallel LLM-I/O capture channel (plan-007). `NullIoCapture` (no-op) when
   * `cfg.inspectIo === null`; a `FileIoCapture` when `--inspect-io` is set. The
   * TUI controller owns the close on session end (it is NOT closed here).
   */
  ioCapture: IoCapture;
}

export async function buildTuiAgentRuntime(cfg: AgentConfig): Promise<TuiAgentRuntime> {
  const { agentGraph, logger, sessionId, ioCapture } = await assembleAgentRuntime(cfg, {
    threadId: 'tui-bootstrap',
  });
  return { agentGraph, logger, sessionId, ioCapture };
}

export async function runInteractiveAgent(cfg: AgentConfig): Promise<void> {
  const runtime = await assembleAgentRuntime(cfg);
  const { agentGraph, logger, sessionId, ioCapture } = runtime;
  let { threadId } = runtime;

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
    void Promise.all([logger.close(), ioCapture.close()]).then(() => {
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
      await ioCapture.close();
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
      const answer = await runOneShot(agentGraph, input, threadId, cfg.maxSteps, { ioCapture, sessionId });
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
      await ioCapture.close();
    }
  });
}
