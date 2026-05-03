/**
 * `composite-synthesize` (and the `--treat-as-tool --help` `mode:
 * 'help-synthesis'` flow) — plan-006 P6 / U-CMD.
 *
 * Drives the full synthesis pipeline:
 *   1. Parse + validate composite flags via U-FLAGS.
 *   2. Resolve the composite name (`--composite-name` or
 *      `deriveCompositeName`).
 *   3. Load `AgentConfig`, construct the LLM, gather member capability
 *      docs.
 *   4. Call `synthesizeComposite` (U-SYNTH).
 *   5. Honour the three distribution forms (§14.I):
 *      a. `--emit-doc` (default ON when `--treat-as-tool`) — schema-3
 *         doc at `<compositeCapabilitiesDir>/<id>.md` + mirror copy.
 *      b. `--emit-wrapper` — POSIX shim under `<compositesDir>/<id>/<id>`;
 *         optional `--emit-wrapper-on-path` symlink.
 *      c. `--register-virtual` — manifest.json at
 *         `<compositesDir>/<id>/manifest.json`.
 *   6. For `mode: 'help-synthesis'`: print the synthesised doc to stdout
 *      so `cli-agent --treat-as-tool --tool A --tool B --help` shows the
 *      composite help.
 *
 * Exit codes follow §14.E + the project-wide errors.ts mapping.
 *
 * Dynamic imports for U-SYNTH (`synthesizer.ts`) and U-VIRTUAL
 * (`manifest.ts`):
 *   These two units are owned by other parallel coders and may not be
 *   merged at the moment U-CMD lands. We `await import(...)` them so
 *   TypeScript only validates the call site (any dot-access on a
 *   dynamically-typed namespace) and the runtime error message is
 *   actionable when the unit is genuinely missing. Once the parallel
 *   units land, the same code path resolves the real exports without
 *   modification.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  ConfigurationError,
  FileError,
  UsageError,
} from '../../errors.js';
import {
  parseCompositeFlags,
  enforceCompositeFlagMatrix,
  type CompositeCliFlags,
} from '../../cli-composite-flags.js';
import { loadAgentConfig } from '../../config/agent-config.js';
import {
  computeMemberDocDigest,
} from '../../agent/composite/cache.js';
import {
  generateCompositeWrapperShim,
  generatePathSymlink,
} from '../../agent/composite/shim-writer.js';
import type {
  AgentConfig,
  CompositeFrontmatter,
  CompositeManifest,
  CompositeMemberRef,
  SynthesisInputs,
  SynthesisResult,
} from '../../agent/composite/types.js';
import { nullLogger } from '../../agent/logging.js';
import {
  canonicalDocPathFor,
  compositeFolderFor,
  deriveCompositeName,
  manifestPathFor,
  mirrorDocPathFor,
  regenerateCompositeDoc,
  shimPathFor,
  validateCompositeName,
} from './shared.js';

/* ------------------------------------------------------------------ */
/* Public option shape                                                  */
/* ------------------------------------------------------------------ */

/**
 * Discriminator separating the two routes by which the synthesise
 * handler is invoked:
 *   - `synthesize-cmd` — explicit `cli-agent composite-synthesize ...`.
 *   - `help-synthesis` — `cli-agent --treat-as-tool --tool A ... --help`,
 *      routed through `runComposite` (the foundation entry point).
 */
export type SynthesizeMode = 'synthesize-cmd' | 'help-synthesis';

