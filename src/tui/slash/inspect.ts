/**
 * /inspect — on-demand viewer for the LLM I/O capture channel (the `--inspect-io`
 * switch). Renders the EXACT provider-normalized request (assembled system
 * prompt + full in-thread memory + current user content + bound tool/function
 * JSON schemas) and the EXACT response (assistant text + parsed tool-calls +
 * tool results) for a completed turn.
 *
 * Sub-commands (args[0]):
 *   status         (default) — is capture active? capture file path + record count.
 *   show [turn]    — render a captured turn (1-based; latest when omitted).
 *   on | off       — explain that file capture is established at launch via
 *                    `--inspect-io` and cannot be created retro-actively mid-session.
 *
 * All output goes through `ctx.println` / `ctx.printSystem` — the SAME stdout
 * path every other slash command uses. NO capture output is interleaved into
 * the live token stream (NFR-2); this renderer runs only on the explicit
 * command. Reads `ctx.controller.ioCapture.read()` (the in-memory mirror) — no
 * disk re-parse. `/inspect on|off` deliberately informs rather than silently
 * no-ops (Design Decision 9), preserving the no-silent-fallback spirit.
 */

import { registerCommand, type SlashCommand, type SlashContext } from './registry.js';
import { BOLD, DIM, RESET, CYAN } from '../ansi.js';
import type { IoCaptureRecord, CapturedMessage, BoundToolSchema } from '../../agent/io-capture.js';

/**
 * Render budget: any single rendered block longer than this many characters is
 * clipped with a visible `… [truncated]` marker (FR-6). This bounds the TUI
 * output of a `/inspect show`; the on-disk JSONL keeps the full 64 KiB-capped
 * field. Intentionally smaller than the writer's 64 KiB byte cap so the
 * terminal view stays readable.
 */
const RENDER_BLOCK_MAX = 4000;

const TRUNCATION_MARKER = `${DIM}… [truncated]${RESET}`;

/** Clip a single string for terminal rendering with a visible marker (FR-6). */
function clip(text: string): string {
  if (text.length <= RENDER_BLOCK_MAX) return text;
  return text.slice(0, RENDER_BLOCK_MAX) + '\n' + TRUNCATION_MARKER;
}

/** Pretty-print an arbitrary value (tool args / tool result) for the view. */
function renderValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '(none)';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Group records by their `turnId`, preserving first-seen order. */
function groupByTurn(records: IoCaptureRecord[]): IoCaptureRecord[][] {
  const order: string[] = [];
  const byTurn = new Map<string, IoCaptureRecord[]>();
  for (const rec of records) {
    let bucket = byTurn.get(rec.turnId);
    if (!bucket) {
      bucket = [];
      byTurn.set(rec.turnId, bucket);
      order.push(rec.turnId);
    }
    bucket.push(rec);
  }
  return order.map((id) => byTurn.get(id)!);
}

/** Render one captured message (role-labelled), with tool-call/-result detail. */
function renderMessage(ctx: SlashContext, msg: CapturedMessage): void {
  ctx.println(`  ${CYAN}${msg.role}${RESET}`);
  if (msg.content.length > 0) {
    ctx.println(clip(msg.content));
  }
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    for (const tc of msg.toolCalls) {
      const id = tc.id ? ` ${DIM}#${tc.id}${RESET}` : '';
      ctx.println(`    ${DIM}tool-call${RESET} ${BOLD}${tc.name}${RESET}${id}`);
      ctx.println(clip(renderValue(tc.args)));
    }
  }
  if (msg.toolCallId) {
    ctx.println(`    ${DIM}↳ tool_call_id=${msg.toolCallId}${RESET}`);
  }
}

/** Render the bound tool/function schemas (FR-3d). */
function renderBoundTools(ctx: SlashContext, tools: BoundToolSchema[]): void {
  ctx.println(`  ${BOLD}Bound tool schemas${RESET} ${DIM}(${tools.length})${RESET}`);
  for (const t of tools) {
    ctx.println(`    ${BOLD}${t.name}${RESET} ${DIM}${t.description}${RESET}`);
    ctx.println(clip(renderValue(t.parameters)));
  }
}

