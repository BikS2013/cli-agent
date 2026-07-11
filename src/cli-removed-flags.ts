/**
 * Legacy-flag argv pre-scan (plan-015).
 *
 * The 32 tool-group/per-tool flags removed by plan-015 must fail fast with
 * `UsageError` (exit 2) and a migration hint. Commander alone cannot
 * deliver that: with the options unregistered it reports "unknown option"
 * through the top-level `parseAsync(...).catch(...)` handler, which exits
 * 1 and carries no hint. So `rejectRemovedLegacyFlags` runs over
 * `process.argv.slice(2)` BEFORE `program.parseAsync` (wired in
 * `src/cli.ts`), mirroring the pre-parse convention of `detectPresence`
 * in `src/cli-composite-flags.ts`.
 *
 * Matching is exact-token: all 32 flags were boolean (no `=value` form),
 * and the accepted `detectPresence` precedent tolerates the theoretical
 * value-position false positive (e.g. a prompt argument that literally
 * equals `--no-composites`).
 */

import { UsageError } from './errors.js';
import { MODE_MIGRATION_HINT } from './config/mode.js';

/** The six removed group-toggle flags (plan-008 surface). */
const REMOVED_GROUP_FLAGS: ReadonlySet<string> = new Set([
  '--composites',
  '--no-composites',
  '--builtin-tools',
  '--no-builtin-tools',
  '--agent-tools',
  '--no-agent-tools',
]);

/** The 26 removed per-tool flags (13 enable/disable pairs). */
const REMOVED_PER_TOOL_FLAGS: ReadonlySet<string> = new Set(
  [
    'glob',
    'grep',
    'multiedit',
    'patch',
    'todo-read',
    'todo-write',
    'web-search',
    'web-fetch',
    'file-read',
    'file-list',
    'file-write',
    'file-edit',
    'file-append',
  ].flatMap((suffix) => [`--enable-agt-${suffix}`, `--disable-agt-${suffix}`]),
);

/**
 * Throw `UsageError` (exit 2) if `argv` contains any of the 32 flags
 * removed by plan-015, naming the offending flag and pointing at its
 * replacement (`--mode` for group flags; `--enable-tool`/`--disable-tool`
 * for per-tool flags). No-op on a clean argv.
 */
export function rejectRemovedLegacyFlags(argv: readonly string[]): void {
  for (const token of argv) {
    if (REMOVED_GROUP_FLAGS.has(token)) {
      throw new UsageError(
        `${token} was removed (plan-015). ${MODE_MIGRATION_HINT}`,
        { flag: token, replacement: '--mode' },
      );
    }
    if (REMOVED_PER_TOOL_FLAGS.has(token)) {
      throw new UsageError(
        `${token} was removed (plan-015). ${MODE_MIGRATION_HINT}`,
        { flag: token, replacement: '--enable-tool / --disable-tool' },
      );
    }
  }
}
