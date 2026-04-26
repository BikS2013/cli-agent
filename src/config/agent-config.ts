/**
 * Configuration loader for cli-agent.
 *
 * Precedence (Policy A — shell-wins):
 *   1. Shell env vars (process.env)                   — baseline
 *   2. ~/.tool-agents/cli-agent/.env                  — per-user durable defaults
 *   3. ./.env or --env-file path                      — project-local override
 *   4. CLI flags                                       — top priority
 *
 * On first invocation: bootstraps ~/.tool-agents/cli-agent/ with mode 0700,
 * seeds a placeholder .env at mode 0600, creates logs/ (0700) and
 * capabilities/ (0700) subdirectories.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfigurationError, ProviderNotSupportedError } from '../errors.js';

export const AGENT_TOOL_NAME = 'cli-agent';

export type ProviderName =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'azure-openai'
  | 'azure-anthropic'
  | 'ollama'
  | 'litellm'
  | 'mlx';

export const SUPPORTED_PROVIDERS: ReadonlyArray<ProviderName> = [
  'openai',
  'anthropic',
  'gemini',
  'azure-openai',
  'azure-anthropic',
  'ollama',
  'litellm',
  'mlx',
];

export const CONFIG_SCHEMA_VERSION = 1;

export interface CapabilitiesConfig {
  readonly depth?: number;
  readonly maxBytesPerTool?: number;
  readonly timeoutMs?: number;
  readonly totalTimeoutMs?: number;
  readonly subcommandExtractor?: string;
  /**
   * If the top-level `--help` output is below this many bytes, the agent
   * skips the LLM-based subcommand extraction and embeds the raw help
   * verbatim in the capability document. Saves ~500-3000 ms per small
   * tool (e.g. `zip`) at the cost of slightly less structure in the
   * embedded prompt section. Set to 0 to always run the LLM extractor.
   * Default: 4096.
   */
  readonly skipLlmBelowBytes?: number;
}

