import { handleToolError } from '../../errors.js';
export { handleToolError };

/**
 * Truncate a tool result to stay within the per-tool byte budget.
 * Arrays drop tail entries; objects get a truncated prefix wrapper.
 * Always returns valid JSON.
 */
export function truncateToolResult(obj: unknown, maxBytes: number): string {
  const full = JSON.stringify(obj);
  if (Buffer.byteLength(full, 'utf8') <= maxBytes) return full;

  if (Array.isArray(obj)) {
    const arr = [...obj];
    while (arr.length > 0) {
      arr.pop();
      const s = JSON.stringify({ __truncated: true, kept: arr.length, original: (obj as unknown[]).length, items: arr });
      if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
    }
    return JSON.stringify({ __truncated: true, kept: 0, original: (obj as unknown[]).length, items: [] });
  }

  const prefix = full.slice(0, Math.max(0, maxBytes - 64));
  return JSON.stringify({ __truncated: true, raw: prefix + '…TRUNCATED' });
}
