/**
 * `multiedit` — apply an ordered list of exact replacements to one file
 * atomically. All edits succeed or none are applied.
 *
 * Algorithm:
 *   1. Validate input via Zod (returns InputValidationError on miss).
 *   2. Resolve the absolute path against `ctx.cwd`.
 *   3. Run `evaluateFsWrite({ operation: 'edit' })` ONCE up front.
 *   4. Read the file, preserving any leading BOM and the original line
 *      ending convention (`\n` vs `\r\n`).
 *   5. Fold the edits sequentially over an in-memory string buffer:
 *      every edit operates on the result of the previous one, so later
 *      edits can target text introduced by earlier edits.
 *   6. If any edit's replacer chain returns null OR `oldString` equals
 *      `newString`, abort immediately and return `{ ok: false }` —
 *      the on-disk file is never modified (atomic fail).
 *   7. On full success, write the rewritten content atomically (write
 *      to a sibling temp file, then rename) and return a unified-diff
 *      preview plus a per-edit summary.
 *
 * The tool never throws across its execute() boundary: every error is
 * surfaced as `{ ok: false, error }` per the {@link ToolResult} contract.
 */
'use strict';

import { promises as fs } from 'node:fs';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import {
  InputValidationError,
  PermissionDeniedError,
  ToolExecutionError,
} from '../../errors.js';
import { permissivePolicy } from '../../permissions.js';
import { loadPromptFile } from '../../prompts/loader.js';
import { registerPrompt } from '../../prompts/registry.js';
import type {
  AgentTool,
  ToolContext,
  ToolResult,
} from '../../types.js';
import { applyReplacers, type ReplacerName } from '../_shared/replacers.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const editEntrySchema = z.object({
  oldString: z.string(),
  newString: z.string(),
  replaceAll: z.boolean().optional(),
});

const inputSchema = z.object({
  filePath: z.string().min(1, 'filePath must be a non-empty string'),
  edits: z.array(editEntrySchema).min(1, 'edits must contain at least one edit'),
});

export type MultieditInput = z.infer<typeof inputSchema>;

export interface MultieditOutput {
  /** Resolved absolute path of the file that was rewritten. */
  readonly filePath: string;
  /** Number of edits applied (always equal to `input.edits.length` on success). */
  readonly editsApplied: number;
  /** Replacer used for each edit, in order. */
  readonly replacersUsed: ReplacerName[];
  /** Unified-diff preview of the cumulative change. */
  readonly diff: string;
}

// ---------------------------------------------------------------------------
// Prompt registration (synchronous at module load).
// ---------------------------------------------------------------------------

const PROMPT = loadPromptFile(import.meta.url, 'multiedit.prompt.md');

const DESCRIPTION =
  'Apply an ordered list of exact replacements to one file atomically. ' +
  'All edits succeed or none are applied.';

registerPrompt('multiedit', DESCRIPTION, PROMPT);

// ---------------------------------------------------------------------------
// BOM helpers (inlined — no shared bom.ts module exists yet).
// ---------------------------------------------------------------------------

const UTF8_BOM = '﻿';

function splitBom(text: string): { bom: boolean; text: string } {
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) {
    return { bom: true, text: text.slice(1) };
  }
  return { bom: false, text };
}

function joinBom(text: string, bom: boolean): string {
  if (!bom) return text;
  if (text.length > 0 && text.charCodeAt(0) === 0xfeff) return text;
  return UTF8_BOM + text;
}

// ---------------------------------------------------------------------------
// Line-ending helpers
// ---------------------------------------------------------------------------

