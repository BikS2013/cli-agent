/**
 * Bridge from cli-agent's existing permission model (`AgentConfig.bashAllow`,
 * `AgentConfig.allowMutations`, `AgentConfig.fileEdit.root`,
 * `AgentConfig.bash.passEnv`) to the vendored agent-tools
 * {@link PermissionPolicy} interface.
 *
 * Why a bridge?
 *   The vendored library exposes a single `PermissionPolicy` interface that
 *   gates `bash` and fs-write operations (no fs-read gate — the upstream
 *   trusts the caller's `cwd` jail for reads). cli-agent already has its
 *   own allowlist + sandbox machinery; the bridge maps the cli-agent rules
 *   onto the upstream surface so that vendored tools enforce identical
 *   behaviour to the native cli-agent tools.
 *
 * Divergences from the original design doc (§10.D):
 *   - The doc assumed method names `checkBash` / `checkFsRead` /
 *     `checkFsWrite` / `scrubEnv` returning Promises. The pinned upstream
 *     SHA actually exposes synchronous `evaluateBash` / `evaluateFsWrite`
 *     and treats `scrubEnv` as a standalone module-level helper, NOT a
 *     policy method. There is also NO read gate at all. This bridge
 *     conforms to the real upstream interface.
 *   - The doc's `scrubEnv(env)` policy method is therefore not part of the
 *     returned policy object. Wrappers that need scrubbing import the
 *     standalone `scrubEnv` helper from
 *     `agent-tools-vendored/upstream/src/permissions.js` directly, OR
 *     consume the `scrubEnv` re-export from this module which respects
 *     `cfg.bash.passEnv`.
 *
 * Strict configuration rule:
 *   `cliAgentPermissionPolicy(cfg)` throws {@link ConfigurationError} when
 *   `cfg` itself is missing or when one of the consumed fields is absent
 *   (`cfg.bash`, `cfg.fileEdit.root`). It does NOT throw when
 *   `cfg.bashAllow` is empty — an empty (unconfigured) allowlist is a
 *   meaningful state that makes bash UNRESTRICTED: every command is allowed
 *   (fail-open by explicit user decision, 2026-07-04; formerly fail-closed). Likewise
 *   `cfg.allowMutations` defaults to `false` at the config-loader level
 *   (U4); the bridge reads whatever the loader resolved.
 *
 * Pure factory: returns a fresh object on every call; no module-level
 * mutable state is captured. The returned policy holds an immutable
 * snapshot of the allowlist / root so concurrent calls remain consistent
 * even if the caller later mutates `cfg` (which they MUST NOT — the
 * bridge is read-only over `cfg`).
 */

import path from 'node:path';
import fs from 'node:fs';

import type { AgentConfig } from '../../../config/agent-config.js';
import { ConfigurationError } from '../../../errors.js';
import {
  parseAllowlistEntries,
  buildAllowlistMatcher,
} from '../bash/allowlist.js';
import type {
  BashCommandRequest,
  FsWriteRequest,
  PermissionDecision,
  PermissionPolicy,
} from '../agent-tools-vendored/upstream/src/types.js';
import {
  scrubEnv as upstreamScrubEnv,
} from '../agent-tools-vendored/upstream/src/permissions.js';

/** Stable id baked into every policy returned by this bridge. */
export const CLI_AGENT_POLICY_ID = 'cli-agent';

/**
 * Build a {@link PermissionPolicy} that delegates every decision back into
 * cli-agent's existing rules.
 *
 * @throws {ConfigurationError} when `cfg` is missing or one of the
 *   consumed fields (`bash`, `fileEdit.root`) is undefined. Empty
 *   `bashAllow` is NOT a configuration error — it is the intended way
 *   to fail-closed for bash.
 */
