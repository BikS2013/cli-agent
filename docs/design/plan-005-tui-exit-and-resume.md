# Plan 005 — TUI double-Ctrl+C exit and JSON-snapshot resume

**Status**: Accepted
**Author**: cli-agent maintainer + Claude
**Date**: 2026-05-02
**Related**: plan-002-tui.md (TUI baseline); FR-EXR-001 through FR-EXR-009 in `docs/design/project-functions.md`; project-design §12.

## Problem

Two ergonomic gaps in the TUI surfaced during user testing:

1. **No keyboard exit.** Ctrl+C never exits — it only clears the input buffer
   (or aborts an in-flight LLM turn). Users have to remember `/quit` or
   `Ctrl+D on an empty line`. Most modern REPLs (Python, Node REPL, Claude
   Code, ipython, psql) treat **double Ctrl+C** as the canonical exit, so
   the current behavior is surprising.

2. **No conversation resume.** The TUI already persists every turn to
   `~/.tool-agents/cli-agent/history/thread-*.jsonl` and writes a `cursor.json`
   pointing at the last-active thread, but quitting and restarting starts
   from a blank LangGraph checkpointer — the LLM has no memory of the
   prior conversation. The persistence is **display-only**.

   Bringing in `SqliteSaver` would solve this but adds a native dependency
   (`better-sqlite3`), a new schema migration concern, and per-turn
   write amplification we don't need for a single-user CLI agent.

## Goal

- Press Ctrl+C once → existing soft-cancel hint. Press Ctrl+C again within
  ~1.5 s → graceful shutdown identical to `/quit` and Ctrl+D-on-empty.

- `cli-agent --resume` (or `-r`) re-opens the last thread (using `cursor.json`)
  with full LangGraph context restored, so the next user message benefits
  from the entire prior conversation. `--resume <threadId>` re-opens a
  specific thread by id. A `/resume [<threadId>]` slash command does the
  same mid-session.

## Non-goals

- A new persistent checkpointer dependency (no SQLite, no Postgres, no Redis).
- Cross-session checkpoint sharing or multi-user concurrency safety.
- Branching / time-travel (jumping to an arbitrary checkpoint id within a
  thread).
- Automatic checkpoint pruning. Users delete files under
  `~/.tool-agents/cli-agent/history/` manually if they want to reclaim
  space.
- Resuming threads that were created with a different provider/model
  combination — we restore the LangGraph state verbatim regardless of
  current provider/model and warn the user when they differ.

## Architecture

### Why a JSON snapshot is sufficient

`@langchain/langgraph-checkpoint`'s `MemorySaver` exposes its full state
through **public typed fields** (verified in
`node_modules/@langchain/langgraph-checkpoint/dist/memory.d.ts`):

```ts
class MemorySaver extends BaseCheckpointSaver {
  storage: Record<string, Record<string, Record<string,
             [Uint8Array, Uint8Array, string | undefined]>>>;
  writes:  Record<string, Record<string,
             [string, string, Uint8Array]>>;
  ...
}
```

Both `Uint8Array` blobs are already encoded by langgraph's internal
`JsonPlusSerializer`. We only need to preserve the bytes — no LangChain
serialization helper required on our side.

### Where artifacts live

```
~/.tool-agents/cli-agent/history/
├── thread-<UTC-iso>-<threadId>.jsonl   ← already present (display transcript)
├── index.jsonl                          ← already present (thread index)
├── cursor.json                          ← already present (last threadId + ts)
└── checkpoint-<threadId>.json           ← NEW (LangGraph state snapshot, mode 0600)
```

One snapshot file per thread. Atomic writes via tmp + rename, mode 0600,
matching the existing pattern in `src/tui/transcript/persist.ts`.

### Snapshot schema

```jsonc
{
  "version": 1,
  "threadId": "5fb1a8…",
  "savedAt": "2026-05-02T14:33:21.117Z",
  "checkpointerKind": "MemorySaver",
  "storage": {
    "<threadId>": {
      "<checkpoint_ns>": {
        "<checkpoint_id>": ["<base64-bytes>", "<base64-bytes>", "<parent_id_or_null>"]
      }
    }
  },
  "writes": {
    "<threadId>": {
      "<task_id>": ["<channel>", "<task_path>", "<base64-bytes>"]
    }
  }
}
```

`Uint8Array` ↔ base64 conversions use Node's built-in
`Buffer.from(u8).toString('base64')` and
`new Uint8Array(Buffer.from(b64, 'base64'))`.

### Module layout

| New file | Purpose |
|---|---|
| `src/agent/checkpoint-store.ts` | `saveCheckpoint(threadId, saver)`, `loadCheckpoint(threadId, saver)`, `findCheckpoint(threadId)`, `checkpointFilePath(threadId)`. Pure I/O around the schema above; no agent imports. |
| `src/agent/checkpoint-store.spec.ts` | Round-trip test: build a `MemorySaver`, write a synthetic checkpoint, save/load via the store, assert the deserialized state equals the original (deep). |
| `src/tui/slash/resume.ts` | `/resume [<threadId>]` slash command. |
| `src/tui/slash/resume.spec.ts` | Registry assertion + happy-path. |

