/**
 * Bespoke `*** Begin Patch` envelope parser ported VERBATIM from
 * `docs/reference/opencode/patch/index.ts` (anomalyco/opencode pinned
 * SHA `3beadeebff13fefb6f771ce22c3ef7b2736e8245`).
 *
 * Why a verbatim port: the parser defines the exact prompt contract
 * the model is trained on. Substituting a generic unified-diff library
 * (e.g. `diff.applyPatch`) would silently break that contract. Per L-15
 * of `plan-001`, the algorithms are reproduced here unchanged; only the
 * Effect-TS / opencode-internal bindings have been removed:
 *   - Removed: `Effect.gen`, `Bus`, `Log`, `Format`, `LSP`,
 *     `Instance.directory`, `AppFileSystem` — these are opencode runtime
 *     internals.
 *   - Removed: the `Bom` helper module — replaced with two local helpers
 *     ({@link splitBom}, {@link joinBom}) that match the upstream API
 *     surface used by the parser.
 *   - Removed: the upstream `Log.create` instrumentation (no logging here;
 *     the calling tool logs the same data via the `data` payload).
 *
 * Every function signature exposed by the upstream module is preserved:
 *   - {@link parsePatch}
 *   - {@link deriveNewContentsFromChunks}
 *   - {@link applyHunksToFiles}
 *   - {@link applyPatch}
 *   - {@link maybeParseApplyPatch}
 *   - {@link maybeParseApplyPatchVerified}
 *
 * The exported types and enums (`Hunk`, `UpdateFileChunk`,
 * `ApplyPatchAction`, `ApplyPatchFileChange`, `AffectedPaths`,
 * `MaybeApplyPatch`, `MaybeApplyPatchVerified`, `ApplyPatchError`) are
 * preserved name-for-name.
 *
 * NOT reused by other tools today, but lives under `_shared/` because
 * the orchestrator authorised a one-file exception so that future tools
 * (e.g. an `apply_patch_dryrun`) can consume the same parser.
 */
'use strict';

import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// BOM helpers — minimal local replacement for the upstream `Bom` module.
// Only the functions referenced by the parser body are reproduced.
// ---------------------------------------------------------------------------

const UTF8_BOM = '﻿';

interface BomSplit {
  readonly text: string;
  readonly bom: boolean;
}

/** Strip a leading UTF-8 BOM from `raw` and report whether one was present. */
export function splitBom(raw: string): BomSplit {
  if (raw.length > 0 && raw.charCodeAt(0) === 0xfeff) {
    return { text: raw.slice(1), bom: true };
  }
  return { text: raw, bom: false };
}

/** Re-prepend a UTF-8 BOM to `text` when `bom` is true. */
export function joinBom(text: string, bom: boolean): string {
  return bom ? UTF8_BOM + text : text;
}

// ---------------------------------------------------------------------------
// Public types — preserved verbatim from the upstream module.
// ---------------------------------------------------------------------------

export interface ApplyPatchArgs {
  patch: string;
  hunks: Hunk[];
  workdir?: string;
}

export type Hunk =
  | { type: 'add'; path: string; contents: string }
  | { type: 'delete'; path: string }
  | {
      type: 'update';
      path: string;
      move_path?: string;
      chunks: UpdateFileChunk[];
    };

export interface UpdateFileChunk {
  old_lines: string[];
  new_lines: string[];
  change_context?: string;
  is_end_of_file?: boolean;
}

export interface ApplyPatchAction {
  changes: Map<string, ApplyPatchFileChange>;
  patch: string;
  cwd: string;
}

export type ApplyPatchFileChange =
  | { type: 'add'; content: string }
  | { type: 'delete'; content: string }
  | {
      type: 'update';
      unified_diff: string;
      move_path?: string;
      new_content: string;
    };

export interface AffectedPaths {
  added: string[];
  modified: string[];
  deleted: string[];
}

export enum ApplyPatchError {
  ParseError = 'ParseError',
  IoError = 'IoError',
  ComputeReplacements = 'ComputeReplacements',
  ImplicitInvocation = 'ImplicitInvocation',
}

export enum MaybeApplyPatch {
  Body = 'Body',
  ShellParseError = 'ShellParseError',
  PatchParseError = 'PatchParseError',
  NotApplyPatch = 'NotApplyPatch',
}

