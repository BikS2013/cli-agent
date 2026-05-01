/**
 * PermissionPolicy implementations and helpers.
 *
 * SECURITY NOTICE
 * ---------------
 * The strict policy implemented here is a TRIAGE LAYER, not a sandbox.
 * It raises the bar for accidental misuse and obvious prompt injection
 * but cannot prevent every attack because it operates on command
 * strings, not on an OS-level process boundary. For real isolation
 * use Docker, firejail, bubblewrap, or a microVM. See the README
 * "Sandboxing" section for the recommended host configuration.
 *
 * The policy interface itself lives in `src/types.ts` so that
 * `ToolContext` can reference it without a circular import. This file
 * supplies the two built-in evaluators plus the `scrubEnv` helper used
 * by the `bash` tool when a strict policy is active.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

import type {
  BashCommandRequest,
  FsWriteRequest,
  PermissionDecision,
  PermissionPolicy,
} from './types.js';

/** Allowlist used by {@link scrubEnv} when none is supplied. */
const DEFAULT_ENV_ALLOWLIST: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'USER',
  'SHELL',
  'TMPDIR',
];

/**
 * Returns a fresh env object containing only the keys in `allowlist`
 * whose value is a defined string.
 *
 * @param input     Source environment. Defaults to `process.env`.
 * @param allowlist Keys to keep. Defaults to PATH/HOME/LANG/TERM/USER/SHELL/TMPDIR.
 */
