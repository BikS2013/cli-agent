/**
 * Regression tests for the TUI wrap-redraw bugs.
 *
 * Bug history:
 *
 * 1. The original "smearing" bug — when a single logical line was longer
 *    than the terminal column count, redrawCurrentLine cleared only the
 *    rows it thought it had used (counting logical lines) but not the
 *    extra terminal rows produced by soft-wrap. Each subsequent keystroke
 *    emitted another `prompt + content` write starting one row below the
 *    previous, smearing copies of the input across the screen.
 *    Fix (0.1.2): track terminal rows = sum of `ceil((promptW + lineW) / cols)`
 *    and use that for the clear loop and cursor math.
 *
 * 2. The "creep up" bug — even with terminal-row tracking, repeated cursor
 *    motions on a wrapped line (Home, word-left, etc.) caused the input
 *    block to visually shift up by one row each keystroke. Cause: the
 *    cursor was assumed to be at the bottom of the previous render, but
 *    the previous redraw had positioned it at the *target* row (which
 *    could be the top). cursorUp(prevTermRows-1) from anywhere except the
 *    bottom overshot above the input area; \x1b[J then wiped one extra
 *    row and the redraw shifted up.
 *    Fix (0.1.3): track the cursor's row offset from the top of the
 *    previous render (RedrawState.cursorRowFromTop) and use that exact
 *    value to move back to the top.
 */
import { describe, it, expect } from 'vitest';
import {
  redrawCurrentLine,
  INITIAL_REDRAW_STATE,
  type RedrawState,
  type EditorState,
} from './line-editor.js';

interface StubStdout {
  columns: number;
  writes: string[];
  write: (chunk: string) => boolean;
}

function makeStubStdout(columns: number): StubStdout {
  const writes: string[] = [];
  return {
    columns,
    writes,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
  };
}

function makeState(lines: string[], row = 0, col = 0): EditorState {
  return { lines, row, col, histIdx: -1, draft: [...lines] };
}

const PROMPT = '>';   // visualWidth = 1
const CONT = '.';     // visualWidth = 1

describe('redrawCurrentLine — wrap-aware row tracking (0.1.2 regression)', () => {
  it('returns terminal-row count, not logical-line count, when content wraps', () => {
    // 1 logical line, 30 chars, cols=10, prompt width=1 → 31 visual cells → 4 rows (ceil(31/10))
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(30)]);
    state.col = 30;
    const result = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(result.termRows).toBe(4);
  });

  it('emits a clear-to-end-of-screen on the SECOND redraw (regression: was a fragile per-row clear loop)', () => {
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(30)]);
    state.col = 30;
    const first = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(first.termRows).toBe(4);

    const writesBefore = stdout.writes.length;
    redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, first,
    );
    const newWrites = stdout.writes.slice(writesBefore).join('');
    const clearScreenCount = (newWrites.match(/\x1b\[J/g) ?? []).length;
    expect(clearScreenCount).toBe(1);
    expect(newWrites).not.toMatch(/\x1b\[2K/);
  });

  it('multi-line buffer with one wrapped line returns total terminal rows', () => {
    const stdout = makeStubStdout(10);
    const state = makeState(['hello', 'x'.repeat(25), ''], 2, 0);
    const result = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(result.termRows).toBe(5);
  });

  it('non-wrapping input still returns 1 row (no regression for short input)', () => {
    const stdout = makeStubStdout(80);
    const state = makeState(['hi']);
    state.col = 2;
    const result = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(result.termRows).toBe(1);
  });

  it('empty buffer renders as 1 terminal row', () => {
    const stdout = makeStubStdout(80);
    const state = makeState(['']);
    const result = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(result.termRows).toBe(1);
  });

  it('Greek (BMP, single-cell) text also wraps deterministically', () => {
    const stdout = makeStubStdout(10);
    const greek = 'Υπάρχειτρόποςναέκανε';
    const long = greek + greek.slice(0, 10);
    const state = makeState([long]);
    state.col = long.length;
    const result = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(result.termRows).toBe(4);
  });

  it('positions cursor with cursorRight to target column on wrapped line', () => {
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(25)]);
    state.col = 12;
    redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    const all = stdout.writes.join('');
    expect(all).toContain('\x1b[1A\r\x1b[3C');
  });

  it('handles non-TTY stdout (no `columns`) using a sane default of 80', () => {
    const writes: string[] = [];
    const stdout = {
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const state = makeState(['x'.repeat(30)]);
    state.col = 30;
    const result = redrawCurrentLine(state, PROMPT, CONT, stdout, INITIAL_REDRAW_STATE);
    expect(result.termRows).toBe(1);
  });

  it('cursor at exactly cols boundary (phantom column) does not double-count rows', () => {
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(9)]);
    state.col = 9;
    const result = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(result.termRows).toBe(1);
  });
});

