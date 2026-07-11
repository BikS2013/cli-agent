/**
 * Integration tests for `buildToolCatalog` (src/agent/tools/registry.ts).
 *
 * Scope: verify that the merged tool catalog produced by `buildToolCatalog`
 * contains the correct set of tools under various combinations of:
 *   - `cfg.agentTools.enabled` (umbrella flag)
 *   - per-tool flags (glob, grep, multiedit, patch, todoRead, todoWrite)
 *   - `cfg.allowMutations`
 *   - `cfg.bash.allow` (bash-run tool gating)
 *
 * The tests also verify that `agentToolsMeta` is always the exact mirror of
 * the registered agt_* subset and that `cliAgentPermissionPolicy` (called
 * internally by `buildToolCatalog`) is exercised on every call.
 *
 * No production source is modified. Tests are self-contained; the only
 * external file contact is through the tool factory closures (which do not
 * touch the filesystem during construction — only during execution).
 *
 * Categories used:
 *   - integration  — verifies merged catalog under flag combinations
 *   - regression   — locks the count of standard read-only tools when all
 *                    agent-tools flags are off (byte-stable baseline)
 *   - error_path   — verifies ConfigurationError when `cliAgentPermissionPolicy`
 *                    receives a malformed cfg (missing required fields)
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig } from '../../config/agent-config.js';
import type { Logger } from '../logging.js';
import { buildToolCatalog } from './registry.js';
import {
  AGT_GLOB_NAME,
  AGT_GREP_NAME,
  AGT_MULTIEDIT_NAME,
  AGT_PATCH_NAME,
  AGT_TODO_READ_NAME,
  AGT_TODO_WRITE_NAME,
  AGT_WEB_SEARCH_NAME,
  AGT_WEB_FETCH_NAME,
} from './agent-tools/index.js';

// ---------------------------------------------------------------------------
// Null logger — satisfies the Logger interface; no-ops everywhere.
// ---------------------------------------------------------------------------

const nullLogger: Logger = {
  log: () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
  get currentLogPath() { return ''; },
  get currentSessionId() { return 'test-session'; },
};

// ---------------------------------------------------------------------------
// AgentConfig fixture factory
//
// `makeCfg` builds the minimal resolved AgentConfig shape that
// `buildToolCatalog` and `cliAgentPermissionPolicy` actually inspect.
// Fields that are never read by either function are omitted via a cast so
// the fixture stays terse and intentional.
//
// Key fields consumed downstream:
//   registry.ts  : allowMutations, bash.allow, agentTools,
//                  plus all fields forwarded to standard tool factories
//                  (fileEdit.root, fileEdit.allowPaths, perToolBudgetBytes,
//                  capabilitiesDir)
//   permissions  : bash (object), fileEdit.root, bashAllow, allowMutations
//                  bash.passEnv (via scrubEnv), bash.allow (matcher)
// ---------------------------------------------------------------------------

interface MakeCfgOpts {
  allowMutations?: boolean;
  /** Whether the umbrella agent-tools flag is on. Default: true. */
  agentToolsEnabled?: boolean;
  agentToolFlags?: {
    glob?: boolean;
    grep?: boolean;
    multiedit?: boolean;
    patch?: boolean;
    todoRead?: boolean;
    todoWrite?: boolean;
    webSearch?: boolean;
    webFetch?: boolean;
    fileRead?: boolean;
    fileList?: boolean;
    fileWrite?: boolean;
    fileEdit?: boolean;
    fileAppend?: boolean;
  };
  /** When truthy, adds 'git' to bash.allow so bash_run is included. */
  withBashAllow?: boolean;
}

