/**
 * extract-recipes — propose canonical invocation recipes for a wrapped
 * tool by feeding its --help text (and its man page when available)
 * through the configured LLM.
 *
 * Default behavior: write the proposal directly between the existing
 * `<!-- USER-RECIPES:START -->` / `<!-- USER-RECIPES:END -->` markers
 * in the capability document. The user is the curator: anything they
 * don't want, they delete by hand.
 *
 * Use `--stdout` to print without writing (for piping, review, or CI).
 * Use `--append` to keep any existing recipes and append the new ones
 * instead of replacing the inner block.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  loadAgentConfig,
  type AgentCliFlags,
} from '../config/agent-config.js';
import { createLLM } from '../agent/providers/registry.js';
import { spawnCommand } from '../agent/tools/bash/exec.js';
import { CapabilityError, UsageError } from '../errors.js';

const HELP_INPUT_CAP = 8192;
const MAN_INPUT_CAP = 64 * 1024;
const DEFAULT_MAX_RECIPES = 8;
const HARD_MAX_RECIPES = 20;

export interface ExtractRecipesFlags extends AgentCliFlags {
  readonly maxRecipes?: number;
  /**
   * Opt-out: when true, print the proposal to stdout and DO NOT touch
   * the capability document. Default false — the command writes the
   * proposal between the USER-RECIPES markers.
   */
  readonly stdout?: boolean;
  /**
   * When writing, keep any existing recipes and append the new ones
   * instead of replacing the inner block.
   */
  readonly append?: boolean;
}

export async function runExtractRecipes(
  toolName: string | undefined,
  opts: ExtractRecipesFlags,
): Promise<void> {
  if (!toolName) {
    throw new UsageError('--tool <name> is required for extract-recipes.');
  }
  const requested = opts.maxRecipes ?? DEFAULT_MAX_RECIPES;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new UsageError('--max-recipes must be a positive integer.');
  }
  const maxRecipes = Math.min(Math.floor(requested), HARD_MAX_RECIPES);

  const cfg = await loadAgentConfig(opts);
  const filePath = path.join(cfg.capabilitiesDir, `${toolName}.md`);

  let docContent: string;
  try {
    docContent = await fsp.readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      throw new CapabilityError(
        'E_CAPABILITY_NOT_FOUND',
        `No capability document for '${toolName}'. Run: cli-agent refresh-capabilities --tool ${toolName}`,
        { tool: toolName },
      );
    }
    throw e;
  }

  const helpText = extractTopLevelSynopsis(docContent);
  const manRef = extractManRefFromFrontmatter(docContent);
  let manText = '';
  if (manRef) {
    const section = manRef.replace(/^man:/, '').split(' ')[0] ?? '';
    manText = await readManPage(section, toolName, cfg.capabilities.timeoutMs);
    if (!manText) {
      process.stderr.write(
        `[cli-agent] note: man page for '${toolName}' is recorded but could not be read; using --help only.\n`,
      );
    }
  } else {
    process.stderr.write(
      `[cli-agent] note: no man page recorded for '${toolName}'; using --help only.\n`,
    );
  }

  const llm = createLLM(cfg);
  const prompt = buildPrompt(toolName, helpText, manText, maxRecipes);
  const response = await llm.invoke([{ role: 'user', content: prompt }]);
  const text = typeof response.content === 'string'
    ? response.content
    : JSON.stringify(response.content);
  const proposal = sanitizeProposal(text.trim());

  if (opts.stdout) {
    process.stdout.write(proposal);
    process.stdout.write('\n');
    return;
  }

  const updated = mergeRecipesIntoDoc(docContent, proposal, opts.append === true);
  await fsp.writeFile(filePath, updated, { encoding: 'utf8', mode: 0o600 });
  process.stderr.write(
    `[cli-agent] wrote recipes to ${filePath}` +
    (opts.append ? ' (appended)' : ' (replaced)') +
    '. Review with: cli-agent show-capabilities --tool ' + toolName + '\n',
  );
}

/**
 * Strip preamble/closing chatter the model occasionally adds even
 * when told not to. Anchor on the first `### ` heading and keep
 * everything from there forward.
 */
function sanitizeProposal(raw: string): string {
  const idx = raw.indexOf('### ');
  if (idx === -1) return raw;
  return raw.slice(idx).trim();
}

/**
 * Splice `proposal` into the document's USER-RECIPES marker block.
 * `append=true` keeps existing inner content; otherwise replaces it.
 * Raises `UsageError` when the document is missing the markers — the
 * fix is to run `refresh-capabilities` to regenerate the schema-2
 * shape, not to silently invent the markers here (that would mask a
 * stale doc).
 */
