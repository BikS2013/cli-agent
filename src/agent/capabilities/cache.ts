/**
 * Cache read/write for per-tool capability documents.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  CAPABILITY_SCHEMA_VERSION,
  extractUserNotes,
  extractUserRecipes,
} from './composeMarkdown.js';

export interface CacheFrontmatter {
  tool: string;
  binaryPath: string;
  binaryMtimeMs: number;
  versionString: string;
  versionHash: string;
  introspectedAt: string;
  introspectionDepth: number;
  introspectionBytes: number;
  schemaVersion: number;
  /** Canonical man-page identifier (e.g. `man:1 git`). Schema-2 only;
   * absent on schema-1 docs (which are treated as cache miss anyway). */
  manRef?: string | null;
  /** Absolute path of the underlying man-page file. Schema-2 only. */
  manPagePath?: string | null;
}

const SUPPORTED_SCHEMA_VERSION = CAPABILITY_SCHEMA_VERSION;

export interface CacheEntry {
  frontmatter: CacheFrontmatter;
  fullContent: string;
  userNotes: string;
  userRecipes: string;
}

function parseFrontmatter(raw: string): CacheFrontmatter | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const lines = match[1]!.split('\n');
  const obj: Record<string, unknown> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value: string = line.slice(colon + 1).trim();
    // Strip surrounding quotes
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    obj[key] = value;
  }
  const manRefRaw = obj['manRef'];
  const manPagePathRaw = obj['manPagePath'];
  return {
    tool: String(obj['tool'] ?? ''),
    binaryPath: String(obj['binaryPath'] ?? ''),
    binaryMtimeMs: Number(obj['binaryMtimeMs'] ?? 0),
    versionString: String(obj['versionString'] ?? ''),
    versionHash: String(obj['versionHash'] ?? ''),
    introspectedAt: String(obj['introspectedAt'] ?? ''),
    introspectionDepth: Number(obj['introspectionDepth'] ?? 0),
    introspectionBytes: Number(obj['introspectionBytes'] ?? 0),
    schemaVersion: Number(obj['schemaVersion'] ?? 0),
    manRef: typeof manRefRaw === 'string' && manRefRaw.length > 0 ? manRefRaw : null,
    manPagePath: typeof manPagePathRaw === 'string' && manPagePathRaw.length > 0 ? manPagePathRaw : null,
  };
}

export async function readCacheEntry(capabilitiesDir: string, tool: string): Promise<CacheEntry | null> {
  const filePath = path.join(capabilitiesDir, `${tool}.md`);
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    const fm = parseFrontmatter(content);
    if (!fm) return null;

    if (fm.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      // Unsupported schema version — treat as cache miss
      return null;
    }

    return {
      frontmatter: fm,
      fullContent: content,
      userNotes: extractUserNotes(content),
      userRecipes: extractUserRecipes(content),
    };
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeCacheEntry(
  capabilitiesDir: string,
  tool: string,
  content: string,
): Promise<void> {
  const filePath = path.join(capabilitiesDir, `${tool}.md`);
  await fsp.writeFile(filePath, content, { encoding: 'utf8', mode: 0o600 });
}

export function toolCapabilityPath(capabilitiesDir: string, tool: string): string {
  return path.join(capabilitiesDir, `${tool}.md`);
}
