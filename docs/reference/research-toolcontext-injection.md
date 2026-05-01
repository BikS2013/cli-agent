---
research_topic: "LangGraph createReactAgent — ToolContext injection per session/turn"
requested_by: "solutions-investigator (plan pre-requisite)"
researched_at: "2026-04-30"
verdict: "Use RunnableConfig.configurable injection — the only pattern that is compatible with createReactAgent's compile-once model and MemorySaver/PostgresSaver checkpointer."
---

# LangGraph `createReactAgent` — Per-Session ToolContext Injection

## Overview

This document answers the wiring question raised in
`docs/reference/investigation-agent-tools-integration.md §Technical Research Guidance
Topic 2`: how to supply a fresh `ToolContext` (`cwd`, `permissions`, `session`,
`signal`) from `BikS2013/agent-tools` to every tool call **without rebuilding the
graph between turns or sessions**.

The conclusion is concrete: use **`RunnableConfig.configurable` injection**.
The `ToolNode` (used internally by `createReactAgent`) already passes the live
`RunnableConfig` to every tool's `.invoke()` call. Tool functions can read
per-call values from `config.configurable` without any mutable shared state or
async-local-storage tricks.

---

## 1. `createReactAgent` Lifecycle — What Is Bound When

### 1.1 Graph compilation happens once per session

`createReactAgent` from `@langchain/langgraph/prebuilt` builds a `StateGraph`
and calls `.compile()` on it. That compile step:

- Binds the tool array to the LLM via `llm.bindTools(tools)`.
- Wires a `ToolNode` that holds a reference to the same tool instances.
- Attaches the checkpointer.

None of these steps are repeated between turns. cli-agent already does this
correctly: `buildAgentGraph` is called once per runner invocation
(`run.ts:71`, `run.ts:164`, `run.ts:250`, `run.ts:289`) and the resulting
`AgentGraph` is reused across all turns within that session.

**Implication**: the tool *instances* are stable for the lifetime of the process
run. Their `name` and Zod `schema` must not change after compile time. Only the
*behavior inside `func`* can be dynamic.

### 1.2 The ToolNode passes RunnableConfig to every tool call

From the LangGraph JS source (`libs/langgraph-core/src/prebuilt/tool_node.ts`):

```typescript
// ToolNode.runTool (simplified)
protected async runTool(call: ToolCall, config: RunnableConfig): Promise<ToolMessage | Command> {
  const tool = this.tools.find((tool) => tool.name === call.name);
  const output = await tool.invoke({ ...call, type: "tool_call" }, config);
  // ...
}
```

The `config` object — the same `RunnableConfig` that was passed to
`graph.invoke(state, config)` or `graph.streamEvents(state, config)` — is
threaded through the entire call stack and handed to each tool's `.invoke()`
call. This is not documented prominently but is confirmed by the source.

### 1.3 What the checkpointer touches

The checkpointer serializes the **graph state** (message history) after every
superstep. It does **not** serialize tool functions or the tool instances
themselves. Tool calls in checkpoint state are stored as `AIMessage.tool_calls`
entries containing only the tool's `name` and `args` strings — not the
callable. When a thread resumes from a checkpoint, the graph re-routes by tool
name at runtime, dispatching to whichever tool instance currently has that
name.

**Critical implication**: changing the `func` closure or the `ToolContext` a
tool uses between turns has **no effect on the checkpointer's consistency**,
because the checkpointer does not care about tool object identity or function
references — only tool name stability. Rebuilding the tool catalog with new
object identities (different `new DynamicStructuredTool(...)` calls) would
still be safe for the checkpointer, but it would force a re-bind of
`llm.bindTools(tools)` and break the compile-once contract of
`createReactAgent`. Per-turn catalog rebuilding is therefore rejected for a
different reason: it requires rebuilding the compiled graph, which is
architecturally incorrect with `createReactAgent`.

---

## 2. `DynamicStructuredTool.func` / `tool()` Closure — The Actual Signature

### 2.1 Three-argument func (DynamicStructuredTool)

`DynamicStructuredTool.func` has the following TypeScript signature:

```typescript
func: (
  input: SchemaOutputT,
  runManager?: CallbackManagerForToolRun,
  config?: RunnableConfig<Record<string, any>>
) => Promise<ToolOutputT>
```

