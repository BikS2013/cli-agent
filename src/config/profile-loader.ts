/**
 * Profile loader — resolves a profile name into an `ActiveProfile`.
 *
 * Public API:
 *   - `loadProfile(name, agentDir)`     — load + validate (E1, E4, E5, E11, E16, E18).
 *   - `listProfiles(agentDir)`          — enumerate the profiles dir for `profile-list`.
 *   - `resolveProfilePath(name, agentDir)` — locate the file on disk.
 *
 * Spec references:
 *   - docs/design/project-design.md §12.D (data models) and §12.I (errors).
 *   - docs/design/plan-005-config-profiles.md §4 P4 (loader + bootstrap).
 */

import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ConfigurationError, FileError, UsageError } from '../errors.js';
import { parseProfile, detectAmbiguity } from './profile-codec.js';
import {
  KNOWN_CLI_PARAMS,
  validateNoSecrets,
  type ProfileCliParams,
  type ProfileTools,
  type ProfileToolArgs,
} from './profile-schema.js';

/* ---------- Types ---------- */

/**
 * Resolved profile carried on `AgentConfig` for the duration of a run.
 *
 * The `digest` is SHA-256 hex first 16 chars over the RAW file bytes
 * (ADR-PROF-9), guaranteeing byte-level reproducibility audit.
 */
export interface ActiveProfile {
  readonly name: string;
  readonly path: string;
  readonly schemaVersion: number;
  readonly digest: string;
  readonly cliParams?: ProfileCliParams;
  readonly tools?: ProfileTools;
  readonly toolArgs?: ProfileToolArgs;
}

export interface ProfileFileEntry {
  readonly name: string;
  readonly description?: string;
  readonly size: number;
  readonly mtime: Date;
  readonly path: string;
}

/* ---------- Constants ---------- */

const PROFILE_NAME_INVALID_RE = /[\\/:*?"<>|\x00-\x1f]/;

const PROFILES_SUBDIR = 'profiles';

/* ---------- Name + path helpers ---------- */

/**
 * Validate a profile name against the filesystem-safe character policy
 * (E16). Throws `UsageError` (exit 2) on any violation. The name MUST NOT:
 *   - be empty
 *   - contain `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|` or control chars
 *   - start with `.` (would shadow dotfiles like `.gitignore`)
 *   - be `.` or `..`
 */
export function validateProfileName(name: string): void {
  if (!name || name.length === 0) {
    throw new UsageError(`Profile name must be non-empty.`);
  }
  if (name === '.' || name === '..') {
    throw new UsageError(`Profile name '${name}' is reserved.`);
  }
  if (name.startsWith('.')) {
    throw new UsageError(
      `Profile name '${name}' must not start with a dot.`,
    );
  }
  if (PROFILE_NAME_INVALID_RE.test(name)) {
    throw new UsageError(
      `Profile name '${name}' contains an illegal character. ` +
        `Allowed: letters, digits, '-', '_', '.', and Unicode letters; ` +
        `not allowed: / \\ : * ? " < > | or control characters.`,
    );
  }
}

/**
 * Resolve the on-disk path of a profile by name. Performs:
 *   - name validation (E16 → UsageError)
 *   - extension ambiguity detection (E18 → ConfigurationError)
 *
 * Returns the candidate paths under `<agentDir>/profiles/`.
 */
export function resolveProfilePath(
  name: string,
  agentDir: string,
): { yaml?: string; json?: string } {
  validateProfileName(name);
  const found = detectAmbiguity(agentDir, name);
  if (found.yaml && found.json) {
    throw new ConfigurationError(
      'profile file',
      [found.yaml, found.json],
      {
        detail:
          `Both YAML and JSON profile files exist for '${name}'. ` +
          `Remove one of: ${found.yaml} or ${found.json}.`,
        yamlPath: found.yaml,
        jsonPath: found.json,
      },
    );
  }
  return found;
}

/* ---------- Loader ---------- */

/**
 * Load and validate a profile by name.
 *
 * Errors:
 *   - E1  profile not found     → `UsageError` exit 2 (lists existing profiles)
 *   - E2  malformed YAML/JSON   → `ConfigurationError` (codec; line/col)
 *   - E3  unknown top-level key → `ConfigurationError` (schema)
 *   - E4  name/stem mismatch    → `ConfigurationError` exit 3
 *   - E5  empty profile         → loads inert; stderr notice
 *   - E11 credential-shape key  → `ConfigurationError` (schema validator)
 *   - E16 illegal characters    → `UsageError` exit 2
 *   - E17 profiles dir unreadable (only via `listProfiles`/E1 list)
 *   - E18 yaml + json ambiguity → `ConfigurationError` exit 3
 */
export async function loadProfile(
  name: string,
  agentDir: string,
): Promise<ActiveProfile> {
  const found = resolveProfilePath(name, agentDir);

  let absPath: string;
  if (found.yaml) {
    absPath = found.yaml;
  } else if (found.json) {
    absPath = found.json;
  } else {
    // E1: profile not found. Enumerate existing profiles for diagnostics.
    let existing: string[] = [];
    try {
      const entries = await listProfiles(agentDir);
      existing = entries.map((e) => e.name);
    } catch {
      // If the listing itself fails we still report the primary error.
    }
    const expected = path.join(agentDir, PROFILES_SUBDIR, `${name}.yaml`);
    const detail =
      existing.length > 0
        ? `Existing profiles: ${existing.join(', ')}.`
        : `No profiles found under ${path.join(agentDir, PROFILES_SUBDIR)}.`;
    throw new UsageError(
      `Profile '${name}' not found. Searched ${expected} (and .yml/.json).\n${detail}`,
      { profileName: name, searchedDir: path.join(agentDir, PROFILES_SUBDIR) },
    );
  }

  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(absPath);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FileError(
        'E_FILE_PERMISSION',
        `Cannot read profile file ${absPath}: ${(e as Error).message}`,
        { path: absPath },
      );
    }
    if (code === 'ENOENT') {
      throw new UsageError(
        `Profile file disappeared between resolution and read: ${absPath}`,
        { path: absPath },
      );
    }
    throw e;
  }

  const text = bytes.toString('utf8');
  const digest = crypto
    .createHash('sha256')
    .update(bytes)
    .digest('hex')
    .slice(0, 16);

  const profile = parseProfile(text, absPath);

  // E4: name/stem cross-check.
  const stem = path.basename(absPath, path.extname(absPath));
  if (profile.name !== undefined && profile.name !== stem) {
    throw new ConfigurationError('profile file', [absPath], {
      detail:
        `Profile 'name' field ('${profile.name}') does not match the file stem ('${stem}'). ` +
        `Either rename the file to ${stem}.<ext> or update the 'name:' field.`,
      profileName: profile.name,
      stem,
    });
  }

  // E11: credential-shape key in cliParams.
  if (profile.cliParams) {
    validateNoSecrets(profile.cliParams as Record<string, unknown>);
    // E20: warn on unknown cliParams keys (cap at 10 per ADR-PROF-11).
    emitUnknownCliParamWarnings(profile.cliParams as Record<string, unknown>, stem);
  }

  // E5: empty profile (no presets at all). Stderr notice but no error.
  const isEmpty =
    !profile.cliParams &&
    !profile.tools &&
    !profile.toolArgs &&
    !profile.description;
  if (isEmpty) {
    process.stderr.write(
      `[cli-agent] profile ${stem} is empty (no presets applied)\n`,
    );
  }

  return Object.freeze({
    name: stem,
    path: absPath,
    schemaVersion: profile.schemaVersion,
    digest,
    cliParams: profile.cliParams,
    tools: profile.tools,
    toolArgs: profile.toolArgs,
  });
}

