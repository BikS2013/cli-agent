/**
 * Composite manifest reader/writer (plan-006 P6 / U-VIRTUAL).
 *
 * Each registered virtual composite owns a `manifest.json` file under
 * `<agentDir>/composites/<id>/manifest.json` (mode 0o600). The manifest
 * captures the artefacts the synthesis run produced and which
 * distribution forms (a/b/c) the user opted into so subsequent commands
 * (`composite-list`, `composite-show`, `composite-delete`) can introspect
 * without re-running synthesis.
 *
 * Race protection (ADR-CMP-13): manifest writes are atomic temp+rename
 * gated by an `O_EXCL`-acquired `<manifestPath>.lock` file. The race
 * window is reduced to the single `open()` syscall that creates the lock
 * file. Concurrent `composite synthesize` invocations on the same id
 * collide on the lock and the loser is told to retry — never producing
 * a torn manifest on disk.
 *
 * Public API:
 *   readManifest(path)              → CompositeManifest | null
 *   writeManifest(path, manifest, opts) → void
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { ConfigurationError, FileError } from '../../errors.js';
import type { CompositeManifest } from './types.js';

const MANIFEST_SCHEMA_VERSION = 1 as const;
const MANIFEST_FILE_MODE = 0o600;

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function isStringArray(v: unknown): v is readonly string[] {
  return Array.isArray(v) && v.every((e) => typeof e === 'string');
}

function isStringRecord(v: unknown): v is Readonly<Record<string, string>> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string')
  );
}

/**
 * Validate the parsed JSON object against the schema-1 `CompositeManifest`
 * shape and return a typed manifest. Throws `ConfigurationError` on any
 * mismatch with a precise message identifying the offending field.
 */
function validateManifest(raw: unknown, manifestPath: string): CompositeManifest {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigurationError('composite-manifest', [manifestPath], {
      reason: 'manifest is not a JSON object',
      manifestPath,
    });
  }
  const obj = raw as Record<string, unknown>;

  if (obj['schemaVersion'] !== MANIFEST_SCHEMA_VERSION) {
    throw new ConfigurationError('composite-manifest.schemaVersion', [manifestPath], {
      reason: `expected schemaVersion=${MANIFEST_SCHEMA_VERSION}; got ${String(obj['schemaVersion'])}`,
      manifestPath,
    });
  }
  if (typeof obj['compositeName'] !== 'string' || obj['compositeName'].length === 0) {
    throw new ConfigurationError('composite-manifest.compositeName', [manifestPath], {
      reason: 'missing or empty compositeName',
      manifestPath,
    });
  }
  if (!isStringArray(obj['members']) || obj['members'].length === 0) {
    throw new ConfigurationError('composite-manifest.members', [manifestPath], {
      reason: 'members must be a non-empty array of strings',
      manifestPath,
    });
  }
  if (!isStringRecord(obj['memberDigests'])) {
    throw new ConfigurationError('composite-manifest.memberDigests', [manifestPath], {
      reason: 'memberDigests must be a string-valued object',
      manifestPath,
    });
  }
  if (typeof obj['createdAt'] !== 'string' || obj['createdAt'].length === 0) {
    throw new ConfigurationError('composite-manifest.createdAt', [manifestPath], {
      reason: 'missing or empty createdAt',
      manifestPath,
    });
  }
  if (typeof obj['cliAgentVersion'] !== 'string' || obj['cliAgentVersion'].length === 0) {
    throw new ConfigurationError('composite-manifest.cliAgentVersion', [manifestPath], {
      reason: 'missing or empty cliAgentVersion',
      manifestPath,
    });
  }
  if (typeof obj['capabilityDocPath'] !== 'string' || !path.isAbsolute(obj['capabilityDocPath'])) {
    throw new ConfigurationError('composite-manifest.capabilityDocPath', [manifestPath], {
      reason: 'capabilityDocPath must be an absolute path',
      manifestPath,
    });
  }

  const dist = obj['distribution'];
  if (typeof dist !== 'object' || dist === null) {
    throw new ConfigurationError('composite-manifest.distribution', [manifestPath], {
      reason: 'distribution must be an object',
      manifestPath,
    });
  }
  const d = dist as Record<string, unknown>;
  for (const k of ['emitDoc', 'emitWrapper', 'emitWrapperOnPath', 'registerVirtual'] as const) {
    if (typeof d[k] !== 'boolean') {
      throw new ConfigurationError(`composite-manifest.distribution.${k}`, [manifestPath], {
        reason: `distribution.${k} must be boolean`,
        manifestPath,
      });
    }
  }

  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    compositeName: obj['compositeName'],
    members: Object.freeze([...obj['members']]),
    memberDigests: Object.freeze({ ...(obj['memberDigests'] as Record<string, string>) }),
    createdAt: obj['createdAt'],
    cliAgentVersion: obj['cliAgentVersion'],
    capabilityDocPath: obj['capabilityDocPath'],
    distribution: Object.freeze({
      emitDoc: d['emitDoc'] as boolean,
      emitWrapper: d['emitWrapper'] as boolean,
      emitWrapperOnPath: d['emitWrapperOnPath'] as boolean,
      registerVirtual: d['registerVirtual'] as boolean,
    }),
  };
}