The `RunnableConfig` is the **third** parameter (after `runManager`). The
`ToolNode` calls `tool.invoke(toolCallArgs, config)`, and LangChain's
`StructuredTool._call` internally unpacks the config and passes it to `func` as
its third argument.

### 2.2 Two-argument func (tool() factory)

The upstream `agent-tools` adapter uses the `tool()` factory from
`@langchain/core/tools`, which wraps the user function differently:

```typescript
// From agent-tools/src/adapters/langchain.ts
const func = async (input: z.infer<S>): Promise<string> => { ... };
const lcTool = tool(func, { name, description, schema });
```

In this form, the `func` closure receives only `input`. LangChain's `tool()`
factory supports a second parameter pattern:

```typescript
const lcTool = tool(
  async (input, config?: RunnableConfig) => {
    const cwd = config?.configurable?.workingDirectory as string;
    // ...
  },
  { name, description, schema }
);
```

When using `tool()`, `RunnableConfig` is the **second** parameter (not third),
because the `tool()` factory does not expose `runManager` to the user function.

**For cli-agent's integration wrapper** (which wraps the upstream adapter), the
recommended approach is to write the wrapper using `DynamicStructuredTool`
directly (matching cli-agent's existing factory pattern) and receive `config`
as the third `func` argument.

### 2.3 Thread-safety and async concurrency

Node.js `@langchain/langgraph` runs in a single-threaded event loop. The
`ToolNode` uses `Promise.all` for parallel tool calls, but Node.js's cooperative
concurrency model means no two promise callbacks execute simultaneously. Reading
from `config.configurable` inside `func` is safe: the `config` object is passed
as an argument (not a global), so it is already scoped to the invocation. There
is no shared mutable state to worry about if you use argument injection.

---

## 3. `RunnableConfig.configurable` Access from Inside a Tool

### 3.1 The official pattern

LangChain JS supports reading `config.configurable` from inside a tool function.
The pattern for `DynamicStructuredTool`:

```typescript
import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';

export function createAgtGrepTool(cfg: AgentConfig): DynamicStructuredTool {
  return new DynamicStructuredTool({
    name: 'agt_grep',
    description: '...',
    schema: grepSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      // Read per-call context from configurable:
      const workingDirectory =
        (config?.configurable?.workingDirectory as string | undefined)
        ?? cfg.fileEdit.root;  // fallback to static cfg
      // Build ToolContext from live configurable values:
      const toolCtx: ToolContext = {
        cwd: workingDirectory,
        permissions: cliAgentPermissionPolicy(cfg),
        signal: config?.signal,
      };
      const result = await grepTool.execute(input, toolCtx);
      // ...
    },
  });
}
```

The caller (in `run.ts`) injects the per-session values at invocation time:

```typescript
// In streamOneShot / runOneShot / wherever graph.invoke/streamEvents is called:
const streamConfig = {
  configurable: {
    thread_id: threadId,
    workingDirectory: cfg.fileEdit.root,  // or a per-session override
    sessionId,
  },
  version: 'v2',
  recursionLimit: maxSteps * 2,
};
agentGraph.graph.streamEvents(state, streamConfig);
```

### 3.2 What can be injected via configurable

`configurable` is a plain `Record<string, any>`. Anything that is serializable
or can be re-constructed each call can go there. For the `agent-tools`
`ToolContext`, the relevant fields are:

| `ToolContext` field | Source for `configurable` | Notes |
|---|---|---|
| `cwd` | `workingDirectory` key | Already in cli-agent: `cfg.fileEdit.root`; can be overridden per-request |
| `permissions` | Not injected — constructed inside `func` from `cfg` | `PermissionPolicy` is a stable object per `cfg`; no per-turn variation needed |
| `signal` | `config.signal` (top-level on `RunnableConfig`) | LangGraph propagates the `AbortSignal` from `streamConfig.signal` |
| `session` (todo store) | Per-session `SessionStore` object | See §4 below |

### 3.3 The JS/TS gap vs Python

As of April 2026, LangGraph JS's `ToolNode` **does** forward `RunnableConfig`
to `tool.invoke()` (confirmed from source). However, the `ToolRuntime.state`
injection (where the tool receives the full graph state) is documented but
behavior in JS may differ from Python. For cli-agent's use case (injecting
`workingDirectory`, `sessionId`, `AbortSignal`) only `config.configurable` is
needed, and that path is confirmed working.

