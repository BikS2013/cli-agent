/**
 * UTF-8 decoder regression tests (spec §14.2).
 *
 * Mandatory coverage: Greek/emoji/CJK round-trip; multi-byte split across
 * data chunks. These guard against the §18.2 mojibake bug.
 */

import { describe, it, expect } from 'vitest';
import { createUtf8Decoder } from './utf8.js';

function feed(decoder: ReturnType<typeof createUtf8Decoder>, bytes: Buffer): string {
  let out = '';
  for (const b of bytes) out += decoder.write(b);
  return out;
}

describe('createUtf8Decoder', () => {
  it('round-trips a Greek string', () => {
    const dec = createUtf8Decoder();
    const buf = Buffer.from('test Αναφορά', 'utf8');
    expect(feed(dec, buf)).toBe('test Αναφορά');
  });

  it('round-trips a 4-byte emoji', () => {
    const dec = createUtf8Decoder();
    const buf = Buffer.from('😀', 'utf8');
    expect(feed(dec, buf)).toBe('😀');
  });

  it('handles multi-byte sequence split across two chunks', () => {
    const dec = createUtf8Decoder();
    // U+03B1 (alpha) is 0xCE 0xB1 in UTF-8
    let acc = '';
    acc += dec.write(0xce); // expect '' (incomplete)
    expect(acc).toBe('');
    acc += dec.write(0xb1); // now complete -> 'α'
    expect(acc).toBe('α');
  });

  it('handles mixed ASCII + multi-byte in one stream', () => {
    const dec = createUtf8Decoder();
    const buf = Buffer.from('hi-αβ-bye-😀', 'utf8');
    expect(feed(dec, buf)).toBe('hi-αβ-bye-😀');
  });

  it('handles Cyrillic and CJK', () => {
    const dec = createUtf8Decoder();
    const buf = Buffer.from('Привет 中文', 'utf8');
    expect(feed(dec, buf)).toBe('Привет 中文');
  });
});