/* ------------------------------------------------------------------ */
/* Sync helpers (used by the boot-time virtual-registry scan)          */
/* ------------------------------------------------------------------ */

/**
 * Synchronous variant of {@link readManifest} used by the boot-time
 * virtual-registry scan. Mirrors `readManifest` semantics: returns
 * `null` when the file is absent; throws `ConfigurationError` on
 * malformed JSON or schema mismatch.
 */
export function readManifestSync(manifestPath: string): CompositeManifest | null {
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new FileError(
      'E_FILE_PERMISSION',
      `readManifest: failed to read '${manifestPath}': ${(err as Error).message}`,
      { manifestPath },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigurationError('composite-manifest', [manifestPath], {
      reason: `manifest is not valid JSON: ${(err as Error).message}`,
      manifestPath,
    });
  }
  return validateManifest(parsed, manifestPath);
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Read and validate a composite manifest. Returns `null` if the
 * manifest file does not exist (the caller distinguishes "missing" from
 * "malformed"). Throws `ConfigurationError` on schema mismatch or
 * malformed JSON, `FileError` on I/O errors other than ENOENT.
 */
export async function readManifest(manifestPath: string): Promise<CompositeManifest | null> {
  let raw: string;
  try {
    raw = await fsp.readFile(manifestPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new FileError(
      'E_FILE_PERMISSION',
      `readManifest: failed to read '${manifestPath}': ${(err as Error).message}`,
      { manifestPath },
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new ConfigurationError('composite-manifest', [manifestPath], {
      reason: `manifest is not valid JSON: ${(err as Error).message}`,
      manifestPath,
    });
  }
  return validateManifest(parsed, manifestPath);
}

export interface WriteManifestOptions {
  /** When false (default), refuse to overwrite an existing manifest at
   * the same path with a different member set (FR-CMP-017). When true,
   * unconditionally replace. Idempotent re-write of the same content
   * succeeds in both modes. */
  readonly force: boolean;
}

/**
 * Write a composite manifest atomically with race protection.
 *
 * Sequence:
 *   1. Acquire `<manifestPath>.lock` via `open()` with `O_EXCL`. On
 *      `EEXIST` raise `FileError` (`E_FILE_PERMISSION`) with the
 *      "concurrent registration in progress; retry" message.
 *   2. Collision check (FR-CMP-017): if a manifest already exists and
 *      `opts.force === false`, refuse when the member set differs;
 *      idempotent succeed when bytes are identical.
 *   3. Write `<manifestPath>.tmp` with `JSON.stringify(manifest, null, 2)`
 *      and mode 0o600.
 *   4. `rename` to `manifestPath`.
 *   5. Always remove `.lock` in `finally`.
 *
 * Errors are wrapped in `FileError` (exit 6) for I/O failures and
 * `ConfigurationError` (exit 3) for collision-without-force.
 */
export async function writeManifest(
  manifestPath: string,
  manifest: CompositeManifest,
  opts: WriteManifestOptions = { force: false },
): Promise<void> {
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    throw new ConfigurationError('composite-manifest.schemaVersion', [manifestPath], {
      reason: `writeManifest only supports schemaVersion=${MANIFEST_SCHEMA_VERSION}`,
      manifestPath,
    });
  }

  // Ensure parent directory exists with the canonical 0o700 mode.
  const dir = path.dirname(manifestPath);
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new FileError(
      'E_FILE_PERMISSION',
      `writeManifest: failed to create directory '${dir}': ${(err as Error).message}`,
      { dir },
    );
  }

  // ---- 1. Acquire the lock ---------------------------------------
  const lockPath = `${manifestPath}.lock`;
  let lockFd: fsp.FileHandle | null = null;
  try {
    try {
      // O_EXCL ensures only one writer can hold the lock at a time.
      lockFd = await fsp.open(lockPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new FileError(
          'E_FILE_PERMISSION',
          `writeManifest: concurrent registration in progress; retry (lock file exists at '${lockPath}')`,
          { manifestPath, lockPath },
        );
      }
      throw new FileError(
        'E_FILE_PERMISSION',
        `writeManifest: failed to acquire lock at '${lockPath}': ${(err as Error).message}`,
        { manifestPath, lockPath },
      );
    }

    // ---- 2. Collision check (FR-CMP-017) -------------------------
    const existing = await readManifest(manifestPath);
    if (existing && !opts.force) {
      const sameMembers =
        existing.members.length === manifest.members.length &&
        existing.members.every((m, i) => m === manifest.members[i]) &&
        existing.compositeName === manifest.compositeName;
      if (!sameMembers) {
        throw new ConfigurationError('composite-manifest', [manifestPath], {
          reason:
            `composite '${manifest.compositeName}' already exists with a different member set; ` +
            `pass --force-overwrite to replace`,
          existingMembers: [...existing.members],
          newMembers: [...manifest.members],
          manifestPath,
        });
      }
      // Idempotent re-write: members + name match → fall through to
      // re-emit canonical JSON (digests / createdAt may have advanced).
    }

    // ---- 3. Write the temp file ----------------------------------
    const tmpPath = `${manifestPath}.tmp`;
    const body = JSON.stringify(manifest, null, 2) + '\n';
    try {
      await fsp.writeFile(tmpPath, body, {
        encoding: 'utf8',
        mode: MANIFEST_FILE_MODE,
      });
    } catch (err) {
      try {
        await fsp.unlink(tmpPath);
      } catch {
        /* tolerated */
      }
      throw new FileError(
        'E_FILE_PERMISSION',
        `writeManifest: failed to write temp file '${tmpPath}': ${(err as Error).message}`,
        { manifestPath, tmpPath },
      );
    }

    // ---- 4. Rename into place ------------------------------------
    try {
      await fsp.rename(tmpPath, manifestPath);
    } catch (err) {
      try {
        await fsp.unlink(tmpPath);
      } catch {
        /* tolerated */
      }
      throw new FileError(
        'E_FILE_PERMISSION',
        `writeManifest: failed to rename '${tmpPath}' to '${manifestPath}': ${(err as Error).message}`,
        { manifestPath, tmpPath },
      );
    }

    // Belt-and-braces chmod (some umask combos can drop the mode on rename).
    try {
      await fsp.chmod(manifestPath, MANIFEST_FILE_MODE);
    } catch {
      /* tolerated */
    }
  } finally {
    // ---- 5. Always release the lock ------------------------------
    if (lockFd) {
      try {
        await lockFd.close();
      } catch {
        /* tolerated */
      }
      try {
        await fsp.unlink(lockPath);
      } catch {
        /* tolerated — file may have been removed by another process */
      }
    }
  }
}
