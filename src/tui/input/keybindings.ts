/**
 * Documented keybinding map for the cli-agent TUI.
 *
 * Used by /help to render a consistent legend. Every entry here MUST be
 * implemented by the line-editor.
 */

export interface KeybindingDoc {
  readonly keys: string;
  readonly action: string;
}

export const KEYBINDINGS: ReadonlyArray<KeybindingDoc> = [
  { keys: 'Enter', action: 'submit current input' },
  { keys: 'Shift+Enter / Ctrl+J', action: 'insert newline (Shift+Enter requires CSI-u-capable terminal; Ctrl+J always works)' },
  { keys: '←/→', action: 'move cursor left/right within the line' },
  { keys: '↑/↓', action: 'move between input lines, or browse input history at top/bottom' },
  { keys: 'Home / End', action: 'cursor to start/end of line' },
  { keys: 'Ctrl+A / Ctrl+E', action: 'cursor to start/end of line' },
  { keys: 'Option+←/→', action: 'word-by-word motion (also Ctrl+←/→)' },
  { keys: 'Backspace', action: 'delete char left, or merge lines at column 0' },
  { keys: 'Delete', action: 'delete char at cursor' },
  { keys: 'Ctrl+W / Alt+Backspace', action: 'delete word left' },
  { keys: 'Ctrl+U', action: 'delete to start of line' },
  { keys: 'Ctrl+K', action: 'delete to end of line' },
  { keys: 'Ctrl+C', action: 'during input: clear buffer; during execution: abort agent' },
  { keys: 'Ctrl+D', action: 'on empty input: exit the TUI' },
  { keys: 'ESC', action: 'during execution: abort agent' },
  { keys: 'Tab', action: '(reserved — collapsible tool-call expansion in a future update)' },
];