---

## 4. Per-Session State (`SessionStore` for todo tools)

The `agent-tools` `SessionStore` (used by `todoread`/`todowrite`) must be shared
within a session but isolated across sessions. The recommended pattern:

```typescript
// In buildToolCatalog or the per-session graph builder:
const sessionStore: SessionStore = { todos: null };
// Pass it via configurable at every graph.invoke call:
const invokeConfig = {
  configurable: {
    thread_id: threadId,
    workingDirectory: cfg.fileEdit.root,
    agentToolsSession: sessionStore,  // same object for all turns in this session
  },
};
```

Inside the todo tool wrappers:

```typescript
func: async (input, _runManager, config?: RunnableConfig) => {
  const session = config?.configurable?.agentToolsSession as SessionStore;
  // session is the same object across turns; mutations to session.todos persist
};
```

This works because `MemorySaver` checkpoints message history only, not the
`configurable` object. The `sessionStore` is held in the Node.js process heap
and passed by reference on every `graph.invoke` call — there is no
serialization of the `SessionStore` itself.

**Caveat**: if cli-agent is used with a durable checkpointer
(`PostgresSaver`) and the process restarts between turns, the in-memory
`SessionStore` is lost. For the initial integration, this is acceptable since
`agt_todo_read`/`agt_todo_write` are default-off. When they are enabled, the
documentation should note that todo state is session-scoped and does not survive
process restarts.

---

## 5. The Four Options — Evaluation and Verdict

### Option A: Closure over a per-session AsyncLocalStorage / module-level mutable holder

**Shape**: a module-level `Map<threadId, ToolContext>` is populated before each
`graph.invoke` call; tool `func` reads from it.

**Pros**: simple to write.

**Cons**: requires careful bookkeeping to avoid leaking sessions; requires
explicit cleanup on session end; dangerous if tool calls execute concurrently
across threads (rare in Node.js, but possible if you fan out to multiple `graph.invoke`
calls). The mutable shared state is an anti-pattern when `config.configurable`
provides a clean, argument-scoped alternative.

**Verdict**: Reject. Higher complexity and risk than Option B for no benefit.

### Option B: `RunnableConfig.configurable`-based injection (recommended)

**Shape**: per-call values (`workingDirectory`, `sessionId`, `agentToolsSession`)
are placed in `configurable` when calling `graph.invoke`/`streamEvents`. Tool
`func` reads them from the third argument.

**Pros**:
- No mutable global state.
- The `config` is argument-scoped — naturally isolated per invocation.
- `AbortSignal` is already on `RunnableConfig.signal`; no separate channel needed.
- Architecturally consistent with how `thread_id` is already injected.
- No changes to `createReactAgent` or the graph compile path.
- Zero checkpointer impact (checkpointer does not inspect `configurable`).

**Cons**: requires adding `workingDirectory` and `agentToolsSession` to the
`configurable` dict that is already passed in `graph.ts`'s `streamConfig` /
`invokeOptions`. Minor effort.

**Verdict**: Accept. This is the recommended pattern.

### Option C: One tool factory per session (rebuild catalog per turn)

**Shape**: `buildToolCatalog` is called on every turn with a fresh `ToolContext`,
and `buildAgentGraph` is called again with the new tools.

**Cons**:
- Requires recompiling the LangGraph `StateGraph` on every turn.
- `llm.bindTools(tools)` is called every turn (expensive).
- Breaks the `MemorySaver` continuity if the thread ID is reused, because the
  new graph instance has a fresh `MemorySaver` that doesn't know the prior turns.
- Completely contradicts cli-agent's existing architecture (single
  `buildAgentGraph` call per session).

**Verdict**: Reject.

### Option D: `InjectedState` / `ToolRuntime.state`

**Shape**: the graph state carries `workingDirectory` in a custom state
annotation; the tool reads `runtime.state.workingDirectory` via `ToolRuntime`.