function detectLineEnding(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function normalizeLineEndings(text: string): string {
  return text.replaceAll('\r\n', '\n');
}

function convertToLineEnding(text: string, ending: '\n' | '\r\n'): string {
  if (ending === '\n') return text;
  return text.replaceAll('\n', '\r\n');
}

// ---------------------------------------------------------------------------
// Minimal unified-diff formatter (we don't depend on the `diff` package).
// ---------------------------------------------------------------------------

function makeUnifiedDiff(filePath: string, before: string, after: string): string {
  if (before === after) {
    return '';
  }
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  // We don't compute a true LCS-based hunk; for an LLM-facing preview a
  // simple "all lines removed / all lines added" envelope is enough and
  // keeps the implementation dependency-free.
  const header =
    `--- ${filePath}\n` +
    `+++ ${filePath}\n` +
    `@@ -1,${beforeLines.length} +1,${afterLines.length} @@\n`;
  const removed = beforeLines.map((l) => `-${l}`).join('\n');
  const added = afterLines.map((l) => `+${l}`).join('\n');
  return header + removed + '\n' + added;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

async function executeMultiedit(
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult<MultieditOutput>> {
  // 1. Validate input.
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: new InputValidationError('multiedit input invalid', parsed.error),
    };
  }
  const { filePath: filePathInput, edits } = parsed.data;

  // 2. Resolve absolute path against the context cwd.
  const absolutePath = path.isAbsolute(filePathInput)
    ? filePathInput
    : path.resolve(ctx.cwd, filePathInput);

  // 3. Single permission check up front. Falls back to permissivePolicy
  //    when ctx.permissions is undefined so the gate is always invoked
  //    (mirrors write/edit/patch/bash). Production callers MUST install
  //    a strict policy explicitly — see README "Sandboxing".
  const policy = ctx.permissions ?? permissivePolicy;
  const decision = policy.evaluateFsWrite({
    path: absolutePath,
    cwd: ctx.cwd,
    operation: 'edit',
  });
  if (!decision.allow) {
    return {
      ok: false,
      error: new PermissionDeniedError(decision.reason),
    };
  }

  // 4. Read the file (preserving BOM + line ending).
  let rawOnDisk: string;
  try {
    const stat = await fs.stat(absolutePath);
    if (stat.isDirectory()) {
      return {
        ok: false,
        error: new ToolExecutionError(
          `Path is a directory, not a file: ${absolutePath}`,
        ),
      };
    }
    rawOnDisk = await fs.readFile(absolutePath, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        error: new ToolExecutionError(`File not found: ${absolutePath}`),
      };
    }
    return {
      ok: false,
      error: new ToolExecutionError(
        `Failed to read file: ${absolutePath}`,
        { cause: e },
      ),
    };
  }

  const { bom, text: contentWithBomStripped } = splitBom(rawOnDisk);
  const originalEnding = detectLineEnding(contentWithBomStripped);
  const originalNormalized = normalizeLineEndings(contentWithBomStripped);

  // 5. Fold edits over the buffer. Every edit operates on the result of
  //    the previous edit. We work in normalized-LF space so the replacer
  //    chain (which is line-aware) sees a consistent newline shape; we
  //    re-apply the original line ending convention before writing.
  let working = originalNormalized;
  const replacersUsed: ReplacerName[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i] as { oldString: string; newString: string; replaceAll?: boolean };
    if (edit.oldString === edit.newString) {
      return {
        ok: false,
        error: new ToolExecutionError(
          `multiedit failed at index ${i}: oldString and newString are identical`,
        ),
      };
    }
    if (edit.oldString.length === 0) {
      // The single-edit `edit` tool uses oldString === '' as a "create
      // file" sentinel. multiedit operates only on existing files, so
      // an empty oldString in the array is a usage error.
      return {
        ok: false,
        error: new ToolExecutionError(
          `multiedit failed at index ${i}: oldString must not be empty`,
        ),
      };
    }
    const oldNormalized = normalizeLineEndings(edit.oldString);
    const newNormalized = normalizeLineEndings(edit.newString);
    const allowMultiple = edit.replaceAll === true;
    const hit = applyReplacers(working, oldNormalized, newNormalized, {
      allowMultiple,
    });
    if (hit === null) {
      return {
        ok: false,
        error: new ToolExecutionError(
          `multiedit failed at index ${i}: oldString not found in ${absolutePath}`,
        ),
      };
    }
    working = hit.result;
    replacersUsed.push(hit.replacerUsed);
  }

  // 6. Re-apply the original line ending and BOM.
  const restoredEnding = convertToLineEnding(working, originalEnding);
  const finalContent = joinBom(restoredEnding, bom);

  // 7. Atomic write via rename.
  try {
    const dir = path.dirname(absolutePath);
    const tmp = path.join(
      dir,
      `.${path.basename(absolutePath)}.multiedit-${process.pid}-${Date.now()}.tmp`,
    );
    await fs.writeFile(tmp, finalContent, 'utf8');
    try {
      await fs.rename(tmp, absolutePath);
    } catch (e) {
      // Best-effort cleanup of the temp file.
      try {
        fsSync.unlinkSync(tmp);
      } catch {
        // ignore
      }
      throw e;
    }
  } catch (e) {
    return {
      ok: false,
      error: new ToolExecutionError(
        `Failed to write file: ${absolutePath}`,
        { cause: e },
      ),
    };
  }

  // 8. Build the diff preview + summary lines.
  const diff = makeUnifiedDiff(absolutePath, originalNormalized, working);
  const summaryLines = edits.map((edit, i) => {
    const replacer = replacersUsed[i];
    const ra = edit.replaceAll === true ? ' (replaceAll)' : '';
    return `  [${i}] ${replacer ?? 'unknown'}${ra}`;
  });
  const output =
    `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${absolutePath}:\n` +
    summaryLines.join('\n') +
    (diff.length > 0 ? `\n\n${diff}` : '');

  return {
    ok: true,
    output,
    data: {
      filePath: absolutePath,
      editsApplied: edits.length,
      replacersUsed,
      diff,
    },
    metadata: {
      diff,
    },
  };
}

// ---------------------------------------------------------------------------
// Public tool object
// ---------------------------------------------------------------------------

export const multieditTool: AgentTool<typeof inputSchema, MultieditOutput> = {
  id: 'multiedit',
  description: DESCRIPTION,
  category: 'fs',
  mutating: true,
  parameters: inputSchema,
  prompt: PROMPT,
  async execute(
    input: MultieditInput,
    ctx: ToolContext,
  ): Promise<ToolResult<MultieditOutput>> {
    return executeMultiedit(input, ctx);
  },
};