export interface BashConfig {
  readonly allow?: string[];
  readonly allowedRoots?: string[];
  readonly passEnv?: string[];
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface WebSearchConfig {
  readonly backend?: string;
}

export interface FileEditConfig {
  readonly root?: string;
  readonly allowPaths?: string[];
}

/** Non-secret runtime defaults stored in config.json. */
export interface AgentConfigFile {
  readonly schemaVersion: number;
  readonly provider?: ProviderName;
  readonly model?: string;
  readonly maxSteps?: number;
  readonly temperature?: number;
  readonly allowMutations?: boolean;
  readonly verbose?: boolean;
  readonly tools?: string[];
  readonly capabilities?: CapabilitiesConfig;
  readonly bash?: BashConfig;
  readonly webSearch?: WebSearchConfig;
  readonly fileEdit?: FileEditConfig;
}

/** Frozen provider env snapshot — factories read only from this. */
export interface ProviderEnvSnapshot {
  readonly OPENAI_API_KEY: string | undefined;
  readonly OPENAI_BASE_URL: string | undefined;
  readonly OPENAI_ORG_ID: string | undefined;
  readonly ANTHROPIC_API_KEY: string | undefined;
  readonly ANTHROPIC_BASE_URL: string | undefined;
  readonly GOOGLE_API_KEY: string | undefined;
  readonly GEMINI_API_KEY: string | undefined;
  readonly AZURE_OPENAI_API_KEY: string | undefined;
  readonly AZURE_OPENAI_ENDPOINT: string | undefined;
  readonly AZURE_OPENAI_DEPLOYMENT: string | undefined;
  readonly AZURE_OPENAI_API_VERSION: string | undefined;
  readonly AZURE_AI_INFERENCE_KEY: string | undefined;
  readonly AZURE_AI_INFERENCE_ENDPOINT: string | undefined;
  readonly ANTHROPIC_FOUNDRY_API_KEY: string | undefined;
  readonly ANTHROPIC_FOUNDRY_ENDPOINT: string | undefined;
  readonly OLLAMA_HOST: string | undefined;
  readonly LITELLM_PROXY_URL: string | undefined;
  readonly LITELLM_MASTER_KEY: string | undefined;
  readonly LITELLM_API_BASE: string | undefined;
  readonly LITELLM_API_KEY: string | undefined;
}

/** Fully resolved agent configuration (one instance per invocation). */
export interface AgentConfig {
  readonly provider: ProviderName;
  readonly model: string;
  readonly maxSteps: number;
  readonly temperature: number | undefined;
  readonly allowMutations: boolean;
  readonly verbose: boolean;
  readonly agentDir: string;
  readonly capabilitiesDir: string;
  readonly logsDir: string;
  readonly providerEnv: ProviderEnvSnapshot;
  /** Merged tool list from config.json + CLI --tool flags (deduped). */
  readonly tools: ReadonlyArray<string>;
  readonly capabilities: Required<CapabilitiesConfig>;
  readonly bash: Required<BashConfig>;
  readonly webSearch: { backend: string };
  readonly fileEdit: { root: string; allowPaths: ReadonlyArray<string> };
  readonly perToolBudgetBytes: number;
  readonly baseUrl: string | undefined;
  readonly webSearchBackend: string | undefined;
  readonly bashAllow: ReadonlyArray<string>;
  readonly bashPassSecrets: ReadonlyArray<string>;
}

/** CLI flags. */
export interface AgentCliFlags {
  readonly provider?: string;
  readonly model?: string;
  readonly maxSteps?: number;
  readonly temperature?: number;
  readonly allowMutations?: boolean;
  readonly verbose?: boolean;
  readonly envFile?: string;
  readonly configFile?: string;
  readonly tools?: string[];
  readonly baseUrl?: string;
  readonly perToolBudget?: number;
  readonly webSearchBackend?: string;
  readonly bashAllow?: string[];
  readonly bashAllowFile?: string;
  readonly bashPassSecret?: string[];
  readonly introspectDepth?: number;
  readonly introspectMaxBytes?: number;
  readonly introspectTimeoutMs?: number;
  readonly introspectTotalBudgetMs?: number;
  readonly introspectSkipLlmBelowBytes?: number;
  readonly refreshCapabilities?: boolean;
  readonly system?: string;
  readonly systemFile?: string;
}

/* ---------- Paths ---------- */

export function agentToolAgentsDir(): string {
  return path.join(os.homedir(), '.tool-agents', AGENT_TOOL_NAME);
}

export function agentDotEnvPath(override?: string): string {
  return override ?? path.join(agentToolAgentsDir(), '.env');
}

export function agentCapabilitiesDir(): string {
  return path.join(agentToolAgentsDir(), 'capabilities');
}

export function agentLogsDir(): string {
  return path.join(agentToolAgentsDir(), 'logs');
}

/* ---------- Bootstrap ---------- */

export async function bootstrapAgentDir(dir?: string): Promise<void> {
  const agentDir = dir ?? agentToolAgentsDir();
  const envPath = path.join(agentDir, '.env');
  const logsDir = path.join(agentDir, 'logs');
  const capabilitiesDir = path.join(agentDir, 'capabilities');

  await fsp.mkdir(agentDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(agentDir, 0o700); } catch { /* tolerated on Windows */ }

  await fsp.mkdir(logsDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(logsDir, 0o700); } catch { /* tolerated */ }

  await fsp.mkdir(capabilitiesDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(capabilitiesDir, 0o700); } catch { /* tolerated */ }

  // Seed .env only if absent
  let envExists = false;
  try {
    await fsp.access(envPath, fs.constants.F_OK);
    envExists = true;
  } catch { envExists = false; }

  if (!envExists) {
    // Seed with all placeholders commented — never write real values
    const placeholder = [
      '# cli-agent environment configuration',
      '# All credential lines are commented out — uncomment and fill in only what you need.',
      '# NEVER set a default/fallback value; the agent raises an exception on missing required vars.',
      '#',
      '# --- OpenAI ---',
      '# OPENAI_API_KEY=',
      '# OPENAI_BASE_URL=',
      '# OPENAI_ORG_ID=',
      '#',
      '# --- Anthropic ---',
      '# ANTHROPIC_API_KEY=',
      '# ANTHROPIC_BASE_URL=',
      '#',
      '# --- Gemini ---',
      '# GOOGLE_API_KEY=',
      '# GEMINI_API_KEY=',
      '#',
      '# --- Azure OpenAI ---',
      '# AZURE_OPENAI_API_KEY=',
      '# AZURE_OPENAI_ENDPOINT=',
      '# AZURE_OPENAI_DEPLOYMENT=',
      '# AZURE_OPENAI_API_VERSION=',
      '#',
      '# --- Azure Anthropic (Foundry) ---',
      '# AZURE_AI_INFERENCE_KEY=',
      '# AZURE_AI_INFERENCE_ENDPOINT=',
      '# ANTHROPIC_FOUNDRY_API_KEY=',
      '# ANTHROPIC_FOUNDRY_ENDPOINT=',
      '#',
      '# --- Ollama ---',
      '# OLLAMA_HOST=',
      '#',
      '# --- LiteLLM ---',
      '# LITELLM_PROXY_URL=',
      '# LITELLM_MASTER_KEY=',
      '# LITELLM_API_BASE=',
      '# LITELLM_API_KEY=',
      '#',
      '# --- Web search backends ---',
      '# WEB_SEARCH_BACKEND=',
      '# TAVILY_API_KEY=',
      '# SERPAPI_API_KEY=',
      '# BRAVE_API_KEY=',
      '# WEB_SEARCH_URL=',
      '# WEB_SEARCH_API_KEY=',
      '# WEB_SEARCH_MAX_REQUESTS=',
      '#',
      '# --- Bash tool ---',
      '# BASH_ALLOWED_COMMANDS=',
      '#',
      '# --- File tool ---',
      '# FILE_EDIT_ROOT=',
      '#',
      '# --- Logging ---',
      '# CLI_AGENT_LOG=',
      '',
    ].join('\n');
    try {
      await fsp.writeFile(envPath, placeholder, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'EEXIST') throw e;
    }
  }
  try { await fsp.chmod(envPath, 0o600); } catch { /* tolerated */ }
}

/* ---------- Minimal .env parser (no external dep) ---------- */

function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice(7) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (key.length === 0) continue;
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
        (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      const q = value[0]!;
      const inner = value.slice(1, -1);
      value = q === '"'
        ? inner.replace(/\\([nrt"\\])/g, (_m, c: string) => {
            switch (c) {
              case 'n': return '\n';
              case 'r': return '\r';
              case 't': return '\t';
              default: return c;
            }
          })
        : inner;
    } else {
      const hi = value.indexOf(' #');
      if (hi >= 0) value = value.slice(0, hi).trimEnd();
    }
    out[key] = value;
  }
  return out;
}

