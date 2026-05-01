/**
 * Raw-mode multiline reader for the cli-agent TUI.
 *
 * Implements the spec §5 byte-level keyboard map verbatim, including:
 *  - Escape-sequence framing by SHAPE, not "any 0x40–0x7E byte terminates"
 *    (spec §5.1 / §18.1). CSI introducer `[` (0x5B) and SS3 introducer `O`
 *    (0x4F) sit inside the would-be terminator range, so a naïve dispatcher
 *    eats arrow keys and emits the letter. We frame:
 *       - `\x1b[` … final byte (0x40–0x7E) AFTER the `[`, total length ≥ 3
 *       - `\x1bO<key>` exactly 3 bytes
 *       - `\x1b<char>` exactly 2 bytes
 *  - UTF-8 printable bytes routed through a stateful StringDecoder
 *    (spec §5.2 / §18.2). String.fromCharCode(b) is FORBIDDEN here — it
 *    Latin-1-mangles every multi-byte code point.
 *  - Shift+Enter accepted via every known sequence (\x1b[13;2u, \x1bOM,
 *    \x1b\r, \x1b\n, \x1b[27;2;13~) for terminals that emit one. Terminals
 *    that send plain `\r` are indistinguishable from Enter — users fall
 *    back to Ctrl+J (0x0A) per spec §18.3.
 *
 * Pure helpers (replaceInput, insertNewline, handleBackspace, redrawCurrentLine)
 * are extracted so the line-editor regression tests can drive them directly.
 */

import { GREEN, RESET, cursorUp, cursorDown, cursorRight } from '../ansi.js';
import { createUtf8Decoder, type Utf8Decoder } from '../utf8.js';