export function scrubEnv(
  input?: NodeJS.ProcessEnv,
  allowlist?: readonly string[],
): Record<string, string> {
  const src = input ?? process.env;
  const keys = allowlist ?? DEFAULT_ENV_ALLOWLIST;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = src[key];
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Permissive policy singleton.
 *
 * Allows every bash command and every fs write, but logs a single
 * `console.warn` on the first call to either evaluator so that the
 * presence of the permissive policy in production is visible.
 *
 * SECURITY NOTICE: this policy is for local development only. Do NOT
 * use it in production or with untrusted LLM input.
 */
export const permissivePolicy: PermissionPolicy = (() => {
  let warned = false;
  function warnOnce(): void {
    if (warned) return;
    warned = true;
    // eslint-disable-next-line no-console
    console.warn(
      '[agent-tools] permissivePolicy is in use: every bash command and ' +
        'fs write will be allowed. This is appropriate ONLY for local ' +
        'development against trusted prompts.',
    );
  }
  return {
    id: 'permissive',
    evaluateBash(_req: BashCommandRequest): PermissionDecision {
      warnOnce();
      return { allow: true };
    },
    evaluateFsWrite(_req: FsWriteRequest): PermissionDecision {
      warnOnce();
      return { allow: true };
    },
  };
})();

/** Configuration accepted by {@link createStrictPolicy}. */
export interface StrictPolicyOptions {
  /**
   * Bash commands beginning with these tokens are allowed. Comparison
   * happens after the command is tokenised by a whitespace-aware state
   * machine that respects single and double quotes. Multi-token
   * prefixes (e.g. `"git status"`) match across consecutive tokens.
   *
   * If omitted or empty the strict policy fails closed — every bash
   * command is denied.
   */
  readonly allowBashPrefixes?: readonly string[];
  /**
   * Filesystem write operations are allowed only inside these absolute
   * roots. Paths outside the roots — including symlinks that resolve
   * outside — are denied.
   */
  readonly allowedWriteRoots: readonly string[];
  /**
   * Optional explicit env passthrough used by `scrubEnv` callers that
   * route through this policy. When omitted the {@link scrubEnv}
   * default allowlist is used.
   */
  readonly envAllowlist?: readonly string[];
}

/**
 * Builds a strict deny-by-default {@link PermissionPolicy}.
 *
 * SECURITY NOTICE: this is a TRIAGE LAYER, not a sandbox. For real
 * isolation use Docker, firejail, or bubblewrap (see README
 * "Sandboxing").
 *
 * Bash rules (applied in order; first match wins):
 *   1. Reject empty / whitespace-only commands.
 *   2. Reject commands containing un-quoted shell operators
 *      (`&&`, `||`, `;`, `|`, backtick, `$(`, `>`, `<`, `>>`).
 *   3. Reject if no `allowBashPrefixes` were configured.
 *   4. Tokenise (whitespace outside quotes) and require token[0]
 *      to match an allowed prefix; multi-token prefixes (e.g.
 *      `"git status"`) match across consecutive tokens.
 *   5. Reject if any argument contains `..` segments OR begins with
 *      `/` and is outside `cwd` AND not in `allowedWriteRoots`.
 *
 * Fs-write rules:
 *   - Reject if the resolved path (`fs.realpathSync.native` when
 *     present, otherwise resolved via the parent) is not under any
 *     of `allowedWriteRoots`.
 */
export function createStrictPolicy(opts: StrictPolicyOptions): PermissionPolicy {
  if (!opts || !Array.isArray(opts.allowedWriteRoots)) {
    throw new Error(
      'createStrictPolicy: allowedWriteRoots is required and must be an array',
    );
  }
  const allowedRoots: readonly string[] = opts.allowedWriteRoots.map((r) =>
    path.resolve(r),
  );
  const allowedPrefixes: readonly string[] = opts.allowBashPrefixes ?? [];

  return {
    id: 'strict',

    evaluateBash(req: BashCommandRequest): PermissionDecision {
      const cmd = req.command ?? '';
      if (cmd.trim().length === 0) {
        return { allow: false, reason: 'empty command' };
      }

      // (2) chaining / redirection / substitution — quote-aware scan.
      const op = scanForUnquotedOperator(cmd);
      if (op !== null) {
        return {
          allow: false,
          reason: `disallowed shell operator: ${op}`,
        };
      }

      // (3) fail closed if no allowlist.
      if (allowedPrefixes.length === 0) {
        return {
          allow: false,
          reason: 'strict policy has no allowBashPrefixes configured (fail-closed)',
        };
      }

      // (4) tokenise and check prefix match.
      const tokens = tokeniseCommand(cmd);
      if (tokens.length === 0) {
        return { allow: false, reason: 'command tokenisation produced no tokens' };
      }
      if (!matchesAnyPrefix(tokens, allowedPrefixes)) {
        return {
          allow: false,
          reason: `command does not match any allowed prefix: ${tokens[0] ?? '<empty>'}`,
        };
      }

      // (5) per-argument absolute-path / `..` check.
      const cwdResolved = path.resolve(req.cwd);
      const writeRoots = allowedRoots;
      for (let i = 1; i < tokens.length; i++) {
        const arg = tokens[i];
        if (arg === undefined) continue;
        if (arg.includes('..')) {
          return {
            allow: false,
            reason: `argument contains '..' traversal: ${arg}`,
          };
        }
        if (arg.startsWith('/')) {
          const resolved = path.resolve(arg);
          if (
            !isUnderAnyRoot(resolved, [cwdResolved, ...writeRoots])
          ) {
            return {
              allow: false,
              reason: `absolute path outside cwd and allowedWriteRoots: ${arg}`,
            };
          }
        }
      }

      return { allow: true };
    },

    evaluateFsWrite(req: FsWriteRequest): PermissionDecision {
      const resolved = resolveRealPath(req.path);
      if (!isUnderAnyRoot(resolved, allowedRoots)) {
        return {
          allow: false,
          reason: `path outside allowedWriteRoots: ${resolved}`,
        };
      }
      return { allow: true };
    },
  };
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

/**
 * Walk the command string with single/double-quote state tracking and
 * return the first unquoted operator we recognise. Returns `null` when
 * the command is operator-free outside quotes.
 *
 * NOTE: a regex blocklist is the documented anti-pattern (CVE-2025-66032);
 * a state machine that skips quoted spans is the v1 mitigation. Real
 * AST parsing is deferred to v2 per L-13 of the plan.
 */
function scanForUnquotedOperator(cmd: string): string | null {
  let i = 0;
  let single = false;
  let double = false;
  while (i < cmd.length) {
    const ch = cmd[i] ?? '';
    if (single) {
      if (ch === "'") single = false;
      i++;
      continue;
    }
    if (double) {
      // Honour backslash escapes so `\"` doesn't close the span.
      if (ch === '\\' && i + 1 < cmd.length) {
        i += 2;
        continue;
      }
      if (ch === '"') double = false;
      i++;
      continue;
    }
    if (ch === "'") {
      single = true;
      i++;
      continue;
    }
    if (ch === '"') {
      double = true;
      i++;
      continue;
    }
    // Two-char operators first, then single chars.
    const two = cmd.slice(i, i + 2);
    if (two === '&&' || two === '||' || two === '$(' || two === '>>') {
      return two;
    }
    if (
      ch === ';' ||
      ch === '|' ||
      ch === '`' ||
      ch === '>' ||
      ch === '<'
    ) {
      return ch;
    }
    i++;
  }
  return null;
}

/**
 * Whitespace-split tokeniser that preserves single- and double-quoted
 * spans. Quotes themselves are stripped from the returned tokens.
 */
function tokeniseCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let single = false;
  let double = false;
  let i = 0;
  while (i < cmd.length) {
    const ch = cmd[i] ?? '';
    if (single) {
      if (ch === "'") {
        single = false;
      } else {
        cur += ch;
      }
      i++;
      continue;
    }
    if (double) {
      if (ch === '\\' && i + 1 < cmd.length) {
        cur += cmd[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (ch === '"') {
        double = false;
      } else {
        cur += ch;
      }
      i++;
      continue;
    }
    if (ch === "'") {
      single = true;
      i++;
      continue;
    }
    if (ch === '"') {
      double = true;
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n') {
      if (cur.length > 0) {
        out.push(cur);
        cur = '';
      }
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/**
 * Return true when `tokens` starts with any of the configured allowed
 * prefixes. A multi-token prefix (e.g. `"git status"`) is matched
 * across consecutive tokens.
 */
function matchesAnyPrefix(
  tokens: readonly string[],
  prefixes: readonly string[],
): boolean {
  for (const prefix of prefixes) {
    const parts = prefix.split(/\s+/).filter((p) => p.length > 0);
    if (parts.length === 0) continue;
    if (parts.length > tokens.length) continue;
    let ok = true;
    for (let j = 0; j < parts.length; j++) {
      if (tokens[j] !== parts[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Resolve `p` to a canonical absolute path, following symlinks when
 * possible. When the path does not exist we resolve the parent
 * directory's real path and rejoin the basename — this lets us still
 * detect escapes for "create" operations on a path that isn't there
 * yet.
 */
function resolveRealPath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    try {
      const parentReal = fs.realpathSync.native(parent);
      return path.join(parentReal, path.basename(abs));
    } catch {
      return abs;
    }
  }
}

/**
 * True when `target` is equal to or nested under any of `roots`.
 * Detects "escape" via `path.relative` returning a `..`-prefixed path.
 */
function isUnderAnyRoot(target: string, roots: readonly string[]): boolean {
  const t = path.resolve(target);
  for (const root of roots) {
    const r = path.resolve(root);
    if (t === r) return true;
    const rel = path.relative(r, t);
    if (
      rel.length > 0 &&
      !rel.startsWith('..') &&
      !path.isAbsolute(rel)
    ) {
      return true;
    }
  }
  return false;
}