async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return parseDotEnv(raw);
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return {};
    throw e;
  }
}

/* ---------- config.json loading ---------- */

async function readConfigFile(filePath: string): Promise<AgentConfigFile | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const sv = parsed['schemaVersion'];
    if (typeof sv === 'number' && sv !== CONFIG_SCHEMA_VERSION) {
      throw new ConfigurationError(
        `config.json schemaVersion`,
        [`~/.tool-agents/${AGENT_TOOL_NAME}/config.json`],
        {
          detail: `schemaVersion ${String(sv)} is not supported. Expected ${CONFIG_SCHEMA_VERSION}. Please update your config.json.`,
        },
      );
    }
    return parsed as unknown as AgentConfigFile;
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
}

/* ---------- Provider env snapshot builder ---------- */

const PROVIDER_ENV_KEYS = [
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ORG_ID',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL',
  'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_API_VERSION',
  'AZURE_AI_INFERENCE_KEY', 'AZURE_AI_INFERENCE_ENDPOINT',
  'ANTHROPIC_FOUNDRY_API_KEY', 'ANTHROPIC_FOUNDRY_ENDPOINT',
  'OLLAMA_HOST',
  'LITELLM_PROXY_URL', 'LITELLM_MASTER_KEY', 'LITELLM_API_BASE', 'LITELLM_API_KEY',
] as const;

