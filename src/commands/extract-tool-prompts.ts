/**
 * `extract-tool-prompts` subcommand.
 *
 * Walks the canonical {@link BUILTIN_TOOL_PROMPTS} registry and writes
 * one overlay markdown file per tool to the resolved `toolPromptsDir`
 * (typically `~/.tool-agents/cli-agent/tool-prompts/`). Idempotent —
 * existing files are skipped unless `--force` is passed. Reports a
 * 2-column table to stderr: tool name | status (written / skipped).
 *
 * Reuses `loadAgentConfig` so the directory respects the same
 * resolution chain as the runtime path (config.json override → default
 * `<agentDir>/tool-prompts/`). The four-tier env / CLI flag lifecycle
 * is preserved.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  agentToolAgentsDir,
  bootstrapAgentDir,
} from '../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../agent/tools/tool-prompts-builtin.js';
import { serializeOverlay } from '../agent/tools/tool-prompt-overlay.js';

export interface ExtractToolPromptsOpts {
  readonly force?: boolean;
  readonly configFile?: string;
  readonly envFile?: string;
}

/**
 * The extract command intentionally does NOT call `loadAgentConfig` —
 * it is a setup command that should run on a fresh install BEFORE
 * `provider` / `model` / `apiKey` config is in place. It still respects
 * the `--config <path>` override by reading config.json directly to
 * pick up any `toolPromptsDir` override; everything else is computed
 * from the canonical agent dir.
 */
export async function runExtractToolPrompts(opts: ExtractToolPromptsOpts): Promise<void> {
  const agentDir = agentToolAgentsDir();
  const cfgPath = opts.configFile ?? path.join(agentDir, 'config.json');
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
  // Bootstrap the agent dir + tool-prompts dir (idempotent — never
  // overwrites). The seeding stderr message from bootstrap will reflect
  // any newly added overlays from this version.
  await bootstrapAgentDir(agentDir, { toolPromptsDir });
  const dir = toolPromptsDir;
  const force = opts.force === true;

  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(dir, 0o700); } catch { /* tolerated on Windows */ }

  type Row = { tool: string; status: 'written' | 'skipped' };
  const rows: Row[] = [];

  for (const [toolName, builtin] of Object.entries(BUILTIN_TOOL_PROMPTS)) {
    const filePath = path.join(dir, `${toolName}.md`);
    let exists = false;
    try {
      await fsp.access(filePath, fs.constants.F_OK);
      exists = true;
    } catch { exists = false; }

    if (exists && !force) {
      rows.push({ tool: toolName, status: 'skipped' });
      continue;
    }

    const body = serializeOverlay(toolName, builtin);
    await fsp.writeFile(filePath, body, { mode: 0o600 });
    try { await fsp.chmod(filePath, 0o600); } catch { /* tolerated */ }
    rows.push({ tool: toolName, status: 'written' });
  }

  // 2-column table to stderr.
  const nameWidth = Math.max(...rows.map((r) => r.tool.length), 'Tool'.length);
  process.stderr.write(`${'Tool'.padEnd(nameWidth)}  Status\n`);
  process.stderr.write(`${'-'.repeat(nameWidth)}  -------\n`);
  for (const r of rows) {
    process.stderr.write(`${r.tool.padEnd(nameWidth)}  ${r.status}\n`);
  }
  const writtenCount = rows.filter((r) => r.status === 'written').length;
  process.stderr.write(
    `\nDirectory: ${dir}\n` +
    `${writtenCount} written, ${rows.length - writtenCount} skipped (use --force to overwrite).\n`,
  );
}
