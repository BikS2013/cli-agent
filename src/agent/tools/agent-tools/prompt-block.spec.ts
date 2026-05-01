/**
 * Tests for buildAgentToolsPromptBlock — pure projection of the
 * AgentToolsCatalogMeta into a markdown block.
 *
 * Locks in:
 *   - empty meta → empty string (byte-stable with pre-integration prompt)
 *   - one tool  → header + one section, framed by leading/trailing '\n'
 *   - six tools → all six sections in registration order
 *   - identical input → identical output (deterministic)
 */

import { describe, it, expect } from 'vitest';
import { buildAgentToolsPromptBlock } from './prompt-block.js';
import type { AgentToolsCatalogMeta } from './group-builder.js';

function meta(
  registered: ReadonlyArray<{ name: string; description: string }>,
  umbrellaEnabled = true,
): AgentToolsCatalogMeta {
  return { umbrellaEnabled, registered };
}

describe('buildAgentToolsPromptBlock', () => {
  it('returns empty string when nothing is registered (umbrella OFF)', () => {
    expect(buildAgentToolsPromptBlock(meta([], false))).toBe('');
  });

  it('returns empty string when umbrella is ON but no per-tool flag fired', () => {
    expect(buildAgentToolsPromptBlock(meta([], true))).toBe('');
  });

  it('renders a single section under header + intro for one tool', () => {
    const out = buildAgentToolsPromptBlock(
      meta([{ name: 'agt_glob', description: 'Fast file-pattern matching.' }]),
    );
    expect(out.startsWith('\n')).toBe(true);
    expect(out.endsWith('\n')).toBe(true);
    expect(out).toContain('## Optional standard tools (agent-tools pack)');
    expect(out).toContain('The following bundled tools are also available in this session:');
    expect(out).toContain('### `agt_glob`');
    expect(out).toContain('Fast file-pattern matching.');
  });

  it('renders all six sections in registration order', () => {
    const entries = [
      { name: 'agt_glob', description: 'GLOB-DESC' },
      { name: 'agt_grep', description: 'GREP-DESC' },
      { name: 'agt_multiedit', description: 'MULTIEDIT-DESC' },
      { name: 'agt_patch', description: 'PATCH-DESC' },
      { name: 'agt_todo_read', description: 'TODOREAD-DESC' },
      { name: 'agt_todo_write', description: 'TODOWRITE-DESC' },
    ];
    const out = buildAgentToolsPromptBlock(meta(entries));
    let lastIdx = -1;
    for (const e of entries) {
      const idx = out.indexOf(`### \`${e.name}\``);
      expect(idx).toBeGreaterThan(lastIdx);
      lastIdx = idx;
      expect(out).toContain(e.description);
    }
  });

  it('is deterministic — identical input yields byte-identical output', () => {
    const m = meta([
      { name: 'agt_glob', description: 'A' },
      { name: 'agt_grep', description: 'B' },
    ]);
    expect(buildAgentToolsPromptBlock(m)).toBe(buildAgentToolsPromptBlock(m));
  });

  it('exact format for one entry', () => {
    const out = buildAgentToolsPromptBlock(
      meta([{ name: 'agt_x', description: 'X-DESC' }]),
    );
    expect(out).toBe(
      '\n' +
        '## Optional standard tools (agent-tools pack)\n' +
        '\n' +
        'The following bundled tools are also available in this session:\n' +
        '\n' +
        '### `agt_x`\nX-DESC' +
        '\n',
    );
  });

  it('exact format for two entries (separator is a blank line)', () => {
    const out = buildAgentToolsPromptBlock(
      meta([
        { name: 'agt_a', description: 'A-DESC' },
        { name: 'agt_b', description: 'B-DESC' },
      ]),
    );
    expect(out).toBe(
      '\n' +
        '## Optional standard tools (agent-tools pack)\n' +
        '\n' +
        'The following bundled tools are also available in this session:\n' +
        '\n' +
        '### `agt_a`\nA-DESC' +
        '\n\n' +
        '### `agt_b`\nB-DESC' +
        '\n',
    );
  });

  it('trims trailing whitespace from descriptions', () => {
    const out = buildAgentToolsPromptBlock(
      meta([{ name: 'agt_x', description: 'A line with trailing space   ' }]),
    );
    expect(out).toContain('A line with trailing space\n');
    expect(out).not.toContain('trailing space   \n');
  });
});