function mergeRecipesIntoDoc(doc: string, proposal: string, append: boolean): string {
  const startTag = '<!-- USER-RECIPES:START -->';
  const endTag = '<!-- USER-RECIPES:END -->';
  const sIdx = doc.indexOf(startTag);
  const eIdx = doc.indexOf(endTag);
  if (sIdx === -1 || eIdx === -1 || eIdx < sIdx) {
    throw new UsageError(
      `Capability document is missing the USER-RECIPES marker block. ` +
      `Run \`cli-agent refresh-capabilities --tool <name>\` to regenerate the schema-2 shape, then retry.`,
    );
  }
  const before = doc.slice(0, sIdx + startTag.length);
  const after = doc.slice(eIdx);
  const existingInner = doc.slice(sIdx + startTag.length, eIdx).trim();
  const innerBody = append && existingInner.length > 0
    ? `${existingInner}\n\n${proposal}`
    : proposal;
  return `${before}\n${innerBody}\n${after}`;
}

/* ---------- helpers ---------- */

function extractTopLevelSynopsis(doc: string): string {
  const m = doc.match(/## Top-level synopsis\n([\s\S]*?)(?=\n## |\n<!-- |$)/);
  if (!m?.[1]) return '';
  // Strip code fences if present.
  const body = m[1].replace(/^```[\s\S]*?\n/, '').replace(/```\s*$/, '').trim();
  return body.length > HELP_INPUT_CAP ? body.slice(0, HELP_INPUT_CAP) + '\n…[TRUNCATED]' : body;
}

function extractManRefFromFrontmatter(doc: string): string | null {
  const fm = doc.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  const m = fm[1]!.match(/^manRef:\s*(.+)$/m);
  if (!m) return null;
  const v = m[1]!.trim().replace(/^"(.*)"$/, '$1');
  return v.length > 0 ? v : null;
}

async function readManPage(section: string, tool: string, timeoutMs: number): Promise<string> {
  // `col -bx` strips backspace overstrikes that traditional man-page
  // formatters emit. Pipeline implemented via two spawn calls: man
  // produces stdout, we hand its output to col.
  let manResult;
  try {
    manResult = await spawnCommand({
      command: 'man',
      args: [section, tool],
      timeoutMs,
      maxOutputBytes: MAN_INPUT_CAP * 2,
      passEnv: ['PATH', 'HOME', 'LANG', 'TERM', 'MANPATH'],
      extraEnv: { PAGER: 'cat', MANPAGER: 'cat', NO_COLOR: '1', TERM: 'dumb' },
    });
  } catch {
    return '';
  }
  if (manResult.exitCode !== 0 || !manResult.stdout) return '';

  let colResult;
  try {
    colResult = await spawnCommand({
      command: 'col',
      args: ['-bx'],
      timeoutMs,
      maxOutputBytes: MAN_INPUT_CAP,
      passEnv: ['PATH', 'HOME', 'LANG', 'TERM'],
      stdin: manResult.stdout,
    });
  } catch {
    // `col` not on PATH — fall back to the raw man output (still useful).
    return manResult.stdout.length > MAN_INPUT_CAP
      ? manResult.stdout.slice(0, MAN_INPUT_CAP) + '\n…[TRUNCATED]'
      : manResult.stdout;
  }
  const out = colResult.exitCode === 0 ? colResult.stdout : manResult.stdout;
  return out.length > MAN_INPUT_CAP ? out.slice(0, MAN_INPUT_CAP) + '\n…[TRUNCATED]' : out;
}

function buildPrompt(
  tool: string,
  help: string,
  man: string,
  maxRecipes: number,
): string {
  return `You are an expert technical writer. Produce up to ${maxRecipes} canonical, idiomatic invocations of the CLI tool '${tool}'.

Output rules (STRICT):
- Output ONLY markdown — no preamble, no closing remarks.
- Each recipe MUST follow this exact shape:

### <short imperative title>
\`\`\`bash
${tool} <flags / args>
\`\`\`

- Use ONLY flags and subcommands that are present in the supplied help / man text below. Do NOT invent flags.
- Avoid destructive flags (--force, --hard, --no-verify, etc.) unless they are the canonical way to perform the action.
- Use \`<placeholder>\` style for arguments the user must supply (e.g. \`<file>\`, \`<branch>\`).
- Prefer high-frequency, daily-use invocations; not exotic edge cases.
- One recipe per task. No duplicates.

--- HELP TEXT ---
${help || '(no help text available)'}

--- MAN TEXT ---
${man || '(no man page available)'}
`;
}
