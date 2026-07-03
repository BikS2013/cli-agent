/**
 * Tests for the plan-008 tool-loading group toggles as they land in
 * `buildToolCatalog` (src/agent/tools/registry.ts — the gate).
 *
 * Three independent group toggles flow through the resolved `AgentConfig`:
 *   - `cfg.builtinTools` — the cross-cutting toolkit
 *      (bash_*, tool_help = readOnly + bashRunTools; file_* moved to the agt_
 *      pack as agt_file_* in plan-012, web_* in plan-011)
 *   - `cfg.composites`   — every virtual/composite tool (loadVirtualToolsSync)
 *   - `cfg.agentTools.enabled` — the agent-tools pack umbrella (agt_*), pre-existing
 *
 * Scope of THIS spec: the catalog GATE behaviour given an already-resolved cfg.
 * Config-resolution precedence (CLI > env > config.json > profile > default)
 * is covered in src/config/agent-config.spec.ts and the profile schema in
 * src/config/profile-schema.spec.ts.
 *
 * Categories:
 *   - integration  — verifies which groups appear/disappear under each toggle
 *   - regression   — defaults (all toggles load) reproduce the usual set
 *   - independence — toggles do not interfere with each other
 *   - empty_path   — all groups off → empty catalog + one stderr notice, no throw
 *
 * The composites group is exercised by mocking `loadVirtualToolsSync` so a
 * deterministic fake virtual handle is returned (the real loader scans the
 * filesystem). The mock is wired with `vi.mock` at module scope and its
 * behaviour adjusted per-test via `mockImplementation`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentConfig } from '../../config/agent-config.js';
import type { Logger } from '../logging.js';
import {
  AGT_GLOB_NAME,
  AGT_GREP_NAME,
  AGT_WEB_SEARCH_NAME,
  AGT_WEB_FETCH_NAME,
} from './agent-tools/index.js';

// ---------------------------------------------------------------------------
// Mock the virtual-tools loader so the composites group is deterministic.
// Default: returns no handles (matches a machine with no composites). Tests
// that need a composite present override via mockImplementation below.
// ---------------------------------------------------------------------------
const loadVirtualToolsSyncMock = vi.fn(() => [] as Array<{ langchainTool: { name: string } }>);
vi.mock('../composite/virtual-registry.js', () => ({
  loadVirtualToolsSync: (...args: unknown[]) => loadVirtualToolsSyncMock(...(args as [])),
}));

// Import AFTER the mock declaration so registry.ts picks up the mocked module.
import { buildToolCatalog } from './registry.js';

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
// AgentConfig fixture factory (mirrors registry.spec.ts `makeCfg`, plus the
// plan-008 group toggles). Fields never read by buildToolCatalog /
// cliAgentPermissionPolicy are omitted via the `as unknown as AgentConfig`
// cast — the fixture stays terse and intentional.
// ---------------------------------------------------------------------------
interface MakeCfgOpts {
  /** plan-008: load the built-in cross-cutting toolkit. Default: true (load). */
  builtinTools?: boolean;
  /** plan-008: load composite (virtual) tools. Default: true (load). */
  composites?: boolean;
  allowMutations?: boolean;
  /** agent-tools pack umbrella. Default: true. */
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
    builtinTools = true,
    composites = true,
    allowMutations = false,
    agentToolsEnabled = true,
    agentToolFlags = {},
    withBashAllow = false,
  } = opts;

  const bashAllow: string[] = withBashAllow ? ['git'] : [];

  return {
    // --- plan-008 group toggles ---
    builtinTools,
    composites,

    // --- required by standard tool factories ---
    fileEdit: { root: '/tmp/test-sandbox', allowPaths: [] },
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
    bashAllow,
    bashPassSecrets: [],
    allowMutations,

    // --- web ---
    webSearch: { backend: 'tavily', maxRequests: 50 },
    webSearchBackend: 'tavily',

    // --- agent-tools pack ---
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

function toolNames(catalog: ReturnType<typeof buildToolCatalog>): string[] {
  return catalog.tools.map((t: { name: string }) => t.name);
}

// The full built-in cross-cutting toolkit (readOnly + bashRun). Web search/
// fetch are NOT here anymore (plan-011), and file_* are NOT here anymore
// (plan-012) — both moved to the agt_* pack (agt_web_* / agt_file_*) governed
// by --agent-tools, independent of the --no-builtin-tools toggle. The built-in
// toolkit is now exactly bash inspection + tool_help (+ bash_run when allowed).
const BUILTIN_READONLY = [
  'bash_list_allowed',
  'bash_which',
  'tool_help',
] as const;
// Legacy file_* names that must NEVER appear in the catalog anymore (they were
// renamed to agt_file_* and moved out of the built-in toolkit).
const LEGACY_FILE_NAMES = ['file_read', 'file_list', 'file_write', 'file_edit', 'file_append'] as const;

beforeEach(() => {
  loadVirtualToolsSyncMock.mockReset();
  loadVirtualToolsSyncMock.mockImplementation(() => []);
});

// ===========================================================================
// Built-in toolkit toggle
// ===========================================================================
describe('buildToolCatalog — builtin-tools toggle (plan-008)', () => {
  it('builtinTools:false → NONE of bash_*/tool_help appear (and no legacy file_* either)', () => {
    const cfg = makeCfg({
      builtinTools: false,
      allowMutations: true,
      withBashAllow: true, // would add bash_run if builtin were on
      agentToolsEnabled: false,
    });
    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = toolNames(catalog);

    for (const n of [...BUILTIN_READONLY, ...LEGACY_FILE_NAMES, 'bash_run']) {
      expect(names).not.toContain(n);
    }
  });

  it('builtinTools:false + bash allow set → bash_run is NOT registered', () => {
    const cfg = makeCfg({ builtinTools: false, withBashAllow: true, agentToolsEnabled: false });
    expect(toolNames(buildToolCatalog(cfg, nullLogger))).not.toContain('bash_run');
  });

  it('default (builtinTools omitted ⇒ load) → the read-only toolkit is present', () => {
    const cfg = makeCfg({ agentToolsEnabled: false });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    for (const n of BUILTIN_READONLY) {
      expect(names).toContain(n);
    }
  });

  it('builtinTools:true (explicit) → identical to default; toolkit present', () => {
    const cfg = makeCfg({ builtinTools: true, agentToolsEnabled: false });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    for (const n of BUILTIN_READONLY) {
      expect(names).toContain(n);
    }
  });
});

// ===========================================================================
// Composites toggle
// ===========================================================================
describe('buildToolCatalog — composites toggle (plan-008)', () => {
  it('composites:false → loadVirtualToolsSync is never called and no composite appears', () => {
    loadVirtualToolsSyncMock.mockImplementation(() => [
      { langchainTool: { name: 'cmp_demo' } },
    ]);
    const cfg = makeCfg({ composites: false, agentToolsEnabled: false });
    const catalog = buildToolCatalog(cfg, nullLogger);

    expect(loadVirtualToolsSyncMock).not.toHaveBeenCalled();
    expect(toolNames(catalog)).not.toContain('cmp_demo');
  });

  it('default (composites omitted ⇒ load) → composite handle is appended to the catalog', () => {
    loadVirtualToolsSyncMock.mockImplementation(() => [
      { langchainTool: { name: 'cmp_demo' } },
    ]);
    const cfg = makeCfg({ agentToolsEnabled: false });
    const catalog = buildToolCatalog(cfg, nullLogger);

    expect(loadVirtualToolsSyncMock).toHaveBeenCalledTimes(1);
    expect(toolNames(catalog)).toContain('cmp_demo');
  });

  it('composites:true (explicit) → loader invoked; composite present', () => {
    loadVirtualToolsSyncMock.mockImplementation(() => [
      { langchainTool: { name: 'cmp_demo' } },
    ]);
    const cfg = makeCfg({ composites: true, agentToolsEnabled: false });
    expect(toolNames(buildToolCatalog(cfg, nullLogger))).toContain('cmp_demo');
  });
});

// ===========================================================================
// Independence between the three groups
// ===========================================================================
describe('buildToolCatalog — group independence (plan-008)', () => {
  it('builtinTools:false still allows agt_* when the agent-tools umbrella is enabled', () => {
    const cfg = makeCfg({
      builtinTools: false,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, grep: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));

    // agt_* survive even though the built-in toolkit is suppressed.
    expect(names).toContain(AGT_GLOB_NAME);
    expect(names).toContain(AGT_GREP_NAME);
    // ...and the built-in toolkit really is gone.
    for (const n of BUILTIN_READONLY) {
      expect(names).not.toContain(n);
    }
  });

  it('agentTools umbrella OFF still leaves the built-in toolkit intact', () => {
    const cfg = makeCfg({
      builtinTools: true,
      agentToolsEnabled: false,
      agentToolFlags: { glob: true, grep: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));

    for (const n of BUILTIN_READONLY) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain(AGT_GLOB_NAME);
    expect(names).not.toContain(AGT_GREP_NAME);
  });

  it('plan-011: builtinTools:false does NOT remove agt_web_* (web is in the agt_* pack now)', () => {
    const cfg = makeCfg({
      builtinTools: false,
      agentToolsEnabled: true,
      agentToolFlags: { webSearch: true, webFetch: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    // The built-in toolkit is suppressed...
    for (const n of BUILTIN_READONLY) {
      expect(names).not.toContain(n);
    }
    // ...but the web tools survive because they ride the agent-tools umbrella.
    expect(names).toContain(AGT_WEB_SEARCH_NAME);
    expect(names).toContain(AGT_WEB_FETCH_NAME);
  });

  it('plan-011: --no-agent-tools removes agt_web_* even with builtinTools on', () => {
    const cfg = makeCfg({
      builtinTools: true,
      agentToolsEnabled: false,
      agentToolFlags: { webSearch: true, webFetch: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));
    expect(names).not.toContain(AGT_WEB_SEARCH_NAME);
    expect(names).not.toContain(AGT_WEB_FETCH_NAME);
    // Built-in read-only toolkit is still intact.
    for (const n of BUILTIN_READONLY) {
      expect(names).toContain(n);
    }
  });

  it('composites:false is independent of builtin + agent-tools (both still load)', () => {
    loadVirtualToolsSyncMock.mockImplementation(() => [
      { langchainTool: { name: 'cmp_demo' } },
    ]);
    const cfg = makeCfg({
      composites: false,
      builtinTools: true,
      agentToolsEnabled: true,
      agentToolFlags: { glob: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));

    expect(names).not.toContain('cmp_demo');
    expect(names).toContain('tool_help'); // built-in survives
    expect(names).toContain(AGT_GLOB_NAME); // agt_* survives
  });
});

// ===========================================================================
// Regression: defaults reproduce the usual set
// ===========================================================================
describe('buildToolCatalog — regression: defaults load every group (plan-008)', () => {
  it('all toggles default (load) → built-in read-only + agt_glob/grep present, plus composite', () => {
    loadVirtualToolsSyncMock.mockImplementation(() => [
      { langchainTool: { name: 'cmp_demo' } },
    ]);
    const cfg = makeCfg({
      // builtinTools + composites default to true via the fixture
      agentToolsEnabled: true,
      agentToolFlags: { glob: true, grep: true },
    });
    const names = toolNames(buildToolCatalog(cfg, nullLogger));

    for (const n of BUILTIN_READONLY) {
      expect(names).toContain(n);
    }
    expect(names).toContain(AGT_GLOB_NAME);
    expect(names).toContain(AGT_GREP_NAME);
    expect(names).toContain('cmp_demo');
  });
});

// ===========================================================================
// Empty-catalog path
// ===========================================================================
describe('buildToolCatalog — empty catalog notice (plan-008)', () => {
  it('every group off → tools is empty, ONE stderr notice, and no throw', () => {
    const cfg = makeCfg({
      builtinTools: false,
      composites: false,
      agentToolsEnabled: false,
      withBashAllow: true, // proves bash_run is still gone with builtin off
      allowMutations: true,
    });

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let catalog: ReturnType<typeof buildToolCatalog> | undefined;
    let calls: string[] = [];
    try {
      expect(() => {
        catalog = buildToolCatalog(cfg, nullLogger);
      }).not.toThrow();
      calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      stderrSpy.mockRestore();
    }

    expect(catalog).toBeDefined();
    expect(catalog!.tools).toHaveLength(0);

    const notices = calls.filter((s) =>
      s.includes('no tools are loaded for this session'),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('plain conversational LLM');
  });

  it('a non-empty catalog does NOT emit the empty-toolset notice', () => {
    const cfg = makeCfg({ agentToolsEnabled: false }); // built-in read-only present

    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let calls: string[] = [];
    try {
      buildToolCatalog(cfg, nullLogger);
      calls = stderrSpy.mock.calls.map((c) => String(c[0]));
    } finally {
      stderrSpy.mockRestore();
    }

    const notice = calls.find((s) => s.includes('no tools are loaded for this session'));
    expect(notice).toBeUndefined();
  });
});