function makeCfg(opts: MakeCfgOpts = {}): AgentConfig {
  const {
    allowMutations = false,
    agentToolsEnabled = true,
    agentToolFlags = {},
    withBashAllow = false,
  } = opts;

  const bashAllow: string[] = withBashAllow ? ['git'] : [];

  return {
    // --- required by standard tool factories ---
    fileEdit: {
      root: '/tmp/test-sandbox',
      allowPaths: [],
    },
    perToolBudgetBytes: 8192,
    capabilitiesDir: '/tmp/test-capabilities',

    // --- bash gating ---
    bash: {
      allow: bashAllow,
      allowedRoots: ['/tmp/test-sandbox'],
      passEnv: ['PATH'],
      timeoutMs: 5000,
      maxOutputBytes: 1048576,
    },
    bashAllow: bashAllow,
    bashPassSecrets: [],
    allowMutations,

    // --- web ---
    webSearch: { backend: 'tavily', maxRequests: 50 },
    webSearchBackend: 'tavily',

    // --- agent-tools pack ---
    // web search/fetch AND the plan-012 file wrappers default to OFF in this
    // fixture (like every other per-tool flag) so existing agt-count
    // assertions stay valid; the dedicated agt_web_* / agt_file_* tests enable
    // them explicitly.
    agentTools: {
      enabled: agentToolsEnabled,
      tools: {
        glob: agentToolFlags.glob ?? false,
        grep: agentToolFlags.grep ?? false,
        multiedit: agentToolFlags.multiedit ?? false,
        patch: agentToolFlags.patch ?? false,
        todoRead: agentToolFlags.todoRead ?? false,
        todoWrite: agentToolFlags.todoWrite ?? false,
        webSearch: agentToolFlags.webSearch ?? false,
        webFetch: agentToolFlags.webFetch ?? false,
        fileRead: agentToolFlags.fileRead ?? false,
        fileList: agentToolFlags.fileList ?? false,
        fileWrite: agentToolFlags.fileWrite ?? false,
        fileEdit: agentToolFlags.fileEdit ?? false,
        fileAppend: agentToolFlags.fileAppend ?? false,
      },
    },

    // --- unused-by-registry fields, present for type safety ---
    provider: 'openai',
    model: 'gpt-4o',
    maxSteps: 25,
    temperature: undefined,
    verbose: false,
    agentDir: '/tmp/test-agent-dir',
    logsDir: '/tmp/test-logs',
    providerEnv: {
      OPENAI_API_KEY: undefined,
      OPENAI_BASE_URL: undefined,
      OPENAI_ORG_ID: undefined,
      ANTHROPIC_API_KEY: undefined,
      ANTHROPIC_BASE_URL: undefined,
      GOOGLE_API_KEY: undefined,
      GEMINI_API_KEY: undefined,
      AZURE_OPENAI_API_KEY: undefined,
      AZURE_OPENAI_ENDPOINT: undefined,
      AZURE_OPENAI_DEPLOYMENT: undefined,
      AZURE_OPENAI_API_VERSION: undefined,
      AZURE_AI_INFERENCE_KEY: undefined,
      AZURE_AI_INFERENCE_ENDPOINT: undefined,
      ANTHROPIC_FOUNDRY_API_KEY: undefined,
      ANTHROPIC_FOUNDRY_ENDPOINT: undefined,
      OLLAMA_HOST: undefined,
      LITELLM_PROXY_URL: undefined,
      LITELLM_MASTER_KEY: undefined,
      LITELLM_API_BASE: undefined,
      LITELLM_API_KEY: undefined,
    },
    tools: [],
    capabilities: {
      depth: 2,
      maxBytesPerTool: 10240,
      timeoutMs: 5000,
      totalTimeoutMs: 60000,
      subcommandExtractor: '',
      skipLlmBelowBytes: 4096,
    },
    baseUrl: undefined,
    systemPromptPath: '/tmp/test-system-prompt.md',
    systemAppendText: undefined,
    systemAppendFile: undefined,
  } as unknown as AgentConfig;
}

// ---------------------------------------------------------------------------
// Helper: extract tool names from the catalog tools array
// ---------------------------------------------------------------------------
function toolNames(catalog: ReturnType<typeof buildToolCatalog>): string[] {
  return catalog.tools.map((t: { name: string }) => t.name);
}

