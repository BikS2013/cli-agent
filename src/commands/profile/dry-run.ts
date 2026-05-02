/**
 * `profile-dry-run` — show the effective configuration that would be
 * produced if cli-agent ran with the given profile / flags, WITHOUT
 * launching the agent.
 *
 * The trace is computed independently here (mirroring the resolution
 * chain in `loadAgentConfig`), per plan-005 §5 U-CLI: "an alternative
 * is to compute the trace independently in the dry-run command by
 * mirroring the resolution chain […] Either approach is acceptable as
 * long as the result matches what `loadAgentConfig` would actually
 * produce". Doing it here keeps the foundation modules untouched while
 * P7's in-loadAgentConfig trace mode lands.
 *
 * Default output: kubectl/aws-style 3-column table (KNOB / VALUE /
 * SOURCE) plus a section listing the resolved tool catalog (currently
 * unfiltered with a stderr note since U-SCOPE has not yet landed; the
 * code is structured to swap to scoped output as soon as that unit is
 * merged).
 *
 * `--json` opts into machine-readable output.
 *
 * Spec: plan-005 §5 U-CLI; FR-PROF-013; AC-16.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  agentToolAgentsDir,
  agentDotEnvPath,
  loadAgentConfig,
} from '../../config/agent-config.js';
import { listProfiles, loadProfile } from '../../config/profile-loader.js';
import type { ActiveProfile } from '../../config/profile-loader.js';
import { renderTable, formatKnobValue } from './shared.js';
import type { KnobSource, KnobTrace } from './shared.js';

export interface ProfileDryRunOpts {
  readonly profile?: string;
  readonly json?: boolean;
}

/* ---------- Module-local types ---------- */

interface SourceLayers {
  readonly cliFlags: Record<string, unknown>; // user-provided flags (none here)
  readonly shellEnv: NodeJS.ProcessEnv;
  readonly agentDotEnv: Record<string, string>;
  readonly localDotEnv: Record<string, string>;
  readonly profile?: ActiveProfile;
  readonly configFile: Record<string, unknown> | null;
}

/**
 * Knob → resolution descriptor: ordered candidates, each pointing to a
 * source layer. Built once and consulted to pick the winning value.
 */
interface KnobResolver {
  readonly knob: string;
  /**
   * Returns the trace tuple (value, source) for this knob. `value`
   * resolves through the precedence chain; if every layer is undefined
   * the source is `built-in-default` (or `<unset>` value if no default).
   */
  readonly resolve: (layers: SourceLayers) => KnobTrace;
}

/* ---------- .env parsing (mirrors agent-config.ts internals) ---------- */

function parseDotEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

async function readEnvFileSafe(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return parseDotEnv(raw);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return {};
    throw e;
  }
}

async function readConfigFileSafe(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed;
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
}

/* ---------- Resolution helpers ---------- */

function pickSource(
  knob: string,
  candidates: ReadonlyArray<{
    readonly value: unknown;
    readonly source: KnobSource;
  }>,
): KnobTrace {
  for (const c of candidates) {
    if (c.value !== undefined) {
      return { knob, value: c.value, source: c.source };
    }
  }
  return { knob, value: undefined, source: 'built-in-default' };
}

/* ---------- Knob resolvers ---------- */

/**
 * The set of pinnable knobs the dry-run report attributes. Mirrors the
 * `cliParams` keys threaded into `loadAgentConfig` per §12.G plus the
 * top-level activation metadata.
 */
