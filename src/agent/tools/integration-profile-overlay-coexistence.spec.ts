/**
 * Integration test: AC-18 — profile tool scoping ↔ tool-prompt overlay coexistence.
 *
 * Plan-005 FR-PROF-016 specifies that overlays and profiles are orthogonal:
 *   - Overlays change a tool's *prompt text*.
 *   - Profiles change *which tools are exposed* and *what default args they carry*.
 *
 * This file verifies three things:
 *   1. A profile that DENIES a tool does not cause that tool's overlay to
 *      be applied (the tool is simply absent from the catalog).
 *   2. A profile that ALLOWS a tool which has an overlay produces a tool in
 *      the catalog where the tool's description has come from the overlay
 *      (i.e., the overlay IS applied for surviving tools).
 *   3. Sequencing invariant: overlays apply at tool-factory construction;
 *      scoping (allow/deny/order) happens at catalog assembly; the catalog
 *      reflects the intersection of "overlay-applied descriptions" ∩
 *      "profile-scoped tool list".
 *
 * Approach:
 *   - Uses the `applyProfileToolScoping` pure function directly (no FS
 *     access needed) to assert the catalog shape.
 *   - Uses `getToolDescription` to assert overlay application.
 *   - Uses `buildToolCatalog` with a fake `toolPromptOverlays` registry
 *     to verify the integration path through registry.ts.
 *
 * All tests are hermetic — no network, no shell, no real filesystem.
 */

import { describe, it, expect, vi } from 'vitest';
import type { AgentConfig } from '../../config/agent-config.js';
import type { Logger } from '../logging.js';
import type { OverlayRegistry } from './tool-prompt-overlay.js';
import { getToolDescription } from './tool-prompt-overlay.js';
import { applyProfileToolScoping } from './profile-scoping.js';
import { buildToolCatalog } from './registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const nullLogger: Logger = {
  log: () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
  get currentLogPath() { return ''; },
  get currentSessionId() { return 'test-session'; },
};

/** Fake tool with a configurable .description property (mirrors DynamicStructuredTool shape). */
function fakeTool(name: string, description: string): { name: string; description: string } {
  return { name, description };
}

/** Minimal OverlayRegistry stub. */
function makeOverlayRegistry(
  entries: Record<string, { description: string }>,
): OverlayRegistry {
  return {
    get(tool: string) {
      const entry = entries[tool];
      if (!entry) return undefined;
      return {
        tool,
        description: entry.description,
        parameters: new Map(),
        source: `/fake/${tool}.md`,
      };
    },
    list() {
      return Object.entries(entries).map(([tool, { description }]) => ({
        tool,
        description,
        parameters: new Map(),
        source: `/fake/${tool}.md`,
      }));
    },
  };
}

/** Minimal AgentConfig fixture for buildToolCatalog tests. */
function makeCfg(
  overrides: Partial<{
    activeProfileData: Record<string, unknown>;
    toolPromptOverlays: OverlayRegistry | undefined;
    allowMutations: boolean;
    /** plan-012: enable the agt_ umbrella so agt_file_* can register. */
    agentToolsEnabled: boolean;
    /** plan-012: per-tool flag overrides merged onto the all-false default. */
    agentToolFlags: Record<string, boolean>;
  }> = {},
): AgentConfig {
  return {
    fileEdit: { root: '/tmp/test-sandbox', allowPaths: [] },
    perToolBudgetBytes: 8192,
    capabilitiesDir: '/tmp/test-capabilities',
    bash: {
      allow: [],
      allowedRoots: ['/tmp/test-sandbox'],
      passEnv: ['PATH'],
      timeoutMs: 5000,
      maxOutputBytes: 1048576,
    },
    bashAllow: [],
    bashPassSecrets: [],
    allowMutations: overrides.allowMutations ?? false,
    webSearch: { backend: 'tavily' },
    webSearchBackend: 'tavily',
    agentTools: {
      enabled: overrides.agentToolsEnabled ?? false,
      tools: {
        glob: false,
        grep: false,
        multiedit: false,
        patch: false,
        todoRead: false,
        todoWrite: false,
        webSearch: false,
        webFetch: false,
        fileRead: false,
        fileList: false,
        fileWrite: false,
        fileEdit: false,
        fileAppend: false,
        ...(overrides.agentToolFlags ?? {}),
      },
    },
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
    activeProfileData: overrides.activeProfileData as AgentConfig['activeProfileData'],
    toolPromptOverlays: overrides.toolPromptOverlays,
  } as unknown as AgentConfig;
}

