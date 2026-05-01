/**
 * U5 prompt-block assembler for the agent-tools pack.
 *
 * `buildAgentToolsPromptBlock(meta)` projects an
 * {@link AgentToolsCatalogMeta} snapshot into a markdown block that the
 * system-prompt builder concatenates after the wrapped-CLI capability
 * documents.
 *
 * Single source of truth: every section's body is the same string the
 * wrapper hands to LangChain via `DynamicStructuredTool.description`
 * (exported as `AGT_*_DESCRIPTION` from each wrapper module). The
 * group-builder copies that description into the catalog metadata, and
 * this assembler renders it verbatim — there is no second copy of the
 * text in this file.
 *
 * Determinism: identical input always produces a byte-identical output.
 * Empty input (no tools registered, OR umbrella off) produces `''`; the
 * caller must not add a header / separator in that case so the assembled
 * prompt is byte-stable with the pre-integration prompt.
 *
 * Output shape (when at least one tool is registered):
 *
 * ```
 * \n
 * ## Optional standard tools (agent-tools pack)
 *
 * The following bundled tools are also available in this session:
 *
 * ### `<name>`
 * <description>
 *
 * ### `<name>`
 * <description>
 * ...
 * \n
 * ```
 *
 * Leading and trailing `\n` keep concatenation with the rest of the
 * prompt clean (the caller can append the block with no extra glue).
 */

import type { AgentToolsCatalogMeta } from './group-builder.js';

const HEADER = '## Optional standard tools (agent-tools pack)';
const INTRO =
  'The following bundled tools are also available in this session:';

/**
 * Render the agent-tools system-prompt block.
 *
 * @returns `''` when `meta.registered.length === 0` (umbrella off OR
 *          no per-tool flag enabled). Otherwise the markdown block
 *          above, framed by a leading and trailing newline.
 */
export function buildAgentToolsPromptBlock(
  meta: AgentToolsCatalogMeta,
): string {
  if (meta.registered.length === 0) {
    return '';
  }

  const sections: string[] = [];
  for (const entry of meta.registered) {
    sections.push(`### \`${entry.name}\`\n${entry.description.trimEnd()}`);
  }

  // Leading and trailing newline, double-newline between header/intro
  // and each section.
  return (
    '\n' +
    [HEADER, '', INTRO, '', sections.join('\n\n')].join('\n') +
    '\n'
  );
}
