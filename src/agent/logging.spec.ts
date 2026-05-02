/**
 * Logging tests: event kinds, redaction, field truncation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { createLogger, newTurnId, type LogEvent } from './logging.js';

// Mock fs to capture written lines
const writtenLines: string[] = [];
vi.spyOn(fs, 'openSync').mockReturnValue(42 as unknown as number);
vi.spyOn(fs, 'writeSync').mockImplementation((_fd, data) => {
  writtenLines.push(String(data));
  return 0;
});
vi.spyOn(fs, 'closeSync').mockImplementation(() => undefined);
vi.spyOn(fs, 'fsyncSync').mockImplementation(() => undefined);
vi.spyOn(fs, 'fchmodSync').mockImplementation(() => undefined);
vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);
vi.spyOn(fs, 'chmodSync').mockImplementation(() => undefined);
vi.spyOn(fs, 'symlinkSync').mockImplementation(() => undefined);
vi.spyOn(fs, 'unlinkSync').mockImplementation(() => undefined);

describe('createLogger', () => {
  beforeEach(() => {
    writtenLines.length = 0;
  });

  it('creates a logger with a sessionId', () => {
    const logger = createLogger({ toolDir: '/tmp/.tool-agents/cli-agent', enabled: true });
    expect(logger.currentSessionId).toBeTruthy();
  });

  it('logs session_start event', () => {
    const logger = createLogger({ toolDir: '/tmp/.tool-agents/cli-agent', enabled: true });
    logger.log({
      kind: 'session_start',
      ts: new Date().toISOString(),
      sessionId: 'test-session',
      threadId: 'thread-1',
      provider: 'openai',
      model: 'gpt-4o',
      allowMutations: false,
      cliVersion: '0.1.0',
    });
    const line = writtenLines[writtenLines.length - 1];
    const event = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(event['kind']).toBe('session_start');
    expect(event['provider']).toBe('openai');
  });

  it('redacts API keys from logged events', () => {
    const logger = createLogger({ toolDir: '/tmp/.tool-agents/cli-agent', enabled: true });
    logger.log({
      kind: 'user_prompt',
      ts: new Date().toISOString(),
      sessionId: 'test',
      turnId: 'turn-1',
      prompt: 'My key is sk-abcdefghijklmnopqrstuvwxyz123456',
    });
    const line = writtenLines[writtenLines.length - 1] ?? '';
    expect(line).not.toContain('sk-abcdefghijklmnopqrstuvwxyz123456');
  });

  it('logs profile_active event with profile metadata (plan-005 AC-19)', () => {
    const logger = createLogger({ toolDir: '/tmp/.tool-agents/cli-agent', enabled: true });
    // Path crafted to stay under the 32-contiguous-base64-char redaction
    // window: dots, slashes, and short segments interspersed.
    const profilePath = '/tmp/p/review.yaml';
    const event: LogEvent = {
      kind: 'profile_active',
      ts: new Date().toISOString(),
      sessionId: 'test-session',
      profileName: 'review',
      profilePath,
      schemaVersion: 1,
      digest: 'a1b2c3d4',
    };
    logger.log(event);
    const line = writtenLines[writtenLines.length - 1];
    const parsed = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(parsed['kind']).toBe('profile_active');
    expect(parsed['profileName']).toBe('review');
    expect(parsed['profilePath']).toBe(profilePath);
    expect(parsed['schemaVersion']).toBe(1);
    expect(parsed['digest']).toBe('a1b2c3d4');
    expect(parsed['sessionId']).toBe('test-session');
  });

  it('null logger is a no-op', async () => {
    const logger = createLogger({ toolDir: '/tmp', enabled: false });
    const countBefore = writtenLines.length;
    logger.log({
      kind: 'session_end',
      ts: new Date().toISOString(),
      sessionId: 'test',
      reason: 'quit',
    });
    await logger.flush();
    await logger.close();
    expect(writtenLines.length).toBe(countBefore);
  });
});

describe('newTurnId', () => {
  it('generates unique turn IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => newTurnId()));
    expect(ids.size).toBeGreaterThan(90); // should be mostly unique
  });
});
