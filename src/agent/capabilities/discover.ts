/**
 * Capability discovery orchestrator.
 *
 * For each declared tool:
 *  1. Check if the binary is on PATH
 *  2. Check cache validity (binaryPath + mtimeMs + versionHash)
 *  3. If miss: invoke --help recursively up to cfg.capabilities.depth
 *  4. Use LLM to extract subcommand list from top-level help
 *  5. For each subcommand (up to depth-1 more levels): invoke subcommand --help
 *  6. Compose and cache the capability document
 */

import path from 'node:path';
import { runHelp } from './runHelp.js';
import { extractSubcommands } from './extractSubcommands.js';
import { composeCapabilityDoc } from './composeMarkdown.js';
import { readCacheEntry, writeCacheEntry } from './cache.js';
import { getBinaryInfo, isCacheValid } from './invalidate.js';
import type { AgentConfig } from '../../config/agent-config.js';
import type { BaseChatModel } from '../providers/types.js';
import type { Logger } from '../logging.js';
import { newTurnId } from '../logging.js';

export interface DiscoveryResult {
  tool: string;
  status: 'ok' | 'cached' | 'failed' | 'not-found';
  message?: string;
  bytes?: number;
  durationMs?: number;
}

export async function discoverAllTools(
  cfg: AgentConfig,
  model: BaseChatModel,
  logger: Logger,
  forceRefresh = false,
): Promise<DiscoveryResult[]> {
  const results: DiscoveryResult[] = [];
  const deadline = Date.now() + cfg.capabilities.totalTimeoutMs;

  for (const tool of cfg.tools) {
    if (Date.now() > deadline) {
      results.push({ tool, status: 'failed', message: 'Total time budget exceeded.' });
      continue;
    }

    const result = await discoverTool(tool, cfg, model, logger, forceRefresh, deadline);
    results.push(result);
  }

  return results;
}

export async function discoverTool(
  tool: string,
  cfg: AgentConfig,
  model: BaseChatModel,
  logger: Logger,
  forceRefresh: boolean,
  deadline: number,
): Promise<DiscoveryResult> {
  const start = Date.now();
  const turnId = newTurnId();

  logger.log({
    kind: 'cli_invoke',
    ts: new Date().toISOString(),
    sessionId: logger.currentSessionId,
    turnId,
    binary: tool,
    argv: [tool, '--help'],
    cwd: process.cwd(),
  });

  // Check binary exists
  const binaryInfo = await getBinaryInfo(tool, cfg.capabilities.timeoutMs);
  if (!binaryInfo) {
    const msg = `Binary '${tool}' not found on PATH. Add it to PATH or check the tool name.`;
    process.stderr.write(`[cli-agent] WARNING: ${msg}\n`);
    // Write placeholder doc
    const placeholder = [
      '---',
      `tool: ${tool}`,
      `binaryPath: (not found)`,
      `binaryMtimeMs: 0`,
      `versionString: ""`,
      `versionHash: sha256:not-found`,
      `introspectedAt: ${new Date().toISOString()}`,
      `introspectionDepth: 0`,
      `introspectionBytes: 0`,
      `schemaVersion: 1`,
      '---',
      '',
      `<!-- AUTO-GENERATED:START hash=not-found -->`,
      `# ${tool} — BINARY NOT FOUND`,
      '',
      `The binary '${tool}' was not found on PATH when capability discovery ran.`,
      '<!-- AUTO-GENERATED:END -->',
      '',
      '<!-- USER-NOTES:START -->',
      '<!-- USER-NOTES:END -->',
    ].join('\n');
    await writeCacheEntry(cfg.capabilitiesDir, tool, placeholder);
    return { tool, status: 'not-found', message: msg, durationMs: Date.now() - start };
  }

  // Check cache validity
  if (!forceRefresh) {
    const cached = await readCacheEntry(cfg.capabilitiesDir, tool);
    if (cached && isCacheValid(cached.frontmatter, binaryInfo)) {
      return {
        tool,
        status: 'cached',
        bytes: cached.fullContent.length,
        durationMs: Date.now() - start,
      };
    }
  }

  // Read existing doc to preserve USER-NOTES
  const existing = await readCacheEntry(cfg.capabilitiesDir, tool);

  // Introspect top-level help
  const topLevelHelp = await runHelp(
    binaryInfo.resolvedPath,
    null,
    cfg.capabilities.timeoutMs,
    cfg.capabilities.maxBytesPerTool,
  );

  // Extract subcommands via LLM
  let subcommandInfos = await extractSubcommands(topLevelHelp.text, model);

  // Limit subcommands to keep within budget
  const MAX_SUBCOMMANDS = 20;
  if (subcommandInfos.length > MAX_SUBCOMMANDS) {
    subcommandInfos = subcommandInfos.slice(0, MAX_SUBCOMMANDS);
  }

  // Fetch per-subcommand help (depth = 1 for now; depth-2 would recurse)
  const subcommands: Array<{ name: string; synopsis: string; helpText: string }> = [];
  let totalBytes = topLevelHelp.text.length;

  if (cfg.capabilities.depth >= 2) {
    for (const sub of subcommandInfos) {
      if (Date.now() > deadline) break;
      if (totalBytes >= cfg.capabilities.maxBytesPerTool) break;

      const subHelp = await runHelp(
        binaryInfo.resolvedPath,
        sub.name,
        cfg.capabilities.timeoutMs,
        Math.min(2048, cfg.capabilities.maxBytesPerTool - totalBytes),
      );
      totalBytes += subHelp.text.length;
      subcommands.push({
        name: sub.name,
        synopsis: sub.oneLineSynopsis,
        helpText: subHelp.text,
      });
    }
  } else {
    // Depth 1: just record synopsis without drilling down
    for (const sub of subcommandInfos) {
      subcommands.push({ name: sub.name, synopsis: sub.oneLineSynopsis, helpText: '' });
    }
  }

  const doc = composeCapabilityDoc(
    {
      tool,
      binaryPath: binaryInfo.resolvedPath,
      binaryMtimeMs: binaryInfo.mtimeMs,
      versionString: binaryInfo.versionString,
      versionHash: binaryInfo.versionHash,
      introspectionDepth: cfg.capabilities.depth,
      introspectionBytes: totalBytes,
      topLevelHelp: topLevelHelp.text,
      subcommands,
    },
    existing?.fullContent,
  );

  await writeCacheEntry(cfg.capabilitiesDir, tool, doc);

  logger.log({
    kind: 'cli_result',
    ts: new Date().toISOString(),
    sessionId: logger.currentSessionId,
    turnId,
    binary: tool,
    exitCode: 0,
    durationMs: Date.now() - start,
    stdoutPreview: `Discovered ${subcommands.length} subcommands, ${totalBytes} bytes`,
    stderrPreview: '',
  });

  return {
    tool,
    status: 'ok',
    bytes: doc.length,
    durationMs: Date.now() - start,
  };
}