// ---------------------------------------------------------------------------
// Standard read-only tool names — used in regression tests.
// Must match the readOnly[] array in registry.ts exactly. Web search/fetch
// moved to the agt_ pack (plan-011); file_read/file_list moved to the agt_
// pack as agt_file_read / agt_file_list (plan-012). The built-in toolkit is
// therefore bash inspection + tool_help + bash_run. Since 2026-07-04
// (fail-open change) bash_run is bound whenever the built-in group is on —
// an EMPTY allowlist means UNRESTRICTED execution, no longer "unbound".
// ---------------------------------------------------------------------------
const STANDARD_READONLY_NAMES = [
  'bash_list_allowed',
  'bash_which',
  'bash_run',
  'tool_help',
] as const;

// ---------------------------------------------------------------------------
// agt_file_* tool names (plan-012). read/list are read-only; write/edit/append
// are mutation-gated (require cfg.allowMutations). NOTE: there are NO built-in
// mutating tools anymore — file mutation lives entirely in the agt_ pack.
// ---------------------------------------------------------------------------
const AGT_FILE_READONLY_NAMES = ['agt_file_read', 'agt_file_list'] as const;
const AGT_FILE_MUTATING_NAMES = ['agt_file_write', 'agt_file_edit', 'agt_file_append'] as const;

// ---------------------------------------------------------------------------
// Describe blocks
// ---------------------------------------------------------------------------

describe('buildToolCatalog — integration: default agent-tools config', () => {
  /**
   * "Default" here means the config produced by loadAgentConfig when no
   * agent-tools flags are passed: enabled=true, glob=true, grep=true,
   * multiedit=true, patch=true, todoRead=false, todoWrite=false.
   * With allowMutations=false the mutating wrappers (multiedit, patch) are
   * dropped even though their per-tool flags are ON.
   *
   * Expected agt_* tools: agt_glob + agt_grep (2 tools).
   */
  it('default flags + allowMutations=false → only agt_glob and agt_grep register', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, grep: true, multiedit: true, patch: true, todoRead: false, todoWrite: false },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = toolNames(catalog);

    expect(names).toContain(AGT_GLOB_NAME);
    expect(names).toContain(AGT_GREP_NAME);
    expect(names).not.toContain(AGT_MULTIEDIT_NAME);
    expect(names).not.toContain(AGT_PATCH_NAME);
    expect(names).not.toContain(AGT_TODO_READ_NAME);
    expect(names).not.toContain(AGT_TODO_WRITE_NAME);
  });

  it('default flags + allowMutations=false → agentToolsMeta reflects exactly the registered pair', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, grep: true, multiedit: true, patch: true, todoRead: false, todoWrite: false },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const metaNames = catalog.agentToolsMeta.registered.map((e: { name: string }) => e.name);

    expect(catalog.agentToolsMeta.umbrellaEnabled).toBe(true);
    expect(metaNames).toEqual([AGT_GLOB_NAME, AGT_GREP_NAME]);
    // Length invariant: tools.length === meta.registered.length
    const agtToolsInCatalog = toolNames(catalog).filter((n) => n.startsWith('agt_'));
    expect(agtToolsInCatalog.length).toBe(catalog.agentToolsMeta.registered.length);
  });

  it('default flags + allowMutations=false → standard read-only tools are all present', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, grep: true, multiedit: true, patch: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = toolNames(catalog);

    for (const name of STANDARD_READONLY_NAMES) {
      expect(names).toContain(name);
    }
  });
});

