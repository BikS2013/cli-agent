/**
 * ANSI escape constants and cursor helpers for the cli-agent TUI.
 *
 * Inline ANSI per spec §6 — no external dependencies.
 */

export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const GREEN = '\x1b[32m';
export const CYAN = '\x1b[36m';
export const YELLOW = '\x1b[33m';
export const RED = '\x1b[31m';
export const MAGENTA = '\x1b[35m';
export const BLUE = '\x1b[34m';

/** `\r` + clear-to-end-of-line. */
export const CLEAR_LINE = '\r\x1b[2K';

export function clearLine(): string {
  return CLEAR_LINE;
}
export function cursorUp(n: number = 1): string {
  return `\x1b[${n}A`;
}
export function cursorDown(n: number = 1): string {
  return `\x1b[${n}B`;
}
export function cursorRight(n: number = 1): string {
  return `\x1b[${n}C`;
}
export function cursorLeft(n: number = 1): string {
  return `\x1b[${n}D`;
}
export function saveCursor(): string {
  return '\x1b[s';
}
export function restoreCursor(): string {
  return '\x1b[u';
}

export function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}
export function bold(s: string): string {
  return `${BOLD}${s}${RESET}`;
}
export function green(s: string): string {
  return `${GREEN}${s}${RESET}`;
}
export function cyan(s: string): string {
  return `${CYAN}${s}${RESET}`;
}
export function yellow(s: string): string {
  return `${YELLOW}${s}${RESET}`;
}
export function red(s: string): string {
  return `${RED}${s}${RESET}`;
}
