/**
 * `composite-list` (alias `composites`) — enumerate the schema-3
 * composite docs under `<compositeCapabilitiesDir>/`.
 *
 * Default output: aligned table (NAME / MEMBERS / SYNTHESIZED_AT /
 * DIGEST). `--json` opts into machine-readable output.
 *
 * Spec: plan-006 §14.E; FR-CMP-022; AC-22.
 *
 * The listing source-of-truth is the canonical schema-3 doc directory
 * (form a) — registered virtual composites (form c, manifest.json) are
 * a strict subset of doc emissions per §14.I. The `--json` payload
 * surfaces the full frontmatter so callers can pipe into `jq`.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

import { agentCompositeCapabilitiesDir } from '../../config/agent-config.js';
import { readCompositeDoc } from '../../agent/composite/cache.js';
import { emitJson, renderTable } from './shared.js';

export interface CompositeListOpts {
  readonly json?: boolean;
  /** Test seam — overrides the resolved composite-capabilities dir. */
  readonly compositeCapabilitiesDirOverride?: string;
}

export async function runCompositeList(
  opts: CompositeListOpts = {},
): Promise<void> {
  // Listing is a read-only filesystem walk — it does NOT need an LLM
  // provider configured, so we bypass the full `loadAgentConfig()`
  // chain (which raises ConfigurationError for missing `provider`).
  const dir =
    opts.compositeCapabilitiesDirOverride ?? agentCompositeCapabilitiesDir();

  let entries: string[] = [];
  try {
    const all = await fsp.readdir(dir);
    entries = all
      .filter((e) => e.endsWith('.md'))
      .map((e) => path.join(dir, e));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
    // Directory does not exist yet — treat as empty.
    entries = [];
  }

  const composites: Array<{
    name: string;
    members: readonly string[];
    synthesizedAt: string;
    digest: string;
    path: string;
  }> = [];

  for (const filePath of entries) {
    const r = await readCompositeDoc(filePath);
    if (!r.ok) continue; // skip stale/malformed docs in listing
    composites.push({
      name: r.doc.frontmatter.compositeName,
      members: r.doc.frontmatter.members,
      synthesizedAt: r.doc.frontmatter.synthesizedAt,
      digest: r.doc.frontmatter.syntheticDigest,
      path: filePath,
    });
  }

  // Sort by name for deterministic output.
  composites.sort((a, b) => a.name.localeCompare(b.name));

  if (opts.json) {
    emitJson(
      composites.map((c) => ({
        name: c.name,
        members: c.members,
        synthesizedAt: c.synthesizedAt,
        digest: c.digest,
        path: c.path,
      })),
    );
    return;
  }

  if (composites.length === 0) {
    process.stderr.write(
      `no composites found under ${dir}\n` +
        `Hint: cli-agent composite-synthesize --tool A --tool B\n`,
    );
    return;
  }

  const rows = composites.map((c) => [
    c.name,
    c.members.join(','),
    c.synthesizedAt,
    c.digest,
  ]);
  process.stdout.write(
    renderTable(['NAME', 'MEMBERS', 'SYNTHESIZED_AT', 'DIGEST'], rows),
  );
}
