/**
 * `composite-delete <name>` (alias `composite-rm`) — remove every
 * artifact a composite owns.
 *
 * Confirmation policy:
 *   - non-TTY (script / pipe): MUST pass `--yes`; otherwise refuse
 *     (ConfigurationError exit 3) so accidental scripted deletions are
 *     impossible. Mirrors `profile-delete`.
 *   - TTY: prompt `delete composite <name>? [y/N] ` unless `--yes`.
 *
 * Artifacts removed (idempotent — silently tolerates each absent):
 *   1. `<compositeCapabilitiesDir>/<id>.md`         (canonical schema-3 doc)
 *   2. `<capabilitiesDir>/<id>.md`                  (mirror copy / ADR-CMP-12)
 *   3. `<compositesDir>/<id>/<id>`                  (POSIX shim)
 *   4. `<compositesDir>/<id>/manifest.json`         (virtual-tool manifest)
 *   5. `<compositesDir>/<id>/`                      (folder, when empty after 3+4)
 *   6. `~/.local/bin/<id>`                          (symlink — ONLY when it
 *                                                    resolves to (3); never
 *                                                    delete a foreign file)
 *
 * Spec: plan-006 §14.E; FR-CMP-022; AC-22 / E-22.
 */

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {
  agentCapabilitiesDir,
  agentCompositeCapabilitiesDir,
  agentCompositesDir,
} from '../../config/agent-config.js';
import { ConfigurationError, UsageError } from '../../errors.js';
import {
  canonicalDocPathFor,
  compositeFolderFor,
  deleteCompositeDocs,
  isInteractive,
  manifestPathFor,
  mirrorDocPathFor,
  shimPathFor,
  validateCompositeName,
} from './shared.js';

export interface CompositeDeleteOpts {
  readonly yes?: boolean;
  /** Test seam — overrides the resolved per-composite folder root. */
  readonly compositesDirOverride?: string;
  /** Test seam — overrides the resolved composite-capabilities dir. */
  readonly compositeCapabilitiesDirOverride?: string;
  /** Test seam — overrides the resolved member capabilities dir. */
  readonly capabilitiesDirOverride?: string;
}

export interface CompositeDeleteDeps {
  /** Test seam: read user confirmation from a TTY. */
  readonly confirm?: (prompt: string) => Promise<boolean>;
  /** Test seam: report whether stdin/stdout are TTYs. */
  readonly isInteractive?: () => boolean;
}

export async function runCompositeDelete(
  name: string,
  opts: CompositeDeleteOpts = {},
  deps: CompositeDeleteDeps = {},
): Promise<void> {
  validateCompositeName(name);

  // Read-only resolution: deletion does NOT need an LLM provider.
  const compositeCapsDir =
    opts.compositeCapabilitiesDirOverride ?? agentCompositeCapabilitiesDir();
  const capsDir = opts.capabilitiesDirOverride ?? agentCapabilitiesDir();
  const composDir = opts.compositesDirOverride ?? agentCompositesDir();
  const docPath = canonicalDocPathFor(compositeCapsDir, name);
  const mirrorPath = mirrorDocPathFor(capsDir, name);
  const shimPath = shimPathFor(composDir, name);
  const manifestPath = manifestPathFor(composDir, name);
  const folderPath = compositeFolderFor(composDir, name);

  const interactive = (deps.isInteractive ?? isInteractive)();

  if (!opts.yes) {
    if (!interactive) {
      throw new ConfigurationError('composite-delete confirmation', [
        '--yes flag (required in non-interactive environments)',
      ], {
        detail:
          `Refusing to delete composite '${name}' without --yes in a non-interactive environment.`,
      });
    }
    const confirm = deps.confirm ?? defaultConfirm;
    const ok = await confirm(`delete composite '${name}'? [y/N] `);
    if (!ok) {
      process.stderr.write(`[cli-agent] aborted; composite '${name}' not deleted\n`);
      return;
    }
  }

  const removed: string[] = [];

  // 1+2. Canonical doc + mirror.
  const docRes = await deleteCompositeDocs({
    compositeDocPath: docPath,
    mirrorPath,
  });
  if (docRes.removedCanonical) removed.push(docPath);
  if (docRes.removedMirror) removed.push(mirrorPath);

  // 3. POSIX shim.
  if (await unlinkIfExists(shimPath)) removed.push(shimPath);

  // 4. Manifest.
  if (await unlinkIfExists(manifestPath)) removed.push(manifestPath);

  // 5. Composite folder (only if now empty — preserves any .lock /
  // pending tmp files the user may have manually placed).
  try {
    const remaining = await fsp.readdir(folderPath);
    if (remaining.length === 0) {
      await fsp.rmdir(folderPath);
      removed.push(folderPath);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
  }

  // 6. PATH symlink — only when it points at our (now-removed) shim.
  // We do NOT chase user-installed symlinks under arbitrary dirs;
  // the canonical home is `~/.local/bin/<name>`.
  const symlinkPath = path.join(os.homedir(), '.local', 'bin', name);
  try {
    const lst = await fsp.lstat(symlinkPath);
    if (lst.isSymbolicLink()) {
      const target = await fsp.readlink(symlinkPath);
      const resolved = path.isAbsolute(target)
        ? target
        : path.resolve(path.dirname(symlinkPath), target);
      if (resolved === shimPath) {
        await fsp.unlink(symlinkPath);
        removed.push(symlinkPath);
      }
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      // Non-fatal: surface but do not block deletion of the rest.
      process.stderr.write(
        `[cli-agent] warning: could not inspect ${symlinkPath}: ${(e as Error).message}\n`,
      );
    }
  }

  if (removed.length === 0) {
    throw new UsageError(
      `composite '${name}' has no artifacts on disk; nothing to delete`,
      { compositeName: name },
    );
  }

  process.stdout.write(`Deleted composite '${name}':\n`);
  for (const p of removed) process.stdout.write(`  ${p}\n`);
}

async function unlinkIfExists(p: string): Promise<boolean> {
  try {
    await fsp.unlink(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
}

function defaultConfirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      const v = answer.trim().toLowerCase();
      resolve(v === 'y' || v === 'yes');
    });
  });
}
