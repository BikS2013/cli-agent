/**
 * Slash-command registry + dispatcher for the cli-agent TUI.
 *
 * Each command exports an object matching SlashCommand. The dispatcher
 * resolves names + aliases, and invokes `run(ctx, args)`.
 */

import type { TuiController } from '../controller.js';

export interface SlashCommand {
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly summary: string;
  run(ctx: SlashContext, args: string[]): Promise<void>;
}

export interface SlashContext {
  readonly controller: TuiController;
  /** Append a line to the rendered transcript using a [system] prefix. */
  printSystem(text: string): void;
  /** Append a plain line (no prefix). */
  println(text: string): void;
}

const COMMANDS: SlashCommand[] = [];

export function registerCommand(cmd: SlashCommand): void {
  COMMANDS.push(cmd);
}

export function listCommands(): ReadonlyArray<SlashCommand> {
  return COMMANDS;
}

export function findCommand(name: string): SlashCommand | undefined {
  // Case-sensitive per spec — user-reported `/Quit` should be unknown.
  for (const c of COMMANDS) {
    if (c.name === name) return c;
    if (c.aliases?.includes(name)) return c;
  }
  return undefined;
}

/**
 * Parse a typed line that begins with `/` into command + args (whitespace-split,
 * with quoted strings preserved).
 */
export function parseSlashLine(line: string): { name: string; args: string[] } {
  const trimmed = line.trim();
  const tokens = trimmed.match(/(?:[^\s"]+|"[^"]*")/g) ?? [];
  const head = tokens[0] ?? '';
  const args = tokens.slice(1).map((t) => (t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t));
  return { name: head, args };
}

/** Returns true if the line was a recognized command and was dispatched. */
export async function dispatchSlash(line: string, ctx: SlashContext): Promise<boolean> {
  const { name, args } = parseSlashLine(line);
  const cmd = findCommand(name);
  if (!cmd) {
    ctx.printSystem(`unknown command: ${name} — try /help`);
    return true; // still consumed as a slash attempt
  }
  await cmd.run(ctx, args);
  return true;
}

/** Reset the registry (used by tests). */
export function _testReset(): void {
  COMMANDS.length = 0;
}
