# LangGraph `streamEvents` v2 — LLM I/O Capture Seam (LangChain v1.x)

> Focused technical research for the **LLM I/O inspector** feature (FR-3/FR-3d, FR-4, FR-12).
> Scope: how to capture the EXACT request (system prompt + full memory + bound tool schemas)
> and EXACT response (assistant text + tool_calls) at the provider-normalized LangChain
> message layer, uniformly across all eight providers, from the `src/agent/graph.ts`
> invocation boundary.
>
> Stack under test (verified from `package.json` + `node_modules` on this machine):
> `@langchain/core@1.1.42`, `@langchain/langgraph@1.2.9`, `@langchain/openai@1.4.5`,
> `@langchain/anthropic@1.3.28`, `@langchain/google-genai@2.1.29`, `zod@3.25.76`,
> TypeScript ESM, Node >=22.

---

## Executive Summary / Recommendations

Two design decisions were the point of this research. Both are now answered with high confidence:

### RECOMMENDATION 1 — Request-side hook: **capture from `on_chat_model_start`, do NOT reconstruct in `run.ts`**

`on_chat_model_start.data.input` carries the **literal, fully-assembled message array the model is about to receive** — system message + complete in-thread memory + the current human turn — as normalized `BaseMessage[]`. This is exactly the "complete memory and system prompt sent to the LLM along with the content" the user asked for, captured at the single seam where the bytes are real, **after** LangGraph has prepended the system prompt and merged the checkpointed history. Reconstructing the request from separate variables (assembled `systemPrompt` string + a separate checkpointer read + the new prompt) is **strictly inferior**: it re-derives what the framework already hands you and risks drift if message-trimming/summarization middleware is ever added between the graph state and the model call.

**However**, the start event does **not** reliably expose the **bound tool schemas / `tool_choice` / model name / temperature** in a documented, provider-neutral field. Therefore the recommended capture is a **hybrid**:

- **Per-turn request messages (FR-3a system prompt, FR-3b memory, FR-3c user content)** → capture from `on_chat_model_start.data.input` (the messages array). One event, one source of truth, zero reconstruction.
- **Bound tool/function schemas (FR-3d) + tool-use instruction overlays** → capture **once at graph-build / runner time** from the `DynamicStructuredTool[]` array and the overlay registry, correlated to the turn by `sessionId`/`turnId`. These are **static for the whole session** (the same tools are bound to every turn), so capturing them once (or once per session) and referencing them per turn is correct and avoids re-serializing on every turn.

This **refines** the codebase scan, which proposed taking the system prompt from the `buildSystemPromptForCfg` return value in `run.ts`. That string is still useful as a *labelled, pre-composition* artifact, but the **authoritative** request capture for FR-3a/3b/3c is the `on_chat_model_start` message array — it is what the provider actually receives and it already contains the system prompt as a `SystemMessage` (see Q4).

### RECOMMENDATION 2 — Tool-schema serialization: **use `convertToOpenAITool` from `@langchain/core/utils/function_calling`. Do NOT add `zod-to-json-schema`.**

**Dependency verdict (CRITICAL):** `zod-to-json-schema` is **NOT transitively available** in this install and you must **not** import it.

- `node_modules/zod-to-json-schema/` **does not exist** (verified: `Glob node_modules/**/zod-to-json-schema/package.json` → *no files*).
- In `package-lock.json` it appears only as an **optional** peer dependency of `@langchain/langgraph` (lines 730–735: `"zod-to-json-schema": "^3.x"` under `peerDependencies`, with `peerDependenciesMeta.zod-to-json-schema.optional = true`). Optional + not installed = not present on disk.
- `@langchain/core@1.1.42` no longer depends on `zod-to-json-schema` at all. Its `dependencies` (verified in `node_modules/@langchain/core/package.json`) are `@cfworker/json-schema`, `zod ^3.25.76 || ^4`, etc. It performs Zod→JSON-Schema conversion with its **own internal** `toJsonSchema` helper (`@langchain/core/dist/utils/json_schema.js`), which under the hood calls `zod/v4/core`'s `toJSONSchema` plus a vendored converter.

Importing `zod-to-json-schema` would therefore add an **undeclared dependency** (would work only by accident if some other package ever hoisted it, and break otherwise) — exactly what the project forbids, and it would have to clear `dependency-validation`. **Avoid it entirely.**

Instead, use what `@langchain/core` already exports and already installs:

```ts
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
// returns { type: 'function', function: { name, description, parameters: <JSON Schema> } }
```

This is the **same** function the OpenAI/Azure provider adapters use to format tools for the wire, so its `parameters` JSON Schema is byte-identical to (the OpenAI-shaped view of) what the provider receives — the highest-fidelity provider-neutral representation available without per-SDK hooks. If you want the raw parameter schema without the OpenAI envelope, `toJsonSchema(tool.schema)` from `@langchain/core/utils/json_schema` is also exported and installed. Both subpaths are declared in `@langchain/core`'s `exports` map (`./utils/function_calling`, `./utils/json_schema`), so the imports are stable.

> One nuance to document for the user: `convertToOpenAITool` always renders the **OpenAI** tool shape. Anthropic and Gemini receive a slightly different envelope on the wire (Anthropic: `{ name, description, input_schema }`; Gemini: `functionDeclarations`). At the **normalized** fidelity the feature targets (Open-Question-4 resolution), the OpenAI-shaped JSON Schema is the correct, uniform, provider-neutral artifact to record — the *parameters schema itself* is identical across providers; only the wrapper key names differ, and wrapper differences are explicitly out of scope (wire-byte capture is deferred).

---

## Question-by-Question Findings

### Q1 — Exact bound tool/function schema (FR-3d)

**Approaches compared:**

