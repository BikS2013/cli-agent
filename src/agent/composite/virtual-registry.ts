/**
 * Virtual-tool registry scan (plan-006 P6 / U-VIRTUAL).
 *
 * Walks `<agentDir>/composites/*` at boot time and produces one
 * {@link VirtualToolHandle} per validly-registered composite. Each
 * handle carries:
 *   - `name`             — the composite id (matches manifest.compositeName)
 *   - `manifest`         — the parsed schema-1 manifest
 *   - `description`      — the AUTO-GEN body of the composite's
 *                          schema-3 capability doc, used as the LLM-visible
 *                          tool description
 *   - `dispatch`         — closure that calls `dispatchComposite` (subprocess
 *                          by default, in-process opt-in per §14.K)
 *   - `langchainTool`    — a `DynamicStructuredTool` ready to append to
 *                          the registry catalog (consumed by `registry.ts`)
 *
 * Recursion guards:
 *   - **Dispatch-time**: if `process.env['CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD']`
 *     is `'1'` the loader returns an empty array without ever opening the
 *     `composites/` directory. This is the load-bearing guard documented in
 *     §14.K — the child cli-agent process spawned by `dispatchComposite`
 *     receives this env var, so its own registry boot never re-injects
 *     virtual tools.
 *   - **Register-time**: while iterating manifests, the loader records
 *     each composite name in a `Set` and rejects (with a stderr warning +
 *     skip) any composite whose member list contains another registered
 *     composite — preventing composite-of-composite at the registry
 *     level even when the dispatch guard is bypassed.
 *
 * Robustness:
 *   - A missing capability doc → warning + skip (the composite is
 *     unusable until `composite synthesize --regenerate` re-emits it).
 *   - A missing member capability doc → warning + skip the entire
 *     composite (mirroring the recipe-extractor's missing-input policy).
 *   - A malformed manifest is fatal: the underlying `readManifest`
 *     throws `ConfigurationError`. The caller decides whether to abort
 *     boot or surface the error — by default the catch in
 *     `loadVirtualTools` upgrades the throw into a stderr warning + skip
 *     so a single broken composite cannot break the entire CLI.
 *
 * Public API:
 *   loadVirtualTools(cfg)             → VirtualToolHandleWithTool[] (async)
 *   loadVirtualToolsSync(cfg)         → VirtualToolHandleWithTool[] (sync,
 *                                       used by buildToolCatalog at boot)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { AgentConfig } from '../../config/agent-config.js';
import type { Logger } from '../logging.js';
import type { CompositeManifest, VirtualToolHandle } from './types.js';
import { readManifestSync } from './manifest.js';
import { dispatchComposite } from './dispatcher.js';

const RECURSION_GUARD_ENV = 'CLI_AGENT_VIRTUAL_DISPATCH_RECURSION_GUARD';

/**
 * Boot-time-extended handle: carries the langchain `DynamicStructuredTool`
 * the registry can append directly to its catalog. The base
 * `VirtualToolHandle` (re-exported from types.ts) stays the public
 * cross-unit shape.
 */
export interface VirtualToolHandleWithTool extends VirtualToolHandle {
  /** A `DynamicStructuredTool` constructed by this module that wraps
   * `dispatch`. Its `name` matches the composite id; its description
   * is the full composite doc body capped at the per-tool budget. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly langchainTool: any;
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function emitWarning(message: string, logger?: Logger): void {
  process.stderr.write(`[cli-agent] warning: ${message}\n`);
  if (logger) {
    try {
      logger.log({
        kind: 'error',
        ts: new Date().toISOString(),
        sessionId: logger.currentSessionId,
        code: 'composite_virtual_registry_warning',
        message,
      });
    } catch {
      /* logger failures must never break tool registration */
    }
  }
}

/**
 * Read the description text for a composite from its capability doc.
 * Strips the YAML frontmatter and AUTO-GEN markers, returning a trimmed
 * body suitable for use as a tool description. On any read failure
 * returns `null` so the caller can decide whether to skip.
 */
function readCompositeDescription(capabilityDocPath: string): string | null {
  let raw: string;
  try {
    raw = fs.readFileSync(capabilityDocPath, 'utf8');
  } catch {
    return null;
  }
  // Strip frontmatter
  const fmStrip = raw.replace(/^---\n[\s\S]*?\n---\n/, '');
  // Strip AUTO-GEN markers if present (keep body)
  const autoGenMatch = fmStrip.match(
    /<!--\s*AUTO-GEN-START\s*-->([\s\S]*?)<!--\s*AUTO-GEN-END\s*-->/,
  );
  const body = autoGenMatch?.[1] ?? fmStrip;
  return body.trim();
}

