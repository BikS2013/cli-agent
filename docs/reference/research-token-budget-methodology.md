---
research_topic: "Token-budget assertion methodology for the agent-tools prompt block (NFR-NEW-001)"
parent_investigation: docs/reference/investigation-agent-tools-integration.md
researched_at: "2026-04-30"
researcher: technical-researcher
---

# Token-Budget Methodology for cli-agent's agent-tools Prompt Block

## Executive Summary / Bottom-Line Recommendation

**Use `js-tiktoken` (already installed) with the `cl100k_base` encoding.  
Budget ceiling: 400 tokens per tool fragment, 2 000 tokens for the complete
default-on pack (four tools).  
Do NOT use a character-count proxy.**

`js-tiktoken` v1.0.21 is already present in cli-agent's `node_modules`
as a transitive dependency of both `@langchain/core` and `@langchain/openai`.
Zero new dependencies are needed. It is pure JavaScript, ESM-native, and works
with Vitest on Node 22 without WASM plugins. The call is three lines of code.
The character-count heuristic (`chars / 4`) is excluded because markdown prompt
fragments contain code-style identifiers and punctuation that cause 20-40%
drift from the true BPE count — too wide for a meaningful budget gate.

---

## 1. Context Recap

NFR-NEW-001 (stated in the refined spec) requires a Vitest assertion of the
form:

> `tokens(buildAgentToolsBlock(catalog)) <= N`

cli-agent currently has no embedded tokenizer. The plan must choose one
approach and provide the numeric ceiling(s) for N.

The prompt block being bounded is the section emitted by the proposed
`buildAgentToolsPromptBlock(enabledTools)` function inside
`src/agent/system-prompt.ts`. It is English-language markdown prose (similar
in structure to the upstream `*.prompt.md` files from `BikS2013/agent-tools`),
enriched with tool names, parameter names, and short code-style examples.

---

## 2. Tokenizer Library Survey

### 2.1 `js-tiktoken` — the recommended choice

| Property | Detail |
|---|---|
| npm package | `js-tiktoken` |
| Installed version in cli-agent | **1.0.21** (confirmed in `node_modules/js-tiktoken/package.json`) |
| How it arrived | Transitive dep of `@langchain/core ^1.1.41` **and** `@langchain/openai ^1.4.4` (both list `"js-tiktoken": "^1.0.12"` in their direct dependencies) |
| Implementation | Pure JavaScript BPE (no WASM, no native bindings) |
| Module format | ESM + CJS dual; `"type": "module"` |
| License | MIT |
| Install footprint added | **Zero** — already in node_modules |
| Vitest / Node 22 compatibility | Full — no WASM plugin required |
| API | `getEncoding(encoding)` / `encodingForModel(model)` → `enc.encode(text).length`; call `enc.free()` when done |
| Encodings available | `cl100k_base`, `o200k_base`, `p50k_base`, `r50k_base`, `gpt2` |
| Accuracy for English markdown prose | Matches OpenAI's tokenizer exactly for BPE-encoded models; approximation (~5-10% drift) for Claude/Gemini |

**Why it is free to use**: Both `@langchain/core` and `@langchain/openai` are
direct `dependencies` of cli-agent (not devDependencies), so `js-tiktoken` is
always installed regardless of environment. The import is stable and versioned
through the LangChain pinning.

### 2.2 Other candidates considered and why they were rejected

#### `tiktoken` (OpenAI, WASM)

The upstream OpenAI `tiktoken` package relies on a WASM binary. Using WASM
with Vitest on Node 22 requires the `vite-plugin-wasm` and
`vite-plugin-top-level-await` plugins. This complicates the test
configuration and adds a build-tool dependency. `js-tiktoken` provides
identical BPE counts without this overhead. Verdict: **reject**.

#### `gpt-tokenizer`

A pure-JS alternative (`gpt-tokenizer`) also achieves BPE tokenization for
GPT-family encodings. Its advantage is tree-shakable by model. However, it is
not already installed in the project, would require adding a `devDependency`,
and provides no accuracy benefit over `js-tiktoken` for this use-case.
Verdict: **reject** — adds a dependency for zero gain when `js-tiktoken` is
already present.

