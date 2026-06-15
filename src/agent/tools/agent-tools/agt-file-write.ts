/**
 * `agt_file_write` — LangChain `DynamicStructuredTool` that overwrites a file
 * inside the sandbox root. Re-homed from the former built-in `file_write`
 * into the agent-tools (`agt_*`) pack (plan-012).
 *
 * FIRST-PARTY agt_ member (not vendored). REUSES cli-agent's own sandbox
 * (`../file/sandbox.js`). MUTATING: the `confirmed: true` gate is preserved
 * verbatim in the body; the RUNTIME `allowMutations` gate (only register this
 * tool when `cfg.allowMutations === true`) lives in `group-builder.ts`, NOT
 * here. Governed by `--agent-tools` + `--enable/--disable-agt-file-write`
 * (default ON) + `--allow-mutations`.
 *
 * The body is the former `createFileWriteTool` verbatim, with the name and
 * prompt key changed to `agt_file_write` and a `{ cfg, overlays }` deps bag.
 */

import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import { resolveSandboxPath } from '../file/sandbox.js';
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
export const AGT_FILE_WRITE_NAME = 'agt_file_write' as const;

/** Canonical description (single literal per tool, via BUILTIN_TOOL_PROMPTS). */
export const AGT_FILE_WRITE_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_FILE_WRITE_NAME]!.description;

/** Dependency bag injected by the catalog builder (`group-builder.ts`). */
export interface AgtFileWriteDeps {
  cfg: AgentConfig;
  /** Optional overlay registry; user-edited descriptions win when present. */
  overlays?: OverlayRegistry;
}

/** Build the LangChain tool. */
export function buildAgtFileWriteTool(deps: AgtFileWriteDeps): DynamicStructuredTool {
  const { cfg } = deps;
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
  };
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_FILE_WRITE_NAME]!;
  const reg = deps.overlays ?? cfg.toolPromptOverlays;
  const schema = z.object({
    path: z.string().min(1).describe(
      getParamDescription(reg, AGT_FILE_WRITE_NAME, 'path', BUILTIN.parameters['path']!),
    ),
    content: z.string().describe(
      getParamDescription(reg, AGT_FILE_WRITE_NAME, 'content', BUILTIN.parameters['content']!),
    ),
    confirmed: z.boolean().describe(
      getParamDescription(reg, AGT_FILE_WRITE_NAME, 'confirmed', BUILTIN.parameters['confirmed']!),
    ),
  });

  return new DynamicStructuredTool({
    name: AGT_FILE_WRITE_NAME,
    description: getToolDescription(reg, AGT_FILE_WRITE_NAME, BUILTIN.description),
    schema,
    func: async (rawInput, _runManager, runConfig) => {
      const input = mergeProfileToolArgs(
        rawInput,
        runConfig?.configurable as ProfileToolArgsConfigurable | undefined,
        AGT_FILE_WRITE_NAME,
      );
      try {
        if (!input.confirmed) {
          return JSON.stringify({
            requires_confirmation: true,
            operation: 'agt_file_write',
            path: input.path,
            message: 'Set confirmed: true to proceed with writing this file.',
          });
        }
        const resolved = resolveSandboxPath(input.path, sandboxCfg);
        await fsp.writeFile(resolved, input.content, 'utf8');
        return JSON.stringify({ ok: true, path: resolved, bytesWritten: Buffer.byteLength(input.content, 'utf8') });
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
