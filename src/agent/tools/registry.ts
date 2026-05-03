/**
 * Build the LLM-visible tool catalog.
 *
 * Returns a {@link ToolCatalog} bundle: the registered `DynamicStructuredTool`
 * list plus an {@link AgentToolsCatalogMeta} snapshot describing which
 * agent-tools-pack wrappers (if any) were included. The metadata is the
 * single source of truth that `buildAgentToolsPromptBlock` consumes when
 * assembling the system prompt — keeping the LLM-visible catalog and the
 * prompt block in lockstep.
 */

import type { AgentConfig } from '../../config/agent-config.js';
import type { Logger } from '../logging.js';
import { parseAllowlistEntries } from './bash/allowlist.js';
import { createFileReadTool } from './file/read-tool.js';
import { createFileListTool } from './file/list-tool.js';
import { createFileWriteTool } from './file/write-tool.js';
import { createFileEditTool } from './file/edit-tool.js';
import { createFileAppendTool } from './file/append-tool.js';
import { createBashRunTool } from './bash/run-tool.js';
import { createBashListAllowedTool } from './bash/list-allowed-tool.js';
import { createBashWhichTool } from './bash/which-tool.js';
import { createWebSearchTool } from './web/search-tool.js';
import { createWebFetchTool } from './web/fetch-tool.js';
import { createToolHelpTool } from './tool-help-tool.js';
import { cliAgentPermissionPolicy } from './agent-tools/index.js';
import {
  buildAgentToolsGroup,
  type AgentToolsCatalogMeta,
} from './agent-tools/group-builder.js';
import { applyProfileToolScoping } from './profile-scoping.js';
import { loadVirtualToolsSync } from '../composite/virtual-registry.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

/**
 * Bundle returned by {@link buildToolCatalog}. The `tools` array is the
 * full LLM-visible toolset (native cli-agent + agent-tools pack); the
 * `agentToolsMeta` snapshot is the input to
 * `buildAgentToolsPromptBlock` so the registered set and its prompt
 * documentation cannot drift.
 */
export interface ToolCatalog {
  readonly tools: AnyTool[];
  readonly agentToolsMeta: AgentToolsCatalogMeta;
}

export function buildToolCatalog(
  cfg: AgentConfig,
  logger: Logger,
): ToolCatalog {
  const maxRequests = parseInt(process.env['WEB_SEARCH_MAX_REQUESTS'] ?? '50', 10);
  const requestBudget = { remaining: maxRequests };

  const readOnly: AnyTool[] = [
    createFileReadTool(cfg),
    createFileListTool(cfg),
    createBashListAllowedTool(cfg),
    createBashWhichTool(cfg),
    createWebSearchTool(cfg, requestBudget),
    createWebFetchTool(cfg, requestBudget),
    createToolHelpTool(cfg),
  ];

  const mutatingFile: AnyTool[] = cfg.allowMutations
    ? [
        createFileWriteTool(cfg),
        createFileEditTool(cfg),
        createFileAppendTool(cfg),
      ]
    : [];

  const allowlistEntries = parseAllowlistEntries([...cfg.bash.allow]);
  const bashRunTools: AnyTool[] = allowlistEntries.length > 0
    ? [createBashRunTool(cfg, logger, cfg.allowMutations)]
    : [];

  // Agent-tools pack (U2/U3/U5). Build the permission policy ONCE per
  // catalog assembly and pass the same instance to every wrapper so
  // their security decisions remain identical.
  const policy = cliAgentPermissionPolicy(cfg);
  const agentToolsGroup = buildAgentToolsGroup(cfg, policy);

  const assembled: AnyTool[] = [
    ...readOnly,
    ...mutatingFile,
    ...bashRunTools,
    ...agentToolsGroup.tools,
  ];

  // Virtual tools (composites — plan-006 U-VIRTUAL). Loaded BEFORE
  // profile scoping so a profile's `tools.allow/deny/order` can include
  // or exclude a composite by id, exactly like a native tool (§14.O).
  // The recursion guard at register-time is enforced inside
  // `loadVirtualToolsSync`; the dispatch-time guard is enforced inside
  // `dispatchComposite` via the `CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD`
  // env sentinel (read by `loadVirtualToolsSync` on subsequent boots).
  const virtualHandles = loadVirtualToolsSync(cfg, logger);
  for (const handle of virtualHandles) {
    assembled.push(handle.langchainTool);
  }

  // Profile tool scoping (plan-005 U-SCOPE). Runs AFTER the catalog is
  // fully built so allow/deny/order operate on the same names that the
  // LLM would otherwise see (registry.ts line ~84 invariant). When the
  // active profile carries no `tools` sub-tree (or no profile is active)
  // this is a no-op identity pass.
  const { tools: scopedTools, warnings } = applyProfileToolScoping(
    assembled,
    cfg.activeProfileData?.tools,
  );
  for (const w of warnings) {
    process.stderr.write(`[cli-agent] warning: ${w}\n`);
  }

  // E9 (plan-005): warn when `profile.toolArgs` references a tool that is
  // not present in the post-scoping catalog (excluded by allow/deny or
  // unknown name). Non-fatal — the dead reference is silently dropped at
  // runtime by `mergeProfileToolArgs`. Emitting a stderr warning gives the
  // user a hint that their preset will never apply.
  const profileToolArgs = cfg.activeProfileData?.toolArgs;
  if (profileToolArgs) {
    const survivorNames = new Set<string>(scopedTools.map((t: AnyTool) => t.name));
    for (const toolName of Object.keys(profileToolArgs)) {
      if (!survivorNames.has(toolName)) {
        process.stderr.write(
          `[cli-agent] warning: profile toolArgs references tool '${toolName}' that is not in the active catalog (excluded by allow/deny or unknown)\n`,
        );
      }
    }
  }

  // Re-derive agentToolsMeta in lockstep with the post-scoping tool list
  // (codebase-scan IP-3 invariant: `tools[i]` ↔ `meta.registered[i]` for
  // the agt_* subset). Filter the meta entries to those whose `name`
  // survived scoping; the umbrella flag is preserved as-is.
  const survivingNames = new Set<string>(scopedTools.map((t: AnyTool) => t.name));
  const agentToolsMeta: AgentToolsCatalogMeta = {
    umbrellaEnabled: agentToolsGroup.meta.umbrellaEnabled,
    registered: agentToolsGroup.meta.registered.filter((entry) =>
      survivingNames.has(entry.name),
    ),
  };

  return {
    tools: scopedTools,
    agentToolsMeta,
  };
}