| Approach | Import | Availability in this install | Output shape | Verdict |
|---|---|---|---|---|
| `convertToOpenAITool(tool)` | `@langchain/core/utils/function_calling` | ✅ Installed, exported, used by OpenAI adapter | `{ type:'function', function:{ name, description, parameters: JSONSchema } }` | **RECOMMENDED** |
| `convertToOpenAIFunction(tool)` | `@langchain/core/utils/function_calling` | ✅ Installed, exported | `{ name, description, parameters: JSONSchema }` | Good (no `type/function` envelope) |
| `toJsonSchema(tool.schema)` | `@langchain/core/utils/json_schema` | ✅ Installed, exported | bare JSON Schema of params only | Good for params-only |
| `zodToJsonSchema(tool.schema)` | `zod-to-json-schema` (3rd-party pkg) | ❌ **NOT installed**, optional peer only | JSON Schema | **DO NOT USE** (undeclared dep) |
| Introspect `tool.schema` raw | n/a (Zod object) | n/a | Zod internals, not JSON Schema | ✗ not the provider view |
| Capture from model run invocation params | streamEvents start event | ⚠️ not a documented neutral field | varies | ✗ unreliable (see Q2) |

**Verification performed (no Bash; used Glob/Grep/Read):**
- `Glob node_modules/**/zod-to-json-schema/package.json` → **no files found** (package absent on disk).
- `Grep "zod-to-json-schema" package-lock.json` → only lines 730 & 733, inside `@langchain/langgraph` `peerDependencies` + `peerDependenciesMeta` marking it **optional**.
- `Read node_modules/@langchain/core/package.json` → `dependencies` has **no** `zod-to-json-schema`; has `@cfworker/json-schema`, `zod`.
- `Read node_modules/@langchain/core/dist/utils/function_calling.js` → `convertToOpenAIFunction` calls the **internal** `toJsonSchema(tool.schema)` from `./json_schema.js`. `convertToOpenAITool` wraps it as `{ type:'function', function:{...} }`.
- `Read node_modules/@langchain/core/dist/utils/json_schema.d.ts` → `toJsonSchema(schema, params?)` is exported; internally uses `zod/v4/core` `toJSONSchema` + a vendored `./zod-to-json-schema/` parser tree (a *fork bundled inside `@langchain/core`*, not the standalone npm package).

**Reproduce the dependency check on any machine:**
```bash
ls node_modules/zod-to-json-schema 2>/dev/null || echo "ABSENT — do not import it"
node -e "require.resolve('zod-to-json-schema')" 2>&1 | grep -q 'Cannot find' && echo "NOT RESOLVABLE"
grep -n 'zod-to-json-schema' package-lock.json   # confirms optional-peer-only
node -e "const {convertToOpenAITool}=require('@langchain/core/utils/function_calling'); console.log(typeof convertToOpenAITool)" # -> function
```

**Recommended capture code (FR-3d):**
```ts
import { convertToOpenAITool } from '@langchain/core/utils/function_calling';
import type { DynamicStructuredTool } from '@langchain/core/tools';

/** Serialize the bound toolset exactly as the model sees it (OpenAI-normalized). */
export function captureBoundToolSchemas(
  tools: DynamicStructuredTool[],
): Array<{ name: string; description: string; parameters: unknown }> {
  return tools.map((t) => {
    const def = convertToOpenAITool(t);            // { type:'function', function:{...} }
    return {
      name: def.function.name,
      description: def.function.description ?? '',
      parameters: def.function.parameters,         // JSON Schema — same the provider receives
    };
  });
}
```
Capture this **once** at the point `buildToolCatalog` returns the `tools` array in `run.ts` (the codebase scan §4 already identifies this location), and write it into the per-session/per-turn request record. Because the same `tools` array is bound to `createReactAgent` for the entire session, the schemas are turn-invariant — record them once and reference by `sessionId`, or denormalize into each turn's request record if you prefer self-contained records (size-cap per NFR-3 / the existing 64 KiB field-cap discipline).

> **Tool-use instruction overlays (the prose side of FR-3d).** The JSON schema above is the *machine* contract. The *prose* "instructions regarding tool use" (A-2) come from `loadOverlayRegistry().list()` and `BUILTIN_TOOL_PROMPTS`, plus the agent-tools prompt block — but note the agent-tools block and overlay descriptions are **already embedded inside the assembled system prompt string**, which is itself captured verbatim as the `SystemMessage` in the `on_chat_model_start` input (Q4). So you get the prose for free in the request-message capture; recording the overlay registry separately is an optional convenience for cleaner rendering, not a correctness requirement.

---

### Q2 — `streamEvents` v2 request-side capture (`on_chat_model_start`)

**Does `on_chat_model_start` expose the literal model input via `event.data.input`?** **YES.**

- Confirmed by Context7 (LangChain v1.x models doc): `if (event.event === "on_chat_model_start") { console.log(event.data.input); }`.
- Confirmed by the canonical streamEvents reference table: for `on_chat_model_start` the **data input** column is **`{"messages": BaseMessage[]}`**.

**Exact shape of `event.data.input`.** It is an object carrying the model's input messages. The well-documented shape is `{ messages: BaseMessage[] }`. **Version-specific caveat (flag):** historically (LangChain JS 0.2/0.3 era) the chat-model start event nested the messages as an **array-of-arrays** — i.e. `event.data.input.messages` could be `BaseMessage[][]` (one inner array per generation/prompt), and in some code paths the input arrived simply as `BaseMessage[]`. The reference table for v1.x shows the flat `{ messages: BaseMessage[] }`. **Do not hard-assume one shape.** Normalize defensively (handles bare array, `{messages: BaseMessage[]}`, and `{messages: BaseMessage[][]}`):

