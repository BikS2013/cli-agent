/**
 * Public type surface for the agent-tools library (Phase C foundation).
 *
 * Every tool implements {@link AgentTool}. Callers compose tools together
 * via the registry exported from `src/index.ts` and pass a {@link ToolContext}
 * to each `execute()` invocation.
 */

import type { z } from 'zod';

/**
 * Per-call context handed to every tool's `execute()` function.
 *
 * The context is intentionally minimal — tools that require additional
 * state (todo store, fs locks, etc.) reach for it via well-defined keys
 * inside this shape rather than ad-hoc globals.
 */
export interface ToolContext {
  /**
   * Caller-provided absolute working directory.
   *
   * Tools that touch the filesystem should treat this as a soft jail
   * (see {@link PermissionPolicy} for actual enforcement). It is the
   * default base used to resolve relative paths and the default workdir
   * for `bash`-style execution.
   */
  readonly cwd: string;

  /**
   * Optional shared session store consulted by `todoread` / `todowrite`.
   *
   * The caller owns the object: pass the same instance across calls in
   * one logical session to allow the todo tools to round-trip state.
   */
  session?: SessionStore;

  /**
   * AbortSignal for cancellation. Tools doing IO (bash, webfetch, grep)
   * must respect it — see each tool's contract for details.
   */
  signal?: AbortSignal;

  /**
   * Permission policy. Defaults to {@link permissivePolicy} if absent;
   * strict consumers should always supply one explicitly.
   */
  permissions?: PermissionPolicy;

  /**
   * Tool-specific overrides (max-bytes, max-lines, timeouts).
   * Library defaults apply if missing.
   */
  limits?: ToolLimits;
}

/** Numeric guardrails consumed by the various tools. */
export interface ToolLimits {
  /** Hard cap on bytes returned in a successful `output`. */
  readonly maxOutputBytes?: number;
  /** Hard cap on lines returned in a successful `output`. */
  readonly maxOutputLines?: number;
  /** Bash timeout in milliseconds. */
  readonly bashTimeoutMs?: number;
  /** Webfetch timeout in milliseconds. */
  readonly webfetchTimeoutMs?: number;
  /**
   * Hard cap on the number of grep matches retained in a successful
   * result. When the underlying ripgrep / JS-fallback search produces
   * more matches than this number, the result is sorted by relevance
   * and truncated; `metadata.truncated` is set to `true`.
   */
  readonly maxMatches?: number;
}

/**
 * In-process session store shared between tools that need cross-call state.
 *
 * Today only the todo tools use it; the shape is permissive so additional
 * tools (e.g. a memoised LSP cache) can reuse `_internal` without a type
 * surface change.
 */
export interface SessionStore {
  /** Used by `todoread` / `todowrite`. Null until first `todowrite`. */
  todos: ReadonlyArray<TodoItem> | null;
  /**
   * Library-internal scratch space; consumers should not read or mutate
   * the contents directly.
   */
  _internal?: Record<string, unknown>;
}

/** A single todo entry maintained by the todo tools. */
export interface TodoItem {
  readonly id: string;
  readonly content: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
  readonly priority?: 'high' | 'medium' | 'low';
}

/**
 * Metadata accompanying a successful {@link ToolResult}.
 *
 * `truncated` / `originalBytes` / `returnedBytes` are reserved keys with
 * library-wide semantics. Tools may attach additional free-form fields
 * (e.g. ripgrep `partial`, http `contentType`).
 */
export interface ToolMetadata {
  readonly truncated?: boolean;
  readonly originalBytes?: number;
  readonly returnedBytes?: number;
  /** Per-tool free-form keys. */
  readonly [key: string]: unknown;
}

/**
 * Discriminated union returned by every tool's `execute()`.
 *
 * - `ok: true` — `output` is the LLM-facing string; `data` carries
 *   structured payload for direct callers; `metadata` is optional.
 * - `ok: false` — `error` is structurally compatible with
 *   {@link ToolExecutionErrorLike} so the LangChain adapter can
 *   serialise it without importing the concrete error class.
 */
export type ToolResult<Output> =
  | { ok: true; output: string; data?: Output; metadata?: ToolMetadata }
  | { ok: false; error: ToolExecutionErrorLike };

/**
 * Structural type for tool errors.
 *
 * Duck-typed on purpose: tools that build a result object don't need
 * to import the concrete error class to satisfy the type. The concrete
 * classes (`ToolExecutionError`, `PermissionDeniedError`, ...) all
 * conform to this shape.
 */
export interface ToolExecutionErrorLike {
  readonly name: string;
  readonly code: string;
  readonly message: string;
  readonly cause?: unknown;
}

/** Coarse-grained category used by the curated bundle helpers. */
export type ToolCategory = 'fs' | 'web' | 'shell' | 'todo';

/**
 * The contract every tool implements.
 *
 * The schema (Zod v3) is the canonical input shape; the LangChain
 * adapter forwards it directly. The `prompt` field is loaded
 * synchronously at module init so it is available immediately after
 * import.
 */
export interface AgentTool<Schema extends z.ZodTypeAny, Output> {
  /** Stable kebab-case identifier (matches the registry key). */
  readonly id: string;
  /** Single-line description; used inside the master system prompt. */
  readonly description: string;
  /** Coarse-grained category for bundle filtering. */
  readonly category: ToolCategory;
  /** True if the tool can mutate state (fs, network, todo store). */
  readonly mutating: boolean;
  /** Zod v3 schema for the input parameters. */
  readonly parameters: Schema;
  /** Raw prompt fragment loaded synchronously at module init. */
  readonly prompt: string;
  /** Run the tool. Errors are returned in `ToolResult`, not thrown. */
  execute(
    input: z.infer<Schema>,
    ctx: ToolContext,
  ): Promise<ToolResult<Output>>;
}

/**
 * Synchronous permission gate consulted by `bash` and the fs-mutating
 * tools (`write`, `edit`, `multiedit`, `patch`).
 *
 * The interface is forward-declared here so `ToolContext` can reference
 * it without a circular import; the concrete implementations live in
 * `src/permissions.ts`.
 */
export interface PermissionPolicy {
  /** Stable identifier — used in error messages and tests. */
  readonly id: string;
  /** Decide whether a bash command may be spawned. */
  evaluateBash(req: BashCommandRequest): PermissionDecision;
  /** Decide whether a filesystem write at `path` is allowed. */
  evaluateFsWrite(req: FsWriteRequest): PermissionDecision;
}

/** Request handed to {@link PermissionPolicy.evaluateBash}. */
export interface BashCommandRequest {
  /** The raw command string supplied by the LLM. */
  readonly command: string;
  /** Resolved absolute working directory. */
  readonly cwd: string;
  /** Final environment that would be passed to the spawned child. */
  readonly env: Record<string, string>;
}

/** Request handed to {@link PermissionPolicy.evaluateFsWrite}. */
export interface FsWriteRequest {
  /** Resolved absolute path of the target. */
  readonly path: string;
  /** Resolved absolute working directory. */
  readonly cwd: string;
  /** What the caller intends to do with the file. */
  readonly operation: 'create' | 'overwrite' | 'edit' | 'patch';
}

/** Decision returned by a {@link PermissionPolicy} evaluator. */
export type PermissionDecision =
  | { allow: true }
  | { allow: false; reason: string };
