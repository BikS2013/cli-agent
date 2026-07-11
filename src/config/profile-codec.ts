/**
 * Profile codec — encapsulates ALL eemeli/yaml package interaction.
 *
 * Callers see only `parseProfile`, `stringifyProfile`, `createProfileStub`,
 * and `detectAmbiguity`. The yaml dependency is not exposed beyond this
 * module so future codec replacement is a one-file change.
 *
 * Design references:
 *   - docs/research/yaml-package-usage.md §"Complete Profile Codec Skeleton"
 *   - docs/design/project-design.md §12.B (module layout) and §12.D (data models)
 *   - docs/design/plan-005-config-profiles.md §6 ADR-PROF-1, ADR-PROF-8, ADR-PROF-10
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseDocument, stringify, visit } from 'yaml';
import type { Document } from 'yaml';
import { ConfigurationError } from '../errors.js';
import { ProfileSchema } from './profile-schema.js';
import type { Profile } from './profile-schema.js';
import { MODE_MIGRATION_HINT } from './mode.js';

/* ---------- Internal helpers ---------- */

/**
 * Parse a raw YAML/JSON string into a Document, throwing ConfigurationError
 * on any syntax problem. JSON files are valid YAML 1.2 so the same parser
 * accepts both — the caller is not required to discriminate by extension.
 */
function parseYamlSafely(text: string, filePath: string): Document {
  const doc = parseDocument(text, {
    prettyErrors: true, // populate linePos on errors (default true; explicit for clarity)
    logLevel: 'error', // suppress YAML spec warnings from console.warn
  });

  if (doc.errors.length > 0) {
    const err = doc.errors[0]!;
    const loc = err.linePos?.[0];
    const location = loc ? ` at line ${loc.line}, column ${loc.col}` : '';
    throw new ConfigurationError('profile file', [filePath], {
      detail: `YAML syntax error${location}: ${err.message}`,
      yamlErrorCode: err.code,
      line: loc?.line,
      column: loc?.col,
    });
  }

  return doc;
}

/**
 * Reject any document that contains alias nodes (ADR-PROF-8). Profiles are
 * small, hand-written files; aliases provide no legitimate value and add
 * a confusion vector ("why didn't my anchor expand?").
 */
function rejectAliases(doc: Document, filePath: string): void {
  visit(doc, {
    Alias(_key, node) {
      throw new ConfigurationError('profile file', [filePath], {
        detail:
          `Profile file contains a YAML alias (*${String(node.source)}), ` +
          `which is not supported in profile files.`,
      });
    },
  });
}

/* ---------- Public API ---------- */

/**
 * Parse a profile file's text content into a validated `Profile` object.
 *
 * Throws `ConfigurationError` (never `ZodError`, never `YAMLParseError`)
 * so callers always receive a single error type regardless of whether the
 * failure is a YAML syntax issue or a schema violation.
 *
 * @param text     - Raw UTF-8 text of the profile file
 * @param filePath - Path used only for error messages
 */
export function parseProfile(text: string, filePath: string): Profile {
  const doc = parseYamlSafely(text, filePath);
  rejectAliases(doc, filePath);

  const raw: unknown = doc.toJS();

  // Legacy group-toggle key pre-check (plan-015, Resolution 2). The keys
  // were removed from ProfileToolsSchema, so `.strict()` alone would reject
  // them with a generic Zod "unrecognized key" message; this pre-check
  // surfaces the actionable migration hint instead.
  if (raw !== null && typeof raw === 'object') {
    const rawTools = (raw as Record<string, unknown>)['tools'];
    if (rawTools !== null && typeof rawTools === 'object') {
      const legacyKeys = ['composites', 'builtin', 'agentTools'].filter((k) =>
        Object.prototype.hasOwnProperty.call(rawTools, k),
      );
      if (legacyKeys.length > 0) {
        // The explanation rides in checkedSources so it lands in the
        // user-visible error MESSAGE (handleErrors prints only e.message);
        // details.detail mirrors it per this codec's spec convention.
        throw new ConfigurationError('profile file', [
          `${filePath} — profile key(s) 'tools.${legacyKeys.join("', 'tools.")}' were removed (plan-015); ` +
            `pin tool groups with cliParams.mode instead`,
        ], {
          detail:
            `Profile key(s) 'tools.${legacyKeys.join("', 'tools.")}' were removed (plan-015). ` +
            `Pin tool groups with cliParams.mode instead. ${MODE_MIGRATION_HINT}`,
          legacyKeys,
        });
      }
    }
  }

  const result = ProfileSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  ${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('\n');
    throw new ConfigurationError('profile file', [filePath], {
      detail: `Schema validation failed:\n${issues}`,
      issues: result.error.issues,
    });
  }

  return result.data;
}

