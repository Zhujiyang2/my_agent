// src/sandbox/net-proxy.ts
import net from 'node:net';

// Built-in domain allowlist for AI workloads
export const BUILTIN_ALLOWED_DOMAINS = [
  'docker.io',
  'registry-1.docker.io',
  'quay.io',
  'mirrors.aliyun.com',
  'my-registry.io',
  'huggingface.co',
  'hf.co',
  'cdn-lfs.huggingface.co',
  'modelscope.cn',
  '*.modelscope.cn',
  'pypi.org',
  'files.pythonhosted.org',
  'github.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
];

export interface ProxyConfig {
  allowedDomains: string[];
  blockedDomains: string[];
  socketPath?: string;
  /** TCP port to listen on (alternative to socketPath, useful for testing on Windows) */
  port?: number;
  onConfirm?: (domain: string) => Promise<boolean>;
  logAccess?: (entry: AccessLogEntry) => void;
}

export interface AccessLogEntry {
  domain: string;
  timestamp: number;
  method: string;
  path: string;
  allowed: boolean;
  bytesSent: number;
}

/**
 * Check if a hostname matches an allowlist pattern.
 * Patterns may be exact ("docker.io") or wildcard ("*.modelscope.cn").
 */
export function matchDomain(pattern: string, hostname: string): boolean {
  // Strip port if present
  const host = hostname.replace(/:\d+$/, '');
  const patternLower = pattern.toLowerCase();
  const hostLower = host.toLowerCase();

  if (patternLower === hostLower) return true;

  // Wildcard: *.example.com matches sub.example.com (one level only)
  if (patternLower.startsWith('*.')) {
    const suffix = patternLower.slice(1); // .example.com
    // Host must end with suffix and have at least one subdomain label
    if (hostLower.endsWith(suffix) && hostLower.length > suffix.length) {
      const subdomain = hostLower.slice(0, -suffix.length);
      // Only match single-level subdomains (no dots in the subdomain part)
      return !subdomain.includes('.');
    }
  }

  return false;
}

function isDomainAllowed(
  hostname: string,
  allowed: string[],
  blocked: string[]
): 'allowed' | 'blocked' | 'unknown' {
  // Blocked domains take priority
  for (const b of blocked) {
    if (matchDomain(b, hostname)) return 'blocked';
  }
  // Then check allowed
  for (const a of allowed) {
    if (matchDomain(a, hostname)) return 'allowed';
  }
  return 'unknown';
}

export function createProxyServer(config: ProxyConfig) {
  const socketPath = config.socketPath ?? '/tmp/my-agent-proxy.sock';
  const tcpPort = config.port;
  let server: net.Server | null = null;
  const connections = new Set<net.Socket>();

  // Combine built-in + user-defined domains for the effective allowlist
  const effectiveAllowed = [...BUILTIN_ALLOWED_DOMAINS, ...config.allowedDomains];

  const handleConnection = (clientSocket: net.Socket) => {
    connections.add(clientSocket);
    clientSocket.once('data', async (data) => {
      const head = data.toString();
      const connectMatch = head.match(/^CONNECT\s+(\S+)/i);
      if (!connectMatch) {
        clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        clientSocket.end();
        return;
      }

      const [targetHost, targetPortStr] = connectMatch[1].split(':');
      const targetPort = parseInt(targetPortStr, 10) || 443;
      const hostname = targetHost.replace(/:\d+$/, '');

      const verdict = isDomainAllowed(hostname, effectiveAllowed, config.blockedDomains);

      if (verdict === 'blocked') {
        config.logAccess?.({
          domain: hostname, timestamp: Date.now(),
          method: 'CONNECT', path: `${hostname}:${targetPort}`,
          allowed: false, bytesSent: 0,
        });
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.end();
        return;
      }

      if (verdict === 'unknown') {
        if (config.onConfirm) {
          const confirmed = await config.onConfirm(hostname);
          if (!confirmed) {
            config.logAccess?.({
              domain: hostname, timestamp: Date.now(),
              method: 'CONNECT', path: `${hostname}:${targetPort}`,
              allowed: false, bytesSent: 0,
            });
            clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            clientSocket.end();
            return;
          }
        } else {
          config.logAccess?.({
            domain: hostname, timestamp: Date.now(),
            method: 'CONNECT', path: `${hostname}:${targetPort}`,
            allowed: false, bytesSent: 0,
          });
          clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          clientSocket.end();
          return;
        }
      }

      // Allowed: establish upstream connection
      let bytesSent = 0;
      const upstream = net.createConnection({ host: targetHost, port: targetPort }, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        connections.add(upstream);
        clientSocket.pipe(upstream);
        upstream.pipe(clientSocket);
        upstream.on('data', (chunk) => { bytesSent += chunk.length; });
      });

      upstream.on('error', () => {
        if (!clientSocket.destroyed) {
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
        clientSocket.end();
      });

      upstream.on('close', () => {
        config.logAccess?.({
          domain: hostname, timestamp: Date.now(),
          method: 'CONNECT', path: `${hostname}:${targetPort}`,
          allowed: true, bytesSent,
        });
        connections.delete(upstream);
      });

      clientSocket.on('close', () => {
        upstream.destroy();
        connections.delete(clientSocket);
      });
    });

    clientSocket.on('error', () => {});
  };

  return {
    async start(): Promise<void> {
      return new Promise((resolve) => {
        server = net.createServer(handleConnection);

        if (tcpPort !== undefined) {
          server.listen(tcpPort, '127.0.0.1', () => resolve());
        } else {
          server.listen(socketPath, () => resolve());
        }
      });
    },

    /** Returns the port the server is listening on (only meaningful when using TCP mode) */
    getPort(): number | null {
      if (server && tcpPort !== undefined) {
        const addr = server.address();
        return typeof addr === 'object' && addr !== null ? addr.port : null;
      }
      return null;
    },

    async stop(): Promise<void> {
      return new Promise((resolve) => {
        for (const conn of connections) {
          conn.destroy();
          connections.delete(conn);
        }
        if (server) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      });
    },
  };
}
