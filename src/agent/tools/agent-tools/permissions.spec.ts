/**
 * Unit tests for the cli-agent → agent-tools PermissionPolicy bridge.
 *
 * Coverage scope (Phase 6 — minimal happy + sad case per surface):
 *   - evaluateBash: empty allowlist, allowed binary, denied binary
 *   - evaluateFsWrite: mutations off, in-sandbox path, out-of-sandbox path
 *   - scrubEnv helper: keeps allowlisted keys, drops the rest
 *   - ConfigurationError surface: missing cfg, missing cfg.bash, missing
 *     cfg.fileEdit.root
 *
 * Phase 9 broadens path-traversal coverage in `agt-*.spec.ts`.
 */

import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';

import {
  cliAgentPermissionPolicy,
  scrubEnv,
  CLI_AGENT_POLICY_ID,
} from './permissions.js';
import { ConfigurationError } from '../../../errors.js';
import type { AgentConfig } from '../../../config/agent-config.js';

/**
 * Build a minimal AgentConfig stub. Only the fields the bridge consumes
 * are populated — every other field is filled with a placeholder of the
 * correct shape so the cast survives `strict` typechecking.
 */
function makeCfg(overrides: {
  bashAllow?: string[];
  passEnv?: string[];
  allowMutations?: boolean;
  fileEditRoot?: string;
  allowPaths?: string[];
  bash?: AgentConfig['bash'] | undefined;
  fileEdit?: AgentConfig['fileEdit'] | undefined;
} = {}): AgentConfig {
  const tmpRoot = overrides.fileEditRoot ?? path.join(os.tmpdir(), 'cli-agent-test-root');
  const passEnv = overrides.passEnv ?? ['PATH', 'HOME'];
  const bash: AgentConfig['bash'] = overrides.bash !== undefined ? overrides.bash : {
    allow: overrides.bashAllow ?? [],
    allowedRoots: [tmpRoot],
    passEnv,
    timeoutMs: 30_000,
    maxOutputBytes: 1_048_576,
  };
  const fileEdit: AgentConfig['fileEdit'] = overrides.fileEdit !== undefined ? overrides.fileEdit : {
    root: tmpRoot,
    allowPaths: overrides.allowPaths ?? [],
  };
  return {
    provider: 'openai',
    model: 'gpt-4o',
    maxSteps: 10,
    temperature: undefined,
    allowMutations: overrides.allowMutations ?? false,
    verbose: false,
    agentDir: '/tmp/agent-dir',
    capabilitiesDir: '/tmp/agent-dir/capabilities',
    logsDir: '/tmp/agent-dir/logs',
    providerEnv: Object.freeze({}) as AgentConfig['providerEnv'],
    tools: [],
    capabilities: {
      depth: 2,
      maxBytesPerTool: 10240,
      timeoutMs: 5000,
      totalTimeoutMs: 60000,
      subcommandExtractor: '',
      skipLlmBelowBytes: 4096,
    },
    bash,
    webSearch: { backend: 'tavily', maxRequests: 50 },
    fileEdit,
    perToolBudgetBytes: 8192,
    baseUrl: undefined,
    webSearchBackend: 'tavily',
    bashAllow: overrides.bashAllow ?? [],
    bashPassSecrets: [],
    systemPromptPath: '/tmp/system-prompt.md',
    systemAppendText: undefined,
    systemAppendFile: undefined,
    agentTools: {
      enabled: true,
      tools: {
        glob: true,
        grep: true,
        multiedit: true,
        patch: true,
        todoRead: false,
        todoWrite: false,
      },
    },
  } as unknown as AgentConfig;
}

describe('cliAgentPermissionPolicy.id', () => {
  it('returns the stable CLI_AGENT_POLICY_ID', () => {
    const policy = cliAgentPermissionPolicy(makeCfg({ bashAllow: ['ls'] }));
    expect(policy.id).toBe(CLI_AGENT_POLICY_ID);
    expect(policy.id).toBe('cli-agent');
  });

  it('returns a fresh object on each call (no module-level state)', () => {
    const cfg = makeCfg({ bashAllow: ['ls'] });
    const a = cliAgentPermissionPolicy(cfg);
    const b = cliAgentPermissionPolicy(cfg);
    expect(a).not.toBe(b);
  });
});

describe('cliAgentPermissionPolicy.evaluateBash', () => {
  const cwd = path.resolve('/tmp/test-cwd');
  const baseReq = { cwd, env: {} as Record<string, string> };

  it('denies when bashAllow is empty (fail-closed)', () => {
    const policy = cliAgentPermissionPolicy(makeCfg({ bashAllow: [] }));
    const decision = policy.evaluateBash({ ...baseReq, command: 'ls -la' });
    expect(decision.allow).toBe(false);
    if (decision.allow === false) {
      expect(decision.reason).toMatch(/empty|fail-closed/i);
    }
  });

  it('allows a binary present in the allowlist', () => {
    const policy = cliAgentPermissionPolicy(makeCfg({ bashAllow: ['ls', 'git'] }));
    const decision = policy.evaluateBash({ ...baseReq, command: 'ls -la /tmp' });
    expect(decision.allow).toBe(true);
  });

  it('denies a binary missing from a non-empty allowlist', () => {
    const policy = cliAgentPermissionPolicy(makeCfg({ bashAllow: ['ls'] }));
    const decision = policy.evaluateBash({ ...baseReq, command: 'rm -rf /tmp' });
    expect(decision.allow).toBe(false);
    if (decision.allow === false) {
      expect(decision.reason).toMatch(/rm/);
      expect(decision.reason).toMatch(/allowlist/i);
    }
  });

  it('denies an empty / whitespace-only command', () => {
    const policy = cliAgentPermissionPolicy(makeCfg({ bashAllow: ['ls'] }));
    expect(policy.evaluateBash({ ...baseReq, command: '   ' }).allow).toBe(false);
    expect(policy.evaluateBash({ ...baseReq, command: '' }).allow).toBe(false);
  });
});

