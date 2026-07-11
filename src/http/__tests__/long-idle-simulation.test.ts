// src/http/__tests__/long-idle-simulation.test.ts
//
// Integration tests: real HTTP server that drops first N connections,
// simulating transient failures after a long-idle period.
// Uses REAL timers (not fake) because HTTP server I/O needs the event loop.

import { describe, it, expect } from 'vitest';
import http from 'node:http';
import { fetchWithRetry } from '../fetch-with-retry';

/**
 * Create an HTTP server that drops the first `dropCount` connections
 * (by destroying the socket immediately), then responds normally.
 */
function createFlakyServer(dropCount: number) {
  let requestCount = 0;

  const server = http.createServer((req, res) => {
    requestCount++;

    if (requestCount <= dropCount) {
      // Simulate "fetch failed" / connection reset
      req.socket.destroy();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', request: requestCount }));
  });

  return {
    server,
    getRequestCount: () => requestCount,
  };
}

function getPort(s: http.Server): number {
  const addr = s.address();
  if (!addr || typeof addr === 'string') throw new Error('No address');
  return addr.port;
}

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return getPort(server);
}

describe('Long-idle simulation (real HTTP server)', () => {
  it(
    'survives 3 dropped connections and recovers on 4th attempt',
    async () => {
      const { server, getRequestCount } = createFlakyServer(3);
      const port = await listen(server);
      const url = `http://127.0.0.1:${port}/api/chat`;

      try {
        const response = await fetchWithRetry(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'hello' }),
          retry: { maxRetries: 5, baseDelayMs: 50 },
          timeout: { requestMs: 5000 },
        });

        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.status).toBe('ok');
        expect(getRequestCount()).toBe(4); // 3 dropped + 1 success
      } finally {
        server.close();
      }
    },
    15000,
  );

  it(
    'raw fetch fails on dropped connection (baseline)',
    async () => {
      const { server } = createFlakyServer(1);
      const port = await listen(server);
      const url = `http://127.0.0.1:${port}/api/chat`;

      try {
        await expect(
          fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'hello' }),
          })
        ).rejects.toThrow();
      } finally {
        server.close();
      }
    },
    15000,
  );

  it(
    'no extra requests beyond dropped + success',
    async () => {
      const { server, getRequestCount } = createFlakyServer(2);
      const port = await listen(server);
      const url = `http://127.0.0.1:${port}/api/chat`;

      try {
        const response = await fetchWithRetry(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt: 'test' }),
          retry: { maxRetries: 3, baseDelayMs: 50 },
          timeout: { requestMs: 5000 },
        });

        expect(response.status).toBe(200);
        expect(getRequestCount()).toBe(3); // 2 dropped + 1 success
      } finally {
        server.close();
      }
    },
    15000,
  );

  it(
    'throws with retry count when all attempts fail',
    async () => {
      const { server } = createFlakyServer(999); // always drop
      const port = await listen(server);
      const url = `http://127.0.0.1:${port}/api/chat`;

      try {
        await expect(
          fetchWithRetry(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: 'test' }),
            retry: { maxRetries: 3, baseDelayMs: 50 },
            timeout: { requestMs: 5000 },
          })
        ).rejects.toThrow(/retries/i);
      } finally {
        server.close();
      }
    },
    15000,
  );
});
