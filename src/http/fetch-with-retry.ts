// src/http/fetch-with-retry.ts
//
// Fetch wrapper with timeout and retry for transient network failures.
// Designed to handle "Error: fetch failed" after long-idle periods (e.g.,
// multi-hour model downloads or vllm startup) when undici's connection pool
// has dropped its idle sockets (keepAliveTimeout = 4s by default).
//
// Retry policy:
//   - Retryable: network errors (TypeError), TimeoutError, 429, 502, 503, 504
//   - Not retryable: AbortError (user Ctrl+C), 400, 401, 403, 404, 422
//   - Max 5 retries with exponential backoff + jitter (±25%)

const DEFAULT_MAX_RETRIES = 10;
const DEFAULT_BASE_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 16000;
const DEFAULT_RETRYABLE_STATUSES = [429, 502, 503, 504];
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 5). */
  maxRetries?: number;
  /** Base delay in ms for exponential backoff (default: 1000). */
  baseDelayMs?: number;
  /** Maximum delay cap in ms (default: 16000). */
  maxDelayMs?: number;
  /** HTTP status codes that trigger a retry (default: [429, 502, 503, 504]). */
  retryableStatuses?: number[];
  /**
   * Custom predicate to decide whether to retry.
   * Called with (error, attempt, response).
   * - `error` is set when fetch threw (network/timeout); response is undefined.
   * - `response` is set on HTTP errors; error is null.
   * Return true to retry.
   */
  shouldRetry?: (error: unknown, attempt: number, response?: Response) => boolean;
}

export interface TimeoutOptions {
  /** Total request timeout in ms (default: 120_000 = 2 minutes). */
  requestMs?: number;
}

export interface FetchWithRetryInit extends RequestInit {
  retry?: RetryOptions;
  timeout?: TimeoutOptions;
}

// ── Helpers ──

/**
 * Calculate exponential backoff delay with jitter.
 * delay = min(base * 2^attempt, max) * random(0.75, 1.25)
 */
function calculateBackoff(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponential = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  const jitter = 0.75 + Math.random() * 0.5; // 0.75–1.25
  return Math.floor(exponential * jitter);
}

/**
 * Sleep for `ms` milliseconds. Uses setTimeout so vitest fake timers
 * can control the passage of time in tests.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if the error is retryable.
 * Retryable: TypeError (network errors, "fetch failed"), TimeoutError (our internal timeout).
 * Not retryable: AbortError (user interruption), other errors.
 */
function isRetryableNetworkError(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return false; // User interruption — do not retry
  }
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return true; // Our internal timeout — retry
  }
  if (error instanceof TypeError) {
    return true; // Network errors (e.g. "fetch failed")
  }
  return false;
}

/**
 * Try to parse Retry-After header value.
 * Supports both delta-seconds ("120") and HTTP-date formats.
 */
function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;

  // Try delta-seconds
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  // Try HTTP-date
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return Math.max(0, delta);
  }

  return null;
}

/**
 * Create a timeout signal that aborts after `ms` milliseconds.
 * Returns the signal and a cleanup function to cancel the timeout.
 * Uses manual setTimeout + AbortController (instead of AbortSignal.timeout)
 * so that vitest fake timers can control it and we can clean up between retries.
 */
function createTimeoutSignal(ms: number): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const controller = new AbortController();
  const timerId = setTimeout(() => {
    controller.abort(new DOMException('Request timed out', 'TimeoutError'));
  }, ms);

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timerId),
  };
}

/**
 * Combine multiple AbortSignals into one.
 * Aborts if any of the input signals abort.
 * Compatible with Node 18 (avoids AbortSignal.any which is Node 20+).
 */
