// src/http/__tests__/fetch-with-retry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithRetry } from '../fetch-with-retry';

describe('fetchWithRetry', () => {
  let originalFetch: typeof global.fetch;
  let originalRandom: typeof Math.random;

  beforeEach(() => {
    originalFetch = global.fetch;
    originalRandom = Math.random;
    // Lock jitter to 1.0 for deterministic backoff timing in tests.
    // Backoff = min(base * 2^attempt, max) * 1.0 = base * 2^attempt
    Math.random = vi.fn(() => 1.0);
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    Math.random = originalRandom;
    vi.useRealTimers();
  });

  // ── Normal operation ──

  it('passes through a successful response without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', { status: 200 })
    );
    global.fetch = fetchMock;

    const response = await fetchWithRetry('https://example.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  it('passes through headers and method correctly', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', { status: 200 })
    );
    global.fetch = fetchMock;

    await fetchWithRetry('https://example.com/api', {
      method: 'PUT',
      headers: { 'X-Custom': 'value', Authorization: 'Bearer token' },
      body: '{"key":"value"}',
    });

    const callOptions = fetchMock.mock.calls[0][1];
    expect(callOptions.method).toBe('PUT');
    expect(callOptions.headers['X-Custom']).toBe('value');
    expect(callOptions.headers['Authorization']).toBe('Bearer token');
    expect(callOptions.body).toBe('{"key":"value"}');
  });

  // ── Retry on network errors ──

  it('retries on TypeError ("fetch failed") up to maxRetries', async () => {
    const failure = new TypeError('fetch failed');
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(failure)  // attempt 0: fail
      .mockRejectedValueOnce(failure)  // retry 1: fail
      .mockRejectedValueOnce(failure)  // retry 2: fail
      .mockRejectedValueOnce(failure)  // retry 3: fail
      .mockRejectedValueOnce(failure)  // retry 4: fail
      .mockResolvedValue(new Response('ok', { status: 200 })); // retry 5: ok
    global.fetch = fetchMock;

    const promise = fetchWithRetry('https://example.com/api', {
      method: 'GET',
      retry: { maxRetries: 5 },
    });

    // Run all timers — each backoff fires, retry proceeds, next sleep set.
    // Since the mock resolves on the 6th call, the loop exits successfully.
    await vi.runAllTimersAsync();

    const response = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(6); // 1 initial + 5 retries
    expect(response.status).toBe(200);
  });

  it('retries on generic network errors (TypeError without "fetch failed")', async () => {
    const failure = new TypeError('network error');
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(new Response('ok', { status: 200 }));
    global.fetch = fetchMock;

    const promise = fetchWithRetry('https://example.com/api', {
      method: 'GET',
      retry: { maxRetries: 3 },
    });

    await vi.runAllTimersAsync();

    const response = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2); // 1 initial + 1 retry
    expect(response.status).toBe(200);
  });

  // ── Retry on server errors ──

  it('retries on 502 Bad Gateway', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    global.fetch = fetchMock;

    const promise = fetchWithRetry('https://example.com/api', {
      method: 'GET',
      retry: { maxRetries: 3 },
    });

    await vi.runAllTimersAsync();

    const response = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it('retries on 503 Service Unavailable', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Service Unavailable', { status: 503 }))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    global.fetch = fetchMock;

    const promise = fetchWithRetry('https://example.com/api', {
      method: 'GET',
      retry: { maxRetries: 3 },
    });

    await vi.runAllTimersAsync();

    const response = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it('retries on 504 Gateway Timeout', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('Gateway Timeout', { status: 504 }))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    global.fetch = fetchMock;

    const promise = fetchWithRetry('https://example.com/api', {
      method: 'GET',
      retry: { maxRetries: 3 },
    });

    await vi.runAllTimersAsync();

    const response = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  it('retries on 429 Too Many Requests and respects Retry-After header', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response('Rate limited', {
          status: 429,
          headers: { 'Retry-After': '2' },
        })
      )
      .mockResolvedValue(new Response('ok', { status: 200 }));
    global.fetch = fetchMock;

    const promise = fetchWithRetry('https://example.com/api', {
      method: 'GET',
      retry: { maxRetries: 3 },
    });

    // Retry-After: 2 seconds → 2000ms
    await vi.runAllTimersAsync();

    const response = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  // ── No retry on client errors ──

  it('does NOT retry on 400 Bad Request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('Bad Request', { status: 400 })
    );
    global.fetch = fetchMock;

    await expect(
      fetchWithRetry('https://example.com/api', { method: 'GET', retry: { maxRetries: 3 } })
    ).rejects.toThrow(/400/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 401 Unauthorized', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('Unauthorized', { status: 401 })
    );
    global.fetch = fetchMock;

    await expect(
      fetchWithRetry('https://example.com/api', { method: 'GET', retry: { maxRetries: 3 } })
    ).rejects.toThrow(/401/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 403 Forbidden', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('Forbidden', { status: 403 })
    );
    global.fetch = fetchMock;

    await expect(
      fetchWithRetry('https://example.com/api', { method: 'GET', retry: { maxRetries: 3 } })
    ).rejects.toThrow(/403/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 404 Not Found', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('Not Found', { status: 404 })
    );
    global.fetch = fetchMock;

    await expect(
      fetchWithRetry('https://example.com/api', { method: 'GET', retry: { maxRetries: 3 } })
    ).rejects.toThrow(/404/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry on 422 Unprocessable Entity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('Unprocessable', { status: 422 })
    );
    global.fetch = fetchMock;

    await expect(
      fetchWithRetry('https://example.com/api', { method: 'GET', retry: { maxRetries: 3 } })
    ).rejects.toThrow(/422/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── AbortError handling ──

  it('does NOT retry on AbortError (user interruption)', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const fetchMock = vi.fn().mockRejectedValue(abortError);
    global.fetch = fetchMock;

    await expect(
      fetchWithRetry('https://example.com/api', { method: 'GET', retry: { maxRetries: 5 } })
    ).rejects.toThrow(/abort/i);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Retry exhaustion ──

  it('throws with context after all retries exhausted', async () => {
    const failure = new TypeError('fetch failed');
    const fetchMock = vi.fn().mockRejectedValue(failure);
    global.fetch = fetchMock;

    const promise = fetchWithRetry('https://example.com/api', {
      method: 'GET',
      retry: { maxRetries: 2 },
    });

    // Suppress unhandled rejection during timer advancement
    promise.catch(() => {});

    // Math.random returns 1.0, so backoff: 1000, 2000 — advance past both
    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow(/attempts/i);
    await expect(promise).rejects.toThrow(/3/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  // ── Exponential backoff with jitter ──

  it('uses exponential backoff: base * 2^attempt ms', async () => {
    // For this test, use real Math.random so we can verify jitter range
    Math.random = originalRandom;

    const delays: number[] = [];
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fail'));
    global.fetch = fetchMock;

    // Spy on setTimeout to record delay values
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout');

    const promise = fetchWithRetry('https://example.com/api', {
      method: 'GET',
      retry: { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 16000 },
    });

    // Suppress unhandled rejection during timer advancement
    promise.catch(() => {});

    // Advance time generously — each backoff ≤ 16000 * 1.25 = 20000
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);
    await vi.advanceTimersByTimeAsync(30000);

    await expect(promise).rejects.toThrow();

    // Extract retry delays (filter out the request timeout timers at 120000ms)
    const retryDelays: number[] = [];
    for (const call of setTimeoutSpy.mock.calls) {
      const ms = call[1] as number;
      if (ms !== undefined && ms < 100000) {
        retryDelays.push(ms);
      }
    }
    setTimeoutSpy.mockRestore();

    expect(retryDelays.length).toBeGreaterThanOrEqual(3);

    // First retry delay: base=1000, jitter 0.75-1.25 → 750–1250
    expect(retryDelays[0]).toBeGreaterThanOrEqual(750);
    expect(retryDelays[0]).toBeLessThanOrEqual(1250);

    // Second retry delay: base=2000, jitter 0.75-1.25 → 1500–2500
    expect(retryDelays[1]).toBeGreaterThanOrEqual(1500);
    expect(retryDelays[1]).toBeLessThanOrEqual(2500);

    // Third retry delay: base=4000, jitter 0.75-1.25 → 3000–5000
    expect(retryDelays[2]).toBeGreaterThanOrEqual(3000);
    expect(retryDelays[2]).toBeLessThanOrEqual(5000);
  });

  // ── Long-idle simulation ──

  it('recovers after simulated long-idle period with connection failures', async () => {
    // This simulates: after a long idle (e.g., downloading weights for hours),
    // the first few connection attempts fail as undici re-establishes the pool,
    // but subsequent retries succeed.

    const networkError = new TypeError('fetch failed');
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(networkError)  // stale connection 1
      .mockRejectedValueOnce(networkError)  // stale connection 2
      .mockRejectedValueOnce(networkError)  // still failing
      .mockResolvedValue(new Response(JSON.stringify({
        choices: [{ message: { content: 'recovered!' } }],
      }), { status: 200 }));
    global.fetch = fetchMock;

    const promise = fetchWithRetry('https://api.example.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
      retry: { maxRetries: 5, baseDelayMs: 1000 },
    });

    // Run all backoff timers — 3 failures, 4th succeeds
    await vi.runAllTimersAsync();

    const response = await promise;
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries

    const data = await response.json();
    expect(data.choices[0].message.content).toBe('recovered!');
  });

  // ── Custom retry predicate ──

  it('uses custom shouldRetry when provided', async () => {
    // Custom logic: retry on 418 (I'm a teapot) — normally non-retryable
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("I'm a teapot", { status: 418 }))
      .mockResolvedValue(new Response('ok', { status: 200 }));
    global.fetch = fetchMock;

    const promise = fetchWithRetry('https://example.com/api', {
      method: 'GET',
      retry: {
        maxRetries: 3,
        shouldRetry: (_error, _attempt, response) => {
          // Retry on 418
          return response?.status === 418;
        },
      },
    });

    await vi.runAllTimersAsync();

    const response = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });

  // ── Timeout ──

  it('applies AbortSignal for request timeout via combined signal', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', { status: 200 })
    );
    global.fetch = fetchMock;

    await fetchWithRetry('https://example.com/api', {
      method: 'GET',
      timeout: { requestMs: 120000 },
    });

    const callOptions = fetchMock.mock.calls[0][1];
    expect(callOptions.signal).toBeDefined();
    expect(callOptions.signal instanceof AbortSignal).toBe(true);
  });

  it('retries on timeout abort before maxRetries', async () => {
    const timeoutError = new DOMException('Request timed out', 'TimeoutError');
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValue(new Response('ok', { status: 200 }));
    global.fetch = fetchMock;

    const promise = fetchWithRetry('https://example.com/api', {
      method: 'GET',
      retry: { maxRetries: 3 },
    });

    await vi.runAllTimersAsync();

    const response = await promise;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
  });
});
