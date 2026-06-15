/**
 * Profile schema (Zod) for configuration profiles.
 *
 * See `docs/design/project-design.md` §12.D and `docs/design/plan-005-config-profiles.md` §6.
 *
 * Layering:
 *   - Top-level object: `.strict()` — unknown keys at the root rejected (E3).
 *   - `cliParams`:      `.passthrough()` — unknown keys tolerated for forward
 *                       compatibility (E20). The codec/loader emit a stderr
 *                       warning per unknown key against `KNOWN_CLI_PARAMS`.
 *   - `tools.allow`:    `.min(1)` so the explicitly empty array is rejected (E6).
 *   - Credential-shape keys in `cliParams` are detected separately by
 *     `validateNoSecrets` (E11) — Zod alone cannot capture the regex policy.
 */

import { z } from 'zod';
import { ConfigurationError } from '../errors.js';

/* ---------- Sub-schemas ---------- */

export const ProfileCliParamsSchema = z
  .object({
    provider: z.string().optional(),
    model: z.string().optional(),
    temperature: z.number().optional(),
    maxIterations: z.number().int().positive().optional(),
    workingDir: z.string().optional(),
    logLevel: z.string().optional(),
    webSearchBackend: z.string().optional(),
    allowMutations: z.boolean().optional(),
  })
  .passthrough(); // E20: forward-compat for unknown cliParams keys.

export const ProfileToolsSchema = z
  .object({
    allow: z.array(z.string()).min(1).optional(), // E6: empty array rejected.
    deny: z.array(z.string()).optional(),
    order: z.array(z.string()).optional(),
    // Tool-loading group toggles (plan-008). Profile tier of the uniform
    // precedence chain CLI flag > env > config.json > profile > default(load).
    // Each is an OPTIONAL boolean; `undefined` defers to the built-in default
    // (load). These are explicit user settings, NOT runtime fallbacks for
    // missing required config.
    //   composites → every virtual/composite tool (loadVirtualToolsSync)
    //   builtin    → the cross-cutting toolkit (file_*/web_*/bash_*/tool_help)
    //   agentTools → the agent-tools pack umbrella (agt_*)
    composites: z.boolean().optional(),
    builtin: z.boolean().optional(),
    agentTools: z.boolean().optional(),
  })
  .strict();

export const ProfileToolArgsSchema = z.record(
  z.string(),
  z.record(z.string(), z.unknown()),
);

export const ProfileSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    schemaVersion: z.literal(1).default(1),
    cliParams: ProfileCliParamsSchema.optional(),
    tools: ProfileToolsSchema.optional(),
    toolArgs: ProfileToolArgsSchema.optional(),
  })
  .strict(); // E3: unknown top-level keys rejected.

export type Profile = z.infer<typeof ProfileSchema>;
export type ProfileCliParams = z.infer<typeof ProfileCliParamsSchema>;
export type ProfileTools = z.infer<typeof ProfileToolsSchema>;
export type ProfileToolArgs = z.infer<typeof ProfileToolArgsSchema>;

/* ---------- Known CLI param keys (forward-compat warn list) ---------- */

/**
 * Set of `cliParams` keys recognised by the current cli-agent build. Profile
 * loaders emit a stderr warning for any key NOT in this set so users can
 * spot typos while still allowing forward-compatible additions in newer
 * versions to load on older binaries (E20).
 */
export const KNOWN_CLI_PARAMS: ReadonlySet<string> = new Set<string>([
  'provider',
  'model',
  'temperature',
  'maxIterations',
  'workingDir',
  'logLevel',
  'webSearchBackend',
  'allowMutations',
]);

/* ---------- Credential-shape detection (E11) ---------- */

/**
 * Matches keys that look like credentials. The regex is anchored to the END
 * of the key so prefixes (e.g. `OPENAI_API_KEY`, `MY_TOKEN`) match while
 * incidental substrings (e.g. `tokenize`) do not.
 */
export const CREDENTIAL_KEY_PATTERN: RegExp = /(_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/i;

/**
 * Throws `ConfigurationError` if any key in `cliParams` matches the
 * credential-shape regex. Profiles MUST NEVER carry secrets — secrets belong
 * in `~/.tool-agents/cli-agent/.env` or shell env vars (E11).
 */
export function validateNoSecrets(cliParams: Record<string, unknown>): void {
  const offenders: string[] = [];
  for (const key of Object.keys(cliParams)) {
    if (CREDENTIAL_KEY_PATTERN.test(key)) {
      offenders.push(key);
    }
  }
  if (offenders.length > 0) {
    throw new ConfigurationError(
      'profile.cliParams',
      ['profile file'],
      {
        detail:
          `cliParams contains credential-shape key(s): ${offenders.join(', ')}. ` +
          `Profiles MUST NOT carry secrets — store credentials in ~/.tool-agents/cli-agent/.env ` +
          `or shell env vars instead.`,
        offendingKeys: offenders,
      },
    );
  }
}