export function cliAgentPermissionPolicy(cfg: AgentConfig): PermissionPolicy {
  if (cfg === undefined || cfg === null) {
    throw new ConfigurationError('AgentConfig', [
      'cliAgentPermissionPolicy(cfg)',
    ]);
  }
  if (!cfg.bash) {
    throw new ConfigurationError('cfg.bash', [
      'config.json bash',
      'env:BASH_ALLOWED_COMMANDS',
      'CLI --bash-allow',
    ]);
  }
  if (!cfg.fileEdit || typeof cfg.fileEdit.root !== 'string' || cfg.fileEdit.root.length === 0) {
    throw new ConfigurationError('cfg.fileEdit.root', [
      'config.json fileEdit.root',
      'env:FILE_EDIT_ROOT',
    ]);
  }

  // Snapshot inputs so later mutations of `cfg` cannot influence decisions.
  const allowlistEntries = parseAllowlistEntries([...cfg.bashAllow]);
  const matcher = buildAllowlistMatcher(allowlistEntries);
  const allowMutations = cfg.allowMutations === true;
  const fileRootResolved = path.resolve(cfg.fileEdit.root);
  const allowPathsResolved: ReadonlyArray<string> = (cfg.fileEdit.allowPaths ?? []).map(
    (p) => path.resolve(p),
  );

  return {
    id: CLI_AGENT_POLICY_ID,

    /**
     * Mirrors the bash gate in `bash/run-tool.ts`:
     *  1. Reject empty / whitespace-only commands.
     *  2. Tokenise on whitespace (the upstream passes a free-form
     *     command string; cli-agent's matcher takes (binary, args)).
     *  3. Delegate the (binary, args) tuple to cli-agent's allowlist
     *     matcher. An EMPTY (unconfigured) allowlist means UNRESTRICTED
     *     — matcher.test returns true for every command (fail-open by
     *     explicit user decision, 2026-07-04; formerly fail-closed).
     */
    evaluateBash(req: BashCommandRequest): PermissionDecision {
      const cmd = (req.command ?? '').trim();
      if (cmd.length === 0) {
        return { allow: false, reason: 'empty command' };
      }
      // Naive whitespace split mirrors the upstream's tokeniser for the
      // token[0] case; cli-agent's allowlist only inspects the binary
      // name (basename) and the joined argv when an `argv-regex:` entry
      // is present, so a deeper shell parse is unnecessary here.
      const tokens = cmd.split(/\s+/u).filter((t) => t.length > 0);
      const head = tokens[0];
      if (head === undefined) {
        return { allow: false, reason: 'empty command' };
      }
      const args = tokens.slice(1);

      // Unconfigured allowlist ⇒ unrestricted (matcher.test returns true
      // for every command); the explicit isEmpty() fail-closed branch was
      // removed 2026-07-04 by user decision.
      if (!matcher.test(head, args)) {
        const allowed = matcher.getBinaryNames();
        return {
          allow: false,
          reason: `command '${head}' is not on the cli-agent bash allowlist (allowed: ${allowed.join(', ') || '(none)'})`,
        };
      }
      return { allow: true };
    },

    /**
     * Mirrors the fs-write gate shared by the agt_file_* mutating wrappers
     * (`agt-file-write.ts`, `agt-file-edit.ts`, `agt-file-append.ts`) via
     * `file/sandbox.ts:resolveSandboxPath` (plan-012 re-homed these from the
     * former `file/{write,edit,append}-tool.ts` into the agt_ pack):
     *  1. Reject ALL writes when `cfg.allowMutations !== true`.
     *  2. Resolve the target with `realpath` when the file exists,
     *     otherwise resolve the parent (the create-new-file case);
     *     both branches re-anchor the result so symlink escapes are
     *     detected.
     *  3. Allow when the resolved path is inside `fileEdit.root` or
     *     any explicit `fileEdit.allowPaths` entry. Deny otherwise.
     */
    evaluateFsWrite(req: FsWriteRequest): PermissionDecision {
      if (!allowMutations) {
        return {
          allow: false,
          reason: 'mutations disabled (set --allow-mutations or AGENT_ALLOW_MUTATIONS=true)',
        };
      }
      const target = req.path;
      if (typeof target !== 'string' || target.length === 0) {
        return { allow: false, reason: 'fs write request missing path' };
      }

      const absolute = path.isAbsolute(target)
        ? target
        : path.resolve(req.cwd ?? fileRootResolved, target);

      const resolved = resolveRealPathLenient(absolute);

      if (isUnderRoot(resolved, fileRootResolved)) {
        return { allow: true };
      }
      for (const allow of allowPathsResolved) {
        if (isUnderRoot(resolved, allow)) {
          return { allow: true };
        }
      }
      return {
        allow: false,
        reason: `path '${resolved}' is outside fileEdit.root '${fileRootResolved}' and configured allowPaths`,
      };
    },
  };
}

/**
 * Standalone env-scrubbing helper that respects `cfg.bash.passEnv`. Wrappers
 * that spawn child processes can call this when they want to apply the same
 * env-stripping cli-agent's native bash tool already applies. It delegates to
 * the vendored {@link upstreamScrubEnv} helper using the cli-agent allowlist.
 *
 * Kept out of the {@link PermissionPolicy} object because the upstream
 * interface does not declare a `scrubEnv` member — see file header
 * "Divergences from the original design doc".
 */
export function scrubEnv(
  cfg: AgentConfig,
  input?: NodeJS.ProcessEnv,
): Record<string, string> {
  if (!cfg || !cfg.bash) {
    throw new ConfigurationError('cfg.bash.passEnv', [
      'cliAgentPermissionPolicy.scrubEnv(cfg, env)',
    ]);
  }
  return upstreamScrubEnv(input, [...cfg.bash.passEnv]);
}

// ---------------------------------------------------------------------------
// internal helpers
// ---------------------------------------------------------------------------

/**
 * Real-path resolver that gracefully handles non-existent paths (the
 * "create new file" case). Mirrors the upstream's `resolveRealPath` so
 * the bridge produces the same canonicalisation upstream callers expect.
 */
function resolveRealPathLenient(p: string): string {
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
 * True when `target` is equal to or nested under `root`. Detects "escape"
 * via `path.relative` returning a `..`-prefixed path. Identical semantics
 * to the upstream `isUnderAnyRoot` (single-root variant).
 */
function isUnderRoot(target: string, root: string): boolean {
  const t = path.resolve(target);
  const r = path.resolve(root);
  if (t === r) return true;
  const rel = path.relative(r, t);
  return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
}
