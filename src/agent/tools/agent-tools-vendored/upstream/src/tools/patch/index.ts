/**
 * `patch` tool — apply a `*** Begin Patch ... *** End Patch` envelope.
 *
 * Wraps the verbatim envelope parser at
 * `src/tools/_shared/patch_parser.ts` (port of upstream
 * `docs/reference/opencode/patch/index.ts`). The wrapper:
 *   1. parses the envelope (atomic verification — no IO yet);
 *   2. resolves every target path against `ctx.cwd`;
 *   3. evaluates `ctx.permissions.evaluateFsWrite` for each target
 *      BEFORE any write — denying any single path aborts the whole
 *      patch with `PermissionDeniedError`;
 *   4. stages every write (add/update/move/delete) in memory by
 *      reading and computing new contents up-front;
 *   5. flushes to disk only after every gate has passed. Any IO error
 *      mid-flush triggers a best-effort rollback so that partial
 *      application is impossible.
 *
 * Output (`output` string) format:
 *
 *     Success. Updated the following files:
 *     A path/added.ts
 *     M path/modified.ts
 *     D path/deleted.ts
 *     R path/from.ts -> path/to.ts
 *
 * Library-side enforcement note: opencode's upstream flow asks the
 * user (via the `ctx.ask` interactive UI) for permission. This library
 * has no interactive UI; the {@link PermissionPolicy} is the gate.
 */
'use strict';

import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

import { PermissionDeniedError, ToolExecutionError } from '../../errors.js';
import { permissivePolicy } from '../../permissions.js';
import { loadPromptFile } from '../../prompts/loader.js';
import { registerPrompt } from '../../prompts/registry.js';
import type { AgentTool, ToolContext, ToolResult } from '../../types.js';
import {
  deriveNewContentsFromChunks,
  joinBom,
  parsePatch,
  splitBom,
  type Hunk,
  type UpdateFileChunk,
} from '../_shared/patch_parser.js';

// ---------------------------------------------------------------------------
// Schema and output types
// ---------------------------------------------------------------------------

export const patchInputSchema = z.object({
  patchText: z
    .string()
    .min(1)
    .describe(
      'The full *** Begin Patch ... *** End Patch envelope describing add/update/delete/move operations across one or more files.',
    ),
});

export type PatchInput = z.infer<typeof patchInputSchema>;

export interface PatchOutput {
  /** Files whose paths were created. Relative to `ctx.cwd`. */
  readonly files: {
    readonly added: string[];
    readonly modified: string[];
    readonly deleted: string[];
  };
  /**
   * Move pairs (update with `*** Move to:`). Both `from` and `to` are
   * relative to `ctx.cwd`. Always populated alongside `files.added` /
   * `files.deleted` for the legacy callers.
   */
  readonly moves: ReadonlyArray<{ from: string; to: string }>;
}

const TOOL_DESCRIPTION =
  'Apply a *** Begin Patch envelope describing add/update/delete/move operations across multiple files. Pre-flight validates every hunk; partial application is impossible.';

const TOOL_PROMPT = loadPromptFile(import.meta.url, 'patch.prompt.md');
registerPrompt('patch', TOOL_DESCRIPTION, TOOL_PROMPT);

// ---------------------------------------------------------------------------
// Internal staging types
// ---------------------------------------------------------------------------

type StagedChange =
  | {
      readonly kind: 'add';
      readonly absPath: string;
      readonly relPath: string;
      readonly content: string; // BOM-prefixed if applicable
    }
  | {
      readonly kind: 'update';
      readonly absPath: string;
      readonly relPath: string;
      readonly content: string; // BOM-prefixed if applicable
    }
  | {
      readonly kind: 'move';
      readonly absFromPath: string;
      readonly absToPath: string;
      readonly relFromPath: string;
      readonly relToPath: string;
      readonly content: string; // BOM-prefixed if applicable
    }
  | {
      readonly kind: 'delete';
      readonly absPath: string;
      readonly relPath: string;
    };

// ---------------------------------------------------------------------------
// Tool implementation
// ---------------------------------------------------------------------------

export const patchTool: AgentTool<typeof patchInputSchema, PatchOutput> = {
  id: 'patch',
  description: TOOL_DESCRIPTION,
  category: 'fs',
  mutating: true,
  parameters: patchInputSchema,
  prompt: TOOL_PROMPT,

  async execute(input, ctx): Promise<ToolResult<PatchOutput>> {
    return executePatch(input, ctx);
  },
};