/** Render a single grouped turn's request/response/tool-result records. */
function renderTurn(ctx: SlashContext, turnNumber: number, group: IoCaptureRecord[]): void {
  const first = group[0]!;
  ctx.println(`${BOLD}Turn ${turnNumber}${RESET} ${DIM}· ${first.ts}${RESET}`);

  for (const rec of group) {
    if (rec.kind === 'request') {
      ctx.println(`${BOLD}${CYAN}── REQUEST${RESET} ${DIM}(step ${rec.stepIndex})${RESET}`);
      for (const msg of rec.messages) {
        renderMessage(ctx, msg);
      }
      if (rec.boundTools && rec.boundTools.length > 0) {
        renderBoundTools(ctx, rec.boundTools);
      }
    } else if (rec.kind === 'response') {
      ctx.println(`${BOLD}${CYAN}── RESPONSE${RESET} ${DIM}(step ${rec.stepIndex})${RESET}`);
      if (rec.finalText.length > 0) {
        ctx.println(clip(rec.finalText));
      }
      for (const tc of rec.toolCalls) {
        const id = tc.id ? ` ${DIM}#${tc.id}${RESET}` : '';
        ctx.println(`  ${DIM}tool-call${RESET} ${BOLD}${tc.name}${RESET}${id}`);
        ctx.println(clip(renderValue(tc.args)));
      }
    } else {
      // tool_result
      const status = rec.ok ? 'ok' : 'error';
      ctx.println(
        `${BOLD}${CYAN}── TOOL RESULT${RESET} ${BOLD}${rec.toolName}${RESET} ` +
          `${DIM}(${status}, ${rec.durationMs}ms, step ${rec.stepIndex})${RESET}`,
      );
      if (rec.result !== undefined) {
        ctx.println(clip(renderValue(rec.result)));
      }
    }
  }
}

const inspectCmd: SlashCommand = {
  name: '/inspect',
  aliases: ['/inspect-io'],
  summary: 'Inspect the captured LLM request/response for a turn',
  async run(ctx, args): Promise<void> {
    const sub = args[0] ?? 'status';
    const io = ctx.controller.ioCapture;
    // FileIoCapture exposes a non-empty capture path; NullIoCapture is ''.
    const active = io.currentCapturePath !== '';

    if (sub === 'on' || sub === 'off') {
      ctx.printSystem(
        `LLM I/O capture is established at launch via the --inspect-io flag and ` +
          `cannot be created or destroyed mid-session — the capture file and the ` +
          `bound-tool snapshot are wired when the agent runtime is built. ` +
          (active
            ? `Capture is currently ACTIVE (writing to ${io.currentCapturePath}). ` +
              `Use '/inspect show [turn]' to view a turn.`
            : `Capture is currently OFF. Restart cli-agent with --inspect-io to enable it.`),
      );
      return;
    }

    if (sub === 'status') {
      try {
        if (!active) {
          ctx.println(`${BOLD}LLM I/O capture${RESET} ${DIM}(inactive)${RESET}`);
          ctx.println(`  enabled: no  ${DIM}(restart with --inspect-io to enable)${RESET}`);
          return;
        }
        const count = io.read().length;
        const turns = groupByTurn(io.read()).length;
        ctx.println(`${BOLD}LLM I/O capture${RESET} ${DIM}(active)${RESET}`);
        ctx.println(`  enabled: yes`);
        ctx.println(`  file:    ${io.currentCapturePath}`);
        ctx.println(`  records: ${count} ${DIM}across ${turns} turn${turns === 1 ? '' : 's'}${RESET}`);
        ctx.println(`  ${DIM}use '/inspect show [turn]' to render a turn${RESET}`);
      } catch (e) {
        ctx.printSystem(`failed to read captures: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    if (sub === 'show') {
      try {
        if (!active) {
          ctx.printSystem(
            `LLM I/O capture is OFF — restart cli-agent with --inspect-io to record turns.`,
          );
          return;
        }
        const groups = groupByTurn(io.read());
        if (groups.length === 0) {
          ctx.printSystem('no captured turns yet — run a prompt first.');
          return;
        }
        let index: number;
        const arg = args[1];
        if (arg === undefined) {
          index = groups.length - 1; // latest
        } else {
          const parsed = Number.parseInt(arg, 10);
          if (!Number.isInteger(parsed) || parsed < 1 || parsed > groups.length) {
            ctx.printSystem(
              `invalid turn '${arg}' — there ${groups.length === 1 ? 'is' : 'are'} ` +
                `${groups.length} captured turn${groups.length === 1 ? '' : 's'} (1..${groups.length}).`,
            );
            return;
          }
          index = parsed - 1; // 1-based → 0-based
        }
        renderTurn(ctx, index + 1, groups[index]!);
      } catch (e) {
        ctx.printSystem(`failed to read captures: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }

    ctx.printSystem(`unknown subcommand '${sub}'. Try status|show [turn]|on|off.`);
  },
};

registerCommand(inspectCmd);
export default inspectCmd;
