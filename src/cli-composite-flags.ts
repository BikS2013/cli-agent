/**
 * Composite-tool CLI flag layer (plan-006 Phase 6 / Unit U-FLAGS).
 *
 * Lives in its own module (parallel to `cli-agent-tools-flags.ts`) so:
 *   1. Tests can import it without triggering the Commander parse
 *      side-effect at the bottom of `src/cli.ts`.
 *   2. The flag-matrix enforcement (§14.H) is a pure function with a
 *      typed input, easy to unit-test cell by cell.
 *
 * Two responsibilities:
 *   - `parseCompositeFlags(opts)` — non-throwing normaliser. Maps
 *     Commander's option object into the typed `CompositeCliFlags`
 *     shape declared in §14.D of project-design.md. Default for
 *     `synthesisBudgetTokens` is read from
 *     `process.env.CLI_AGENT_COMPOSITE_BUDGET` when no `--synthesis-budget-tokens`
 *     was given; if that env var is absent, falls back to 32 768 (the
 *     ADR-CMP-10 / spec-locked default).
 *   - `enforceCompositeFlagMatrix(flags, opts)` — implements the
 *     locked §14.H matrix. Throws `UsageError` (exit code 2) for any
 *     forbidden combination; returns silently for permitted ones. The
 *     OQ-7 / ADR-CMP-3 deviation (`--regenerate-capabilities` requires
 *     `--treat-as-tool`, with a guidance message pointing to
 *     `--refresh-capabilities`) is enforced here.
 *
 * Cross-references:
 *   - docs/design/plan-006-composite-tools.md §5 (U-FLAGS spec).
 *   - docs/design/project-design.md §14.D (interface contract row),
 *     §14.H (canonical matrix), §14.P (P6 unit ownership).
 *   - docs/design/refined-request-composite-tools.md FR-CMP-001..022.
 */

import { UsageError } from './errors.js';

/**
 * Typed shape of the composite-tool CLI flags after Commander parse +
 * env-var resolution. Mirrors the `AgentCliFlags` extension landed in
 * P3 (`src/config/agent-config.ts`) but uses non-optional fields with
 * concrete defaults so the matrix enforcer can reason about every
 * cell without `undefined`-handling noise.
 */
export interface CompositeCliFlags {
  readonly treatAsTool: boolean;
  readonly compositeName: string | null;
  readonly emitDoc: boolean;
  readonly emitWrapper: boolean;
  readonly emitWrapperOnPath: boolean;
  readonly registerVirtual: boolean;
  readonly regenerateCapabilities: boolean;
  readonly dryRunSynthesis: boolean;
  readonly synthesisBudgetTokens: number;
  readonly forceOverwrite: boolean;
}

/**
 * The spec-locked default for the combined Stage-1 + Stage-2 token
 * budget when neither the CLI flag nor `CLI_AGENT_COMPOSITE_BUDGET`
 * is supplied (ADR-CMP-10 / refined-spec FR-CMP-008).
 */
export const DEFAULT_SYNTHESIS_BUDGET_TOKENS = 32_768;

/**
 * Tracks whether the user actually supplied each compositeflag on the
 * command line, used by the matrix enforcer to distinguish "flag set
 * to its default" from "flag explicitly toggled". Parsed alongside
 * the typed flag values via raw argv inspection because Commander
 * does not expose that bit.
 */
interface CompositeFlagPresence {
  readonly treatAsTool: boolean;
  readonly compositeName: boolean;
  readonly emitDoc: boolean;            // true if --emit-doc OR --no-emit-doc was supplied
  readonly emitDocPositive: boolean;    // true ONLY if --emit-doc was supplied
  readonly emitDocNegative: boolean;    // true ONLY if --no-emit-doc was supplied
  readonly emitWrapper: boolean;
  readonly emitWrapperOnPath: boolean;
  readonly registerVirtual: boolean;
  readonly regenerateCapabilities: boolean;
  readonly dryRunSynthesis: boolean;
  readonly synthesisBudgetTokens: boolean;
  readonly forceOverwrite: boolean;
  readonly resume: boolean;
}

