/**
 * Output-truncation helpers shared by `read`, `bash`, `webfetch`,
 * `grep`, and `list`.
 *
 * Two independent caps:
 *   - byte cap (utf-8 bytes; multi-byte safe via TextDecoder fatal:false
 *     trim-back)
 *   - line cap (split on /\r?\n/, join with "\n")
 *
 * The combined helper {@link truncate} runs the line cap first, then
 * the byte cap, so the consumer can supply either or both.
 *
 * On truncation, a footer line is appended:
 *     \n[truncated, X of Y bytes shown]
 *  or \n[truncated, X of Y lines shown]
 *
 * Returned metadata always includes both counters; line counters appear
 * only when the line variant ran.
 */
'use strict';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TruncationResult {
  /** The (possibly truncated) string the caller should emit. */
  readonly output: string;
  /** True when a truncation occurred. */
  readonly truncated: boolean;
  /** Total utf-8 byte length of the input prior to truncation. */
  readonly originalBytes: number;
  /** utf-8 byte length of the returned `output` (excluding any footer). */
  readonly returnedBytes: number;
  /** Total line count of the input (only present for line-variant runs). */
  readonly originalLines?: number;
  /** Returned line count (only present for line-variant runs). */
  readonly returnedLines?: number;
}

export interface TruncateOptions {
  readonly maxBytes?: number;
  readonly maxLines?: number;
}

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Produce a substring whose utf-8 byte length is ≤ `maxBytes`, walking
 * back to the previous valid character boundary if the naive slice
 * landed mid-multibyte.
 */
function sliceUtf8Safe(input: string, maxBytes: number): { slice: string; bytes: number } {
  if (maxBytes <= 0) return { slice: '', bytes: 0 };
  const bytes = utf8Encoder.encode(input);
  if (bytes.byteLength <= maxBytes) {
    return { slice: input, bytes: bytes.byteLength };
  }
  // Decode with fatal:false — invalid trailing bytes turn into U+FFFD,
  // which we then trim. Walk back until the decoded text round-trips
  // to a byte-length ≤ maxBytes (bounded loop).
  let cut = maxBytes;
  while (cut > 0) {
    const candidate = utf8Decoder.decode(bytes.subarray(0, cut));
    // Drop any trailing replacement chars produced by an interrupted
    // multi-byte sequence.
    const cleaned = candidate.replace(/�+$/u, '');
    const cleanedBytes = byteLength(cleaned);
    if (cleanedBytes <= maxBytes) {
      return { slice: cleaned, bytes: cleanedBytes };
    }
    cut--;
  }
  return { slice: '', bytes: 0 };
}

function buildBytesFooter(returned: number, total: number): string {
  return `\n[truncated, ${returned} of ${total} bytes shown]`;
}

