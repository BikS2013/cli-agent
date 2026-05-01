/**
 * `audit-tool-prompts` subcommand.
 *
 * Cross-checks every overlay file under the resolved `toolPromptsDir`
 * against the canonical `BUILTIN_TOOL_PROMPTS` registry. Reports:
 *   - `unknown tool` for overlays whose H1 names a tool no longer in
 *     the registry (e.g. removed in a release);
 *   - `stale parameter` for overlays containing a `### <param>` not
 *     present in the current schema;
 *   - `missing parameter` for built-in parameters not represented in
 *     the overlay (the overlay is incomplete);
 *   - `info` for built-in tools with no overlay file at all.
 *
 * `--strict`: exit with status 1 when any warning was emitted (CI gate).
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { agentToolAgentsDir } from '../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../agent/tools/tool-prompts-builtin.js';
import { loadOverlayRegistry } from '../agent/tools/tool-prompt-overlay.js';

export interface AuditToolPromptsOpts {
  readonly strict?: boolean;
  readonly configFile?: string;
  readonly envFile?: string;
}

async function resolveToolPromptsDir(configFile: string | undefined): Promise<string> {
  const agentDir = agentToolAgentsDir();
  const cfgPath = configFile ?? path.join(agentDir, 'config.json');
  let toolPromptsDir = path.join(agentDir, 'tool-prompts');
  try {
    const raw = await fsp.readFile(cfgPath, 'utf8');
    const parsed = JSON.parse(raw) as { toolPromptsDir?: string };
    if (parsed.toolPromptsDir) {
      const v = parsed.toolPromptsDir;
      if (path.isAbsolute(v)) toolPromptsDir = v;
      else if (!v.includes('/') && !v.includes('\\')) toolPromptsDir = path.join(agentDir, v);
      else toolPromptsDir = path.resolve(process.cwd(), v);
    }
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
  return toolPromptsDir;
}

type Severity = 'warn' | 'info';
interface Finding {
  readonly severity: Severity;
  readonly tool: string;
  readonly category: string;
  readonly detail: string;
}

export async function runAuditToolPrompts(opts: AuditToolPromptsOpts): Promise<void> {
  const toolPromptsDir = await resolveToolPromptsDir(opts.configFile);
  const overlays = await loadOverlayRegistry(toolPromptsDir);
  const overlayList = overlays.list();
  const overlayByTool = new Map<string, ReturnType<typeof overlays.get>>();
  for (const o of overlayList) overlayByTool.set(o.tool, o);

  const findings: Finding[] = [];

  // 1. Overlays present but tool unknown / stale parameters.
  for (const overlay of overlayList) {
    const builtin = BUILTIN_TOOL_PROMPTS[overlay.tool];
    if (!builtin) {
      findings.push({
        severity: 'warn',
        tool: overlay.tool,
        category: 'unknown tool',
        detail: `Overlay file ${overlay.source} names a tool not in the current registry.`,
      });
      continue;
    }
    for (const paramName of overlay.parameters.keys()) {
      if (!(paramName in builtin.parameters)) {
        findings.push({
          severity: 'warn',
          tool: overlay.tool,
          category: 'stale parameter',
          detail: `Parameter "${paramName}" is in the overlay but not in the current schema.`,
        });
      }
    }
  }

  // 2. Overlays present but missing built-in parameters.
  for (const [toolName, builtin] of Object.entries(BUILTIN_TOOL_PROMPTS)) {
    const overlay = overlayByTool.get(toolName);
    if (!overlay) {
      findings.push({
        severity: 'info',
        tool: toolName,
        category: 'no overlay',
        detail: 'No overlay file present; using built-in defaults.',
      });
      continue;
    }
    for (const paramName of Object.keys(builtin.parameters)) {
      if (!overlay.parameters.has(paramName)) {
        findings.push({
          severity: 'warn',
          tool: toolName,
          category: 'missing parameter',
          detail: `Built-in parameter "${paramName}" has no entry in the overlay.`,
        });
      }
    }
  }

  // Render summary to stderr.
  const warns = findings.filter((f) => f.severity === 'warn');
  const infos = findings.filter((f) => f.severity === 'info');
  const toolWidth = Math.max(
    ...findings.map((f) => f.tool.length),
    'Tool'.length,
  );
  const sevWidth = 5;
  const catWidth = Math.max(
    ...findings.map((f) => f.category.length),
    'Category'.length,
  );
  process.stderr.write(
    `${'Tool'.padEnd(toolWidth)}  ${'Sev'.padEnd(sevWidth)}  ${'Category'.padEnd(catWidth)}  Detail\n`,
  );
  process.stderr.write(
    `${'-'.repeat(toolWidth)}  ${'-'.repeat(sevWidth)}  ${'-'.repeat(catWidth)}  ------\n`,
  );
  for (const f of findings) {
    process.stderr.write(
      `${f.tool.padEnd(toolWidth)}  ${f.severity.padEnd(sevWidth)}  ${f.category.padEnd(catWidth)}  ${f.detail}\n`,
    );
  }
  process.stderr.write(
    `\nSummary: ${warns.length} warning(s), ${infos.length} info note(s).\n` +
    `Directory: ${toolPromptsDir}\n`,
  );

  if (opts.strict && warns.length > 0) {
    process.exit(1);
  }
}
