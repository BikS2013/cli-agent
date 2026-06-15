/**
 * CLI flag mapper for the agent-tools pack.
 *
 * Lives in its own module so tests can import it WITHOUT triggering the
 * Commander parse side-effect at the bottom of `src/cli.ts` (which would
 * call `process.exit` against vitest's argv).
 *
 * The mapper is the single CLI-tier gatekeeper for agent-tools flags:
 * conflict detection (umbrella enable+disable, per-tool enable+disable)
 * happens here and surfaces as `UsageError` (exit code 2). The four-tier
 * precedence chain (CLI > env > config.json > default) is then completed
 * inside `loadAgentConfig` via the `resolveAgentTools` helper.
 */

import { UsageError } from './errors.js';
import type { AgentCliFlags } from './config/agent-config.js';

/**
 * Translate Commander's parsed options into the partial
 * `AgentCliFlags['agentTools']` shape consumed by `loadAgentConfig`.
 *
 * Commander's behavior for `.option('--no-agent-tools', ...)` paired with
 * `.option('--agent-tools', ...)`:
 *   - Neither flag passed   → `opts.agentTools` is `undefined`
 *   - `--agent-tools`        → `opts.agentTools === true`
 *   - `--no-agent-tools`     → `opts.agentTools === false`
 *   - Both flags passed      → Commander records the LAST one; we cannot
 *                              detect the conflict from the parsed object.
 *                              Therefore we inspect `process.argv` for the
 *                              umbrella conflict only (a focused string
 *                              search on the two umbrella flags).
 *
 * For per-tool flags, both `--enable-X` and `--disable-X` are independent
 * boolean options that default to `false` when absent and `true` when
 * present. If a user passes both, both keys are `true` simultaneously and
 * the conflict IS detectable from the parsed object — that's what the
 * pair-by-pair conflict check below relies on.
 *
 * Returns `undefined` when no agent-tools flags were passed at all (so
 * the resolver falls through to env / config / default cleanly). Returns
 * a partial object otherwise. Throws `UsageError` (exit code 2) on any
 * detected conflict — STRICT, no silent precedence between conflicting
 * CLI flags.
 */