export interface SynthesizeRunOptions {
  readonly mode: SynthesizeMode;
  /** Pre-parsed composite flags. When absent, the handler parses
   * `rawOpts` itself. */
  readonly flags?: CompositeCliFlags;
  /** Sorted member tool names. Required and non-empty. */
  readonly tools: readonly string[];
  /** Raw Commander opts object — used to derive `flags` when the
   * caller did not pre-parse, and to enforce the §14.H matrix. */
  readonly rawOpts?: Record<string, unknown>;
  /** Optional override for the resolved AgentConfig. Tests inject a
   * pre-built config; production calls fall through to
   * `loadAgentConfig()`. */
  readonly cfgOverride?: AgentConfig;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

export async function handleSynthesize(
  opts: SynthesizeRunOptions,
): Promise<void> {
  const tools = [...opts.tools].sort();
  if (tools.length === 0) {
    throw new UsageError(
      'composite synthesis requires at least one --tool argument',
    );
  }

  // Flag parsing + matrix enforcement. Dual-entry: subcommand callers
  // pass `rawOpts` already containing every composite knob; the
  // help-synthesis path is invoked from cli.ts which has already
  // enforced the matrix once — re-enforcing here is a defence-in-depth
  // no-op for that path.
  const flags = opts.flags ?? parseCompositeFlags(opts.rawOpts ?? {});
  enforceCompositeFlagMatrix(flags, {
    tools,
    help: opts.mode === 'help-synthesis',
  });

  // Resolve composite name.
  const compositeName = flags.compositeName !== null
    ? validateCompositeName(flags.compositeName)
    : deriveCompositeName(tools);

  // Load agent config (the pipeline needs the LLM, paths, profile).
  const cfg = opts.cfgOverride ?? (await loadAgentConfig());

  // Resolve member capability docs. For composite synthesis the docs
  // MUST already exist at `<capabilitiesDir>/<name>.md` — we do NOT
  // run discovery here (that is `--refresh-capabilities` territory,
  // ADR-CMP-3).
  const members = await resolveMembers(cfg, tools);

  // Build SynthesisInputs and call U-SYNTH (dynamic import so this
  // module compiles before the synthesizer.ts unit lands).
  const synthesizer = await loadSynthesizer();

  // U-SYNTH consumes the LLM via the registry factory; we let
  // synthesizer construct its own LLM from cfg to avoid duplicating
  // the wiring here.
  const llm = await loadLLM(cfg);

  const inputs: SynthesisInputs = {
    cfg,
    llm,
    members: members.map((m) => m.name),
    compositeName,
    dryRun: flags.dryRunSynthesis,
    budgetTokens: flags.synthesisBudgetTokens,
    logger: nullLogger(),
  };

  const result: SynthesisResult = await synthesizer.synthesizeComposite(inputs);

  // Dry-run: pipeline did not call the LLM and did not write the
  // cache. Emit the would-be prompts (the synthesizer returns them in
  // `result.doc` for the dry-run path) and exit 0.
  if (flags.dryRunSynthesis) {
    process.stdout.write(result.doc);
    if (!result.doc.endsWith('\n')) process.stdout.write('\n');
    return;
  }

  // ---- Distribution forms ----
  const summary: string[] = [];
  const warnings: string[] = [];

  // Form a — emit-doc (default ON whenever --treat-as-tool is set).
  let docPath: string | null = null;
  let mirrorPath: string | null = null;
  if (flags.emitDoc) {
    const compositeDocPath = canonicalDocPathFor(
      cfg.compositeCapabilitiesDir,
      compositeName,
    );
    const reg = await regenerateCompositeDoc({
      frontmatter: result.frontmatter,
      autoGenBody: extractAutoGen(result.doc),
      userRecipes: extractRecipes(result.doc),
      userNotes: extractNotes(result.doc),
      compositeDocPath,
      capabilitiesDir: cfg.capabilitiesDir,
      compositeName,
    });
    docPath = reg.compositeDocPath;
    mirrorPath = reg.mirrorPath;
    summary.push(`emitted doc: ${docPath}`);
    summary.push(`mirror:      ${mirrorPath}`);
    if (reg.preservedUserBlocks) {
      summary.push('(preserved USER-RECIPES / USER-NOTES blocks)');
    }
  }

  // Form b — emit-wrapper (POSIX shim).
  let shimPath: string | null = null;
  if (flags.emitWrapper) {
    if (docPath === null) {
      // The shim points at the canonical doc; if --no-emit-doc was
      // set the canonical doc was not written, so the shim's `--help`
      // branch would be stale. The matrix forbids the all-disabled
      // combination but a `--no-emit-doc --emit-wrapper` pairing is
      // permitted — point the shim at the path the canonical writer
      // WOULD have used so a future re-emit picks it up.
      docPath = canonicalDocPathFor(cfg.compositeCapabilitiesDir, compositeName);
    }
    const cliBin = resolveCliAgentBin();
    const shimDir = compositeFolderFor(cfg.compositesDir, compositeName);
    const shimRes = await generateCompositeWrapperShim({
      compositeName,
      members: members.map((m) => m.name),
      cliAgentBinPath: cliBin,
      capabilityDocPath: docPath,
      shimDir,
      synthesizedAt: result.frontmatter.synthesizedAt,
    });
    shimPath = shimRes.path;
    summary.push(`emitted shim: ${shimPath}`);
    warnings.push(...shimRes.warnings);

    if (flags.emitWrapperOnPath) {
      const symlink = await generatePathSymlink(shimPath, compositeName);
      summary.push(`PATH symlink: ${symlink.symlinkPath}`);
      warnings.push(...symlink.warnings);
    }
  }

  // Form c — register-virtual (manifest).
  let manifestPath: string | null = null;
  if (flags.registerVirtual) {
    const virtualMod = await loadVirtualModule();
    manifestPath = manifestPathFor(cfg.compositesDir, compositeName);
    const manifest: CompositeManifest = {
      schemaVersion: 1,
      compositeName,
      members: members.map((m) => m.name),
      memberDigests: Object.fromEntries(
        members.map((m) => [m.name, m.digest]),
      ) as Readonly<Record<string, string>>,
      createdAt: result.frontmatter.synthesizedAt,
      cliAgentVersion: result.frontmatter.cliAgentVersion,
      capabilityDocPath: docPath ?? canonicalDocPathFor(
        cfg.compositeCapabilitiesDir,
        compositeName,
      ),
      distribution: {
        emitDoc: flags.emitDoc,
        emitWrapper: flags.emitWrapper,
        emitWrapperOnPath: flags.emitWrapperOnPath,
        registerVirtual: true,
      },
    };
    await virtualMod.writeManifest(manifestPath, manifest, {
      force: flags.forceOverwrite,
    });
    summary.push(`manifest:    ${manifestPath}`);
  }

  // ---- Final report ----
  if (opts.mode === 'help-synthesis') {
    // The user typed `--treat-as-tool --help` — they want to SEE the
    // composite's capability doc on stdout. Side-effects (file
    // writes) ran above but are summarised on stderr so the stdout
    // stream stays pipe-clean.
    process.stdout.write(result.doc);
    if (!result.doc.endsWith('\n')) process.stdout.write('\n');
    if (summary.length > 0) {
      process.stderr.write(`\n[cli-agent composite] ${compositeName}\n`);
      for (const line of summary) process.stderr.write(`  ${line}\n`);
    }
  } else {
    process.stdout.write(`composite '${compositeName}' synthesised\n`);
    for (const line of summary) process.stdout.write(`  ${line}\n`);
  }
  for (const w of warnings) process.stderr.write(`[cli-agent] warning: ${w}\n`);
}

/* ------------------------------------------------------------------ */
/* Member resolution                                                    */
/* ------------------------------------------------------------------ */

async function resolveMembers(
  cfg: AgentConfig,
  tools: readonly string[],
): Promise<CompositeMemberRef[]> {
  const out: CompositeMemberRef[] = [];
  for (const name of tools) {
    const docPath = path.join(cfg.capabilitiesDir, `${name}.md`);
    let raw: string;
    try {
      raw = await fsp.readFile(docPath, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new ConfigurationError(
          `capability document for member tool '${name}'`,
          [
            `${docPath}`,
            'run `cli-agent --tool <name>` once to populate the cache, OR',
            'run `cli-agent refresh-capabilities --tool <name>` explicitly',
          ],
          { tool: name, expectedPath: docPath },
        );
      }
      throw new FileError(
        'E_FILE_PERMISSION',
        `failed to read capability doc for '${name}': ${(e as Error).message}`,
        { tool: name, path: docPath },
      );
    }
    const digest = computeMemberDocDigest(raw);
    out.push({ name, docPath, digest });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Dynamic-import shims for U-SYNTH and U-VIRTUAL                       */
/* ------------------------------------------------------------------ */

interface SynthesizerModule {
  synthesizeComposite: (input: SynthesisInputs) => Promise<SynthesisResult>;
}

async function loadSynthesizer(): Promise<SynthesizerModule> {
  try {
    const mod = (await import(
      '../../agent/composite/synthesizer.js'
    )) as Partial<SynthesizerModule>;
    if (typeof mod.synthesizeComposite !== 'function') {
      throw new Error(
        "src/agent/composite/synthesizer.ts does not export 'synthesizeComposite'",
      );
    }
    return { synthesizeComposite: mod.synthesizeComposite };
  } catch (e) {
    throw new ConfigurationError(
      'composite synthesis pipeline (U-SYNTH)',
      ['src/agent/composite/synthesizer.ts'],
      {
        detail:
          'composite synthesis is unavailable until plan-006 P6 unit U-SYNTH lands',
        cause: (e as Error).message,
      },
    );
  }
}

interface VirtualModule {
  writeManifest: (
    path: string,
    manifest: CompositeManifest,
    opts: { force: boolean },
  ) => Promise<void>;
  readManifest?: (path: string) => Promise<CompositeManifest | null>;
}

async function loadVirtualModule(): Promise<VirtualModule> {
  try {
    const mod = (await import(
      '../../agent/composite/manifest.js'
    )) as Partial<VirtualModule>;
    if (typeof mod.writeManifest !== 'function') {
      throw new Error(
        "src/agent/composite/manifest.ts does not export 'writeManifest'",
      );
    }
    return { writeManifest: mod.writeManifest, readManifest: mod.readManifest };
  } catch (e) {
    throw new ConfigurationError(
      'composite virtual-tool registry (U-VIRTUAL)',
      ['src/agent/composite/manifest.ts'],
      {
        detail:
          'virtual-tool registration is unavailable until plan-006 P6 unit U-VIRTUAL lands',
        cause: (e as Error).message,
      },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Provider/LLM construction (delegates to provider registry)          */
/* ------------------------------------------------------------------ */

async function loadLLM(cfg: AgentConfig): Promise<SynthesisInputs['llm']> {
  // The provider-registry export name is `createLLM(cfg)` per
  // §14.G. Dynamic-import to avoid pulling the entire provider tree
  // into module load when U-CMD is loaded for an unrelated subcommand
  // (e.g. composite-list).
  const reg = (await import('../../agent/providers/registry.js')) as {
    createLLM?: (cfg: AgentConfig) => SynthesisInputs['llm'];
  };
  if (typeof reg.createLLM !== 'function') {
    throw new ConfigurationError(
      'createLLM provider factory',
      ['src/agent/providers/registry.ts'],
      { detail: "module did not export 'createLLM'" },
    );
  }
  return reg.createLLM(cfg);
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function resolveCliAgentBin(): string {
  // Prefer `process.argv[1]` (the script Node was invoked with). Falls
  // back to `process.execPath` only if argv[1] is missing — that
  // resolves to the Node binary, which is incorrect, so we throw
  // instead of silently writing a broken shim.
  const a1 = process.argv[1];
  if (typeof a1 === 'string' && a1.length > 0 && path.isAbsolute(a1)) {
    return a1;
  }
  if (typeof a1 === 'string' && a1.length > 0) {
    return path.resolve(process.cwd(), a1);
  }
  throw new ConfigurationError('cli-agent binary path', [
    'process.argv[1]',
  ], {
    detail:
      'unable to resolve absolute path to the running cli-agent binary; ' +
      'shim emission requires it (ADR-CMP-9).',
  });
}

/**
 * Best-effort extractor for the AUTO-GENERATED body inside a fully
 * composed schema-3 doc. Mirrors `cache.ts:extractAutoGenBody` but
 * inlined here because U-SYNTH may return either the composed doc OR
 * just the body — we treat the former as the contract (per §14.D
 * `SynthesisResult.doc` is "Full schema-3 markdown body, ready to
 * write to disk"). When the markers are absent we return the entire
 * doc as the AUTO-GEN body so the regenerator does not error out.
 */
function extractAutoGen(doc: string): string {
  const startIdx = doc.indexOf('<!-- AUTO-GENERATED:START');
  const endIdx = doc.indexOf('<!-- AUTO-GENERATED:END -->');
  if (startIdx === -1 || endIdx === -1) return doc.trim();
  const lineStart = doc.indexOf('\n', startIdx) + 1;
  return doc.slice(lineStart, endIdx).trim();
}

function extractRecipes(doc: string): string {
  return extractTagged(doc, '<!-- USER-RECIPES:START -->', '<!-- USER-RECIPES:END -->');
}

function extractNotes(doc: string): string {
  return extractTagged(doc, '<!-- USER-NOTES:START -->', '<!-- USER-NOTES:END -->');
}

function extractTagged(doc: string, start: string, end: string): string {
  const s = doc.indexOf(start);
  const e = doc.indexOf(end);
  if (s === -1 || e === -1 || e < s) return '';
  return doc.slice(s + start.length, e).trim();
}

/* ------------------------------------------------------------------ */
/* Re-export for the dispatcher                                         */
/* ------------------------------------------------------------------ */

export type { CompositeFrontmatter };
