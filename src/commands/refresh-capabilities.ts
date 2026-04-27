/**
 * refresh-capabilities command: re-run discovery for one or all tools.
 */

import type { AgentCliFlags } from '../config/agent-config.js';
import { loadAgentConfig } from '../config/agent-config.js';
import { createLogger } from '../agent/logging.js';
import { createLLM } from '../agent/providers/registry.js';
import { discoverTool, defaultDiscoveryReporter } from '../agent/capabilities/discover.js';
import { isLoggingDisabledByEnv } from '../config/agent-config.js';
import { UsageError } from '../errors.js';

export async function runRefreshCapabilities(
  toolName: string | undefined,
  opts: AgentCliFlags,
): Promise<void> {
  const cfg = await loadAgentConfig(opts);

  const toolsToRefresh = toolName
    ? [toolName]
    : cfg.tools;

  if (toolsToRefresh.length === 0) {
    throw new UsageError(
      'No tools configured. Pass --tool <name> or add tools[] to config.json.',
    );
  }

  const loggingEnabled = !isLoggingDisabledByEnv();
  const logger = createLogger({
    toolDir: cfg.agentDir,
    enabled: loggingEnabled,
  });

  const llm = createLLM(cfg);
  const deadline = Date.now() + cfg.capabilities.totalTimeoutMs;

  process.stderr.write(`Refreshing capabilities for: ${toolsToRefresh.join(', ')}\n\n`);

  const reporter = defaultDiscoveryReporter();
  const rows: Array<{ tool: string; status: string; bytes: number; durationMs: number }> = [];

  for (const tool of toolsToRefresh) {
    // forceFullInvestigation=true → bypass the skipLlmBelowBytes fast
    // path so the LLM extractor always runs, regardless of how small
    // the top-level --help happens to be. `refresh-capabilities` is the
    // user's explicit "redo everything" knob, so partial discovery here
    // would defeat its purpose.
    const result = await discoverTool(tool, cfg, llm, logger, true, deadline, reporter, true);
    rows.push({
      tool: result.tool,
      status: result.status,
      bytes: result.bytes ?? 0,
      durationMs: result.durationMs ?? 0,
    });
  }

  // Print table to stderr
  process.stderr.write('Tool                 Status      Bytes   Duration\n');
  process.stderr.write('----                 ------      -----   --------\n');
  for (const row of rows) {
    process.stderr.write(
      `${row.tool.padEnd(20)} ${row.status.padEnd(10)} ${String(row.bytes).padEnd(7)} ${row.durationMs}ms\n`,
    );
  }

  await logger.close();
}
