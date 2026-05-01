/**
 * `show-tool-prompt` subcommand.
 *
 * Prints the EFFECTIVE (overlay-merged) description and per-parameter
 * help text for a named tool. The output is rendered in the same
 * markdown format as the on-disk overlay file, so the user can see
 * exactly what string the LLM will receive at `bindTools` time.
 *
 * Useful for verifying that an edit to `<toolPromptsDir>/<name>.md`
 * is taking effect without launching the agent.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { agentToolAgentsDir } from '../config/agent-config.js';
import { BUILTIN_TOOL_PROMPTS } from '../agent/tools/tool-prompts-builtin.js';
import {
  getToolDescription,
  getParamDescription,
  loadOverlayRegistry,
  serializeOverlay,
} from '../agent/tools/tool-prompt-overlay.js';
import { UsageError } from '../errors.js';

export interface ShowToolPromptOpts {
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

export async function runShowToolPrompt(
  toolName: string | undefined,
  opts: ShowToolPromptOpts,
): Promise<void> {
  if (!toolName || toolName.length === 0) {
    throw new UsageError('--tool <name> is required for show-tool-prompt.');
  }
  const builtin = BUILTIN_TOOL_PROMPTS[toolName];
  if (!builtin) {
    const known = Object.keys(BUILTIN_TOOL_PROMPTS).sort().join(', ');
    throw new UsageError(
      `Unknown tool '${toolName}'. Known built-in tools: ${known}.`,
      { tool: toolName },
    );
  }

  const toolPromptsDir = await resolveToolPromptsDir(opts.configFile);
  const reg = await loadOverlayRegistry(toolPromptsDir);

  // Compute the effective values via the same helpers the tool factories
  // use, so the rendered markdown matches what `bindTools` sees.
  const effectiveDescription = getToolDescription(reg, toolName, builtin.description);
  const effectiveParameters: { [param: string]: string } = {};
  for (const param of Object.keys(builtin.parameters)) {
    effectiveParameters[param] = getParamDescription(
      reg,
      toolName,
      param,
      builtin.parameters[param]!,
    );
  }

  const rendered = serializeOverlay(toolName, {
    description: effectiveDescription,
    parameters: effectiveParameters,
  });
  process.stdout.write(rendered);
}