| Modified file | Change |
|---|---|
| `src/agent/graph.ts` | Add optional `prehydrateThreadId` to `buildAgentGraph` — when set, after `new MemorySaver()` we call `loadCheckpoint(prehydrateThreadId, checkpointer)` before returning. |
| `src/agent/run.ts` (or wherever `buildTuiAgentRuntime` lives) | Accept and forward `resumeThreadId`. |
| `src/cli.ts` | Add `--resume [threadId]` / `-r [threadId]` option to the bare TUI surface. Resolve the threadId from `cursor.json` if the value is omitted. |
| `src/tui/controller.ts` | After every turn (success or abort) call `saveCheckpoint(this.threadId, this.agentGraph.checkpointer)`. Add a `resumeFrom(turns: TurnRecord[])` helper that primes `messages` and `lastAssistantText` for display. |
| `src/tui/index.ts` | (1) Implement double-Ctrl+C window in the SIGINT branch. (2) When `resumeThreadId` is set in opts, log a banner line and call `controller.resumeFrom(...)` after construction. |
| `src/tui/slash/registry.ts` (via import in `src/tui/index.ts`) | Register `resume` so `/resume` is dispatchable. |
| `docs/tools/cli-agent.md` | Document `--resume`, `/resume`, double Ctrl+C, snapshot file. |
| `docs/design/project-functions.md` | Add FR-EXR-001 through FR-EXR-009. |
| `docs/design/project-design.md` | Add §12 "TUI exit & resume". |

### Persistence cadence

- **End of turn** (success or abort, in `finally` of `runTurn`): write the snapshot. ~10–50 ms IO per turn; runs after the assistant text has already been rendered, so user-perceived latency is unaffected.
- **Crash mid-turn:** the prior snapshot survives, so the next `--resume` returns to the last fully completed turn. Acceptable for a CLI agent.
- **`/new`, `/model`, `/provider`** (which call `resetThread`): we keep the previous thread's snapshot file; only the in-process saver gets reset. The user can `--resume <previous-id>` later.

### Double-Ctrl+C exit semantics

Replace the current SIGINT branch in `src/tui/index.ts:124–129` with a
debounced state machine:

```ts
const DOUBLE_SIGINT_WINDOW_MS = 1500;
let lastSigintAt = 0;

if (m === 'SIGINT') {
  const now = Date.now();
  if (now - lastSigintAt < DOUBLE_SIGINT_WINDOW_MS) {
    // Same path as EOF: persist + close + exit 0
    controller.logger.log({ kind: 'session_end', ts: new Date().toISOString(),
                            sessionId: controller.logger.currentSessionId,
                            reason: 'quit' });
    await controller.persistIndex();
    await controller.logger.close();
    stdout.write(`${DIM}goodbye.${RESET}\n`);
    process.exit(0);
  }
  lastSigintAt = now;
  stdout.write(`${DIM}(press Ctrl+C again within ${Math.round(DOUBLE_SIGINT_WINDOW_MS/1000)}s to exit, or use /quit)${RESET}\n`);
  continue;
}
```

`lastSigintAt` is reset implicitly: any other input (Enter, Ctrl+D, slash command) just continues the main loop and the next Ctrl+C compares against the stale timestamp, so a soft-cancel followed by typing then Ctrl+C does NOT exit. The only window in which a second Ctrl+C exits is "immediately after the hint."

### Functional requirements

See FR-EXR-001 through FR-EXR-009 in `docs/design/project-functions.md`.

### Testing

| Test | Target |
|---|---|
| `checkpoint-store.spec.ts` — round-trip a `MemorySaver` populated via `put` + `putWrites` | persistence correctness |
| `checkpoint-store.spec.ts` — `loadCheckpoint` returns false on missing file, throws on malformed JSON | error paths |
| `resume.spec.ts` — `/resume` is registered; runs against a stub checkpointer | slash plumbing |
| `controller.spec.ts` (extend) — `saveCheckpoint` is called once per turn, with the active threadId | wiring |
| Manual smoke — quit and `--resume`, prove the LLM remembers a prior fact | end-to-end |

### Failure modes / fallbacks

- **Schema version mismatch** (snapshot `version` ≠ 1) → throw with a clear
  message; do not silently rebuild. Per project policy, no fallbacks.
- **Snapshot file missing for an explicit `--resume <id>`** → exit code 2
  (UsageError). Bare `--resume` with no threadId AND no `cursor.json` →
  exit code 2 with "no prior session to resume."
- **`MemorySaver` internals change in a future langgraph release** → the
  snapshot loader fails on shape mismatch with a one-shot error pointing
  at this plan; the user can delete the snapshot and start fresh.

### Out of scope (deferred)

- A `--list-threads` flag (the existing `/history` slash is enough for now).
- Automatic checkpoint cleanup on `cli-agent` invocation.
- Resume across machines (the snapshot embeds local-only ids; no port).
- A migration helper if/when we ever add `SqliteSaver` — at that point a
  one-shot import script can read these JSON files and write the SQLite
  database, since both share the same `JsonPlusSerializer`-encoded blobs.
