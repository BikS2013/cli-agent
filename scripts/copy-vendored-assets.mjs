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
 * Strategy: walk only the vendored upstream source tree and copy `*.prompt.md`
 * files into the same relative path under dist/.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const srcRoot = path.join(projectRoot, 'src', 'agent', 'tools', 'agent-tools-vendored', 'upstream', 'src');
const distRoot = path.join(projectRoot, 'dist');

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
      await walk(fullPath);
      continue;
    }
    if (!entry.isFile()) continue;

    if (!entry.name.endsWith('.prompt.md')) continue;

    const relPath = path.relative(path.join(projectRoot, 'src'), fullPath);
    const destPath = path.join(distRoot, relPath);
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.copyFile(fullPath, destPath);
    copiedCount += 1;
  }
}

await walk(srcRoot);
console.log(`[postbuild:assets] Copied ${copiedCount} vendored prompt asset(s) from src/ to dist/.`);
