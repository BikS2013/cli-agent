# Plan 002 — Raw-mode TUI for cli-agent

**Status:** In Progress
**Created:** 2026-04-26
**Spec:** `~/.claude/agents/agent-tui-builder-spec.md` (sections §2 — §18)
**Brief:** main-chat hand-off, full slash-command set (4 groups), streaming wire-up, history at `~/.tool-agents/cli-agent/history/`.

---

## 1. Backend detection

| Signal | Match |
|---|---|
| `package.json` has `@langchain/langgraph` and `@langchain/langgraph/prebuilt createReactAgent` | yes (`src/agent/graph.ts:6`, `src/agent/graph.ts:29`) |
| `src/agent/graph.ts` exports a graph from `createReactAgent` returning `agentGraph.graph` | yes — non-streaming `.invoke()` path |
| `~/.tool-agents/cli-agent/` populated with .env + capabilities | yes |

Detected backend row: **cli-agent-builder output (LangGraph)**.

Existing seam (non-streaming):
- `src/agent/run.ts:18`  `runOneShotAgent(cfg, prompt) -> Promise<string>`
- `src/agent/graph.ts:39` `runOneShot(agentGraph, prompt, threadId, maxSteps) -> Promise<string>` — calls `agentGraph.graph.invoke(...)`

**New streaming seam (this plan):**
- `src/agent/graph.ts` will gain `streamOneShot()` — async generator over `agentGraph.graph.streamEvents(input, { version: 'v2' })`.
- `src/agent/run.ts` will gain `streamOneShotAgent()` — same setup as `runOneShotAgent` but yielding through `streamOneShot`.

---

## 2. Slash-command scope (all four groups)

| Group | Command | Status |
|---|---|---|
| Core | `/help` | in scope |
| Core | `/quit` (alias `/exit`) | in scope |
| Core | `/new` (alias `/reset`) | in scope |
| Core | `/clear` | in scope |
| History/memory | `/history` | in scope |
| History/memory | `/last` (alias `/raw`) | in scope |
| History/memory | `/copy` | in scope |
| History/memory | `/memory` | in scope |
| Runtime switching | `/model [<id>]` | in scope |
| Runtime switching | `/provider [<name>]` | in scope |
| Runtime switching | `/tools <add\|remove\|list> [name] [--save]` | in scope |
| Runtime switching | `/allow-mutations <on\|off>` | in scope |
| Capability inspection | `/capabilities` | in scope |
| Capability inspection | `/refresh-capabilities [<tool>]` | in scope |
| Capability inspection | `/tool-help <tool> [<sub>]` | in scope |

The spec's `/copy-all`, `/state`, `/memory add/remove/clear`, and `/monitor` commands are **not** part of the brief and are **omitted** in favor of the cli-agent-specific set listed above. `/memory` here is **diagnostic** (read-only; shows the active thread's `MemorySaver` state) — not the persistent user-instructions store from the spec.

---

## 3. File-creation matrix

All paths under `/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/`.

### `src/tui/` (new namespace)

