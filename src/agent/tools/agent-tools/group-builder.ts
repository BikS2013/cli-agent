/**
 * U5 catalog assembly for the agent-tools pack.
 *
 * `buildAgentToolsGroup(cfg, policy)` consults the resolved
 * `cfg.agentTools` flag matrix and returns the subset of the six wrapper
 * tools that should be registered for this run, alongside an
 * `AgentToolsCatalogMeta` snapshot that the prompt-block assembler
 * (`buildAgentToolsPromptBlock`) consumes to render the corresponding
 * documentation block.
 *
 * Gating rules (in order, mirroring §10.D.3 / §10.F.1 of the design):
 *
 *   1. If `cfg.agentTools.enabled === false` → return empty group
 *      (no tools, no metadata). The umbrella OFF case wins.
 *   2. For each per-tool flag, register the wrapper iff the flag is true.
 *   3. Mutating tools (`agt_multiedit`, `agt_patch`) ALSO require
 *      `cfg.allowMutations === true`. When the user opts into the wrapper
 *      via flag but `allowMutations` is off, the wrapper is silently
 *      DROPPED (and its meta entry omitted) — a mismatch for the user
 *      to resolve at flag/config time, NOT a runtime failure. Both flags
 *      must be enabled together for these wrappers to appear.
 *   4. Todo wrappers (`agt_todo_read`, `agt_todo_write`) carry no extra
 *      gating here; the per-graph `AgentToolsSession` they read from is
 *      injected by the caller via `RunnableConfig.configurable`.
 *
 * Invariant (also relied upon by `buildAgentToolsPromptBlock`):
 *   `tools.length === meta.registered.length`, and the i-th metadata
 *   entry describes the i-th tool in registration order.
 */

import type { DynamicStructuredTool } from '@langchain/core/tools';

import type { AgentConfig } from '../../../config/agent-config.js';
import {
  AGT_GLOB_NAME,
  AGT_GLOB_DESCRIPTION,
  buildAgtGlobTool,
  AGT_GREP_NAME,
  AGT_GREP_DESCRIPTION,
  buildAgtGrepTool,
  AGT_MULTIEDIT_NAME,
  AGT_MULTIEDIT_DESCRIPTION,
  buildAgtMultieditTool,
  AGT_PATCH_NAME,
  AGT_PATCH_DESCRIPTION,
  buildAgtPatchTool,
  AGT_TODO_READ_NAME,
  AGT_TODO_READ_DESCRIPTION,
  buildAgtTodoReadTool,
  AGT_TODO_WRITE_NAME,
  AGT_TODO_WRITE_DESCRIPTION,
  buildAgtTodoWriteTool,
} from './index.js';
import type { PermissionPolicy } from '../agent-tools-vendored/upstream/src/types.js';

/**
 * Per-tool entry surfaced to the prompt-block assembler. The `description`
 * is the same string handed to LangChain via `DynamicStructuredTool.description`
 * (and exported as the `AGT_*_DESCRIPTION` constant from each wrapper) so
 * the block stays a pure projection of the registered set — there is no
 * second source of truth for the prompt-fragment text.
 */
export interface AgentToolsCatalogEntry {
  readonly name: string;
  readonly description: string;
}

/**
 * Catalog snapshot produced by {@link buildAgentToolsGroup}. Always
 * returned alongside the registered tool list so the system-prompt
 * builder can derive the documentation block deterministically.
 */
export interface AgentToolsCatalogMeta {
  /**
   * Resolved umbrella flag. When `false`, `registered` is guaranteed to
   * be empty AND the prompt-block assembler must produce the empty
   * string (preserving byte-stability with the pre-integration prompt).
   */
  readonly umbrellaEnabled: boolean;
  /**
   * In registration order. When the umbrella is on but every per-tool
   * flag is off (or every requested mutating tool was dropped because
   * `allowMutations` was off) this is an empty array — and the prompt
   * block is still empty.
   */
  readonly registered: ReadonlyArray<AgentToolsCatalogEntry>;
}

/**
 * Bundle of `DynamicStructuredTool`s and the matching catalog metadata,
 * returned by {@link buildAgentToolsGroup}. The two arrays are in
 * lockstep — `tools[i]` is described by `meta.registered[i]`.
 */
export interface AgentToolsGroup {
  readonly tools: ReadonlyArray<DynamicStructuredTool>;
  readonly meta: AgentToolsCatalogMeta;
}

/**
 * Conditionally assemble the agent-tools group + parallel metadata.
 *
 * Throws nothing: gating is value-driven. The wrappers themselves throw
 * later (at execute time) if `RunnableConfig.configurable` is missing
 * the keys they need.
 *
 * @param cfg     resolved {@link AgentConfig}; required field
 *                {@link AgentConfig.agentTools} is consulted for both
 *                umbrella and per-tool gating.
 * @param policy  pre-built {@link PermissionPolicy}; expected to be
 *                constructed ONCE per session by `buildToolCatalog` via
 *                `cliAgentPermissionPolicy(cfg)` and passed in by
 *                reference so all wrappers share identical security
 *                decisions.
 */
export function buildAgentToolsGroup(
  cfg: AgentConfig,
  policy: PermissionPolicy,
): AgentToolsGroup {
  if (!cfg.agentTools.enabled) {
    return {
      tools: [],
      meta: { umbrellaEnabled: false, registered: [] },
    };
  }

  const tools: DynamicStructuredTool[] = [];
  const registered: AgentToolsCatalogEntry[] = [];
  const flags = cfg.agentTools.tools;

  if (flags.glob) {
    tools.push(buildAgtGlobTool({ permissions: policy }));
    registered.push({ name: AGT_GLOB_NAME, description: AGT_GLOB_DESCRIPTION });
  }
  if (flags.grep) {
    tools.push(buildAgtGrepTool({ permissions: policy }));
    registered.push({ name: AGT_GREP_NAME, description: AGT_GREP_DESCRIPTION });
  }
  // Mutating wrappers: BOTH the per-tool flag AND cfg.allowMutations must
  // be true. If only the per-tool flag is set, the wrapper is silently
  // dropped (matching the pre-existing native file_edit/file_write/file_append
  // gating in registry.ts). Users who enable `agt_multiedit` / `agt_patch`
  // also need `--allow-mutations` (or AGENT_ALLOW_MUTATIONS=true).
  if (flags.multiedit && cfg.allowMutations) {
    tools.push(buildAgtMultieditTool({ permissions: policy }));
    registered.push({ name: AGT_MULTIEDIT_NAME, description: AGT_MULTIEDIT_DESCRIPTION });
  }
  if (flags.patch && cfg.allowMutations) {
    tools.push(buildAgtPatchTool({ permissions: policy }));
    registered.push({ name: AGT_PATCH_NAME, description: AGT_PATCH_DESCRIPTION });
  }
  if (flags.todoRead) {
    tools.push(buildAgtTodoReadTool({ permissions: policy }));
    registered.push({ name: AGT_TODO_READ_NAME, description: AGT_TODO_READ_DESCRIPTION });
  }
  if (flags.todoWrite) {
    tools.push(buildAgtTodoWriteTool({ permissions: policy }));
    registered.push({ name: AGT_TODO_WRITE_NAME, description: AGT_TODO_WRITE_DESCRIPTION });
  }

  return {
    tools,
    meta: { umbrellaEnabled: true, registered },
  };
}