/**
 * Build a `DynamicStructuredTool` that, when invoked by the LLM, calls
 * `dispatchComposite` with the captured manifest. The tool exposes a
 * single `prompt` argument — the composite is a black-box higher-level
 * tool that takes a natural-language goal and returns the inner
 * agent's answer.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildLangchainTool(
  manifest: CompositeManifest,
  description: string,
  cfg: AgentConfig,
  logger?: Logger,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  // Cap description at a generous-but-finite budget so a runaway
  // composite doc cannot blow up the system prompt token budget.
  const MAX_DESC_BYTES = 8192;
  const cappedDesc =
    Buffer.byteLength(description, 'utf8') > MAX_DESC_BYTES
      ? description.slice(0, MAX_DESC_BYTES) + '\n…TRUNCATED'
      : description;

  const schema = z.object({
    prompt: z
      .string()
      .min(1)
      .describe(
        `Natural-language task for the composite tool '${manifest.compositeName}'. ` +
          `This composite delegates to its members: ${manifest.members.join(', ')}.`,
      ),
  });

  return new DynamicStructuredTool({
    name: manifest.compositeName,
    description:
      cappedDesc ||
      `Composite tool '${manifest.compositeName}' aggregating members: ${manifest.members.join(', ')}`,
    schema,
    func: async (input: { prompt: string }): Promise<string> => {
      const result = await dispatchComposite({
        manifest,
        invocationArgs: [input.prompt],
        mode: resolveDispatchMode(cfg),
        cfg,
        logger: logger ?? createNullLogger(),
      });
      if (result.exitCode !== 0) {
        return JSON.stringify({
          error: {
            code: 'E_COMPOSITE_DISPATCH',
            message: `Composite '${manifest.compositeName}' exited with code ${result.exitCode}`,
            stderr: result.stderr.slice(0, 4096),
          },
        });
      }
      return result.stdout;
    },
  });
}

function resolveDispatchMode(cfg: AgentConfig): 'child-process' | 'in-process' {
  // Honour `cfg.virtualDispatch` when present (forward-compatible with
  // the field U-CMD will add to AgentConfig); fall back to the env var
  // documented in §14.K. Default: 'child-process' (ADR-CMP-7).
  const fromCfg = (cfg as unknown as Record<string, unknown>)['virtualDispatch'];
  if (fromCfg === 'in-process') return 'in-process';
  if (fromCfg === 'child-process') return 'child-process';
  if (process.env['CLI_AGENT_VIRTUAL_DISPATCH'] === 'in-process') return 'in-process';
  return 'child-process';
}

function createNullLogger(): Logger {
  return {
    log: () => undefined,
    flush: async () => undefined,
    close: async () => undefined,
    get currentLogPath() {
      return '';
    },
    get currentSessionId() {
      return 'null-session';
    },
  };
}

/* ------------------------------------------------------------------ */
/* Sync scan (used by buildToolCatalog at boot)                        */
/* ------------------------------------------------------------------ */

interface ScanContext {
  readonly cfg: AgentConfig;
  readonly logger: Logger | undefined;
  readonly registeredCompositeNames: ReadonlySet<string>;
}

