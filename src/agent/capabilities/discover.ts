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
import { getBinaryInfo } from './invalidate.js';
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

/**
 * Phase events emitted during discovery so the caller can render live
 * progress (e.g. to stderr in the TUI / one-shot startup). The agent
 * runtime installs a default reporter that shows the user which tool is
 * being discovered AND breaks down the per-phase wall time so the LLM
 * round-trip cost (almost always the dominant cost for small tools like
 * `zip`) is visible. See `defaultDiscoveryReporter()` below.
 */
export type DiscoveryPhase =
  | { kind: 'start'; tool: string }
  | { kind: 'cache_hit'; tool: string; bytes: number; durationMs: number }
  | { kind: 'probe'; tool: string; durationMs: number }
  | { kind: 'help'; tool: string; durationMs: number; bytes: number }
  | { kind: 'extract_start'; tool: string }
  | { kind: 'extract_end'; tool: string; durationMs: number; subcommandCount: number }
  | { kind: 'extract_skipped'; tool: string; reason: string; helpBytes: number }
  | { kind: 'subcommands'; tool: string; durationMs: number; count: number; bytes: number }
  | { kind: 'done'; tool: string; totalMs: number; bytes: number }
  | { kind: 'not_found'; tool: string }
  | { kind: 'failed'; tool: string; reason: string };

export type DiscoveryProgress = (event: DiscoveryPhase) => void;

/**
 * Default reporter — writes a tasteful per-tool progress trace to stderr.
 * Suppressed when `CLI_AGENT_QUIET_DISCOVERY=1` (or `=true|yes|on`).
 */
export function defaultDiscoveryReporter(stream: NodeJS.WritableStream = process.stderr): DiscoveryProgress {
  const quiet = String(process.env['CLI_AGENT_QUIET_DISCOVERY'] ?? '').toLowerCase();
  if (quiet === '1' || quiet === 'true' || quiet === 'yes' || quiet === 'on') {
    return () => undefined;
  }
  const w = (s: string): void => { stream.write(s); };
  return (e: DiscoveryPhase): void => {
    switch (e.kind) {
      case 'start':
        w(`[cli-agent] Discovering capabilities for '${e.tool}'...\n`);
        break;
      case 'cache_hit':
        w(`             cached document used (${e.bytes} bytes, ${e.durationMs}ms)\n`);
        break;
      case 'probe':
        w(`             probed binary (${e.durationMs}ms)\n`);
        break;
      case 'help':
        w(`             read top-level --help (${e.durationMs}ms, ${e.bytes} bytes)\n`);
        break;
      case 'extract_start':
        w(`             asking LLM to extract subcommands... `);
        break;
      case 'extract_end':
        w(`done (${e.durationMs}ms, ${e.subcommandCount} subcommands)\n`);
        break;
      case 'extract_skipped':
        w(`             skipped LLM extraction (${e.reason}; ${e.helpBytes} bytes)\n`);
        break;
      case 'subcommands':
        if (e.count > 0) {
          w(`             fetched ${e.count} subcommand --helps (${e.durationMs}ms, ${e.bytes} bytes)\n`);
        }
        break;
      case 'done':
        w(`             ✓ '${e.tool}' ready (${e.totalMs}ms, ${e.bytes} bytes)\n`);
        break;
      case 'not_found':
        w(`             ✗ binary '${e.tool}' not found on PATH\n`);
        break;
      case 'failed':
        w(`             ✗ discovery failed: ${e.reason}\n`);
        break;
    }
  };
}