export enum MaybeApplyPatchVerified {
  Body = 'Body',
  ShellParseError = 'ShellParseError',
  CorrectnessError = 'CorrectnessError',
  NotApplyPatch = 'NotApplyPatch',
}

// ---------------------------------------------------------------------------
// Parser implementation — verbatim port (Effect-TS removed).
// ---------------------------------------------------------------------------

function parsePatchHeader(
  lines: string[],
  startIdx: number,
): { filePath: string; movePath?: string; nextIdx: number } | null {
  const line = lines[startIdx];
  if (line === undefined) return null;

  if (line.startsWith('*** Add File:')) {
    const filePath = line.slice('*** Add File:'.length).trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }

  if (line.startsWith('*** Delete File:')) {
    const filePath = line.slice('*** Delete File:'.length).trim();
    return filePath ? { filePath, nextIdx: startIdx + 1 } : null;
  }

  if (line.startsWith('*** Update File:')) {
    const filePath = line.slice('*** Update File:'.length).trim();
    let movePath: string | undefined;
    let nextIdx = startIdx + 1;

    // Check for move directive
    const peeked = lines[nextIdx];
    if (peeked !== undefined && peeked.startsWith('*** Move to:')) {
      movePath = peeked.slice('*** Move to:'.length).trim();
      nextIdx++;
    }

    if (!filePath) return null;
    return movePath !== undefined
      ? { filePath, movePath, nextIdx }
      : { filePath, nextIdx };
  }

  return null;
}

function parseUpdateFileChunks(
  lines: string[],
  startIdx: number,
): { chunks: UpdateFileChunk[]; nextIdx: number } {
  const chunks: UpdateFileChunk[] = [];
  let i = startIdx;

  while (i < lines.length && !(lines[i] ?? '').startsWith('***')) {
    const cur = lines[i] ?? '';
    if (cur.startsWith('@@')) {
      // Parse context line
      const contextLine = cur.substring(2).trim();
      i++;

      const oldLines: string[] = [];
      const newLines: string[] = [];
      let isEndOfFile = false;

      // Parse change lines
      while (
        i < lines.length &&
        !(lines[i] ?? '').startsWith('@@') &&
        !(lines[i] ?? '').startsWith('***')
      ) {
        const changeLine = lines[i] ?? '';

        if (changeLine === '*** End of File') {
          isEndOfFile = true;
          i++;
          break;
        }

        if (changeLine.startsWith(' ')) {
          // Keep line - appears in both old and new
          const content = changeLine.substring(1);
          oldLines.push(content);
          newLines.push(content);
        } else if (changeLine.startsWith('-')) {
          // Remove line - only in old
          oldLines.push(changeLine.substring(1));
        } else if (changeLine.startsWith('+')) {
          // Add line - only in new
          newLines.push(changeLine.substring(1));
        }

        i++;
      }

      const chunk: UpdateFileChunk = {
        old_lines: oldLines,
        new_lines: newLines,
      };
      if (contextLine) chunk.change_context = contextLine;
      if (isEndOfFile) chunk.is_end_of_file = true;
      chunks.push(chunk);
    } else {
      i++;
    }
  }

  return { chunks, nextIdx: i };
}

function parseAddFileContent(
  lines: string[],
  startIdx: number,
): { content: string; nextIdx: number } {
  let content = '';
  let i = startIdx;

  while (i < lines.length && !(lines[i] ?? '').startsWith('***')) {
    const cur = lines[i] ?? '';
    if (cur.startsWith('+')) {
      content += cur.substring(1) + '\n';
    }
    i++;
  }

  // Remove trailing newline
  if (content.endsWith('\n')) {
    content = content.slice(0, -1);
  }

  return { content, nextIdx: i };
}