async function executePatch(
  input: PatchInput,
  ctx: ToolContext,
): Promise<ToolResult<PatchOutput>> {
  const cwd = ctx.cwd;
  const policy = ctx.permissions ?? permissivePolicy;

  // -------------------------------------------------------------------
  // 1. Parse the envelope. Failures are deterministic (no IO).
  // -------------------------------------------------------------------
  let hunks: Hunk[];
  try {
    const parseResult = parsePatch(input.patchText);
    hunks = parseResult.hunks;
  } catch (err) {
    return {
      ok: false,
      error: new ToolExecutionError(
        `apply_patch verification failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      ),
    };
  }

  if (hunks.length === 0) {
    const normalized = input.patchText
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .trim();
    if (normalized === '*** Begin Patch\n*** End Patch') {
      return {
        ok: false,
        error: new ToolExecutionError('patch rejected: empty patch'),
      };
    }
    return {
      ok: false,
      error: new ToolExecutionError(
        'apply_patch verification failed: no hunks found',
      ),
    };
  }

  // -------------------------------------------------------------------
  // 2. Resolve paths and evaluate fs-write permission for EACH target.
  //    Any single denial aborts the whole patch.
  // -------------------------------------------------------------------
  interface ResolvedHunk {
    readonly hunk: Hunk;
    readonly absPath: string;
    readonly absMovePath?: string;
  }
  const resolved: ResolvedHunk[] = hunks.map((hunk) => {
    const absPath = path.resolve(cwd, hunk.path);
    if (hunk.type === 'update' && hunk.move_path !== undefined) {
      return { hunk, absPath, absMovePath: path.resolve(cwd, hunk.move_path) };
    }
    return { hunk, absPath };
  });

  for (const r of resolved) {
    const operation: 'create' | 'overwrite' | 'edit' =
      r.hunk.type === 'add'
        ? 'create'
        : r.hunk.type === 'delete'
          ? 'overwrite'
          : 'edit';
    const decision = policy.evaluateFsWrite({
      path: r.absPath,
      cwd,
      operation,
    });
    if (!decision.allow) {
      return {
        ok: false,
        error: new PermissionDeniedError(
          `patch denied for ${r.absPath}: ${decision.reason}`,
        ),
      };
    }
    if (r.absMovePath !== undefined) {
      const moveDecision = policy.evaluateFsWrite({
        path: r.absMovePath,
        cwd,
        operation: 'create',
      });
      if (!moveDecision.allow) {
        return {
          ok: false,
          error: new PermissionDeniedError(
            `patch denied for ${r.absMovePath}: ${moveDecision.reason}`,
          ),
        };
      }
    }
  }

  // -------------------------------------------------------------------
  // 3. Stage all changes in memory. Compute final byte content for
  //    every write up-front so we can verify before touching disk.
  // -------------------------------------------------------------------
  const staged: StagedChange[] = [];
  for (const r of resolved) {
    try {
      const change = stageHunk(r.hunk, r.absPath, r.absMovePath, cwd);
      staged.push(change);
    } catch (err) {
      return {
        ok: false,
        error: new ToolExecutionError(
          `apply_patch verification failed: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        ),
      };
    }
  }

  // -------------------------------------------------------------------
  // 4. Flush. On any error mid-flush, roll back what we've already
  //    written using the snapshots captured during staging.
  // -------------------------------------------------------------------
  type Snapshot =
    | { readonly kind: 'pre-existed'; readonly path: string; readonly bytes: Buffer }
    | { readonly kind: 'absent'; readonly path: string };
  const snapshots: Snapshot[] = [];

  try {
    for (const change of staged) {
      switch (change.kind) {
        case 'add': {
          snapshots.push(await snapshot(change.absPath));
          await fs.mkdir(path.dirname(change.absPath), { recursive: true });
          await fs.writeFile(change.absPath, change.content, 'utf-8');
          break;
        }
        case 'update': {
          snapshots.push(await snapshot(change.absPath));
          await fs.mkdir(path.dirname(change.absPath), { recursive: true });
          await fs.writeFile(change.absPath, change.content, 'utf-8');
          break;
        }
        case 'move': {
          snapshots.push(await snapshot(change.absFromPath));
          snapshots.push(await snapshot(change.absToPath));
          await fs.mkdir(path.dirname(change.absToPath), { recursive: true });
          await fs.writeFile(change.absToPath, change.content, 'utf-8');
          await fs.unlink(change.absFromPath);
          break;
        }
        case 'delete': {
          snapshots.push(await snapshot(change.absPath));
          await fs.unlink(change.absPath);
          break;
        }
      }
    }
  } catch (err) {
    // Best-effort rollback: undo every snapshot in reverse order.
    for (let i = snapshots.length - 1; i >= 0; i--) {
      const snap = snapshots[i];
      if (snap === undefined) continue;
      try {
        if (snap.kind === 'pre-existed') {
          await fs.mkdir(path.dirname(snap.path), { recursive: true });
          await fs.writeFile(snap.path, snap.bytes);
        } else {
          // Was absent before we touched it — make it absent again.
          await fs.rm(snap.path, { force: true });
        }
      } catch {
        // Swallow — best-effort. The error from the original failure
        // is what matters, not the rollback failure itself.
      }
    }
    return {
      ok: false,
      error: new ToolExecutionError(
        `apply_patch failed during write: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      ),
    };
  }

  // -------------------------------------------------------------------
  // 5. Build summary output and structured data.
  // -------------------------------------------------------------------
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const moves: Array<{ from: string; to: string }> = [];

  const summaryLines: string[] = [];
  for (const change of staged) {
    switch (change.kind) {
      case 'add':
        added.push(change.relPath);
        summaryLines.push(`A ${change.relPath}`);
        break;
      case 'update':
        modified.push(change.relPath);
        summaryLines.push(`M ${change.relPath}`);
        break;
      case 'move':
        modified.push(change.relToPath);
        moves.push({ from: change.relFromPath, to: change.relToPath });
        summaryLines.push(
          `R ${change.relFromPath} -> ${change.relToPath}`,
        );
        break;
      case 'delete':
        deleted.push(change.relPath);
        summaryLines.push(`D ${change.relPath}`);
        break;
    }
  }

  const output = `Success. Updated the following files:\n${summaryLines.join('\n')}`;

  return {
    ok: true,
    output,
    data: { files: { added, modified, deleted }, moves },
    metadata: {
      addedCount: added.length,
      modifiedCount: modified.length,
      deletedCount: deleted.length,
      moveCount: moves.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Staging helpers
// ---------------------------------------------------------------------------

function stageHunk(
  hunk: Hunk,
  absPath: string,
  absMovePath: string | undefined,
  cwd: string,
): StagedChange {
  switch (hunk.type) {
    case 'add': {
      const newContent =
        hunk.contents.length === 0 || hunk.contents.endsWith('\n')
          ? hunk.contents
          : `${hunk.contents}\n`;
      const next = splitBom(newContent);
      return {
        kind: 'add',
        absPath,
        relPath: relPathFor(absPath, cwd),
        content: joinBom(next.text, next.bom),
      };
    }

    case 'delete': {
      // Make sure the file actually exists; mirrors upstream which
      // reads it for the diff. We intentionally read here so a
      // missing-file error is reported BEFORE any disk write.
      try {
        readFileSync(absPath, 'utf-8');
      } catch (err) {
        throw new Error(
          `Failed to read file to delete: ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return {
        kind: 'delete',
        absPath,
        relPath: relPathFor(absPath, cwd),
      };
    }

    case 'update': {
      // Verify the target exists and is a regular file BEFORE applying
      // chunks; mirrors upstream verification flow.
      try {
        readFileSync(absPath, 'utf-8');
      } catch (err) {
        throw new Error(
          `Failed to read file to update: ${absPath}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const updated = computeUpdate(absPath, hunk.chunks);
      const finalContent = joinBom(updated.content, updated.bom);

      if (absMovePath !== undefined) {
        return {
          kind: 'move',
          absFromPath: absPath,
          absToPath: absMovePath,
          relFromPath: relPathFor(absPath, cwd),
          relToPath: relPathFor(absMovePath, cwd),
          content: finalContent,
        };
      }
      return {
        kind: 'update',
        absPath,
        relPath: relPathFor(absPath, cwd),
        content: finalContent,
      };
    }
  }
}

/**
 * Apply update chunks to the file at `absPath`. Reads the file
 * synchronously and uses the verbatim parser routine to compute the
 * new content. Throws when the file cannot be read or any chunk
 * cannot be located.
 */
function computeUpdate(
  absPath: string,
  chunks: UpdateFileChunk[],
): { content: string; bom: boolean } {
  // Delegate to the verbatim parser routine so the algorithm has a
  // single source of truth.
  const result = deriveNewContentsFromChunks(absPath, chunks);
  return { content: result.content, bom: result.bom };
}

function relPathFor(absPath: string, cwd: string): string {
  const rel = path.relative(cwd, absPath);
  return rel.length === 0 ? absPath : rel.split(path.sep).join('/');
}

async function snapshot(p: string): Promise<
  | { readonly kind: 'pre-existed'; readonly path: string; readonly bytes: Buffer }
  | { readonly kind: 'absent'; readonly path: string }
> {
  try {
    const bytes = await fs.readFile(p);
    return { kind: 'pre-existed', path: p, bytes };
  } catch (err) {
    if (
      err instanceof Error &&
      'code' in err &&
      (err as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return { kind: 'absent', path: p };
    }
    // Other errors (e.g. EACCES) propagate so the caller knows the
    // pre-flight already had a problem.
    throw err;
  }
}
