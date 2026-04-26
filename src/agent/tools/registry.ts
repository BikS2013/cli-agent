/**
 * Build the LLM-visible tool catalog.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

export function buildToolCatalog(
  cfg: AgentConfig,
  logger: Logger,
): AnyTool[] {
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

  return [...readOnly, ...mutatingFile, ...bashRunTools];
}