function combineSignals(
  signals: (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const defined = signals.filter((s): s is AbortSignal => !!s);
  if (defined.length === 0) return undefined;
  if (defined.length === 1) return defined[0];

  const controller = new AbortController();

  const onAbort = (reason: unknown) => {
    if (!controller.signal.aborted) {
      controller.abort(reason);
    }
  };

  for (const signal of defined) {
    if (signal.aborted) {
      // Already aborted — immediately propagate
      controller.abort(signal.reason);
      return controller.signal;
    }
    signal.addEventListener('abort', () => onAbort(signal.reason), { once: true });
  }

  return controller.signal;
}

// ── Main ──

/**
 * Fetch wrapper with automatic retry and timeout.
 *
 * Retries on transient failures:
 * - Network errors (TypeError including "fetch failed")
 * - HTTP 429 Too Many Requests (respects Retry-After header)
 * - HTTP 502 Bad Gateway
 * - HTTP 503 Service Unavailable
 * - HTTP 504 Gateway Timeout
 *
 * Does NOT retry on:
 * - AbortError (user interruption)
 * - Client errors (400, 401, 403, 404, 422)
 *
 * Uses exponential backoff with jitter between retries.
 *
 * @returns The fetch Response on success (2xx).
 * @throws On non-retryable HTTP errors, or retryable errors after all retries exhausted.
 */
export async function fetchWithRetry(
  url: string,
  init: FetchWithRetryInit = {},
): Promise<Response> {
  const maxRetries = init.retry?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const baseDelayMs = init.retry?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = init.retry?.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const retryableStatuses =
    init.retry?.retryableStatuses ?? DEFAULT_RETRYABLE_STATUSES;
  const customShouldRetry = init.retry?.shouldRetry;
  const requestMs = init.timeout?.requestMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  const userSignal = init.signal;
  // Strip our custom fields from the init passed to fetch
  const { retry: _retry, timeout: _timeout, signal: _signal, ...baseFetchInit } = init;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Build a cancellable timeout for this attempt
    const { signal: timeoutSignal, cleanup: cleanupTimeout } =
      createTimeoutSignal(requestMs);

    // Combine user signal with timeout signal
    const combinedSignal = combineSignals([userSignal, timeoutSignal]);

    const requestInit: RequestInit = {
      ...baseFetchInit,
      signal: combinedSignal,
    };

    try {
      const response = await fetch(url, requestInit);
      cleanupTimeout(); // fetch succeeded within timeout

      // Success — return immediately
      if (response.ok) {
        return response;
      }

      // Determine if this HTTP error is retryable
      const retryable =
        customShouldRetry?.(null, attempt, response) ??
        retryableStatuses.includes(response.status);

      if (retryable && attempt < maxRetries) {
        // Check Retry-After header (especially for 429)
        const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
        const delay = retryAfter ?? calculateBackoff(attempt, baseDelayMs, maxDelayMs);
        lastError = new Error(`HTTP ${response.status}`);
        await sleep(delay);
        continue;
      }

      // Non-retryable or last attempt — read body and throw
      const errorBody = await response.text().catch(() => '<unreadable>');
      throw new Error(`HTTP ${response.status}: ${errorBody}`);
    } catch (error: unknown) {
      cleanupTimeout(); // clean up the timeout timer for this attempt

      lastError = error;

      // Never retry AbortError from the USER (Ctrl+C)
      if (
        error instanceof DOMException &&
        error.name === 'AbortError' &&
        userSignal?.aborted
      ) {
        throw error;
      }

      // Determine retryability
      const retryable =
        customShouldRetry?.(error, attempt, undefined) ??
        isRetryableNetworkError(error);

      if (retryable && attempt < maxRetries) {
        const delay = calculateBackoff(attempt, baseDelayMs, maxDelayMs);
        await sleep(delay);
        continue;
      }

      // Retries exhausted for network error — give a user-friendly message
      if (attempt >= maxRetries && isRetryableNetworkError(error)) {
        const originalMsg =
          error instanceof Error ? error.message : String(error);
        throw new Error(
          `Network error after ${maxRetries + 1} attempts: ${originalMsg}. Please check your network connection.`,
        );
      }

      // Non-retryable error — re-throw as-is
      throw error;
    }
  }

  // Should not reach here, but just in case
  throw new Error(
    `Request failed after ${maxRetries} retries.` +
      (lastError instanceof Error ? ` Last error: ${lastError.message}` : ''),
  );
}
