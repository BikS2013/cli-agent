/**
 * Profile tool-scoping algorithm (plan-005 U-SCOPE).
 *
 * Filters and reorders the assembled `buildToolCatalog` tool array per the
 * active profile's `tools` sub-tree (`{ allow?, deny?, order? }`). Strict
 * three-pass evaluation per investigation Recommendation #3:
 *
 *   1. Validation pass — hard errors:
 *        - E23: `allow ∩ deny` non-empty.
 *        - E22: duplicate names in `order`.
 *   2. Allow pass — keep only tools whose name is in `allow` (if present).
 *      Names in `allow` that are not in the catalog → warning (E8).
 *   3. Deny pass — drop tools whose name is in `deny` (if present).
 *      Names in `deny` that are not in the catalog → warning (E8).
 *   4. Empty-survivor check — hard error E7 if everything was filtered out.
 *   5. Order pass — stable reorder; survivors mentioned in `order` come first
 *      in `order`'s order, the rest keep their original relative position.
 *      Names in `order` not present among survivors → warning (E21).
 *
 * The function is pure: it does not log or mutate. Warnings are returned
 * to the caller so the call site (registry.ts) decides how to surface
 * them (currently: stderr).
 *
 * Spec references:
 *   - docs/design/plan-005-config-profiles.md §5 U-SCOPE
 *   - docs/design/project-design.md §12 (scoping algorithm + §12.M)
 *   - docs/design/plan-005-config-profiles.md §10 error matrix (E7, E8,
 *     E21, E22, E23).
 */

import { ConfigurationError } from '../../errors.js';
import type { ProfileTools } from '../../config/profile-schema.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyTool = any;

/**
 * Result returned by {@link applyProfileToolScoping}.
 *
 * `warnings` collects non-fatal issues — currently E8 (unknown name in
 * allow/deny) and E21 (`order` references a non-survivor). The registry
 * forwards these to stderr at catalog assembly time.
 */
export interface ProfileScopingResult {
  readonly tools: AnyTool[];
  readonly warnings: string[];
}

/**
 * Apply a profile's `tools` sub-tree to the assembled tool catalog.
 *
 * Returns the original `tools` array (by reference) and an empty
 * `warnings` array when `scoping` is `undefined` or all three sub-keys
 * (`allow`, `deny`, `order`) are themselves `undefined` — the caller can
 * detect "no scoping" by `warnings.length === 0` AND identical reference,
 * but should not rely on that since both branches behave identically
 * downstream.
 *
 * @throws ConfigurationError E22 — `order` contains a duplicate name.
 * @throws ConfigurationError E23 — `allow ∩ deny` is non-empty.
 * @throws ConfigurationError E7  — survivors list is empty after allow+deny.
 */
export function applyProfileToolScoping(
  tools: AnyTool[],
  scoping: ProfileTools | undefined,
): ProfileScopingResult {
  // Identity case: no scoping at all → return as-is.
  if (
    scoping === undefined ||
    (scoping.allow === undefined &&
      scoping.deny === undefined &&
      scoping.order === undefined)
  ) {
    return { tools, warnings: [] };
  }

  const { allow, deny, order } = scoping;
  const warnings: string[] = [];

  // ---- Pass 1: validation (hard errors) ----

  // E23: allow ∩ deny non-empty.
  if (allow && deny) {
    const allowSet = new Set(allow);
    const intersection = deny.filter((n) => allowSet.has(n));
    if (intersection.length > 0) {
      throw new ConfigurationError(
        'profile.tools',
        ['profile file'],
        {
          detail:
            `profile.tools.allow and profile.tools.deny share entries: ${intersection.join(', ')}. ` +
            `A tool cannot be both allowed and denied — remove the offending name(s) from one of the lists.`,
          intersection,
        },
      );
    }
  }

  // E22: duplicates in `order`.
  if (order) {
    const seen = new Set<string>();
    const dups: string[] = [];
    for (const name of order) {
      if (seen.has(name)) {
        if (!dups.includes(name)) dups.push(name);
      } else {
        seen.add(name);
      }
    }
    if (dups.length > 0) {
      throw new ConfigurationError(
        'profile.tools.order',
        ['profile file'],
        {
          detail:
            `profile.tools.order contains duplicate entries: ${dups.join(', ')}. ` +
            `Each tool name may appear at most once in the order list.`,
          duplicates: dups,
        },
      );
    }
  }

  // ---- Pass 2: allow filter ----
  // Build a name lookup of the input catalog for the unknown-name warning.
  const catalogNames = new Set<string>(tools.map((t) => t.name));

  let survivors: AnyTool[] = tools;

  if (allow) {
    const allowSet = new Set(allow);
    for (const name of allow) {
      if (!catalogNames.has(name)) {
        warnings.push(
          `profile allowlist references unknown tool '${name}' — ignoring`,
        );
      }
    }
    survivors = survivors.filter((t) => allowSet.has(t.name));
  }

  // ---- Pass 3: deny filter ----
  if (deny) {
    const denySet = new Set(deny);
    for (const name of deny) {
      if (!catalogNames.has(name)) {
        warnings.push(
          `profile denylist references unknown tool '${name}' — ignoring`,
        );
      }
    }
    survivors = survivors.filter((t) => !denySet.has(t.name));
  }

  // ---- Pass 4: empty-survivor check (E7) ----
  if (survivors.length === 0) {
    throw new ConfigurationError(
      'profile.tools',
      ['profile file'],
      {
        detail:
          `profile.tools allow/deny combination disabled every tool in the catalog. ` +
          `Relax the allow list, remove offending deny entries, or remove the profile.`,
        allow: allow ?? null,
        deny: deny ?? null,
      },
    );
  }

  // ---- Pass 5: stable reorder ----
  if (order && order.length > 0) {
    const survivorNames = new Set<string>(survivors.map((t) => t.name));

    // E21: names in order that are not survivors.
    for (const name of order) {
      if (!survivorNames.has(name)) {
        warnings.push(
          `profile order references tool '${name}' that was excluded by allow/deny — ignoring`,
        );
      }
    }

    // Stable rearrangement:
    //   - "front" = survivors mentioned in `order`, in `order`'s order.
    //   - "tail"  = remaining survivors in their original relative order.
    const orderedSet = new Set<string>(order);
    const byName = new Map<string, AnyTool>();
    for (const t of survivors) byName.set(t.name, t);

    const front: AnyTool[] = [];
    for (const name of order) {
      const tool = byName.get(name);
      if (tool !== undefined) front.push(tool);
    }
    const tail: AnyTool[] = survivors.filter((t) => !orderedSet.has(t.name));

    survivors = [...front, ...tail];
  }

  return { tools: survivors, warnings };
}