```ts
import type { BaseMessage } from '@langchain/core/messages';

function extractStartMessages(input: unknown): BaseMessage[] {
  if (Array.isArray(input)) {
    // could be BaseMessage[] or BaseMessage[][]
    return (input as unknown[]).flat() as BaseMessage[];
  }
  if (input && typeof input === 'object' && 'messages' in input) {
    const m = (input as { messages: unknown }).messages;
    if (Array.isArray(m)) return (m as unknown[]).flat() as BaseMessage[];
  }
  return [];
}
```

**Are bound tools / `tool_choice` / model name / temperature available on the start event?**
**Not via a documented, provider-neutral `event.data` field.** The reference table's `data` for the chat-model start event is documented only as the input messages. Invocation kwargs (bound `tools`, `tool_choice`, `model`, `temperature`) are *not* surfaced as a stable, normalized key on `event.data` — they live inside the serialized runnable / `event.metadata` (e.g. `ls_model_name`, `ls_provider`, `ls_temperature` LangSmith metadata keys may appear, but these are advisory, not guaranteed, and not the tool list). **Therefore: do not rely on the start event for FR-3d tool schemas.** Capture tool schemas from the bound `tools` array (Q1) instead.

**Verdict for the request-side hook:** The inspector **CAN** capture the literal request — **system + full message memory + current user content** — directly from `on_chat_model_start.data.input`, with **no reconstruction**. The **only** part that must be sourced separately is the **bound tool schema set (FR-3d)** and (optionally) the model/temperature, which come from the `tools` array and `cfg`/the model instance respectively. This is the hybrid in Recommendation 1.

**Recommended request-capture hook:**
```ts
// inside the streamOneShot for-await switch, add a case:
case 'on_chat_model_start': {
  if (ioCapture) {
    const msgs = extractStartMessages(event.data?.input);
    ioCapture.captureRequest({
      sessionId, threadId, turnId,
      ts: new Date().toISOString(),
      // each message normalized to { role, content, tool_calls?, tool_call_id? }
      messages: msgs.map(toCaptureMessage),
      // tool schemas captured once at build-time and injected via closure:
      boundTools: ioCapture.boundToolSchemas,   // from Q1
    });
  }
  break;
}
```
Where `toCaptureMessage` reads `m._getType()` (`'system' | 'human' | 'ai' | 'tool'`), `m.content`, and for AI messages `m.tool_calls` (see Q3). This mirrors the existing `/memory` command, which already calls `m._getType?.()` (`src/tui/slash/memory.ts:35`).

> **Important multi-step nuance:** `on_chat_model_start` fires **once per model call**, and a single agent "turn" (one user message) can trigger **multiple** model calls in the ReAct loop (call → tool → call again). So you will see **N** `on_chat_model_start` events per user turn when tools are used. Each one's `data.input` is the *growing* message array (memory + prior tool results). Decide whether a "captured turn" = one user message (group all N model calls under one `turnId`, capturing the request before each model call) or one model call. The codebase's existing `turnId` is minted **once per `streamOneShot`** (`src/agent/graph.ts:167`, `randomUUID()` at the top), i.e. **per user turn** — so multiple `on_chat_model_start` events will share the same `turnId`. Record each model call as a sub-step (add a monotonically increasing `stepIndex`) so the request→tool→request chain is inspectable (this directly serves FR-4c "request→response→tool-result chain ... end to end").

---

### Q3 — `streamEvents` v2 response-side capture (`on_chat_model_end` / `on_chat_model_stream`)

**`on_chat_model_end.data.output` shape.** It is an **`AIMessageChunk`** (the streaming aggregate), per the reference table (`AIMessageChunk("hello world")`) and Context7 (`event.data.output.text` for the full message). Treat it as an `AIMessage`-compatible object:
- **final text** → `output.text` (v1.x convenience getter) or normalize `output.content` (string | content-block array) with the codebase's existing `normalizeContent` (`src/agent/graph.ts:282`).
- **structured content** → `output.contentBlocks` (array of `{ type, text, ... }`).
- **tool calls** → `output.tool_calls`: an array of `ToolCall` = `{ type?: 'tool_call'; id?: string; name: string; args: Record<string, any> }` (verified in `node_modules/@langchain/core/dist/messages/tool.d.ts:92-106`). **`args` here is a fully-parsed object** — this is what you record for FR-4b.

**Reading the response reliably (FR-4a + FR-4b):**
```ts
import type { AIMessageChunk } from '@langchain/core/messages';

case 'on_chat_model_end': {
  const out = event.data?.output as AIMessageChunk | undefined;
  const finalText = out ? normalizeContent(out.content) : assembledText;
  const toolCalls = (out?.tool_calls ?? []).map((tc) => ({
    id: tc.id, name: tc.name, args: tc.args,   // args is a parsed object
  }));
  ioCapture?.captureResponse({
    sessionId, threadId, turnId,
    ts: new Date().toISOString(),
    finalText,
    toolCalls,
  });
  break;
}
```

**How `on_chat_model_stream` chunks concatenate.** Each `on_chat_model_stream` event carries `event.data.chunk` as an **`AIMessageChunk`**. The **correct** aggregation is `AIMessageChunk.concat()` (verified `node_modules/@langchain/core/dist/messages/ai.d.ts:60` — `concat(chunk): this`), **not** manual string concatenation:
```ts
let full: AIMessageChunk | null = null;
// inside on_chat_model_stream:
const chunk = event.data?.chunk as AIMessageChunk | undefined;
if (chunk) full = full ? full.concat(chunk) : chunk;
// after the stream: full.text is the final text; full.tool_calls is the assembled tool-call list
```
`concat()` does two non-trivial things string concatenation cannot: it **merges `tool_call_chunks` by `index`** into complete `tool_calls` (assembling the streamed JSON-fragment args into a parsed object), and it correctly joins content blocks. **This is the single biggest response-side pitfall** (see Pitfalls). The existing code accumulates text with `assembledText += text` and *separately* reads `tool_calls` off each **streamed chunk** (`src/agent/graph.ts:219` reads `event.data.chunk.tool_calls`) — but **a streamed chunk's `tool_calls` is usually empty/partial**; the populated one is `tool_call_chunks` (fragments) mid-stream and a complete `tool_calls` only on the **final** aggregated message or the **`on_chat_model_end` output**. For the inspector, **prefer the `on_chat_model_end.data.output.tool_calls`** (already assembled) over scraping per-chunk.

