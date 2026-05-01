/**
 * Curated tool-name bundles used by the public selection helpers.
 *
 * The arrays are typed `as const` so `ToolName` becomes a strict
 * union of the twelve in-scope tools. Phase F populates the actual
 * tool registry; this file only declares the names.
 */

/** Tools that never mutate filesystem, network, or session state. */
export const READ_ONLY_TOOLS = [
  'read',
  'glob',
  'grep',
  'list',
  'webfetch',
  'todoread',
] as const;

/** Filesystem-related tools (read AND write). */
export const FS_TOOLS = [
  'read',
  'write',
  'edit',
  'multiedit',
  'patch',
  'glob',
  'grep',
  'list',
] as const;

/** Web-surface tools. */
export const WEB_TOOLS = ['webfetch'] as const;

/** Shell-execution tools. */
export const SHELL_TOOLS = ['bash'] as const;

/** Session-todo tools. */
export const TODO_TOOLS = ['todoread', 'todowrite'] as const;

/** Master list of all tool names supported in v1. */
export const ALL_TOOL_NAMES = [
  'read',
  'write',
  'edit',
  'multiedit',
  'patch',
  'bash',
  'glob',
  'grep',
  'list',
  'webfetch',
  'todoread',
  'todowrite',
] as const;

/** Strict union of every supported tool name. */
export type ToolName = (typeof ALL_TOOL_NAMES)[number];
