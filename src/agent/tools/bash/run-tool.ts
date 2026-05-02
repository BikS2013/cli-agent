import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import path from 'node:path';
import fs from 'node:fs';
import { spawnCommand } from './exec.js';
import { BashError, handleToolError } from '../../../errors.js';
import type { AgentConfig } from '../../../config/agent-config.js';
import { parseAllowlistEntries, buildAllowlistMatcher } from './allowlist.js';
import type { Logger } from '../../logging.js';
import { newTurnId } from '../../logging.js';
import { BUILTIN_TOOL_PROMPTS } from '../tool-prompts-builtin.js';
import { getToolDescription, getParamDescription } from '../tool-prompt-overlay.js';
import { mergeProfileToolArgs, type ProfileToolArgsConfigurable } from '../profile-tool-args.js';

const TOOL_NAME = 'bash_run';
const BUILTIN = BUILTIN_TOOL_PROMPTS[TOOL_NAME]!;

export function createBashRunTool(cfg: AgentConfig, logger: Logger, allowMutations: boolean): DynamicStructuredTool {
  const entries = parseAllowlistEntries([...cfg.bash.allow]);
  const matcher = buildAllowlistMatcher(entries);

  // bash_run has a dynamic description that swaps prefix on
  // `allowMutations`. The overlay-or-default helper consults the overlay
  // FIRST; only when no overlay is present do we compose the dynamic
  // prefix from the built-in default (which uses the [MUTATING] form
  // canonically and then we swap when needed). This keeps user overlays
  // authoritative — they can author a single description that ignores
  // the read-only/mutating distinction if they prefer.
  const descPrefix = allowMutations
    ? '[MUTATING]'
    : '[READ-ONLY-AGENT]';
  const dynamicDefault = `${descPrefix} Execute an allow-listed local command and capture its stdout/stderr. ` +
    (allowMutations
      ? 'Requires confirmed: true. Only binaries on the allowlist may be called.'
      : 'Requires confirmed: true. The user has not enabled --allow-mutations; prefer read-only commands. Only allow-listed binaries may be called.');
  const reg = cfg.toolPromptOverlays;
  const description = getToolDescription(reg, TOOL_NAME, dynamicDefault);
  const schema = z.object({
    command: z.string().min(1).describe(
      getParamDescription(reg, TOOL_NAME, 'command', BUILTIN.parameters['command']!),
    ),
    args: z.array(z.string()).optional().describe(
      getParamDescription(reg, TOOL_NAME, 'args', BUILTIN.parameters['args']!),
    ),
    timeout_ms: z.number().int().positive().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'timeout_ms', BUILTIN.parameters['timeout_ms']!),
    ),
    cwd: z.string().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'cwd', BUILTIN.parameters['cwd']!),
    ),
    stdin: z.string().optional().describe(
      getParamDescription(reg, TOOL_NAME, 'stdin', BUILTIN.parameters['stdin']!),
    ),
    confirmed: z.boolean().describe(
      getParamDescription(reg, TOOL_NAME, 'confirmed', BUILTIN.parameters['confirmed']!),
    ),
  });

  const allowedRoots = cfg.bash.allowedRoots.length > 0
    ? cfg.bash.allowedRoots.map((r) => path.resolve(r))
    : [path.resolve(process.cwd())];

  return new DynamicStructuredTool({
    name: TOOL_NAME,
    description,
    schema,
    func: async (rawInput, _runManager, runConfig) => {
      const input = mergeProfileToolArgs(
        rawInput,
        runConfig?.configurable as ProfileToolArgsConfigurable | undefined,
        TOOL_NAME,
      );
      try {
        if (!input.confirmed) {
          return JSON.stringify({
            requires_confirmation: true,
            operation: 'bash_run',
            command: input.command,
            args: input.args ?? [],
            message: 'Set confirmed: true to execute this command.',
          });
        }

        const args = input.args ?? [];

        // Allowlist check
        if (!matcher.test(input.command, args)) {
          throw new BashError(
            'E_BASH_COMMAND_NOT_ALLOWED',
            `Command '${input.command}' is not on the allowlist. Allowed binaries: ${matcher.getBinaryNames().join(', ') || '(none)'}`,
            { command: input.command, allowedBinaries: matcher.getBinaryNames() },
          );
        }

        // CWD sandbox check
        const resolvedCwd = input.cwd ? path.resolve(input.cwd) : path.resolve(process.cwd());
        let cwdAllowed = false;
        for (const root of allowedRoots) {
          if (resolvedCwd === root || resolvedCwd.startsWith(root + path.sep)) {
            cwdAllowed = true;
            break;
          }
        }
        if (!cwdAllowed) {
          throw new BashError(
            'E_BASH_CWD_OUTSIDE_ROOT',
            `Working directory '${resolvedCwd}' is outside the allowed roots.`,
            { cwd: resolvedCwd, allowedRoots },
          );
        }

        // Resolve binary against PATH (not cwd)
        const resolvedBinary = resolveBinary(input.command);
        if (!resolvedBinary) {
          throw new BashError(
            'E_BASH_BINARY_NOT_FOUND',
            `Binary '${input.command}' not found on PATH.`,
            { command: input.command },
          );
        }

        const turnId = newTurnId();

        logger.log({
          kind: 'cli_invoke',
          ts: new Date().toISOString(),
          sessionId: logger.currentSessionId,
          turnId,
          binary: resolvedBinary,
          argv: [input.command, ...args],
          cwd: resolvedCwd,
        });

        const result = await spawnCommand({
          command: resolvedBinary,
          args,
          cwd: resolvedCwd,
          stdin: input.stdin,
          timeoutMs: input.timeout_ms ?? cfg.bash.timeoutMs,
          maxOutputBytes: cfg.bash.maxOutputBytes,
          passEnv: [...cfg.bash.passEnv],
          passSecrets: cfg.bashPassSecrets.length > 0 ? [...cfg.bashPassSecrets] : undefined,
        });

        logger.log({
          kind: 'cli_result',
          ts: new Date().toISOString(),
          sessionId: logger.currentSessionId,
          turnId,
          binary: resolvedBinary,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          stdoutPreview: result.stdout.slice(0, 4096),
          stderrPreview: result.stderr.slice(0, 4096),
        });

        // Truncate stdout/stderr for LLM context (per-tool budget)
        const llmResult = {
          command: input.command,
          args,
          stdout: result.stdout.slice(0, cfg.perToolBudgetBytes),
          stderr: result.stderr.slice(0, 2048),
          exitCode: result.exitCode,
          durationMs: result.durationMs,
          ...(result._truncated ? { _truncated: true } : {}),
        };

        return JSON.stringify(llmResult);
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}

function resolveBinary(name: string): string | null {
  if (path.isAbsolute(name)) {
    try {
      fs.accessSync(name, fs.constants.X_OK);
      return name;
    } catch {
      return null;
    }
  }

  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* try next */ }
  }
  return null;
}
