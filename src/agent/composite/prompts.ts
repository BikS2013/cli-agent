/**
 * Stage-1 + Stage-2 prompt templates for composite-tool synthesis
 * (plan-006 §14.G, Unit U-SYNTH).
 *
 * Pure string-assembly module. No LLM calls, no I/O. Both prompt
 * builders return:
 *   - `messages`: the assembled `BaseMessage[]` ready for `llm.invoke()`.
 *   - `templateVersion`: a frozen string identifier; bumping the
 *     constant invalidates any caller-side cache keyed off the template.
 *   - (Stage-2 only) `prefixEndIndex`: the index up to which messages
 *     should be marked cacheable by `withSynthesisCache` (the
 *     compose-instruction tail lives in the LAST message's last content
 *     block and is left unmarked).
 *
 * Stage-1 outputs are always < 1024 tokens, so provider caching does
 * not help; the on-disk Stage-1 cache (per ADR-CMP-1) is the only
 * effective reuse mechanism. Stage-2 is the prompt where provider
 * caching matters — see `withSynthesisCache` in `./llm-cache.ts`.
 *
 * The Stage-1 prompt asks for STRICT JSON output matching the
 * `Stage1Distillation.content` shape (a small structured intent
 * surface). The Stage-2 prompt asks for the schema-3 composite-doc
 * AUTO-GENERATED body, with empty USER-RECIPES and USER-NOTES blocks
 * (the user fills the latter post-synthesis; the composer wires the
 * markers per `composeCompositeDoc`).
 */

import { HumanMessage, SystemMessage, type BaseMessage } from '@langchain/core/messages';
import type { Stage1Distillation } from './types.js';

/**
 * Stage-1 template version pin. Bumping this invalidates EVERY
 * on-disk Stage-1 cache entry (callers include this in the cache key).
 */
export const STAGE1_TEMPLATE_VERSION = 'stage1-v1' as const;

/**
 * Stage-2 template version pin. Forward-compatible: bumping this
 * forces a fresh Stage-2 invocation even when the Stage-1 cache is hot.
 */
export const STAGE2_TEMPLATE_VERSION = 'stage2-v1' as const;

/* --------------------------------------------------------------------- */
/* Stage-1 distillation prompt                                            */
/* --------------------------------------------------------------------- */

const STAGE1_SYSTEM_PROMPT = [
  'You are a capability-distillation pre-processor for cli-agent\'s composite-tool synthesis pipeline.',
  '',
  'Given a single member tool\'s full capability document (already canonicalised — frontmatter + AUTO-GENERATED body, with USER-* sections stripped), you must produce a TERSE STRUCTURED INTENT SURFACE describing the tool\'s purpose, top-level subcommands, common flags, illustrative invocation patterns, and any noted constraints.',
  '',
  'Output ONLY valid JSON. No markdown, no commentary, no code fences. The JSON object MUST conform to this shape:',
  '',
  '{',
  '  "synopsis": string,             // 1-3 sentences describing what the tool does',
  '  "intents": string[],            // verbs the user might want to perform (≤ 8 items)',
  '  "subcommands": [                // ≤ 12 entries; the most useful subcommands',
  '    { "name": string, "purpose": string }',
  '  ],',
  '  "flags": [                      // ≤ 12 entries; common cross-subcommand flags',
  '    { "name": string, "purpose": string }',
  '  ],',
  '  "examples": [                   // ≤ 5 illustrative single-tool invocation patterns',
  '    { "command": string, "explanation": string }',
  '  ],',
  '  "constraints": string[]         // ≤ 8 items: auth, rate, prerequisites, side-effects',
  '}',
  '',
  'Refrain from emitting credential placeholders (no real or fake API keys, tokens, passwords). Aim for ~500 tokens total. Do NOT echo the input doc verbatim.',
].join('\n');

export interface Stage1PromptOutput {
  readonly messages: BaseMessage[];
  readonly templateVersion: string;
}