describe('buildToolCatalog — integration: allowMutations=true', () => {
  it('glob+grep+multiedit+patch flags ON, allowMutations=true → all four agt_* tools register', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, grep: true, multiedit: true, patch: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = toolNames(catalog);

    expect(names).toContain(AGT_GLOB_NAME);
    expect(names).toContain(AGT_GREP_NAME);
    expect(names).toContain(AGT_MULTIEDIT_NAME);
    expect(names).toContain(AGT_PATCH_NAME);
  });

  it('allowMutations=true + file mutator flags on → agt_file_write/edit/append are included', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { fileWrite: true, fileEdit: true, fileAppend: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = toolNames(catalog);

    for (const name of AGT_FILE_MUTATING_NAMES) {
      expect(names).toContain(name);
    }
  });

  it('all six agt_* flags ON + allowMutations=true → all six agt_* tools register in canonical order', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, grep: true, multiedit: true, patch: true, todoRead: true, todoWrite: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const metaNames = catalog.agentToolsMeta.registered.map((e: { name: string }) => e.name);

    expect(metaNames).toEqual([
      AGT_GLOB_NAME,
      AGT_GREP_NAME,
      AGT_MULTIEDIT_NAME,
      AGT_PATCH_NAME,
      AGT_TODO_READ_NAME,
      AGT_TODO_WRITE_NAME,
    ]);
    expect(catalog.tools).toHaveLength(
      STANDARD_READONLY_NAMES.length + 6,
    );
  });

  it('agentToolsMeta matches registered tools exactly when allowMutations=true and all flags on', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, grep: true, multiedit: true, patch: true, todoRead: true, todoWrite: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const agtTools = catalog.tools
      .filter((t: { name: string }) => t.name.startsWith('agt_'))
      .map((t: { name: string }) => t.name);
    const metaNames = catalog.agentToolsMeta.registered.map((e: { name: string }) => e.name);

    expect(agtTools).toEqual(metaNames);
  });
});

describe('buildToolCatalog — integration: umbrella disabled', () => {
  it('agentTools.enabled=false → no agt_* tools regardless of per-tool flags', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: false,
      agentToolFlags: { glob: true, grep: true, multiedit: true, patch: true, todoRead: true, todoWrite: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = toolNames(catalog);

    for (const agtName of [AGT_GLOB_NAME, AGT_GREP_NAME, AGT_MULTIEDIT_NAME, AGT_PATCH_NAME, AGT_TODO_READ_NAME, AGT_TODO_WRITE_NAME]) {
      expect(names).not.toContain(agtName);
    }
  });

  it('agentTools.enabled=false → umbrellaEnabled is false and registered is empty', () => {
    const cfg = makeCfg({ agentToolsEnabled: false });
    const catalog = buildToolCatalog(cfg, nullLogger);

    expect(catalog.agentToolsMeta.umbrellaEnabled).toBe(false);
    expect(catalog.agentToolsMeta.registered).toHaveLength(0);
  });

  it('umbrella OFF → standard read-only tools are still present', () => {
    const cfg = makeCfg({ agentToolsEnabled: false });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = toolNames(catalog);

    for (const name of STANDARD_READONLY_NAMES) {
      expect(names).toContain(name);
    }
  });
});

describe('buildToolCatalog — integration: todoRead + todoWrite', () => {
  it('todoRead=true AND todoWrite=true → both register (no mutation gate applies)', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { todoRead: true, todoWrite: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = toolNames(catalog);

    expect(names).toContain(AGT_TODO_READ_NAME);
    expect(names).toContain(AGT_TODO_WRITE_NAME);
  });

  it('todoRead=true AND todoWrite=true meta entries carry non-empty descriptions', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { todoRead: true, todoWrite: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);

    for (const entry of catalog.agentToolsMeta.registered) {
      expect((entry as { description: string }).description.length).toBeGreaterThan(0);
    }
  });
});

describe('buildToolCatalog — integration: selective per-tool flags', () => {
  it('only glob enabled → only agt_glob registers from the agt_* pack', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = toolNames(catalog);

    expect(names).toContain(AGT_GLOB_NAME);
    expect(names).not.toContain(AGT_GREP_NAME);
    expect(names).not.toContain(AGT_MULTIEDIT_NAME);
    expect(names).not.toContain(AGT_PATCH_NAME);
    expect(names).not.toContain(AGT_TODO_READ_NAME);
    expect(names).not.toContain(AGT_TODO_WRITE_NAME);
  });

  it('only grep enabled → only agt_grep registers from the agt_* pack', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { grep: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const metaNames = catalog.agentToolsMeta.registered.map((e: { name: string }) => e.name);

    expect(metaNames).toEqual([AGT_GREP_NAME]);
  });

  it('multiedit flag ON but allowMutations=false → agt_multiedit NOT registered', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { multiedit: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    expect(toolNames(catalog)).not.toContain(AGT_MULTIEDIT_NAME);
  });

  it('patch flag ON but allowMutations=false → agt_patch NOT registered', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { patch: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    expect(toolNames(catalog)).not.toContain(AGT_PATCH_NAME);
  });

  it('patch flag ON + allowMutations=true → agt_patch IS registered', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { patch: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    expect(toolNames(catalog)).toContain(AGT_PATCH_NAME);
  });
});

