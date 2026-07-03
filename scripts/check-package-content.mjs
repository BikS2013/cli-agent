#!/usr/bin/env node
/**
 * Verifies the npm publish payload produced by `npm pack --dry-run`.
 *
 * This intentionally checks the packed file list rather than the working tree,
 * so it catches mistakes in `files`, build output, and postbuild asset copying.
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const failures = [];

function fail(message) {
  failures.push(message);
}

async function collectPromptAssets(dir) {
  const assets = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return assets;
    throw err;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      assets.push(...await collectPromptAssets(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.prompt.md')) {
      assets.push(fullPath);
    }
  }

  return assets;
}

function parsePackJson(stdout) {
  const text = stdout.trim();
  if (text.length === 0) {
    throw new Error('npm pack produced empty stdout');
  }
  try {
    return JSON.parse(text);
  } catch {
    const jsonStart = text.indexOf('[');
    if (jsonStart === -1) throw new Error(`npm pack stdout was not JSON:\n${text}`);
    return JSON.parse(text.slice(jsonStart));
  }
}

const packageJson = JSON.parse(await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8'));
const pack = spawnSync('npm', ['pack', '--dry-run', '--json'], {
  cwd: projectRoot,
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
});

if (pack.error) {
  throw pack.error;
}
if (pack.status !== 0) {
  process.stderr.write(pack.stdout);
  process.stderr.write(pack.stderr);
  process.exit(pack.status ?? 1);
}

const parsed = parsePackJson(pack.stdout);
if (!Array.isArray(parsed) || parsed.length !== 1) {
  fail(`Expected npm pack to report exactly one package, got ${Array.isArray(parsed) ? parsed.length : typeof parsed}.`);
}

const result = parsed[0] ?? {};
const files = Array.isArray(result.files) ? result.files : [];
const packedPaths = new Map(files.map((file) => [file.path, file]));
const pathSet = new Set(packedPaths.keys());

for (const requiredPath of ['package.json', 'README.md', 'LICENSE', 'dist/cli.js']) {
  if (!pathSet.has(requiredPath)) {
    fail(`Missing required publish payload file: ${requiredPath}`);
  }
}

if (packageJson.main !== 'dist/cli.js') {
  fail(`package.json main must point at dist/cli.js, got ${String(packageJson.main)}`);
}
if (packageJson.bin?.['cli-agent'] !== 'dist/cli.js') {
  fail(`package.json bin.cli-agent must point at dist/cli.js, got ${String(packageJson.bin?.['cli-agent'])}`);
}

const cliEntry = packedPaths.get('dist/cli.js');
if (cliEntry && (Number(cliEntry.mode) & 0o111) === 0) {
  fail('dist/cli.js is present but is not executable in the npm payload.');
}

const promptRoot = path.join(projectRoot, 'src', 'agent', 'tools', 'agent-tools-vendored', 'upstream', 'src');
const promptAssets = await collectPromptAssets(promptRoot);
const expectedPromptPaths = new Set(promptAssets.map((asset) => {
  const rel = path.relative(path.join(projectRoot, 'src'), asset).split(path.sep).join('/');
  return `dist/${rel}`;
}));

for (const expectedPath of expectedPromptPaths) {
  if (!pathSet.has(expectedPath)) {
    fail(`Missing vendored prompt runtime asset: ${expectedPath}`);
  }
}

for (const packedPath of pathSet) {
  if (
    packedPath.startsWith('src/')
    || packedPath.startsWith('docs/')
    || packedPath.startsWith('test_scripts/')
    || packedPath.startsWith('scripts/')
    || packedPath.startsWith('.github/')
  ) {
    fail(`Unexpected source/test/support path in publish payload: ${packedPath}`);
  }

  if (/\.spec\.(?:js|d\.ts)(?:\.map)?$/u.test(packedPath) || /\.test\.(?:js|d\.ts)(?:\.map)?$/u.test(packedPath)) {
    fail(`Unexpected compiled test artifact in publish payload: ${packedPath}`);
  }

  if (/\/integration-[^/]+\.(?:js|d\.ts)(?:\.map)?$/u.test(packedPath)) {
    fail(`Unexpected compiled integration test artifact in publish payload: ${packedPath}`);
  }

  if (packedPath.endsWith('.ts') && !packedPath.endsWith('.d.ts')) {
    fail(`Unexpected TypeScript source file in publish payload: ${packedPath}`);
  }

  if (packedPath.includes('/__fixtures__/') || packedPath.includes('/__tests__/')) {
    fail(`Unexpected fixture/test directory in publish payload: ${packedPath}`);
  }

  if (packedPath === 'package-lock.json' || packedPath.endsWith('/upstream/package.json')) {
    fail(`Unexpected package metadata file in publish payload: ${packedPath}`);
  }

  if (packedPath.endsWith('.prompt.md') && !expectedPromptPaths.has(packedPath)) {
    fail(`Unexpected prompt asset in publish payload: ${packedPath}`);
  }
}

if (failures.length > 0) {
  console.error('[release:package] Package content validation failed:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(`[release:package] Package content OK: ${files.length} file(s), ${expectedPromptPaths.size} vendored prompt asset(s).`);
