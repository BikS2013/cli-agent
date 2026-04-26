/**
 * Line-editor regression tests (spec §14.1, §14.2, §14.3).
 *
 * The mandatory cases:
 *
 *  1. Escape framing (§14.1) — every CSI/SS3/Alt sequence pressed alone
 *     followed by Enter must resolve to "" (empty buffer). If a letter
 *     leaks through, the framer is mis-dispatching on the introducer byte.
 *
 *  2. UTF-8 (§14.2) — Greek round-trip, emoji round-trip, multi-byte
 *     split across data chunks.
 *
 *  3. Mixed (§14.3) — ASCII + multi-byte + escape sequence in one chunk.
 *
 * The reader is driven through a PassThrough stream with isTTY=true and a
 * no-op setRawMode, per spec §14.
 */

import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { readInput, feedFramer, newFramerState, resolveEscapeSequence } from './line-editor.js';

function makeStdin(): NodeJS.ReadStream {
  const pt = new PassThrough() as unknown as NodeJS.ReadStream;
  // Pretend this is a TTY so the line-editor uses raw-mode codepath.
  Object.defineProperty(pt, 'isTTY', { value: true, configurable: true });
  // No-op setRawMode: tests don't need real raw-mode.
  (pt as unknown as { setRawMode: (b: boolean) => void }).setRawMode = () => {};
  return pt;
}

function makeStdout(): NodeJS.WriteStream {
  const pt = new PassThrough();
  // Sink — discard everything
  pt.on('data', () => {});
  return pt as unknown as NodeJS.WriteStream;
}

async function drive(bytes: ReadonlyArray<Buffer>, history: string[] = []): Promise<string> {
  const stdin = makeStdin();
  const stdout = makeStdout();
  const promise = readInput({
    prompt: '>',
    continuationPrompt: ' .',
    inputHistory: history,
    stdin,
    stdout,
  });
  // Feed bytes after a tick to ensure the data listener is attached.
  setImmediate(() => {
    for (const b of bytes) stdin.emit('data', b);
  });
  return promise;
}

describe('readInput (line-editor) — escape framing regression (spec §14.1)', () => {
  const cases: Array<[string, Buffer]> = [
    ['arrow up   \\x1b[A',     Buffer.from([0x1b, 0x5b, 0x41])],
    ['arrow down \\x1b[B',     Buffer.from([0x1b, 0x5b, 0x42])],
    ['arrow right\\x1b[C',     Buffer.from([0x1b, 0x5b, 0x43])],
    ['arrow left \\x1b[D',     Buffer.from([0x1b, 0x5b, 0x44])],
    ['SS3 Home   \\x1bOH',     Buffer.from([0x1b, 0x4f, 0x48])],
    ['Delete     \\x1b[3~',    Buffer.from([0x1b, 0x5b, 0x33, 0x7e])],
    ['Ctrl+left  \\x1b[1;5D',  Buffer.from([0x1b, 0x5b, 0x31, 0x3b, 0x35, 0x44])],
    ['Alt+b      \\x1bb',      Buffer.from([0x1b, 0x62])],
  ];

  for (const [name, esc] of cases) {
    it(`${name} alone + Enter resolves to ""`, async () => {
      const result = await drive([esc, Buffer.from([0x0d])]);
      expect(result).toBe('');
    });
  }
});

describe('readInput (line-editor) — UTF-8 regression (spec §14.2)', () => {
  it('Greek "test Αναφορά" + Enter round-trips', async () => {
    const result = await drive([Buffer.from('test Αναφορά', 'utf8'), Buffer.from([0x0d])]);
    expect(result).toBe('test Αναφορά');
  });

  it('emoji "😀" + Enter round-trips', async () => {
    const result = await drive([Buffer.from('😀', 'utf8'), Buffer.from([0x0d])]);
    expect(result).toBe('😀');
  });

  it('split multi-byte α (0xCE 0xB1) across two chunks decodes as "α"', async () => {
    const result = await drive([
      Buffer.from([0xce]),
      Buffer.from([0xb1]),
      Buffer.from([0x0d]),
    ]);
    expect(result).toBe('α');
  });
});

