/**
 * Virtual-tool dispatcher (plan-006 P6 / U-VIRTUAL).
 *
 * Implements §14.K (Virtual-tool dispatch). Two modes:
 *
 *   - `child-process` (default; ADR-CMP-7) — spawns a fresh `cli-agent`
 *     subprocess with the recorded `--tool <member>` flags pre-baked
 *     and the user's prompt as the trailing argv. The child receives
 *     `CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD=1` so its own
 *     `loadVirtualTools` returns `[]` — structurally preventing
 *     composite-of-composite recursion at runtime.
 *
 *   - `in-process` (experimental; opt-in via `cfg.virtualDispatch ===
 *     'in-process'` or env `CLI_AGENT_VIRTUAL_DISPATCH=in-process`) —
 *     re-enters `runOneShotAgent` from `src/agent/run.ts` with a
 *     cloned `AgentConfig` whose `tools` array is the recorded member
 *     set. Each call starts a fresh `MemorySaver` so caller state
 *     never leaks. The recursion guard is enforced by an in-process
 *     depth counter capped at 2.
 *
 * Both modes:
 *   - Re-check the live registry against the manifest's members
 *     (register-time recursion can be bypassed if a manifest is
 *     hand-edited; the dispatch-time guard catches it).
 *   - Emit a `composite_dispatched` log event with manifest digest,
 *     member set, mode, exit code, and latency.
 *
 * Public API:
 *   dispatchComposite(input) → { exitCode; stdout; stderr }
 */

import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { UsageError, AgentRuntimeError } from '../../errors.js';
import type { AgentConfig } from '../../config/agent-config.js';
import type { Logger } from '../logging.js';
import type { CompositeManifest, DispatchMode } from './types.js';

const RECURSION_GUARD_ENV = 'CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD';
const IN_PROCESS_DEPTH_ENV = 'CLI_AGENT_VIRTUAL_DISPATCH_IN_PROCESS_DEPTH';
const DEFAULT_DISPATCH_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
const MAX_IN_PROCESS_DEPTH = 2;

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export interface DispatchInput {
  readonly manifest: CompositeManifest;
  /** Caller-supplied invocation argv. The dispatcher concatenates the
   * recorded `--tool` flags with these args before spawning the
   * subprocess. The first non-flag element is treated as the prompt
   * for in-process mode. */
  readonly invocationArgs: readonly string[];
  readonly mode: DispatchMode;
  readonly cfg: AgentConfig;
  readonly logger: Logger;
}

export interface DispatchResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/* ------------------------------------------------------------------ */
/* cli-agent binary path resolution                                    */
/* ------------------------------------------------------------------ */

/**
 * Resolve the absolute path of the cli-agent binary that should be
 * spawned for child-process dispatch.
 *
 * Resolution order (first match wins):
 *   1. `process.env['CLI_AGENT_BIN']` if set and points to an existing
 *      file. Allows test harnesses + power users to override.
 *   2. `process.argv[1]` — the script that started the current Node
 *      process. When cli-agent is run via `node dist/cli.js …` or
 *      via the `cli-agent` shim installed by npm, this is the
 *      cli-agent entry-point and is always absolute.
 *   3. The `cli-agent` binary on `PATH` resolved via the `which`-style
 *      lookup. This is a fall-back for unusual invocations (e.g.
 *      embedded as a library) where `argv[1]` is a different script.
 *
 * The resolved path is returned verbatim (not symlink-followed) so
 * version-manager shims (nvm/volta/asdf) keep their indirection. The
 * shim writer's `detectVersionManager` warning lives elsewhere.
 *
 * Throws `AgentRuntimeError` (exit 1) when no candidate is resolvable.
 */
export function resolveCliAgentBinPath(): string {
  const fromEnv = process.env['CLI_AGENT_BIN'];
  if (fromEnv && fromEnv.length > 0) {
    try {
      const stat = fs.statSync(fromEnv);
      if (stat.isFile()) return path.isAbsolute(fromEnv) ? fromEnv : path.resolve(fromEnv);
    } catch {
      /* fall through to the next candidate */
    }
  }

  const fromArgv = process.argv[1];
  if (fromArgv && fromArgv.length > 0) {
    const abs = path.isAbsolute(fromArgv) ? fromArgv : path.resolve(fromArgv);
    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) return abs;
    } catch {
      /* fall through */
    }
  }

  // PATH lookup (fall-back).
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, 'cli-agent');
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }

  throw new AgentRuntimeError(
    `dispatchComposite: cannot resolve cli-agent binary. Set CLI_AGENT_BIN to an absolute path.`,
    { argv1: fromArgv ?? null, env: fromEnv ?? null },
  );
}

/* ------------------------------------------------------------------ */
/* Recursion guard                                                     */
/* ------------------------------------------------------------------ */

/**
 * Re-check the live registry: the manifest's members must NOT include
 * any composite that is itself registered. The register-time guard in
 * `loadVirtualTools` catches the common case; this dispatch-time
 * re-check catches hand-edited manifests installed after registration.
 *
 * Throws `UsageError` (exit 2) on violation.
 */
