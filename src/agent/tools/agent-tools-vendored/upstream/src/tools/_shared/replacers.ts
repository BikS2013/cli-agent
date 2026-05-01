/**
 * Nine-replacer chain ported from the upstream `edit.ts` reference at
 * `docs/reference/opencode/edit.ts`. The algorithms (not the Effect-TS
 * error handling) are reproduced here as pure functions so they are
 * trivially unit-testable: every function takes
 *   (original, oldStr, newStr, opts?) and returns either the rewritten
 *   string or `null` when the strategy did not apply.
 *
 * The orchestrator {@link applyReplacers} runs the strategies in the
 * order documented in the design, and is the only entry point callers
 * (e.g. the `edit`, `multiedit`, and `patch` tools) should use.
 *
 * Pure module: no IO, no side effects, no globals.
 */
'use strict';

// ---------------------------------------------------------------------------
// Replacer name constants (exported for diagnostics / metadata).
// ---------------------------------------------------------------------------

export const REPLACER_SIMPLE = 'simpleReplacer';
export const REPLACER_LINE_TRIMMED = 'lineTrimmedReplacer';
export const REPLACER_BLOCK_ANCHOR = 'blockAnchorReplacer';
export const REPLACER_WHITESPACE_NORMALIZED = 'whitespaceNormalizedReplacer';
export const REPLACER_INDENTATION_FLEXIBLE = 'indentationFlexibleReplacer';
export const REPLACER_ESCAPE_NORMALIZED = 'escapeNormalizedReplacer';
export const REPLACER_TRIMMED_BOUNDARY = 'trimmedBoundaryReplacer';
export const REPLACER_CONTEXT_AWARE = 'contextAwareReplacer';
export const REPLACER_MULTI_OCCURRENCE = 'multiOccurrenceReplacer';

export const REPLACER_NAMES = [
  REPLACER_SIMPLE,
  REPLACER_LINE_TRIMMED,
  REPLACER_BLOCK_ANCHOR,
  REPLACER_WHITESPACE_NORMALIZED,
  REPLACER_INDENTATION_FLEXIBLE,
  REPLACER_ESCAPE_NORMALIZED,
  REPLACER_TRIMMED_BOUNDARY,
  REPLACER_CONTEXT_AWARE,
  REPLACER_MULTI_OCCURRENCE,
] as const;

export type ReplacerName = (typeof REPLACER_NAMES)[number];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ApplyReplacerOptions {
  /**
   * Allow replacers that produce more-than-one candidate match to perform
   * the substitution at every site. Default: false (strict single-match).
   *
   * Note: even when this flag is `false`, candidate yields from the
   * non-MultiOccurrence strategies are still gated by uniqueness — the
   * effect of `allowMultiple` is to permit the {@link multiOccurrenceReplacer}
   * (last-resort) to write all occurrences, AND to fan out a single
   * `String.prototype.replaceAll` from earlier strategies when they
   * produced exactly one canonical match.
   */
  readonly allowMultiple?: boolean;
}

export interface ReplacerHit {
  /** New file content with the substitution applied. */
  readonly result: string;
  /** Identifier of the replacer that succeeded. */
  readonly replacerUsed: ReplacerName;
}

/**
 * Function shape every individual replacer adheres to.
 *
 * Returning `null` signals "this strategy does not apply"; the
 * orchestrator then tries the next strategy. A non-null return is
 * authoritative — the new content replaces the original.
 */
export type Replacer = (
  original: string,
  oldStr: string,
  newStr: string,
  opts?: ApplyReplacerOptions,
) => string | null;

// ---------------------------------------------------------------------------
// Helpers (private)
// ---------------------------------------------------------------------------

/**
 * Levenshtein distance — quadratic, no allocation tricks. Used by the
 * block-anchor replacer for similarity scoring.
 */
