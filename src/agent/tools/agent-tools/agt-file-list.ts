/**
 * `agt_file_list` — LangChain `DynamicStructuredTool` for listing a directory
 * inside the sandbox root. Re-homed from the former built-in `file_list` into
 * the agent-tools (`agt_*`) pack (plan-012).
 *
 * FIRST-PARTY agt_ member (not vendored). REUSES cli-agent's own sandbox
 * (`../file/sandbox.js`). Read-only; governed by `--agent-tools` + the
 * per-tool `--enable/--disable-agt-file-list` flag (default ON). NOT affected
 * by `--no-builtin-tools`.
 *
 * The body is the former `createFileListTool` verbatim, with the name and
 * prompt key changed to `agt_file_list` and a `{ cfg, overlays }` deps bag.
 */

import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import fsp from 'node:fs/promises';
import path from 'node:path';
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
export const AGT_FILE_LIST_NAME = 'agt_file_list' as const;

/** Canonical description (single literal per tool, via BUILTIN_TOOL_PROMPTS). */
export const AGT_FILE_LIST_DESCRIPTION = BUILTIN_TOOL_PROMPTS[AGT_FILE_LIST_NAME]!.description;

/** Dependency bag injected by the catalog builder (`group-builder.ts`). */
export interface AgtFileListDeps {
  cfg: AgentConfig;
  /** Optional overlay registry; user-edited descriptions win when present. */
  overlays?: OverlayRegistry;
}

/** Build the LangChain tool. */
export function buildAgtFileListTool(deps: AgtFileListDeps): DynamicStructuredTool {
  const { cfg } = deps;
  const sandboxCfg = {
    root: cfg.fileEdit.root,
    allowPaths: [...cfg.fileEdit.allowPaths],
  };
  const BUILTIN = BUILTIN_TOOL_PROMPTS[AGT_FILE_LIST_NAME]!;
  const reg = deps.overlays ?? cfg.toolPromptOverlays;
  const schema = z.object({
    path: z.string().min(1).describe(
      getParamDescription(reg, AGT_FILE_LIST_NAME, 'path', BUILTIN.parameters['path']!),
    ),
    glob: z.string().optional().describe(
      getParamDescription(reg, AGT_FILE_LIST_NAME, 'glob', BUILTIN.parameters['glob']!),
    ),
  });

  return new DynamicStructuredTool({
    name: AGT_FILE_LIST_NAME,
    description: getToolDescription(reg, AGT_FILE_LIST_NAME, BUILTIN.description),
    schema,
    func: async (rawInput, _runManager, runConfig) => {
      const input = mergeProfileToolArgs(
        rawInput,
        runConfig?.configurable as ProfileToolArgsConfigurable | undefined,
        AGT_FILE_LIST_NAME,
      );
      try {
        const resolved = resolveSandboxPath(input.path, sandboxCfg);
        const entries = await fsp.readdir(resolved, { withFileTypes: true });
        const items = entries.map((e) => ({
          name: e.name,
          type: e.isDirectory() ? 'directory' : 'file',
          path: path.join(resolved, e.name),
        }));
        // Apply simple glob filter if provided
        const filtered = input.glob
          ? items.filter((item) => {
              const pattern = input.glob!.replace(/\./g, '\\.').replace(/\*/g, '.*');
              return new RegExp('^' + pattern + '$').test(item.name);
            })
          : items;
        return JSON.stringify({ path: resolved, items: filtered });
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