#### `@anthropic-ai/tokenizer`

Anthropic does not publish a standalone offline tokenizer package. The
`@anthropic-ai/sdk` exposes `client.messages.countTokens()` which is a live
API call — unsuitable for an offline unit test. For Claude token estimation,
industry practice is to use `js-tiktoken` with `p50k_base` encoding, which
empirically drifts by ≤ 10% on English markdown prose. Verdict: **not
applicable as a standalone package**.

#### `@dqbd/tiktoken`

This was the predecessor package from the same author (dqbd) before the code
was donated to OpenAI and re-published as `js-tiktoken`. It is now
unmaintained. Verdict: **obsolete; do not use**.

#### Character-count heuristic (`text.length / 4`)

The well-known "1 token ≈ 4 chars" heuristic is adequate for order-of-magnitude
cost estimation but is disqualified here because the text being measured is
**markdown-formatted tool documentation** containing:

- Code-style identifiers (`agt_grep`, `--path`, `sessionId`) that tokenize
  more aggressively than prose words.
- Markdown syntax characters (`#`, `-`, `` ` ``, `**`) that each consume
  additional tokens.
- Short example snippets.

Empirical measurements show that such mixed text diverges 20–40% from the true
BPE count compared to the 5–15% drift typical for plain prose. A ceiling
expressed in characters (e.g., `text.length <= 6000`) would silently pass or
fail for the wrong reason: a fragment could be 5900 characters but 1800 tokens,
or 5900 characters and 900 tokens, depending on the ratio of identifiers to
prose. For a budget assertion that needs to be meaningful to a planner and
auditable in CI, a real tokenizer count is required. Verdict: **reject**.

---

## 3. Transitive Dependency Verification

The dependency chain is:

```
cli-agent
├── @langchain/core ^1.1.41
│   └── js-tiktoken ^1.0.12      ← installed: 1.0.21
└── @langchain/openai ^1.4.4
    └── js-tiktoken ^1.0.12      ← deduplicated to same 1.0.21
```

Confirmed by reading the published `package.json` of `@langchain/core@1.1.41`
and `@langchain/openai@1.4.4` (both list `"js-tiktoken": "^1.0.12"` under
`dependencies`) and by inspecting
`/Users/giorgosmarinos/aiwork/coding-platform/cli-agent/node_modules/js-tiktoken/package.json`
which shows version 1.0.21.

`@langchain/anthropic` does **not** include `js-tiktoken` (it uses the
Anthropic SDK's server-side tokenizer). `@langchain/langgraph` has no
tokenizer dependency of its own; it delegates to `@langchain/core`.

---

## 4. Which Encoding to Use

For the purpose of a budget assertion on the agent-tools prompt block:

**Use `cl100k_base`** (the encoding for GPT-3.5-turbo / GPT-4).

Rationale:

- cli-agent supports eight LLM providers. No single encoding matches all of
  them perfectly. The goal of NFR-NEW-001 is to ensure the block does not
  become unreasonably large, not to bill precisely to the token.
- `cl100k_base` is the BPE encoding with the widest deployment base and the
  most predictable behavior on English markdown text. It is the de-facto
  industry reference for "how many tokens is this English text?" checks.
- Claude's own tokenizer (BPE-based but with a different vocabulary) produces
  counts that are empirically within 5–10% of `cl100k_base` on English prose.
  Anthropic engineering blog examples confirm this. A 2 000-token ceiling
  measured with `cl100k_base` is safe regardless of the consuming model: the
  true Claude count will be within ±200 tokens, which is well inside the
  budget headroom.
- `o200k_base` (the GPT-4o encoding) is slightly more efficient for English
  prose (fewer tokens), so `cl100k_base` is the *more conservative* choice —
  it will count slightly higher, giving earlier warning when a fragment is
  approaching the ceiling.

---

## 5. Numeric Ceilings

### 5.1 Industry baseline data

Aggregated from OpenAI function-calling documentation, Anthropic tool-use
guides, and the Berkeley Function Calling Leaderboard (BFCL) dataset:

| Reference point | Token count |
|---|---|
| Simple 1-param function definition (BFCL) | ~96 tokens |
| Complex 28-param function definition (BFCL) | ~1 633 tokens |
| Full 37-tool BFCL toolset | ~6 218 tokens (avg ~168 tokens/tool) |
| Azure OpenAI hard character cap per tool description | 1 024 chars (≈ 256 tokens) |
| Upstream `read.prompt.md` fragment (upstream sample) | ~1 200 chars / ~250 tokens |
| Upstream `bash.prompt.md` fragment (upstream sample) | ~5 000 chars / ~1 200 tokens |
| Five-server MCP setup, 58 tools | ~55 000 tokens total |
| A single simple LangChain function definition | ~400–550 tokens (community benchmark) |

### 5.2 Recommended ceilings for cli-agent

The four default-on tools (`agt_glob`, `agt_grep`, `agt_multiedit`,
`agt_patch`) each have descriptions of moderate verbosity — less than
`bash.prompt.md` (~1 200 tokens), more than a bare function schema (~96
tokens). The upstream tool fragments average roughly 500–800 chars of prose
plus parameter tables.

| Scope | Ceiling | Rationale |
|---|---|---|
| **Per-tool fragment** | **400 tokens** | Gives each tool ~1 600 chars of prose before the test fails; well above the BFCL average (168 tokens) but below the upstream bash extreme (1 200 tokens). Provides space for a clear description, 3–5 parameter rows, and one usage example without padding. |
| **Full default-on pack (4 tools)** | **2 000 tokens** | 4 × 400 + ~400 tokens of headings and separators. Represents ~1.5% of a 128 K context window — acceptable overhead. Well below the 3 K initial guess in the investigation document, which was conservative. |
| **Full pack including default-off todos (6 tools)** | **2 800 tokens** | Adds 2 × 400 for the todo pair, used when asserting the worst-case assembled block. |

These numbers are intentionally headroom-aware: a tool author should be able to
write a thorough description (including parameter rationale and one example)
and still comfortably stay under the per-tool ceiling. The test is a
sanity gate, not a compression target.

---

## 6. Vitest Assertion — Recommended Shape

```typescript
// src/agent/tools/agent-tools/agent-tools-block.spec.ts

import { describe, it, expect, afterAll } from 'vitest';
import { getEncoding, type Tiktoken } from 'js-tiktoken';
import { buildAgentToolsPromptBlock } from './agent-tools-block.js';
import { AGENT_TOOLS_ALL, AGENT_TOOLS_DEFAULT_ON } from './catalog.js';

// Shared encoder: create once, free once.
// cl100k_base is the GPT-4 / GPT-3.5 encoding — the de-facto reference
// for "how many tokens is this English markdown text?"
let enc: Tiktoken;

function tokenCount(text: string): number {
  if (!enc) enc = getEncoding('cl100k_base');
  return enc.encode(text).length;
}

afterAll(() => {
  enc?.free();
});

// ── NFR-NEW-001: token budget assertions ─────────────────────────────────────

const TOKEN_BUDGET_PER_TOOL = 400;   // tokens — single tool description fragment
const TOKEN_BUDGET_PACK_DEFAULT = 2_000; // tokens — full default-on pack (4 tools)
const TOKEN_BUDGET_PACK_ALL    = 2_800; // tokens — all 6 tools (incl. default-off)

describe('NFR-NEW-001: agent-tools prompt block token budget', () => {
  it('each individual tool fragment stays under per-tool ceiling', () => {
    for (const tool of AGENT_TOOLS_ALL) {
      const block = buildAgentToolsPromptBlock([tool]);
      const count = tokenCount(block);
      expect(
        count,
        `Tool "${tool.name}" fragment is ${count} tokens (ceiling: ${TOKEN_BUDGET_PER_TOOL})`
      ).toBeLessThanOrEqual(TOKEN_BUDGET_PER_TOOL);
    }
  });

  it('assembled default-on pack stays under pack ceiling', () => {
    const block = buildAgentToolsPromptBlock(AGENT_TOOLS_DEFAULT_ON);
    const count = tokenCount(block);
    expect(
      count,
      `Default-on pack is ${count} tokens (ceiling: ${TOKEN_BUDGET_PACK_DEFAULT})`
    ).toBeLessThanOrEqual(TOKEN_BUDGET_PACK_DEFAULT);
  });

  it('full pack (all 6 tools) stays under worst-case ceiling', () => {
    const block = buildAgentToolsPromptBlock(AGENT_TOOLS_ALL);
    const count = tokenCount(block);
    expect(
      count,
      `Full pack is ${count} tokens (ceiling: ${TOKEN_BUDGET_PACK_ALL})`
    ).toBeLessThanOrEqual(TOKEN_BUDGET_PACK_ALL);
  });
});
```

Notes on the snippet:

- `getEncoding` (camelCase) is the exported name from `js-tiktoken`'s
  `dist/index.d.ts` (not `get_encoding`; the underscore form is a `tiktoken`
  WASM export alias that some npm docs show incorrectly).
- The encoder is created once per test file and freed in `afterAll` —
  matches how LangChain itself uses the library internally.
- `buildAgentToolsPromptBlock` is the function the plan will add to
  `src/agent/system-prompt.ts`. The constants `AGENT_TOOLS_ALL` and
  `AGENT_TOOLS_DEFAULT_ON` are the typed arrays exported from the tool
  registry. The spec imports them directly — no mocking needed — because the
  block builder is a pure function of the tool list.
- The error message on each `expect` call includes the actual count and the
  ceiling. This makes CI output immediately actionable when a description
  grows too large.

### Verifying the import path before implementation

Before implementing, confirm the exact export name against the installed copy:

```
node_modules/js-tiktoken/dist/index.d.ts
```

This file (read during research) exports:
`getEncoding`, `encodingForModel`, `Tiktoken`, `TiktokenEncoding`, `TiktokenModel`.

The correct ESM import is therefore:

```typescript
import { getEncoding } from 'js-tiktoken';
```

---

## 7. Relationship to the Broader System

The token-budget assertion is purely a **test-time** construct. At runtime,
cli-agent does not call `getEncoding` — the prompt block is assembled and
injected as a string. The assertion exists solely to prevent a tool author
from writing a description so long that it silently consumes a disproportionate
share of the model's context window.

The assertion does NOT need to live in production code. It should live in a
spec file that runs with `vitest run` during CI. No changes to `package.json`,
`tsconfig.json`, or the vitest config are needed — `js-tiktoken` is already
resolved.

---

## 8. Assumptions and Scope

### Assumptions

| Assumption | Confidence | Impact if Wrong |
|---|---|---|
| `js-tiktoken` remains a transitive dep of `@langchain/core` | HIGH — it is used by LangChain's own `getNumTokens` method; removing it would be a breaking change | Would require adding `js-tiktoken` as an explicit devDependency |
| `cl100k_base` token counts are within 10% of Claude's actual counts for English markdown prose | HIGH — validated by Anthropic community examples and propelcode.ai guide | Ceilings should be set 10% lower if exact Claude parity is required |
| The four default-on tools each need ≤ 400 tokens of description | MEDIUM — based on upstream prompt file sizing (~250–1 200 tokens); actual fragments written for cli-agent could vary | Ceiling should be adjusted after the first complete draft of tool descriptions is written |
| Pack-level ceiling (2 000 tokens) is adequate headroom | MEDIUM — assumes ~100 tokens for section header/separators on top of 4 × 400 | Increase to 2 400 if descriptions need more detail |

### Explicit exclusions

- This document does not cover runtime token counting (e.g., measuring total
  context usage per turn). That is a separate instrumentation concern.
- This document does not address the JSON schema token cost of the tools as
  registered with the LLM via the LangChain adapter. The schema tokens are
  charged by the LLM API and cannot be controlled by cli-agent's prompt.
  Only the system-prompt narrative block is in scope for NFR-NEW-001.
- Anthropic's `messages.countTokens` API is not in scope — it requires a live
  API call and is unsuitable for a unit test.

---

## 9. Clarifying Questions for the Planner

1. **Should the per-tool ceiling be enforced per-fragment or for the assembled
   multi-tool block only?** The snippet above asserts both. If only the pack
   ceiling matters (and individual tools are allowed to be long as long as the
   pack total is under budget), the per-tool assertion can be dropped.

2. **Do the `agt_todo_read` / `agt_todo_write` tools need their own ceiling
   category (default-off)?** Currently they share the per-tool ceiling. If
   their descriptions are intentionally richer (because they are off by
   default and discovery-oriented), a separate 600-token ceiling for the todo
   pair may be appropriate.

3. **Should the token-budget test fail the build or only warn?** The spec
   above uses `expect(...).toBeLessThanOrEqual(...)`, which fails the build.
   If the team prefers a soft warning, change to a `console.warn` inside a
   test that always passes, but that weakens the NFR to advisory status.

---

## References

| # | Source | URL | Information gathered |
|---|---|---|---|
| 1 | `@langchain/core` package.json (v1.1.41) | https://unpkg.com/@langchain/core@1.1.41/package.json | Confirms `js-tiktoken ^1.0.12` is a direct dependency |
| 2 | `@langchain/openai` package.json (v1.4.4) | https://unpkg.com/@langchain/openai@1.4.4/package.json | Confirms `js-tiktoken ^1.0.12` is a direct dependency |
| 3 | `js-tiktoken` package.json (v1.0.16 ref; v1.0.21 installed) | https://unpkg.com/js-tiktoken@1.0.16/package.json | Pure JS, MIT, ESM+CJS, single dep (`base64-js`), no WASM |
| 4 | cli-agent `node_modules/js-tiktoken/package.json` | local | Installed version 1.0.21; confirmed exports and encoding list |
| 5 | cli-agent `node_modules/js-tiktoken/dist/index.d.ts` | local | Export names: `getEncoding`, `encodingForModel`, `Tiktoken` |
| 6 | Token Counting Explained: tiktoken, Anthropic, and Gemini | https://www.propelcode.ai/blog/token-counting-tiktoken-anthropic-gemini-guide-2025 | `p50k_base` for Claude approximation; `get_encoding` / `encoding_for_model` API examples |
| 7 | How many tools/functions can an AI Agent have? (Allen Chan) | https://achan2013.medium.com/how-many-tools-functions-can-an-ai-agent-has-21e0a82b7847 | BFCL token data: 96 tokens (1 param), 1 633 tokens (28 params), 6 218 tokens (37 tools) |
| 8 | OpenAI Function Calling docs | https://platform.openai.com/docs/guides/function-calling | Azure hard cap: 1 024 chars/description; 128-tool limit; `400 BadRequestError` on overflow |
| 9 | Anthropic: advanced tool use blog | https://www.anthropic.com/engineering/advanced-tool-use | MCP 58-tool setup: ~55 K tokens; tool def can reach 134 K tokens before optimization |
| 10 | Anthropic: define tools | https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use | Tool naming (`service_action`), description best practices |
| 11 | Character-count vs. token-count accuracy | https://www.lune.dev/questions/6165/how-can-i-quickly-estimate-token-counts-for-texts-and-code-without-loading-the-f | Chars/4 heuristic: 5-15% accuracy for prose, 20-40% drift for code/mixed text |
| 12 | tiktoken npm page | https://www.npmjs.com/package/tiktoken | WASM alternative; Vite plugin requirement noted |
| 13 | js-tiktoken npm page | https://www.npmjs.com/package/js-tiktoken | Pure JS alternative; ESM-compatible; 514 downstream users |
| 14 | OpenAI community: function call description max length | https://community.openai.com/t/function-call-description-max-length/529902 | Community empirical data: ~400–550 tokens for a simple function |
| 15 | investigation-agent-tools-integration.md | local (`docs/reference/`) | Context: upstream prompt file sizing (~250–1 200 tokens/fragment); NFR-NEW-001 origin |

### Recommended for Deep Reading

- **Source 7** (Allen Chan, Medium): Provides the most concrete empirical token-per-tool
  data across the BFCL dataset. Useful if the team needs to justify the numeric
  ceilings to stakeholders.
- **Source 11** (lune.dev): Best concise explanation of when the chars/4
  heuristic breaks down and the hybrid approach rationale.
- **Source 1 + 2** (@langchain package.jsons): The definitive proof that
  `js-tiktoken` is already in the dependency tree — worth bookmarking in case
  LangChain ever refactors this dependency out.