function enforceRecursionGuard(manifest: CompositeManifest, cfg: AgentConfig): void {
  const compositesDir = cfg.compositesDir;
  if (!compositesDir) return;

  for (const member of manifest.members) {
    const memberManifest = path.join(compositesDir, member, 'manifest.json');
    let exists = false;
    try {
      const stat = fs.statSync(memberManifest);
      exists = stat.isFile();
    } catch {
      /* member is not a composite — fine */
    }
    if (exists) {
      throw new UsageError(
        `composite-of-composite is not supported in v1; member '${member}' is itself a composite`,
        { compositeName: manifest.compositeName, offendingMember: member },
      );
    }
  }
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

function emitDispatchedEvent(
  logger: Logger,
  manifest: CompositeManifest,
  mode: DispatchMode,
  exitCode: number,
  latencyMs: number,
): void {
  // The LogEvent union does not yet declare 'composite_dispatched'
  // (that extension lands with U-DOC's logging additions). Use the
  // generic 'error' event kind with `code: 'composite_dispatched'` so
  // the JSONL stream still captures the dispatch — downstream tooling
  // can promote to a typed kind once the union is extended.
  try {
    logger.log({
      kind: 'error',
      ts: new Date().toISOString(),
      sessionId: logger.currentSessionId,
      code: 'composite_dispatched',
      message: `composite '${manifest.compositeName}' dispatched (mode=${mode}, exit=${exitCode}, ${latencyMs}ms)`,
      details: {
        compositeName: manifest.compositeName,
        mode,
        members: [...manifest.members],
        exitCode,
        latencyMs,
        memberDigests: manifest.memberDigests,
      },
    });
  } catch {
    /* logger errors must never break dispatch */
  }
}

/* ------------------------------------------------------------------ */
/* Subprocess (default) dispatch                                       */
/* ------------------------------------------------------------------ */

interface SpawnConfig {
  readonly bin: string;
  readonly argv: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
}

function buildSpawnArgs(
  manifest: CompositeManifest,
  invocationArgs: readonly string[],
): string[] {
  const argv: string[] = [];
  for (const member of manifest.members) {
    argv.push('--tool', member);
  }
  for (const a of invocationArgs) argv.push(a);
  return argv;
}

async function dispatchSubprocess(
  manifest: CompositeManifest,
  invocationArgs: readonly string[],
  cfg: AgentConfig,
  logger: Logger,
): Promise<DispatchResult> {
  const bin = resolveCliAgentBinPath();
  const argv = buildSpawnArgs(manifest, invocationArgs);

  // Forward parent env, set the dispatch-time recursion guard, and
  // bump the in-process depth counter (defensive — also relevant for
  // nested in-process calls within a child).
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    [RECURSION_GUARD_ENV]: '1',
  };

  const timeoutMs = readDispatchTimeoutMs(cfg);
  const start = Date.now();

  // The cli-agent script has a Node shebang and is chmod +x post-build,
  // so spawning it directly works on macOS/Linux. On systems where
  // the shebang is not honoured (or the file is not executable), we
  // fall back to spawning `node <script>`. We prefer the direct exec
  // path because it preserves the shebang's `node` semantics (the
  // user's installed Node) without forcing `process.execPath`.
  const spawnConfig: SpawnConfig = {
    bin,
    argv,
    env: childEnv,
    timeoutMs,
  };

  return await runSpawn(spawnConfig, manifest, logger, 'child-process', start);
}

