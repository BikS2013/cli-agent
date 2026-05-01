/**
 * Typed error classes for the agent-tools library.
 *
 * Every error has a stable `code` discriminator so consumers can branch
 * on it without an `instanceof` check (useful when an error crosses a
 * worker boundary or is logged as JSON).
 *
 * The classes use ES2022 cause-chaining via the standard `Error.cause`
 * option. They do NOT extend a common base beyond `Error` in cases
 * where the planning explicitly ruled out the relationship — see
 * {@link MissingConfigurationError} below.
 */

/** Discriminator codes used across the library. */
export type ToolErrorCode =
  | 'TOOL_EXECUTION'
  | 'PERMISSION_DENIED'
  | 'MISSING_CONFIGURATION'
  | 'INPUT_VALIDATION'
  | 'NOT_IMPLEMENTED'
  | 'PROMPT_NOT_FOUND'
  | string;

interface ToolExecutionErrorOptions {
  /** Underlying cause, forwarded to ES2022 `Error.cause`. */
  cause?: unknown;
  /** Optional explicit code override; defaults to `'TOOL_EXECUTION'`. */
  code?: ToolErrorCode;
}

/**
 * Generic catch-all for predictable tool failures.
 *
 * Tools should prefer this class for any error that the LLM is allowed
 * to read in plain text (file-not-found, missing match, network error).
 *
 * The structural `ToolExecutionErrorLike` type in `src/types.ts`
 * matches this class — that lets tools build the `{ok:false}` branch
 * without importing the class itself.
 */
export class ToolExecutionError extends Error {
  override readonly name: string = 'ToolExecutionError';
  readonly code: ToolErrorCode;
  override readonly cause?: unknown;

  constructor(message: string, opts: ToolExecutionErrorOptions = {}) {
    // ES2022 cause-chaining
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.code = opts.code ?? 'TOOL_EXECUTION';
    if (opts.cause !== undefined) {
      this.cause = opts.cause;
    }
  }
}

/**
 * Raised by {@link PermissionPolicy} consumers when a strict policy
 * denies an operation. The `code` is fixed to `'PERMISSION_DENIED'`.
 */
export class PermissionDeniedError extends ToolExecutionError {
  override readonly name: string = 'PermissionDeniedError';
  readonly reason: string;

  constructor(reason: string, opts: Omit<ToolExecutionErrorOptions, 'code'> = {}) {
    super(`Permission denied: ${reason}`, { ...opts, code: 'PERMISSION_DENIED' });
    this.reason = reason;
  }
}

interface InputValidationErrorOptions extends Omit<ToolExecutionErrorOptions, 'code'> {
  // No additional fields — kept as a type alias for clarity.
}

/**
 * Returned (not thrown) from a tool when Zod schema validation fails.
 *
 * The optional `zodError` parameter is formatted to a flat string and
 * stored on the instance under `issues` so direct callers can read it
 * without re-importing the Zod error type.
 */
export class InputValidationError extends ToolExecutionError {
  override readonly name: string = 'InputValidationError';
  readonly issues: string;

  constructor(message: string, zodError?: unknown, opts: InputValidationErrorOptions = {}) {
    const formatted = zodError !== undefined ? formatZodIssues(zodError) : '';
    const finalMessage = formatted.length > 0
      ? `${message}: ${formatted}`
      : message;
    super(finalMessage, {
      ...opts,
      code: 'INPUT_VALIDATION',
      cause: opts.cause ?? zodError,
    });
    this.issues = formatted;
  }
}

/**
 * Thrown by the test harness's pre-flight when one or more required
 * environment variables are absent.
 *
 * Intentionally NOT a subclass of {@link ToolExecutionError}: the
 * harness treats configuration errors as a separate failure mode
 * (the agent never starts), not as a tool failure mid-loop.
 */
export class MissingConfigurationError extends Error {
  override readonly name: string = 'MissingConfigurationError';
  readonly code: ToolErrorCode = 'MISSING_CONFIGURATION';
  readonly missing: ReadonlyArray<string>;

  constructor(varNames: string[], message?: string) {
    const finalMessage =
      message ?? `Missing required configuration: ${varNames.join(', ')}`;
    super(finalMessage);
    this.missing = Object.freeze([...varNames]);
  }
}

/**
 * Distinct error signalling a "v2 stub" — used by the `task` tool
 * placeholder and any other surfaced-but-unbuilt feature.
 */
export class NotImplementedError extends ToolExecutionError {
  override readonly name: string = 'NotImplementedError';

  constructor(featureName: string) {
    super(`Not implemented: ${featureName}`, { code: 'NOT_IMPLEMENTED' });
  }
}

/**
 * Type guard for {@link ToolExecutionError} and its subclasses.
 *
 * Useful in adapter code that needs to discriminate between a
 * tool-domain error (`ToolExecutionError`) and an unexpected runtime
 * failure (`Error`).
 */
export function isToolExecutionError(x: unknown): x is ToolExecutionError {
  return x instanceof ToolExecutionError;
}

/**
 * Best-effort flattening of a Zod error object into a single string.
 *
 * We do not import `zod` here — that would make `errors.ts` depend on
 * Zod even when callers never validate input. Instead we duck-type the
 * common shapes (`.issues[]`, `.errors[]`, plain object).
 */
function formatZodIssues(zodError: unknown): string {
  if (zodError === null || zodError === undefined) return '';
  if (typeof zodError === 'string') return zodError;

  // Handle ZodError-like objects (Zod v3 exposes `issues`).
  if (typeof zodError === 'object') {
    const e = zodError as { issues?: unknown; errors?: unknown; message?: unknown };
    const list = Array.isArray(e.issues)
      ? e.issues
      : Array.isArray(e.errors)
        ? e.errors
        : null;
    if (list !== null) {
      const parts = list.map((issue) => {
        if (typeof issue !== 'object' || issue === null) return String(issue);
        const i = issue as { path?: unknown; message?: unknown };
        const pathStr = Array.isArray(i.path) && i.path.length > 0
          ? i.path.join('.')
          : '<root>';
        const msg = typeof i.message === 'string' ? i.message : 'invalid';
        return `${pathStr}: ${msg}`;
      });
      return parts.join('; ');
    }
    if (typeof e.message === 'string') return e.message;
  }
  return String(zodError);
}