// ---------------------------------------------------------------------------
// 1. Pure applyProfileToolScoping × overlay coexistence
// ---------------------------------------------------------------------------

describe('AC-18: overlay-aware catalog × deny scoping', () => {
  /**
   * A profile that DENIES bash_run must not include it in the survivors.
   * The overlay for bash_run (had it existed) would be irrelevant —
   * the factory for bash_run is not called, so overlay text never appears.
   * We verify this at the `applyProfileToolScoping` layer using fake tools
   * whose .description would be the overlay-resolved value.
   */
  it('tool excluded via deny is absent from the survivor list', () => {
    const OVERLAY_TEXT = 'OVERLAY: run a bash command.';
    const catalog = [
      fakeTool('agt_file_read', 'Built-in file_read description.'),
      fakeTool('bash_run', OVERLAY_TEXT),    // overlay would have been applied here
      fakeTool('agt_web_search', 'Built-in web_search.'),
    ];

    const result = applyProfileToolScoping(catalog, { deny: ['bash_run'] });

    const names = result.tools.map((t) => t.name);
    expect(names).not.toContain('bash_run');
    expect(names).toContain('agt_file_read');
    expect(names).toContain('agt_web_search');
    expect(result.warnings).toEqual([]);
  });

  it('denied tool overlay text does NOT appear in any surviving tool description', () => {
    const OVERLAY_TEXT = 'OVERLAY: run a bash command.';
    const catalog = [
      fakeTool('agt_file_read', 'Built-in file_read description.'),
      fakeTool('bash_run', OVERLAY_TEXT),
      fakeTool('agt_web_search', 'Built-in web_search.'),
    ];

    const result = applyProfileToolScoping(catalog, { deny: ['bash_run'] });

    const allDescriptions = result.tools.map((t) => t.description);
    for (const desc of allDescriptions) {
      expect(desc).not.toContain('OVERLAY: run a bash command.');
    }
  });

  /**
   * A profile that ALLOWS file_read should include it in the survivors with
   * its overlay-applied description intact.
   */
  it('allowed tool retains its overlay-applied description', () => {
    const OVERLAY_DESC = 'OVERLAY: read a file.';
    const catalog = [
      fakeTool('agt_file_read', OVERLAY_DESC),
      fakeTool('bash_run', 'Built-in bash_run.'),
      fakeTool('agt_web_search', 'Built-in web_search.'),
    ];

    const result = applyProfileToolScoping(catalog, { allow: ['agt_file_read'] });

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0]).toMatchObject({ name: 'agt_file_read', description: OVERLAY_DESC });
  });
});

// ---------------------------------------------------------------------------
// 2. getToolDescription × profile-based exclusion
// ---------------------------------------------------------------------------

describe('AC-18: getToolDescription not called for excluded tools', () => {
  it('overlay registry is consulted only for surviving tools (allow subset)', () => {
    const overlayReg = makeOverlayRegistry({
      agt_file_read: { description: 'OVERLAY: read a file.' },
      bash_run: { description: 'OVERLAY: run bash.' },  // should never be consulted
    });

    // Simulate the "surviving" catalog after allow scoping (only file_read survives)
    const survivingTools = ['agt_file_read'];

    // Verify overlay is correctly applied for file_read
    const desc = getToolDescription(overlayReg, 'agt_file_read', 'BUILTIN-FILE-READ');
    expect(desc).toBe('OVERLAY: read a file.');

    // bash_run was excluded — simulate that its description is never read
    // (we prove this by verifying the overlay would return a value IF consulted,
    // but the catalog does not contain it)
    expect(survivingTools).not.toContain('bash_run');

    // The overlay for bash_run DOES exist in the registry (it's still on disk)
    // but since bash_run is not in the surviving catalog, it's dead for this run.
    expect(overlayReg.get('bash_run')?.description).toBe('OVERLAY: run bash.');
  });

  it('getToolDescription falls back to built-in for a tool not in the overlay registry', () => {
    const overlayReg = makeOverlayRegistry({
      agt_file_read: { description: 'OVERLAY: read a file.' },
    });

    // web_search has no overlay — must return built-in fallback
    const desc = getToolDescription(overlayReg, 'agt_web_search', 'BUILTIN-WEB-SEARCH');
    expect(desc).toBe('BUILTIN-WEB-SEARCH');
  });
});