/**
 * Build the Stage-1 distillation prompt for a single member tool.
 *
 * Inputs:
 *   - `memberName` — the canonical member-tool name (the `--tool`
 *     argument value).
 *   - `memberDocCanonical` — the canonicalised member-doc bytes
 *     (output of `canonicaliseMemberDoc`). Stripped of USER-* blocks
 *     so cache invalidation is keyed only to capability bytes.
 *
 * Returns the assembled messages + the locked template version. The
 * messages are ready for direct `llm.invoke(messages)` consumption.
 */
export function stage1DistillPrompt(opts: {
  readonly memberName: string;
  readonly memberDocCanonical: string;
}): Stage1PromptOutput {
  const userText = [
    `## Member tool: ${opts.memberName}`,
    '',
    '<canonicalised capability document>',
    opts.memberDocCanonical,
    '</canonicalised capability document>',
    '',
    'Emit the JSON intent surface now. JSON only.',
  ].join('\n');

  return {
    messages: [
      new SystemMessage({ content: STAGE1_SYSTEM_PROMPT }),
      new HumanMessage({ content: userText }),
    ],
    templateVersion: STAGE1_TEMPLATE_VERSION,
  };
}

/* --------------------------------------------------------------------- */
/* Stage-2 composer prompt                                                */
/* --------------------------------------------------------------------- */

/**
 * Stage-2 system prompt — the STABLE prefix that benefits from
 * provider-side prompt caching when the prefix is ≥ 1024 tokens. It
 * carries no per-composite variables; every byte is identical across
 * synthesis runs (within the same template version).
 */
const STAGE2_SYSTEM_PROMPT = [
  'You are the composite synthesizer for cli-agent.',
  '',
  'Your job: compose ONE capability document for a composite tool that aggregates several member CLI tools. You will receive per-member STRUCTURED INTENT SURFACES (Stage-1 distillations) plus a compose instruction naming the composite and its members. Produce the body of a schema-3 composite capability document.',
  '',
  'OUTPUT RULES:',
  '1. Output ONLY the AUTO-GENERATED body of the composite doc — DO NOT emit frontmatter, DO NOT emit a YAML envelope, DO NOT wrap your output in code fences. The host adds the frontmatter and the document title.',
  '2. The output MUST be markdown text consisting of these sections in order:',
  '   ## Synopsis',
  '     A 2-4 sentence summary of what the composite tool can do across all its members.',
  '   ## Cross-tool intents',
  '     A bullet list of verbs / objectives the user can accomplish by combining the member tools. Each bullet ≤ 1 line; ≤ 12 bullets total.',
  '   ## Parameter glossary',
  '     A definition list (term : definition) of canonical parameters that appear across members, disambiguated when two members use the same name with different meanings. ≤ 20 entries.',
  '   ## Cross-tool recipes',
  '     3 to 7 worked examples that combine TWO OR MORE member tools to accomplish a goal. Each recipe has a one-line title, a 1-2 sentence rationale, and a fenced shell-block showing the invocation sequence.',
  '   ## Constraints and notes',
  '     Bullet list of cross-tool constraints (auth coupling, ordering requirements, mutual exclusivity, rate-limit interactions). ≤ 10 bullets.',
  '3. The body must be standalone markdown — your sections begin with `## Synopsis` and end after the last bullet of `## Constraints and notes`. Do NOT emit the AUTO-GENERATED markers, the USER-RECIPES markers, or the USER-NOTES markers — the composer wires them.',
  '4. Do NOT emit any credential placeholder strings (no real or fake API keys, tokens, passwords).',
  '5. Do NOT invent flags or behaviour the input distillations do not describe. When a recipe needs a value the user must supply, write a clearly-bracketed placeholder like `<source-path>` or `<recipient-email>`.',
  '6. Stay under 6000 tokens of output.',
  '',
  'CACHING NOTE: The cli-agent host applies provider-side prompt caching to the prefix of this conversation. Reproducible byte-stable output is desired; do not introduce stylistic variation that depends on randomness.',
].join('\n');