/**
 * Inspect raw argv for which composite flags the user actually
 * supplied. Commander's parsed-object API does not distinguish
 * between "flag absent" and "flag set to its default value" for
 * boolean options, but the §14.H matrix needs that distinction (e.g.
 * `--no-emit-doc` triggers the catch-all "requires --treat-as-tool"
 * rule, but the implicit default `emitDoc=true` does not).
 *
 * We accept an `argv` parameter for testability; production callers
 * pass `process.argv.slice(2)` via `parseCompositeFlags` /
 * `enforceCompositeFlagMatrix`'s own internal lookup.
 */
function detectPresence(argv: readonly string[]): CompositeFlagPresence {
  const has = (flag: string): boolean => argv.includes(flag);
  // For value-taking flags, also accept the `--flag=value` form.
  const hasValueFlag = (flag: string): boolean =>
    argv.includes(flag) || argv.some((a) => a.startsWith(`${flag}=`));
  return {
    treatAsTool: has('--treat-as-tool'),
    compositeName: hasValueFlag('--composite-name'),
    emitDocPositive: has('--emit-doc'),
    emitDocNegative: has('--no-emit-doc'),
    emitDoc: has('--emit-doc') || has('--no-emit-doc'),
    emitWrapper: has('--emit-wrapper'),
    emitWrapperOnPath: has('--emit-wrapper-on-path'),
    registerVirtual: has('--register-virtual'),
    regenerateCapabilities: has('--regenerate-capabilities'),
    dryRunSynthesis: has('--dry-run-synthesis'),
    synthesisBudgetTokens: hasValueFlag('--synthesis-budget-tokens'),
    forceOverwrite: has('--force-overwrite'),
    // `--resume` is a value-or-bare flag (Commander `[threadId]`); accept
    // both forms. We do NOT accept `-r` here because the §14.H rule is
    // textually anchored on `--resume` (and `-r` resolves to the same
    // Commander option key — argv inspection still surfaces `-r` if we
    // need it later; for now `parseCompositeFlags` falls back to
    // `opts.resume` truthiness for the typed extraction).
    resume: has('--resume') || argv.some((a) => a.startsWith('--resume=')) || has('-r'),
  };
}

/**
 * Translate Commander's parsed options object into the typed
 * `CompositeCliFlags`. Pure normalisation — never throws. Matrix
 * enforcement is the responsibility of `enforceCompositeFlagMatrix`.
 *
 * Defaults applied here:
 *   - All booleans default to `false` when absent, EXCEPT `emitDoc`
 *     which defaults to `true` whenever `--treat-as-tool` is in
 *     effect (per §14.D and the §14.H "default ON whenever
 *     --treat-as-tool" cell). When `--treat-as-tool` is absent, the
 *     `emitDoc` field is irrelevant for downstream consumers (the
 *     matrix enforcer rejects any `--emit-doc/--no-emit-doc` use
 *     without `--treat-as-tool`); we still default it to `true` so
 *     the field is well-typed.
 *   - `synthesisBudgetTokens` resolves through:
 *       1. `--synthesis-budget-tokens <n>` flag (Commander parsed it
 *          via `parseInt` already).
 *       2. `process.env.CLI_AGENT_COMPOSITE_BUDGET` (parseInt; NaN
 *          falls through).
 *       3. `DEFAULT_SYNTHESIS_BUDGET_TOKENS` (32 768).
 *     This matches the project's four-tier resolution chain
 *     described in §14.E (CLI > env > config > default; the config
 *     tier is consumed downstream in U-CMD when it loads
 *     `AgentConfig`).
 *   - `compositeName` is `null` when absent (NOT undefined) so the
 *     downstream `validateCompositeName` / `deriveCompositeName`
 *     helpers (P5) can pattern-match cleanly.
 */