function runSpawn(
  cfg: SpawnConfig,
  manifest: CompositeManifest,
  logger: Logger,
  mode: DispatchMode,
  startTime: number,
): Promise<DispatchResult> {
  return new Promise<DispatchResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cfg.bin, cfg.argv, {
        env: cfg.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      emitDispatchedEvent(logger, manifest, mode, 1, latencyMs);
      resolve({
        exitCode: 1,
        stdout: '',
        stderr: `dispatchComposite: failed to spawn cli-agent: ${(err as Error).message}\n`,
      });
      return;
    }

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* tolerated */
      }
    }, cfg.timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (err) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - startTime;
      emitDispatchedEvent(logger, manifest, mode, 1, latencyMs);
      resolve({
        exitCode: 1,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr:
          Buffer.concat(stderrChunks).toString('utf8') +
          `dispatchComposite: child process error: ${err.message}\n`,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const latencyMs = Date.now() - startTime;
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      let stderr = Buffer.concat(stderrChunks).toString('utf8');
      let exitCode: number;
      if (timedOut) {
        exitCode = 1;
        stderr += `dispatchComposite: child timed out after ${cfg.timeoutMs}ms (signal=${signal ?? 'n/a'})\n`;
      } else if (code === null) {
        exitCode = signal ? 128 : 1;
        stderr += `dispatchComposite: child exited via signal ${signal ?? 'unknown'}\n`;
      } else {
        exitCode = code;
      }
      emitDispatchedEvent(logger, manifest, mode, exitCode, latencyMs);
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function readDispatchTimeoutMs(cfg: AgentConfig): number {
  const composite = (cfg as unknown as Record<string, unknown>)['composite'];
  if (composite && typeof composite === 'object') {
    const v = (composite as Record<string, unknown>)['dispatchTimeoutMs'];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v;
  }
  const fromEnv = process.env['CLI_AGENT_COMPOSITE_DISPATCH_TIMEOUT_MS'];
  if (fromEnv) {
    const n = Number(fromEnv);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_DISPATCH_TIMEOUT_MS;
}

/* ------------------------------------------------------------------ */
/* In-process (experimental) dispatch                                  */
/* ------------------------------------------------------------------ */

/**
 * Re-enter the cli-agent runner in the current Node process with a
 * cloned config whose `tools` is the manifest's member set. A fresh
 * `MemorySaver` is implied by `runOneShotAgent` (it constructs a new
 * graph per call), so caller thread-state never leaks.
 *
 * Depth tracking: the env var `CLI_AGENT_VIRTUAL_DISPATCH_IN_PROCESS_DEPTH`
 * accumulates the active in-process call count. Beyond
 * {@link MAX_IN_PROCESS_DEPTH} (2) the call is rejected with a
 * `UsageError` — the structural recursion guard prevents the
 * composite-of-composite scenario from emerging via the in-process
 * path even though `loadVirtualTools` is bypassed entirely.
 */
async function dispatchInProcess(
  manifest: CompositeManifest,
  invocationArgs: readonly string[],
  cfg: AgentConfig,
  logger: Logger,
): Promise<DispatchResult> {
  const currentDepth = Number(process.env[IN_PROCESS_DEPTH_ENV] ?? '0');
  if (currentDepth >= MAX_IN_PROCESS_DEPTH) {
    throw new UsageError(
      `dispatchComposite: in-process recursion depth ${currentDepth} exceeds limit ${MAX_IN_PROCESS_DEPTH}`,
      { compositeName: manifest.compositeName, depth: currentDepth },
    );
  }

  // Resolve the prompt: the convention is that the first non-flag arg
  // is the prompt; if none, raise UsageError.
  const prompt = invocationArgs.find((a) => !a.startsWith('-'));
  if (!prompt) {
    throw new UsageError(
      `dispatchComposite: in-process mode requires a prompt argument; got args=${JSON.stringify(invocationArgs)}`,
      { compositeName: manifest.compositeName },
    );
  }

  // Clone the config with the recorded member set as the tool list.
  // Use a structural clone via spread; AgentConfig is `readonly` but
  // the spread produces a fresh top-level object satisfying the type.
  const clonedCfg: AgentConfig = {
    ...cfg,
    tools: Object.freeze([...manifest.members]),
  };

  // Bump the depth counter for the duration of the call so any
  // re-entrant in-process call is counted.
  const prevDepth = process.env[IN_PROCESS_DEPTH_ENV];
  process.env[IN_PROCESS_DEPTH_ENV] = String(currentDepth + 1);
  // Set the registry-level recursion guard too, so any cli-agent
  // module that consults it (e.g. a future loadVirtualTools called
  // mid-stream) sees the guard active.
  const prevGuard = process.env[RECURSION_GUARD_ENV];
  process.env[RECURSION_GUARD_ENV] = '1';

  const start = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    // Lazy import to avoid a hard dependency on run.ts at module load
    // time (run.ts pulls in graph.ts → langgraph). Keeping this import
    // inside the function lets manifest tests run without spinning up
    // the full agent stack.
    const runMod = await import('../run.js');
    const result = await runMod.runOneShotAgent(clonedCfg, prompt);
    stdout = result;
  } catch (err) {
    exitCode = 1;
    stderr = `dispatchComposite (in-process): ${(err as Error).message}\n`;
  } finally {
    if (prevDepth === undefined) delete process.env[IN_PROCESS_DEPTH_ENV];
    else process.env[IN_PROCESS_DEPTH_ENV] = prevDepth;
    if (prevGuard === undefined) delete process.env[RECURSION_GUARD_ENV];
    else process.env[RECURSION_GUARD_ENV] = prevGuard;
  }
  const latencyMs = Date.now() - start;
  emitDispatchedEvent(logger, manifest, 'in-process', exitCode, latencyMs);
  return { exitCode, stdout, stderr };
}

/* ------------------------------------------------------------------ */
/* Public entry-point                                                  */
/* ------------------------------------------------------------------ */

export async function dispatchComposite(input: DispatchInput): Promise<DispatchResult> {
  const { manifest, invocationArgs, mode, cfg, logger } = input;

  // Dispatch-time recursion guard (re-check live registry).
  enforceRecursionGuard(manifest, cfg);

  if (mode === 'in-process') {
    return await dispatchInProcess(manifest, invocationArgs, cfg, logger);
  }
  return await dispatchSubprocess(manifest, invocationArgs, cfg, logger);
}
