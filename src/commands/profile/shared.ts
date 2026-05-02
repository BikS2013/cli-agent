/**
 * Shared helpers for the profile-* subcommand handlers (U-CLI).
 *
 * Houses output formatting (aligned columns, ISO-short dates), the
 * dry-run trace structure, and small predicates reused across the six
 * handlers. Anything tightly coupled to a single subcommand stays in
 * its own file.
 */

import type { ProfileFileEntry } from '../../config/profile-loader.js';

/* ---------- Source-attribution enum (dry-run trace) ---------- */

/**
 * One of the seven possible sources for a resolved configuration knob.
 * Matches the design spec §12.J / plan-005 §5 U-CLI.
 */
export type KnobSource =
  | 'cli-flag'
  | `env:${string}`
  | 'agent-dir-.env'
  | 'local-.env'
  | `profile:${string}`
  | 'config.json'
  | 'built-in-default';

export interface KnobTrace {
  readonly knob: string;
  readonly value: unknown;
  readonly source: KnobSource;
}

/* ---------- Table formatting ---------- */

/**
 * Render a 2-column or N-column aligned table to a string. Follows the
 * existing `audit-tool-prompts` style: pad-right columns separated by
 * two spaces, dashed underline row between header and body.
 */
export function renderTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const sep = '  ';
  const fmtRow = (cells: ReadonlyArray<string>): string =>
    cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(sep).trimEnd();

  const lines: string[] = [];
  lines.push(fmtRow(headers));
  lines.push(fmtRow(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) lines.push(fmtRow(r));
  return lines.join('\n') + '\n';
}

/**
 * Format a Date as `YYYY-MM-DD HH:mm` (UTC). Short, sortable, and free
 * of timezone ambiguity for the table output.
 */
export function formatMtime(d: Date): string {
  const yr = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  const hr = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${yr}-${mo}-${da} ${hr}:${mi}`;
}

/**
 * Convert byte size into a compact human form (e.g. `1.2K`, `34B`).
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * Render the table emitted by `profile-list`.
 */
export function renderProfileListTable(entries: ReadonlyArray<ProfileFileEntry>): string {
  const rows = entries.map((e) => [
    e.name,
    e.description ?? '',
    formatSize(e.size),
    formatMtime(e.mtime),
  ]);
  return renderTable(['NAME', 'DESCRIPTION', 'SIZE', 'MTIME'], rows);
}

/* ---------- Stringification of arbitrary knob values ---------- */

/**
 * Stringify a config knob value for display in the dry-run table. Strings
 * are passed through verbatim, primitives are JSON-encoded for clarity,
 * and arrays/objects fall back to compact JSON.
 */
export function formatKnobValue(v: unknown): string {
  if (v === undefined) return '<unset>';
  if (v === null) return 'null';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