describe('buildToolCatalog — integration: agt_web_* (plan-011)', () => {
  /**
   * Web search/fetch are no longer built-in. They are first-party members of
   * the agt_* pack: present when the umbrella is on AND their per-tool flags
   * are on (read-only — no allowMutations gate), and never under the legacy
   * built-in `web_search` / `web_fetch` names.
   */
  it('built-in read-only catalog no longer contains web_search / web_fetch', () => {
    const cfg = makeCfg({ agentToolsEnabled: false }); // built-ins only
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('web_fetch');
  });

  it('umbrella on + webSearch/webFetch flags on → agt_web_search and agt_web_fetch register (read-only)', () => {
    const cfg = makeCfg({
      allowMutations: false, // read-only: still registers
      agentToolsEnabled: true,
      agentToolFlags: { webSearch: true, webFetch: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    expect(names).toContain(AGT_WEB_SEARCH_NAME);
    expect(names).toContain(AGT_WEB_FETCH_NAME);
    // And never the legacy built-in names.
    expect(names).not.toContain('web_search');
    expect(names).not.toContain('web_fetch');
  });

  it('agt_web_* register in canonical order (after grep) and mirror meta', () => {
    const cfg = makeCfg({
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, grep: true, webSearch: true, webFetch: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const metaNames = catalog.agentToolsMeta.registered.map((e: { name: string }) => e.name);
    expect(metaNames).toEqual([
      AGT_GLOB_NAME,
      AGT_GREP_NAME,
      AGT_WEB_SEARCH_NAME,
      AGT_WEB_FETCH_NAME,
    ]);
    const agtTools = toolNames(catalog).filter((n) => n.startsWith('agt_'));
    expect(agtTools).toEqual(metaNames);
  });

  it('umbrella OFF → agt_web_search / agt_web_fetch are gone even with their flags on', () => {
    const cfg = makeCfg({
      agentToolsEnabled: false,
      agentToolFlags: { webSearch: true, webFetch: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    expect(names).not.toContain(AGT_WEB_SEARCH_NAME);
    expect(names).not.toContain(AGT_WEB_FETCH_NAME);
  });

  it('per-tool: webSearch on, webFetch off → only agt_web_search registers', () => {
    const cfg = makeCfg({
      agentToolsEnabled: true,
      agentToolFlags: { webSearch: true, webFetch: false },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    expect(names).toContain(AGT_WEB_SEARCH_NAME);
    expect(names).not.toContain(AGT_WEB_FETCH_NAME);
  });
});

describe('buildToolCatalog — integration: agt_file_* (plan-012)', () => {
  /**
   * File operations are no longer built-in. They are first-party members of
   * the agt_* pack: read/list are read-only (present when the umbrella + their
   * flags are on), write/edit/append are mutation-gated (also require
   * allowMutations), and the legacy built-in `file_*` names never appear.
   */
  it('AC1: built-in catalog (umbrella off) contains ONLY bash + tool_help — no file_* and no agt_file_*', () => {
    const cfg = makeCfg({ allowMutations: true, agentToolsEnabled: false });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    // Exactly the four built-in tools (bash_run is bound even with an empty
    // allowlist since the 2026-07-04 fail-open change — unrestricted mode).
    expect(names.sort()).toEqual([...STANDARD_READONLY_NAMES].sort());
    // No legacy built-in file names.
    for (const legacy of ['file_read', 'file_list', 'file_write', 'file_edit', 'file_append']) {
      expect(names).not.toContain(legacy);
    }
    // No agt_file_* either (umbrella off).
    for (const n of [...AGT_FILE_READONLY_NAMES, ...AGT_FILE_MUTATING_NAMES]) {
      expect(names).not.toContain(n);
    }
  });

  it('AC2/AC3: defaults (umbrella on, file flags on, no allowMutations) → agt_file_read+list present, mutators absent', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { fileRead: true, fileList: true, fileWrite: true, fileEdit: true, fileAppend: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    for (const n of AGT_FILE_READONLY_NAMES) expect(names).toContain(n);
    for (const n of AGT_FILE_MUTATING_NAMES) expect(names).not.toContain(n);
  });

  it('AC3: with --allow-mutations the three agt_file_* mutators additionally appear', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { fileRead: true, fileList: true, fileWrite: true, fileEdit: true, fileAppend: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    for (const n of [...AGT_FILE_READONLY_NAMES, ...AGT_FILE_MUTATING_NAMES]) {
      expect(names).toContain(n);
    }
  });

  it('mutator flag ON but allowMutations=false → that agt_file_* mutator is dropped (meta omitted too)', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { fileWrite: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    expect(toolNames(catalog)).not.toContain('agt_file_write');
    expect(catalog.agentToolsMeta.registered.map((e: { name: string }) => e.name)).not.toContain('agt_file_write');
  });

  it('AC4: --no-builtin-tools removes bash + tool_help only; agt_file_* still present', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { fileRead: true, fileList: true, fileWrite: true },
    });
    (cfg as unknown as Record<string, unknown>)['builtinTools'] = false;
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    // Built-in toolkit suppressed.
    expect(names).not.toContain('bash_list_allowed');
    expect(names).not.toContain('bash_which');
    expect(names).not.toContain('tool_help');
    // File ops survive — they are governed by agent-tools, not builtin-tools.
    expect(names).toContain('agt_file_read');
    expect(names).toContain('agt_file_list');
    expect(names).toContain('agt_file_write');
  });

  it('AC5: --no-agent-tools removes all agt_file_*; bash + tool_help remain', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: false,
      agentToolFlags: { fileRead: true, fileList: true, fileWrite: true, fileEdit: true, fileAppend: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    for (const n of [...AGT_FILE_READONLY_NAMES, ...AGT_FILE_MUTATING_NAMES]) {
      expect(names).not.toContain(n);
    }
    expect(names).toContain('bash_list_allowed');
    expect(names).toContain('tool_help');
  });

  it('AC6: profile tools.deny: [agt_file_write] removes it via name-based scoping', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { fileRead: true, fileList: true, fileWrite: true, fileEdit: true, fileAppend: true },
    });
    (cfg as unknown as Record<string, unknown>)['activeProfileData'] = {
      tools: { deny: ['agt_file_write'] },
    };
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    expect(names).not.toContain('agt_file_write');
    // siblings survive
    expect(names).toContain('agt_file_read');
    expect(names).toContain('agt_file_edit');
  });
});

describe('buildToolCatalog — integration: agentToolsMeta lockstep invariant', () => {
  it('tools[i].name === agentToolsMeta.registered[i].name for all i', () => {
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, grep: true, multiedit: true, patch: true, todoRead: true, todoWrite: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const agtTools = catalog.tools.filter((t: { name: string }) => t.name.startsWith('agt_'));

    expect(agtTools.length).toBe(catalog.agentToolsMeta.registered.length);
    for (let i = 0; i < agtTools.length; i++) {
      const tool = agtTools[i] as { name: string };
      const meta = catalog.agentToolsMeta.registered[i] as { name: string; description: string };
      expect(tool.name).toBe(meta.name);
    }
  });

  it('meta is consistent when only a partial subset is registered', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, todoRead: true },
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const metaNames = catalog.agentToolsMeta.registered.map((e: { name: string }) => e.name);

    expect(metaNames).toEqual([AGT_GLOB_NAME, AGT_TODO_READ_NAME]);
    expect(catalog.agentToolsMeta.registered).toHaveLength(2);
  });
});

describe('buildToolCatalog — integration: bash_run binding (fail-open, 2026-07-04)', () => {
  it('empty bash.allow → bash_run IS in the catalog (unrestricted mode)', () => {
    const cfg = makeCfg({ withBashAllow: false });
    const catalog = buildToolCatalog(cfg, nullLogger);
    expect(toolNames(catalog)).toContain('bash_run');
  });

  it('empty bash.allow emits the unrestricted stderr notice', () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(s);
      return true;
    };
    try {
      buildToolCatalog(makeCfg({ withBashAllow: false }), nullLogger);
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    expect(writes.join('')).toMatch(/no bash allowlist is configured — bash_run may execute ANY binary/);
  });

  it('non-empty bash.allow → bash_run IS in the catalog (restricted) and no unrestricted notice', () => {
    const writes: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      writes.push(s);
      return true;
    };
    let catalog;
    try {
      catalog = buildToolCatalog(makeCfg({ withBashAllow: true }), nullLogger);
    } finally {
      (process.stderr as unknown as { write: typeof orig }).write = orig;
    }
    expect(toolNames(catalog)).toContain('bash_run');
    expect(writes.join('')).not.toMatch(/may execute ANY binary/);
  });
});