function levenshtein(a: string, b: string): number {
  if (a === '' || b === '') return Math.max(a.length, b.length);
  const aLen = a.length;
  const bLen = b.length;
  const matrix: number[][] = [];
  for (let i = 0; i <= aLen; i++) {
    const row: number[] = new Array<number>(bLen + 1);
    for (let j = 0; j <= bLen; j++) {
      row[j] = i === 0 ? j : j === 0 ? i : 0;
    }
    matrix[i] = row;
  }
  for (let i = 1; i <= aLen; i++) {
    const rowI = matrix[i] as number[];
    const rowPrev = matrix[i - 1] as number[];
    const aChar = a[i - 1];
    for (let j = 1; j <= bLen; j++) {
      const cost = aChar === b[j - 1] ? 0 : 1;
      const a1 = (rowPrev[j] as number) + 1;
      const a2 = (rowI[j - 1] as number) + 1;
      const a3 = (rowPrev[j - 1] as number) + cost;
      rowI[j] = Math.min(a1, a2, a3);
    }
  }
  return (matrix[aLen] as number[])[bLen] as number;
}

/**
 * Apply a candidate match `search` to `original`, returning the
 * rewritten content under single- or multi-occurrence semantics.
 *
 * Returns null when the candidate is ambiguous in single-occurrence
 * mode (more than one occurrence) so the orchestrator can move on.
 */
function applyCandidate(
  original: string,
  search: string,
  newStr: string,
  allowMultiple: boolean,
): string | null {
  const index = original.indexOf(search);
  if (index === -1) return null;
  if (allowMultiple) {
    return original.split(search).join(newStr);
  }
  const lastIndex = original.lastIndexOf(search);
  if (index !== lastIndex) return null;
  return original.substring(0, index) + newStr + original.substring(index + search.length);
}

// ---------------------------------------------------------------------------
// Replacer 1: simpleReplacer
//   Exact, single-occurrence string replace. Returns null if the literal
//   `oldStr` is not present, or is present more than once (under default
//   single-occurrence semantics).
// ---------------------------------------------------------------------------

export const simpleReplacer: Replacer = (original, oldStr, newStr, opts) => {
  if (oldStr.length === 0) return null;
  return applyCandidate(original, oldStr, newStr, opts?.allowMultiple === true);
};

// ---------------------------------------------------------------------------
// Replacer 2: lineTrimmedReplacer
//   Match while ignoring leading/trailing whitespace per line. Yields the
//   first matching block; ambiguity (>1 candidate) defers to the next
//   strategy under single-occurrence semantics.
// ---------------------------------------------------------------------------

export const lineTrimmedReplacer: Replacer = (original, oldStr, newStr, opts) => {
  const allowMultiple = opts?.allowMultiple === true;
  if (oldStr.length === 0) return null;

  const originalLines = original.split('\n');
  const searchLines = oldStr.split('\n');
  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }
  if (searchLines.length === 0) return null;

  const matches: string[] = [];
  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let ok = true;
    for (let j = 0; j < searchLines.length; j++) {
      const o = (originalLines[i + j] as string).trim();
      const s = (searchLines[j] as string).trim();
      if (o !== s) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;

    let startIdx = 0;
    for (let k = 0; k < i; k++) {
      startIdx += (originalLines[k] as string).length + 1;
    }
    let endIdx = startIdx;
    for (let k = 0; k < searchLines.length; k++) {
      endIdx += (originalLines[i + k] as string).length;
      if (k < searchLines.length - 1) endIdx += 1;
    }
    matches.push(original.substring(startIdx, endIdx));
  }

  for (const candidate of matches) {
    const rewrite = applyCandidate(original, candidate, newStr, allowMultiple);
    if (rewrite !== null) return rewrite;
  }
  return null;
};

// ---------------------------------------------------------------------------
// Replacer 3: blockAnchorReplacer
//   Match using the first and last lines as anchors; requires ≥3 lines.
//   Single-candidate: accept always (anchors are sufficient).
//   Multi-candidate: pick the highest-similarity (>= 0.3 threshold).
// ---------------------------------------------------------------------------