**Streaming vs non-streaming (`graph.invoke`) difference (FR-4 / `runOneShot`).** The non-streaming path (`src/agent/graph.ts:116`, `agentGraph.graph.invoke(...)`) produces **no streamEvents** — there is nothing to hook. Instead you read the final state: `result['messages']` is the full ordered message list (system + memory + human + ai + tool + ai...). For capture:
- **Request** = the messages array **as passed in** plus what the checkpointer merged — but on the invoke path you don't get an `on_chat_model_start` snapshot. Two options: (a) read `result['messages']` and take everything **up to and including** the final human message as the request context, or (b) read the checkpointer **before** invoke (Q5) for the prior memory and append the new human message. Option (b) is cleaner and matches `/memory`.
- **Response** = the **last** `AIMessage` in `result['messages']` (the codebase already extracts `messages[messages.length-1]` at `src/agent/graph.ts:122`). Read its `.tool_calls` for FR-4b. Note: when the model requested tools, the **last** message may be a final AI summary; the AI message(s) carrying `tool_calls` are earlier in the array — iterate and capture each `AIMessage` with non-empty `tool_calls`.

```ts
// runOneShot capture (non-streaming):
const messages = result['messages'] as BaseMessage[];
for (const m of messages) {
  if (m._getType() === 'ai') {
    const ai = m as AIMessage;
    if (ai.tool_calls?.length) { /* capture each tool_call: {id,name,args} */ }
  }
}
const last = messages[messages.length - 1];
const finalText = normalizeContent(last.content);
```

---

### Q4 — System prompt delivery & visibility

**How is the system prompt passed to `createReactAgent` in v1.x?**
The codebase currently uses `stateModifier: systemPrompt` (a plain string) — `src/agent/graph.ts:73`. In LangChain/LangGraph v1.x there are **several accepted forms**, and they are equivalent for capture purposes:

- `createReactAgent({ ..., prompt: "..." })` or `prompt: new SystemMessage("...")` — the **current v1.x prebuilt** parameter (Context7 migration doc: `createReactAgent({ model, tools, prompt: new SystemMessage(...) })`). When a `SystemMessage` is passed, **only its string content is used**.
- `stateModifier` / `messagesModifier` — **older** parameter names still accepted by the prebuilt for back-compat (what this codebase uses). A **string** `stateModifier` is treated as the system prompt.
- The newer `createAgent` (LangChain core agents) uses `systemPrompt: "..."`.

**Critical for the inspector — does the system prompt appear as a `SystemMessage` in the `on_chat_model_start` input?** **YES.** Regardless of which parameter delivered it, the prebuilt agent **prepends the system prompt as a `SystemMessage`** to the message list before the model call. Therefore it shows up as the **first element** of `on_chat_model_start.data.input.messages` with `_getType() === 'system'` and `content` = the full assembled prompt string. **This means FR-3a (complete assembled system prompt) is captured for free** in the Q2 request hook — you do **not** strictly need to capture the `buildSystemPromptForCfg` return value separately.

**Recommendation:** Capture the system prompt **from the `SystemMessage` in the start event** as the authoritative "what was actually sent" value. You *may* additionally record the `buildSystemPromptForCfg` string in `run.ts` as a labelled, sectioned artifact (it lets you annotate which bytes are base vs capabilities vs agent-tools block vs user addendum, per the `buildSystemPrompt` composition order documented at `src/agent/system-prompt.ts:80-112`), but if the two ever disagree, the **start-event `SystemMessage` wins** — it is the literal request.

> Edge case to flag: if a future change moves the system prompt into **middleware** (`wrapModelCall` mutating `request.systemMessage`, per the Context7 middleware example) rather than a static `prompt`, the start-event `SystemMessage` will reflect the **post-middleware** value — which is *more* correct for an inspector, another reason to prefer the start-event capture over the pre-composition string.

---

### Q5 — Reading exact in-thread memory from the checkpointer (`MemorySaver`)

**What `checkpointer.get(config)` / `.getTuple(config)` returns.** With `MemorySaver` + `config = { configurable: { thread_id } }`:
- `await checkpointer.get(config)` → a **`Checkpoint`** object whose `channel_values.messages` is the ordered `BaseMessage[]` history (the codebase already does exactly this: `src/tui/slash/memory.ts:20-27` → `cp.channel_values.messages`).
- `await checkpointer.getTuple(config)` → a **`CheckpointTuple`** = `{ config, checkpoint, metadata, parentConfig?, pendingWrites? }`. Use `.getTuple` if you also want checkpoint metadata (step, source); use `.get` if you only want the state. For the inspector, `.get(...).channel_values.messages` is sufficient and matches existing code.

```ts
const cp = await agentGraph.checkpointer.get({ configurable: { thread_id: threadId } });
const memory = (cp?.channel_values?.messages ?? []) as BaseMessage[];
```

