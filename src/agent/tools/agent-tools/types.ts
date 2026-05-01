/**
 * Shared types for the agent-tools wrapper layer.
 *
 * The wrappers (U3) live next to this file as `agt-*.ts`. They consume the
 * `cliAgentPermissionPolicy` returned by `./permissions.ts` and read the
 * per-call session store + working directory out of LangChain's
 * `RunnableConfig.configurable` bag using the shapes declared here.
 *
 * The vendored upstream `TodoItem` type is re-exported so wrapper modules
 * can import it from a single, stable cli-agent path rather than reaching
 * into `agent-tools-vendored/upstream/...`.
 */

import type { TodoItem } from '../agent-tools-vendored/upstream/src/types.js';

export type { TodoItem };

/**
 * Per-session in-memory store backing the `agt_todo_read` / `agt_todo_write`
 * pair.
 *
 * Created once per logical agent session by the catalog builder (U5) and
 * threaded through every tool invocation via
 * `RunnableConfig.configurable.agentToolsSession`.
 *
 * `todos === null` means "never written"; `todoread` reports `(no todos)`
 * in that case. `todowrite` populates the array on first call and replaces
 * it on subsequent calls (it is NOT additive — the upstream contract is
 * "write the canonical list").
 */
export interface AgentToolsSession {
  /** Null until `todowrite` has been called at least once. */
  todos: TodoItem[] | null;
}

/**
 * Shape of `RunnableConfig.configurable` keys that the agent-tools wrappers
 * (U3) read at execution time.
 *
 * - `workingDirectory`: REQUIRED absolute path used as the soft jail / cwd
 *   passed into every vendored tool's `ToolContext.cwd`. The catalog builder
 *   (U5) populates this from `cfg.fileEdit.root` (or whichever resolved root
 *   the run is anchored to).
 * - `sessionId`: optional logical session identifier (informational only;
 *   the todo pair keys off `agentToolsSession`, not this field).
 * - `agentToolsSession`: the shared todo store (see {@link AgentToolsSession}).
 *   Required when the todo wrappers are enabled in the registered catalog.
 * - `signal`: cancellation token forwarded into `ToolContext.signal` so
 *   long-running tools (e.g. `agt_grep`) honour caller-side aborts.
 *
 * Wrappers that need a field MUST validate its presence and throw a tool
 * error (or return an `{ok:false}` envelope) when missing — there is no
 * silent fallback.
 */
export interface AgentToolsConfigurable {
  workingDirectory: string;
  sessionId?: string;
  agentToolsSession?: AgentToolsSession;
  signal?: AbortSignal;
}