export function parseCompositeFlags(
  opts: Record<string, unknown>,
): CompositeCliFlags {
  const treatAsTool = opts['treatAsTool'] === true;

  // `--emit-doc` / `--no-emit-doc` is registered as a single boolean
  // option in Commander, which means it ends up as `opts.emitDoc:
  // true|false|undefined`. We map the tri-state directly: explicit
  // user intent wins; absence falls through to the default-true
  // policy when `--treat-as-tool` is in effect, default-false
  // otherwise (the value is unused in that branch — see field doc).
  let emitDoc: boolean;
  const emitDocRaw = opts['emitDoc'];
  if (emitDocRaw === true) {
    emitDoc = true;
  } else if (emitDocRaw === false) {
    emitDoc = false;
  } else {
    emitDoc = treatAsTool; // default-on with --treat-as-tool, irrelevant otherwise
  }

  const compositeNameRaw = opts['compositeName'];
  const compositeName =
    typeof compositeNameRaw === 'string' && compositeNameRaw.length > 0
      ? compositeNameRaw
      : null;

  // synthesisBudgetTokens precedence: CLI > env > spec default.
  let synthesisBudgetTokens: number;
  const cliBudget = opts['synthesisBudgetTokens'];
  if (typeof cliBudget === 'number' && Number.isFinite(cliBudget)) {
    synthesisBudgetTokens = cliBudget;
  } else {
    const envRaw = process.env['CLI_AGENT_COMPOSITE_BUDGET'];
    if (envRaw !== undefined && envRaw !== '') {
      const parsed = parseInt(envRaw, 10);
      synthesisBudgetTokens = Number.isFinite(parsed)
        ? parsed
        : DEFAULT_SYNTHESIS_BUDGET_TOKENS;
    } else {
      synthesisBudgetTokens = DEFAULT_SYNTHESIS_BUDGET_TOKENS;
    }
  }

  return {
    treatAsTool,
    compositeName,
    emitDoc,
    emitWrapper: opts['emitWrapper'] === true,
    emitWrapperOnPath: opts['emitWrapperOnPath'] === true,
    registerVirtual: opts['registerVirtual'] === true,
    regenerateCapabilities: opts['regenerateCapabilities'] === true,
    dryRunSynthesis: opts['dryRunSynthesis'] === true,
    synthesisBudgetTokens,
    forceOverwrite: opts['forceOverwrite'] === true,
  };
}

/**
 * Options consumed by `enforceCompositeFlagMatrix`.
 *
 * `tools` mirrors the parent's `--tool` aggregator (an array of
 * member names). `help` mirrors the manual `--help` flag the P4
 * migration introduced. `resume` is included so the §14.H last row
 * (`--treat-as-tool` + `--resume` → ERR-2) can be enforced; it is
 * optional because the spec value comes from a different Commander
 * option (`opts.resume`) and the §14.D contract did not foresee it
 * — an additive widening that does not break existing callers.
 *
 * `argv` is an optional escape hatch for tests; production callers
 * omit it and the function reads `process.argv.slice(2)` directly.
 * The argv is inspected to distinguish "flag explicitly supplied"
 * from "flag set to its default" for the catch-all "<flag> requires
 * --treat-as-tool" rules.
 */
export interface EnforceMatrixOptions {
  readonly tools: readonly string[];
  readonly help?: boolean;
  readonly resume?: boolean | string;
  readonly argv?: readonly string[];
}

