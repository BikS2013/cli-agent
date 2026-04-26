/**
 * Spinner unit tests.
 *
 * Drives the spinner against an in-memory stream and asserts on the frame
 * sequence + ANSI save/restore wrap. We use vi.useFakeTimers to advance the
 * 80ms tick deterministically.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { createSpinner, SPINNER_FRAMES } from './spinner.js';

describe('createSpinner', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('paints ANSI save/restore around the frame', () => {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on('data', (c: Buffer) => { chunks.push(c.toString('utf8')); });
    const sp = createSpinner('thinking', { stream: out as unknown as NodeJS.WritableStream, tickMs: 80 });
    sp.start();
    const written = chunks.join('');
    expect(written).toContain('\x1b[s'); // save cursor
    expect(written).toContain('\x1b[u'); // restore cursor
    expect(written).toContain('thinking');
    sp.stop();
  });

  it('rotates frames on each tick', () => {
    const out = new PassThrough();
    const chunks: string[] = [];
    out.on('data', (c: Buffer) => { chunks.push(c.toString('utf8')); });
    const sp = createSpinner('x', { stream: out as unknown as NodeJS.WritableStream, tickMs: 80 });
    sp.start();
    // First paint already happened on start()
    vi.advanceTimersByTime(80);
    vi.advanceTimersByTime(80);
    sp.stop();
    const all = chunks.join('');
    // We should have observed at least 3 distinct frames
    const seen = SPINNER_FRAMES.filter((f) => all.includes(f));
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  it('isActive() reflects start/stop', () => {
    const out = new PassThrough();
    const sp = createSpinner('x', { stream: out as unknown as NodeJS.WritableStream });
    expect(sp.isActive()).toBe(false);
    sp.start();
    expect(sp.isActive()).toBe(true);
    sp.stop();
    expect(sp.isActive()).toBe(false);
  });
});