const OTHER_ENV_KEYS = [
  'AGENT_PROVIDER', 'AGENT_MODEL', 'AGENT_ALLOW_MUTATIONS',
  'WEB_SEARCH_BACKEND', 'BASH_ALLOWED_COMMANDS', 'FILE_EDIT_ROOT', 'CLI_AGENT_LOG',
  'WEB_SEARCH_URL', 'WEB_SEARCH_API_KEY',
  'TAVILY_API_KEY', 'SERPAPI_API_KEY', 'BRAVE_API_KEY', 'WEB_SEARCH_MAX_REQUESTS',
] as const;

const ALL_ENV_KEYS = [...PROVIDER_ENV_KEYS, ...OTHER_ENV_KEYS] as const;

function buildProviderEnv(layered: Record<string, string | undefined>): ProviderEnvSnapshot {
  return Object.freeze({
    OPENAI_API_KEY: layered['OPENAI_API_KEY'],
    OPENAI_BASE_URL: layered['OPENAI_BASE_URL'],
    OPENAI_ORG_ID: layered['OPENAI_ORG_ID'],
    ANTHROPIC_API_KEY: layered['ANTHROPIC_API_KEY'],
    ANTHROPIC_BASE_URL: layered['ANTHROPIC_BASE_URL'],
    GOOGLE_API_KEY: layered['GOOGLE_API_KEY'],
    GEMINI_API_KEY: layered['GEMINI_API_KEY'],
    AZURE_OPENAI_API_KEY: layered['AZURE_OPENAI_API_KEY'],
    AZURE_OPENAI_ENDPOINT: layered['AZURE_OPENAI_ENDPOINT'],
    AZURE_OPENAI_DEPLOYMENT: layered['AZURE_OPENAI_DEPLOYMENT'],
    AZURE_OPENAI_API_VERSION: layered['AZURE_OPENAI_API_VERSION'],
    AZURE_AI_INFERENCE_KEY: layered['AZURE_AI_INFERENCE_KEY'],
    AZURE_AI_INFERENCE_ENDPOINT: layered['AZURE_AI_INFERENCE_ENDPOINT'],
    ANTHROPIC_FOUNDRY_API_KEY: layered['ANTHROPIC_FOUNDRY_API_KEY'],
    ANTHROPIC_FOUNDRY_ENDPOINT: layered['ANTHROPIC_FOUNDRY_ENDPOINT'],
    OLLAMA_HOST: layered['OLLAMA_HOST'],
    LITELLM_PROXY_URL: layered['LITELLM_PROXY_URL'],
    LITELLM_MASTER_KEY: layered['LITELLM_MASTER_KEY'],
    LITELLM_API_BASE: layered['LITELLM_API_BASE'],
    LITELLM_API_KEY: layered['LITELLM_API_KEY'],
  });
}

/* ---------- Bash allowlist file reader ---------- */

async function readBashAllowFile(filePath: string): Promise<string[]> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return [];
    throw e;
  }
}

/* ---------- Main loader ---------- */

export const EMPTY_FLAGS: AgentCliFlags = {};