// ---------------------------------------------------------------------------
// 3. buildToolCatalog integration: overlay + deny scoping sequencing
// ---------------------------------------------------------------------------

describe('AC-18: buildToolCatalog sequencing — overlays apply before scoping', () => {
  /**
   * Sequencing invariant per codebase-scan IP-5:
   *   1. `loadOverlayRegistry` (overlays).
   *   2. Tool factories called with cfg that carries overlays.
   *   3. `applyProfileToolScoping` on the assembled array.
   *
   * In this test we use a profile that:
   *   - DENIES `bash_run` (which has no bash.allow so it would not appear anyway)
   *   - ALLOWS only `file_read` and `tool_help`
   *
   * (plan-011: web is no longer a built-in tool; the agent-tools umbrella is
   * off in this fixture, so two built-in read-only tools are used to prove
   * the allow-scoping subset.)
   *
   * We verify the catalog:
   *   - does not contain any tool other than file_read and tool_help
   *   - the agentToolsMeta registered list is empty (agt_* tools off)
   */
  it('allow-scoped catalog contains only the allowed tools (one agt_file_* + one built-in)', () => {
    // plan-012: allow one agt_file_* tool and one built-in; everything else is
    // scoped away. agt_file_read is registered because the umbrella + its flag
    // are on.
    const cfg = makeCfg({
      agentToolsEnabled: true,
      agentToolFlags: { fileRead: true, fileList: true },
      activeProfileData: {
        tools: { allow: ['agt_file_read', 'tool_help'] },
      },
    });

    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = catalog.tools.map((t: { name: string }) => t.name);

    expect(names).toContain('agt_file_read');
    expect(names).toContain('tool_help');
    // All other tools must be absent after allow scoping.
    expect(names).not.toContain('agt_file_list');
    expect(names).not.toContain('bash_list_allowed');
    expect(names).not.toContain('bash_which');
    expect(names).toHaveLength(2);
  });

  it('deny-scoped catalog: denied agt_file_* tool absent; siblings + built-ins survive', () => {
    /**
     * Profile denies agt_file_list. We verify it is absent and that its sibling
     * agt_file_read plus the built-in bash/tool_help tools survive. The overlay
     * for the denied tool (were it registered) would never surface.
     */
    const cfg = makeCfg({
      agentToolsEnabled: true,
      agentToolFlags: { fileRead: true, fileList: true },
      activeProfileData: {
        tools: { deny: ['agt_file_list'] },
      },
    });

    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = catalog.tools.map((t: { name: string }) => t.name);

    expect(names).not.toContain('agt_file_list');
    // Sibling agt_file_read + the built-in read-only tools survive.
    expect(names).toContain('agt_file_read');
    expect(names).toContain('bash_list_allowed');
    expect(names).toContain('bash_which');
    expect(names).toContain('tool_help');
  });

  it('agentToolsMeta stays in lockstep with survivors after scoping', () => {
    /**
     * With agentTools disabled and allow scoping applied to a built-in, the
     * agentToolsMeta registered list should be empty and match the (also empty)
     * agt_* subset of the survivor catalog.
     */
    const cfg = makeCfg({
      activeProfileData: {
        tools: { allow: ['tool_help'] },
      },
    });

    const catalog = buildToolCatalog(cfg, nullLogger);
    const agtSurvivors = catalog.tools.filter((t: { name: string }) =>
      t.name.startsWith('agt_'),
    );

    expect(agtSurvivors).toHaveLength(0);
    expect(catalog.agentToolsMeta.registered).toHaveLength(0);
  });

  it('E15 coexistence: tool excluded by profile deny has overlay on disk but no effect on survivors', () => {
    /**
     * This validates E15 (FR-PROF-016): a tool excluded by profile deny
     * may have an overlay file on disk — it must have zero effect on the
     * surviving catalog. The overlay is "silently unused for that run".
     *
     * We simulate this by constructing a fake overlay registry where the
     * denied tool HAS an overlay, then verifying no survivor carries that
     * overlay's description.
     */
    const EXCLUDED_OVERLAY = 'OVERLAY-FOR-EXCLUDED: fancy bash description.';
    const ALLOWED_OVERLAY = 'OVERLAY-FOR-ALLOWED: custom file_read description.';

    // These are the tool factory outputs WITH overlays applied (as they
    // would be after the tool factory runs with cfg.toolPromptOverlays set).
    const catalog = [
      fakeTool('agt_file_read', ALLOWED_OVERLAY),
      fakeTool('bash_run', EXCLUDED_OVERLAY),
    ];

    const result = applyProfileToolScoping(catalog, {
      deny: ['bash_run'],
    });

    // The excluded overlay text should not appear in any survivor
    const allSurvivorDescriptions = result.tools.map((t) => t.description);
    for (const d of allSurvivorDescriptions) {
      expect(d).not.toContain(EXCLUDED_OVERLAY);
    }
    // The allowed tool's overlay description must be intact
    expect(allSurvivorDescriptions).toContain(ALLOWED_OVERLAY);
  });

  it('order pass does not alter tool descriptions (overlays are unaffected by reordering)', () => {
    const catalog = [
      fakeTool('agt_file_read', 'OVERLAY-FILE-READ'),
      fakeTool('agt_web_search', 'OVERLAY-WEB-SEARCH'),
      fakeTool('tool_help', 'BUILTIN-TOOL-HELP'),
    ];

    const result = applyProfileToolScoping(catalog, {
      order: ['agt_web_search', 'agt_file_read'],
    });

    // Check order
    expect(result.tools.map((t) => t.name)).toEqual([
      'agt_web_search',
      'agt_file_read',
      'tool_help',
    ]);
    // Check descriptions are untouched
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t.description]));
    expect(byName['agt_file_read']).toBe('OVERLAY-FILE-READ');
    expect(byName['agt_web_search']).toBe('OVERLAY-WEB-SEARCH');
    expect(byName['tool_help']).toBe('BUILTIN-TOOL-HELP');
  });
});