export async function discoverAllTools(
  cfg: AgentConfig,
  model: BaseChatModel,
  logger: Logger,
  forceRefresh = false,
  onPhase?: DiscoveryProgress,
  forceFullInvestigation = false,
): Promise<DiscoveryResult[]> {
  const results: DiscoveryResult[] = [];
  const deadline = Date.now() + cfg.capabilities.totalTimeoutMs;

  for (const tool of cfg.tools) {
    if (Date.now() > deadline) {
      onPhase?.({ kind: 'failed', tool, reason: 'Total time budget exceeded.' });
      results.push({ tool, status: 'failed', message: 'Total time budget exceeded.' });
      continue;
    }

    const result = await discoverTool(tool, cfg, model, logger, forceRefresh, deadline, onPhase, forceFullInvestigation);
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
  onPhase?: DiscoveryProgress,
  forceFullInvestigation = false,
): Promise<DiscoveryResult> {
  const start = Date.now();
  onPhase?.({ kind: 'start', tool });

  // Doc-exists shortcut: if a capability document already exists for this
  // tool and the user has not forced a refresh, trust it and skip every
  // probe (no `which`, no `<tool> --version`, no LLM call). This is the
  // fastest startup path and is safe because:
  //  - Re-discovery on demand is one command away: `cli-agent
  //    refresh-capabilities --tool <name>` or the `--refresh-capabilities`
  //    flag.
  //  - The version-hash invalidation that used to fire here was a
  //    convenience, not a correctness requirement; binary upgrades are
  //    rare and the user can refresh explicitly.
  if (!forceRefresh) {
    const existing = await readCacheEntry(cfg.capabilitiesDir, tool);
    if (existing) {
      const elapsed = Date.now() - start;
      onPhase?.({ kind: 'cache_hit', tool, bytes: existing.fullContent.length, durationMs: elapsed });
      return {
        tool,
        status: 'cached',
        bytes: existing.fullContent.length,
        durationMs: elapsed,
      };
    }
  }

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

  // Check binary exists (only reached on cache miss or forced refresh)
  const probeStart = Date.now();
  const binaryInfo = await getBinaryInfo(tool, cfg.capabilities.timeoutMs);
  if (!binaryInfo) {
    onPhase?.({ kind: 'not_found', tool });
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

  onPhase?.({ kind: 'probe', tool, durationMs: Date.now() - probeStart });

  // Read existing doc (only used here to preserve USER-NOTES across
  // regeneration). The doc-exists shortcut above already returned early
  // when a cached doc was acceptable, so reaching this line means we are
  // either forcing a refresh or recovering from a binary-not-found
  // placeholder; either way we still want to keep the user's notes.
  const existing = await readCacheEntry(cfg.capabilitiesDir, tool);

  // Introspect top-level help
  const helpStart = Date.now();
  const topLevelHelp = await runHelp(
    binaryInfo.resolvedPath,
    null,
    cfg.capabilities.timeoutMs,
    cfg.capabilities.maxBytesPerTool,
  );
  onPhase?.({ kind: 'help', tool, durationMs: Date.now() - helpStart, bytes: topLevelHelp.text.length });

  // Extract subcommands via LLM (almost always the dominant cost — Azure
  // OpenAI / Anthropic round-trip is 1-3s regardless of input size).
  //
  // Small-tool fast path: when the top-level --help is below
  // `cfg.capabilities.skipLlmBelowBytes` (default 4096), skip the LLM
  // call entirely and embed the raw help. Two reasons:
  //   1. Small CLIs typically use flags rather than subcommands (zip,
  //      head, jq, curl) so the LLM extractor returns 0 subcommands and
  //      provided no value for the round-trip cost.
  //   2. The full help fits in the system-prompt budget anyway, so the
  //      model gets the same information either way.
  // Set skipLlmBelowBytes to 0 to disable this and always run the LLM.
  //
  // `forceFullInvestigation` (set by the explicit `refresh-capabilities`
  // entry points) bypasses this fast path so the user always gets a
  // complete LLM-driven introspection regardless of help size.
  let subcommandInfos: Awaited<ReturnType<typeof extractSubcommands>> = [];
  const threshold = cfg.capabilities.skipLlmBelowBytes;
  if (!forceFullInvestigation && threshold > 0 && topLevelHelp.text.length < threshold) {
    onPhase?.({
      kind: 'extract_skipped',
      tool,
      reason: `help is small (< ${threshold} bytes)`,
      helpBytes: topLevelHelp.text.length,
    });
  } else {
    onPhase?.({ kind: 'extract_start', tool });
    const extractStart = Date.now();
    subcommandInfos = await extractSubcommands(topLevelHelp.text, model);
    // Limit subcommands to keep within budget
    const MAX_SUBCOMMANDS = 20;
    if (subcommandInfos.length > MAX_SUBCOMMANDS) {
      subcommandInfos = subcommandInfos.slice(0, MAX_SUBCOMMANDS);
    }
    onPhase?.({ kind: 'extract_end', tool, durationMs: Date.now() - extractStart, subcommandCount: subcommandInfos.length });
  }

  // Fetch per-subcommand help (depth = 1 for now; depth-2 would recurse)
  const subcommands: Array<{ name: string; synopsis: string; helpText: string }> = [];
  let totalBytes = topLevelHelp.text.length;
  const subStart = Date.now();
  let subBytes = 0;

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
      subBytes += subHelp.text.length;
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

  if (subcommands.length > 0 && cfg.capabilities.depth >= 2) {
    onPhase?.({ kind: 'subcommands', tool, durationMs: Date.now() - subStart, count: subcommands.length, bytes: subBytes });
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

  const totalMs = Date.now() - start;
  onPhase?.({ kind: 'done', tool, totalMs, bytes: doc.length });

  return {
    tool,
    status: 'ok',
    bytes: doc.length,
    durationMs: totalMs,
  };
}