describe('buildToolCatalog — regression: baseline standard tool count', () => {
  /**
   * Regression guard: when all agent-tools flags are off and bash allow is
   * empty and allowMutations is false, the catalog must contain exactly
   * the standard built-in tools (incl. bash_run, always bound since the
   * 2026-07-04 fail-open change). This test fails if a new standard tool
   * is added without being reflected here — an intentional tripwire.
   */
  it('all agt_* flags off + allowMutations=false + no bash allow → exactly the standard read-only tools', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: true,
      agentToolFlags: {
        glob: false,
        grep: false,
        multiedit: false,
        patch: false,
        todoRead: false,
        todoWrite: false,
      },
      withBashAllow: false,
    });
    const catalog = buildToolCatalog(cfg, nullLogger);

    expect(catalog.tools).toHaveLength(STANDARD_READONLY_NAMES.length);
    for (const name of STANDARD_READONLY_NAMES) {
      expect(toolNames(catalog)).toContain(name);
    }
  });

  it('umbrella OFF + allowMutations=false + no bash allow → still exactly the standard read-only tools', () => {
    const cfg = makeCfg({
      allowMutations: false,
      agentToolsEnabled: false,
      withBashAllow: false,
    });
    const catalog = buildToolCatalog(cfg, nullLogger);

    expect(catalog.tools).toHaveLength(STANDARD_READONLY_NAMES.length);
  });
});

