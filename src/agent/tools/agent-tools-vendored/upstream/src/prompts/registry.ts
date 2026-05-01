/**
 * In-memory registry of tool prompts.
 *
 * Tool modules call {@link registerPrompt} at module load time. The
 * public `getToolPrompt` / `buildSystemPromptBlock` API in
 * `src/prompts/index.ts` reads from this registry.
 *
 * Internal: the underscored accessors are not re-exported from the
 * package barrel.
 */

interface RegistryEntry {
  readonly description: string;
  readonly prompt: string;
}

const registry = new Map<string, RegistryEntry>();

/**
 * Register a tool's prompt under its name. Re-registering the same
 * name silently overwrites the previous entry — this lets a tool
 * module re-register safely (e.g. when reloaded by a test runner).
 */
export function registerPrompt(
  name: string,
  description: string,
  prompt: string,
): void {
  registry.set(name, { description, prompt });
}

/** Internal accessor — returns `undefined` when `name` is not registered. */
export function _getRegisteredPrompt(name: string): RegistryEntry | undefined {
  return registry.get(name);
}

/** Internal accessor — returns the list of registered tool names. */
export function _listRegisteredPrompts(): ReadonlyArray<string> {
  return Array.from(registry.keys());
}

/** Test seam: clears the registry. Not exported from the package barrel. */
export function _resetRegistry(): void {
  registry.clear();
}
