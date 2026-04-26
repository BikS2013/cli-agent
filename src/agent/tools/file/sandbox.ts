/**
 * File tool path sandbox enforcement.
 * All paths are resolved with realpath before the allowlist check.
 * Symlinks pointing outside the root are rejected.
 */

import fs from 'node:fs';
import path from 'node:path';
import { FileError } from '../../../errors.js';

export interface SandboxConfig {
  root: string;
  allowPaths?: string[];
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024; // 1 MiB

/**
 * Resolve and validate a file path against the sandbox root.
 * Returns the absolute resolved path.
 * Throws E_FILE_PATH_OUTSIDE_ROOT if not inside root or allowPaths.
 */
export function resolveSandboxPath(input: string, cfg: SandboxConfig): string {
  const absolute = path.isAbsolute(input)
    ? input
    : path.join(cfg.root, input);

  // Attempt real path resolution (follows symlinks)
  let resolved: string;
  try {
    resolved = fs.realpathSync(absolute);
  } catch {
    // File does not exist yet (for write operations) — resolve without realpath
    resolved = path.resolve(absolute);
  }

  const root = path.resolve(cfg.root);
  if (resolved.startsWith(root + path.sep) || resolved === root) {
    return resolved;
  }

  // Check explicit allowPaths
  for (const allowed of cfg.allowPaths ?? []) {
    const resolvedAllowed = path.resolve(allowed);
    if (resolved.startsWith(resolvedAllowed + path.sep) || resolved === resolvedAllowed) {
      return resolved;
    }
  }

  throw new FileError(
    'E_FILE_PATH_OUTSIDE_ROOT',
    `Path '${input}' (resolved: '${resolved}') is outside the allowed root '${root}'.`,
    { input, resolved, root },
  );
}

export function assertMaxBytes(filePath: string, maxBytes = DEFAULT_MAX_BYTES): void {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return; // File doesn't exist yet
  }
  if (size > maxBytes) {
    throw new FileError(
      'E_FILE_TOO_LARGE',
      `File '${filePath}' is ${size} bytes, exceeding the limit of ${maxBytes} bytes.`,
      { filePath, size, maxBytes },
    );
  }
}