| File | Purpose | ~LOC |
|---|---|---|
| `src/tui/index.ts` | Entry point — `startTui(cfg)`; banner; resume prompt; main loop | 180 |
| `src/tui/controller.ts` | TUI state machine, AbortController owner, session lifecycle, slash dispatch | 250 |
| `src/tui/renderer.ts` | Terminal renderer: agent header, tool-call summaries, transcript output, resize-aware | 200 |
| `src/tui/spinner.ts` | Braille spinner (per-line; multiple concurrent instances permitted) | 70 |
| `src/tui/utf8.ts` | Stateful UTF-8 decoder (StringDecoder wrapper) | 25 |
| `src/tui/ansi.ts` | ANSI constants + cursor helpers (RESET/BOLD/DIM/GREEN/CYAN/YELLOW/RED + cursor save/restore) | 60 |
| `src/tui/clipboard.ts` | Cross-platform copy via internal allowlist (`pbcopy`/`xclip`/`xsel`/`clip.exe`) | 70 |
| `src/tui/input/keybindings.ts` | Documented key→sequence map for /help | 80 |
| `src/tui/input/line-editor.ts` | Raw-mode multiline reader (escape framing per spec §5.1; UTF-8 per §5.2) | 480 |
| `src/tui/transcript/types.ts` | TurnRecord, ToolCallRecord, AssistantMsgRecord, ThreadIndexEntry | 50 |
| `src/tui/transcript/persist.ts` | history/ persistence: append turn JSONL, atomic index update, cursor.json | 180 |
| `src/tui/slash/registry.ts` | SlashCommand registration + dispatch + `SlashContext` typedef | 90 |
| `src/tui/slash/help.ts` | `/help` | 40 |
| `src/tui/slash/quit.ts` | `/quit` `/exit` | 30 |
| `src/tui/slash/new.ts` | `/new` `/reset` | 60 |
| `src/tui/slash/clear.ts` | `/clear` | 25 |
| `src/tui/slash/history.ts` | `/history` paginated browser | 90 |
| `src/tui/slash/last.ts` | `/last` `/raw` | 30 |
| `src/tui/slash/copy.ts` | `/copy` | 35 |
| `src/tui/slash/memory.ts` | `/memory` (diagnostic — current MemorySaver state) | 60 |
| `src/tui/slash/model.ts` | `/model [<id>]` runtime model swap | 70 |
| `src/tui/slash/provider.ts` | `/provider [<name>]` runtime provider swap | 90 |
| `src/tui/slash/tools.ts` | `/tools add\|remove\|list [--save]` | 110 |
| `src/tui/slash/allow-mutations.ts` | `/allow-mutations on\|off` | 50 |
| `src/tui/slash/capabilities.ts` | `/capabilities` table | 70 |
| `src/tui/slash/refresh-capabilities.ts` | `/refresh-capabilities [<tool>]` | 60 |
| `src/tui/slash/tool-help.ts` | `/tool-help <tool> [<sub>]` (shares resolver with `tool_help` LLM tool) | 70 |

### Tests under `src/tui/`

| Spec file | Coverage |
|---|---|
| `src/tui/utf8.spec.ts` | spec §14.2 — Greek/emoji/split-chunk decoding (mandatory) |
| `src/tui/spinner.spec.ts` | frame rotation; ANSI save/restore wrap |
| `src/tui/input/line-editor.spec.ts` | spec §14.1 escape framing + §14.2 UTF-8 + §14.3 mixed (mandatory) |
| `src/tui/clipboard.spec.ts` | platform dispatch (mocked `spawnCommand`) |
| `src/tui/transcript/persist.spec.ts` | JSONL append, atomic index, cursor.json, mode 0600 |
| `src/tui/slash/registry.spec.ts` | dispatch + alias resolution |
| `src/tui/slash/help.spec.ts` | renders the registered command list |
| `src/tui/slash/copy.spec.ts` | invokes correct platform command |
| `src/tui/slash/model.spec.ts` | rebuilds graph; rejects on factory error |
| `src/tui/slash/tools.spec.ts` | add/remove/list mutate session catalog; --save persists to config.json |
| `src/tui/slash/capabilities.spec.ts` | freshness column reflects `isCacheValid` |
| `src/tui/controller.spec.ts` | streaming loop: token emit + tool-start/end + ESC abort |

### Existing files modified

| File | Change |
|---|---|
| `src/agent/graph.ts` | Add `streamOneShot()` async generator + `AgentStreamEvent` union |
| `src/agent/run.ts` | Add `streamOneShotAgent()` async generator |
| `src/cli.ts` | Bare invocation (no prompt + no `-i`) → dispatch into `startTui(cfg)` |
| `src/commands/agent.ts` | One-shot path now consumes `streamOneShotAgent` and writes tokens as they arrive |
| `src/agent/logging.ts` | Already exports `llm_chunk`/`llm_final` types (no change). Wiring happens in `streamOneShot`. |
| `package.json` | (no change — `dev` already runs `tsx src/cli.ts`; bare invocation works) |
| `Issues - Pending Items.md` | Remove the [MEDIUM] llm_chunk/llm_final pending item |
| `docs/tools/cli-agent.md` | Append `## TUI mode` section |
| `docs/design/project-design.md` | Append `## TUI Subsystem` section |
| `docs/design/project-functions.md` | Append `FR-TUI-*` block |
| `docs/design/configuration-guide.md` | Document `CLI_AGENT_NO_TUI` + clipboard internal-allowlist note |
| `README.md` | Append `## TUI` section |

---