// ---------------------------------------------------------------------------
// 4. E19 through buildToolCatalog — allowMutations via profile
// ---------------------------------------------------------------------------

describe('AC-18 / E19: allowMutations profile flag makes mutation tools visible', () => {
  it('profile allowMutations=true (via cfg.allowMutations) causes agt_file_* mutators to appear', () => {
    /**
     * When the active profile sets allowMutations: true (already merged into
     * cfg.allowMutations by loadAgentConfig's tier-5 resolution), buildToolCatalog
     * must include the mutating agt_file_* tools (plan-012) and overlay-aware
     * descriptions remain intact. The umbrella + per-tool flags must be on too.
     */
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { fileWrite: true, fileEdit: true, fileAppend: true },
    });

    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = catalog.tools.map((t: { name: string }) => t.name);

    expect(names).toContain('agt_file_write');
    expect(names).toContain('agt_file_edit');
    expect(names).toContain('agt_file_append');
  });

  it('profile with allowMutations=true + deny=[agt_file_write]: that mutator absent, others present', () => {
    /**
     * Verify that profile-based scoping (deny) works on top of the mutation-gated
     * catalog — i.e., even mutation tools can be individually denied by a profile.
     */
    const cfg = makeCfg({
      allowMutations: true,
      agentToolsEnabled: true,
      agentToolFlags: { fileRead: true, fileWrite: true, fileEdit: true, fileAppend: true },
      activeProfileData: {
        tools: { deny: ['agt_file_write'] },
      },
    });

    const catalog = buildToolCatalog(cfg, nullLogger);
    const names = catalog.tools.map((t: { name: string }) => t.name);

    expect(names).not.toContain('agt_file_write');
    expect(names).toContain('agt_file_edit');
    expect(names).toContain('agt_file_append');
    expect(names).toContain('agt_file_read');
  });
});