function stripHeredoc(input: string): string {
  // Match heredoc patterns like: cat <<'EOF'\n...\nEOF or <<EOF\n...\nEOF
  const heredocMatch = input.match(
    /^(?:cat\s+)?<<['"]?(\w+)['"]?\s*\n([\s\S]*?)\n\1\s*$/,
  );
  if (heredocMatch && heredocMatch[2] !== undefined) {
    return heredocMatch[2];
  }
  return input;
}

/**
 * Parse a `*** Begin Patch ... *** End Patch` envelope into a list of
 * hunks. Throws on malformed input.
 */
export function parsePatch(patchText: string): { hunks: Hunk[] } {
  const cleaned = stripHeredoc(patchText.trim());
  const lines = cleaned.split('\n');
  const hunks: Hunk[] = [];
  let i = 0;

  // Look for Begin/End patch markers
  const beginMarker = '*** Begin Patch';
  const endMarker = '*** End Patch';

  const beginIdx = lines.findIndex((line) => line.trim() === beginMarker);
  const endIdx = lines.findIndex((line) => line.trim() === endMarker);

  if (beginIdx === -1 || endIdx === -1 || beginIdx >= endIdx) {
    throw new Error('Invalid patch format: missing Begin/End markers');
  }

  // Parse content between markers
  i = beginIdx + 1;

  while (i < endIdx) {
    const header = parsePatchHeader(lines, i);
    if (!header) {
      i++;
      continue;
    }

    const cur = lines[i] ?? '';
    if (cur.startsWith('*** Add File:')) {
      const { content, nextIdx } = parseAddFileContent(lines, header.nextIdx);
      hunks.push({
        type: 'add',
        path: header.filePath,
        contents: content,
      });
      i = nextIdx;
    } else if (cur.startsWith('*** Delete File:')) {
      hunks.push({
        type: 'delete',
        path: header.filePath,
      });
      i = header.nextIdx;
    } else if (cur.startsWith('*** Update File:')) {
      const { chunks, nextIdx } = parseUpdateFileChunks(lines, header.nextIdx);
      const updateHunk: Hunk =
        header.movePath !== undefined
          ? {
              type: 'update',
              path: header.filePath,
              move_path: header.movePath,
              chunks,
            }
          : {
              type: 'update',
              path: header.filePath,
              chunks,
            };
      hunks.push(updateHunk);
      i = nextIdx;
    } else {
      i++;
    }
  }

  return { hunks };
}

// ---------------------------------------------------------------------------
// `apply_patch` shell-invocation parsing (verbatim).
// ---------------------------------------------------------------------------

export function maybeParseApplyPatch(
  argv: string[],
):
  | { type: MaybeApplyPatch.Body; args: ApplyPatchArgs }
  | { type: MaybeApplyPatch.PatchParseError; error: Error }
  | { type: MaybeApplyPatch.NotApplyPatch } {
  const APPLY_PATCH_COMMANDS = ['apply_patch', 'applypatch'];

  // Direct invocation: apply_patch <patch>
  if (argv.length === 2 && APPLY_PATCH_COMMANDS.includes(argv[0] ?? '')) {
    try {
      const { hunks } = parsePatch(argv[1] ?? '');
      return {
        type: MaybeApplyPatch.Body,
        args: {
          patch: argv[1] ?? '',
          hunks,
        },
      };
    } catch (error) {
      return {
        type: MaybeApplyPatch.PatchParseError,
        error: error as Error,
      };
    }
  }

  // Bash heredoc form: bash -lc 'apply_patch <<"EOF" ...'
  if (argv.length === 3 && argv[0] === 'bash' && argv[1] === '-lc') {
    // Simple extraction - in real implementation would need proper bash parsing
    const script = argv[2] ?? '';
    const heredocMatch = script.match(
      /apply_patch\s*<<['"](\w+)['"]\s*\n([\s\S]*?)\n\1/,
    );

    if (heredocMatch && heredocMatch[2] !== undefined) {
      const patchContent = heredocMatch[2];
      try {
        const { hunks } = parsePatch(patchContent);
        return {
          type: MaybeApplyPatch.Body,
          args: {
            patch: patchContent,
            hunks,
          },
        };
      } catch (error) {
        return {
          type: MaybeApplyPatch.PatchParseError,
          error: error as Error,
        };
      }
    }
  }

  return { type: MaybeApplyPatch.NotApplyPatch };
}

// ---------------------------------------------------------------------------
// File content manipulation — verbatim port.
// ---------------------------------------------------------------------------

interface ApplyPatchFileUpdate {
  unified_diff: string;
  content: string;
  bom: boolean;
}

/**
 * Read `filePath` synchronously and apply the supplied chunks to derive
 * new content. Throws when the file cannot be read or any chunk cannot
 * be located in the original file.
 */
export function deriveNewContentsFromChunks(
  filePath: string,
  chunks: UpdateFileChunk[],
): ApplyPatchFileUpdate {
  // Read original file content
  let originalContent: BomSplit;
  try {
    originalContent = splitBom(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    throw new Error(`Failed to read file ${filePath}: ${error as Error}`, {
      cause: error,
    });
  }

  const originalLines = originalContent.text.split('\n');

  // Drop trailing empty element for consistent line counting
  if (
    originalLines.length > 0 &&
    originalLines[originalLines.length - 1] === ''
  ) {
    originalLines.pop();
  }

  const replacements = computeReplacements(originalLines, filePath, chunks);
  const newLines = applyReplacements(originalLines, replacements);

  // Ensure trailing newline
  if (newLines.length === 0 || newLines[newLines.length - 1] !== '') {
    newLines.push('');
  }

  const next = splitBom(newLines.join('\n'));
  const newContent = next.text;

  // Generate unified diff
  const unifiedDiff = generateUnifiedDiff(originalContent.text, newContent);

  return {
    unified_diff: unifiedDiff,
    content: newContent,
    bom: originalContent.bom || next.bom,
  };
}

function computeReplacements(
  originalLines: string[],
  filePath: string,
  chunks: UpdateFileChunk[],
): Array<[number, number, string[]]> {
  const replacements: Array<[number, number, string[]]> = [];
  let lineIndex = 0;

  for (const chunk of chunks) {
    // Handle context-based seeking
    if (chunk.change_context) {
      const contextIdx = seekSequence(
        originalLines,
        [chunk.change_context],
        lineIndex,
      );
      if (contextIdx === -1) {
        throw new Error(
          `Failed to find context '${chunk.change_context}' in ${filePath}`,
        );
      }
      lineIndex = contextIdx + 1;
    }

    // Handle pure addition (no old lines)
    if (chunk.old_lines.length === 0) {
      const insertionIdx =
        originalLines.length > 0 &&
        originalLines[originalLines.length - 1] === ''
          ? originalLines.length - 1
          : originalLines.length;
      replacements.push([insertionIdx, 0, chunk.new_lines]);
      continue;
    }

    // Try to match old lines in the file
    let pattern = chunk.old_lines;
    let newSlice = chunk.new_lines;
    let found = seekSequence(
      originalLines,
      pattern,
      lineIndex,
      chunk.is_end_of_file,
    );

    // Retry without trailing empty line if not found
    if (found === -1 && pattern.length > 0 && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1);
      if (newSlice.length > 0 && newSlice[newSlice.length - 1] === '') {
        newSlice = newSlice.slice(0, -1);
      }
      found = seekSequence(
        originalLines,
        pattern,
        lineIndex,
        chunk.is_end_of_file,
      );
    }

    if (found !== -1) {
      replacements.push([found, pattern.length, newSlice]);
      lineIndex = found + pattern.length;
    } else {
      throw new Error(
        `Failed to find expected lines in ${filePath}:\n${chunk.old_lines.join('\n')}`,
      );
    }
  }

  // Sort replacements by index to apply in order
  replacements.sort((a, b) => a[0] - b[0]);

  return replacements;
}

function applyReplacements(
  lines: string[],
  replacements: Array<[number, number, string[]]>,
): string[] {
  // Apply replacements in reverse order to avoid index shifting
  const result = [...lines];

  for (let i = replacements.length - 1; i >= 0; i--) {
    const entry = replacements[i];
    if (entry === undefined) continue;
    const [startIdx, oldLen, newSegment] = entry;

    // Remove old lines
    result.splice(startIdx, oldLen);

    // Insert new lines
    for (let j = 0; j < newSegment.length; j++) {
      const seg = newSegment[j];
      if (seg === undefined) continue;
      result.splice(startIdx + j, 0, seg);
    }
  }

  return result;
}

// Normalize Unicode punctuation to ASCII equivalents (like Rust's normalize_unicode)
function normalizeUnicode(str: string): string {
  return str
    .replace(/[‘’‚‛]/g, "'") // single quotes
    .replace(/[“”„‟]/g, '"') // double quotes
    .replace(/[‐‑‒–—―]/g, '-') // dashes
    .replace(/…/g, '...') // ellipsis
    .replace(/ /g, ' '); // non-breaking space
}

type Comparator = (a: string, b: string) => boolean;

function tryMatch(
  lines: string[],
  pattern: string[],
  startIndex: number,
  compare: Comparator,
  eof: boolean,
): number {
  // If EOF anchor, try matching from end of file first
  if (eof) {
    const fromEnd = lines.length - pattern.length;
    if (fromEnd >= startIndex) {
      let matches = true;
      for (let j = 0; j < pattern.length; j++) {
        const a = lines[fromEnd + j] ?? '';
        const b = pattern[j] ?? '';
        if (!compare(a, b)) {
          matches = false;
          break;
        }
      }
      if (matches) return fromEnd;
    }
  }

  // Forward search from startIndex
  for (let i = startIndex; i <= lines.length - pattern.length; i++) {
    let matches = true;
    for (let j = 0; j < pattern.length; j++) {
      const a = lines[i + j] ?? '';
      const b = pattern[j] ?? '';
      if (!compare(a, b)) {
        matches = false;
        break;
      }
    }
    if (matches) return i;
  }

  return -1;
}

function seekSequence(
  lines: string[],
  pattern: string[],
  startIndex: number,
  eof = false,
): number {
  if (pattern.length === 0) return -1;

  // Pass 1: exact match
  const exact = tryMatch(lines, pattern, startIndex, (a, b) => a === b, eof);
  if (exact !== -1) return exact;

  // Pass 2: rstrip (trim trailing whitespace)
  const rstrip = tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => a.trimEnd() === b.trimEnd(),
    eof,
  );
  if (rstrip !== -1) return rstrip;

  // Pass 3: trim (both ends)
  const trim = tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => a.trim() === b.trim(),
    eof,
  );
  if (trim !== -1) return trim;

  // Pass 4: normalized (Unicode punctuation to ASCII)
  const normalized = tryMatch(
    lines,
    pattern,
    startIndex,
    (a, b) => normalizeUnicode(a.trim()) === normalizeUnicode(b.trim()),
    eof,
  );
  return normalized;
}