export async function loadAgentConfig(
  flags: AgentCliFlags = EMPTY_FLAGS,
  opts: { shellEnv?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<AgentConfig> {
  const agentDir = agentToolAgentsDir();
  await bootstrapAgentDir(agentDir);

  const shellEnv = opts.shellEnv ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  // Layer 1: shell env (baseline — Policy A: shell wins)
  const layered: Record<string, string | undefined> = {};
  for (const k of ALL_ENV_KEYS) {
    const v = shellEnv[k];
    if (v !== undefined) layered[k] = v;
  }

  // Layer 2: ~/.tool-agents/cli-agent/.env (fills gaps only — override:false semantics)
  const agentEnvPath = flags.envFile ?? agentDotEnvPath();
  const agentEnvVars = await readEnvFile(agentEnvPath);
  for (const k of ALL_ENV_KEYS) {
    const v = agentEnvVars[k];
    if (v !== undefined && layered[k] === undefined) layered[k] = v;
  }

  // Layer 3: ./.env (local, also fills gaps)
  const localEnvPath = path.join(cwd, '.env');
  if (path.resolve(localEnvPath) !== path.resolve(agentEnvPath)) {
    const localEnvVars = await readEnvFile(localEnvPath);
    for (const k of ALL_ENV_KEYS) {
      const v = localEnvVars[k];
      if (v !== undefined && layered[k] === undefined) layered[k] = v;
    }
  }

  // Load config.json
  const configFilePath = flags.configFile ?? path.join(agentDir, 'config.json');
  const configFile = await readConfigFile(configFilePath);

  // Layer 4: CLI flags override everything.
  const provider = resolveProvider(
    flags.provider ?? layered['AGENT_PROVIDER'] ?? configFile?.provider,
  );

  const model =
    flags.model ??
    layered['AGENT_MODEL'] ??
    configFile?.model ??
    defaultModelForProvider(provider) ??
    '';

  const maxSteps = flags.maxSteps ?? configFile?.maxSteps ?? 25;
  const temperature = flags.temperature ?? configFile?.temperature;

  let allowMutations: boolean;
  if (flags.allowMutations !== undefined) {
    allowMutations = flags.allowMutations;
  } else if (layered['AGENT_ALLOW_MUTATIONS'] !== undefined) {
    allowMutations = parseBooleanEnvVar(layered['AGENT_ALLOW_MUTATIONS'], 'AGENT_ALLOW_MUTATIONS');
  } else {
    allowMutations = configFile?.allowMutations ?? false;
  }

  const verbose = flags.verbose ?? configFile?.verbose ?? false;

  // Tools: CLI flags are ADDITIVE over config.json (unique merge)
  const configTools = configFile?.tools ?? [];
  const cliTools = flags.tools ?? [];
  const tools = [...new Set([...configTools, ...cliTools])];

  // Capabilities config
  const capConfig = configFile?.capabilities ?? {};
  const capabilities: Required<CapabilitiesConfig> = {
    depth: flags.introspectDepth ?? capConfig.depth ?? 2,
    maxBytesPerTool: flags.introspectMaxBytes ?? capConfig.maxBytesPerTool ?? 10240,
    timeoutMs: flags.introspectTimeoutMs ?? capConfig.timeoutMs ?? 5000,
    totalTimeoutMs: flags.introspectTotalBudgetMs ?? capConfig.totalTimeoutMs ?? 60000,
    subcommandExtractor: capConfig.subcommandExtractor ?? '',
    skipLlmBelowBytes: flags.introspectSkipLlmBelowBytes ?? capConfig.skipLlmBelowBytes ?? 4096,
  };

  // Bash config
  const bashConfig = configFile?.bash ?? {};
  const envBashAllow = layered['BASH_ALLOWED_COMMANDS']
    ? layered['BASH_ALLOWED_COMMANDS'].split(',').map((s) => s.trim()).filter(Boolean)
    : [];
  const flagBashAllow = flags.bashAllow ?? [];
  const fileBashAllow = flags.bashAllowFile ? await readBashAllowFile(flags.bashAllowFile) : [];
  const configBashAllow = bashConfig.allow ?? [];
  const mergedBashAllow = [...new Set([...configBashAllow, ...envBashAllow, ...flagBashAllow, ...fileBashAllow, ...tools])];

  const bash: Required<BashConfig> = {
    allow: mergedBashAllow,
    allowedRoots: bashConfig.allowedRoots ?? [cwd],
    passEnv: bashConfig.passEnv ?? ['PATH', 'HOME', 'LANG', 'TERM'],
    timeoutMs: bashConfig.timeoutMs ?? 30000,
    maxOutputBytes: bashConfig.maxOutputBytes ?? 1048576,
  };

  // Web search config
  const webSearchConfig = configFile?.webSearch ?? {};
  const webSearchBackend =
    flags.webSearchBackend ??
    layered['WEB_SEARCH_BACKEND'] ??
    webSearchConfig.backend ??
    'tavily';

  // File edit config
  const fileEditConfig = configFile?.fileEdit ?? {};
  const fileEditRoot =
    layered['FILE_EDIT_ROOT'] ??
    fileEditConfig.root ??
    cwd;

  return {
    provider,
    model,
    maxSteps,
    temperature,
    allowMutations,
    verbose,
    agentDir,
    capabilitiesDir: path.join(agentDir, 'capabilities'),
    logsDir: path.join(agentDir, 'logs'),
    providerEnv: buildProviderEnv(layered),
    tools,
    capabilities,
    bash,
    webSearch: { backend: webSearchBackend },
    fileEdit: {
      root: fileEditRoot,
      allowPaths: fileEditConfig.allowPaths ?? [],
    },
    perToolBudgetBytes: flags.perToolBudget ?? 8192,
    baseUrl: flags.baseUrl,
    webSearchBackend,
    bashAllow: mergedBashAllow,
    bashPassSecrets: flags.bashPassSecret ?? [],
  };
}

function resolveProvider(raw: string | undefined): ProviderName {
  if (!raw) {
    throw new ConfigurationError('provider', [
      'CLI --provider',
      'env:AGENT_PROVIDER',
      `~/.tool-agents/${AGENT_TOOL_NAME}/.env`,
      `~/.tool-agents/${AGENT_TOOL_NAME}/config.json provider`,
    ]);
  }
  if (!SUPPORTED_PROVIDERS.includes(raw as ProviderName)) {
    throw new ProviderNotSupportedError(raw);
  }
  return raw as ProviderName;
}

function parseBooleanEnvVar(raw: string, name: string): boolean {
  const v = raw.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  throw new ConfigurationError(name, [
    `env:${name} must be one of true|false|1|0|yes|no|on|off (got '${raw}')`,
  ]);
}

function defaultModelForProvider(provider: ProviderName): string | undefined {
  // Return provider-known sensible defaults where they exist.
  // Empty string means the user MUST supply the model.
  const defaults: Record<ProviderName, string | undefined> = {
    openai: 'gpt-4o',
    anthropic: 'claude-3-5-sonnet-20241022',
    gemini: 'gemini-2.0-flash',
    'azure-openai': undefined,
    'azure-anthropic': undefined,
    ollama: undefined,
    litellm: undefined,
    mlx: undefined,
  };
  return defaults[provider];
}

/** Helper for provider factories: read a required value from the env snapshot. */
export function requireProviderEnv(
  env: ProviderEnvSnapshot,
  key: keyof ProviderEnvSnapshot,
  _provider: string,
): string {
  const value = env[key];
  if (!value) {
    throw new ConfigurationError(key, [
      `env:${key}`,
      `~/.tool-agents/${AGENT_TOOL_NAME}/.env`,
      `~/.tool-agents/${AGENT_TOOL_NAME}/config.json`,
    ]);
  }
  return value;
}

/** Check if logging is disabled via CLI_AGENT_LOG env var. */
export function isLoggingDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env['CLI_AGENT_LOG'];
  if (typeof raw !== 'string') return false;
  const v = raw.trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false' || v === 'no';
}
