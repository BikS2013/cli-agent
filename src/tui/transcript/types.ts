/**
 * Shared types for the TUI transcript / history persistence layer.
 */

export interface ToolCallRecord {
  readonly toolName: string;
  readonly args: unknown;
  readonly durationMs: number;
  readonly ok: boolean;
}

export interface TurnRecord {
  readonly ts: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface ThreadIndexEntry {
  readonly threadId: string;
  readonly startedAt: string;
  readonly lastTurnAt: string;
  readonly turnCount: number;
  readonly firstPrompt: string;
}

export interface CursorState {
  readonly lastThreadId: string;
  readonly lastTurnAt: string;
}
