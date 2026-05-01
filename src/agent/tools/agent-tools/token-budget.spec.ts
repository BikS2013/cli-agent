/**
 * NFR-NEW-001: token-budget assertions for the agent-tools prompt block.
 *
 * Uses `js-tiktoken` (already a transitive dep via @langchain/core) with the
 * `cl100k_base` encoding — the de-facto reference for "how many tokens is this
 * English markdown text?" Budget ceilings per the methodology document at
 * docs/reference/research-token-budget-methodology.md:
 *
 *   - Per individual tool fragment : 400 tokens
 *   - Default-on pack (4 tools)    : 2 000 tokens
 *   - Full pack    (6 tools)       : 2 800 tokens
 *
 * Categories: unit (each per-tool constant), regression (pack ceilings that
 * must not regress as descriptions are edited over time).
 */

import { describe, it, expect } from 'vitest';
import { getEncoding } from 'js-tiktoken';
import type { Tiktoken } from 'js-tiktoken';
import { buildAgentToolsPromptBlock } from './prompt-block.js';
import {
  AGT_GLOB_NAME,
  AGT_GLOB_DESCRIPTION,
  AGT_GREP_NAME,
  AGT_GREP_DESCRIPTION,
  AGT_MULTIEDIT_NAME,
  AGT_MULTIEDIT_DESCRIPTION,
  AGT_PATCH_NAME,
  AGT_PATCH_DESCRIPTION,
  AGT_TODO_READ_NAME,
  AGT_TODO_READ_DESCRIPTION,
  AGT_TODO_WRITE_NAME,
  AGT_TODO_WRITE_DESCRIPTION,
} from './index.js';
import type { AgentToolsCatalogMeta } from './group-builder.js';

// ---------------------------------------------------------------------------
// Shared encoder — created once per file.
// Note: js-tiktoken (pure-JS BPE port, not the WASM tiktoken package) does
// NOT have a free() method — no cleanup is necessary. Using cl100k_base
// (GPT-4 / GPT-3.5 BPE encoding): the de-facto reference for English
// markdown token-count checks across model families.
// ---------------------------------------------------------------------------

const enc: Tiktoken = getEncoding('cl100k_base');

function tokenCount(text: string): number {
  return enc.encode(text).length;
}

// ---------------------------------------------------------------------------
// Constants — mirrors docs/reference/research-token-budget-methodology.md §5
// ---------------------------------------------------------------------------

const TOKEN_BUDGET_PER_TOOL = 400;
const TOKEN_BUDGET_PACK_DEFAULT = 2_000; // 4 default-on tools + headings
const TOKEN_BUDGET_PACK_ALL = 2_800; // all 6 tools (incl. default-off todo pair)

// ---------------------------------------------------------------------------
// Helpers to build AgentToolsCatalogMeta without constructing actual tools.
// The prompt-block assembler is a pure function of AgentToolsCatalogMeta, so
// no DynamicStructuredTool instances are needed here.
// ---------------------------------------------------------------------------

function singleToolMeta(name: string, description: string): AgentToolsCatalogMeta {
  return {
    umbrellaEnabled: true,
    registered: [{ name, description }],
  };
}

/**
 * All six tools in the order the group-builder registers them
 * (glob → grep → multiedit → patch → todoRead → todoWrite).
 * Mirrors the default-on order: glob + grep + multiedit + patch first,
 * then the default-off todo pair.
 */
const ALL_TOOL_ENTRIES = [
  { name: AGT_GLOB_NAME, description: AGT_GLOB_DESCRIPTION },
  { name: AGT_GREP_NAME, description: AGT_GREP_DESCRIPTION },
  { name: AGT_MULTIEDIT_NAME, description: AGT_MULTIEDIT_DESCRIPTION },
  { name: AGT_PATCH_NAME, description: AGT_PATCH_DESCRIPTION },
  { name: AGT_TODO_READ_NAME, description: AGT_TODO_READ_DESCRIPTION },
  { name: AGT_TODO_WRITE_NAME, description: AGT_TODO_WRITE_DESCRIPTION },
];

/** Default-on pack: the four tools enabled when agentTools.enabled is true. */
const DEFAULT_ON_ENTRIES = ALL_TOOL_ENTRIES.slice(0, 4); // glob, grep, multiedit, patch

const ALL_TOOLS_META: AgentToolsCatalogMeta = {
  umbrellaEnabled: true,
  registered: ALL_TOOL_ENTRIES,
};

const DEFAULT_ON_META: AgentToolsCatalogMeta = {
  umbrellaEnabled: true,
  registered: DEFAULT_ON_ENTRIES,
};

