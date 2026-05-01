/**
 * Tool-prompt overlay loader + parser.
 *
 * Implements the user-editable overlay system specified in plan-004:
 * users can edit `~/.tool-agents/cli-agent/tool-prompts/<tool>.md` to
 * tune the description and per-parameter help text every native tool
 * exposes through `bindTools`. The overlay layer falls back to the
 * built-in defaults baked into `tool-prompts-builtin.ts` when no
 * overlay is registered for a given tool / parameter — that is the
 * documented "no overlay" state, NOT a runtime fallback for missing
 * required configuration (see CLAUDE.md).
 *
 * File format (pure markdown, no YAML dependency):
 *
 *     # <tool-name>
 *
 *     ## Description
 *
 *     <free-form markdown body>
 *
 *     ## Parameters
 *
 *     ### <param-1>
 *
 *     <param-1 description>
 *
 *     ### <param-2>
 *
 *     ...
 *
 * Parser rejects (raises ConfigurationError) on:
 *   - missing or wrong-form H1
 *   - missing `## Description` section
 *   - empty description body
 *   - duplicate `### <param>` names within `## Parameters`
 *
 * Parser DOES NOT throw on:
 *   - missing `## Parameters` section (a tool with no params has nothing
 *     to describe).
 *
 * Filename / H1 cross-check is performed by `loadOverlayRegistry`, not
 * the parser — it lets `parseOverlayFile` be useful in pure unit tests.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ConfigurationError } from '../../errors.js';

/** Result of parsing one overlay file. Frozen. */
export interface ParsedOverlay {
  readonly tool: string;
  readonly description: string;
  readonly parameters: ReadonlyMap<string, string>;
  readonly source: string;
}

/** Read-only registry of all parsed overlays for a session. */
export interface OverlayRegistry {
  get(tool: string): ParsedOverlay | undefined;
  list(): readonly ParsedOverlay[];
}

/* ---------- Parser ---------- */

/**
 * Parse a single overlay markdown file. Returns a frozen
 * {@link ParsedOverlay}. Throws {@link ConfigurationError} for any
 * structural problem, naming `absPath` so the user sees which file is
 * malformed.
 */
