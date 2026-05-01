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

  return {
    tools: [...readOnly, ...mutatingFile, ...bashRunTools, ...agentToolsGroup.tools],
    agentToolsMeta: agentToolsGroup.meta,
  };
}
