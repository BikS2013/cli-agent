import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { parseAllowlistEntries, buildAllowlistMatcher } from './allowlist.js';
import type { AgentConfig } from '../../../config/agent-config.js';

const schema = z.object({});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBashListAllowedTool(cfg: AgentConfig): DynamicStructuredTool<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new DynamicStructuredTool<any>({
    name: 'bash_list_allowed',
    description: 'List all commands currently on the bash allowlist. Call this first before attempting bash_run to know what is permitted.',
    schema: schema as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    func: async () => {
      const entries = parseAllowlistEntries([...cfg.bash.allow]);
      const matcher = buildAllowlistMatcher(entries);
      return JSON.stringify({
        entries: matcher.getBinaryNames().map((name) => ({
          pattern: name,
          kind: 'binary',
        })),
        hasArgvRegexEntries: entries.some((e) => e.kind === 'argv-regex'),
        totalEntries: entries.length,
        isEmpty: matcher.isEmpty(),
      });
    },
  });
}
