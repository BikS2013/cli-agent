/**
 * Public prompt API.
 *
 * The library stores per-tool prompt fragments in a process-wide
 * registry (`src/prompts/registry.ts`); tools register themselves at
 * module load time. This file exposes the read side: lookup by name,
 * filtered map, and the `buildSystemPromptBlock` helper.
 *
 * Substitution rule: every `${KEY}` token in a registered prompt is
 * replaced with `String(context[KEY])` when the key is defined on the
 * supplied {@link PromptSubstitutionContext}. Unknown tokens are left
 * literal so that downstream renderers can substitute them later.
 * In a test environment (`NODE_ENV === 'test'`) we additionally emit a
 * `console.warn` to make undefined placeholders visible.
 */

import { ToolExecutionError } from '../errors.js';
import {
  _getRegisteredPrompt,
  _listRegisteredPrompts,
} from './registry.js';

/** Substitutions accepted by {@link buildSystemPromptBlock}. */
export interface PromptSubstitutionContext {
  /** Operating system, typically `process.platform`. */
  readonly os?: string;
  /** Shell, typically `process.env.SHELL` or `'/bin/sh'`. */
  readonly shell?: string;
  /** Human-readable chaining policy line (e.g. "no chaining allowed"). */
  readonly chaining?: string;
  /** Bash output line cap. */
  readonly maxLines?: number;
  /** Bash output byte cap. */
  readonly maxBytes?: number;
  /** Resolved working directory. */
  readonly directory?: string;
  /** Free-form additional substitutions. */
  readonly [key: string]: string | number | boolean | undefined;
}

/** Options for {@link buildSystemPromptBlock}. */
export interface SystemPromptBlockOptions {
  /** Tool names to include. Defaults to every registered tool. */
  readonly include?: readonly string[];
  /** Substitution context for tools that template their prompts. */
  readonly context?: PromptSubstitutionContext;
  /** Heading rendered above the concatenated block. */
  readonly heading?: string;
}

/**
 * Returns the verbatim prompt fragment for a single tool.
 *
 * @throws {ToolExecutionError} (code `'PROMPT_NOT_FOUND'`) when no
 *   prompt has been registered for `name`.
 */
export function getToolPrompt(name: string): string {
  const entry = _getRegisteredPrompt(name);
  if (entry === undefined) {
    throw new ToolExecutionError(
      `No prompt registered for tool: ${name}`,
      { code: 'PROMPT_NOT_FOUND' },
    );
  }
  return entry.prompt;
}

/**
 * Returns a name→prompt map filtered by an explicit `names` list.
 * Names that are not registered are silently omitted.
 */
export function getToolPrompts(
  names: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const entry = _getRegisteredPrompt(name);
    if (entry !== undefined) {
      out[name] = entry.prompt;
    }
  }
  return out;
}

/** Returns a name→prompt map containing every registered tool. */
export function getAllToolPrompts(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of _listRegisteredPrompts()) {
    const entry = _getRegisteredPrompt(name);
    if (entry !== undefined) {
      out[name] = entry.prompt;
    }
  }
  return out;
}

/**
 * Build a single system-prompt block by concatenating per-tool
 * fragments, optionally filtered and templated.
 *
 * Filtering: when `include` is provided we use those names in the
 * order given; otherwise every registered tool is included in
 * registration order.
 *
 * Concatenation: fragments are joined with `\n\n---\n\n`. The
 * `heading` (default `"## Available tools"`) is rendered above the
 * block.
 */
export function buildSystemPromptBlock(
  opts: SystemPromptBlockOptions = {},
): string {
  const heading = opts.heading ?? '## Available tools';
  const names = opts.include ?? _listRegisteredPrompts();
  const fragments: string[] = [];
  for (const name of names) {
    const entry = _getRegisteredPrompt(name);
    if (entry === undefined) continue;
    fragments.push(applySubstitutions(entry.prompt, opts.context));
  }
  const body = fragments.join('\n\n---\n\n');
  return `${heading}\n\n${body}`;
}

/**
 * Replace every `${key}` token in `text` with the corresponding value
 * from `context`. Unknown tokens are left literal; in test
 * environments a `console.warn` flags every miss.
 */
function applySubstitutions(
  text: string,
  context: PromptSubstitutionContext | undefined,
): string {
  if (text.indexOf('${') === -1) return text;
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key: string) => {
    const value = context?.[key];
    if (value === undefined) {
      if (process.env['NODE_ENV'] === 'test') {
        // eslint-disable-next-line no-console
        console.warn(
          `[agent-tools] prompt substitution: no value for \${${key}}`,
        );
      }
      return match;
    }
    return String(value);
  });
}
