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

const schema = z.object({
  command: z.string().min(1).describe('Binary name to execute (must be on the allowlist).'),
  args: z.array(z.string()).optional().describe('Arguments to pass to the binary.'),
  timeout_ms: z.number().int().positive().optional().describe('Per-call timeout in milliseconds (max 300000).'),
  cwd: z.string().optional().describe('Working directory for the command.'),
  stdin: z.string().optional().describe('Static stdin string passed to the process.'),
  confirmed: z.boolean().describe('Must be true to execute the command.'),
});

export function createBashRunTool(cfg: AgentConfig, logger: Logger, allowMutations: boolean): DynamicStructuredTool {
  const entries = parseAllowlistEntries([...cfg.bash.allow]);
  const matcher = buildAllowlistMatcher(entries);

  const descPrefix = allowMutations
    ? '[MUTATING]'
    : '[READ-ONLY-AGENT]';
  const description = `${descPrefix} Execute an allow-listed local command and capture its stdout/stderr. ` +
    (allowMutations
      ? 'Requires confirmed: true. Only binaries on the allowlist may be called.'
      : 'Requires confirmed: true. The user has not enabled --allow-mutations; prefer read-only commands. Only allow-listed binaries may be called.');

  const allowedRoots = cfg.bash.allowedRoots.length > 0
    ? cfg.bash.allowedRoots.map((r) => path.resolve(r))
    : [path.resolve(process.cwd())];

  return new DynamicStructuredTool({
    name: 'bash_run',
    description,
    schema,
    func: async (input) => {
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
