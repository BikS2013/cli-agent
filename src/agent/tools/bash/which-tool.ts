import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import path from 'node:path';
import fs from 'node:fs';
import { parseAllowlistEntries, buildAllowlistMatcher } from './allowlist.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import { getToolDescription, getParamDescription } from '../tool-prompt-overlay.js';
import { mergeProfileToolArgs, type ProfileToolArgsConfigurable } from '../profile-tool-args.js';

const TOOL_NAME = 'bash_which';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL_NAME]!;

export function createBashWhichTool(cfg: AgentConfig): DynamicStructuredTool {
  const reg = cfg.toolPromptOverlays;
  const schema = z.object({
    binary: z.string().min(1).describe(
      getParamDescription(reg, TOOL_NAME, 'binary', BUILTIN.parameters['binary']!),
    ),
  });
  return new DynamicStructuredTool({
    name: TOOL_NAME,
    description: getToolDescription(reg, TOOL_NAME, BUILTIN.description),
    schema,
    func: async (rawInput, _runManager, runConfig) => {
      const input = mergeProfileToolArgs(
        rawInput,
        runConfig?.configurable as ProfileToolArgsConfigurable | undefined,
        TOOL_NAME,
      );
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
