/**
 * Invoke <tool> [subcommand] --help and return the raw text output.
 * Uses the bash exec module (no shell string) with hardened env.
 */

import { spawnCommand } from '../tools/bash/exec.js';

const HELP_ENV: Record<string, string> = {
  PAGER: 'cat',
  MANPAGER: 'cat',
  GIT_PAGER: 'cat',
  NO_COLOR: '1',
  TERM: 'dumb',
};

export interface RunHelpResult {
  text: string;
  exitCode: number;
  durationMs: number;
  _truncated: boolean;
}

export async function runHelp(
  binary: string,
  subcommand: string | null,
  timeoutMs: number,
  maxBytes: number,
): Promise<RunHelpResult> {
  const args = subcommand
    ? [subcommand, '--help']
    : ['--help'];

  // Try --help first
  let result = await spawnCommand({
    command: binary,
    args,
    timeoutMs,
    maxOutputBytes: maxBytes,
    passEnv: ['PATH', 'HOME', 'LANG', 'TERM'],
    extraEnv: HELP_ENV,
  });

  // Fallback to -h
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    const argsH = subcommand ? [subcommand, '-h'] : ['-h'];
    result = await spawnCommand({
      command: binary,
      args: argsH,
      timeoutMs,
      maxOutputBytes: maxBytes,
      passEnv: ['PATH', 'HOME', 'LANG', 'TERM'],
      extraEnv: HELP_ENV,
    });
  }

  // Fallback to `<tool> help <sub>` form
  if (result.exitCode !== 0 && !result.stdout.trim() && subcommand) {
    result = await spawnCommand({
      command: binary,
      args: ['help', subcommand],
      timeoutMs,
      maxOutputBytes: maxBytes,
      passEnv: ['PATH', 'HOME', 'LANG', 'TERM'],
      extraEnv: HELP_ENV,
    });
  }

  // Combine stdout and stderr (many CLIs print help to stderr)
  const combined = (result.stdout + '\n' + result.stderr).trim();
  return {
    text: combined,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    _truncated: result._truncated ?? false,
  };
}
