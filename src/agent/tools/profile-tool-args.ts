/**
 * Profile tool-args merge helper (plan-005, Unit U-ARGS).
 *
 * Each tool factory's `.func` body calls `mergeProfileToolArgs` once at the
 * top to overlay any profile-supplied default arguments onto the runtime
 * `input`. The merge is shallow per-key with **runtime input winning per key**:
 *
 *   - If the active profile (carried via `RunnableConfig.configurable.profileToolArgs`)
 *     has no preset entry for `toolName`, `input` is returned unchanged.
 *   - Otherwise the result is `{ ...presets, ...input }` so any key supplied at
 *     runtime overrides the preset, while preset-only keys are preserved.
 *
 * v1: preset values are NOT Zod-validated at profile-load time; validation
 * occurs at first tool call (Zod schema rejection). Full load-time
 * `validateToolArgsAgainstTool` is deferred to v2 (plan-005 §5
 * U-FOUNDATION-FOLLOWUP, E10) — the shallow merge already lets runtime
 * input override preset keys, so a malformed preset surfaces as a Zod
 * parse error at the moment the LLM first calls the tool, which is
 * acceptable for v1. This helper is intentionally tolerant of malformed
 * `profileToolArgs` shapes — it just returns `input` unchanged in that
 * case so a bad profile cannot break a tool call mid-flight (defence in
 * depth).
 *
 * See `docs/design/plan-005-config-profiles.md` §5 Unit U-ARGS and
 * `docs/design/project-design.md` §12.M.
 */

/**
 * Shape of the profile-tool-args sub-bag carried on the LangChain
 * `RunnableConfig.configurable` object. Outer key = tool name; inner record
 * = preset arg key/value pairs to overlay onto the runtime input.
 */
export interface ProfileToolArgsConfigurable {
  profileToolArgs?: Record<string, Record<string, unknown>>;
}

/**
 * Shallow per-key merge of profile-supplied preset args onto a runtime tool
 * input. Runtime input keys win over preset keys; preset keys absent from
 * runtime are preserved.
 *
 * @param input        Runtime input object passed to the tool's `.func`.
 *                     `null`/`undefined` is tolerated (treated as `{}`).
 * @param configurable The `RunnableConfig.configurable` bag (or `undefined`).
 *                     Read-only — never mutated.
 * @param toolName     Exact registered tool name (matches the factory's
 *                     `TOOL_NAME` / `AGT_*_NAME` constant).
 * @returns            A new object `{ ...presets, ...input }` typed as `I`,
 *                     OR the original `input` reference if no presets apply.
 */
export function mergeProfileToolArgs<I extends Record<string, unknown>>(
  input: I | null | undefined,
  configurable: ProfileToolArgsConfigurable | undefined | null,
  toolName: string,
): I {
  // Defensive: tool factories that pass through `input` unchanged from
  // LangChain may receive `null`/`undefined` in degenerate cases; treat as {}.
  const safeInput: Record<string, unknown> = (input ?? {}) as Record<string, unknown>;

  // Defensive: malformed `configurable` (or missing `profileToolArgs`) ⇒ identity.
  if (
    configurable === undefined ||
    configurable === null ||
    typeof configurable !== 'object'
  ) {
    return safeInput as I;
  }
  const bag = configurable.profileToolArgs;
  if (!bag || typeof bag !== 'object') {
    return safeInput as I;
  }

  const presets = bag[toolName];
  if (!presets || typeof presets !== 'object') {
    return safeInput as I;
  }

  const presetKeys = Object.keys(presets);
  if (presetKeys.length === 0) {
    return safeInput as I;
  }

  // Shallow merge with runtime input winning per-key.
  return { ...presets, ...safeInput } as I;
}