const BLOCK_ANCHOR_MULTI_THRESHOLD = 0.3;

export const blockAnchorReplacer: Replacer = (original, oldStr, newStr, opts) => {
  const allowMultiple = opts?.allowMultiple === true;
  const originalLines = original.split('\n');
  const searchLines = oldStr.split('\n');
  if (searchLines.length < 3) return null;
  if (searchLines[searchLines.length - 1] === '') searchLines.pop();
  if (searchLines.length < 3) return null;

  const firstLineSearch = (searchLines[0] as string).trim();
  const lastLineSearch = (searchLines[searchLines.length - 1] as string).trim();
  const searchBlockSize = searchLines.length;

  type Candidate = { startLine: number; endLine: number };
  const candidates: Candidate[] = [];
  for (let i = 0; i < originalLines.length; i++) {
    if ((originalLines[i] as string).trim() !== firstLineSearch) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if ((originalLines[j] as string).trim() === lastLineSearch) {
        candidates.push({ startLine: i, endLine: j });
        break;
      }
    }
  }
  if (candidates.length === 0) return null;

  function blockText(c: Candidate): string {
    let startIdx = 0;
    for (let k = 0; k < c.startLine; k++) {
      startIdx += (originalLines[k] as string).length + 1;
    }
    let endIdx = startIdx;
    for (let k = c.startLine; k <= c.endLine; k++) {
      endIdx += (originalLines[k] as string).length;
      if (k < c.endLine) endIdx += 1;
    }
    return original.substring(startIdx, endIdx);
  }

  if (candidates.length === 1) {
    // Anchors-only match is sufficient when there is exactly one candidate.
    const text = blockText(candidates[0] as Candidate);
    return applyCandidate(original, text, newStr, allowMultiple);
  }

  // Multiple candidates — score by mean middle-line similarity.
  let best: Candidate | null = null;
  let bestSim = -1;
  for (const c of candidates) {
    const actual = c.endLine - c.startLine + 1;
    const linesToCheck = Math.min(searchBlockSize - 2, actual - 2);
    let similarity = 0;
    if (linesToCheck > 0) {
      for (let j = 1; j < searchBlockSize - 1 && j < actual - 1; j++) {
        const o = (originalLines[c.startLine + j] as string).trim();
        const s = (searchLines[j] as string).trim();
        const maxLen = Math.max(o.length, s.length);
        if (maxLen === 0) continue;
        similarity += 1 - levenshtein(o, s) / maxLen;
      }
      similarity /= linesToCheck;
    } else {
      similarity = 1;
    }
    if (similarity > bestSim) {
      bestSim = similarity;
      best = c;
    }
  }
  if (best === null || bestSim < BLOCK_ANCHOR_MULTI_THRESHOLD) return null;
  const text = blockText(best);
  return applyCandidate(original, text, newStr, allowMultiple);
};

// ---------------------------------------------------------------------------
// Replacer 4: whitespaceNormalizedReplacer
//   Collapse internal whitespace runs to a single space for matching.
// ---------------------------------------------------------------------------

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const whitespaceNormalizedReplacer: Replacer = (original, oldStr, newStr, opts) => {
  const allowMultiple = opts?.allowMultiple === true;
  const norm = (t: string): string => t.replace(/\s+/g, ' ').trim();
  const normalizedFind = norm(oldStr);
  if (normalizedFind.length === 0) return null;

  const lines = original.split('\n');

  // Single-line mode
  for (const line of lines) {
    if (norm(line) === normalizedFind) {
      const rewrite = applyCandidate(original, line, newStr, allowMultiple);
      if (rewrite !== null) return rewrite;
    } else if (norm(line).includes(normalizedFind)) {
      const words = oldStr.trim().split(/\s+/);
      if (words.length > 0) {
        const pattern = words.map((w) => escapeRegex(w)).join('\\s+');
        try {
          const re = new RegExp(pattern);
          const m = line.match(re);
          if (m && m[0]) {
            const rewrite = applyCandidate(original, m[0], newStr, allowMultiple);
            if (rewrite !== null) return rewrite;
          }
        } catch {
          // Fall through.
        }
      }
    }
  }

  // Multi-line mode
  const findLines = oldStr.split('\n');
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length).join('\n');
      if (norm(block) === normalizedFind) {
        const rewrite = applyCandidate(original, block, newStr, allowMultiple);
        if (rewrite !== null) return rewrite;
      }
    }
  }

  return null;
};