/**
 * Serialize a validated `Profile` object back to YAML text. Used by
 * `profile-create` (writes a new stub file) and `profile-create
 * --from-current` (serialises the current effective config).
 *
 * Does NOT attempt to preserve comments from any previously-read file.
 */
export function stringifyProfile(profile: Profile): string {
  return stringify(profile, {
    indent: 2,
    lineWidth: 100,
    singleQuote: false,
  });
}

/**
 * Generate the canonical YAML stub for a new profile, with three
 * commented-out sections (`cliParams`, `tools`, `toolArgs`) plus
 * `name: <name>` and `schemaVersion: 1`.
 *
 * Returns the YAML text; the caller is responsible for writing to disk.
 */
export function createProfileStub(name: string): string {
  return [
    `# cli-agent profile: ${name}`,
    `# Generated by profile-create. Edit this file, then run:`,
    `#   cli-agent --profile ${name} [your query]`,
    `#`,
    `# See docs/design/configuration-guide.md for all available settings.`,
    ``,
    `name: ${name}`,
    `schemaVersion: 1`,
    ``,
    `# --- cliParams ----------------------------------------------------------`,
    `# Uncomment and edit any of the following to pin CLI parameter values.`,
    `#`,
    `# cliParams:`,
    `#   provider: anthropic`,
    `#   model: claude-3-5-sonnet-20241022`,
    `#   temperature: 0.7`,
    `#   maxIterations: 50`,
    ``,
    `# --- tools ---------------------------------------------------------------`,
    `# Uncomment to restrict which tools the agent may use.`,
    `#`,
    `# tools:`,
    `#   allow:`,
    `#     - bash_run`,
    `#     - file_read`,
    `#   deny: []`,
    `#   order: []`,
    ``,
    `# --- toolArgs ------------------------------------------------------------`,
    `# Uncomment to set default arguments for specific tools.`,
    `#`,
    `# toolArgs:`,
    `#   agt_web_search:`,
    `#     maxResults: 10`,
    ``,
  ].join('\n');
}

/**
 * Detect ambiguity when both `<name>.yaml` and `<name>.json` (or `.yml`)
 * exist for the same profile stem (E18). Returns the absolute paths of any
 * extensions that are present on disk.
 *
 * The caller (profile-loader) decides how to react: when more than one
 * extension is present a `ConfigurationError` is raised so the system
 * never silently prefers one over the other.
 *
 * Uses synchronous fs because the checks are O(profileExtensions) tiny stats
 * and the function is also called from synchronous paths in some tests; the
 * loader-time call site can wrap as needed.
 */
export function detectAmbiguity(
  agentDir: string,
  name: string,
): { yaml?: string; json?: string } {
  const profilesDir = path.join(agentDir, 'profiles');
  const yamlPath = path.join(profilesDir, `${name}.yaml`);
  const ymlPath = path.join(profilesDir, `${name}.yml`);
  const jsonPath = path.join(profilesDir, `${name}.json`);

  const out: { yaml?: string; json?: string } = {};
  if (existsSafe(yamlPath)) out.yaml = yamlPath;
  else if (existsSafe(ymlPath)) out.yaml = ymlPath;
  if (existsSafe(jsonPath)) out.json = jsonPath;
  return out;
}

function existsSafe(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
