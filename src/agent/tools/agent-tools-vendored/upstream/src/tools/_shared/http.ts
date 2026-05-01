/**
 * Generic HTTP-fetch helper used by `webfetch` (and any future tool
 * that needs to talk HTTP).
 *
 * Features:
 *   - Wraps Node's built-in `fetch` (Node ≥ 20, no `undici` import).
 *   - Wall-clock timeout via `AbortController`, composable with a caller
 *     `AbortSignal` (whichever fires first wins).
 *   - Manual redirect following with a configurable cap (default 5).
 *   - Exponential backoff retry on:
 *       * HTTP 429 / 503 (default `retryStatuses`)
 *       * Cloudflare bot-mitigation: status 403 with header
 *         `cf-mitigated: challenge` (matches the upstream
 *         `webfetch.ts` retry trigger), or status 1015/1020 reported
 *         in body / header (`cloudflareStatuses`).
 *   - Custom `User-Agent` (default identifies the library).
 *
 * Design notes (extracted from the upstream reference):
 *   The upstream Effect-TS code retries Cloudflare-blocked requests
 *   ONCE with a fallback `User-Agent: opencode`. We generalise that to
 *   N retries with backoff so the helper is reusable for non-CF
 *   transient errors. The retry sleeps honour AbortSignal.
 */
'use strict';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HttpFetchOptions {
  /** Caller cancellation. Honoured at every await boundary. */
  readonly signal?: AbortSignal;
  /** Wall-clock timeout in ms. Default: 30_000. */
  readonly timeoutMs?: number;
  /** Maximum redirects to follow. Default: 5. */
  readonly maxRedirects?: number;
  /** Total retry attempts (besides the initial request). Default: 3. */
  readonly maxRetries?: number;
  /** HTTP statuses considered retryable. Default: [429, 503]. */
  readonly retryStatuses?: ReadonlyArray<number>;
  /** Cloudflare-style status codes considered retryable. Default: [1015, 1020]. */
  readonly cloudflareStatuses?: ReadonlyArray<number>;
  /** Extra headers to include in every attempt. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Override the User-Agent. */
  readonly userAgent?: string;
}