**Cons**: `ToolRuntime.state` injection is documented but JS behavior is
inconsistent with Python (open issue as of April 2026). Requires a custom
`StateGraph` instead of `createReactAgent`, since adding custom state fields to
`createReactAgent`'s `MessagesAnnotation` is non-trivial. Overkill for values
that are stable within a session.

**Verdict**: Reject for this scope.

---

## 6. Checkpointer Consistency Under Tool Identity Changes

This is a concern raised specifically in the investigation brief. The answer is:

**The checkpointer does not care about tool object identity.**

LangGraph's checkpointer (`MemorySaver`, `PostgresSaver`, etc.) saves:
- The messages channel (the `AIMessage` and `ToolMessage` sequence).
- Other state channel values.

`AIMessage.tool_calls` entries contain `{ name: string, args: unknown, id: string }`.
The `name` is a string — not a reference to the tool object. When the graph
resumes a thread, `ToolNode` dispatches by matching `call.name` against
`tool.name` in the tools array. As long as the tool name string is stable, the
graph can resume correctly even if the tool function or its closure has changed.

**Consequence for cli-agent**: if for any reason tool *instances* are rebuilt
between turns (which Option C does and which we reject), the checkpointer
continues to work correctly as long as tool names are unchanged. The problem
with Option C is not checkpointer corruption — it is graph recompilation cost
and lost in-memory state, not checkpoint state. This distinction matters for the
plan: there is no hidden checkpointer fragility here.

---

## 7. Concrete Recommendation for cli-agent

### 7.1 Wiring shape (TypeScript pseudocode)

