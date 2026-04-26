/**
 * /capabilities — list active wrapped tools + cache freshness.
 *
 * Freshness column uses the same isCacheValid() the agent uses internally.
 */

import path from 'node:path';
import { registerCommand, type SlashCommand } from './registry.js';
import { readCacheEntry } from '../../agent/capabilities/cache.js';
import { getBinaryInfo, isCacheValid } from '../../agent/capabilities/invalidate.js';
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from '../ansi.js';

const capabilitiesCmd: SlashCommand = {
  name: '/capabilities',
  summary: 'List wrapped tools with cache freshness, binary path, and last-introspect time',
  async run(ctx): Promise<void> {
    const c = ctx.controller;
    const tools = c.sessionTools;
    if (tools.length === 0) {
      ctx.printSystem('no wrapped tools configured.');
      return;
    }
    ctx.println(`${BOLD}Capability cache${RESET}`);
    ctx.println(`  ${DIM}freshness  tool                 binary path                                              bytes  introspected${RESET}`);
    for (const tool of tools) {
      const cached = await readCacheEntry(c.cfg.capabilitiesDir, tool);
      let mark = `${RED}✗ missing${RESET}`;
      let bytes = 0;
      let introspected = '-';
      let binary = path.join(c.cfg.capabilitiesDir, `${tool}.md`);
      if (cached) {
        bytes = cached.fullContent.length;
        introspected = cached.frontmatter.introspectedAt;
        binary = cached.frontmatter.binaryPath;
        try {
          const info = await getBinaryInfo(tool, c.cfg.capabilities.timeoutMs);
          if (info && isCacheValid(cached.frontmatter, info)) {
            mark = `${GREEN}✓ fresh  ${RESET}`;
          } else {
            mark = `${YELLOW}⚠ stale  ${RESET}`;
          }
        } catch {
          mark = `${YELLOW}⚠ stale  ${RESET}`;
        }
      }
      ctx.println(`  ${mark}  ${tool.padEnd(20)} ${binary.slice(-54).padEnd(54)} ${String(bytes).padStart(5)}  ${DIM}${introspected}${RESET}`);
    }
  },
};

registerCommand(capabilitiesCmd);
export default capabilitiesCmd;