// ---------------------------------------------------------------------------
// Replacer 5: indentationFlexibleReplacer
//   Strip the common minimum indent from `oldStr` and from each
//   candidate window before comparing.
// ---------------------------------------------------------------------------

export const indentationFlexibleReplacer: Replacer = (original, oldStr, newStr, opts) => {
  const allowMultiple = opts?.allowMultiple === true;

  const removeIndent = (text: string): string => {
    const lines = text.split('\n');
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    if (nonEmpty.length === 0) return text;
    const minIndent = Math.min(
      ...nonEmpty.map((l) => {
        const m = l.match(/^(\s*)/);
        return m && m[1] ? m[1].length : 0;
      }),
    );
    return lines.map((l) => (l.trim().length === 0 ? l : l.slice(minIndent))).join('\n');
  };

  const normalizedFind = removeIndent(oldStr);
  const contentLines = original.split('\n');
  const findLines = oldStr.split('\n');
  if (findLines.length === 0 || findLines.length > contentLines.length + 1) return null;

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join('\n');
    if (removeIndent(block) === normalizedFind) {
      const rewrite = applyCandidate(original, block, newStr, allowMultiple);
      if (rewrite !== null) return rewrite;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Replacer 6: escapeNormalizedReplacer
//   Handle `\n`/`\\n`, `\t`/`\\t`, and other escape mismatches between
//   oldStr (often LLM-emitted with literal backslashes) and content.
// ---------------------------------------------------------------------------

export const escapeNormalizedReplacer: Replacer = (original, oldStr, newStr, opts) => {
  const allowMultiple = opts?.allowMultiple === true;

  const unescape = (s: string): string =>
    s.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, captured: string) => {
      switch (captured) {
        case 'n':
          return '\n';
        case 't':
          return '\t';
        case 'r':
          return '\r';
        case "'":
          return "'";
        case '"':
          return '"';
        case '`':
          return '`';
        case '\\':
          return '\\';
        case '\n':
          return '\n';
        case '$':
          return '$';
        default:
          return match;
      }
    });

  const unescapedFind = unescape(oldStr);

  if (original.includes(unescapedFind)) {
    const rewrite = applyCandidate(original, unescapedFind, newStr, allowMultiple);
    if (rewrite !== null) return rewrite;
  }

  const lines = original.split('\n');
  const findLines = unescapedFind.split('\n');
  if (findLines.length === 0) return null;
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (unescape(block) === unescapedFind) {
      const rewrite = applyCandidate(original, block, newStr, allowMultiple);
      if (rewrite !== null) return rewrite;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Replacer 7: trimmedBoundaryReplacer
//   Trim leading/trailing whitespace from `oldStr` before searching.
// ---------------------------------------------------------------------------

export const trimmedBoundaryReplacer: Replacer = (original, oldStr, newStr, opts) => {
  const allowMultiple = opts?.allowMultiple === true;
  const trimmed = oldStr.trim();
  if (trimmed === oldStr || trimmed.length === 0) return null;

  if (original.includes(trimmed)) {
    const rewrite = applyCandidate(original, trimmed, newStr, allowMultiple);
    if (rewrite !== null) return rewrite;
  }

  const lines = original.split('\n');
  const findLines = oldStr.split('\n');
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join('\n');
    if (block.trim() === trimmed) {
      const rewrite = applyCandidate(original, block, newStr, allowMultiple);
      if (rewrite !== null) return rewrite;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Replacer 8: contextAwareReplacer
//   Match by line-context similarity using first/last lines as anchors
//   and a 50%-line-equality threshold over the middle.
// ---------------------------------------------------------------------------

export const contextAwareReplacer: Replacer = (original, oldStr, newStr, opts) => {
  const allowMultiple = opts?.allowMultiple === true;
  const findLines = oldStr.split('\n');
  if (findLines.length < 3) return null;
  if (findLines[findLines.length - 1] === '') findLines.pop();
  if (findLines.length < 3) return null;

  const contentLines = original.split('\n');
  const firstLine = (findLines[0] as string).trim();
  const lastLine = (findLines[findLines.length - 1] as string).trim();

  for (let i = 0; i < contentLines.length; i++) {
    if ((contentLines[i] as string).trim() !== firstLine) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if ((contentLines[j] as string).trim() !== lastLine) continue;
      const blockLines = contentLines.slice(i, j + 1);
      if (blockLines.length === findLines.length) {
        let matchingLines = 0;
        let totalNonEmpty = 0;
        for (let k = 1; k < blockLines.length - 1; k++) {
          const bl = (blockLines[k] as string).trim();
          const fl = (findLines[k] as string).trim();
          if (bl.length > 0 || fl.length > 0) {
            totalNonEmpty++;
            if (bl === fl) matchingLines++;
          }
        }
        if (totalNonEmpty === 0 || matchingLines / totalNonEmpty >= 0.5) {
          const block = blockLines.join('\n');
          const rewrite = applyCandidate(original, block, newStr, allowMultiple);
          if (rewrite !== null) return rewrite;
        }
      }
      break; // only the first matching last-line is considered
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// Replacer 9: multiOccurrenceReplacer
//   Last-resort: replaces ALL occurrences of an exact `oldStr`. Only
//   activates when `allowMultiple` is true (otherwise, ambiguous matches
//   should be rejected by earlier replacers).
// ---------------------------------------------------------------------------

export const multiOccurrenceReplacer: Replacer = (original, oldStr, newStr, opts) => {
  if (oldStr.length === 0) return null;
  if (opts?.allowMultiple !== true) return null;
  if (!original.includes(oldStr)) return null;
  return original.split(oldStr).join(newStr);
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

const CHAIN: ReadonlyArray<{ name: ReplacerName; fn: Replacer }> = [
  { name: REPLACER_SIMPLE, fn: simpleReplacer },
  { name: REPLACER_LINE_TRIMMED, fn: lineTrimmedReplacer },
  { name: REPLACER_BLOCK_ANCHOR, fn: blockAnchorReplacer },
  { name: REPLACER_WHITESPACE_NORMALIZED, fn: whitespaceNormalizedReplacer },
  { name: REPLACER_INDENTATION_FLEXIBLE, fn: indentationFlexibleReplacer },
  { name: REPLACER_ESCAPE_NORMALIZED, fn: escapeNormalizedReplacer },
  { name: REPLACER_TRIMMED_BOUNDARY, fn: trimmedBoundaryReplacer },
  { name: REPLACER_CONTEXT_AWARE, fn: contextAwareReplacer },
  { name: REPLACER_MULTI_OCCURRENCE, fn: multiOccurrenceReplacer },
];

/**
 * Run the chain in order. Returns the rewritten content + the name of
 * the strategy that succeeded, or `null` when every strategy declined.
 *
 * The orchestrator never throws on a non-find — callers (tools) are
 * expected to surface "no match" as a {@link ToolExecutionError} with
 * domain context.
 */
export function applyReplacers(
  original: string,
  oldStr: string,
  newStr: string,
  opts: ApplyReplacerOptions = {},
): ReplacerHit | null {
  if (oldStr === newStr) return null;
  for (const link of CHAIN) {
    const out = link.fn(original, oldStr, newStr, opts);
    if (out !== null) {
      return { result: out, replacerUsed: link.name };
    }
  }
  return null;
}
