// src/sandbox/__tests__/net-proxy.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createProxyServer, matchDomain, BUILTIN_ALLOWED_DOMAINS } from '../net-proxy';
import net from 'node:net';

/** Find a free TCP port for testing */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error('Could not find free port')));
      }
    });
  });
}

/** Create a simple echo TCP server that responds and then closes */
function createEchoServer(): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const srv = net.createServer((socket) => {
      socket.write('ECHO_OK');
      socket.end();
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        port,
        stop: () => new Promise<void>((r) => srv.close(() => r())),
      });
    });
  });
}

/** Send a raw HTTP CONNECT request and return the response status code */
function sendConnect(
  proxyPort: number,
  targetHost: string,
  targetPort: number,
  timeoutMs = 3000
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Connect request timed out'));
    }, timeoutMs);

    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n`);
      socket.write(`Host: ${targetHost}:${targetPort}\r\n`);
      socket.write('\r\n');
    });

    let response = '';
    socket.on('data', (data) => {
      response += data.toString();
      clearTimeout(timer);

      // Parse HTTP status line
      const statusMatch = response.match(/^HTTP\/1\.1\s+(\d+)/);
      if (statusMatch) {
        const statusCode = parseInt(statusMatch[1], 10);
        socket.end();
        resolve({ statusCode, body: response });
      }
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

describe('matchDomain', () => {
  it('matches exact domain', () => {
    expect(matchDomain('docker.io', 'docker.io')).toBe(true);
  });

  it('does not match different domain', () => {
    expect(matchDomain('docker.io', 'evil.com')).toBe(false);
  });

  it('matches wildcard: *.modelscope.cn matches cdn.modelscope.cn', () => {
    expect(matchDomain('*.modelscope.cn', 'cdn.modelscope.cn')).toBe(true);
  });

  it('wildcard: *.modelscope.cn does not match modelscope.cn', () => {
    expect(matchDomain('*.modelscope.cn', 'modelscope.cn')).toBe(false);
  });

  it('wildcard: *.modelscope.cn matches a.modelscope.cn (single-level)', () => {
    expect(matchDomain('*.modelscope.cn', 'a.modelscope.cn')).toBe(true);
  });

  it('handles port numbers in host header', () => {
    expect(matchDomain('docker.io', 'docker.io:443')).toBe(true);
  });

  it('case insensitive', () => {
    expect(matchDomain('Docker.IO', 'docker.io')).toBe(true);
  });
});

describe('BUILTIN_ALLOWED_DOMAINS', () => {
  it('contains essential AI workload domains', () => {
    expect(BUILTIN_ALLOWED_DOMAINS).toContain('docker.io');
    expect(BUILTIN_ALLOWED_DOMAINS).toContain('huggingface.co');
    expect(BUILTIN_ALLOWED_DOMAINS).toContain('pypi.org');
    expect(BUILTIN_ALLOWED_DOMAINS).toContain('github.com');
  });
});

describe('createProxyServer', () => {
  let proxy: ReturnType<typeof createProxyServer>;
  let port: number;
  let allowedLog: string[] = [];
  let blockedLog: string[] = [];

  beforeEach(async () => {
    port = await findFreePort();
    allowedLog = [];
    blockedLog = [];
    proxy = createProxyServer({
      allowedDomains: ['docker.io', '*.modelscope.cn'],
      blockedDomains: ['evil.com'],
      port,
      logAccess: (entry) => {
        if (entry.allowed) allowedLog.push(entry.domain);
        else blockedLog.push(entry.domain);
      },
    });
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
  });

  it('starts and listens on the configured TCP port', () => {
    const actualPort = proxy.getPort();
    expect(actualPort).toBe(port);
  });

  it('allows CONNECT to whitelisted domain with local upstream', async () => {
    // Create a separate proxy that allows 127.0.0.1 for testing
    const testPort = await findFreePort();
    const upstream = await createEchoServer();
    const testProxy = createProxyServer({
      allowedDomains: ['127.0.0.1'],
      blockedDomains: [],
      port: testPort,
    });
    await testProxy.start();
    try {
      const { statusCode } = await sendConnect(testPort, '127.0.0.1', upstream.port, 5000);
      expect(statusCode).toBe(200);
    } finally {
      await testProxy.stop();
      await upstream.stop();
    }
  }, 10000);

  it('blocks CONNECT to unknown domain (returns 403 without onConfirm)', async () => {
    const { statusCode } = await sendConnect(port, 'unknown.com', 443, 5000);
    expect(statusCode).toBe(403);
  }, 10000);

  it('blocks CONNECT to explicitly blocked domain', async () => {
    const { statusCode } = await sendConnect(port, 'evil.com', 443, 5000);
    expect(statusCode).toBe(403);
    expect(blockedLog).toContain('evil.com');
  }, 10000);

  it('returns 400 for non-CONNECT request', async () => {
    const result = await new Promise<{ statusCode: number }>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error('Request timed out'));
      }, 3000);

      const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
        socket.write('GET / HTTP/1.1\r\nHost: test\r\n\r\n');
      });

      socket.on('data', (data) => {
        clearTimeout(timer);
        const statusMatch = data.toString().match(/^HTTP\/1\.1\s+(\d+)/);
        if (statusMatch) {
          resolve({ statusCode: parseInt(statusMatch[1], 10) });
        }
        socket.end();
      });

      socket.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
    expect(result.statusCode).toBe(400);
  }, 10000);
});
