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

import { GREEN, RESET, CLEAR_LINE, cursorUp, cursorDown, cursorLeft } from '../ansi.js';
import { createUtf8Decoder, type Utf8Decoder } from '../utf8.js';

export interface ReadInputOptions {
  readonly prompt: string;
  readonly continuationPrompt: string;
  readonly inputHistory: string[];
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
}

interface EditorState {
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
 * Re-render the buffer from the prompt position.
 *
 * Strategy: walk back to the prompt origin (number of buffer lines − row), clear
 * each line, redraw all lines, then position cursor on the right line + column.
 *
 * Returns the number of lines we are now occupying (useful for the caller to
 * track when transitioning into agent output).
 */
export function redrawCurrentLine(
  state: EditorState,
  prompt: string,
  continuationPrompt: string,
  out: NodeJS.WriteStream,
  prevLines: number,
): number {
  // Move to top of previous render
  if (prevLines > 1) {
    out.write(cursorUp(prevLines - 1));
  }
  out.write('\r');
  // Clear all lines we previously occupied
  for (let i = 0; i < prevLines; i++) {
    out.write(CLEAR_LINE);
    if (i < prevLines - 1) out.write('\n');
  }
  // Move back to top
  if (prevLines > 1) {
    out.write(cursorUp(prevLines - 1));
  }
  out.write('\r');

  // Draw all lines
  for (let i = 0; i < state.lines.length; i++) {
    const p = i === 0 ? prompt : continuationPrompt;
    out.write(p + state.lines[i]!);
    if (i < state.lines.length - 1) out.write('\n');
  }

  // Position cursor on the right line + column
  const linesAfter = state.lines.length - 1 - state.row;
  if (linesAfter > 0) {
    out.write(cursorUp(linesAfter));
  }
  // Cursor is at end of the active line; move it to col + prompt-width
  const promptWidth = state.row === 0 ? visualWidth(prompt) : visualWidth(continuationPrompt);
  const lineLen = state.lines[state.row]!.length;
  const desiredCol = promptWidth + state.col;
  const currentCol = promptWidth + lineLen;
  if (currentCol > desiredCol) {
    out.write(cursorLeft(currentCol - desiredCol));
  }

  return state.lines.length;
}

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
    let prevLines = 1;

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