function buildLinesFooter(returned: number, total: number): string {
  return `\n[truncated, ${returned} of ${total} lines shown]`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Cap `input` at `maxBytes` utf-8 bytes (multi-byte safe).
 *
 * If truncation occurs, the returned `output` includes a single-line
 * footer indicating the cut. `returnedBytes` reflects the size of the
 * truncated *content* (the footer is informational and not counted).
 */
export function truncateBytes(input: string, maxBytes: number): TruncationResult {
  if (!Number.isFinite(maxBytes) || maxBytes < 0) {
    throw new RangeError(`truncateBytes: maxBytes must be a non-negative finite number; got ${maxBytes}`);
  }
  const originalBytes = byteLength(input);
  if (originalBytes <= maxBytes) {
    return {
      output: input,
      truncated: false,
      originalBytes,
      returnedBytes: originalBytes,
    };
  }
  const { slice, bytes } = sliceUtf8Safe(input, maxBytes);
  const footer = buildBytesFooter(bytes, originalBytes);
  return {
    output: slice + footer,
    truncated: true,
    originalBytes,
    returnedBytes: bytes,
  };
}

/**
 * Cap `input` at `maxLines` lines. Newlines are normalised to "\n"
 * in the output.
 */
export function truncateLines(input: string, maxLines: number): TruncationResult {
  if (!Number.isFinite(maxLines) || maxLines < 0) {
    throw new RangeError(`truncateLines: maxLines must be a non-negative finite number; got ${maxLines}`);
  }
  const lines = input.split(/\r?\n/);
  const originalLines = lines.length;
  const originalBytes = byteLength(input);
  if (originalLines <= maxLines) {
    return {
      output: input,
      truncated: false,
      originalBytes,
      returnedBytes: originalBytes,
      originalLines,
      returnedLines: originalLines,
    };
  }
  const kept = lines.slice(0, maxLines).join('\n');
  const footer = buildLinesFooter(maxLines, originalLines);
  const returnedBytes = byteLength(kept);
  return {
    output: kept + footer,
    truncated: true,
    originalBytes,
    returnedBytes,
    originalLines,
    returnedLines: maxLines,
  };
}

/**
 * Run line-cap first, then byte-cap, propagating the `truncated` flag.
 * If neither cap is provided the input is returned unchanged.
 */
export function truncate(input: string, opts: TruncateOptions): TruncationResult {
  const { maxLines, maxBytes } = opts;

  let working = input;
  let truncatedAny = false;
  let originalBytes: number;
  let originalLines: number | undefined;
  let returnedLines: number | undefined;

  if (typeof maxLines === 'number') {
    const lineRes = truncateLines(working, maxLines);
    originalLines = lineRes.originalLines;
    returnedLines = lineRes.returnedLines;
    truncatedAny = truncatedAny || lineRes.truncated;
    // Re-take the working slice WITHOUT the synthetic footer when we
    // truncated, so the byte pass operates on real content.
    if (lineRes.truncated) {
      const lines = working.split(/\r?\n/);
      working = lines.slice(0, maxLines).join('\n');
    }
  }
  originalBytes = byteLength(input);

  if (typeof maxBytes === 'number') {
    const byteRes = truncateBytes(working, maxBytes);
    if (byteRes.truncated) {
      truncatedAny = true;
    }
    // The byte pass operates on `working` (already line-truncated). When
    // truncation happened anywhere, we use the byte pass output and
    // extend with the bytes footer; otherwise we keep the line-pass
    // output (with its line footer if applicable).
    if (truncatedAny) {
      // Recompute the cleaned slice (without footer) so we can re-attach
      // a single accurate footer reflecting the *final* byte length.
      const { slice, bytes } = sliceUtf8Safe(working, maxBytes);
      const final = slice + buildBytesFooter(bytes, originalBytes);
      const result: TruncationResult = {
        output: final,
        truncated: true,
        originalBytes,
        returnedBytes: bytes,
        ...(originalLines !== undefined ? { originalLines } : {}),
        ...(returnedLines !== undefined ? { returnedLines } : {}),
      };
      return result;
    }
    return {
      output: working,
      truncated: false,
      originalBytes,
      returnedBytes: byteRes.returnedBytes,
      ...(originalLines !== undefined ? { originalLines } : {}),
      ...(returnedLines !== undefined ? { returnedLines } : {}),
    };
  }

  if (truncatedAny) {
    // Line-only truncation occurred.
    const footer = buildLinesFooter(returnedLines as number, originalLines as number);
    const returnedBytes = byteLength(working);
    return {
      output: working + footer,
      truncated: true,
      originalBytes,
      returnedBytes,
      ...(originalLines !== undefined ? { originalLines } : {}),
      ...(returnedLines !== undefined ? { returnedLines } : {}),
    };
  }

  return {
    output: working,
    truncated: false,
    originalBytes,
    returnedBytes: byteLength(working),
    ...(originalLines !== undefined ? { originalLines } : {}),
    ...(returnedLines !== undefined ? { returnedLines } : {}),
  };
}