export interface HttpFetchResult {
  readonly status: number;
  readonly statusText: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly contentType: string | null;
  readonly finalUrl: string;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_RETRY_STATUSES: ReadonlyArray<number> = [429, 503];
const DEFAULT_CLOUDFLARE_STATUSES: ReadonlyArray<number> = [1015, 1020];
const DEFAULT_USER_AGENT =
  'agent-platform-tools/0.0.1 (+https://github.com/anomalyco/opencode)';

const BACKOFFS_MS: ReadonlyArray<number> = [1_000, 2_000, 4_000];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class AbortError extends Error {
  override readonly name = 'AbortError';
  constructor(message = 'The operation was aborted') {
    super(message);
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new AbortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function combineSignals(signals: ReadonlyArray<AbortSignal | undefined>): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const ctrl = new AbortController();
  const cleanups: Array<() => void> = [];
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    const handler = (): void => {
      ctrl.abort(s.reason);
    };
    s.addEventListener('abort', handler, { once: true });
    cleanups.push(() => s.removeEventListener('abort', handler));
  }
  return {
    signal: ctrl.signal,
    cleanup: () => {
      for (const c of cleanups) c();
    },
  };
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Detect Cloudflare-style block in body. Cloudflare error pages embed
 * the numeric error code (e.g. `Error 1020`, `Error 1015`) in the
 * markup.
 */
function bodyMentionsCfStatus(body: string, cfStatuses: ReadonlyArray<number>): number | null {
  if (body.length === 0) return null;
  for (const code of cfStatuses) {
    const re = new RegExp(`Error\\s*${code}\\b|cf-error-code\\s*:\\s*${code}\\b`, 'i');
    if (re.test(body)) return code;
  }
  return null;
}

function isCloudflareChallenge(headers: Record<string, string>, status: number): boolean {
  if (status !== 403) return false;
  const cf = headers['cf-mitigated'];
  if (typeof cf === 'string' && cf.toLowerCase() === 'challenge') return true;
  return false;
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// ---------------------------------------------------------------------------
// Public fetch helper
// ---------------------------------------------------------------------------

/**
 * GET `url` with timeouts, retries, and manual redirect handling.
 *
 * Returns the body as a utf-8 string. Non-2xx responses are returned
 * normally (no throw); the caller inspects `status` to decide.
 *
 * Throws on:
 *   - Caller-aborted signal (`AbortError`).
 *   - Wall-clock timeout (`AbortError` with timeout reason).
 *   - Network failure from `fetch` (the underlying error is rethrown).
 *   - Exceeded `maxRedirects`.
 */
export async function httpFetchText(
  url: string,
  opts: HttpFetchOptions = {},
): Promise<HttpFetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryStatuses = opts.retryStatuses ?? DEFAULT_RETRY_STATUSES;
  const cfStatuses = opts.cloudflareStatuses ?? DEFAULT_CLOUDFLARE_STATUSES;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;

  let attempt = 0;
  // The retry loop: on retryable failure we sleep with backoff and retry
  // the *whole* redirect chain from scratch (this matches the upstream
  // semantics — Cloudflare retries re-issue the request).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) throw new AbortError();
    try {
      return await singleAttempt(url, {
        timeoutMs,
        maxRedirects,
        retryStatuses,
        cfStatuses,
        userAgent,
        ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      });
    } catch (err) {
      if (!(err instanceof RetryableHttpError)) throw err;
      if (attempt >= maxRetries) {
        // Out of retries — surface the underlying response.
        return err.response;
      }
      const wait = BACKOFFS_MS[Math.min(attempt, BACKOFFS_MS.length - 1)] as number;
      attempt += 1;
      await delay(wait, opts.signal);
    }
  }
}

interface InternalAttemptOptions {
  readonly timeoutMs: number;
  readonly maxRedirects: number;
  readonly retryStatuses: ReadonlyArray<number>;
  readonly cfStatuses: ReadonlyArray<number>;
  readonly userAgent: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

class RetryableHttpError extends Error {
  override readonly name = 'RetryableHttpError';
  constructor(
    readonly response: HttpFetchResult,
    readonly trigger: 'retry-status' | 'cf-challenge' | 'cf-body' | 'cf-status',
  ) {
    super(`Retryable HTTP response (${response.status}) [trigger=${trigger}]`);
  }
}

async function singleAttempt(
  startUrl: string,
  opts: InternalAttemptOptions,
): Promise<HttpFetchResult> {
  let currentUrl = startUrl;
  let redirects = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (opts.signal?.aborted) throw new AbortError();

    const timeoutCtrl = new AbortController();
    const timeoutHandle = setTimeout(() => timeoutCtrl.abort(new AbortError('Request timed out')), opts.timeoutMs);
    const merged = combineSignals([opts.signal, timeoutCtrl.signal]);

    let response: Response;
    try {
      response = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        signal: merged.signal,
        headers: {
          'User-Agent': opts.userAgent,
          ...(opts.headers ?? {}),
        },
      });
    } catch (err) {
      clearTimeout(timeoutHandle);
      merged.cleanup();
      if (
        err instanceof Error &&
        (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR')
      ) {
        // Caller-abort vs. timeout: rethrow as AbortError either way.
        throw new AbortError(err.message || 'Request aborted');
      }
      throw err;
    } finally {
      clearTimeout(timeoutHandle);
      merged.cleanup();
    }

    const headerObj = headersToObject(response.headers);

    // Manual redirect handling.
    if (isRedirectStatus(response.status)) {
      const loc = response.headers.get('location');
      if (loc !== null) {
        if (redirects >= opts.maxRedirects) {
          throw new Error(`Exceeded maxRedirects (${opts.maxRedirects}) following ${startUrl}`);
        }
        // Drain the body to free the socket.
        try {
          await response.text();
        } catch {
          // ignore
        }
        currentUrl = new URL(loc, currentUrl).toString();
        redirects += 1;
        continue;
      }
    }

    const body = await response.text();
    const contentType = response.headers.get('content-type');
    const result: HttpFetchResult = {
      status: response.status,
      statusText: response.statusText,
      headers: headerObj,
      body,
      contentType,
      finalUrl: response.url || currentUrl,
    };

    // Retry triggers.
    if (opts.retryStatuses.includes(response.status)) {
      throw new RetryableHttpError(result, 'retry-status');
    }
    if (isCloudflareChallenge(headerObj, response.status)) {
      throw new RetryableHttpError(result, 'cf-challenge');
    }
    if (opts.cfStatuses.includes(response.status)) {
      throw new RetryableHttpError(result, 'cf-status');
    }
    const cfBody = bodyMentionsCfStatus(body, opts.cfStatuses);
    if (cfBody !== null) {
      throw new RetryableHttpError(result, 'cf-body');
    }

    return result;
  }
}