function buildKnobResolvers(): ReadonlyArray<KnobResolver> {
  return [
    {
      knob: 'provider',
      resolve: (l) =>
        pickSource('provider', [
          { value: l.cliFlags['provider'], source: 'cli-flag' },
          { value: l.shellEnv['AGENT_PROVIDER'], source: 'env:AGENT_PROVIDER' },
          {
            value: l.agentDotEnv['AGENT_PROVIDER'],
            source: 'agent-dir-.env',
          },
          { value: l.localDotEnv['AGENT_PROVIDER'], source: 'local-.env' },
          {
            value: l.profile?.cliParams?.['provider'],
            source: l.profile ? `profile:${l.profile.name}` : 'built-in-default',
          },
          { value: l.configFile?.['provider'], source: 'config.json' },
        ]),
    },
    {
      knob: 'model',
      resolve: (l) =>
        pickSource('model', [
          { value: l.cliFlags['model'], source: 'cli-flag' },
          { value: l.shellEnv['AGENT_MODEL'], source: 'env:AGENT_MODEL' },
          { value: l.agentDotEnv['AGENT_MODEL'], source: 'agent-dir-.env' },
          { value: l.localDotEnv['AGENT_MODEL'], source: 'local-.env' },
          {
            value: l.profile?.cliParams?.['model'],
            source: l.profile ? `profile:${l.profile.name}` : 'built-in-default',
          },
          { value: l.configFile?.['model'], source: 'config.json' },
        ]),
    },
    {
      knob: 'temperature',
      resolve: (l) =>
        pickSource('temperature', [
          { value: l.cliFlags['temperature'], source: 'cli-flag' },
          {
            value: l.profile?.cliParams?.['temperature'],
            source: l.profile ? `profile:${l.profile.name}` : 'built-in-default',
          },
          { value: l.configFile?.['temperature'], source: 'config.json' },
        ]),
    },
    {
      knob: 'maxIterations',
      resolve: (l) =>
        pickSource('maxIterations', [
          { value: l.cliFlags['maxSteps'], source: 'cli-flag' },
          {
            value: l.profile?.cliParams?.['maxIterations'],
            source: l.profile ? `profile:${l.profile.name}` : 'built-in-default',
          },
          { value: l.configFile?.['maxSteps'], source: 'config.json' },
          { value: 25, source: 'built-in-default' },
        ]),
    },
    {
      knob: 'allowMutations',
      resolve: (l) => {
        const env = l.shellEnv['AGENT_ALLOW_MUTATIONS'];
        const agt = l.agentDotEnv['AGENT_ALLOW_MUTATIONS'];
        const loc = l.localDotEnv['AGENT_ALLOW_MUTATIONS'];
        return pickSource('allowMutations', [
          { value: l.cliFlags['allowMutations'], source: 'cli-flag' },
          {
            value: env !== undefined ? parseBool(env) : undefined,
            source: 'env:AGENT_ALLOW_MUTATIONS',
          },
          {
            value: agt !== undefined ? parseBool(agt) : undefined,
            source: 'agent-dir-.env',
          },
          {
            value: loc !== undefined ? parseBool(loc) : undefined,
            source: 'local-.env',
          },
          {
            value: l.profile?.cliParams?.['allowMutations'],
            source: l.profile ? `profile:${l.profile.name}` : 'built-in-default',
          },
          { value: l.configFile?.['allowMutations'], source: 'config.json' },
          { value: false, source: 'built-in-default' },
        ]);
      },
    },
    {
      knob: 'webSearchBackend',
      resolve: (l) =>
        pickSource('webSearchBackend', [
          { value: l.cliFlags['webSearchBackend'], source: 'cli-flag' },
          {
            value: l.shellEnv['WEB_SEARCH_BACKEND'],
            source: 'env:WEB_SEARCH_BACKEND',
          },
          {
            value: l.agentDotEnv['WEB_SEARCH_BACKEND'],
            source: 'agent-dir-.env',
          },
          { value: l.localDotEnv['WEB_SEARCH_BACKEND'], source: 'local-.env' },
          {
            value: l.profile?.cliParams?.['webSearchBackend'],
            source: l.profile ? `profile:${l.profile.name}` : 'built-in-default',
          },
          {
            value: (l.configFile?.['webSearch'] as { backend?: string } | undefined)
              ?.backend,
            source: 'config.json',
          },
          { value: 'tavily', source: 'built-in-default' },
        ]),
    },
    {
      knob: 'logLevel',
      resolve: (l) =>
        pickSource('logLevel', [
          { value: l.cliFlags['verbose'], source: 'cli-flag' },
          { value: l.shellEnv['CLI_AGENT_LOG'], source: 'env:CLI_AGENT_LOG' },
          { value: l.agentDotEnv['CLI_AGENT_LOG'], source: 'agent-dir-.env' },
          { value: l.localDotEnv['CLI_AGENT_LOG'], source: 'local-.env' },
          {
            value: l.profile?.cliParams?.['logLevel'],
            source: l.profile ? `profile:${l.profile.name}` : 'built-in-default',
          },
        ]),
    },
    {
      knob: 'workingDir',
      resolve: (l) =>
        pickSource('workingDir', [
          { value: l.shellEnv['FILE_EDIT_ROOT'], source: 'env:FILE_EDIT_ROOT' },
          { value: l.agentDotEnv['FILE_EDIT_ROOT'], source: 'agent-dir-.env' },
          { value: l.localDotEnv['FILE_EDIT_ROOT'], source: 'local-.env' },
          {
            value: l.profile?.cliParams?.['workingDir'],
            source: l.profile ? `profile:${l.profile.name}` : 'built-in-default',
          },
          {
            value: (l.configFile?.['fileEdit'] as { root?: string } | undefined)
              ?.root,
            source: 'config.json',
          },
          { value: process.cwd(), source: 'built-in-default' },
        ]),
    },
  ];
}

