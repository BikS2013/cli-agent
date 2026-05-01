import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import { parseAllowlistEntries, buildAllowlistMatcher } from './allowlist.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import { getToolDescription } from '../tool-prompt-overlay.js';

const TOOL_NAME = 'bash_list_allowed';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL_NAME]!;

const schema = z.object({});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBashListAllowedTool(cfg: AgentConfig): DynamicStructuredTool<any> {
  const reg = cfg.toolPromptOverlays;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new DynamicStructuredTool<any>({
    name: TOOL_NAME,
    description: getToolDescription(reg, TOOL_NAME, BUILTIN.description),
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