describe('buildToolCatalog — integration: cliAgentPermissionPolicy side-effect', () => {
  /**
   * `cliAgentPermissionPolicy(cfg)` is called once per `buildToolCatalog`
   * invocation. We verify this by spying on the module-level export.
   * The policy object carries a stable `id` property (CLI_AGENT_POLICY_ID);
   * we verify the returned ToolCatalog's tools array still matches the
   * expected count to ensure the spy didn't swallow the call.
   */
  it('cliAgentPermissionPolicy is invoked once per buildToolCatalog call via spy', async () => {
    // Dynamic import so vi.spyOn can intercept the ES-module export.
    const permissionsModule = await import('./agent-tools/permissions.js');
    const spy = vi.spyOn(permissionsModule, 'cliAgentPermissionPolicy');

    const cfg = makeCfg({ agentToolsEnabled: false });

    // First call
    buildToolCatalog(cfg, nullLogger);
    expect(spy).toHaveBeenCalledTimes(1);

    // Second call — count increments
    buildToolCatalog(cfg, nullLogger);
    expect(spy).toHaveBeenCalledTimes(2);

    spy.mockRestore();
  });

  it('policy.id returned by cliAgentPermissionPolicy matches CLI_AGENT_POLICY_ID', async () => {
    const { cliAgentPermissionPolicy, CLI_AGENT_POLICY_ID } = await import('./agent-tools/permissions.js');
    const cfg = makeCfg();
    const policy = cliAgentPermissionPolicy(cfg);

    expect(policy.id).toBe(CLI_AGENT_POLICY_ID);
  });
});