/**
 * Emit per-key stderr warnings for unknown `cliParams` keys (E20).
 * Capped at 10 lines per profile load with a "(N more suppressed)" footer.
 */
function emitUnknownCliParamWarnings(
  cliParams: Record<string, unknown>,
  profileName: string,
): void {
  const unknown = Object.keys(cliParams).filter((k) => !KNOWN_CLI_PARAMS.has(k));
  if (unknown.length === 0) return;
  const cap = 10;
  for (const key of unknown.slice(0, cap)) {
    process.stderr.write(
      `[cli-agent] warning: profile ${profileName} cliParams.${key} is not a recognised setting (forward-compat; ignoring)\n`,
    );
  }
  if (unknown.length > cap) {
    process.stderr.write(
      `[cli-agent] warning: profile ${profileName} cliParams has ${unknown.length - cap} more unknown keys (suppressed)\n`,
    );
  }
}

/* ---------- listProfiles ---------- */

/**
 * Enumerate all profile files under `<agentDir>/profiles/`. Used by
 * `profile-list` and (best-effort) by the E1 "profile not found"
 * diagnostic.
 *
 * Errors:
 *   - profiles dir unreadable (EACCES) → `FileError` (E17, exit 6)
 *   - profiles dir missing (ENOENT)    → returns [] (caller treats as empty)
 */
export async function listProfiles(agentDir: string): Promise<ProfileFileEntry[]> {
  const dir = path.join(agentDir, PROFILES_SUBDIR);
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOENT') return [];
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FileError(
        'E_FILE_PERMISSION',
        `Cannot read profiles directory ${dir}: ${(e as Error).message}`,
        { path: dir },
      );
    }
    throw e;
  }

  const out: ProfileFileEntry[] = [];
  for (const entry of entries) {
    const ext = path.extname(entry).toLowerCase();
    if (ext !== '.yaml' && ext !== '.yml' && ext !== '.json') continue;
    const stem = path.basename(entry, ext);
    const abs = path.join(dir, entry);
    let stat: { size: number; mtime: Date };
    try {
      const s = await fsp.stat(abs);
      stat = { size: s.size, mtime: s.mtime };
    } catch {
      continue;
    }
    let description: string | undefined;
    try {
      const text = await fsp.readFile(abs, 'utf8');
      const profile = parseProfile(text, abs);
      description = profile.description;
    } catch {
      // Malformed profile is still listed; description stays undefined.
    }
    out.push({
      name: stem,
      description,
      size: stat.size,
      mtime: stat.mtime,
      path: abs,
    });
  }
  // Stable alpha-sort for deterministic output.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
