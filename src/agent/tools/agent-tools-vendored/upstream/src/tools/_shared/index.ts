/**
 * Internal barrel for `src/tools/_shared/*`.
 *
 * Consumed only by tool implementations under `src/tools/<name>/`.
 * NOT re-exported from the package's public `src/index.ts` barrel.
 */
'use strict';

// ---------------------------------------------------------------------------
// Replacers
// ---------------------------------------------------------------------------
export {
  applyReplacers,
  simpleReplacer,
  lineTrimmedReplacer,
  blockAnchorReplacer,
  whitespaceNormalizedReplacer,
  indentationFlexibleReplacer,
  escapeNormalizedReplacer,
  trimmedBoundaryReplacer,
  contextAwareReplacer,
  multiOccurrenceReplacer,
  REPLACER_NAMES,
  REPLACER_SIMPLE,
  REPLACER_LINE_TRIMMED,
  REPLACER_BLOCK_ANCHOR,
  REPLACER_WHITESPACE_NORMALIZED,
  REPLACER_INDENTATION_FLEXIBLE,
  REPLACER_ESCAPE_NORMALIZED,
  REPLACER_TRIMMED_BOUNDARY,
  REPLACER_CONTEXT_AWARE,
  REPLACER_MULTI_OCCURRENCE,
} from './replacers.js';
export type {
  ApplyReplacerOptions,
  Replacer,
  ReplacerHit,
  ReplacerName,
} from './replacers.js';

// ---------------------------------------------------------------------------
// Ripgrep
// ---------------------------------------------------------------------------
export { probeRipgrep, runRipgrep, __resetProbeCacheForTesting } from './ripgrep.js';
export type {
  RipgrepProbeResult,
  RunRipgrepOptions,
  RunRipgrepResult,
} from './ripgrep.js';

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
export { httpFetchText } from './http.js';
export type { HttpFetchOptions, HttpFetchResult } from './http.js';

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------
export { truncate, truncateBytes, truncateLines } from './truncate.js';
export type { TruncateOptions, TruncationResult } from './truncate.js';

// ---------------------------------------------------------------------------
// JS fallback (glob/grep)
// ---------------------------------------------------------------------------
export { globFallback, grepFallback } from './jsfallback.js';
export type {
  GlobFallbackOptions,
  GrepFallbackOptions,
  GrepFallbackMatch,
} from './jsfallback.js';