describe('buildToolCatalog — integration: profile toolArgs dead-reference warning (plan-005 E9)', () => {
  /**
   * E9: when an active profile's `toolArgs` keys reference a tool name that
   * does not survive scoping (excluded by allow/deny, or simply not part of
   * the standard catalog), `buildToolCatalog` must emit a single non-fatal
   * stderr warning per dead reference. Surviving keys produce no warning.
   */
  it('toolArgs key referencing an excluded tool emits stderr warning', () => {
    const cfg = makeCfg({ allowMutations: false, agentToolsEnabled: false });
    // Inject activeProfileData with a deny that drops the built-in tool_help
    // AND a toolArgs entry that references the now-dropped name. (file_read is
    // no longer a built-in catalog name after plan-012, so a built-in that
    // actually survives-then-is-denied is used to exercise the exclusion path.)
    (cfg as unknown as Record<string, unknown>)['activeProfileData'] = {
      tools: { deny: ['tool_help'] },
      toolArgs: { tool_help: { section: 'full' } },
    };

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let calls: string[] = [];
    try {
      buildToolCatalog(cfg, nullLogger);
      calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      stderrSpy.mockRestore();
    }

    const warning = calls.find((s) =>
      s.includes("profile toolArgs references tool 'tool_help'"),
    );
    expect(warning).toBeDefined();
    expect(warning).toContain('not in the active catalog');
  });

  it('toolArgs key referencing an unknown tool emits stderr warning', () => {
    const cfg = makeCfg({ allowMutations: false, agentToolsEnabled: false });
    (cfg as unknown as Record<string, unknown>)['activeProfileData'] = {
      toolArgs: { not_a_real_tool: { foo: 'bar' } },
    };

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let calls: string[] = [];
    try {
      buildToolCatalog(cfg, nullLogger);
      calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      stderrSpy.mockRestore();
    }

    const warning = calls.find((s) =>
      s.includes("profile toolArgs references tool 'not_a_real_tool'"),
    );
    expect(warning).toBeDefined();
  });

  it('toolArgs key matching a surviving tool produces no warning', () => {
    const cfg = makeCfg({ allowMutations: false, agentToolsEnabled: false });
    (cfg as unknown as Record<string, unknown>)['activeProfileData'] = {
      toolArgs: { tool_help: { section: 'full' } },
    };

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let calls: string[] = [];
    try {
      buildToolCatalog(cfg, nullLogger);
      calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      stderrSpy.mockRestore();
    }

    const warning = calls.find((s) => s.includes('profile toolArgs references tool'));
    expect(warning).toBeUndefined();
  });
});

describe('buildToolCatalog — error_path: malformed cfg to cliAgentPermissionPolicy', () => {
  /**
   * `cliAgentPermissionPolicy` (called inside `buildToolCatalog`) throws
   * `ConfigurationError` when required fields are absent. Since
   * `buildToolCatalog` does not catch this error, it propagates to the
   * caller. These tests document that contract.
   */
  it('throws ConfigurationError when cfg.bash is missing', () => {
    const badCfg = makeCfg();
    // Deliberately remove the bash field
    (badCfg as unknown as Record<string, unknown>)['bash'] = undefined;

    expect(() => buildToolCatalog(badCfg, nullLogger)).toThrow();
  });

  it('throws ConfigurationError when cfg.fileEdit.root is empty string', () => {
    const badCfg = makeCfg();
    (badCfg as unknown as Record<string, unknown>)['fileEdit'] = { root: '', allowPaths: [] };

    expect(() => buildToolCatalog(badCfg, nullLogger)).toThrow();
  });
});