function scanCompositesDir(ctx: ScanContext): VirtualToolHandleWithTool[] {
  const compositesDir = ctx.cfg.compositesDir;
  if (!compositesDir) {
    // Test fixtures sometimes omit compositesDir; treat as "no virtuals".
    return [];
  }

  // Walk the directory; tolerate missing root (composites have never
  // been registered yet — the boot path must succeed).
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(compositesDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    emitWarning(
      `loadVirtualTools: failed to scan compositesDir '${compositesDir}': ${(err as Error).message}`,
      ctx.logger,
    );
    return [];
  }

  const handles: VirtualToolHandleWithTool[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const id = entry.name;
    const manifestPath = path.join(compositesDir, id, 'manifest.json');

    let manifest: CompositeManifest | null;
    try {
      manifest = readManifestSync(manifestPath);
    } catch (err) {
      emitWarning(
        `loadVirtualTools: composite '${id}' has a malformed manifest (${(err as Error).message}); skipping`,
        ctx.logger,
      );
      continue;
    }
    if (manifest === null) {
      // No manifest in this dir — could be a wrapper-only composite
      // (form b without form c). Silent skip; not an error.
      continue;
    }

    if (manifest.compositeName !== id) {
      emitWarning(
        `loadVirtualTools: composite '${id}' manifest declares a different compositeName ` +
          `('${manifest.compositeName}'); skipping`,
        ctx.logger,
      );
      continue;
    }

    // Register-time recursion guard: refuse if any member is itself a
    // registered composite. The names of all currently-registered
    // composites are pre-computed in `ctx.registeredCompositeNames`.
    const offending = manifest.members.find((m) => ctx.registeredCompositeNames.has(m));
    if (offending) {
      emitWarning(
        `loadVirtualTools: composite '${id}' lists member '${offending}' which is itself a ` +
          `registered composite; composite-of-composite is not supported in v1 (FR-CMP-016); skipping`,
        ctx.logger,
      );
      continue;
    }

    // Member capability docs must exist (otherwise the composite is
    // unusable — the inner agent would fail to load capabilities).
    let allMembersPresent = true;
    for (const member of manifest.members) {
      const memberDoc = path.join(ctx.cfg.capabilitiesDir, `${member}.md`);
      try {
        fs.accessSync(memberDoc, fs.constants.R_OK);
      } catch {
        emitWarning(
          `loadVirtualTools: composite '${id}' member '${member}' is missing capability doc ` +
            `'${memberDoc}'; skipping composite`,
          ctx.logger,
        );
        allMembersPresent = false;
        break;
      }
    }
    if (!allMembersPresent) continue;

    // Composite capability doc must exist; absent → skip.
    let description = readCompositeDescription(manifest.capabilityDocPath);
    if (description === null) {
      emitWarning(
        `loadVirtualTools: composite '${id}' capability doc is missing or unreadable at ` +
          `'${manifest.capabilityDocPath}'; skipping`,
        ctx.logger,
      );
      continue;
    }

    const langchainTool = buildLangchainTool(manifest, description, ctx.cfg, ctx.logger);

    const handle: VirtualToolHandleWithTool = {
      name: manifest.compositeName,
      manifest,
      description,
      dispatch: async (args: readonly string[]) => {
        const result = await dispatchComposite({
          manifest,
          invocationArgs: args,
          mode: resolveDispatchMode(ctx.cfg),
          cfg: ctx.cfg,
          logger: ctx.logger ?? createNullLogger(),
        });
        return result;
      },
      langchainTool,
    };
    handles.push(handle);
  }

  return handles;
}

/**
 * Pre-compute the set of registered composite names so the
 * register-time recursion guard can detect "member is a composite"
 * before constructing any handle. Returns an empty set when the
 * compositesDir does not exist.
 */
function preScanCompositeNames(cfg: AgentConfig): Set<string> {
  const dir = cfg.compositesDir;
  if (!dir) return new Set<string>();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return new Set<string>();
  }
  const names = new Set<string>();
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const m = path.join(dir, e.name, 'manifest.json');
    try {
      const parsed = readManifestSync(m);
      if (parsed) names.add(parsed.compositeName);
    } catch {
      /* skip — the main scan will surface the warning */
    }
  }
  return names;
}

/**
 * Synchronous virtual-tools loader used by `buildToolCatalog`. Honours
 * the dispatch-time recursion guard and returns `[]` immediately when
 * the env sentinel is set.
 */
export function loadVirtualToolsSync(
  cfg: AgentConfig,
  logger?: Logger,
): VirtualToolHandleWithTool[] {
  if (process.env[RECURSION_GUARD_ENV] === '1') {
    // Dispatch-time guard: child cli-agent processes must NEVER load
    // virtual tools. This prevents composite-of-composite recursion
    // structurally — even a hand-crafted manifest cannot leak through.
    return [];
  }
  const registeredCompositeNames = preScanCompositeNames(cfg);
  return scanCompositesDir({ cfg, logger, registeredCompositeNames });
}

/**
 * Public async entrypoint per plan-006 §14.D / §14.P. Internally
 * delegates to {@link loadVirtualToolsSync} — the I/O is small and
 * synchronous filesystem reads keep `buildToolCatalog` fully sync.
 * The async signature is preserved so U-CMD subcommands (which await
 * other async setup) consume it via the documented contract.
 */
export async function loadVirtualTools(
  cfg: AgentConfig,
  logger?: Logger,
): Promise<readonly VirtualToolHandleWithTool[]> {
  return Object.freeze(loadVirtualToolsSync(cfg, logger));
}
