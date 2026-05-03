/**
 * Co-located tests for `prompts.ts` (plan-006 Phase 6, U-SYNTH).
 */

import { describe, it, expect } from 'vitest';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  STAGE1_TEMPLATE_VERSION,
  STAGE2_TEMPLATE_VERSION,
  stage1DistillPrompt,
  stage2ComposePrompt,
} from './prompts.js';
import type { Stage1Distillation } from './types.js';

function makeDistillation(name: string, body: string): Stage1Distillation {
  return {
    memberName: name,
    content: body,
    modelId: 'anthropic:claude-sonnet-4-6',
    templateVersion: STAGE1_TEMPLATE_VERSION,
    createdAt: '2026-05-02T00:00:00.000Z',
  };
}

describe('stage1DistillPrompt', () => {
  it('returns System + Human messages with the locked template version', () => {
    const out = stage1DistillPrompt({
      memberName: 'file-cli',
      memberDocCanonical: '# file-cli\n\nManipulates files.\n',
    });
    expect(out.templateVersion).toBe(STAGE1_TEMPLATE_VERSION);
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toBeInstanceOf(SystemMessage);
    expect(out.messages[1]).toBeInstanceOf(HumanMessage);
  });

  it('embeds the member name and the canonical doc bytes in the user message', () => {
    const out = stage1DistillPrompt({
      memberName: 'outlook-cli',
      memberDocCanonical: '# outlook-cli\n\nReads email.\n',
    });
    const userText = String(out.messages[1]!.content);
    expect(userText).toContain('## Member tool: outlook-cli');
    expect(userText).toContain('# outlook-cli');
    expect(userText).toContain('Reads email.');
  });

  it('instructs the model to emit JSON only', () => {
    const out = stage1DistillPrompt({
      memberName: 'x',
      memberDocCanonical: 'doc',
    });
    const sys = String(out.messages[0]!.content);
    expect(sys).toMatch(/Output ONLY valid JSON/);
    expect(sys).toContain('"synopsis"');
  });

  it('produces byte-stable messages across calls with identical inputs', () => {
    const a = stage1DistillPrompt({ memberName: 'x', memberDocCanonical: 'd' });
    const b = stage1DistillPrompt({ memberName: 'x', memberDocCanonical: 'd' });
    expect(JSON.stringify(a.messages.map((m) => m.content)))
      .toBe(JSON.stringify(b.messages.map((m) => m.content)));
  });
});

describe('stage2ComposePrompt', () => {
  it('returns System + 2 Human messages with the locked template version + prefixEndIndex', () => {
    const out = stage2ComposePrompt({
      compositeName: 'email-assistant',
      members: [
        { name: 'file-cli', distillation: makeDistillation('file-cli', '{"synopsis": "files"}') },
        { name: 'outlook-cli', distillation: makeDistillation('outlook-cli', '{"synopsis": "email"}') },
      ],
      cliAgentVersion: '0.3.0',
      synthesisModel: 'anthropic:claude-sonnet-4-6',
      activeProfile: null,
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    expect(out.templateVersion).toBe(STAGE2_TEMPLATE_VERSION);
    expect(out.messages).toHaveLength(3);
    expect(out.messages[0]).toBeInstanceOf(SystemMessage);
    expect(out.messages[1]).toBeInstanceOf(HumanMessage);
    expect(out.messages[2]).toBeInstanceOf(HumanMessage);
    // Cache through messages[0..1] (system + members); compose
    // instruction at messages[2] is unmarked.
    expect(out.prefixEndIndex).toBe(1);
  });

  it('sorts members in the assembled members block', () => {
    const out = stage2ComposePrompt({
      compositeName: 'c',
      members: [
        { name: 'zoo', distillation: makeDistillation('zoo', '{"z": 1}') },
        { name: 'apple', distillation: makeDistillation('apple', '{"a": 1}') },
      ],
      cliAgentVersion: '0.3.0',
      synthesisModel: 'm',
      activeProfile: null,
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    const membersMsg = out.messages[1]!;
    const blocks = membersMsg.content as Array<{ type: string; text: string }>;
    const text = blocks[0]!.text;
    expect(text.indexOf('## apple')).toBeLessThan(text.indexOf('## zoo'));
  });

  it('puts compose instruction in a separate trailing HumanMessage', () => {
    const out = stage2ComposePrompt({
      compositeName: 'foo',
      members: [
        { name: 'a', distillation: makeDistillation('a', '{}') },
      ],
      cliAgentVersion: '9.9.9',
      synthesisModel: 'openai:gpt-4o',
      activeProfile: 'work',
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    const composeMsg = out.messages[2]!;
    const blocks = composeMsg.content as Array<{ type: string; text: string }>;
    const text = blocks[0]!.text;
    expect(text).toContain('Compose the composite "foo"');
    expect(text).toContain('Today: 2026-05-02T00:00:00.000Z');
    expect(text).toContain('cli-agent version: 9.9.9');
    expect(text).toContain('Active profile: work');
  });

  it('prints `(none)` when activeProfile is null', () => {
    const out = stage2ComposePrompt({
      compositeName: 'foo',
      members: [
        { name: 'a', distillation: makeDistillation('a', '{}') },
      ],
      cliAgentVersion: '0.3.0',
      synthesisModel: 'm',
      activeProfile: null,
      nowIso: '2026-05-02T00:00:00.000Z',
    });
    const composeMsg = out.messages[2]!;
    const blocks = composeMsg.content as Array<{ type: string; text: string }>;
    expect(blocks[0]!.text).toContain('Active profile: (none)');
  });

  it('produces byte-stable assembly across calls with identical inputs', () => {
    const args = {
      compositeName: 'foo',
      members: [
        { name: 'a', distillation: makeDistillation('a', '{}') },
        { name: 'b', distillation: makeDistillation('b', '{}') },
      ],
      cliAgentVersion: '0.3.0',
      synthesisModel: 'm',
      activeProfile: null,
      nowIso: '2026-05-02T00:00:00.000Z',
    } as const;
    const a = stage2ComposePrompt(args);
    const b = stage2ComposePrompt(args);
    expect(JSON.stringify(a.messages.map((m) => m.content)))
      .toBe(JSON.stringify(b.messages.map((m) => m.content)));
  });
});