describe('redrawCurrentLine — RedrawState.cursorRowFromTop tracking (0.1.3 regression: word-motion creep-up)', () => {
  it('returns cursorRowFromTop=0 when cursor lands on the first sub-row', () => {
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(25)]);
    state.col = 5; // visual cell 6, sub-row 0
    const result = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(result.cursorRowFromTop).toBe(0);
  });

  it('returns cursorRowFromTop equal to the wrap sub-row of the cursor', () => {
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(25)]);
    state.col = 12; // visual cell 13, sub-row 1
    const result = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(result.cursorRowFromTop).toBe(1);
  });

  it('uses cursorRowFromTop (not termRows-1) to navigate to top on next redraw', () => {
    // After a Home/word-left, cursor is at row 0 of the input. The NEXT
    // redraw must move up by 0 rows (the cursor is already at the top),
    // not by termRows-1 (which would land above the input area and trigger
    // the creep-up bug).
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(25)]);
    state.col = 0; // top of input after Home
    const first = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(first.cursorRowFromTop).toBe(0);
    expect(first.termRows).toBeGreaterThan(1); // sanity: line did wrap

    // Second redraw with cursor still at col 0. Capture writes.
    const mark = stdout.writes.length;
    redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, first,
    );
    const chunk = stdout.writes.slice(mark).join('');
    // The first byte sequence emitted should NOT be cursorUp — cursor is
    // already at the top of the previous render. The original bug emitted
    // cursorUp(termRows-1) here, overshooting above the input area.
    expect(chunk.startsWith('\r')).toBe(true);
    // Specifically: no cursorUp at all on this redraw.
    expect(chunk).not.toMatch(/^\x1b\[\d+A/);
  });

  it('Home then Right then Right does not creep up (full scenario regression)', () => {
    const stdout = makeStubStdout(40);
    const greek = 'Μπορείς να κρατάς το τελευταίο μήνυμα που έχεις διαβάσει από το Telegram';
    const state = makeState([greek]);
    state.col = greek.length;
    let rs = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(rs.termRows).toBe(2);

    // Press Home — cursor goes to col 0 → row 0.
    let mark = stdout.writes.length;
    state.col = 0;
    rs = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, rs,
    );
    let chunk = stdout.writes.slice(mark).join('');
    expect(rs.cursorRowFromTop).toBe(0);
    expect((chunk.match(/\x1b\[J/g) ?? []).length).toBe(1);

    // Press Right (col 0→1) — cursor still on row 0. The redraw must NOT
    // emit any cursorUp before the \r + \x1b[J, otherwise we creep above
    // the input area.
    mark = stdout.writes.length;
    state.col = 1;
    rs = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, rs,
    );
    chunk = stdout.writes.slice(mark).join('');
    expect(chunk.startsWith('\r')).toBe(true); // immediate \r, no cursorUp
    expect(rs.cursorRowFromTop).toBe(0);

    // Press Right again — same.
    mark = stdout.writes.length;
    state.col = 2;
    rs = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, rs,
    );
    chunk = stdout.writes.slice(mark).join('');
    expect(chunk.startsWith('\r')).toBe(true);
    expect(rs.cursorRowFromTop).toBe(0);
  });

  it('word-right from col 0 to col 8 stays on row 0; subsequent redraw uses up=0', () => {
    const stdout = makeStubStdout(10);
    const greek = 'word1 word2 word3 word4 word5'; // 29 chars; with prompt → wraps 10-col
    const state = makeState([greek]);
    state.col = 0;
    let rs = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(rs.cursorRowFromTop).toBe(0);

    // word-right: cursor moves from 0 to "word1 ".length = 6 (visual cell 7, sub-row 0).
    state.col = 6;
    const mark = stdout.writes.length;
    rs = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, rs,
    );
    const chunk = stdout.writes.slice(mark).join('');
    // Cursor was at row 0; should not move up before clearing.
    expect(chunk.startsWith('\r')).toBe(true);
    expect(rs.cursorRowFromTop).toBe(0);
  });

  it('word-left from end of wrapped line drops the cursor to row 0 in one shot', () => {
    const stdout = makeStubStdout(10);
    const text = 'word1 word2 word3'; // 17 chars
    const state = makeState([text]);
    state.col = text.length; // at end → with prompt, cell 18, row 1
    let rs = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, INITIAL_REDRAW_STATE,
    );
    expect(rs.cursorRowFromTop).toBe(1);

    // word-left jumps to col 12 ("word3" start); visual cell 13; sub-row 1.
    state.col = 12;
    rs = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, rs,
    );
    expect(rs.cursorRowFromTop).toBe(1);

    // word-left again to col 6; visual cell 7; sub-row 0.
    state.col = 6;
    rs = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, rs,
    );
    expect(rs.cursorRowFromTop).toBe(0);
  });
});
