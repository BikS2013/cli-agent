/**
 * /resume slash registration + happy-path dispatch.
 *
 * The full hydration path is exercised end-to-end by checkpoint-store.spec
 * plus startTui's --resume tests; here we only confirm the command is
 * wired into the registry and bails cleanly when no prior thread exists.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findCommand, dispatchSlash, type SlashContext } from './registry.js';
// Side-effect import: /resume registers itself once at module load. We
// intentionally do NOT _testReset() between tests in this file — Node ESM
// caches the import, so a reset would wipe the registration without a
// clean way to re-trigger it.
import './resume.js';

let tmpHome: string;
let savedHome: string | undefined;

beforeEach(async () => {
  tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'cli-agent-resume-'));
  savedHome = process.env['HOME'];
  process.env['HOME'] = tmpHome;
});

afterEach(async () => {
  if (savedHome === undefined) {
    delete process.env['HOME'];
  } else {
    process.env['HOME'] = savedHome;
  }
  try { await fsp.rm(tmpHome, { recursive: true, force: true }); } catch { /* tolerated */ }
});

describe('/resume', () => {
  it('is registered as a slash command', () => {
    const cmd = findCommand('/resume');
    expect(cmd).toBeDefined();
    expect(cmd?.summary).toMatch(/resume/i);
  });

  it('reports a friendly hint when no prior session exists', async () => {
    const messages: string[] = [];
    const ctx: SlashContext = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      controller: { threadId: 'current' } as any,
      printSystem: (s) => messages.push(s),
      println: () => {},
    };
    await dispatchSlash('/resume', ctx);
    expect(messages.join('')).toMatch(/no prior session|cursor\.json/i);
  });
});
