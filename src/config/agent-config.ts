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
import { ConfigurationError, ProviderNotSupportedError, UsageError } from '../errors.js';
import { BUILTIN_DEFAULT_SYSTEM_PROMPT, LEGACY_DEFAULT_SYSTEM_PROMPTS } from '../agent/system-prompt.js';
import { BUILTIN_TOOL_PROMPTS } from '../agent/tools/tool-prompts-builtin.js';
import {
  loadOverlayRegistry,
  serializeOverlay,
  type OverlayRegistry,
} from '../agent/tools/tool-prompt-overlay.js';
import { loadProfile } from './profile-loader.js';
import type {
  ProfileCliParams,
  ProfileTools,
  ProfileToolArgs,
} from './profile-schema.js';
import {
  AGENT_MODES,
  isAgentMode,
  modeToGroups,
  MODE_MIGRATION_HINT,
  type AgentMode,
} from './mode.js';

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

/** Resolved web-search runtime snapshot. Web tools read only from this. */
export interface ResolvedWebSearchConfig {
  readonly backend: string;
  readonly tavilyApiKey?: string;
  readonly serpApiKey?: string;
  readonly braveApiKey?: string;
  readonly customHttpUrl?: string;
  readonly customHttpApiKey?: string;
  readonly maxRequests: number;
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
  /** Selects the BASE system prompt file. Same resolution rules as the
   * `--system-prompt` CLI flag (absolute / bare filename / relative). */
  readonly systemPromptFile?: string;
  /** Agent-tools pack (curated subset of BikS2013/agent-tools). Each
   * per-tool boolean opts the specific wrapper in or out of the registered
   * catalog. All fields are OPTIONAL on the file shape — defaults are
   * applied during resolution (see `loadAgentConfig`). The defaults are
   * explicit starting values, NOT runtime fallbacks for missing required
   * config. NOTE (plan-015): the former `enabled` umbrella key was removed
   * — whether the pack loads at all is decided by the `mode` knob; a
   * present `agentTools.enabled` key is rejected with a migration hint. */
  readonly agentTools?: {
    readonly tools?: {
      readonly glob?: boolean;
      readonly grep?: boolean;
      readonly multiedit?: boolean;
      readonly patch?: boolean;
      readonly todoRead?: boolean;
      readonly todoWrite?: boolean;
      readonly webSearch?: boolean;
      readonly webFetch?: boolean;
      /** First-party file wrappers (plan-012). Re-homed from the former
       * built-in file_* tools; reuse the sandbox. read/list read-only,
       * write/edit/append mutation-gated downstream. */
      readonly fileRead?: boolean;
      readonly fileList?: boolean;
      readonly fileWrite?: boolean;
      readonly fileEdit?: boolean;
      readonly fileAppend?: boolean;
    };
  };
  /** Agent mode knob (plan-015). config.json tier of the pinnable chain
   * CLI --mode > env CLI_AGENT_MODE > profile cliParams.mode > config.json
   * mode > default 'composite'. One of chat|basic|tool|composite; an
   * invalid value is rejected during resolution (no fallback). NOTE: the
   * former plan-008 group-toggle keys (`composites`, `builtinTools`) were
   * removed — a present key is rejected with a migration hint. */
  readonly mode?: string;
  /** Optional override for the tool-prompt overlay directory. When unset
   * the resolver computes `<agentDir>/tool-prompts/`. Same path-resolution
   * rules as the system prompt: absolute path → verbatim; bare folder
   * name → joined onto `agentDir`; relative path with separators →
   * resolved against `process.cwd()`. */
  readonly toolPromptsDir?: string;
  /** LLM I/O inspector (plan-007). All fields OPTIONAL on the file
   * shape; resolution applies them in `loadAgentConfig`. `enabled`
   * turns the capture channel on (config.json tier — lowest priority
   * of the three explicit tiers). `redact: false` opts out of
   * redaction for captures only. `dir` overrides the default capture
   * directory (`<agentDir>/io-captures/`). These are explicit user
   * settings, NOT runtime fallbacks for missing required config. */
  readonly inspectIo?: { enabled?: boolean; redact?: boolean; dir?: string };
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
  /** Canonical schema-3 composite capability docs root (plan-006 §14.F).
   * Always populated by `loadAgentConfig`; created at mode 0o700 by
   * `bootstrapAgentDir`. */
  readonly compositeCapabilitiesDir: string;
  /** Stage-1 per-member distillation cache (plan-006 §14.F). Filenames
   * follow `<member>@<digest16>.json`. Always populated. */
  readonly compositeDistillDir: string;
  /** Per-composite manifest + wrapper-shim folder root (plan-006
   * §14.F). Always populated. */
  readonly compositesDir: string;
  /** Resolved view of the LLM I/O inspector switch (plan-007).
   * `null` when the inspector is NOT requested — the normal disabled
   * state, distinct from a misconfiguration. When requested, a fully
   * populated object: `enabled` is always `true`, `redact` reflects
   * the raw opt-out, and `dir` is the (created, writable) capture
   * directory. NEVER silently defaulted: an explicitly-requested-but-
   * uninitialisable inspector raises `ConfigurationError` in
   * `loadAgentConfig` (FR-10), so this field is `null` ONLY when the
   * switch is off, never as a fallback. */
  readonly inspectIo: { enabled: boolean; redact: boolean; dir: string } | null;
  readonly providerEnv: ProviderEnvSnapshot;
  /** Merged tool list from config.json + CLI --tool flags (deduped). */
  readonly tools: ReadonlyArray<string>;
  readonly capabilities: Required<CapabilitiesConfig>;
  readonly bash: Required<BashConfig>;
  readonly webSearch: ResolvedWebSearchConfig;
  readonly fileEdit: { root: string; allowPaths: ReadonlyArray<string> };
  readonly perToolBudgetBytes: number;
  readonly baseUrl: string | undefined;
  readonly webSearchBackend: string | undefined;
  readonly bashAllow: ReadonlyArray<string>;
  readonly bashPassSecrets: ReadonlyArray<string>;
  /** Absolute path to the BASE system prompt file. Always populated and
   * always existing on disk — `loadAgentConfig` raises a `UsageError` if
   * the user-selected file is unreadable. */
  readonly systemPromptPath: string;
  /** Optional inline addendum (`--system <text>`). Appended verbatim. */
  readonly systemAppendText: string | undefined;
  /** Optional file addendum (`--system-file <path>`). Read by callers. */
  readonly systemAppendFile: string | undefined;
  /** Resolved view of the agent-tools pack settings. ALWAYS present on the
   * resolved config — defaults are applied at the end of the four-tier
   * precedence chain in `loadAgentConfig`. The defaults are explicit
   * starting values, NOT runtime fallbacks for missing required config. */
  readonly agentTools: {
    readonly enabled: boolean;
    readonly tools: {
      readonly glob: boolean;
      readonly grep: boolean;
      readonly multiedit: boolean;
      readonly patch: boolean;
      readonly todoRead: boolean;
      readonly todoWrite: boolean;
      /** First-party web wrappers (plan-011). Read-only; default true. */
      readonly webSearch: boolean;
      readonly webFetch: boolean;
      /** First-party file wrappers (plan-012). Re-homed from the former
       * built-in file_* tools, reusing the sandbox. read/list read-only;
       * write/edit/append default-on but mutation-gated in group-builder. */
      readonly fileRead: boolean;
      readonly fileList: boolean;
      readonly fileWrite: boolean;
      readonly fileEdit: boolean;
      readonly fileAppend: boolean;
    };
  };
  /** Resolved tool-group booleans (internal representation). ALWAYS
   * present on the resolved config. Since plan-015 these are produced
   * EXCLUSIVELY by the mode knob's expansion (`modeToGroups`), so exactly
   * four combinations are reachable (chat/basic/tool/composite) and
   * `deriveModeFromGroups` is an exact inverse.
   *   composites   → when false, no virtual/composite tools are loaded.
   *   builtinTools → when false, the cross-cutting toolkit
   *                  (bash_*, tool_help) is not built. NOTE this also
   *                  removes bash_run — the path used to run wrapped CLIs. */
  readonly composites: boolean;
  readonly builtinTools: boolean;
  /** Absolute path to the tool-prompt overlay directory. Always populated
   * by `loadAgentConfig` — resolved from config.json override or
   * `<agentDir>/tool-prompts/`. The directory is created during
   * bootstrap and seeded with one `.md` file per built-in tool.
   *
   * Marked optional on the static type to keep older test fixtures
   * type-compatible; production code reads this field via
   * `loadAgentConfig`, which always populates it. */
  readonly toolPromptsDir?: string;
  /** Loaded overlay registry. Always populated by `loadAgentConfig`
   * (frozen empty registry when no overlay files exist). Tool factories
   * consult this via `getToolDescription` / `getParamDescription` to
   * produce the effective LLM-visible description text.
   *
   * Marked optional on the static type to keep older test fixtures
   * type-compatible. The runtime helpers tolerate `undefined` and
   * fall through to the built-in default. */
  readonly toolPromptOverlays?: OverlayRegistry;
  /** Active configuration profile metadata (plan-005). Populated by
   * `loadAgentConfig` ONLY when `--profile` or `CLI_AGENT_PROFILE` is
   * set. Carries identification + reproducibility audit fields; does
   * NOT carry the typed sub-trees (those live on `activeProfileData`). */
  readonly activeProfile?: {
    readonly name: string;
    readonly path: string;
    readonly schemaVersion: number;
    readonly digest: string;
  };
  /** Active profile typed sub-trees (plan-005). Populated alongside
   * `activeProfile`. Downstream consumers:
   *   - per-knob expressions in `loadAgentConfig` consult `cliParams` (tier 5).
   *   - `applyProfileToolScoping` consumes `tools` (U-SCOPE).
   *   - `mergeProfileToolArgs` consumes `toolArgs` via `runConfig.configurable` (U-ARGS).
   */
  readonly activeProfileData?: {
    readonly cliParams?: ProfileCliParams;
    readonly tools?: ProfileTools;
    readonly toolArgs?: ProfileToolArgs;
  };
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
  /** Selects the BASE system prompt file. Three resolution forms:
   *   absolute path → use verbatim
   *   bare filename → resolved against `cfg.capabilitiesDir`
   *   relative path with separators → resolved against `process.cwd()`
   * Omitting the flag falls through to env / config.json / the seeded
   * default at `<capabilitiesDir>/system-prompt.md`. */
  readonly systemPromptFile?: string;
  /** Agent-tools pack per-tool overrides (CLI tier — highest priority),
   * produced by the generic `--enable-tool <name>` / `--disable-tool <name>`
   * pair (plan-015). Each field is tri-state: `true` enables, `false`
   * disables, `undefined` defers to the next tier (env → config.json →
   * default). Conflicts (the same tool named in both flags) and unknown
   * tool names MUST be detected by the CLI mapper and surfaced as a
   * `UsageError` BEFORE reaching this shape — `mapAgentToolFlags` in
   * `src/cli-agent-tools-flags.ts` is the gatekeeper. NOTE (plan-015): the
   * former `enabled` umbrella member was removed — the pack's presence is
   * decided by the `mode` knob. */
  readonly agentTools?: {
    readonly tools?: {
      readonly glob?: boolean;
      readonly grep?: boolean;
      readonly multiedit?: boolean;
      readonly patch?: boolean;
      readonly todoRead?: boolean;
      readonly todoWrite?: boolean;
      readonly webSearch?: boolean;
      readonly webFetch?: boolean;
      /** First-party file wrappers (plan-012). */
      readonly fileRead?: boolean;
      readonly fileList?: boolean;
      readonly fileWrite?: boolean;
      readonly fileEdit?: boolean;
      readonly fileAppend?: boolean;
    };
  };
  /** Agent mode knob (plan-015) — CLI tier (highest priority) of the
   * pinnable chain. Raw string from Commander, pre-validated by
   * `parseModeFlag` in `src/cli.ts` (UsageError on a non-mode value);
   * `resolveMode` re-validates defensively for non-Commander callers.
   * `undefined` defers to env CLI_AGENT_MODE → profile cliParams.mode →
   * config.json mode → default 'composite'. Replaces the removed plan-008
   * group-toggle flags (`--composites`/`--builtin-tools`/`--agent-tools`
   * and their `--no-*` forms). */
  readonly mode?: string;
  /** Activate a named configuration profile (plan-005). When set the
   * loader resolves `<agentDir>/profiles/<name>.{yaml|yml|json}` and
   * threads `cliParams` into the per-knob precedence chain at tier 5.
   * Equivalent env var: `CLI_AGENT_PROFILE`. CLI flag wins (E12). */
  readonly profile?: string;
  /* ---------- Composite-intelligent-tools flags (plan-006 P3) ----------
   *
   * Foundation declarations only — wired through Commander in U-FLAGS
   * (Phase 6). Help-interception logic is implemented in P4. The
   * subset below is what U-FLAGS / U-CMD parses and what
   * `enforceCompositeFlagMatrix` validates against §14.H.
   */
  /** When `--treat-as-tool` is present, the default-command `--help`
   * branch hands off to the composite synthesis pipeline (or rejects
   * with `UsageError` when no `--tool` is supplied). */
  readonly treatAsTool?: boolean;
  /** Explicit composite-id override (FR-CMP-011). When omitted, U-CMD
   * derives the name from the sorted member list. */
  readonly compositeName?: string;
  /** Emit a schema-3 composite capability doc into
   * `<agentDir>/capabilities/composite/<id>.md` (form a). Default
   * true with `--treat-as-tool`; opt-out via `--no-emit-doc`. */
  readonly emitDoc?: boolean;
  /** Emit a POSIX wrapper shim under `<agentDir>/composites/<id>/<id>`
   * (form b). Opt-in. */
  readonly emitWrapper?: boolean;
  /** Additionally place a symlink at `~/.local/bin/<id>` so the
   * composite is invocable from PATH. Implies `--emit-wrapper`. */
  readonly emitWrapperOnPath?: boolean;
  /** Register the composite as a virtual tool (form c) — writes a
   * manifest the `loadVirtualTools` registry consumes. Opt-in. */
  readonly registerVirtual?: boolean;
  /** Force re-synthesis even when the cache key matches; preserves
   * USER-RECIPES / USER-NOTES blocks across rewrite. */
  readonly regenerateCapabilities?: boolean;
  /** Emit the prompts that WOULD be sent to the LLM, exit 0 without
   * spending a token. */
  readonly dryRunSynthesis?: boolean;
  /** Combined Stage-1 + Stage-2 token cap for the synthesis pipeline.
   * Defaults to 32_768 in U-FLAGS. */
  readonly synthesisBudgetTokens?: number;
  /** Overwrite an existing composite of the same name without
   * prompting (FR-CMP-017). */
  readonly forceOverwrite?: boolean;
  /** Manual `--help` flag (P4 migrates Commander's auto-help to a
   * manual flag so the composite branch can intercept). */
  readonly help?: boolean;
  /* ---------- LLM I/O inspector flags (plan-007) ----------
   *
   * Diagnostic switch that captures the EXACT provider-normalized
   * request (assembled system prompt + full in-thread memory + current
   * user content + bound tool/function JSON schemas) and response
   * (assistant text + parsed tool-calls + tool results) for every LLM
   * turn to a tailable JSONL file. Both fields are tri-state: `true`
   * forces on; `undefined` defers to env (`CLI_AGENT_INSPECT_IO` /
   * `CLI_AGENT_INSPECT_IO_RAW`) → config.json (`inspectIo`) → off.
   * Resolution is no-fallback: an explicitly-requested-but-
   * uninitialisable inspector raises `ConfigurationError`, never a
   * silent downgrade (FR-10). */
  /** `--inspect-io` — enable the LLM I/O capture channel. */
  readonly inspectIo?: boolean;
  /** `--inspect-io-raw` — disable redaction for the capture channel
   * only (prints a prominent stderr warning before any byte is
   * written). */
  readonly inspectIoRaw?: boolean;
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

/* ---------- Composite-tool paths (plan-006 P3) ----------
 *
 * Three new directories owned by the composite-intelligent-tools
 * subsystem. All under the existing per-user agent dir so they inherit
 * the same 0o700 / 0o600 mode discipline. Mirrors the existing
 * `agentCapabilitiesDir` / `agentToolAgentsDir` pattern.
 */

/**
 * Canonical schema-3 composite capability docs live here, one
 * `<composite-id>.md` per registered composite. Mirror copies are
 * additionally written into `agentCapabilitiesDir()` so the existing
 * `composeCapabilitiesSystemPrompt` reader picks them up unchanged
 * (ADR-CMP-12).
 */
export function agentCompositeCapabilitiesDir(): string {
  return path.join(agentCapabilitiesDir(), 'composite');
}

/**
 * Stage-1 per-member distillation cache. Filenames follow
 * `<member>@<digest16>.json`; contents are `Stage1Distillation` JSON
 * objects (see `src/agent/composite/types.ts`).
 */
export function agentCompositeDistillDir(): string {
  return path.join(agentCompositeCapabilitiesDir(), '_distill');
}

/**
 * Per-composite manifest + wrapper-shim folder root. Each registered
 * composite owns its own `<composite-id>/` subdirectory inside this
 * root.
 */
export function agentCompositesDir(): string {
  return path.join(agentToolAgentsDir(), 'composites');
}

/** Reserved filename inside capabilitiesDir for the BASE system prompt.
 * The capability cache reads files by exact tool name (`<tool>.md`) so
 * this only collides if someone wraps a CLI literally named
 * `system-prompt` — accepted edge case. */
export const SYSTEM_PROMPT_FILENAME = 'system-prompt.md';

export function defaultSystemPromptPath(): string {
  return path.join(agentCapabilitiesDir(), SYSTEM_PROMPT_FILENAME);
}

export function agentLogsDir(): string {
  return path.join(agentToolAgentsDir(), 'logs');
}

/** Default directory for LLM I/O inspector captures (plan-007).
 * Mirrors `agentLogsDir()`. Created at mode 0o700 by
 * `bootstrapAgentDir`; can be overridden per-run via
 * `config.json` `inspectIo.dir`. */
export function agentIoCapturesDir(): string {
  return path.join(agentToolAgentsDir(), 'io-captures');
}

/* ---------- Bootstrap ---------- */

export async function bootstrapAgentDir(
  dir?: string,
  opts: { toolPromptsDir?: string; seedToolPrompts?: boolean } = {},
): Promise<void> {
  const agentDir = dir ?? agentToolAgentsDir();
  const envPath = path.join(agentDir, '.env');
  const logsDir = path.join(agentDir, 'logs');
  const ioCapturesDir = path.join(agentDir, 'io-captures');
  const capabilitiesDir = path.join(agentDir, 'capabilities');
  const toolPromptsDir = opts.toolPromptsDir ?? path.join(agentDir, 'tool-prompts');
  const seedToolPrompts = opts.seedToolPrompts ?? true;

  await fsp.mkdir(agentDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(agentDir, 0o700); } catch { /* tolerated on Windows */ }

  await fsp.mkdir(logsDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(logsDir, 0o700); } catch { /* tolerated */ }

  // LLM I/O inspector capture directory (plan-007). Additive: directory
  // only, never seeded. Mode 0o700 matches the logs/ privacy invariant
  // — captures can contain the full system prompt + memory + tool args.
  await fsp.mkdir(ioCapturesDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(ioCapturesDir, 0o700); } catch { /* tolerated */ }

  await fsp.mkdir(capabilitiesDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(capabilitiesDir, 0o700); } catch { /* tolerated */ }

  // Profiles directory (plan-005). Additive: directory only, never seeded.
  const profilesDir = path.join(agentDir, 'profiles');
  await fsp.mkdir(profilesDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(profilesDir, 0o700); } catch { /* tolerated */ }

  // Composite directories (plan-006 §14.F). Additive: directories only,
  // never seeded. All at mode 0o700 so the per-user privacy invariant
  // matches the existing capabilities/ tree. The order matters only
  // because `<capabilities>/composite/_distill` is nested two levels
  // deep — `recursive: true` already handles that — but we still call
  // `mkdir` per-level to make the chmod calls explicit per directory.
  const compositeCapabilitiesDir = path.join(capabilitiesDir, 'composite');
  await fsp.mkdir(compositeCapabilitiesDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(compositeCapabilitiesDir, 0o700); } catch { /* tolerated */ }
  const compositeDistillDir = path.join(compositeCapabilitiesDir, '_distill');
  await fsp.mkdir(compositeDistillDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(compositeDistillDir, 0o700); } catch { /* tolerated */ }
  const compositesDir = path.join(agentDir, 'composites');
  await fsp.mkdir(compositesDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(compositesDir, 0o700); } catch { /* tolerated */ }

  if (seedToolPrompts) {
    await bootstrapToolPromptsDir(toolPromptsDir);
  }

  // Seed .env only if absent
  let envExists = false;
  try {
    await fsp.access(envPath, fs.constants.F_OK);
    envExists = true;
  } catch { envExists = false; }

  // Seed system-prompt.md only if absent. Built-in default is the
  // bootstrap source; it is NOT a runtime fallback (see system-prompt.ts).
  const systemPromptPath = path.join(capabilitiesDir, SYSTEM_PROMPT_FILENAME);
  let systemPromptExists = false;
  try {
    await fsp.access(systemPromptPath, fs.constants.F_OK);
    systemPromptExists = true;
  } catch { systemPromptExists = false; }

  if (!systemPromptExists) {
    try {
      await fsp.writeFile(systemPromptPath, BUILTIN_DEFAULT_SYSTEM_PROMPT, { mode: 0o600, flag: 'wx' });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'EEXIST') throw e;
    }
  } else {
    // In-place upgrade (plan-009): if the existing system-prompt.md is an
    // UNMODIFIED prior default (byte-exactly equal to any entry in
    // LEGACY_DEFAULT_SYSTEM_PROMPTS), overwrite it with the new slim
    // BUILTIN_DEFAULT_SYSTEM_PROMPT so the built-in tool instructions move
    // into the runtime conditional block. If it differs at all (user-
    // customized, or already the new slim default) → leave it UNTOUCHED.
    // This is NOT a runtime fallback; a missing/unreadable selected prompt
    // still raises UsageError at load time. Never throw from the upgrade —
    // a failed upgrade simply leaves the existing file in place.
    try {
      const existing = await fsp.readFile(systemPromptPath, 'utf8');
      if (
        existing !== BUILTIN_DEFAULT_SYSTEM_PROMPT &&
        LEGACY_DEFAULT_SYSTEM_PROMPTS.includes(existing)
      ) {
        await fsp.writeFile(systemPromptPath, BUILTIN_DEFAULT_SYSTEM_PROMPT, { mode: 0o600 });
      }
    } catch { /* tolerated — leave the existing file untouched on any error */ }
  }
  try { await fsp.chmod(systemPromptPath, 0o600); } catch { /* tolerated */ }

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
      '#',
      '# --- System prompt selection ---',
      '# Absolute path, bare filename (resolved under capabilities/), or relative path.',
      '# CLI_AGENT_SYSTEM_PROMPT=',
      '#',
      '# --- LLM I/O inspector ---',
      '# Enable to capture the exact provider request/response per LLM turn',
      '# to ~/.tool-agents/cli-agent/io-captures/ (1/true/yes/on enables).',
      '# CLI_AGENT_INSPECT_IO=',
      '# Set truthy to DISABLE redaction for captures only — writes secrets',
      '# in the system prompt / memory / tool args in PLAINTEXT. Use with care.',
      '# CLI_AGENT_INSPECT_IO_RAW=',
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

/**
 * Create the tool-prompt overlay directory (mode 0700) if absent and
 * additively seed any built-in overlays that don't yet exist on disk
 * (mode 0600). Existing files are NEVER overwritten — that preserves
 * user edits across upgrades.
 *
 * Reports the count + names of newly-seeded files to stderr in a single
 * one-line summary so the user knows when a release introduced new
 * overlays.
 */
export async function bootstrapToolPromptsDir(toolPromptsDir: string): Promise<string[]> {
  await fsp.mkdir(toolPromptsDir, { recursive: true, mode: 0o700 });
  try { await fsp.chmod(toolPromptsDir, 0o700); } catch { /* tolerated */ }

  const seededNames: string[] = [];
  for (const [toolName, builtin] of Object.entries(BUILTIN_TOOL_PROMPTS)) {
    const filePath = path.join(toolPromptsDir, `${toolName}.md`);
    let exists = false;
    try {
      await fsp.access(filePath, fs.constants.F_OK);
      exists = true;
    } catch { exists = false; }
    if (exists) {
      try { await fsp.chmod(filePath, 0o600); } catch { /* tolerated */ }
      continue;
    }
    const body = serializeOverlay(toolName, builtin);
    try {
      await fsp.writeFile(filePath, body, { mode: 0o600, flag: 'wx' });
      seededNames.push(toolName);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== 'EEXIST') throw e;
    }
    try { await fsp.chmod(filePath, 0o600); } catch { /* tolerated */ }
  }
  if (seededNames.length > 0) {
    process.stderr.write(
      `[cli-agent] seeded ${seededNames.length} new tool-prompt overlays: ${seededNames.join(', ')}\n`,
    );
  }
  return seededNames;
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
  'CLI_AGENT_SYSTEM_PROMPT',
  // --- Agent mode knob (plan-015) ---
  // Pinnable chain: CLI --mode > env CLI_AGENT_MODE > profile cliParams.mode
  // > config.json mode > default 'composite'. Invalid value →
  // ConfigurationError (no fallback).
  'CLI_AGENT_MODE',
  // --- Legacy tool-group toggles (plan-008; REMOVED by plan-015) ---
  // Kept in the snapshot ONLY so the layered env remains able to SEE a set
  // value: presence of any of these is REJECTED in loadAgentConfig with a
  // ConfigurationError carrying the mode migration hint — never silently
  // ignored (Resolution 2 of the refined request).
  'CLI_AGENT_DISABLE_COMPOSITES',
  'CLI_AGENT_DISABLE_BUILTIN_TOOLS',
  'CLI_AGENT_DISABLE_AGENT_TOOLS',
  // Per-tool tri-state: 1/true/yes/on → enable; 0/false/no/off → disable;
  // unset → defer to lower tier (config.json → default).
  'CLI_AGENT_AGT_GLOB',
  'CLI_AGENT_AGT_GREP',
  'CLI_AGENT_AGT_MULTIEDIT',
  'CLI_AGENT_AGT_PATCH',
  'CLI_AGENT_AGT_TODO_READ',
  'CLI_AGENT_AGT_TODO_WRITE',
  // First-party web wrappers (plan-011), same tri-state per-tool semantics.
  'CLI_AGENT_AGT_WEB_SEARCH',
  'CLI_AGENT_AGT_WEB_FETCH',
  // First-party file wrappers (plan-012), same tri-state per-tool semantics.
  'CLI_AGENT_AGT_FILE_READ',
  'CLI_AGENT_AGT_FILE_LIST',
  'CLI_AGENT_AGT_FILE_WRITE',
  'CLI_AGENT_AGT_FILE_EDIT',
  'CLI_AGENT_AGT_FILE_APPEND',
  // --- Configuration profiles (plan-005) ---
  // Activates a named profile (equivalent to --profile <name>). CLI flag
  // wins over env (E12) via natural ?? precedence in `loadAgentConfig`.
  'CLI_AGENT_PROFILE',
  // --- Composite intelligent tools (plan-006) ---
  // Combined Stage-1 + Stage-2 token cap; numeric. Default applied in
  // U-FLAGS (32_768).
  'CLI_AGENT_COMPOSITE_BUDGET',
  // Virtual-tool dispatch mode: `child-process` (default) or
  // `in-process` (experimental). Consumed by U-VIRTUAL.
  'CLI_AGENT_VIRTUAL_DISPATCH',
  // --- LLM I/O inspector (plan-007) ---
  // Enable the I/O capture channel (1/true/yes/on). Off by default;
  // invalid (non-boolean) value raises ConfigurationError — no fallback.
  'CLI_AGENT_INSPECT_IO',
  // Disable redaction for captures only (truthy). Prints a stderr warning
  // before any unredacted byte is written. Invalid value → ConfigurationError.
  'CLI_AGENT_INSPECT_IO_RAW',
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

/* ---------- System prompt path resolution ---------- */

/**
 * Resolve the user-supplied `--system-prompt` value (or its env / config
 * equivalent) into an absolute path. Three rules:
 *   1. Absolute path → used verbatim.
 *   2. Bare filename (no path separator)  → joined onto capabilitiesDir.
 *   3. Relative path with separators       → resolved against `cwd`.
 * Returns the absolute path. Does NOT check for existence — caller does.
 */
export function resolveSystemPromptPath(
  raw: string,
  capabilitiesDir: string,
  cwd: string,
): string {
  if (path.isAbsolute(raw)) return raw;
  // A bare filename is one whose basename equals itself — i.e. no path
  // separator anywhere. `path.sep` differs by platform; check both `/`
  // and `\` so Windows-style separators in user input also count as a
  // relative path rather than a bare filename.
  const hasSeparator = raw.includes('/') || raw.includes('\\');
  if (!hasSeparator) {
    return path.join(capabilitiesDir, raw);
  }
  return path.resolve(cwd, raw);
}

/* ---------- Main loader ---------- */

export const EMPTY_FLAGS: AgentCliFlags = {};

export async function loadAgentConfig(
  flags: AgentCliFlags = EMPTY_FLAGS,
  opts: { shellEnv?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<AgentConfig> {
  const agentDir = agentToolAgentsDir();

  const shellEnv = opts.shellEnv ?? process.env;
  const cwd = opts.cwd ?? process.cwd();

  // Bootstrap the agent dir EARLY so the seeded `.env`, capabilities,
  // and tool-prompts overlays are present even on the first invocation
  // — and even when later resolution steps (e.g. `resolveProvider`) raise
  // a `ConfigurationError`. We need the config.json override for
  // `toolPromptsDir` first, so eager-load just config.json (cheap),
  // then bootstrap with the resolved directory.
  const earlyConfigFilePath = flags.configFile ?? path.join(agentDir, 'config.json');
  const earlyConfigFile = await readConfigFile(earlyConfigFilePath);
  const earlyToolPromptsRaw = earlyConfigFile?.toolPromptsDir;
  let earlyToolPromptsDir: string;
  if (earlyToolPromptsRaw && earlyToolPromptsRaw.length > 0) {
    if (path.isAbsolute(earlyToolPromptsRaw)) {
      earlyToolPromptsDir = earlyToolPromptsRaw;
    } else if (!earlyToolPromptsRaw.includes('/') && !earlyToolPromptsRaw.includes('\\')) {
      earlyToolPromptsDir = path.join(agentDir, earlyToolPromptsRaw);
    } else {
      earlyToolPromptsDir = path.resolve(cwd, earlyToolPromptsRaw);
    }
  } else {
    earlyToolPromptsDir = path.join(agentDir, 'tool-prompts');
  }
  await bootstrapAgentDir(agentDir, { toolPromptsDir: earlyToolPromptsDir });

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
  // We already read config.json once during early-bootstrap; reuse the
  // cached value (the path was computed identically).
  const configFile = earlyConfigFile;

  // ---- Configuration profile activation (plan-005) ----
  // Decided ONCE here, after the layered env snapshot and before per-knob
  // resolution. CLI flag wins over env (E12) by ?? precedence. When neither
  // is set, no filesystem access happens (NFR-PROF-001 / AC-21 invariant —
  // ADR-PROF-13 short-circuit).
  const profileName = flags.profile ?? layered['CLI_AGENT_PROFILE'];
  let activeProfile: AgentConfig['activeProfile'] | undefined;
  let activeProfileData: AgentConfig['activeProfileData'] | undefined;
  if (profileName !== undefined && profileName.length > 0) {
    const resolved = await loadProfile(profileName, agentDir);
    activeProfile = {
      name: resolved.name,
      path: resolved.path,
      schemaVersion: resolved.schemaVersion,
      digest: resolved.digest,
    };
    activeProfileData = {
      cliParams: resolved.cliParams,
      tools: resolved.tools,
      toolArgs: resolved.toolArgs,
    };
  }

  // ---- Legacy tool-group surface rejection (plan-015, Resolution 2) ----
  // The plan-008 group toggles were replaced by the single `mode` knob. A
  // SET legacy env var (any value) or a PRESENT legacy config.json key
  // fails fast with a migration hint — never silently ignored (project
  // no-fallback convention).
  for (const legacyEnvKey of [
    'CLI_AGENT_DISABLE_COMPOSITES',
    'CLI_AGENT_DISABLE_BUILTIN_TOOLS',
    'CLI_AGENT_DISABLE_AGENT_TOOLS',
  ] as const) {
    if (layered[legacyEnvKey] !== undefined) {
      throw new ConfigurationError(legacyEnvKey, [
        `env:${legacyEnvKey} was removed (plan-015). ${MODE_MIGRATION_HINT}`,
      ]);
    }
  }
  {
    const rawConfig = configFile as unknown as Record<string, unknown> | null;
    if (rawConfig !== null) {
      const legacyConfigKeys: string[] = [];
      if ('composites' in rawConfig) legacyConfigKeys.push('composites');
      if ('builtinTools' in rawConfig) legacyConfigKeys.push('builtinTools');
      const rawAgentTools = rawConfig['agentTools'];
      if (
        rawAgentTools !== null &&
        typeof rawAgentTools === 'object' &&
        'enabled' in (rawAgentTools as Record<string, unknown>)
      ) {
        legacyConfigKeys.push('agentTools.enabled');
      }
      if (legacyConfigKeys.length > 0) {
        throw new ConfigurationError(legacyConfigKeys.join(', '), [
          `config.json key(s) '${legacyConfigKeys.join("', '")}' were removed (plan-015). ${MODE_MIGRATION_HINT}`,
        ]);
      }
    }
  }

  // ---- Agent mode (plan-015) ----
  // Pinnable chain: CLI --mode > env CLI_AGENT_MODE > profile cliParams.mode
  // > config.json mode > default 'composite'. The 'composite' default is a
  // documented optional-knob starting value (NFR-4) — flagless behavior is
  // identical to the pre-plan-015 all-groups-on default — NOT a runtime
  // fallback for missing required config.
  const mode = resolveMode(
    flags.mode,
    layered,
    activeProfileData?.cliParams?.mode,
    configFile?.mode,
  );
  const modeGroups = modeToGroups(mode);

  // Layer 4: CLI flags override everything.
  // Tier-5 insertion: `?? activeProfileData?.cliParams?.X` is added between
  // `layered[...]` and `configFile?.X` for each pinnable knob (plan-005 §12.G).
  const provider = resolveProvider(
    flags.provider
      ?? layered['AGENT_PROVIDER']
      ?? activeProfileData?.cliParams?.provider
      ?? configFile?.provider,
  );

  const model =
    flags.model ??
    layered['AGENT_MODEL'] ??
    activeProfileData?.cliParams?.model ??
    configFile?.model ??
    defaultModelForProvider(provider) ??
    '';

  const maxSteps =
    flags.maxSteps
    ?? activeProfileData?.cliParams?.maxIterations
    ?? configFile?.maxSteps
    ?? 25;
  const temperature =
    flags.temperature
    ?? activeProfileData?.cliParams?.temperature
    ?? configFile?.temperature;

  let allowMutations: boolean;
  if (flags.allowMutations !== undefined) {
    allowMutations = flags.allowMutations;
  } else if (layered['AGENT_ALLOW_MUTATIONS'] !== undefined) {
    allowMutations = parseBooleanEnvVar(layered['AGENT_ALLOW_MUTATIONS'], 'AGENT_ALLOW_MUTATIONS');
  } else if (activeProfileData?.cliParams?.allowMutations !== undefined) {
    allowMutations = activeProfileData.cliParams.allowMutations;
  } else {
    allowMutations = configFile?.allowMutations ?? false;
  }

  const verbose = flags.verbose ?? configFile?.verbose ?? false;

  // Tools: CLI flags are ADDITIVE over config.json (unique merge)
  const configTools = configFile?.tools ?? [];
  const cliTools = flags.tools ?? [];
  const tools = [...new Set([...configTools, ...cliTools])];

  // ---- --tool × mode conflict (plan-015, FR-MODE-5) ----
  // Wrapped CLIs execute through bash_run, which only exists in 'tool' and
  // 'composite' modes. The check runs on the EFFECTIVE mode and the MERGED
  // wrapped-tools list, so modes sourced from env/profile/config and tools
  // sourced from config.json are caught too.
  if ((mode === 'chat' || mode === 'basic') && tools.length > 0) {
    throw new UsageError(
      `--tool is not available in '${mode}' mode: wrapped CLIs run through bash_run, ` +
        `which is only loaded in 'tool' or 'composite' mode. Re-run with --mode tool or ` +
        `--mode composite, or drop the wrapped tool(s): ${tools.join(', ')}.`,
      { mode, tools },
    );
  }

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
    activeProfileData?.cliParams?.webSearchBackend ??
    webSearchConfig.backend ??
    'tavily';
  const webSearch: ResolvedWebSearchConfig = {
    backend: webSearchBackend,
    tavilyApiKey: layered['TAVILY_API_KEY'],
    serpApiKey: layered['SERPAPI_API_KEY'],
    braveApiKey: layered['BRAVE_API_KEY'],
    customHttpUrl: layered['WEB_SEARCH_URL'],
    customHttpApiKey: layered['WEB_SEARCH_API_KEY'],
    maxRequests: parseNonNegativeIntegerEnvVar(
      layered['WEB_SEARCH_MAX_REQUESTS'],
      'WEB_SEARCH_MAX_REQUESTS',
      50,
    ),
  };

  // File edit config
  const fileEditConfig = configFile?.fileEdit ?? {};
  const fileEditRoot =
    layered['FILE_EDIT_ROOT'] ??
    fileEditConfig.root ??
    cwd;

  // System prompt selection (precedence: CLI flag > env > config.json >
  // bootstrapped default at <capabilitiesDir>/system-prompt.md). Whichever
  // wins, the resolved absolute path must exist; otherwise UsageError.
  const capabilitiesDir = path.join(agentDir, 'capabilities');
  const systemPromptRaw =
    flags.systemPromptFile ??
    layered['CLI_AGENT_SYSTEM_PROMPT'] ??
    configFile?.systemPromptFile;
  let systemPromptPath: string;
  if (systemPromptRaw && systemPromptRaw.length > 0) {
    systemPromptPath = resolveSystemPromptPath(systemPromptRaw, capabilitiesDir, cwd);
    try {
      await fsp.access(systemPromptPath, fs.constants.R_OK);
    } catch {
      throw new UsageError(
        `System prompt file not found or not readable.\n` +
        `  raw value: ${systemPromptRaw}\n` +
        `  resolved path: ${systemPromptPath}\n` +
        `  resolution rules: absolute path → verbatim; bare filename → joined onto ${capabilitiesDir}; ` +
        `relative path with separators → joined onto ${cwd}.`,
        { rawValue: systemPromptRaw, resolvedPath: systemPromptPath },
      );
    }
  } else {
    // Default — bootstrapped at agent-dir setup; readability checked here too
    // because a hostile user could have removed it between bootstrap and now.
    systemPromptPath = path.join(capabilitiesDir, SYSTEM_PROMPT_FILENAME);
    try {
      await fsp.access(systemPromptPath, fs.constants.R_OK);
    } catch {
      throw new UsageError(
        `Default system prompt file is missing.\n` +
        `  expected at: ${systemPromptPath}\n` +
        `  the file is normally seeded on first run; restore it from the built-in default ` +
        `or pass --system-prompt <path>.`,
        { resolvedPath: systemPromptPath },
      );
    }
  }

  // Tool-prompt overlay directory was already resolved + seeded at the
  // top of `loadAgentConfig` (the early-bootstrap path). Reuse the same
  // resolution to load the registry now that we're definitively past
  // any config.json override.
  const toolPromptsDir = earlyToolPromptsDir;
  const toolPromptOverlays = await loadOverlayRegistry(toolPromptsDir);

  // ---- LLM I/O inspector resolution (plan-007) ----
  // Four-tier, no-fallback. "Requested?" follows the same early-return
  // precedence idiom as resolveAgentTools: CLI flag (if defined) wins,
  // else env (tri-state via parseAgentToolsBoolEnvVar — strict validation,
  // unset → defer), else config.json `inspectIo.enabled`, else off.
  // An explicitly-requested-but-uninitialisable inspector raises
  // ConfigurationError (never a silent downgrade to null / NullIoCapture).
  const inspectIo = await resolveInspectIo(flags, layered, configFile);

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
    compositeCapabilitiesDir: path.join(agentDir, 'capabilities', 'composite'),
    compositeDistillDir: path.join(agentDir, 'capabilities', 'composite', '_distill'),
    compositesDir: path.join(agentDir, 'composites'),
    inspectIo,
    providerEnv: buildProviderEnv(layered),
    tools,
    capabilities,
    bash,
    webSearch,
    fileEdit: {
      root: fileEditRoot,
      allowPaths: fileEditConfig.allowPaths ?? [],
    },
    perToolBudgetBytes: flags.perToolBudget ?? 8192,
    baseUrl: flags.baseUrl,
    webSearchBackend,
    bashAllow: mergedBashAllow,
    bashPassSecrets: flags.bashPassSecret ?? [],
    systemPromptPath,
    systemAppendText: flags.system,
    systemAppendFile: flags.systemFile,
    toolPromptsDir,
    toolPromptOverlays,
    // Agent-tools pack — the pack's PRESENCE comes from the mode knob
    // (plan-015); the per-tool booleans resolve through the unchanged
    // chain CLI (--enable-tool/--disable-tool) > env (CLI_AGENT_AGT_*) >
    // config.json (agentTools.tools.*) > default. Downstream code
    // (registry / catalog builder) relies on this field always being present.
    agentTools: resolveAgentTools(
      flags.agentTools,
      layered,
      configFile,
      modeGroups.agentToolsEnabled,
    ),
    // Tool-group booleans (internal representation) — produced EXCLUSIVELY
    // by the mode knob's expansion (plan-015). The plan-008 per-group
    // toggle chain was removed.
    composites: modeGroups.composites,
    builtinTools: modeGroups.builtinTools,
    activeProfile,
    activeProfileData,
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

function parseNonNegativeIntegerEnvVar(raw: string | undefined, name: string, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  const v = raw.trim();
  if (!/^\d+$/.test(v)) {
    throw new ConfigurationError(name, [
      `env:${name} must be a non-negative integer (got '${raw}')`,
    ]);
  }
  const parsed = Number(v);
  if (!Number.isSafeInteger(parsed)) {
    throw new ConfigurationError(name, [
      `env:${name} must be a safe non-negative integer (got '${raw}')`,
    ]);
  }
  return parsed;
}


/**
 * Tri-state env-var parser for the agent-tools per-tool flags.
 *
 * Returns:
 *   - `true`     when the value parses as enabled (1/true/yes/on)
 *   - `false`    when the value parses as disabled (0/false/no/off)
 *   - `undefined` when the value is undefined (caller defers to next tier)
 *
 * Throws `ConfigurationError` when the value is set but unparseable —
 * STRICT, no fallback. The variable name is included in the error so the
 * user knows exactly which env var to fix.
 */
function parseAgentToolsBoolEnvVar(raw: string | undefined, name: string): boolean | undefined {
  if (raw === undefined) return undefined;
  const v = raw.trim().toLowerCase();
  if (v.length === 0) return undefined;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  throw new ConfigurationError(name, [
    `env:${name} must be one of true|false|1|0|yes|no|on|off (got '${raw}')`,
  ]);
}

/**
 * Resolve the agent-tools pack settings through the four-tier precedence
 * chain (CLI flag > shell env > local .env / agent-dir .env > config.json),
 * with explicit defaults applied as starting values at the end.
 *
 * NOTE on the "no fallback for missing required config" rule: none of the
 * agent-tools flags are REQUIRED — they all have explicit defaults. The
 * defaults are documented as starting values, NOT runtime fallbacks for
 * missing required config. The strict rule still holds for env-var values
 * that ARE present but unparseable: those throw `ConfigurationError`.
 *
 * `layered` already encodes the env-tier precedence (shell > agent-dir
 * .env > local .env) per `loadAgentConfig`. CLI flags are passed
 * separately and win unconditionally.
 */
function resolveAgentTools(
  flags: AgentCliFlags['agentTools'] | undefined,
  layered: Record<string, string | undefined>,
  configFile: AgentConfigFile | null,
  enabled: boolean,
): AgentConfig['agentTools'] {
  const cfgPack = configFile?.agentTools;
  const cfgTools = cfgPack?.tools;

  // Umbrella (plan-015): the pack's presence is decided by the mode knob's
  // expansion and passed in as `enabled` — there is no per-umbrella chain
  // anymore. The legacy CLI_AGENT_DISABLE_AGENT_TOOLS env var and
  // `agentTools.enabled` config key are REJECTED upstream in
  // `loadAgentConfig` before this resolver runs.

  // Per-tool flags. Default starting values: glob/grep/multiedit/patch=true,
  // todoRead/todoWrite=false. Mutation gating happens DOWNSTREAM in the
  // catalog builder (U5) — this resolver only encodes the user's stated
  // intent, not the runtime gate.
  const resolveOne = (
    flagVal: boolean | undefined,
    envKey:
      | 'CLI_AGENT_AGT_GLOB'
      | 'CLI_AGENT_AGT_GREP'
      | 'CLI_AGENT_AGT_MULTIEDIT'
      | 'CLI_AGENT_AGT_PATCH'
      | 'CLI_AGENT_AGT_TODO_READ'
      | 'CLI_AGENT_AGT_TODO_WRITE'
      | 'CLI_AGENT_AGT_WEB_SEARCH'
      | 'CLI_AGENT_AGT_WEB_FETCH'
      | 'CLI_AGENT_AGT_FILE_READ'
      | 'CLI_AGENT_AGT_FILE_LIST'
      | 'CLI_AGENT_AGT_FILE_WRITE'
      | 'CLI_AGENT_AGT_FILE_EDIT'
      | 'CLI_AGENT_AGT_FILE_APPEND',
    cfgVal: boolean | undefined,
    defaultVal: boolean,
  ): boolean => {
    if (flagVal !== undefined) return flagVal;
    const envVal = parseAgentToolsBoolEnvVar(layered[envKey], envKey);
    if (envVal !== undefined) return envVal;
    if (cfgVal !== undefined) return cfgVal;
    return defaultVal;
  };

  const flagTools = flags?.tools;
  const tools = {
    glob: resolveOne(flagTools?.glob, 'CLI_AGENT_AGT_GLOB', cfgTools?.glob, true),
    grep: resolveOne(flagTools?.grep, 'CLI_AGENT_AGT_GREP', cfgTools?.grep, true),
    multiedit: resolveOne(flagTools?.multiedit, 'CLI_AGENT_AGT_MULTIEDIT', cfgTools?.multiedit, true),
    patch: resolveOne(flagTools?.patch, 'CLI_AGENT_AGT_PATCH', cfgTools?.patch, true),
    todoRead: resolveOne(flagTools?.todoRead, 'CLI_AGENT_AGT_TODO_READ', cfgTools?.todoRead, false),
    todoWrite: resolveOne(flagTools?.todoWrite, 'CLI_AGENT_AGT_TODO_WRITE', cfgTools?.todoWrite, false),
    // First-party web wrappers (plan-011) — read-only, default ON.
    webSearch: resolveOne(flagTools?.webSearch, 'CLI_AGENT_AGT_WEB_SEARCH', cfgTools?.webSearch, true),
    webFetch: resolveOne(flagTools?.webFetch, 'CLI_AGENT_AGT_WEB_FETCH', cfgTools?.webFetch, true),
    // First-party file wrappers (plan-012) — all default ON; read/list are
    // read-only, write/edit/append are mutation-gated DOWNSTREAM in the
    // catalog builder (group-builder.ts), not here.
    fileRead: resolveOne(flagTools?.fileRead, 'CLI_AGENT_AGT_FILE_READ', cfgTools?.fileRead, true),
    fileList: resolveOne(flagTools?.fileList, 'CLI_AGENT_AGT_FILE_LIST', cfgTools?.fileList, true),
    fileWrite: resolveOne(flagTools?.fileWrite, 'CLI_AGENT_AGT_FILE_WRITE', cfgTools?.fileWrite, true),
    fileEdit: resolveOne(flagTools?.fileEdit, 'CLI_AGENT_AGT_FILE_EDIT', cfgTools?.fileEdit, true),
    fileAppend: resolveOne(flagTools?.fileAppend, 'CLI_AGENT_AGT_FILE_APPEND', cfgTools?.fileAppend, true),
  };

  return Object.freeze({
    enabled,
    tools: Object.freeze(tools),
  });
}

/**
 * Resolve the agent mode (plan-015) through the pinnable-knob chain:
 *
 *   CLI --mode  >  env CLI_AGENT_MODE (layered)  >  profile cliParams.mode
 *   >  config.json mode  >  default 'composite'
 *
 * The CLI tier is pre-validated by `parseModeFlag` in `src/cli.ts`
 * (UsageError, exit 2); this resolver re-validates defensively for
 * non-Commander callers (tests, subcommands). The profile tier is already
 * Zod-validated (enum) by the profile schema. Env and config.json values
 * are validated here: an invalid value raises `ConfigurationError` — no
 * fallback. The `'composite'` default is a documented optional-knob
 * starting value (flagless behavior identical to the pre-plan-015
 * all-groups-on default), NOT a runtime fallback for missing required
 * config.
 */
function resolveMode(
  flagMode: string | undefined,
  layered: Record<string, string | undefined>,
  profileMode: string | undefined,
  configMode: string | undefined,
): AgentMode {
  if (flagMode !== undefined) {
    if (!isAgentMode(flagMode)) {
      throw new UsageError(
        `Invalid --mode value '${flagMode}'. Valid modes: ${AGENT_MODES.join(', ')}.`,
        { flag: '--mode', value: flagMode },
      );
    }
    return flagMode;
  }
  const envMode = layered['CLI_AGENT_MODE'];
  if (envMode !== undefined) {
    if (!isAgentMode(envMode)) {
      throw new ConfigurationError('CLI_AGENT_MODE', [
        `env:CLI_AGENT_MODE must be one of ${AGENT_MODES.join('|')} (got '${envMode}')`,
      ]);
    }
    return envMode;
  }
  if (profileMode !== undefined) {
    // Zod-validated enum at profile load time; defensive re-check.
    if (!isAgentMode(profileMode)) {
      throw new ConfigurationError('profile.cliParams.mode', [
        `profile cliParams.mode must be one of ${AGENT_MODES.join('|')} (got '${profileMode}')`,
      ]);
    }
    return profileMode;
  }
  if (configMode !== undefined) {
    if (!isAgentMode(configMode)) {
      throw new ConfigurationError('mode', [
        `config.json "mode" must be one of ${AGENT_MODES.join('|')} (got '${configMode}')`,
      ]);
    }
    return configMode;
  }
  return 'composite'; // documented optional-knob starting value (NFR-4)
}

/**
 * Resolve the LLM I/O inspector switch (plan-007) through the four-tier
 * precedence chain with NO fallback for a requested-but-uninitialisable
 * state.
 *
 * "Requested?" precedence (highest priority first, mirroring the
 * `resolveOne` early-return idiom in `resolveAgentTools`):
 *   1. CLI flag `flags.inspectIo` (if defined)
 *   2. env `CLI_AGENT_INSPECT_IO` (tri-state; unset → defer, invalid → throw)
 *   3. config.json `inspectIo.enabled`
 *   4. (none) → off
 *
 * When NOT requested → returns `null` (the normal disabled state).
 * When requested → returns `{ enabled: true, redact, dir }` where:
 *   - `redact = !(flags.inspectIoRaw || truthy CLI_AGENT_INSPECT_IO_RAW
 *      || config.inspectIo.redact === false)` — redaction ON by default.
 *   - `dir = config.inspectIo.dir ?? agentIoCapturesDir()`.
 * The resolved `dir` is created at mode 0o700 and verified writable; on
 * any failure a `ConfigurationError` is raised (NEVER a downgrade to
 * `null` / a default mode — hard project rule, FR-10). Invalid
 * `CLI_AGENT_INSPECT_IO` / `CLI_AGENT_INSPECT_IO_RAW` boolean values
 * raise `ConfigurationError` via `parseAgentToolsBoolEnvVar`.
 */
async function resolveInspectIo(
  flags: AgentCliFlags,
  layered: Record<string, string | undefined>,
  configFile: AgentConfigFile | null,
): Promise<AgentConfig['inspectIo']> {
  const cfgInspect = configFile?.inspectIo;

  // Tier resolution for "requested?" — CLI flag > env > config.json > off.
  let requested: boolean;
  if (flags.inspectIo !== undefined) {
    requested = flags.inspectIo;
  } else {
    const envEnabled = parseAgentToolsBoolEnvVar(
      layered['CLI_AGENT_INSPECT_IO'],
      'CLI_AGENT_INSPECT_IO',
    );
    if (envEnabled !== undefined) {
      requested = envEnabled;
    } else if (cfgInspect?.enabled !== undefined) {
      requested = cfgInspect.enabled;
    } else {
      requested = false;
    }
  }

  if (!requested) return null;

  // Redaction is ON by default; opt out only via the raw flag, a truthy
  // CLI_AGENT_INSPECT_IO_RAW, or config.json `inspectIo.redact === false`.
  // The env read is strict-validated (invalid value → ConfigurationError).
  const envRaw = parseAgentToolsBoolEnvVar(
    layered['CLI_AGENT_INSPECT_IO_RAW'],
    'CLI_AGENT_INSPECT_IO_RAW',
  );
  const redact = !(
    flags.inspectIoRaw === true ||
    envRaw === true ||
    cfgInspect?.redact === false
  );

  const dir =
    cfgInspect?.dir && cfgInspect.dir.length > 0
      ? cfgInspect.dir
      : agentIoCapturesDir();

  // No-fallback: the inspector was explicitly requested, so the capture
  // dir MUST be creatable AND writable. Any failure is a configuration
  // error — never a silent downgrade to disabled.
  try {
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    try { await fsp.chmod(dir, 0o700); } catch { /* tolerated on Windows */ }
    await fsp.access(dir, fs.constants.W_OK);
  } catch (e) {
    throw new ConfigurationError('inspectIo.dir', [
      `--inspect-io / CLI_AGENT_INSPECT_IO / config.json inspectIo.enabled`,
    ], {
      resolvedDir: dir,
      cause: (e as { message?: string }).message ?? String(e),
    });
  }

  return { enabled: true, redact, dir };
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
