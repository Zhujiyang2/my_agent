#!/usr/bin/env node
// bin/simulate-long-idle.ts
//
// Simulates the "Error: fetch failed" scenario after a genuinely long idle.
//
// Scenario:
//   1. Start local HTTP server (mock LLM API)
//   2. Make a warmup request → connection established, added to undici pool
//   3. Wait IDLE_SECONDS (default 3600 = 1 hour)
//      During idle:
//        - undici keepAliveTimeout (4s) drops pooled sockets from client side
//        - OS TCP keepalive may expire
//        - Server-side keepalive may expire
//        - In real world: firewalls/NAT gateways drop the mapping
//   4. After idle, test TWO approaches:
//      a. Raw fetch → expected to fail ("Error: fetch failed")
//      b. fetchWithRetry → expected to recover after retries
//
// Usage:
//   node --import tsx bin/simulate-long-idle.ts [idleSeconds]
//
//   # 1-hour test (default)
//   node --import tsx bin/simulate-long-idle.ts
//
//   # 5-minute quick test
//   node --import tsx bin/simulate-long-idle.ts 300
//
//   # 10-second smoke test
//   node --import tsx bin/simulate-long-idle.ts 10

import http from 'node:http';
import { fetchWithRetry } from '../src/http/fetch-with-retry';

// ── Config ──

const IDLE_SECONDS = parseInt(process.argv[2] || '3600', 10);
const RETRY_MAX = 5;
const RETRY_BASE_DELAY_MS = 1000;

// ── Tiny HTTP server ──

let requestCount = 0;
const server = http.createServer((_req, res) => {
  requestCount++;
  const now = new Date().toISOString();
  console.log(`  [server] Request #${requestCount} at ${now}`);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    request: requestCount,
    time: now,
  }));
});

// ── Helpers ──

function getPort(s: http.Server): number {
  const addr = s.address();
  if (!addr || typeof addr === 'string') throw new Error('No address');
  return addr.port;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDuration(seconds: number): string {
  if (seconds < 120) return `${seconds}s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)}min`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

// ── Main ──

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('  Long-Idle Fetch Recovery Simulation');
  console.log('═══════════════════════════════════════════');
  console.log(`  Idle duration: ${formatDuration(IDLE_SECONDS)} (${IDLE_SECONDS}s)`);
  console.log(`  Retry config:  maxRetries=${RETRY_MAX}, baseDelay=${RETRY_BASE_DELAY_MS}ms`);
  console.log(`  Start time:    ${new Date().toISOString()}`);
  console.log('');

  // Start server
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = getPort(server);
  const url = `http://127.0.0.1:${port}/api/chat`;
  console.log(`[setup] Local HTTP server on ${url}\n`);

  try {
    // ── Phase 1: Warmup ──
    console.log('── Phase 1: Warmup request ──');
    const warmupBody = JSON.stringify({ prompt: 'warmup' });
    const warmupRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: warmupBody,
    });
    const warmupData = await warmupRes.json();
    console.log(`  Warmup OK: status=${warmupRes.status}, request=${warmupData.request}\n`);

    // ── Phase 2: Long idle ──
    console.log(`── Phase 2: Idle for ${formatDuration(IDLE_SECONDS)} ──`);
    console.log(`  Idle start: ${new Date().toISOString()}`);
    console.log('  (undici keepAliveTimeout=4s — connections will be dropped within 4 seconds)');
    console.log('  (TCP keepalive probes may or may not keep the socket alive)');
    console.log('');

    const startTime = Date.now();
    let lastReport = startTime;
    for (let elapsed = 0; elapsed < IDLE_SECONDS; elapsed++) {
      await sleep(1000);

      // Report progress every 5 minutes
      const now = Date.now();
      if (now - lastReport >= 300_000) {
        lastReport = now;
        const remaining = IDLE_SECONDS - elapsed;
        console.log(`  [idle] ${formatDuration(elapsed)} elapsed, ${formatDuration(remaining)} remaining...`);
      }
    }

    const idleEnd = Date.now();
    console.log(`\n  Idle end:   ${new Date().toISOString()}`);
    console.log(`  Actual idle: ${formatDuration(Math.round((idleEnd - startTime) / 1000))}\n`);

    // ── Phase 3: Raw fetch test ──
    console.log('── Phase 3: Raw fetch (baseline — expected to possibly fail) ──');
    const testBody = JSON.stringify({ prompt: 'test after long idle' });
    let rawFetchResult = 'FAIL';
    try {
      const rawRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: testBody,
      });
      if (rawRes.ok) {
        rawFetchResult = 'OK';
        const data = await rawRes.json();
        console.log(`  Raw fetch OK: status=${rawRes.status}, request=${data.request}`);
      } else {
        console.log(`  Raw fetch HTTP error: ${rawRes.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  Raw fetch FAILED: ${msg}`);
    }
    console.log(`  Result: ${rawFetchResult}\n`);

    // ── Phase 4: fetchWithRetry test ──
    console.log(`── Phase 4: fetchWithRetry (maxRetries=${RETRY_MAX}) ──`);
    const retryStart = Date.now();
    let retryResult = 'FAIL';
    try {
      const retryRes = await fetchWithRetry(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: testBody,
        retry: { maxRetries: RETRY_MAX, baseDelayMs: RETRY_BASE_DELAY_MS },
      });
      const retryElapsed = Date.now() - retryStart;
      if (retryRes.ok) {
        retryResult = 'OK';
        const data = await retryRes.json();
        console.log(`  fetchWithRetry OK: status=${retryRes.status}, request=${data.request}`);
        console.log(`  Total time: ${retryElapsed}ms (${(retryElapsed / 1000).toFixed(1)}s)`);
      } else {
        console.log(`  fetchWithRetry HTTP error: ${retryRes.status}`);
      }
    } catch (err) {
      const retryElapsed = Date.now() - retryStart;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  fetchWithRetry FAILED after ${retryElapsed}ms: ${msg}`);
    }
    console.log(`  Result: ${retryResult}\n`);

    // ── Summary ──
    console.log('═══════════════════════════════════════════');
    console.log('  Simulation Complete');
    console.log('═══════════════════════════════════════════');
    console.log(`  Total requests to server: ${requestCount}`);
    console.log(`  Raw fetch:               ${rawFetchResult}`);
    console.log(`  fetchWithRetry:          ${retryResult}`);
    console.log(`  End time:                ${new Date().toISOString()}`);
    console.log('');

    const overallSuccess = retryResult === 'OK';
    console.log(overallSuccess
      ? '  ✅ fetchWithRetry successfully recovered after long idle'
      : '  ❌ fetchWithRetry also failed — investigate further');
    console.log('');

  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  server.close();
  process.exit(1);
});