export interface ReadInputOptions {
  readonly prompt: string;
  readonly continuationPrompt: string;
  readonly inputHistory: string[];
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

/** Exported for tests. */
export interface EditorState {
  lines: string[];
  /** Logical column within the current line (UTF-16 code-unit count, mirrors String.length). */
  col: number;
  /** Index into `lines` for the active line. */
  row: number;
  /** Scrollback navigation index into history; -1 means the user is editing fresh input. */
  histIdx: number;
  /** Snapshot of in-progress input when the user starts navigating history. */
  draft: string[];
}

/** Exported for tests. */
export function replaceInput(state: EditorState, fresh: string): void {
  state.lines = fresh.split('\n');
  if (state.lines.length === 0) state.lines = [''];
  state.row = state.lines.length - 1;
  state.col = state.lines[state.row]!.length;
}

/** Exported for tests. */
export function insertNewline(state: EditorState): void {
  const line = state.lines[state.row]!;
  const before = line.slice(0, state.col);
  const after = line.slice(state.col);
  state.lines.splice(state.row, 1, before, after);
  state.row += 1;
  state.col = 0;
}

/** Exported for tests. */
export function handleBackspace(state: EditorState): void {
  if (state.col > 0) {
    const line = state.lines[state.row]!;
    state.lines[state.row] = line.slice(0, state.col - 1) + line.slice(state.col);
    state.col -= 1;
    return;
  }
  // At column 0: merge with previous line if any
  if (state.row > 0) {
    const prev = state.lines[state.row - 1]!;
    const cur = state.lines[state.row]!;
    state.col = prev.length;
    state.lines[state.row - 1] = prev + cur;
    state.lines.splice(state.row, 1);
    state.row -= 1;
  }
}

function deleteCharAtCursor(state: EditorState): void {
  const line = state.lines[state.row]!;
  if (state.col < line.length) {
    state.lines[state.row] = line.slice(0, state.col) + line.slice(state.col + 1);
    return;
  }
  // At end of line: pull next line up
  if (state.row < state.lines.length - 1) {
    const next = state.lines[state.row + 1]!;
    state.lines[state.row] = line + next;
    state.lines.splice(state.row + 1, 1);
  }
}

function deleteToStartOfLine(state: EditorState): void {
  const line = state.lines[state.row]!;
  state.lines[state.row] = line.slice(state.col);
  state.col = 0;
}

function deleteToEndOfLine(state: EditorState): void {
  const line = state.lines[state.row]!;
  state.lines[state.row] = line.slice(0, state.col);
}

function deleteWordLeft(state: EditorState): void {
  const line = state.lines[state.row]!;
  if (state.col === 0) {
    handleBackspace(state);
    return;
  }
  let i = state.col;
  // Skip trailing spaces
  while (i > 0 && /\s/.test(line[i - 1]!)) i -= 1;
  // Then consume non-spaces
  while (i > 0 && !/\s/.test(line[i - 1]!)) i -= 1;
  state.lines[state.row] = line.slice(0, i) + line.slice(state.col);
  state.col = i;
}

function moveWordLeft(state: EditorState): void {
  const line = state.lines[state.row]!;
  let i = state.col;
  while (i > 0 && /\s/.test(line[i - 1]!)) i -= 1;
  while (i > 0 && !/\s/.test(line[i - 1]!)) i -= 1;
  state.col = i;
}

function moveWordRight(state: EditorState): void {
  const line = state.lines[state.row]!;
  let i = state.col;
  while (i < line.length && /\s/.test(line[i]!)) i += 1;
  while (i < line.length && !/\s/.test(line[i]!)) i += 1;
  state.col = i;
}

function insertChar(state: EditorState, ch: string): void {
  // ch may be a multi-character grapheme; just insert as-is.
  const line = state.lines[state.row]!;
  state.lines[state.row] = line.slice(0, state.col) + ch + line.slice(state.col);
  state.col += ch.length;
}

/**
 * Number of terminal rows a single rendered line occupies, given its prompt
 * width, content visual width, and the terminal's column count. A line that
 * fills `cols` exactly visually occupies one row in most terminals (the
 * cursor parks at the "phantom column" until the next char arrives) — we
 * round up so we still clear/redraw the second row when one exists.
 */
function rowsForLine(promptWidth: number, contentWidth: number, cols: number): number {
  if (cols <= 0) return 1;
  const total = promptWidth + contentWidth;
  if (total === 0) return 1;
  return Math.max(1, Math.ceil(total / cols));
}

/** Resolve the terminal column count, with a sane default for non-TTY streams. */
function getCols(out: NodeJS.WriteStream): number {
  const c = (out as { columns?: number }).columns;
  return typeof c === 'number' && c > 0 ? c : 80;
}

/** Render-state pair returned by `redrawCurrentLine` and threaded through the input loop. */
export interface RedrawState {
  /** Total terminal rows the last render occupied. */
  readonly termRows: number;
  /** 0-indexed terminal row of the cursor at the end of the last render, measured from the top of the render. */
  readonly cursorRowFromTop: number;
}

/**
 * Re-render the buffer from the prompt position.
 *
 * IMPORTANT: this routine tracks **terminal rows**, not logical lines. A
 * single logical line whose visual width plus prompt exceeds the terminal
 * column count wraps to two or more terminal rows; an earlier version of
 * this function conflated the two and left a trail of stale prompts behind
 * each keystroke once a line wrapped (the original wrap-smearing bug).
 *
 * It also tracks the **row offset of the cursor at the end of the previous
 * render** (`cursorRowFromTop`). The cursor doesn't always end at the bottom
 * row of the previous render — when the user presses Home, word-left, etc.,
 * the previous redraw left the cursor at the *target* row, which can be the
 * top of the render. If we naively did `cursorUp(prevTermRows - 1)` from
 * there, we'd land *above* the input area and `\x1b[J` would wipe the
 * unrelated row above plus shift content visually up by one row on each
 * keystroke (the symptom: word-motion makes the line "creep up").
 *
 * Strategy:
 *   1. Move cursor up by exactly `prev.cursorRowFromTop` rows to reach the
 *      top of the previous render, then `\r` to col 0.
 *   2. Erase from cursor to end of screen (`\x1b[J`). One terminal-native
 *      op that handles any number of rows correctly, even if our row count
 *      is stale.
 *   3. Redraw all logical lines — the terminal handles soft-wrap.
 *   4. Position the cursor by computing the target terminal row/column.
 *   5. Return the new render state so the next call knows where the cursor
 *      now sits.
 *
 * Caveat: still does not react to mid-edit terminal resizes (SIGWINCH).
 */
export function redrawCurrentLine(
  state: EditorState,
  prompt: string,
  continuationPrompt: string,
  out: NodeJS.WriteStream,
  prev: RedrawState,
): RedrawState {
  const cols = getCols(out);

  // Move to the top-left of the previous render. Use cursorRowFromTop —
  // NOT prevTermRows-1 — because the cursor may have been positioned
  // anywhere in the prior render (e.g. on the top row after word-left to
  // start of line). cursorUp(prevTermRows-1) from anywhere except the
  // bottom row would overshoot above the input area.
  if (prev.cursorRowFromTop > 0) {
    out.write(cursorUp(prev.cursorRowFromTop));
  }
  out.write('\r');
  // Clear from here to end of screen — a single ANSI op that handles any
  // number of rows correctly, including when our row count is stale.
  out.write('\x1b[J');

  // Draw all logical lines — terminal handles soft-wrap.
  const promptWFirst = visualWidth(prompt);
  const promptWCont = visualWidth(continuationPrompt);
  for (let i = 0; i < state.lines.length; i++) {
    const p = i === 0 ? prompt : continuationPrompt;
    out.write(p + state.lines[i]!);
    if (i < state.lines.length - 1) out.write('\n');
  }

  // Compute total terminal rows the new render occupies.
  let totalTermRows = 0;
  for (let i = 0; i < state.lines.length; i++) {
    const pw = i === 0 ? promptWFirst : promptWCont;
    totalTermRows += rowsForLine(pw, state.lines[i]!.length, cols);
  }

  // Compute the target cursor position in terminal-row / terminal-col space.
  let targetRowAbs = 0;
  for (let i = 0; i < state.row; i++) {
    const pw = i === 0 ? promptWFirst : promptWCont;
    targetRowAbs += rowsForLine(pw, state.lines[i]!.length, cols);
  }
  const promptWidthForActive = state.row === 0 ? promptWFirst : promptWCont;
  const cursorVisualOffset = promptWidthForActive + state.col;
  const subRow = Math.floor(cursorVisualOffset / cols);
  const targetCol = cursorVisualOffset % cols;
  targetRowAbs += subRow;

  // After the draw, terminal cursor is at the end of the last logical line
  // (i.e. row totalTermRows - 1).
  const currentRowAbs = totalTermRows - 1;

  // Move vertically to target row.
  const rowDelta = currentRowAbs - targetRowAbs;
  if (rowDelta > 0) {
    out.write(cursorUp(rowDelta));
  } else if (rowDelta < 0) {
    out.write(cursorDown(-rowDelta));
  }
  // Snap horizontally: \r → col 0, then advance to targetCol.
  out.write('\r');
  if (targetCol > 0) {
    out.write(cursorRight(targetCol));
  }

  return { termRows: totalTermRows, cursorRowFromTop: targetRowAbs };
}

/** Initial RedrawState for the very first redraw call (just-printed prompt, cursor on prompt row). */
export const INITIAL_REDRAW_STATE: RedrawState = { termRows: 1, cursorRowFromTop: 0 };

/** ANSI-aware visual width — strips CSI/SS3 sequences. */
export function visualWidth(s: string): number {
  // Strip ANSI escapes
  const stripped = s.replace(/\x1b(\[[0-9;?]*[A-Za-z]|O.|.)/g, '');
  return stripped.length;
}

/** Default prompt strings. */
export const DEFAULT_PROMPT = `${GREEN}You>${RESET} `;
export const DEFAULT_CONTINUATION = `${GREEN} ..${RESET} `;

/* ---------- Escape buffer dispatch ---------- */

interface KeyAction {
  /** What kind of key did we resolve? */
  kind:
    | 'enter' | 'newline' | 'ctrlc' | 'ctrld' | 'backspace'
    | 'left' | 'right' | 'up' | 'down'
    | 'home' | 'end' | 'delete'
    | 'word-left' | 'word-right'
    | 'word-back-delete'
    | 'line-back-delete' | 'line-fwd-delete'
    | 'unknown';
}

/**
 * Map a fully-framed escape sequence (without the leading 0x1B) into a key
 * action, or `null` if it doesn't match any known binding.
 *
 * The leading ESC byte has already been consumed by the framer; `seq` is what
 * follows (e.g. for arrow up the framer passes `[A`).
 */
export function resolveEscapeSequence(seq: string): KeyAction | null {
  // Shift+Enter via xterm modifyOtherKeys=2: ESC + [27;2;13~
  if (seq === '[27;2;13~') return { kind: 'newline' };
  // Shift+Enter via Kitty/Ghostty CSI-u: ESC + [13;2u
  if (seq === '[13;2u') return { kind: 'newline' };
  // Alt+Enter / some Shift+Enter: ESC + \r
  if (seq === '\r') return { kind: 'newline' };
  // ESC + LF
  if (seq === '\n') return { kind: 'newline' };
  // SS3 Enter (legacy Shift+Enter on some terms): ESC + OM
  if (seq === 'OM') return { kind: 'newline' };

  // Arrows
  if (seq === '[A') return { kind: 'up' };
  if (seq === '[B') return { kind: 'down' };
  if (seq === '[C') return { kind: 'right' };
  if (seq === '[D') return { kind: 'left' };

  // Home / End — multiple variants
  if (seq === '[H' || seq === 'OH' || seq === '[1~' || seq === '[7~') return { kind: 'home' };
  if (seq === '[F' || seq === 'OF' || seq === '[4~' || seq === '[8~') return { kind: 'end' };

  // Delete
  if (seq === '[3~') return { kind: 'delete' };

  // Cmd+Backspace (iTerm2)
  if (seq === '[3;9~') return { kind: 'line-back-delete' };

  // Word motion
  if (seq === '[1;3D' || seq === '[1;5D') return { kind: 'word-left' };
  if (seq === '[1;3C' || seq === '[1;5C') return { kind: 'word-right' };

  // Cmd+←/→ (iTerm2)
  if (seq === '[1;9D' || seq === '[1;2H') return { kind: 'home' };
  if (seq === '[1;9C' || seq === '[1;2F') return { kind: 'end' };

  // Alt+b / Alt+f (legacy)
  if (seq === 'b') return { kind: 'word-left' };
  if (seq === 'f') return { kind: 'word-right' };

  // Alt+Backspace (ESC + 0x7F)
  if (seq === '\x7f' || seq === '\x08') return { kind: 'word-back-delete' };

  return null;
}

/**
 * Frame an incoming raw byte into one of:
 *   - `null` — still buffering, no dispatch
 *   - `{ kind: 'sequence', seq: string }` — a complete escape sequence (without leading ESC)
 *   - `{ kind: 'discard' }` — buffer overflow / safety cap
 *
 * Internal state is held in `framerBuf` between calls. The framer recognises:
 *
 *   ESC + '[' …  CSI: dispatch when a final byte (0x40–0x7E) arrives AFTER `[`
 *   ESC + 'O' x  SS3: dispatch at exactly 3 bytes total
 *   ESC + ch    : single-char ESC dispatch at 2 bytes (where ch ∉ {'[', 'O'})
 *
 * `framerBuf` always starts with the literal '\x1b' once we are in escape-mode.
 */
export interface FramerState {
  buf: string;
}

export function newFramerState(): FramerState {
  return { buf: '' };
}

export type FramerOutcome =
  | { kind: 'sequence'; seq: string }
  | { kind: 'discard' }
  | { kind: 'incomplete' };

const SAFETY_CAP = 16; // bytes including leading ESC

export function feedFramer(state: FramerState, byte: number): FramerOutcome {
  // First byte must be ESC (0x1B); caller is expected to only call us once
  // an ESC has been observed (state.buf starts with '\x1b').
  if (state.buf.length === 0) {
    if (byte !== 0x1b) {
      // Defensive: pass through as unknown, no dispatch
      return { kind: 'incomplete' };
    }
    state.buf = '\x1b';
    return { kind: 'incomplete' };
  }

  const ch = String.fromCharCode(byte); // byte-level only; never used for printable text
  state.buf += ch;

  if (state.buf.length > SAFETY_CAP) {
    state.buf = '';
    return { kind: 'discard' };
  }

  // After ESC, second byte determines mode
  if (state.buf.length === 2) {
    const second = state.buf[1]!;
    if (second === '[') {
      // CSI — keep accumulating until final byte 0x40–0x7E AFTER `[`
      return { kind: 'incomplete' };
    }
    if (second === 'O') {
      // SS3 — needs exactly 3 bytes; not done yet
      return { kind: 'incomplete' };
    }
    // ESC + char — dispatch immediately
    const seq = state.buf.slice(1);
    state.buf = '';
    return { kind: 'sequence', seq };
  }

  // CSI: dispatch on first 0x40–0x7E byte AFTER the `[`
  if (state.buf[1] === '[') {
    if (state.buf.length >= 3 && byte >= 0x40 && byte <= 0x7e) {
      const seq = state.buf.slice(1);
      state.buf = '';
      return { kind: 'sequence', seq };
    }
    return { kind: 'incomplete' };
  }

  // SS3: dispatch at exactly 3 bytes
  if (state.buf[1] === 'O' && state.buf.length === 3) {
    const seq = state.buf.slice(1);
    state.buf = '';
    return { kind: 'sequence', seq };
  }

  return { kind: 'incomplete' };
}

/* ---------- Public reader ---------- */

export type ReadResult =
  | { kind: 'submit'; text: string }
  | { kind: 'sigint' }
  | { kind: 'eof' };

/**
 * Drive `readInput` from an arbitrary readable stream. Returns a promise that
 * resolves with the user's input or rejects with a SIGINT/EOF marker.
 *
 * Designed to be testable: callers can pass a PassThrough as `stdin` (with
 * isTTY = true and a no-op setRawMode) and an in-memory writable as `stdout`.
 */
export function readInput(opts: ReadInputOptions): Promise<string> {
  const stdin = opts.stdin ?? (process.stdin as NodeJS.ReadStream);
  const stdout = opts.stdout ?? (process.stdout as NodeJS.WriteStream);
  const prompt = opts.prompt;
  const continuationPrompt = opts.continuationPrompt;
  const history = opts.inputHistory;

  return new Promise<string>((resolve, reject) => {
    const state: EditorState = {
      lines: [''],
      col: 0,
      row: 0,
      histIdx: history.length,
      draft: [''],
    };
    const decoder: Utf8Decoder = createUtf8Decoder();
    const framer = newFramerState();
    let inEscape = false;
    let prevLines: RedrawState = INITIAL_REDRAW_STATE;

    if (typeof stdin.setRawMode === 'function') {
      try { stdin.setRawMode(true); } catch { /* tolerated for non-TTY tests */ }
    }
    stdin.resume();

    // Initial render
    stdout.write(prompt);

    const onData = (data: Buffer): void => {
      for (const byte of data) {
        // In-flight escape sequence — feed framer first
        if (inEscape) {
          const outcome = feedFramer(framer, byte);
          if (outcome.kind === 'incomplete') continue;
          if (outcome.kind === 'discard') {
            inEscape = false;
            continue;
          }
          inEscape = false;
          dispatchSequence(outcome.seq);
          prevLines = redrawCurrentLine(state, prompt, continuationPrompt, stdout, prevLines);
          continue;
        }

        // Control bytes
        if (byte === 0x1b) {
          inEscape = true;
          framer.buf = '';
          feedFramer(framer, byte);
          continue;
        }
        if (byte === 0x03) { // Ctrl+C
          stdout.write('\n');
          cleanup();
          reject(new Error('SIGINT'));
          return;
        }
        if (byte === 0x04) { // Ctrl+D
          if (state.lines.length === 1 && state.lines[0] === '') {
            stdout.write('\n');
            cleanup();
            reject(new Error('EOF'));
            return;
          }
          continue;
        }
        if (byte === 0x0d) { // Enter (CR) — submit
          stdout.write('\n');
          cleanup();
          resolve(state.lines.join('\n'));
          return;
        }
        if (byte === 0x0a) { // Ctrl+J / LF — newline
          insertNewline(state);
          prevLines = redrawCurrentLine(state, prompt, continuationPrompt, stdout, prevLines);
          continue;
        }
        if (byte === 0x7f || byte === 0x08) { // Backspace
          handleBackspace(state);
          prevLines = redrawCurrentLine(state, prompt, continuationPrompt, stdout, prevLines);
          continue;
        }
        if (byte === 0x01) { // Ctrl+A
          state.col = 0;
          prevLines = redrawCurrentLine(state, prompt, continuationPrompt, stdout, prevLines);
          continue;
        }
        if (byte === 0x05) { // Ctrl+E
          state.col = state.lines[state.row]!.length;
          prevLines = redrawCurrentLine(state, prompt, continuationPrompt, stdout, prevLines);
          continue;
        }
        if (byte === 0x0b) { // Ctrl+K
          deleteToEndOfLine(state);
          prevLines = redrawCurrentLine(state, prompt, continuationPrompt, stdout, prevLines);
          continue;
        }
        if (byte === 0x15) { // Ctrl+U
          deleteToStartOfLine(state);
          prevLines = redrawCurrentLine(state, prompt, continuationPrompt, stdout, prevLines);
          continue;
        }
        if (byte === 0x17) { // Ctrl+W
          deleteWordLeft(state);
          prevLines = redrawCurrentLine(state, prompt, continuationPrompt, stdout, prevLines);
          continue;
        }
        if (byte < 0x20) {
          // Other control bytes — ignore silently
          continue;
        }

        // Printable byte — through UTF-8 decoder
        const ch = decoder.write(byte);
        if (ch.length > 0) {
          insertChar(state, ch);
          prevLines = redrawCurrentLine(state, prompt, continuationPrompt, stdout, prevLines);
        }
      }
    };

    function dispatchSequence(seq: string): void {
      const action = resolveEscapeSequence(seq);
      if (!action) return; // unknown — drop silently per spec §5.1
      switch (action.kind) {
        case 'newline':
          insertNewline(state);
          break;
        case 'left':
          if (state.col > 0) state.col -= 1;
          else if (state.row > 0) {
            state.row -= 1;
            state.col = state.lines[state.row]!.length;
          }
          break;
        case 'right':
          if (state.col < state.lines[state.row]!.length) state.col += 1;
          else if (state.row < state.lines.length - 1) {
            state.row += 1;
            state.col = 0;
          }
          break;
        case 'up':
          if (state.row > 0) {
            state.row -= 1;
            state.col = Math.min(state.col, state.lines[state.row]!.length);
          } else {
            // Edge: navigate history backwards
            historyPrev();
          }
          break;
        case 'down':
          if (state.row < state.lines.length - 1) {
            state.row += 1;
            state.col = Math.min(state.col, state.lines[state.row]!.length);
          } else {
            historyNext();
          }
          break;
        case 'home':
          state.col = 0;
          break;
        case 'end':
          state.col = state.lines[state.row]!.length;
          break;
        case 'delete':
          deleteCharAtCursor(state);
          break;
        case 'word-left':
          moveWordLeft(state);
          break;
        case 'word-right':
          moveWordRight(state);
          break;
        case 'word-back-delete':
          deleteWordLeft(state);
          break;
        case 'line-back-delete':
          deleteToStartOfLine(state);
          break;
        case 'line-fwd-delete':
          deleteToEndOfLine(state);
          break;
        case 'unknown':
        case 'enter':
        case 'newline':
        case 'ctrlc':
        case 'ctrld':
        case 'backspace':
          break;
      }
    }

    function historyPrev(): void {
      if (history.length === 0) return;
      if (state.histIdx === history.length) {
        state.draft = [...state.lines];
      }
      if (state.histIdx > 0) state.histIdx -= 1;
      replaceInput(state, history[state.histIdx]!);
    }

    function historyNext(): void {
      if (history.length === 0) return;
      if (state.histIdx < history.length) state.histIdx += 1;
      if (state.histIdx === history.length) {
        replaceInput(state, state.draft.join('\n'));
      } else {
        replaceInput(state, history[state.histIdx]!);
      }
    }

    function cleanup(): void {
      stdin.off('data', onData);
      if (typeof stdin.setRawMode === 'function') {
        try { stdin.setRawMode(false); } catch { /* tolerated */ }
      }
      stdin.pause();
    }

    stdin.on('data', onData);
  });
}

/* ---------- Helpers exported for testing ---------- */

export const __test__ = {
  insertChar,
  deleteCharAtCursor,
  deleteToStartOfLine,
  deleteToEndOfLine,
  deleteWordLeft,
  moveWordLeft,
  moveWordRight,
};