function parseBool(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return undefined;
}

/* ---------- Public entry point ---------- */

export async function runProfileDryRun(
  opts: ProfileDryRunOpts = {},
): Promise<void> {
  const agentDir = agentToolAgentsDir();

  // Determine profile (CLI flag → CLI_AGENT_PROFILE env → none).
  const profileName = opts.profile ?? process.env['CLI_AGENT_PROFILE'];

  let profile: ActiveProfile | undefined;
  if (profileName !== undefined && profileName.length > 0) {
    profile = await loadProfile(profileName, agentDir);
  }

  // Layer collection.
  const agentDotEnv = await readEnvFileSafe(agentDotEnvPath());
  const cwd = process.cwd();
  const localDotEnvPath = path.join(cwd, '.env');
  const localDotEnv =
    path.resolve(localDotEnvPath) !== path.resolve(agentDotEnvPath())
      ? await readEnvFileSafe(localDotEnvPath)
      : {};
  const configFile = await readConfigFileSafe(path.join(agentDir, 'config.json'));

  const layers: SourceLayers = {
    cliFlags: {},
    shellEnv: process.env,
    agentDotEnv,
    localDotEnv,
    profile,
    configFile,
  };

  // Build the trace.
  const resolvers = buildKnobResolvers();
  const traces = resolvers.map((r) => r.resolve(layers));

  // Resolve the catalog (best-effort) by loading the canonical config
  // and using its tools field. We deliberately DON'T call
  // `applyProfileToolScoping` because U-SCOPE may not have landed yet;
  // the prompt instructs us to "gracefully degrade by listing the
  // unfiltered catalog with a stderr note".
  let catalog: ReadonlyArray<string>;
  let scopingApplied = false;
  try {
    const cfg = await loadAgentConfig(
      profileName ? { profile: profileName } : {},
    );
    catalog = await deriveCatalog(cfg);
    if (profile?.tools) {
      // Best-effort scoping preview if `applyProfileToolScoping` is
      // exposed; otherwise unfiltered + stderr note.
      const scoped = await tryApplyScoping(catalog, profile.tools);
      if (scoped) {
        catalog = scoped;
        scopingApplied = true;
      } else {
        process.stderr.write(
          `[cli-agent] (scoping preview unavailable until U-SCOPE lands)\n`,
        );
      }
    }
  } catch (e) {
    // When the agent config itself fails to resolve (e.g. missing
    // provider env vars) we still want to emit the trace. Surface the
    // resolution error on stderr but continue.
    process.stderr.write(
      `[cli-agent] note: agent-config resolution failed (${(e as Error).message}); ` +
        `dry-run trace below reflects only profile + .env layers.\n`,
    );
    catalog = [];
  }

  if (opts.json) {
    const payload = {
      profile: profile
        ? {
            name: profile.name,
            path: profile.path,
            schemaVersion: profile.schemaVersion,
            digest: profile.digest,
          }
        : null,
      knobs: traces.map((t) => ({
        knob: t.knob,
        value: t.value,
        source: t.source,
      })),
      catalog,
      scopingApplied,
    };
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    return;
  }

  // Human output.
  const out: string[] = [];
  out.push(
    profile
      ? `Active profile: ${profile.name}  (${profile.path}, digest=${profile.digest})\n`
      : `Active profile: <none>\n`,
  );

  if (profile === undefined && profileName) {
    // Shouldn't happen — loader would have thrown. Defensive log.
    out.push(`(profile name '${profileName}' did not resolve)\n`);
  }

  out.push('\n');
  out.push('Resolved configuration\n');
  out.push(
    renderTable(
      ['KNOB', 'VALUE', 'SOURCE'],
      traces.map((t) => [t.knob, formatKnobValue(t.value), t.source]),
    ),
  );

  out.push('\n');
  out.push(
    `Resolved tool catalog (${catalog.length} tool${catalog.length === 1 ? '' : 's'}` +
      `${scopingApplied ? ', after profile scoping' : ', unscoped'}):\n`,
  );
  if (catalog.length === 0) {
    out.push('  <no tools registered>\n');
  } else {
    for (const t of catalog) out.push(`  - ${t}\n`);
  }

  // Print existing-profiles hint when none active.
  if (!profile) {
    try {
      const entries = await listProfiles(agentDir);
      if (entries.length > 0) {
        out.push('\n');
        out.push(`(${entries.length} profile(s) available — pass --profile <name> to dry-run with one)\n`);
      }
    } catch {
      // ignore
    }
  }

  process.stdout.write(out.join(''));
}