describe('readInput (line-editor) — mixed chunk (spec §14.3)', () => {
  it('"αβ" + arrow-left + "γ" gives "αγβ"', async () => {
    // αβ → cursor at end (col=2), arrow-left moves col to 1, γ inserts before β
    const data = Buffer.concat([
      Buffer.from('αβ', 'utf8'),
      Buffer.from([0x1b, 0x5b, 0x44]), // \x1b[D arrow left
      Buffer.from('γ', 'utf8'),
    ]);
    const result = await drive([data, Buffer.from([0x0d])]);
    expect(result).toBe('αγβ');
  });

  it('zero escape-byte leakage when ESC seq lives in same chunk as text', async () => {
    // ascii + ESC seq + ascii — ensure the ESC bytes do not appear in output
    const data = Buffer.concat([
      Buffer.from('hi', 'utf8'),
      Buffer.from([0x1b, 0x5b, 0x44]), // arrow-left between chars
      Buffer.from('!', 'utf8'),
    ]);
    const result = await drive([data, Buffer.from([0x0d])]);
    // Cursor was at end after 'hi' (col=2), arrow-left → col=1, '!' inserted between h and i
    expect(result).toBe('h!i');
    expect(result).not.toMatch(/[A-D]/); // no leaked arrow letter
  });
});

describe('readInput (line-editor) — basic editing', () => {
  it('plain ASCII + Enter submits', async () => {
    const result = await drive([Buffer.from('hello world', 'utf8'), Buffer.from([0x0d])]);
    expect(result).toBe('hello world');
  });

  it('Ctrl+J inserts newline; Enter submits the multiline buffer', async () => {
    const result = await drive([
      Buffer.from('line1', 'utf8'),
      Buffer.from([0x0a]), // Ctrl+J
      Buffer.from('line2', 'utf8'),
      Buffer.from([0x0d]),
    ]);
    expect(result).toBe('line1\nline2');
  });

  it('Backspace deletes the previous char', async () => {
    const result = await drive([
      Buffer.from('hello', 'utf8'),
      Buffer.from([0x7f]),
      Buffer.from([0x0d]),
    ]);
    expect(result).toBe('hell');
  });
});

describe('feedFramer + resolveEscapeSequence — unit-level checks', () => {
  it('frames CSI arrow keys on the final byte AFTER `[`', () => {
    const s = newFramerState();
    expect(feedFramer(s, 0x1b).kind).toBe('incomplete');
    expect(feedFramer(s, 0x5b).kind).toBe('incomplete'); // `[`
    const out = feedFramer(s, 0x41); // 'A'
    expect(out.kind).toBe('sequence');
    if (out.kind === 'sequence') expect(out.seq).toBe('[A');
  });

  it('frames SS3 in exactly 3 bytes', () => {
    const s = newFramerState();
    feedFramer(s, 0x1b);
    feedFramer(s, 0x4f); // O
    const out = feedFramer(s, 0x48); // H
    expect(out.kind).toBe('sequence');
    if (out.kind === 'sequence') expect(out.seq).toBe('OH');
  });

  it('frames ESC + char in exactly 2 bytes', () => {
    const s = newFramerState();
    feedFramer(s, 0x1b);
    const out = feedFramer(s, 0x62); // 'b'
    expect(out.kind).toBe('sequence');
    if (out.kind === 'sequence') expect(out.seq).toBe('b');
  });

  it('discards on safety-cap overflow', () => {
    const s = newFramerState();
    feedFramer(s, 0x1b);
    feedFramer(s, 0x5b); // CSI introducer; would keep accumulating
    // SAFETY_CAP=16; ESC + '[' is 2 bytes; the 15th '0' pushes total to 17 → discard
    let sawDiscard = false;
    for (let i = 0; i < 30; i++) {
      const out = feedFramer(s, 0x30); // '0' — neither final nor introducer
      if (out.kind === 'discard') {
        sawDiscard = true;
        break;
      }
    }
    expect(sawDiscard).toBe(true);
  });

  it('resolves arrow keys', () => {
    expect(resolveEscapeSequence('[A')?.kind).toBe('up');
    expect(resolveEscapeSequence('[B')?.kind).toBe('down');
    expect(resolveEscapeSequence('[C')?.kind).toBe('right');
    expect(resolveEscapeSequence('[D')?.kind).toBe('left');
  });

  it('resolves Shift+Enter variants', () => {
    expect(resolveEscapeSequence('[13;2u')?.kind).toBe('newline');
    expect(resolveEscapeSequence('OM')?.kind).toBe('newline');
    expect(resolveEscapeSequence('\r')?.kind).toBe('newline');
    expect(resolveEscapeSequence('\n')?.kind).toBe('newline');
    expect(resolveEscapeSequence('[27;2;13~')?.kind).toBe('newline');
  });

  it('returns null for unknown sequences (drop silently)', () => {
    expect(resolveEscapeSequence('[99~')).toBeNull();
  });
});