**Step 1**: In `buildToolCatalog` (`registry.ts`), each agent-tools wrapper
reads static config from `cfg` at construction time (as today's tools do) but
defers dynamic, per-call values to `config.configurable`:

```typescript
// src/agent/tools/agent-tools/grep-tool.ts

import { DynamicStructuredTool } from '@langchain/core/tools';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { AgentConfig } from '../../../config/agent-config.js';
import type { ToolContext } from '../../../agent-tools-vendored/types.js';
import { grepTool } from '../../../agent-tools-vendored/tools/grep/index.js';
import { cliAgentPermissionPolicy } from './permission-policy.js';
import { handleToolError } from '../types.js';
import { grepSchema } from './schemas.js';

export function createAgtGrepTool(cfg: AgentConfig): DynamicStructuredTool {
  // Static, per-session context built once:
  const policy = cliAgentPermissionPolicy(cfg);
  const staticCwd = cfg.fileEdit.root;

  return new DynamicStructuredTool({
    name: 'agt_grep',
    description: grepTool.description,
    schema: grepSchema,
    func: async (input, _runManager, config?: RunnableConfig) => {
      // Dynamic, per-call context from configurable:
      const cwd =
        (config?.configurable?.['workingDirectory'] as string | undefined)
        ?? staticCwd;
      const signal = config?.signal;

      const toolCtx: ToolContext = {
        cwd,
        permissions: policy,
        signal,
        limits: {
          maxOutputBytes: cfg.perToolBudgetBytes,
        },
      };

      try {
        const result = await grepTool.execute(input, toolCtx);
        if (result.ok) return result.output;
        return `[agt_grep error] ${result.error.name}: ${result.error.message}`;
      } catch (err) {
        return handleToolError(err);
      }
    },
  });
}
```

**Step 2**: Pass per-session values in the `configurable` block when the graph
is invoked. In `graph.ts`, the two invocation sites already build a
`streamConfig` / `invokeOptions` dict. Extend them:

```typescript
// src/agent/graph.ts — runOneShot (existing invokeOptions block)
const invokeOptions: Record<string, any> = {
  configurable: {
    thread_id: threadId,
    workingDirectory: cfg.fileEdit.root,  // NEW: picked up by agt_* tools
  },
  recursionLimit: maxSteps * 2,
};
```

```typescript
// src/agent/graph.ts — streamOneShot (existing streamConfig block)
const streamConfig: Record<string, any> = {
  configurable: {
    thread_id: threadId,
    workingDirectory: cfg.fileEdit.root,  // NEW
  },
  version: 'v2',
  recursionLimit: maxSteps * 2,
};
```

**Step 3**: For `todoread`/`todowrite` (default-off), add session store to
`AgentGraph` and pass it through:

```typescript
// src/agent/graph.ts
export interface AgentGraph {
  readonly graph: AnyGraph;
  readonly checkpointer: MemorySaver;
  readonly todoSession: SessionStore;  // NEW, only used when todo tools enabled
}

// In buildAgentGraph:
const todoSession: SessionStore = { todos: null };
return { graph, checkpointer, todoSession };

// In runOneShot invokeOptions.configurable:
configurable: {
  thread_id: threadId,
  workingDirectory: cfg.fileEdit.root,
  agentToolsSession: agentGraph.todoSession,  // NEW, only if todo tools enabled
},
```

### 7.2 What does NOT need to change

- `buildToolCatalog` call sites in `run.ts` — no change; tools are built once.
- `buildAgentGraph` call sites — minor: pass `cfg` so it can populate
  `workingDirectory` in the returned `AgentGraph`, or just pass the config
  in each `runOneShot`/`streamOneShot` call.
- `MemorySaver` / checkpointer — zero changes needed.
- Tool names — the `agt_*` prefix is stable; checkpointer consistency is maintained.

### 7.3 Minimal surface change

The diff is two lines per invocation site (adding `workingDirectory` to
`configurable`) plus the per-tool wrapper reading from `config?.configurable`.
The upstream adapter (`toLangChainTool`) closes over a static context — the
cli-agent integration does NOT use `toLangChainTool` for this reason. Instead,
cli-agent writes its own `DynamicStructuredTool` wrappers that read from
`configurable`, matching the pattern already established for all 11 existing
standard tools.

---

## 8. Assumptions and Scope

| Assumption | Confidence | Impact if Wrong |
|---|---|---|
| `ToolNode.runTool` passes `config` to `tool.invoke()` | HIGH — verified from source | The configurable approach would not work; would need AsyncLocalStorage fallback |
| `DynamicStructuredTool.func` receives `config` as third arg | HIGH — confirmed from API ref + search results | Same as above |
| Checkpointer does not serialize tool functions | HIGH — documented: state must be JSON-serializable; functions are not | Option C would be required; it is painful but technically possible |
| LangGraph JS `ToolNode` propagates `configurable` correctly in current stable release | HIGH — confirmed from source; consistent with issue #1199 being about a *past* limitation | Config would need to be read via AsyncLocalStorage |
| `SessionStore` for todo tools can be held in process heap | MEDIUM — acceptable for default-off tools | With PostgresSaver + process restarts, todo state lost between restarts |
| `createReactAgent` from `@langchain/langgraph/prebuilt` is the correct entrypoint | HIGH — cli-agent already uses it; no reason to switch | N/A |
| cli-agent is single-process (no worker threads sharing tool instances) | HIGH — Node.js CLI tool | With worker threads, mutable shared state would be dangerous; configurable is still safe |

### Uncertainties and Gaps

- **`ToolRuntime.state` in JS**: as of April 2026, a LangChain forum post confirms that `ToolRuntime.state` is not populated by `ToolNode` in JS the same way Python does. For cli-agent's use case this gap is irrelevant — `config.configurable` is sufficient.
- **`tool()` factory vs `DynamicStructuredTool`**: the upstream adapter uses `tool()` (which exposes `RunnableConfig` as the second function argument, not the third). cli-agent's own wrappers use `DynamicStructuredTool` (third argument). Both work; the integration must use one consistently. The recommendation is `DynamicStructuredTool` to match existing code.
- **`PostgresSaver` + todo session state**: the durable-checkpointer + in-memory session store combination is only a concern if todo tools are enabled in a long-running server context. The initial integration (todo tools default-off) is not affected.

### Clarifying Questions for Follow-up

1. Should `workingDirectory` in `configurable` allow per-request overrides (e.g., the user passes a `--cwd` flag that differs from `cfg.fileEdit.root`)? If yes, `graph.ts`'s `invokeOptions` building needs to accept it from outside.
2. Are `agt_todo_read`/`agt_todo_write` in scope for the initial plan, or should they be deferred until a durable session-store mechanism is designed?
3. Should the `cliAgentPermissionPolicy` factory be constructed once in `buildToolCatalog` and shared across all tool wrappers, or independently per tool? (Shared is fine — it is read-only and stateless.)

---

## References

| # | Source | URL | What was learned |
|---|---|---|---|
| 1 | LangGraph JS source — `tool_node.ts` | https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-core/src/prebuilt/tool_node.ts | `ToolNode.runTool` calls `tool.invoke(callArgs, config)` — config is propagated to every tool |
| 2 | upstream `agent-tools/src/types.ts` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/types.ts | Full `ToolContext` shape: `cwd`, `session`, `signal`, `permissions`, `limits` |
| 3 | upstream `agent-tools/src/adapters/langchain.ts` | https://raw.githubusercontent.com/BikS2013/agent-tools/main/src/adapters/langchain.ts | Adapter closes over `context` at construction time; does NOT re-read from config; cli-agent must write its own wrappers |
| 4 | `DynamicStructuredTool` API reference | https://reference.langchain.com/javascript/langchain-core/tools/DynamicStructuredTool | `func` signature: `(input, runManager?, config?: RunnableConfig)` — config is 3rd arg |
| 5 | LangChain JS how-to (tool_configure) | https://js.langchain.com/docs/how_to/tool_configure/ | Official how-to page on accessing RunnableConfig from a tool |
| 6 | LangChain JS how-to (configuration) | https://langchain-ai.github.io/langgraphjs/how-tos/configuration/ | Graph-level configurable field usage |
| 7 | LangGraph.js GitHub issue #1199 | https://github.com/langchain-ai/langgraphjs/issues/1199 | History of config propagation concerns; confirms pattern is now standard |
| 8 | LangGraph forum — ToolRuntime JS gap | https://forum.langchain.com/t/discussion-about-why-langgraph-js-toolnode-doesn-t-inject-toolruntime-state-like-python-does-and-what-the-correct-workaround-or-intended-design-pattern-is/3483 | JS `ToolRuntime.state` not populated; `config.configurable` is the recommended workaround |
| 9 | LangGraph JS guide — react agent | https://langgraphjs.guide/agents/react-agent/ | Graph compiled once; tools bound at compile time; tool catalog stable across turns |
| 10 | LangGraph JS guide — tool calling | https://langgraphjs.guide/agents/tool-calling/ | ToolNode dispatches by tool name; `ToolNode` handles parallel tool calls |
| 11 | LangGraph JS guide — persistence | https://langgraphjs.guide/persistence/ | Checkpointer saves message state, not tool functions; `configurable` not checkpointed |
| 12 | Web search synthesis — checkpointer state schema | multiple | `AIMessage.tool_calls` stores `name` + `args` strings, not callable references |
| 13 | cli-agent `src/agent/graph.ts` | local | `streamConfig` and `invokeOptions` already built per-call; extension point is there |
| 14 | cli-agent `src/agent/tools/registry.ts` | local | `buildToolCatalog` builds tools once with closed-over `cfg`; pattern to follow |
| 15 | cli-agent `src/agent/tools/file/read-tool.ts` | local | Canonical example of `DynamicStructuredTool` factory pattern to replicate for agt_* tools |
| 16 | `RunnableConfig` interface reference | https://reference.langchain.com/javascript/langchain-core/runnables/RunnableConfig | `configurable: Record<string, any>`, `signal: AbortSignal` — both relevant |
| 17 | `ToolRuntime` type reference | https://reference.langchain.com/javascript/types/_langchain_core.tools.ToolRuntime.html | Advanced injection type; covers `state`, `store`, `toolCallId` — not needed for cli-agent's scope |

### Recommended for Deep Reading

- **Source 1** (`tool_node.ts`): The 60-line `runTool` method is the authoritative proof that `config` is forwarded. Read before implementing to verify against the version actually installed in the project.
- **Source 3** (upstream adapter): The comment "The optional `ToolContext` is captured at construction time. To rotate contexts, build a fresh adapter" is the upstream's own documentation of why cli-agent cannot use `toLangChainTool` directly for per-turn context — it must write its own wrappers.
- **Source 8** (forum thread): Confirms the JS/Python gap on `ToolRuntime.state` and validates that `config.configurable` is the current recommended workaround in LangGraph JS.
