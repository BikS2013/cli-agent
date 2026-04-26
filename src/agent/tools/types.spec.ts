import { describe, it, expect } from 'vitest';
import { truncateToolResult } from './types.js';

describe('truncateToolResult', () => {
  it('returns full JSON when under budget', () => {
    const result = truncateToolResult({ foo: 'bar' }, 10000);
    expect(JSON.parse(result)).toEqual({ foo: 'bar' });
  });

  it('truncates array by dropping tail entries', () => {
    const arr = Array.from({ length: 100 }, (_, i) => ({ id: i, data: 'x'.repeat(100) }));
    const result = truncateToolResult(arr, 1000);
    const parsed = JSON.parse(result);
    expect(parsed.__truncated).toBe(true);
    expect(parsed.original).toBe(100);
    expect(parsed.kept).toBeLessThan(100);
  });

  it('returns __truncated wrapper for large object', () => {
    const obj = { key: 'x'.repeat(10000) };
    const result = truncateToolResult(obj, 100);
    const parsed = JSON.parse(result);
    expect(parsed.__truncated).toBe(true);
    expect(parsed.raw).toBeDefined();
  });

  it('always returns valid JSON', () => {
    const large = { a: 'x'.repeat(100000) };
    const result = truncateToolResult(large, 50);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('preserves array items that fit within budget', () => {
    const arr = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const result = truncateToolResult(arr, 10000);
    expect(JSON.parse(result)).toEqual(arr);
  });
});