**Relationship between checkpointed state messages and `on_chat_model_start` input messages — are they equivalent for capture?**
**Almost, with one important distinction:**
- The **checkpointed** `channel_values.messages` is the **persisted graph state**: human + ai + tool messages accumulated across turns. It **does NOT include the system prompt** (the system prompt is injected by the agent at model-call time via `prompt`/`stateModifier`, not stored in the message channel).
- The **`on_chat_model_start.data.input.messages`** is the **actual model input**: `[SystemMessage(prompt), ...checkpointed memory..., newHumanMessage]` (and, on later ReAct steps, the AI tool-call message + tool results appended). It is the checkpoint state **plus the system prompt prepended** **plus** any not-yet-checkpointed in-flight messages for the current step.

**Implication for the inspector:** For the truest "exactly what the model received this turn," **prefer the `on_chat_model_start` input** (it includes the system prompt and the in-flight step messages). The checkpointer read is the right source for the **`/inspect`-style on-demand memory view** (matching `/memory`) and for the **non-streaming `runOneShot` path** where no start event exists. They are equivalent **for the memory portion** (the human/ai/tool history) but the start event is a **superset** (adds the system message + current step's transient messages). Capturing the start-event input thus subsumes a checkpointer read for the streaming path; keep the checkpointer read for `runOneShot` and for the slash-command memory view.

---

### Q6 — Provider neutrality (FR-12)

**Is the `streamEvents` v2 event layer uniform across OpenAI, Anthropic, Gemini for the events above?** **YES, by design.** `streamEvents` is emitted by `@langchain/core`'s Runnable/tracer machinery, **above** the provider SDK. For all eight providers the inspector sees the same event names (`on_chat_model_start/stream/end`), the same `data.input` = `{ messages: BaseMessage[] }`, the same `data.chunk` = `AIMessageChunk`, and the same `data.output` = `AIMessageChunk`/`AIMessage`. **No provider-specific capture branches are needed** at the normalized fidelity the feature ships (Open-Question-4 resolution). This is precisely why the chosen seam satisfies FR-12 and AC-8 with one code path.

**Known per-provider differences to be aware of (none break the design, but document them):**
1. **`tool_calls` normalization.** All three providers' tool calls are **normalized into the same `ToolCall` shape** (`{ id?, name, args: object }`) by the provider adapter before they reach `AIMessage.tool_calls`. So the captured `tool_calls` are uniform. The *raw* provider differences (OpenAI `tool_calls[].function.arguments` as a JSON **string**; Anthropic `tool_use` blocks; Gemini `functionCall` parts) are already reconciled — you only ever see the normalized form. ✅
2. **Tool-call IDs.** OpenAI and Anthropic supply real `id`s; **Gemini historically does not** provide tool-call IDs (LangChain synthesizes/leaves them undefined). Your capture must treat `tool_call.id` as **optional** (the `.d.ts` already types `id?`). Don't key correlation on it.
3. **Streaming granularity of `tool_call_chunks`.** OpenAI streams args as incremental JSON fragments (`tool_call_chunks[].args` = partial string); Anthropic streams `input_json_delta`; Gemini often emits the tool call **non-incrementally** (one chunk). `AIMessageChunk.concat()` handles all three — another reason to rely on `concat()`/the end-event output rather than per-chunk scraping.
4. **`content` shape.** Anthropic/Gemini more frequently use **content-block arrays** (`[{type:'text',text:...}]`) where OpenAI uses a plain string. The codebase's `normalizeContent` already handles both; reuse it. ✅
5. **`data.input` nesting.** The array-of-arrays vs flat `{messages}` variance (Q2) is a **LangChain-version** artifact, not a provider artifact — the defensive `extractStartMessages` normalizer covers it across all providers.

---

## Practical Integration Snippet (ties Q1–Q6 together)

A minimal `IoCapture` shape and the two graph hooks, consistent with the codebase scan's `src/agent/io-capture.ts` plan and the existing `streamOneShot` structure:

```ts
// src/agent/io-capture.ts (new) — interface only; FileIoCapture/NullIoCapture per logging.ts pattern
import type { BaseMessage, AIMessageChunk } from '@langchain/core/messages';

export interface CapturedMessage {
  role: 'system' | 'human' | 'ai' | 'tool' | string;
  content: string;
  toolCalls?: Array<{ id?: string; name: string; args: unknown }>;
  toolCallId?: string;          // for tool messages
}
export interface IoCapture {
  /** Bound tool schemas captured once at session start (Q1). */
  readonly boundToolSchemas: ReadonlyArray<{ name: string; description: string; parameters: unknown }>;
  captureRequest(rec: {
    sessionId: string; threadId: string; turnId: string; stepIndex: number;
    ts: string; messages: CapturedMessage[];
  }): void;
  captureResponse(rec: {
    sessionId: string; threadId: string; turnId: string; stepIndex: number;
    ts: string; finalText: string;
    toolCalls: Array<{ id?: string; name: string; args: unknown }>;
  }): void;
  close(): Promise<void>;
}

export function toCaptureMessage(m: BaseMessage): CapturedMessage {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mm = m as any;
  const role = mm._getType?.() ?? mm.role ?? 'msg';
  const content = typeof mm.content === 'string'
    ? mm.content
    : Array.isArray(mm.content)
      ? mm.content.filter((c: any) => c?.type === 'text').map((c: any) => c.text ?? '').join('')
      : '';
  const out: CapturedMessage = { role, content };
  if (Array.isArray(mm.tool_calls) && mm.tool_calls.length > 0) {
    out.toolCalls = mm.tool_calls.map((tc: any) => ({ id: tc.id, name: tc.name, args: tc.args }));
  }
  if (mm.tool_call_id) out.toolCallId = mm.tool_call_id;
  return out;
}
```

```ts
// src/agent/graph.ts — additions to streamOneShot's switch (sketch; redaction applied inside IoCapture)
let stepIndex = 0;
// ...
case 'on_chat_model_start': {
  if (ioCapture) {
    const msgs = extractStartMessages(event.data?.input);
    ioCapture.captureRequest({
      sessionId, threadId, turnId, stepIndex,
      ts: new Date().toISOString(),
      messages: msgs.map(toCaptureMessage),    // includes SystemMessage = full system prompt (Q4)
    });
  }
  break;
}
case 'on_chat_model_end': {
  // existing logger.log({ kind:'llm_final', ... }) stays
  if (ioCapture) {
    const out = event.data?.output as AIMessageChunk | undefined;
    const finalText = out ? normalizeContent(out.content) : assembledText;
    const toolCalls = (out?.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.name, args: tc.args }));
    ioCapture.captureResponse({ sessionId, threadId, turnId, stepIndex, ts: new Date().toISOString(), finalText, toolCalls });
  }
  stepIndex += 1;
  break;
}
```

`boundToolSchemas` is built once in `run.ts` (`captureBoundToolSchemas(tools)` from Q1) and injected into the `IoCapture` instance, which threads into `streamOneShot` via the existing `StreamOneShotOptions` (extend it with `ioCapture?: IoCapture`, exactly as the codebase scan §4 proposes).

---

## Best Practices

1. **Single seam, normalized layer.** Capture only at `on_chat_model_start` / `on_chat_model_end` (streaming) and `result['messages']` (non-streaming). This is the one provider-neutral place (FR-12) and avoids per-SDK hooks the project explicitly deferred.
2. **Prefer the end-event aggregated message for tool_calls.** `on_chat_model_end.data.output.tool_calls` is already assembled and parsed. Avoid reconstructing tool calls from streamed chunks unless you specifically want token-level streaming fidelity (then use `AIMessageChunk.concat()`).
3. **Capture the system prompt from the `SystemMessage`, not the pre-composition string.** It reflects the literal request and survives any future middleware/trimming.
4. **Capture tool schemas once per session** (they're bound once) and reference per turn; don't re-serialize Zod on every turn (NFR-3 performance).
5. **Reuse the existing primitives:** `normalizeContent` (`graph.ts:282`), `_getType()` message classification (`memory.ts:35`), `redactString`/`redactObject` (`util/redact.ts`), the 64 KiB field-cap + `_truncated` marker (`logging.ts:64-82`), and the `0700`/`0600` + `latest.*` filesystem contract (`logging.ts:149-177`). Do not invent parallels.
6. **`stepIndex` within a `turnId`.** Because one user turn can produce multiple model calls, record an incrementing `stepIndex` so the request→tool→request chain (FR-4c) is reconstructable.
7. **Redaction interplay.** Apply redaction **inside** `IoCapture.serialize()` right before write (mirroring `FileLogger.log()` at `logging.ts:104`), and **skip** it only when `--inspect-io-raw` is set, emitting the stderr warning **before** opening the file. Redact **both** message `content` **and** tool-call `args` (use `redactObject` for args) — secrets can ride in either.

---

## Common Pitfalls

| # | Pitfall | Why it bites | Fix |
|---|---|---|---|
| 1 | **Manual string concat of stream chunks** loses tool calls | `assembledText += text` never assembles `tool_call_chunks` → args | Use `AIMessageChunk.concat()` or read `on_chat_model_end.data.output` |
| 2 | **Reading `tool_calls` off a streamed chunk** (`event.data.chunk.tool_calls`) | mid-stream chunks carry `tool_call_chunks` (fragments), `tool_calls` is usually empty until the final/aggregated message | Read tool_calls from the **end event output** (or aggregated `full`) |
| 3 | **`tool_call_chunks.args` is a partial JSON *string*, `tool_calls.args` is a parsed *object*** | recording the wrong one yields truncated/invalid args | Record `tool_calls.args` (object) from the end event |
| 4 | **Assuming `data.input` is always `{messages: BaseMessage[]}`** | older/edge versions nest as `BaseMessage[][]` or pass a bare array | Use defensive `extractStartMessages` (flatten) |
| 5 | **Expecting one `on_chat_model_start` per user turn** | the ReAct loop fires it once **per model call** (N per tool-using turn) | Group by `turnId` + `stepIndex`; capture request before each model call |
| 6 | **Looking for the system prompt in the checkpointer** | system prompt is **not** stored in `channel_values.messages`; it's injected at call time | Capture the `SystemMessage` from the start-event input |
| 7 | **Importing `zod-to-json-schema`** | **not installed** (optional peer only); undeclared-dep violation + runtime failure | Use `convertToOpenAITool` / `toJsonSchema` from `@langchain/core` |
| 8 | **Gemini tool calls missing `id`** | keying correlation on `tool_call.id` breaks for Gemini | Treat `id` as optional; don't correlate on it |
| 9 | **`content` is sometimes a content-block array, not a string** (Anthropic/Gemini) | naive `String(content)` mangles it | Reuse `normalizeContent` |
| 10 | **Capturing in `runOneShot` by hooking events** | `graph.invoke()` emits **no** streamEvents | Read `result['messages']`; capture request via checkpointer pre-read |
| 11 | **Redacting only `content`, not tool-call `args`** | secrets can appear in tool arguments | `redactObject(args)` too |
| 12 | **Bloating the operational log** with system-prompt/memory payloads | breaks log compactness + off-state byte-stability (NFR-1) | Use the **separate** `io-captures/` channel (Q7 resolution), never extend `LogEvent` |

---

## Findings that change / refine the codebase-scan hook design

1. **Dependency correction (high impact).** The scan §5 says `zod-to-json-schema` is "already transitively available via `@langchain/core`." **This is no longer true in the installed `@langchain/core@1.1.42`** — the package is absent on disk and is only an *optional peer* of langgraph. **Use `convertToOpenAITool` / `toJsonSchema` from `@langchain/core/utils/function_calling` | `/utils/json_schema` instead.** No new dependency, no `dependency-validation` cycle needed. (Verified by Glob/Grep/Read on `node_modules` + `package-lock.json`.)

2. **Request capture should come from `on_chat_model_start`, not (only) the `buildSystemPromptForCfg` string.** The scan §5 leans on capturing the assembled `systemPrompt` string in `run.ts`. That's a fine *labelled* artifact, but the **authoritative** FR-3a/3b/3c capture is the `on_chat_model_start.data.input` message array, which already contains the system prompt as a `SystemMessage` **and** the full memory **and** the user content in one literal snapshot — and is robust to future middleware. Adds a new `on_chat_model_start` case to `streamOneShot` (the scan only contemplated reusing the existing `on_chat_model_end` case).

3. **One user turn → multiple `on_chat_model_start` events.** The scan's per-turn framing must accommodate a `stepIndex` within the existing per-turn `turnId` so multi-call ReAct turns capture each model request and the interleaved tool results (serves FR-4c end-to-end chain).

4. **`runOneShot` needs an explicit request snapshot.** No streamEvents on the invoke path → capture the request via a checkpointer pre-read (Q5) plus the new human message, and the response from `result['messages']` (iterate AI messages for `tool_calls`, not just the last message).

5. **Tool-use *prose* is already inside the captured system prompt.** Overlay/built-in prompt text and the agent-tools block are embedded in the assembled system prompt, hence already captured as the `SystemMessage`. Capturing `loadOverlayRegistry().list()` separately is optional (nicer rendering), not required for fidelity.

---

## Assumptions & Scope

- **Interpretation of "exact request/response":** the **provider-normalized LangChain message layer** (per refined-request Open-Question-4 resolution), i.e. `BaseMessage[]` at the model-call boundary and the normalized `AIMessage`/`ToolCall` shapes — **not** literal per-provider HTTP bytes (explicitly deferred). All findings target this layer.
- **Out of scope (unchanged from refined request):** wire-byte capture, capability-discovery/composite-synthesis LLM calls, editing/replaying captures.
- **`createReactAgent` continues to bind the same `tools` array for the whole session.** Verified by reading `buildAgentGraph` (`graph.ts:60-90`) — tools are passed once at build; no per-turn rebinding. Hence schema capture is turn-invariant. (Confidence HIGH.)
- **Confidence levels for key claims:** see table below.

---

## Sources Collected

| # | Source | URL | Information Gathered |
|---|---|---|---|
| 1 | Installed `@langchain/core` `function_calling.d.ts` / `.js` | local `node_modules/@langchain/core/dist/utils/function_calling.*` | Exact exports `convertToOpenAITool` / `convertToOpenAIFunction`; both use internal `toJsonSchema`; OpenAI envelope shape |
| 2 | Installed `@langchain/core` `json_schema.d.ts` | local `node_modules/@langchain/core/dist/utils/json_schema.d.ts` | `toJsonSchema(schema, params?)` exported; uses `zod/v4/core` + vendored converter + `@cfworker/json-schema` |
| 3 | Installed `@langchain/core/package.json` | local | v1.1.42 deps have **no** `zod-to-json-schema`; has `@cfworker/json-schema`, `zod`; `exports` map has `./utils/function_calling`, `./utils/json_schema` |
| 4 | Project `package-lock.json` | local lines 700–737 | `zod-to-json-schema` is an **optional peer** of `@langchain/langgraph@1.2.9` only; not a real dep |
| 5 | Installed `@langchain/core` `messages/ai.d.ts` | local | `AIMessage.tool_calls`, `AIMessageChunk.tool_call_chunks`, `AIMessageChunk.concat(): this`, `contentBlocks`, `.text` |
| 6 | Installed `@langchain/core` `messages/tool.d.ts` | local | `ToolCall = {type?, id?, name, args: object}`; `ToolCallChunk = {id?, name?, args?: string-fragment, index?}` |
| 7 | LangChain JS v1.x — Models (Context7) | https://docs.langchain.com/oss/javascript/langchain/models | `streamEvents`: `on_chat_model_start.data.input`, `on_chat_model_stream.data.chunk.text`, `on_chat_model_end.data.output.text`; `AIMessageChunk.concat()` aggregation |
| 8 | LangChain JS v1.x — Messages / Migrate / Middleware (Context7) | https://docs.langchain.com/oss/javascript/langchain/messages , .../migrate/langchain-v1 , .../middleware/custom | `createReactAgent({prompt: new SystemMessage(...)})`; `createAgent({systemPrompt})`; SystemMessage content used directly; `AIMessageChunk` concat |
| 9 | LangChain Reference — `streamEvents` (StructuredTool) | https://reference.langchain.com/javascript/langchain/index/StructuredTool/streamEvents | Event reference table: `on_chat_model_start` data input = `{"messages": BaseMessage[]}`; `on_chat_model_end` output = `AIMessageChunk` |
| 10 | LangChain Reference — `streamEvents` (ChatOllama) | https://reference.langchain.com/javascript/langchain-ollama/ChatOllama/streamEvents | Confirms flat `{"messages": BaseMessage[]}` start input; `AIMessageChunk` end output; no documented graph-vs-bare-model difference |
| 11 | LangChain — event streaming (v3 typed projections) | https://docs.langchain.com/oss/javascript/langchain/event-streaming | `AIMessageChunk.isInstance`, `message.tool_call_chunks`, `ToolMessage.isInstance`, streaming tool-call lifecycle (v3) |
| 12 | LangChain Python StreamEvent schema (cross-ref) | https://api.python.langchain.com/en/latest/runnables/langchain_core.runnables.schema.StreamEvent.html | StreamEvent fields (`event`, `name`, `run_id`, `tags`, `metadata`, `data`); data varies by event type; v2 default |
| 13 | Existing codebase (graph/memory/system-prompt) | local `src/agent/graph.ts`, `src/tui/slash/memory.ts`, `src/agent/system-prompt.ts` | Current `stateModifier` prompt delivery, v2 event loop, `checkpointer.get().channel_values.messages`, `normalizeContent`, per-turn `turnId` minting |

### Recommended for Deep Reading
- **Source 9 / 10 (LangChain Reference `streamEvents` tables):** the authoritative, version-current definition of the `on_chat_model_*` `data` shapes — the backbone of Q2/Q3.
- **Source 1 + 3 + 4 (installed `function_calling` + the two package manifests):** the decisive evidence for the dependency verdict (Q1). Re-run the reproduce-check block before implementation to confirm on the build machine.
- **Source 7 (Context7 Models doc):** the cleanest end-to-end `streamEvents` capture example and the `AIMessageChunk.concat()` pattern.

---

## Assumptions Made

| Assumption | Confidence | Impact if Wrong |
|---|---|---|
| `on_chat_model_start.data.input` is `{messages: BaseMessage[]}` (possibly nested) | **HIGH** | If shape differs, the defensive `extractStartMessages` flatten already covers bare-array / array-of-arrays / `{messages}` — low residual risk |
| `on_chat_model_end.data.output` is an `AIMessage`/`AIMessageChunk` with `.tool_calls` (parsed) and `.content`/`.text` | **HIGH** | If output were a raw provider object, would need `normalizeContent` + tool-call normalization — already used defensively |
| `zod-to-json-schema` is absent and must not be imported; `convertToOpenAITool` is the correct serializer | **HIGH** | Verified directly on disk + in lockfile + in core source. If a future `npm install` hoisted it, importing would *work* but still be a policy violation — recommendation stands regardless |
| System prompt appears as a `SystemMessage` in the start-event input regardless of `stateModifier`/`prompt` form | **HIGH** (Context7 + prebuilt behavior) | If a version stopped prepending it to the model input, fall back to capturing the `buildSystemPromptForCfg` string in `run.ts` (already available) |
| The `streamEvents` v2 layer is provider-uniform for these events across OpenAI/Anthropic/Gemini | **HIGH** | If a provider adapter emitted divergent event data, you'd add a thin per-provider normalizer — but tool_calls/content are already normalized by the adapters |
| One user turn can fire multiple `on_chat_model_start` events (ReAct loop) | **HIGH** | If only one fired, `stepIndex` is harmless (stays 0); design degrades gracefully |
| `MemorySaver.get(config).channel_values.messages` is the ordered history and excludes the system prompt | **HIGH** (matches existing `/memory` code) | If memory included the system prompt, the start-event capture still wins as the literal request |
| `convertToOpenAITool`'s `parameters` JSON Schema equals the params the non-OpenAI providers receive (only the envelope differs) | **MEDIUM** | If a provider materially reshapes the *parameters* (not just the wrapper), the recorded schema is an OpenAI-normalized approximation — acceptable at the deferred-wire-byte fidelity, but worth a doc note |

## Uncertainties & Gaps

- **Exact `data.input` nesting in `@langchain/langgraph@1.2.9` specifically:** the reference tables show the flat `{messages: BaseMessage[]}`, but I could not execute code in this environment (Bash disabled) to print the live shape from a real graph run. The defensive normalizer removes the risk, but a 3-line runtime probe during implementation (log `JSON.stringify(Object.keys(event.data.input))` on the first start event) would convert this from MEDIUM-HIGH to certain.
- **Whether `on_chat_model_end.data.output` is precisely `AIMessageChunk` vs `AIMessage` on the *non*-streaming-but-event-emitting paths:** the reference table says `AIMessageChunk`; in practice both expose `.tool_calls`/`.content`/`.text` identically, so capture code is shape-agnostic. No action needed beyond treating it as `AIMessage`-compatible.
- **Per-provider `tool_choice`/model-name visibility on the start event:** confirmed *not* a reliable neutral field; LangSmith metadata keys (`ls_model_name`, `ls_provider`, `ls_temperature`) *may* appear in `event.metadata` but are advisory. If the inspector wants to display model/temperature, source them from `cfg`/the model instance, not the event.
- **Live runtime confirmation of all six providers:** verified the *normalized contract* from types + docs; did not run all eight providers end-to-end (out of scope for a research task, and the normalization guarantee is architectural).

## Clarifying Questions for Follow-up

1. Should a "captured turn" be **one user message** (group all ReAct model calls under one `turnId` with `stepIndex`) or **one model call**? (Recommendation: per user message, with `stepIndex` — matches the existing per-`streamOneShot` `turnId`.)
2. Should the inspector also record **model name / temperature / `tool_choice`** for each request? If yes, source from `cfg`/the model instance (not the start event) — confirm that's acceptable.
3. For `runOneShot` (non-streaming) request capture, prefer **(a)** deriving request context from `result['messages']` or **(b)** a checkpointer pre-read + new human message? (Recommendation: (b), matching `/memory`.)
4. Is recording the OpenAI-normalized tool **parameters** schema (identical params across providers; only envelope differs) sufficient for FR-3d, or is a per-provider envelope view ever wanted later? (Wire-byte/envelope capture is currently deferred per Open-Question-4.)
5. Should the separately-capturable **overlay prose** (`loadOverlayRegistry().list()` + `BUILTIN_TOOL_PROMPTS`) be recorded as its own block, given it's already embedded in the captured system prompt? (Optional; improves rendering granularity for FR-6.)
