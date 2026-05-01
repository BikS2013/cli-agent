/**
 * Internal synchronous prompt-file loader.
 *
 * Each tool calls `loadPromptFile(import.meta.url, '<name>.prompt.md')`
 * at module init so that `tool.prompt` is a string immediately after
 * import. Reads happen via `fs.readFileSync` and are cached by absolute
 * path; subsequent calls for the same file are O(1).
 *
 * Internal — NOT re-exported from the package barrel. Tools talk to
 * this module directly; consumers go through `src/prompts/index.ts`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, isAbsolute } from 'node:path';

const cache = new Map<string, string>();

/**
 * Load a prompt fragment from disk synchronously.
 *
 * The first form `loadPromptFile(callerImportMetaUrl, basename)`
 * resolves the file relative to the directory of the caller's module
 * (typical usage from a tool's `index.ts`).
 *
 * The second form `loadPromptFile(absolutePath)` reads the file at the
 * supplied absolute path directly. Used by tests.
 *
 * @throws if the file is missing or empty.
 */
export function loadPromptFile(
  callerImportMetaUrl: string,
  basename: string,
): string;
export function loadPromptFile(absolutePath: string): string;
export function loadPromptFile(
  arg1: string,
  basename?: string,
): string {
  const absolute = resolveAbsolute(arg1, basename);
  const cached = cache.get(absolute);
  if (cached !== undefined) return cached;
  const raw = readFileSync(absolute, 'utf8');
  if (raw.length === 0) {
    throw new Error(`Prompt fragment is empty: ${absolute}`);
  }
  cache.set(absolute, raw);
  return raw;
}

function resolveAbsolute(arg1: string, basename: string | undefined): string {
  if (basename === undefined) {
    if (!isAbsolute(arg1)) {
      throw new Error(
        `loadPromptFile expects an absolute path when called with one argument; got: ${arg1}`,
      );
    }
    return arg1;
  }
  // arg1 is a caller's import.meta.url; convert to a directory path.
  const dir = dirname(fileURLToPath(arg1));
  return join(dir, basename);
}

/**
 * Test seam: clears the load cache. Not exported from the package
 * barrel — only used by direct tests that want a clean slate.
 */
export function _resetLoaderCache(): void {
  cache.clear();
}