function generateUnifiedDiff(oldContent: string, newContent: string): string {
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  // Simple diff generation - in a real implementation you'd use a proper diff algorithm
  let diff = '@@ -1 +1 @@\n';

  // Find changes (simplified approach)
  const maxLen = Math.max(oldLines.length, newLines.length);
  let hasChanges = false;

  for (let i = 0; i < maxLen; i++) {
    const oldLine = oldLines[i] ?? '';
    const newLine = newLines[i] ?? '';

    if (oldLine !== newLine) {
      if (oldLine) diff += `-${oldLine}\n`;
      if (newLine) diff += `+${newLine}\n`;
      hasChanges = true;
    } else if (oldLine) {
      diff += ` ${oldLine}\n`;
    }
  }

  return hasChanges ? diff : '';
}

// ---------------------------------------------------------------------------
// Filesystem application — verbatim port (Log instrumentation removed).
// ---------------------------------------------------------------------------

/**
 * Apply parsed `hunks` to the filesystem. Returns the lists of paths
 * affected. Throws on the first IO error encountered; partial
 * application is possible — callers that need atomicity must stage
 * changes themselves.
 *
 * NOTE: the patch tool wrapping this parser stages all writes in
 * memory and only flushes once every gate has passed. This function
 * is the lower-level "non-atomic" entry point, kept verbatim from
 * upstream for parity.
 */