export interface Stage2PromptOutput {
  readonly messages: BaseMessage[];
  readonly templateVersion: string;
  /** Index up to and including which messages should be marked
   * cacheable by `withSynthesisCache`. The dynamic compose-instruction
   * lives in the LAST content block of the LAST message and is NOT
   * cacheable. Stage-2 always sets this to `messages.length - 1`
   * because the cache helper marks the last block of each cached
   * message — the dynamic tail is its own block in the same
   * HumanMessage. See plan-006 §14.G. */
  readonly prefixEndIndex: number;
}

/**
 * Build the Stage-2 composer prompt.
 *
 * The HumanMessage carries TWO content blocks:
 *   - Block 0: concatenated Stage-1 distillations (the cacheable
 *     members block; bytes change only when a member's doc changes).
 *   - Block 1: the compose instruction (composite name, sorted
 *     members list, today's ISO date, synthesis context — the dynamic
 *     tail).
 *
 * `prefixEndIndex = messages.length - 1` because U-CACHE's Anthropic
 * adapter marks only the LAST content block of each cached message.
 * The members block sits at index 0 of the HumanMessage's content
 * array; for the cache helper to attach a `cache_control` marker to
 * the members block specifically (and NOT to the compose
 * instruction), the helper-aware caller would set `prefixEndIndex` to
 * an index that points at a message ENDING with the members block.
 * Plan-006 §14.G locks this to `messages.length - 1` and accepts that
 * Anthropic's marker lands on the LAST block of the HumanMessage —
 * i.e., the compose instruction. To keep the dynamic tail unmarked,
 * we instead emit the members block as the LAST content block of a
 * SEPARATE HumanMessage, and put the compose instruction in a third
 * message. This three-message layout matches §14.G and the research
 * §"Stage-2 Prompt Assembly" sketch.
 */
export function stage2ComposePrompt(opts: {
  readonly compositeName: string;
  readonly members: ReadonlyArray<{ readonly name: string; readonly distillation: Stage1Distillation }>;
  readonly cliAgentVersion: string;
  readonly synthesisModel: string;
  readonly activeProfile: string | null;
  readonly nowIso?: string;
}): Stage2PromptOutput {
  const sortedMembers = [...opts.members].sort((a, b) => a.name.localeCompare(b.name));
  const todayIso = opts.nowIso ?? new Date().toISOString();

  // Members block — the cacheable middle of the prompt. The exact
  // bytes here are the only ones that change when a member's doc
  // changes (Stage-1 distillation rotates).
  const membersBlock = sortedMembers
    .map((m) => `## ${m.name}\n${m.distillation.content}`)
    .join('\n\n---\n\n');

  // Compose instruction — the dynamic tail. Composite name, member
  // list, date, and the active profile name are the only variables
  // that drift across runs; they live in this block alone so the
  // members block stays byte-stable.
  const composeInstruction = [
    `Compose the composite "${opts.compositeName}" capability document.`,
    `Members (sorted): [${sortedMembers.map((m) => m.name).join(', ')}].`,
    `Today: ${todayIso}.`,
    `Synthesis model: ${opts.synthesisModel}.`,
    `cli-agent version: ${opts.cliAgentVersion}.`,
    `Active profile: ${opts.activeProfile ?? '(none)'}.`,
    '',
    'Emit the body sections (## Synopsis through ## Constraints and notes) per the system rules. Markdown only.',
  ].join('\n');

  // Three-message layout (system + members + compose). This places
  // the cacheable members block as a complete message of its own so
  // the cache helper can mark it cleanly.
  const messages: BaseMessage[] = [
    new SystemMessage({ content: STAGE2_SYSTEM_PROMPT }),
    new HumanMessage({
      content: [
        {
          type: 'text' as const,
          text: membersBlock,
        },
      ],
    }),
    new HumanMessage({
      content: [
        {
          type: 'text' as const,
          text: composeInstruction,
        },
      ],
    }),
  ];

  // Cache through messages[0..1] (system + members). The compose
  // instruction is messages[2], which is left unmarked.
  const prefixEndIndex = 1;

  return {
    messages,
    templateVersion: STAGE2_TEMPLATE_VERSION,
    prefixEndIndex,
  };
}