/**
 * Implements the canonical §14.H flag interaction matrix. Throws
 * `UsageError` (exit code 2) for any forbidden cell; returns
 * silently for permitted cells. This is the single CLI-tier
 * gatekeeper for composite-flag conflicts; the action handler in
 * `src/cli.ts` calls it BEFORE the help branch so a flag-matrix
 * violation is reported with a uniform error path regardless of
 * whether `--help` was set.
 *
 * The matrix rows enforced (canonical reference: §14.H of
 * project-design.md):
 *
 *   1. Catch-all `<flag> requires --treat-as-tool` for: `--composite-name`,
 *      `--emit-doc`/`--no-emit-doc`, `--emit-wrapper`,
 *      `--emit-wrapper-on-path`, `--register-virtual`,
 *      `--dry-run-synthesis`, `--force-overwrite`.
 *   2. ADR-CMP-3 / OQ-7 deviation: `--regenerate-capabilities` without
 *      `--treat-as-tool` → exit 2 with the dedicated guidance message.
 *   3. `--synthesis-budget-tokens` without `--treat-as-tool` → OK
 *      (recorded for future synthesis runs in the same session).
 *   4. `--treat-as-tool` + `--help` + empty member list → exit 2.
 *   5. `--treat-as-tool` + `--no-emit-doc` + `!--emit-wrapper` +
 *      `!--register-virtual` (zero distribution forms) → exit 2.
 *      This blocks the "synthesis runs but produces no artifact"
 *      footgun. Note the rule fires only when `--no-emit-doc` was
 *      EXPLICITLY supplied — the implicit emit-doc default keeps the
 *      bare `--treat-as-tool --help` path operational.
 *   6. `--emit-wrapper-on-path` without `--emit-wrapper` → exit 2.
 *   7. `--treat-as-tool` + `--resume` → exit 2.
 *
 * Rules NOT enforced here (deferred to other units):
 *   - `--composite-name` regex validation → P5 `validateCompositeName`.
 *   - Composite-name collision (`--force-overwrite` resolution) →
 *     U-VIRTUAL `writeManifest` (read-then-write under O_EXCL lock).
 *   - Synthesis-budget overrun mid-pipeline → U-SYNTH.
 *   - Recursion guards (composite-of-composite) → U-VIRTUAL.
 *
 * Permitted cells (will NOT throw — guard against accidental over-
 * enforcement in future edits):
 *   - Bare invocation, no composite flags at all.
 *   - `--treat-as-tool` alone (metadata-only, no synthesis).
 *   - `--treat-as-tool` + emit/register flags without `--help` (recorded
 *     for next synthesis in the same session).
 *   - `--dry-run-synthesis` + `--emit-wrapper` and/or
 *     `--register-virtual` — the dry-run is enforced INSIDE the
 *     synthesis pipeline (no LLM, no cache write); pairing with
 *     emission flags is permitted by §14.H ("Print stage prompts +
 *     digests; do NOT call LLM; do NOT write cache" cell does not
 *     forbid the emit flags).
 *   - `--synthesis-budget-tokens <n>` without `--treat-as-tool`
 *     ("OK (no-op; ignored without synth)" — §14.H row).
 */
