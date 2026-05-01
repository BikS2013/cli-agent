/**
 * Regression tests for the TUI wrap-redraw bug.
 *
 * Bug: when a single logical input line was longer than the terminal column
 * count, `redrawCurrentLine` cleared only the rows it thought it had used
 * (counting logical lines) but not the extra terminal rows produced by soft-
 * wrap. Each subsequent keystroke emitted another `prompt + content` write
 * starting one row below the previous, smearing copies of the input across
 * the screen.
 *
 * The fix: track terminal rows (ceil((promptW + lineW) / cols) per logical
 * line) and use that count for both the clear loop and the cursor math.
 *
 * These tests exercise `redrawCurrentLine` directly with a stub stdout that
 * has a fixed `columns` value, recording every write so we can assert the
 * exact sequence of escape codes.
 */
import { describe, it, expect } from 'vitest';
import { redrawCurrentLine, type EditorState } from './line-editor.js';

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

const PROMPT = '>';     // visualWidth = 1
const CONT = '.';       // visualWidth = 1

describe('redrawCurrentLine — wrap-aware row tracking', () => {
  it('returns terminal-row count, not logical-line count, when content wraps', () => {
    // 1 logical line, 30 chars, cols=10, prompt width=1 → 31 visual cells → 4 rows (ceil(31/10))
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(30)]);
    state.col = 30;
    const rows = redrawCurrentLine(
      state,
      PROMPT,
      CONT,
      stdout as unknown as NodeJS.WriteStream,
      1,
    );
    expect(rows).toBe(4);
  });

  it('emits a clear-to-end-of-screen on the SECOND redraw (regression: was a fragile per-row clear loop)', () => {
    // First redraw: long line wraps to 4 rows.
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(30)]);
    state.col = 30;
    const firstRows = redrawCurrentLine(
      state,
      PROMPT,
      CONT,
      stdout as unknown as NodeJS.WriteStream,
      1,
    );
    expect(firstRows).toBe(4);

    // Second redraw — verify we emit exactly one `\x1b[J` (clear-to-end-of-
    // screen) instead of the previous fragile per-row CLEAR_LINE loop.
    // \x1b[J is robust against `prevTermRows` drift (e.g. when the terminal
    // wrapped at a different column than predicted).
    const writesBefore = stdout.writes.length;
    redrawCurrentLine(
      state,
      PROMPT,
      CONT,
      stdout as unknown as NodeJS.WriteStream,
      firstRows,
    );
    const newWrites = stdout.writes.slice(writesBefore).join('');
    const clearScreenCount = (newWrites.match(/\x1b\[J/g) ?? []).length;
    expect(clearScreenCount).toBe(1);
    // And no per-row CLEAR_LINE leftovers.
    expect(newWrites).not.toMatch(/\x1b\[2K/);
  });

  it('multi-line buffer with one wrapped line returns total terminal rows', () => {
    // line 0: 5 chars + prompt 1 = 6 cells → 1 row
    // line 1: 25 chars + cont prompt 1 = 26 cells → 3 rows (cols=10)
    // line 2: 0 chars + cont prompt 1 = 1 cell → 1 row
    // total: 5 rows
    const stdout = makeStubStdout(10);
    const state = makeState(['hello', 'x'.repeat(25), ''], 2, 0);
    const rows = redrawCurrentLine(
      state,
      PROMPT,
      CONT,
      stdout as unknown as NodeJS.WriteStream,
      1,
    );
    expect(rows).toBe(5);
  });

  it('non-wrapping input still returns 1 row (no regression for short input)', () => {
    const stdout = makeStubStdout(80);
    const state = makeState(['hi']);
    state.col = 2;
    const rows = redrawCurrentLine(
      state,
      PROMPT,
      CONT,
      stdout as unknown as NodeJS.WriteStream,
      1,
    );
    expect(rows).toBe(1);
  });

  it('empty buffer renders as 1 terminal row', () => {
    const stdout = makeStubStdout(80);
    const state = makeState(['']);
    const rows = redrawCurrentLine(
      state,
      PROMPT,
      CONT,
      stdout as unknown as NodeJS.WriteStream,
      1,
    );
    expect(rows).toBe(1);
  });

  it('Greek (BMP, single-cell) text also wraps deterministically', () => {
    // 30 Greek chars, each .length=1 (BMP), prompt 1 = 31 cells, cols=10 → 4 rows
    const stdout = makeStubStdout(10);
    const greek = 'Υπάρχειτρόποςναέκανε'; // 20 Greek chars
    const long = greek + greek.slice(0, 10); // 30 chars
    const state = makeState([long]);
    state.col = long.length;
    const rows = redrawCurrentLine(
      state,
      PROMPT,
      CONT,
      stdout as unknown as NodeJS.WriteStream,
      1,
    );
    expect(rows).toBe(4);
  });

  it('positions cursor with cursorRight to target column on wrapped line', () => {
    // cols=10, prompt 1, line of 25 chars, cursor at col 12 (logical).
    // Target visual cell = 1 + 12 = 13.
    // Sub-row: floor(13/10) = 1; col within row: 13 % 10 = 3.
    // After draw, cursor sits at end (visual offset 1+25=26, sub-row 2, col 6).
    // Need: cursorUp(1), \r, cursorRight(3).
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(25)]);
    state.col = 12;
    redrawCurrentLine(
      state,
      PROMPT,
      CONT,
      stdout as unknown as NodeJS.WriteStream,
      1,
    );
    const all = stdout.writes.join('');
    // Verify the cursor-positioning suffix: cursorUp(1) + \r + cursorRight(3).
    expect(all).toContain('\x1b[1A\r\x1b[3C');
  });

  it('handles non-TTY stdout (no `columns`) using a sane default of 80', () => {
    // Without a `columns` field, getCols falls back to 80. 30-char content
    // with prompt 1 = 31 cells, well under 80, so 1 row.
    const writes: string[] = [];
    const stdout = {
      write(chunk: string) {
        writes.push(chunk);
        return true;
      },
    } as unknown as NodeJS.WriteStream;
    const state = makeState(['x'.repeat(30)]);
    state.col = 30;
    const rows = redrawCurrentLine(state, PROMPT, CONT, stdout, 1);
    expect(rows).toBe(1);
  });

  it('Home then Right on a wrapped line emits clear-to-end-of-screen each time (no smearing)', () => {
    // User scenario: long line wrapped, press Home (col -> 0), then press
    // Right (col -> 1). Each redraw must emit exactly one `\x1b[J` so any
    // soft-wrap row count drift cannot leave stale content visible.
    const stdout = makeStubStdout(40);
    const greek = 'Μπορείς να κρατάς το τελευταίο μήνυμα που έχεις διαβάσει από το Telegram';
    const state = makeState([greek]);
    state.col = greek.length;
    let rows = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, 1,
    );
    // 73 + 1 = 74 cells / 40 cols = 2 rows
    expect(rows).toBe(2);

    // Press Home
    let mark = stdout.writes.length;
    state.col = 0;
    rows = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, rows,
    );
    let chunk = stdout.writes.slice(mark).join('');
    expect((chunk.match(/\x1b\[J/g) ?? []).length).toBe(1);
    expect(chunk).not.toMatch(/\x1b\[2K/);

    // Press Right
    mark = stdout.writes.length;
    state.col = 1;
    rows = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, rows,
    );
    chunk = stdout.writes.slice(mark).join('');
    expect((chunk.match(/\x1b\[J/g) ?? []).length).toBe(1);
    expect(chunk).not.toMatch(/\x1b\[2K/);

    // Press Right again
    mark = stdout.writes.length;
    state.col = 2;
    rows = redrawCurrentLine(
      state, PROMPT, CONT, stdout as unknown as NodeJS.WriteStream, rows,
    );
    chunk = stdout.writes.slice(mark).join('');
    expect((chunk.match(/\x1b\[J/g) ?? []).length).toBe(1);
    expect(chunk).not.toMatch(/\x1b\[2K/);
  });

  it('cursor at exactly cols boundary (phantom column) does not double-count rows', () => {
    // cols=10, prompt 1, line of 9 chars → 1 + 9 = 10 cells = exactly 1 row.
    // ceil(10/10) = 1, so totalTermRows = 1.
    const stdout = makeStubStdout(10);
    const state = makeState(['x'.repeat(9)]);
    state.col = 9;
    const rows = redrawCurrentLine(
      state,
      PROMPT,
      CONT,
      stdout as unknown as NodeJS.WriteStream,
      1,
    );
    expect(rows).toBe(1);
  });
});