const EMPTY_META: AgentToolsCatalogMeta = {
  umbrellaEnabled: false,
  registered: [],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NFR-NEW-001: individual tool DESCRIPTION constant token budget', () => {
  /**
   * Each of the six AGT_*_DESCRIPTION constants (the text handed to both
   * LangChain and the prompt-block assembler) must stay under the per-tool
   * ceiling. This catches description growth early, before it compounds
   * into a pack overage.
   */

  it('unit: AGT_GLOB_DESCRIPTION is within 400-token per-tool ceiling', () => {
    const count = tokenCount(AGT_GLOB_DESCRIPTION);
    expect(
      count,
      `AGT_GLOB_DESCRIPTION is ${count} tokens (ceiling: ${TOKEN_BUDGET_PER_TOOL})`,
    ).toBeLessThanOrEqual(TOKEN_BUDGET_PER_TOOL);
  });

  it('unit: AGT_GREP_DESCRIPTION is within 400-token per-tool ceiling', () => {
    const count = tokenCount(AGT_GREP_DESCRIPTION);
    expect(
      count,
      `AGT_GREP_DESCRIPTION is ${count} tokens (ceiling: ${TOKEN_BUDGET_PER_TOOL})`,
    ).toBeLessThanOrEqual(TOKEN_BUDGET_PER_TOOL);
  });

  it('unit: AGT_MULTIEDIT_DESCRIPTION is within 400-token per-tool ceiling', () => {
    const count = tokenCount(AGT_MULTIEDIT_DESCRIPTION);
    expect(
      count,
      `AGT_MULTIEDIT_DESCRIPTION is ${count} tokens (ceiling: ${TOKEN_BUDGET_PER_TOOL})`,
    ).toBeLessThanOrEqual(TOKEN_BUDGET_PER_TOOL);
  });

  it('unit: AGT_PATCH_DESCRIPTION is within 400-token per-tool ceiling', () => {
    const count = tokenCount(AGT_PATCH_DESCRIPTION);
    expect(
      count,
      `AGT_PATCH_DESCRIPTION is ${count} tokens (ceiling: ${TOKEN_BUDGET_PER_TOOL})`,
    ).toBeLessThanOrEqual(TOKEN_BUDGET_PER_TOOL);
  });

  it('unit: AGT_TODO_READ_DESCRIPTION is within 400-token per-tool ceiling', () => {
    const count = tokenCount(AGT_TODO_READ_DESCRIPTION);
    expect(
      count,
      `AGT_TODO_READ_DESCRIPTION is ${count} tokens (ceiling: ${TOKEN_BUDGET_PER_TOOL})`,
    ).toBeLessThanOrEqual(TOKEN_BUDGET_PER_TOOL);
  });

  it('unit: AGT_TODO_WRITE_DESCRIPTION is within 400-token per-tool ceiling', () => {
    const count = tokenCount(AGT_TODO_WRITE_DESCRIPTION);
    expect(
      count,
      `AGT_TODO_WRITE_DESCRIPTION is ${count} tokens (ceiling: ${TOKEN_BUDGET_PER_TOOL})`,
    ).toBeLessThanOrEqual(TOKEN_BUDGET_PER_TOOL);
  });
});

describe('NFR-NEW-001: buildAgentToolsPromptBlock assembled pack token budget', () => {
  /**
   * Pack-level regression assertions. `buildAgentToolsPromptBlock` is a pure
   * function: identical input → byte-identical output. These tests verify the
   * complete assembled block (including the section header, intro line, and
   * per-tool `### \`name\`` headings) stays within budget.
   */

  it('regression: default-on pack (glob+grep+multiedit+patch) assembled block <= 2000 tokens', () => {
    const block = buildAgentToolsPromptBlock(DEFAULT_ON_META);
    const count = tokenCount(block);
    expect(
      count,
      `Default-on pack block is ${count} tokens (ceiling: ${TOKEN_BUDGET_PACK_DEFAULT})`,
    ).toBeLessThanOrEqual(TOKEN_BUDGET_PACK_DEFAULT);
  });

  it('regression: full pack (all 6 tools) assembled block <= 2800 tokens', () => {
    const block = buildAgentToolsPromptBlock(ALL_TOOLS_META);
    const count = tokenCount(block);
    expect(
      count,
      `Full pack block is ${count} tokens (ceiling: ${TOKEN_BUDGET_PACK_ALL})`,
    ).toBeLessThanOrEqual(TOKEN_BUDGET_PACK_ALL);
  });

  it('unit: empty meta (umbrella OFF) produces zero-length block', () => {
    const block = buildAgentToolsPromptBlock(EMPTY_META);
    expect(block).toBe('');
    expect(tokenCount(block)).toBe(0);
  });

  it('unit: each individual tool fragment assembled through buildAgentToolsPromptBlock is <= 400 tokens', () => {
    // Measures the fragment INCLUDING the section header overhead
    // (the `### \`name\`` heading, header, and intro lines). This is the
    // most conservative per-tool check: it catches a single tool inflating
    // the total block past its share of the pack budget.
    for (const entry of ALL_TOOL_ENTRIES) {
      const block = buildAgentToolsPromptBlock(singleToolMeta(entry.name, entry.description));
      const count = tokenCount(block);
      expect(
        count,
        `Tool "${entry.name}" assembled block fragment is ${count} tokens ` +
          `(ceiling: ${TOKEN_BUDGET_PER_TOOL})`,
      ).toBeLessThanOrEqual(TOKEN_BUDGET_PER_TOOL);
    }
  });
});