describe('cliAgentPermissionPolicy.evaluateFsWrite', () => {
  const root = path.join(os.tmpdir(), 'cli-agent-fs-root');

  it('denies every write when allowMutations is false', () => {
    const policy = cliAgentPermissionPolicy(
      makeCfg({ allowMutations: false, fileEditRoot: root, bashAllow: ['ls'] }),
    );
    const decision = policy.evaluateFsWrite({
      path: path.join(root, 'newfile.txt'),
      cwd: root,
      operation: 'create',
    });
    expect(decision.allow).toBe(false);
    if (decision.allow === false) {
      expect(decision.reason).toMatch(/mutation/i);
    }
  });

  it('allows writes inside fileEdit.root when mutations are enabled', () => {
    const policy = cliAgentPermissionPolicy(
      makeCfg({ allowMutations: true, fileEditRoot: root, bashAllow: ['ls'] }),
    );
    const decision = policy.evaluateFsWrite({
      path: path.join(root, 'subdir', 'newfile.txt'),
      cwd: root,
      operation: 'create',
    });
    expect(decision.allow).toBe(true);
  });

  it('denies writes outside fileEdit.root even when mutations are enabled', () => {
    const policy = cliAgentPermissionPolicy(
      makeCfg({ allowMutations: true, fileEditRoot: root, bashAllow: ['ls'] }),
    );
    const decision = policy.evaluateFsWrite({
      path: '/etc/passwd',
      cwd: root,
      operation: 'overwrite',
    });
    expect(decision.allow).toBe(false);
    if (decision.allow === false) {
      expect(decision.reason).toMatch(/outside/i);
    }
  });

  it('honours fileEdit.allowPaths for paths outside the main root', () => {
    const extra = path.join(os.tmpdir(), 'cli-agent-extra-allow');
    const policy = cliAgentPermissionPolicy(
      makeCfg({
        allowMutations: true,
        fileEditRoot: root,
        allowPaths: [extra],
        bashAllow: ['ls'],
      }),
    );
    const decision = policy.evaluateFsWrite({
      path: path.join(extra, 'in-allow.txt'),
      cwd: root,
      operation: 'create',
    });
    expect(decision.allow).toBe(true);
  });
});

describe('scrubEnv (cli-agent passEnv allowlist)', () => {
  it('keeps only the keys listed in cfg.bash.passEnv', () => {
    const cfg = makeCfg({ passEnv: ['PATH', 'HOME'], bashAllow: ['ls'] });
    const scrubbed = scrubEnv(cfg, {
      PATH: '/usr/bin',
      HOME: '/home/u',
      OPENAI_API_KEY: 'sk-deadbeefdeadbeefdeadbeef',
      RANDOM_VAR: 'leakme',
    });
    expect(scrubbed).toEqual({ PATH: '/usr/bin', HOME: '/home/u' });
    expect(scrubbed['OPENAI_API_KEY']).toBeUndefined();
    expect(scrubbed['RANDOM_VAR']).toBeUndefined();
  });

  it('omits keys that are not present in the source env', () => {
    const cfg = makeCfg({ passEnv: ['PATH', 'NONEXISTENT'], bashAllow: ['ls'] });
    const scrubbed = scrubEnv(cfg, { PATH: '/usr/bin' });
    expect(scrubbed).toEqual({ PATH: '/usr/bin' });
  });

  it('throws ConfigurationError when cfg.bash is missing', () => {
    const cfg = makeCfg({ bashAllow: ['ls'] });
    // Force-clear `bash` to reproduce the missing-config branch.
    const broken = { ...cfg, bash: undefined } as unknown as AgentConfig;
    expect(() => scrubEnv(broken, {})).toThrow(ConfigurationError);
  });
});

describe('cliAgentPermissionPolicy ConfigurationError surface', () => {
  it('throws when cfg is null/undefined', () => {
    expect(() => cliAgentPermissionPolicy(undefined as unknown as AgentConfig)).toThrow(
      ConfigurationError,
    );
    expect(() => cliAgentPermissionPolicy(null as unknown as AgentConfig)).toThrow(
      ConfigurationError,
    );
  });

  it('throws when cfg.bash is missing', () => {
    const cfg = makeCfg({ bashAllow: ['ls'] });
    const broken = { ...cfg, bash: undefined } as unknown as AgentConfig;
    expect(() => cliAgentPermissionPolicy(broken)).toThrow(ConfigurationError);
  });

  it('throws when cfg.fileEdit.root is missing', () => {
    const cfg = makeCfg({ bashAllow: ['ls'] });
    const broken = {
      ...cfg,
      fileEdit: { root: '', allowPaths: [] },
    } as unknown as AgentConfig;
    expect(() => cliAgentPermissionPolicy(broken)).toThrow(ConfigurationError);
  });

  it('throws when cfg.fileEdit itself is missing', () => {
    const cfg = makeCfg({ bashAllow: ['ls'] });
    const broken = { ...cfg, fileEdit: undefined } as unknown as AgentConfig;
    expect(() => cliAgentPermissionPolicy(broken)).toThrow(ConfigurationError);
  });
});
