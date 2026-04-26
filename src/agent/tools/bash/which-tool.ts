import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import path from 'node:path';
import fs from 'node:fs';
import { parseAllowlistEntries, buildAllowlistMatcher } from './allowlist.js';
import type { AgentConfig } from '../../../config/agent-config.js';

const schema = z.object({
  binary: z.string().min(1).describe('Binary name to look up on PATH.'),
});

export function createBashWhichTool(cfg: AgentConfig): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'bash_which',
    description: 'Resolve a binary name to its full path on PATH and check if it is on the allowlist.',
    schema,
    func: async (input) => {
      const entries = parseAllowlistEntries([...cfg.bash.allow]);
      const matcher = buildAllowlistMatcher(entries);

      const resolved = resolveBinary(input.binary);
      const allowed = matcher.test(input.binary, []);

      return JSON.stringify({
        binary: input.binary,
        resolvedPath: resolved,
        found: resolved !== null,
        allowed,
      });
    },
  });
}

function resolveBinary(name: string): string | null {
  if (path.isAbsolute(name)) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}