export function mapAgentToolFlags(opts: Record<string, unknown>): AgentCliFlags['agentTools'] | undefined {
  // ---- Umbrella conflict detection ----
  // Inspect raw argv because Commander silently keeps only the last value
  // when --agent-tools and --no-agent-tools are both passed.
  const argv = process.argv.slice(2);
  const sawEnableUmbrella = argv.includes('--agent-tools');
  const sawDisableUmbrella = argv.includes('--no-agent-tools');
  if (sawEnableUmbrella && sawDisableUmbrella) {
    throw new UsageError(
      'Conflicting flags: --agent-tools and --no-agent-tools cannot be used together.',
      { conflict: ['--agent-tools', '--no-agent-tools'] },
    );
  }

  // Resolve umbrella from the parsed value. Commander stores it under
  // `agentTools` (camelCased from `--agent-tools` / `--no-agent-tools`).
  let enabled: boolean | undefined;
  const umbrellaRaw = opts['agentTools'];
  if (typeof umbrellaRaw === 'boolean') {
    enabled = umbrellaRaw;
  } else {
    enabled = undefined;
  }

  // ---- Per-tool conflict detection + value extraction ----
  type ToolKey =
    | 'glob' | 'grep' | 'multiedit' | 'patch' | 'todoRead' | 'todoWrite'
    | 'webSearch' | 'webFetch'
    | 'fileRead' | 'fileList' | 'fileWrite' | 'fileEdit' | 'fileAppend';
  const pairs: Array<{
    key: ToolKey;
    enableOpt: string;
    disableOpt: string;
    enableFlag: string;
    disableFlag: string;
  }> = [
    { key: 'glob',      enableOpt: 'enableAgtGlob',      disableOpt: 'disableAgtGlob',      enableFlag: '--enable-agt-glob',      disableFlag: '--disable-agt-glob' },
    { key: 'grep',      enableOpt: 'enableAgtGrep',      disableOpt: 'disableAgtGrep',      enableFlag: '--enable-agt-grep',      disableFlag: '--disable-agt-grep' },
    { key: 'multiedit', enableOpt: 'enableAgtMultiedit', disableOpt: 'disableAgtMultiedit', enableFlag: '--enable-agt-multiedit', disableFlag: '--disable-agt-multiedit' },
    { key: 'patch',     enableOpt: 'enableAgtPatch',     disableOpt: 'disableAgtPatch',     enableFlag: '--enable-agt-patch',     disableFlag: '--disable-agt-patch' },
    { key: 'todoRead',  enableOpt: 'enableAgtTodoRead',  disableOpt: 'disableAgtTodoRead',  enableFlag: '--enable-agt-todo-read', disableFlag: '--disable-agt-todo-read' },
    { key: 'todoWrite', enableOpt: 'enableAgtTodoWrite', disableOpt: 'disableAgtTodoWrite', enableFlag: '--enable-agt-todo-write', disableFlag: '--disable-agt-todo-write' },
    { key: 'webSearch', enableOpt: 'enableAgtWebSearch', disableOpt: 'disableAgtWebSearch', enableFlag: '--enable-agt-web-search', disableFlag: '--disable-agt-web-search' },
    { key: 'webFetch',  enableOpt: 'enableAgtWebFetch',  disableOpt: 'disableAgtWebFetch',  enableFlag: '--enable-agt-web-fetch', disableFlag: '--disable-agt-web-fetch' },
    { key: 'fileRead',   enableOpt: 'enableAgtFileRead',   disableOpt: 'disableAgtFileRead',   enableFlag: '--enable-agt-file-read',   disableFlag: '--disable-agt-file-read' },
    { key: 'fileList',   enableOpt: 'enableAgtFileList',   disableOpt: 'disableAgtFileList',   enableFlag: '--enable-agt-file-list',   disableFlag: '--disable-agt-file-list' },
    { key: 'fileWrite',  enableOpt: 'enableAgtFileWrite',  disableOpt: 'disableAgtFileWrite',  enableFlag: '--enable-agt-file-write',  disableFlag: '--disable-agt-file-write' },
    { key: 'fileEdit',   enableOpt: 'enableAgtFileEdit',   disableOpt: 'disableAgtFileEdit',   enableFlag: '--enable-agt-file-edit',   disableFlag: '--disable-agt-file-edit' },
    { key: 'fileAppend', enableOpt: 'enableAgtFileAppend', disableOpt: 'disableAgtFileAppend', enableFlag: '--enable-agt-file-append', disableFlag: '--disable-agt-file-append' },
  ];

  const tools: Partial<Record<ToolKey, boolean>> = {};
  let anyToolFlag = false;
  for (const pair of pairs) {
    const enableSet = opts[pair.enableOpt] === true;
    const disableSet = opts[pair.disableOpt] === true;
    if (enableSet && disableSet) {
      throw new UsageError(
        `Conflicting flags: ${pair.enableFlag} and ${pair.disableFlag} cannot be used together.`,
        { conflict: [pair.enableFlag, pair.disableFlag] },
      );
    }
    if (enableSet) {
      tools[pair.key] = true;
      anyToolFlag = true;
    } else if (disableSet) {
      tools[pair.key] = false;
      anyToolFlag = true;
    }
  }

  // Return undefined when no agent-tools flag was passed AT ALL — leaves
  // the four-tier precedence chain unaffected by the CLI tier.
  if (enabled === undefined && !anyToolFlag) return undefined;

  const out: NonNullable<AgentCliFlags['agentTools']> = {};
  if (enabled !== undefined) {
    (out as { enabled?: boolean }).enabled = enabled;
  }
  if (anyToolFlag) {
    (out as { tools?: Partial<Record<ToolKey, boolean>> }).tools = tools;
  }
  return out;
}
