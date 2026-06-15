/**
 * /resume — switch the live TUI session to a previously-persisted thread.
 *
 * Usage:
 *   /resume                  — adopts the last active thread from cursor.json
 *   /resume <threadId>       — adopts the specified thread
 *
 * Mid-session semantics: the current thread's checkpoint snapshot has
 * already been written by the per-turn save in TuiController.runTurn, so
 * resuming back to it later is always possible.
 *
 * The graph is rebuilt fresh (new MemorySaver), then hydrated from the
 * target thread's on-disk snapshot. The transcript is restored from the
 * thread's JSONL for visual continuity; the LLM-side state comes from
 * the checkpoint, not the transcript.
 */

import { registerCommand, type SlashCommand } from './registry.js';
import { buildAgentGraph } from '../../agent/graph.js';
import { createLLM } from '../../agent/providers/registry.js';
import { buildToolCatalog } from '../../agent/tools/registry.js';
import { composeCapabilitiesSystemPrompt } from '../../agent/capabilities/compose-system-prompt.js';
import { buildSystemPromptForCfg } from '../../agent/system-prompt.js';
import { loadCheckpoint } from '../../agent/checkpoint-store.js';
import {
  readCursor,
  readIndex,
  findThreadFile,
  readThreadTurns,
} from '../transcript/persist.js';
import type {
  TuiAssistantMessage,
  TuiMessage,
  TuiUserMessage,
} from '../controller.js';

const resumeCmd: SlashCommand = {
  name: '/resume',
  summary: 'Resume a prior thread by id (or omit the id to use the last active thread)',
  async run(ctx, args): Promise<void> {
    const c = ctx.controller;

    // Resolve the target thread.
    let target: string | null = args[0]?.trim() || null;
    if (!target) {
      const cursor = await readCursor();
      if (!cursor) {
        ctx.printSystem(`/resume: no prior session recorded (cursor.json missing)`);
        return;
      }
      target = cursor.lastThreadId;
    }

    if (target === c.threadId) {
      ctx.printSystem(`/resume: already on thread ${target.slice(0, 8)} — nothing to do`);
      return;
    }

    // Persist whatever we have on the current thread before swapping.
    await c.persistIndex();

    // Build a fresh graph so the MemorySaver namespace is clean before hydration.
    const llm = createLLM(c.cfg);
    const { tools, agentToolsMeta } = buildToolCatalog(c.cfg, c.logger);
    const capSection = await composeCapabilitiesSystemPrompt(
      c.cfg.capabilitiesDir,
      c.cfg.tools,
      c.cfg.capabilities.maxBytesPerTool,
    );
    const systemPrompt = await buildSystemPromptForCfg(c.cfg, capSection, agentToolsMeta, tools);
    const newGraph = buildAgentGraph(llm, tools, systemPrompt, c.cfg.maxSteps, c.cfg);

    const ok = await loadCheckpoint(target, newGraph.checkpointer);
    if (!ok) {
      ctx.printSystem(
        `/resume: no checkpoint snapshot for thread ${target.slice(0, 8)} — ` +
        `this thread predates the snapshot feature or the file was removed`,
      );
      return;
    }

    // Re-load transcript + index entry for the resumed thread.
    const file = await findThreadFile(target);
    const turns = file ? await readThreadTurns(file) : [];
    const idx = await readIndex();
    const entry = idx.find((e) => e.threadId === target);
    const startedAt = entry ? new Date(entry.startedAt) : new Date();

    const messages: TuiMessage[] = turns.map((t): TuiMessage => {
      if (t.role === 'user') {
        const m: TuiUserMessage = { role: 'user', text: t.content, ts: t.ts };
        return m;
      }
      const m: TuiAssistantMessage = {
        role: 'assistant', text: t.content, ts: t.ts, toolCalls: [],
      };
      return m;
    });

    c.agentGraph = newGraph;
    c.applyResume(target, startedAt, messages);

    const userTurns = turns.filter((t) => t.role === 'user').length;
    ctx.printSystem(
      `resumed thread ${target.slice(0, 8)} — ` +
      `${userTurns} prior turn${userTurns === 1 ? '' : 's'} restored, LLM context rehydrated`,
    );
  },
};

registerCommand(resumeCmd);
export default resumeCmd;