export async function applyHunksToFiles(hunks: Hunk[]): Promise<AffectedPaths> {
  if (hunks.length === 0) {
    throw new Error('No files were modified.');
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  for (const hunk of hunks) {
    switch (hunk.type) {
      case 'add': {
        // Create parent directories
        const addDir = path.dirname(hunk.path);
        if (addDir !== '.' && addDir !== '/') {
          await fs.mkdir(addDir, { recursive: true });
        }

        await fs.writeFile(hunk.path, hunk.contents, 'utf-8');
        added.push(hunk.path);
        break;
      }

      case 'delete': {
        await fs.unlink(hunk.path);
        deleted.push(hunk.path);
        break;
      }

      case 'update': {
        const fileUpdate = deriveNewContentsFromChunks(hunk.path, hunk.chunks);

        if (hunk.move_path) {
          // Handle file move
          const moveDir = path.dirname(hunk.move_path);
          if (moveDir !== '.' && moveDir !== '/') {
            await fs.mkdir(moveDir, { recursive: true });
          }

          await fs.writeFile(
            hunk.move_path,
            joinBom(fileUpdate.content, fileUpdate.bom),
            'utf-8',
          );
          await fs.unlink(hunk.path);
          modified.push(hunk.move_path);
        } else {
          // Regular update
          await fs.writeFile(
            hunk.path,
            joinBom(fileUpdate.content, fileUpdate.bom),
            'utf-8',
          );
          modified.push(hunk.path);
        }
        break;
      }
    }
  }

  return { added, modified, deleted };
}

/**
 * Convenience wrapper: parse + apply in one call (non-atomic).
 *
 * The `patch` tool does NOT use this — it parses, gates, stages, then
 * writes atomically. Kept for parity with the upstream module.
 */
export async function applyPatch(patchText: string): Promise<AffectedPaths> {
  const { hunks } = parsePatch(patchText);
  return applyHunksToFiles(hunks);
}

// ---------------------------------------------------------------------------
// Verified shell-invocation parsing — verbatim port.
// ---------------------------------------------------------------------------

export async function maybeParseApplyPatchVerified(
  argv: string[],
  cwd: string,
): Promise<
  | { type: MaybeApplyPatchVerified.Body; action: ApplyPatchAction }
  | { type: MaybeApplyPatchVerified.CorrectnessError; error: Error }
  | { type: MaybeApplyPatchVerified.NotApplyPatch }
> {
  // Detect implicit patch invocation (raw patch without apply_patch command)
  if (argv.length === 1) {
    try {
      parsePatch(argv[0] ?? '');
      return {
        type: MaybeApplyPatchVerified.CorrectnessError,
        error: new Error(ApplyPatchError.ImplicitInvocation),
      };
    } catch {
      // Not a patch, continue
    }
  }

  const result = maybeParseApplyPatch(argv);

  switch (result.type) {
    case MaybeApplyPatch.Body: {
      const { args } = result;
      const effectiveCwd = args.workdir ? path.resolve(cwd, args.workdir) : cwd;
      const changes = new Map<string, ApplyPatchFileChange>();

      for (const hunk of args.hunks) {
        const resolvedPath = path.resolve(
          effectiveCwd,
          hunk.type === 'update' && hunk.move_path ? hunk.move_path : hunk.path,
        );

        switch (hunk.type) {
          case 'add':
            changes.set(resolvedPath, {
              type: 'add',
              content: hunk.contents,
            });
            break;

          case 'delete': {
            const deletePath = path.resolve(effectiveCwd, hunk.path);
            try {
              const content = await fs.readFile(deletePath, 'utf-8');
              changes.set(resolvedPath, {
                type: 'delete',
                content,
              });
            } catch {
              return {
                type: MaybeApplyPatchVerified.CorrectnessError,
                error: new Error(`Failed to read file for deletion: ${deletePath}`),
              };
            }
            break;
          }

          case 'update': {
            const updatePath = path.resolve(effectiveCwd, hunk.path);
            try {
              const fileUpdate = deriveNewContentsFromChunks(
                updatePath,
                hunk.chunks,
              );
              const change: ApplyPatchFileChange = hunk.move_path
                ? {
                    type: 'update',
                    unified_diff: fileUpdate.unified_diff,
                    move_path: path.resolve(effectiveCwd, hunk.move_path),
                    new_content: fileUpdate.content,
                  }
                : {
                    type: 'update',
                    unified_diff: fileUpdate.unified_diff,
                    new_content: fileUpdate.content,
                  };
              changes.set(resolvedPath, change);
            } catch (error) {
              return {
                type: MaybeApplyPatchVerified.CorrectnessError,
                error: error as Error,
              };
            }
            break;
          }
        }
      }

      return {
        type: MaybeApplyPatchVerified.Body,
        action: {
          changes,
          patch: args.patch,
          cwd: effectiveCwd,
        },
      };
    }

    case MaybeApplyPatch.PatchParseError:
      return {
        type: MaybeApplyPatchVerified.CorrectnessError,
        error: result.error,
      };

    case MaybeApplyPatch.NotApplyPatch:
      return { type: MaybeApplyPatchVerified.NotApplyPatch };
  }
}