## 4. Adapter strategy

LangGraph already speaks the spec §4 event shape (`v2` event stream). The TUI's "adapter" is the thin `streamOneShot()` async generator which:

1. Calls `agentGraph.graph.streamEvents({ messages: [HumanMessage(prompt)] }, { configurable: { thread_id }, version: 'v2', recursionLimit: maxSteps*2, signal: abortSignal })`.
2. Maps:
   - `on_chat_model_stream` → `{ kind: 'token', text: chunk.content }`. **Also** writes `llm_chunk` log line via the active logger.
   - `on_chat_model_end` → emits `llm_final` log line; no TUI event.
   - `on_tool_start` → `{ kind: 'tool_call_start', toolName, args }`.
   - `on_tool_end` → `{ kind: 'tool_call_end', toolName, durationMs, ok }`.
3. On abort: throws `AbortError` from inside the generator; the TUI catches and renders `[interrupted]`.
4. Returns the assembled `agentText` when the run completes.

A single `turnId = randomUUID()` scopes one full `streamOneShot` call.

---

## 5. Persistence layout

```
~/.tool-agents/cli-agent/history/      # mode 0700
  thread-<UTC-iso>-<threadId>.jsonl   # mode 0600 — one line per turn (user prompt OR assistant final)
  index.jsonl                          # mode 0600 — one line per thread; updated atomically (tmp+rename)
  cursor.json                          # mode 0600 — { lastThreadId, lastTurnAt }
```

Per-turn JSONL line shape:
```
{ ts, threadId, turnId, role: "user"|"assistant", content }
```

`index.jsonl` line shape:
```
{ threadId, startedAt, lastTurnAt, turnCount, firstPrompt }
```

The TUI never writes `llm_chunk`-level fragments here. Chunks remain only in `~/.tool-agents/cli-agent/logs/`.

---

## 6. Mandatory test additions

Per spec §14, two regression suites are non-negotiable:

1. **Escape-framing (§14.1)** — `src/tui/input/line-editor.spec.ts` must drive each of `\x1b[A`/`[B`/`[C`/`[D`, `\x1bOH`, `\x1b[3~`, `\x1b[1;5D`, `\x1bb` followed by Enter, asserting the resolved buffer is exactly `""`.
2. **UTF-8 (§14.2)** — `src/tui/utf8.spec.ts` and `src/tui/input/line-editor.spec.ts` together must cover Greek round-trip, emoji round-trip, and split multi-byte across chunks.

Both must pass before the controller wiring is exercised end-to-end.

---

## 7. Documentation update list

- `docs/tools/cli-agent.md` — `## TUI mode` section near top of `<info>`
- `docs/design/project-design.md` — `## TUI Subsystem` (file map + event flow)
- `docs/design/project-functions.md` — `FR-TUI-001`..`FR-TUI-015` blocks
- `docs/design/configuration-guide.md` — `CLI_AGENT_NO_TUI` env var + clipboard internal allowlist note
- `Issues - Pending Items.md` — delete the [MEDIUM] llm_chunk/llm_final line; add line under "Done — see plan-002"
- `README.md` — `## TUI` section with ASCII screen mock + slash-command list

---

## 8. Phased gates

- **Phase 1 (scaffolding)**: stub files exist, `tsc --noEmit` clean, `tsx src/cli.ts --help` works.
- **Phase 2 (helpers)**: utf8/spinner/ansi/clipboard/line-editor units green; mandatory regression tests pass.
- **Phase 3 (streaming seam)**: `streamOneShot` + `streamOneShotAgent` exist; `llm_chunk`/`llm_final` log lines fire in a synthetic test.
- **Phase 4 (slash modules)**: every in-scope command has a passing test; dispatcher resolves names + aliases.
- **Phase 5 (entry point)**: bare invocation enters TUI; `--interactive` keeps readline REPL untouched; one-shot prompt uses streaming path.
- **Phase 6 (docs)**: all six documentation tasks complete; pending-items file updated.

End-state targets:
- `npx tsc --noEmit` clean.
- `npx vitest run` — all new tests pass on top of the existing baseline.
- Smoke run: bare invocation, type a prompt, see streaming tokens, ESC aborts mid-stream.
- Verify `~/.tool-agents/cli-agent/history/thread-*.jsonl` is created with mode 0600.