export function parseOverlayFile(absPath: string, content: string): ParsedOverlay {
  const lines = content.split(/\r?\n/);

  // -------- Locate H1 ("# <tool>") --------
  let h1Index = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^#\s+\S/.test(line) && !line.startsWith('## ') && !line.startsWith('### ')) {
      h1Index = i;
      break;
    }
  }
  if (h1Index < 0) {
    throw new ConfigurationError('tool-prompt overlay', [absPath], {
      detail: 'Missing H1 "# <tool-name>" heading at the top of the file.',
    });
  }
  const h1Match = (lines[h1Index] ?? '').match(/^#\s+(\S.*?)\s*$/);
  if (!h1Match) {
    throw new ConfigurationError('tool-prompt overlay', [absPath], {
      detail: 'Malformed H1 line. Expected: "# <tool-name>".',
    });
  }
  const tool = (h1Match[1] ?? '').trim();
  if (tool.length === 0) {
    throw new ConfigurationError('tool-prompt overlay', [absPath], {
      detail: 'H1 heading is empty.',
    });
  }

  // -------- Walk H2 sections after the H1 --------
  type Section = { name: string; bodyStart: number; bodyEnd: number };
  const sections: Section[] = [];
  let pending: Section | null = null;
  for (let i = h1Index + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = line.match(/^##\s+(\S.*?)\s*$/);
    if (m && !line.startsWith('### ')) {
      if (pending) {
        pending.bodyEnd = i;
        sections.push(pending);
      }
      pending = { name: (m[1] ?? '').trim(), bodyStart: i + 1, bodyEnd: lines.length };
    }
  }
  if (pending) sections.push(pending);

  const descSection = sections.find((s) => s.name === 'Description');
  if (!descSection) {
    throw new ConfigurationError('tool-prompt overlay', [absPath], {
      detail: 'Missing "## Description" section.',
    });
  }
  const description = lines
    .slice(descSection.bodyStart, descSection.bodyEnd)
    .join('\n')
    .replace(/\s+$/g, '')
    .replace(/^\s*\n/, '')
    .trimEnd();
  if (description.trim().length === 0) {
    throw new ConfigurationError('tool-prompt overlay', [absPath], {
      detail: '"## Description" body is empty.',
    });
  }

  // -------- Parameters section (optional) --------
  const parameters = new Map<string, string>();
  const paramsSection = sections.find((s) => s.name === 'Parameters');
  if (paramsSection) {
    type ParamHit = { name: string; bodyStart: number; bodyEnd: number };
    const paramHits: ParamHit[] = [];
    let pendingP: ParamHit | null = null;
    for (let i = paramsSection.bodyStart; i < paramsSection.bodyEnd; i++) {
      const line = lines[i] ?? '';
      const m = line.match(/^###\s+(\S.*?)\s*$/);
      if (m) {
        if (pendingP) {
          pendingP.bodyEnd = i;
          paramHits.push(pendingP);
        }
        pendingP = {
          name: (m[1] ?? '').trim(),
          bodyStart: i + 1,
          bodyEnd: paramsSection.bodyEnd,
        };
      }
    }
    if (pendingP) paramHits.push(pendingP);

    for (const ph of paramHits) {
      if (parameters.has(ph.name)) {
        throw new ConfigurationError('tool-prompt overlay', [absPath], {
          detail: `Duplicate parameter heading "### ${ph.name}".`,
        });
      }
      const body = lines
        .slice(ph.bodyStart, ph.bodyEnd)
        .join('\n')
        .replace(/\s+$/g, '')
        .replace(/^\s*\n/, '')
        .trimEnd();
      parameters.set(ph.name, body);
    }
  }

  return Object.freeze({
    tool,
    description,
    parameters: parameters as ReadonlyMap<string, string>,
    source: absPath,
  });
}

/* ---------- Serializer ---------- */

/**
 * Render a built-in entry as the canonical overlay-file markdown the
 * bootstrap and `extract-tool-prompts` commands write. The output is
 * deliberately round-trippable through `parseOverlayFile`.
 */
export function serializeOverlay(
  toolName: string,
  builtin: { description: string; parameters: { readonly [param: string]: string } },
): string {
  const out: string[] = [];
  out.push(`# ${toolName}`);
  out.push('');
  out.push('## Description');
  out.push('');
  out.push(builtin.description);
  out.push('');
  const paramNames = Object.keys(builtin.parameters);
  if (paramNames.length > 0) {
    out.push('## Parameters');
    out.push('');
    for (const name of paramNames) {
      out.push(`### ${name}`);
      out.push('');
      out.push(builtin.parameters[name] ?? '');
      out.push('');
    }
  }
  // Trailing newline for POSIX file conventions.
  return out.join('\n').replace(/\n+$/g, '\n');
}

/* ---------- Loader ---------- */

class OverlayRegistryImpl implements OverlayRegistry {
  private readonly byTool: ReadonlyMap<string, ParsedOverlay>;

  public constructor(entries: ReadonlyArray<ParsedOverlay>) {
    const map = new Map<string, ParsedOverlay>();
    for (const e of entries) map.set(e.tool, e);
    this.byTool = map;
  }

  public get(tool: string): ParsedOverlay | undefined {
    return this.byTool.get(tool);
  }

  public list(): readonly ParsedOverlay[] {
    return Array.from(this.byTool.values());
  }
}

const EMPTY_REGISTRY = new OverlayRegistryImpl([]);

/**
 * Read every `*.md` file in `toolPromptsDir`, parse each, validate that
 * the filename (sans `.md`) matches the H1, and return an
 * {@link OverlayRegistry}. Missing directory → empty registry (the
 * documented "no overlays" state — NOT a fallback).
 */
export async function loadOverlayRegistry(
  toolPromptsDir: string,
): Promise<OverlayRegistry> {
  let entries: string[];
  try {
    entries = await fsp.readdir(toolPromptsDir);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return EMPTY_REGISTRY;
    throw e;
  }
  const parsed: ParsedOverlay[] = [];
  for (const name of entries.sort()) {
    if (!name.endsWith('.md')) continue;
    const abs = path.join(toolPromptsDir, name);
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(abs);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    const content = await fsp.readFile(abs, 'utf8');
    const overlay = parseOverlayFile(abs, content);
    const expected = name.slice(0, -3); // strip `.md`
    if (overlay.tool !== expected) {
      throw new ConfigurationError('tool-prompt overlay', [abs], {
        detail:
          `Filename "${name}" does not match H1 "${overlay.tool}". ` +
          `Either rename the file to "${overlay.tool}.md" or update the H1 to "# ${expected}".`,
      });
    }
    parsed.push(overlay);
  }
  return new OverlayRegistryImpl(parsed);
}

/* ---------- Effective-value helpers ---------- */

/**
 * Resolve the effective tool description through the overlay layer.
 * Returns the overlay's value if present, otherwise the built-in
 * `fallback`. The `fallback` argument is the BUILT-IN DEFAULT, not a
 * runtime fallback for missing required config.
 */
export function getToolDescription(
  reg: OverlayRegistry | undefined | null,
  tool: string,
  fallback: string,
): string {
  if (!reg) return fallback;
  const o = reg.get(tool);
  if (!o) return fallback;
  return o.description;
}

/**
 * Resolve the effective parameter description through the overlay
 * layer. Returns the overlay's value if present, otherwise the
 * built-in `fallback`. The `fallback` argument is the BUILT-IN
 * DEFAULT, not a runtime fallback for missing required config.
 */
export function getParamDescription(
  reg: OverlayRegistry | undefined | null,
  tool: string,
  param: string,
  fallback: string,
): string {
  if (!reg) return fallback;
  const o = reg.get(tool);
  if (!o) return fallback;
  const v = o.parameters.get(param);
  if (v === undefined || v.length === 0) return fallback;
  return v;
}
