/**
 * Public barrel for the agent-tools wrapper layer (U3 outputs).
 *
 * U5's catalog builder consumes these `build*` factories along with the
 * paired `AGT_*_NAME` and `AGT_*_DESCRIPTION` constants. The constants
 * are exported separately so the prompt-block assembler can render the
 * tool catalog text without instantiating a `DynamicStructuredTool`.
 *
 * Type re-exports from `./types.js` give downstream code a single
 * import path for the `AgentToolsConfigurable` / `AgentToolsSession` /
 * `TodoItem` shapes.
 *
 * Permission bridge re-exports from `./permissions.js` are included so
 * U5 only has to import from this barrel.
 */

// ---------------------------------------------------------------------------
// Wrapper factories + per-tool name/description constants
// ---------------------------------------------------------------------------

export {
  AGT_GLOB_NAME,
  AGT_GLOB_DESCRIPTION,
  buildAgtGlobTool,
  type AgtGlobDeps,
} from './agt-glob.js';

export {
  AGT_GREP_NAME,
  AGT_GREP_DESCRIPTION,
  buildAgtGrepTool,
  type AgtGrepDeps,
} from './agt-grep.js';

export {
  AGT_MULTIEDIT_NAME,
  AGT_MULTIEDIT_DESCRIPTION,
  buildAgtMultieditTool,
  type AgtMultieditDeps,
} from './agt-multiedit.js';

export {
  AGT_PATCH_NAME,
  AGT_PATCH_DESCRIPTION,
  buildAgtPatchTool,
  type AgtPatchDeps,
} from './agt-patch.js';

export {
  AGT_TODO_READ_NAME,
  AGT_TODO_READ_DESCRIPTION,
  buildAgtTodoReadTool,
  type AgtTodoReadDeps,
} from './agt-todo-read.js';

export {
  AGT_TODO_WRITE_NAME,
  AGT_TODO_WRITE_DESCRIPTION,
  buildAgtTodoWriteTool,
  type AgtTodoWriteDeps,
} from './agt-todo-write.js';

// ---------------------------------------------------------------------------
// Configurable + session types (re-exported from ./types.js)
// ---------------------------------------------------------------------------

export type {
  AgentToolsConfigurable,
  AgentToolsSession,
  TodoItem,
} from './types.js';

// ---------------------------------------------------------------------------
// Permission bridge (re-exported from ./permissions.js)
// ---------------------------------------------------------------------------

export {
  cliAgentPermissionPolicy,
  scrubEnv,
  CLI_AGENT_POLICY_ID,
} from './permissions.js';
