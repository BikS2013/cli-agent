/**
 * Braille spinner for the cli-agent TUI.
 *
 * Each instance owns its own line and animation. Multiple instances may run
 * concurrently (one per in-flight tool call + one for the model call).
 *
 * Per spec §4 / §6: 80 ms tick, ANSI save/restore wrap.
 */

import { CLEAR_LINE, DIM, RESET, YELLOW, saveCursor, restoreCursor } from './ansi.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const TICK_MS = 80;

export interface Spinner {
  setLabel(s: string): void;
  start(): void;
  stop(): void;
  isActive(): boolean;
}

export interface SpinnerOptions {
  /** Where to write frames. Defaults to process.stdout. */
  readonly stream?: NodeJS.WritableStream;
  /** ms between frames. Defaults to 80. */
  readonly tickMs?: number;
}

export function createSpinner(initialLabel: string, opts: SpinnerOptions = {}): Spinner {
  const stream = opts.stream ?? process.stdout;
  const tickMs = opts.tickMs ?? TICK_MS;
  let label = initialLabel;
  let frame = 0;
  let timer: NodeJS.Timeout | null = null;

  function paint(): void {
    const f = FRAMES[frame % FRAMES.length]!;
    stream.write(`${saveCursor()}${CLEAR_LINE}${YELLOW}${f}${RESET} ${DIM}${label}${RESET}${restoreCursor()}`);
    frame += 1;
  }

  return {
    setLabel(s: string): void {
      label = s;
    },
    start(): void {
      if (timer !== null) return;
      paint();
      timer = setInterval(paint, tickMs);
      // Don't keep the event loop alive solely for spinner animation
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop(): void {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
      stream.write(`${saveCursor()}${CLEAR_LINE}${restoreCursor()}`);
    },
    isActive(): boolean {
      return timer !== null;
    },
  };
}

/** Exposed for tests. */
export const SPINNER_FRAMES = FRAMES;