/* ---------- Catalog derivation (without spawning the LLM) ---------- */

/**
 * Build the LLM-visible tool catalog WITHOUT launching the agent.
 * Imports the registry lazily so a `profile-dry-run` invocation that
 * fails the trace doesn't pay the registry import cost.
 */
async function deriveCatalog(
  cfg: import('../../config/agent-config.js').AgentConfig,
): Promise<ReadonlyArray<string>> {
  const { buildToolCatalog } = await import('../../agent/tools/registry.js');
  // Provide a minimal logger shim — we don't emit any events here.
  const logger = makeNoopLogger();
  const cat = buildToolCatalog(cfg, logger);
  return cat.tools.map((t) => (t as { name?: string }).name ?? '<anonymous>');
}

function makeNoopLogger(): import('../../agent/logging.js').Logger {
  // Match the shape of the production Logger lazily — using a cast keeps
  // this file decoupled from the logging module's exact surface (which
  // grows over time and includes log-rotation state we don't need).
  const noop: unknown = {
    log: () => undefined,
    flush: async () => undefined,
    sessionId: 'profile-dry-run',
  };
  return noop as import('../../agent/logging.js').Logger;
}

/**
 * Best-effort application of profile tool scoping. Returns `undefined`
 * when U-SCOPE has not yet landed (`applyProfileToolScoping` is not
 * exported). When it lands the import resolves and the catalog is
 * filtered through the algorithm.
 */
async function tryApplyScoping(
  catalog: ReadonlyArray<string>,
  scoping: { allow?: string[]; deny?: string[]; order?: string[] } | undefined,
): Promise<ReadonlyArray<string> | undefined> {
  if (!scoping) return undefined;
  try {
    const mod = (await import(
      '../../agent/tools/profile-scoping.js' as string
    )) as {
      applyProfileToolScoping?: (
        tools: Array<{ name: string }>,
        s: typeof scoping,
      ) => { tools: Array<{ name: string }>; warnings: string[] };
    };
    if (typeof mod.applyProfileToolScoping !== 'function') return undefined;
    const result = mod.applyProfileToolScoping(
      catalog.map((name) => ({ name })),
      scoping,
    );
    for (const w of result.warnings) {
      process.stderr.write(`[cli-agent] ${w}\n`);
    }
    return result.tools.map((t) => t.name);
  } catch {
    // Module not present yet (U-SCOPE pending) — fall back to undefined.
    return undefined;
  }
}
