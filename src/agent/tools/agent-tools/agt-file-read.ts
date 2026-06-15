/**
 * `agt_file_read` — LangChain `DynamicStructuredTool` for reading a
 * plain-text (or binary→base64) file inside the sandbox root. Re-homed from
 * the former built-in `file_read` into the agent-tools (`agt_*`) pack
 * (plan-012).
 *
 * Like `agt_web_*` (plan-011), this is a FIRST-PARTY member of the `agt_`
 * namespace — NOT vendored from upstream `agent-tools`. It REUSES cli-agent's
 * own sandbox (`../file/sandbox.js`); the sandbox was not moved or duplicated.
 *
 * Read-only. Governed by `--agent-tools` (umbrella) + the per-tool
 * `--enable/--disable-agt-file-read` flag (default ON). NOT affected by
 * `--no-builtin-tools`.
 *
 * The body is the former `createFileReadTool` verbatim, with the name and
 * prompt key changed to `agt_file_read` and a `{ cfg, overlays }` deps bag.
 */

import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import { resolveSandboxPath, assertMaxBytes } from '../file/sandbox.js';
import { FileError } from '../../../errors.js';
import { handleToolError } from '../types.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import {
  getToolDescription,
  getParamDescription,
  type OverlayRegistry,
} from '../tool-prompt-overlay.js';
import { mergeProfileToolArgs, type ProfileToolArgsConfigurable } from '../profile-tool-args.js';

/** LangChain-visible tool name. Stable across catalog / prompt-block. */
export const AGT_FILE_READ_NAME = 'agt_file_read' as const;

/**
 * Description handed both to LangChain (`DynamicStructuredTool.description`)
 * and to the agent-tools prompt-block assembler. Sourced from the canonical
 * `BUILTIN_TOOL_PROMPTS` registry so there is a SINGLE literal per tool.
 */
export const AGT_FILE_READ_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_FILE_READ_NAME]!.description;

/** Dependency bag injected by the catalog builder (`group-builder.ts`). */
export interface AgtFileReadDeps {
  cfg: AgentConfig;
  /** Optional overlay registry; when present, user-edited descriptions take
   * precedence over the canonical built-in. */
  overlays?: OverlayRegistry;
}

/** Build the LangChain tool. */
export function buildAgtFileReadTool(deps: AgtFileReadDeps): DynamicStructuredTool {
  const { cfg } = deps;
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
    maxBytes: cfg.perToolBudgetBytes,
  };
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_FILE_READ_NAME]!;
  const reg = deps.overlays ?? cfg.toolPromptOverlays;
  const schema = z.object({
    path: z.string().min(1).describe(
      getParamDescription(reg, AGT_FILE_READ_NAME, 'path', BUILTIN.parameters['path']!),
    ),
    max_bytes: z.number().int().positive().optional().describe(
      getParamDescription(reg, AGT_FILE_READ_NAME, 'max_bytes', BUILTIN.parameters['max_bytes']!),
    ),
    binary: z.boolean().optional().describe(
      getParamDescription(reg, AGT_FILE_READ_NAME, 'binary', BUILTIN.parameters['binary']!),
    ),
  });

  return new DynamicStructuredTool({
    name: AGT_FILE_READ_NAME,
    description: getToolDescription(reg, AGT_FILE_READ_NAME, BUILTIN.description),
    schema,
    func: async (rawInput, _runManager, runConfig) => {
      const input = mergeProfileToolArgs(
        rawInput,
        runConfig?.configurable as ProfileToolArgsConfigurable | undefined,
        AGT_FILE_READ_NAME,
      );
      try {
        const resolved = resolveSandboxPath(input.path, sandboxCfg);
        assertMaxBytes(resolved, input.max_bytes ?? 1024 * 1024);
        let content: string;
        if (input.binary) {
          const buf = await fsp.readFile(resolved);
          content = buf.toString('base64');
        } else {
          content = await fsp.readFile(resolved, 'utf8');
        }
        return JSON.stringify({ path: resolved, content, binary: input.binary ?? false });
      } catch (err) {
        if ((err as { code?: string }).code === 'ENOENT') {
          throw new FileError('E_FILE_NOT_FOUND', `File not found: ${input.path}`);
        }
        if ((err as { code?: string }).code === 'EACCES') {
          throw new FileError('E_FILE_PERMISSION', `Permission denied: ${input.path}`);
        }
        return handleToolError(err);
      }
    },
  });
}
