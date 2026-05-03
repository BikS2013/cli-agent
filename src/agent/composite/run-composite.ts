/**
 * Composite synthesis entry point — full dispatcher (plan-006 P6 / U-CMD).
 *
 * Lives outside `src/commands/composite/` so the foundation modules
 * (P3–P5) can call it without importing the command tree (cycle risk).
 * The dispatcher is intentionally thin: it routes by `mode` and delegates
 * to the U-CMD `synthesize` handler. The actual side-effects
 * (synthesis, doc emission, shim, manifest) live in
 * `src/commands/composite/synthesize.ts`.
 *
 * Two entry modes:
 *   - `'help-synthesis'` — invoked from `src/cli.ts` when the user
 *     types `cli-agent --treat-as-tool --tool A --tool B --help`. The
 *     pipeline runs and the synthesised doc is printed to stdout.
 *   - `'synthesize-cmd'` — invoked by the
 *     `cli-agent composite-synthesize ...` subcommand handler when it
 *     wants to share the dispatcher (kept here for future cross-call
 *     uses; today the subcommand handler can also call
 *     `handleSynthesize` directly).
 */

import type { CompositeCliFlags } from '../../cli-composite-flags.js';
import { handleSynthesize } from '../../commands/composite/synthesize.js';
import type { AgentConfig } from './types.js';

export interface RunCompositeOptions {
  /** Mode discriminant. */
  readonly mode: 'help-synthesis' | 'synthesize-cmd';
  /** Member tool names (array form; the parent CLI's `--tool` aggregator). */
  readonly tools?: readonly string[];
  /** Pre-parsed composite flags. Optional — the dispatcher will parse
   * `rawOpts` itself when this field is absent. */
  readonly flags?: CompositeCliFlags;
  /** Optional override for the resolved AgentConfig. */
  readonly cfgOverride?: AgentConfig;
  /** All other CLI opts pass through verbatim — `parseCompositeFlags`
   * picks the relevant ones up. */
  readonly [key: string]: unknown;
}

export async function runComposite(opts: RunCompositeOptions): Promise<void> {
  switch (opts.mode) {
    case 'help-synthesis':
    case 'synthesize-cmd': {
      const tools = Array.isArray(opts.tools)
        ? (opts.tools as string[])
        : [];
      // Pull the raw rest of opts so `parseCompositeFlags` can reach
      // them; strip the discriminator + reserved keys to keep the
      // input cleanly typed.
      const { mode, tools: _tools, flags, cfgOverride, ...rawOpts } = opts;
      void mode;
      void _tools;
      await handleSynthesize({
        mode: opts.mode,
        tools,
        flags,
        cfgOverride,
        rawOpts: rawOpts as Record<string, unknown>,
      });
      return;
    }
    default: {
      const _exhaustive: never = opts.mode;
      void _exhaustive;
      throw new Error(`unknown composite mode: ${String(opts.mode)}`);
    }
  }
}