export function enforceCompositeFlagMatrix(
  flags: CompositeCliFlags,
  opts: EnforceMatrixOptions,
): void {
  const argv = opts.argv ?? process.argv.slice(2);
  const presence = detectPresence(argv);

  // Resolve `--help` and `--resume` from either the typed opts
  // (preferred — caller has already de-shadowed parent globals) or
  // the raw argv (fallback for direct programmatic use).
  const helpRequested = opts.help === true || argv.includes('--help') || argv.includes('-h');
  const resumeRequested =
    opts.resume === true ||
    typeof opts.resume === 'string' ||
    presence.resume;

  // ---- Rule 0: bare no-treat-as-tool invocation is a fast-path
  // identity. Skip ALL composite-flag checks unless the user opted
  // into composite mode OR supplied a composite-only flag (which
  // triggers the catch-all). This preserves byte-stable behaviour
  // for the existing cli-agent surface (NFR-CMP-001).
  const anyCompositeFlagPresent =
    flags.treatAsTool ||
    presence.compositeName ||
    presence.emitDoc ||
    presence.emitWrapper ||
    presence.emitWrapperOnPath ||
    presence.registerVirtual ||
    presence.regenerateCapabilities ||
    presence.dryRunSynthesis ||
    presence.synthesisBudgetTokens ||
    presence.forceOverwrite;
  if (!anyCompositeFlagPresent) {
    return; // identity for normal cli-agent invocations
  }

  // ---- Rule 1+2: catch-all "requires --treat-as-tool" plus the
  // ADR-CMP-3 deviation for --regenerate-capabilities. Emit the
  // deviation message FIRST when applicable so the user gets the
  // most actionable guidance. --synthesis-budget-tokens is
  // explicitly permitted without --treat-as-tool (no-op).
  if (!flags.treatAsTool) {
    if (presence.regenerateCapabilities) {
      throw new UsageError(
        '--regenerate-capabilities requires --treat-as-tool; use --refresh-capabilities for member-tool discovery refresh',
        { flag: '--regenerate-capabilities', requires: '--treat-as-tool' },
      );
    }
    // Catch-all order matches the §14.H matrix row order so the
    // surfaced message is deterministic across argv permutations.
    if (presence.compositeName) {
      throw new UsageError('--composite-name requires --treat-as-tool', {
        flag: '--composite-name',
        requires: '--treat-as-tool',
      });
    }
    if (presence.emitDocPositive) {
      throw new UsageError('--emit-doc requires --treat-as-tool', {
        flag: '--emit-doc',
        requires: '--treat-as-tool',
      });
    }
    if (presence.emitDocNegative) {
      throw new UsageError('--no-emit-doc requires --treat-as-tool', {
        flag: '--no-emit-doc',
        requires: '--treat-as-tool',
      });
    }
    if (presence.emitWrapper) {
      throw new UsageError('--emit-wrapper requires --treat-as-tool', {
        flag: '--emit-wrapper',
        requires: '--treat-as-tool',
      });
    }
    if (presence.emitWrapperOnPath) {
      throw new UsageError('--emit-wrapper-on-path requires --treat-as-tool', {
        flag: '--emit-wrapper-on-path',
        requires: '--treat-as-tool',
      });
    }
    if (presence.registerVirtual) {
      throw new UsageError('--register-virtual requires --treat-as-tool', {
        flag: '--register-virtual',
        requires: '--treat-as-tool',
      });
    }
    if (presence.dryRunSynthesis) {
      throw new UsageError('--dry-run-synthesis requires --treat-as-tool', {
        flag: '--dry-run-synthesis',
        requires: '--treat-as-tool',
      });
    }
    if (presence.forceOverwrite) {
      throw new UsageError('--force-overwrite requires --treat-as-tool', {
        flag: '--force-overwrite',
        requires: '--treat-as-tool',
      });
    }
    // synthesisBudgetTokens is allowed without --treat-as-tool per
    // §14.H "OK (no-op; ignored without synth)". No throw.
    return;
  }

  // ---- Below this line --treat-as-tool is in effect. ----

  // Rule 7: `--treat-as-tool` + `--resume` is forbidden (§14.H last
  // row). Both with and without `--help`.
  if (resumeRequested) {
    throw new UsageError('--treat-as-tool is incompatible with --resume', {
      flag: '--treat-as-tool',
      conflictsWith: '--resume',
    });
  }

  // Rule 6: `--emit-wrapper-on-path` requires `--emit-wrapper`. This
  // applies in BOTH the with-help and without-help branches (the
  // PATH symlink would orphan an unmaterialised shim). Enforce
  // before the help-branch checks so the message is consistent.
  if (flags.emitWrapperOnPath && !flags.emitWrapper) {
    throw new UsageError('--emit-wrapper-on-path requires --emit-wrapper', {
      flag: '--emit-wrapper-on-path',
      requires: '--emit-wrapper',
    });
  }

  // Rule 5: zero distribution forms — block the "synthesis runs
  // but writes nothing" footgun. Only triggers when the user
  // EXPLICITLY supplied --no-emit-doc (otherwise the implicit
  // emit-doc default keeps the bare --treat-as-tool --help path
  // operational). Affects both with-help and without-help branches:
  // even the "recorded for next synthesis" path is meaningless if
  // every distribution form is suppressed.
  if (
    presence.emitDocNegative &&
    !flags.emitDoc &&
    !flags.emitWrapper &&
    !flags.registerVirtual
  ) {
    throw new UsageError(
      'composite must emit at least one of: --emit-doc, --emit-wrapper, --register-virtual',
      {
        flag: '--no-emit-doc',
        suggestion: 'enable --emit-wrapper or --register-virtual, or drop --no-emit-doc',
      },
    );
  }

  // Rule 4: `--treat-as-tool` + `--help` + empty member list →
  // exit 2. The synthesis path needs at least one member to
  // distil. Already enforced inside the action handler in
  // `src/cli.ts`, but mirrored here so a programmatic caller of
  // `enforceCompositeFlagMatrix` gets the same guarantee. AC-3 / E-1.
  if (helpRequested && opts.tools.length === 0) {
    throw new UsageError(
      'composite synthesis requires at least one --tool argument',
      { flag: '--treat-as-tool', missing: '--tool' },
    );
  }

  // All other combinations with `--treat-as-tool` are permitted by
  // §14.H. Composite-name regex validation, collision checks, and
  // recursion guards happen in their owning units (see fn header).
}
