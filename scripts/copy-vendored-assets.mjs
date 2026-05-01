#!/usr/bin/env node
/**
 * Copies non-TypeScript runtime assets from src/ into dist/ after `tsc` runs.
 *
 * tsc only emits .js / .d.ts files. The vendored agent-tools upstream bundles
 * `.prompt.md` files alongside its source modules and reads them with
 * `readFileSync(path.join(import.meta.url, '...'))` at runtime. Without this
 * step, the published / built CLI throws ENOENT on first import of any
 * `agt_*` tool.
 *
 * Strategy: walk src/ recursively, copy any file matching the
 * `EXTENSIONS_TO_COPY` set into the same relative path under dist/.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(projectRoot, 'src');
const distRoot = path.join(projectRoot, 'dist');

// Files with these extensions are runtime assets and must be mirrored to dist/.
const EXTENSIONS_TO_COPY = new Set(['.md', '.txt', '.json']);

// Skip these directories — they are documentation/test fixtures, not runtime assets.
const SKIP_DIRS = new Set(['__tests__', '__fixtures__', 'node_modules']);

let copiedCount = 0;

async function walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;

    const ext = path.extname(entry.name).toLowerCase();
    if (!EXTENSIONS_TO_COPY.has(ext)) continue;

    // Skip spec/test fixtures.
    if (entry.name.endsWith('.spec.md') || entry.name.endsWith('.test.md')) continue;

    const relPath = path.relative(srcRoot, fullPath);
    const destPath = path.join(distRoot, relPath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(fullPath, destPath);
    copiedCount += 1;
  }
}

await walk(srcRoot);
console.log(`[postbuild:assets] Copied ${copiedCount} runtime asset(s) from src/ to dist/.`);
