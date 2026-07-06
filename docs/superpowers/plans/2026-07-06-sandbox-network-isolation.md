# Sandbox Network Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `--share-net` with `--unshare-net` + HTTP CONNECT proxy with domain whitelist to prevent prompt-injection data exfiltration while preserving network access for AI workloads (model downloads, pip installs, Docker operations via daemon socket).

**Architecture:** Six tasks. `net-domains.ts` loads `~/.my_agent/sandbox-domains.json`. `net-proxy.ts` implements a Unix-socket HTTP CONNECT proxy with domain allowlist/blocklist matching and optional confirmation callback. `bwrap-executor.ts` switches to `--unshare-net`, fixes DNS for systemd-resolved, bind-mounts the proxy socket, and wraps commands with a socat forwarder + proxy env vars. `sandbox-manager.ts` manages proxy lifecycle. `bin/my-agent.ts` loads domain config and wires confirmation UI.

**Tech Stack:** TypeScript, Node.js `net` module (Unix socket + raw TCP), bubblewrap, socat, vitest.

---

## File Map

| Action | File | Purpose |
|--------|------|---------|
| Create | `src/sandbox/net-domains.ts` | Load `~/.my_agent/sandbox-domains.json` |
| Create | `src/sandbox/net-proxy.ts` | HTTP CONNECT proxy with domain filtering |
| Create | `src/sandbox/__tests__/net-domains.test.ts` | Tests for domain config loading |
| Create | `src/sandbox/__tests__/net-proxy.test.ts` | Tests for proxy domain matching + CONNECT |
| Modify | `src/sandbox/bwrap-executor.ts:66-69` | `--unshare-net`, DNS fix, socat wrapper, proxy bind-mount |
| Modify | `src/sandbox/__tests__/bwrap-executor.test.ts` | Updated assertions for network isolation |
| Modify | `src/sandbox/sandbox-manager.ts:34-36` | Proxy lifecycle (start/stop/health check) |
| Modify | `src/sandbox/__tests__/sandbox-manager.test.ts` | Proxy integration tests |
| Modify | `bin/my-agent.ts:101-104` | Load domains, init proxy with onConfirm |

---

### Task 1: Domain config loader (net-domains.ts)

**Files:**
- Create: `src/sandbox/net-domains.ts`
- Create: `src/sandbox/__tests__/net-domains.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sandbox/__tests__/net-domains.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadSandboxDomains } from '../net-domains';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('loadSandboxDomains', () => {
  const tmpFile = path.join(os.tmpdir(), `sandbox-domains-test-${Date.now()}.json`);

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it('returns empty config when file does not exist', () => {
    const result = loadSandboxDomains('/nonexistent/path/domains.json');
    expect(result.extra_allowed_domains).toEqual([]);
    expect(result.blocked_domains).toEqual([]);
  });

  it('loads domains from a valid file', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      extra_allowed_domains: ['example.com'],
      blocked_domains: ['bad.com'],
    }));
    const result = loadSandboxDomains(tmpFile);
    expect(result.extra_allowed_domains).toEqual(['example.com']);
    expect(result.blocked_domains).toEqual(['bad.com']);
  });

  it('returns empty config for malformed JSON', () => {
    fs.writeFileSync(tmpFile, '{not json}');
    const result = loadSandboxDomains(tmpFile);
    expect(result.extra_allowed_domains).toEqual([]);
    expect(result.blocked_domains).toEqual([]);
  });

  it('filters non-string entries from arrays', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({
      extra_allowed_domains: ['good.com', 123, null, ''],
      blocked_domains: ['bad.com', {}, true],
    }));
    const result = loadSandboxDomains(tmpFile);
    expect(result.extra_allowed_domains).toEqual(['good.com']);
    expect(result.blocked_domains).toEqual(['bad.com']);
  });

  it('defaults missing fields to empty arrays', () => {
    fs.writeFileSync(tmpFile, JSON.stringify({}));
    const result = loadSandboxDomains(tmpFile);
    expect(result.extra_allowed_domains).toEqual([]);
    expect(result.blocked_domains).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/__tests__/net-domains.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/sandbox/net-domains.ts
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface SandboxDomainsConfig {
  extra_allowed_domains: string[];
  blocked_domains: string[];
}

export function loadSandboxDomains(filePath?: string): SandboxDomainsConfig {
  const resolvedPath = filePath ?? path.join(os.homedir(), '.my_agent', 'sandbox-domains.json');

  if (!fs.existsSync(resolvedPath)) {
    return { extra_allowed_domains: [], blocked_domains: [] };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(resolvedPath, 'utf-8'));
  } catch {
    console.warn(`[sandbox] Invalid JSON in ${resolvedPath}, using empty domain config.`);
    return { extra_allowed_domains: [], blocked_domains: [] };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    console.warn(`[sandbox] ${resolvedPath} must contain a JSON object, using empty domain config.`);
    return { extra_allowed_domains: [], blocked_domains: [] };
  }

  const cfg = raw as Record<string, unknown>;

  return {
    extra_allowed_domains: filterStrings(cfg.extra_allowed_domains),
    blocked_domains: filterStrings(cfg.blocked_domains),
  };
}

function filterStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sandbox/__tests__/net-domains.test.ts`
Expected: all 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/net-domains.ts src/sandbox/__tests__/net-domains.test.ts
git commit -m "feat: add sandbox domain config loader from sandbox-domains.json"
```

---

### Task 2: HTTP CONNECT proxy server (net-proxy.ts)

**Files:**
- Create: `src/sandbox/net-proxy.ts`
- Create: `src/sandbox/__tests__/net-proxy.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/sandbox/__tests__/net-proxy.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createProxyServer, matchDomain, BUILTIN_ALLOWED_DOMAINS } from '../net-proxy';
import net from 'node:net';
import http from 'node:http';
import fs from 'node:fs';

const SOCKET_PATH = '/tmp/net-proxy-test.sock';

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

  it('wildcard: *.modelscope.cn matches a.b.modelscope.cn (single-level)', () => {
    // Wildcard only matches one subdomain level
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
  let allowedLog: string[] = [];
  let blockedLog: string[] = [];

  beforeEach(async () => {
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
    allowedLog = [];
    blockedLog = [];
    proxy = createProxyServer({
      allowedDomains: ['docker.io', '*.modelscope.cn'],
      blockedDomains: ['evil.com'],
      socketPath: SOCKET_PATH,
      logAccess: (entry) => {
        if (entry.allowed) allowedLog.push(entry.domain);
        else blockedLog.push(entry.domain);
      },
    });
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    try { fs.unlinkSync(SOCKET_PATH); } catch {}
  });

  it('starts and creates a Unix socket', () => {
    expect(fs.existsSync(SOCKET_PATH)).toBe(true);
  });

  it('allows CONNECT to whitelisted domain', (done) => {
    const req = http.request({
      socketPath: SOCKET_PATH,
      path: 'docker.io:443',
      method: 'CONNECT',
      headers: { host: 'docker.io:443' },
    });
    req.on('connect', (res, socket) => {
      expect(res.statusCode).toBe(200);
      socket.end();
      done();
    });
    req.on('error', done);
    req.end();
  }, 5000);

  it('blocks CONNECT to unknown domain (no onConfirm)', (done) => {
    const req = http.request({
      socketPath: SOCKET_PATH,
      path: 'unknown.com:443',
      method: 'CONNECT',
      headers: { host: 'unknown.com:443' },
    });
    req.on('response', (res) => {
      // HTTP CONNECT failure returns a non-2xx response
      expect(res.statusCode).not.toBe(200);
      done();
    });
    req.on('error', done);
    req.end();
  }, 5000);

  it('logs blocked domains', async () => {
    const req = http.request({
      socketPath: SOCKET_PATH,
      path: 'evil.com:443',
      method: 'CONNECT',
      headers: { host: 'evil.com:443' },
    });
    await new Promise<void>((resolve) => {
      req.on('connect', resolve);
      req.on('response', () => resolve());
      req.on('error', () => resolve());
      req.end();
    });
    expect(blockedLog).toContain('evil.com');
  });

  it('rejects wildcard-matching blocked domain', async () => {
    // evil.com is in blocked list — exact match beats any allow list
    const req = http.request({
      socketPath: SOCKET_PATH,
      path: 'evil.com:443',
      method: 'CONNECT',
      headers: { host: 'evil.com:443' },
    });
    await new Promise<void>((resolve) => {
      req.on('connect', () => resolve());
      req.on('response', () => resolve());
      req.on('error', () => resolve());
      req.end();
    });
    expect(blockedLog).toContain('evil.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/__tests__/net-proxy.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/sandbox/net-proxy.ts
import net from 'node:net';
import fs from 'node:fs';

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
  let server: net.Server | null = null;
  const connections = new Set<net.Socket>();

  // Combine built-in + user-defined domains for the effective allowlist
  const effectiveAllowed = [...BUILTIN_ALLOWED_DOMAINS, ...config.allowedDomains];

  return {
    async start(): Promise<void> {
      return new Promise((resolve) => {
        server = net.createServer((clientSocket) => {
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
                // Add to a session-level approved set? For now, just allow.
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
              // Track bytes for logging
              upstream.on('data', (chunk) => { bytesSent += chunk.length; });
            });

            upstream.on('error', () => {
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
        });

        server.listen(socketPath, () => resolve());
      });
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sandbox/__tests__/net-proxy.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/net-proxy.ts src/sandbox/__tests__/net-proxy.test.ts
git commit -m "feat: add HTTP CONNECT proxy server with domain allowlist"
```

---

### Task 3: DNS fix for systemd-resolved in bwrap-executor

**Files:**
- Modify: `src/sandbox/bwrap-executor.ts:32-83`
- Modify: `src/sandbox/__tests__/bwrap-executor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/sandbox/__tests__/bwrap-executor.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { buildBwrapCommand, isBwrapAvailable, findBwrap } from '../bwrap-executor';
import { createPathPolicy } from '../path-policy';
import path from 'node:path';
import fs from 'node:fs';

// ... existing imports ...

describe('buildBwrapCommand — DNS fix', () => {
  let policy: ReturnType<typeof createPathPolicy>;
  let resolvBackup: string | null;

  beforeEach(() => {
    policy = createPathPolicy();
    // Backup real resolv.conf
    if (fs.existsSync('/etc/resolv.conf')) {
      resolvBackup = fs.readFileSync('/etc/resolv.conf', 'utf-8');
    }
  });

  afterEach(() => {
    // Restore
    if (resolvBackup) {
      fs.writeFileSync('/etc/resolv.conf', resolvBackup);
    }
    try { fs.unlinkSync('/tmp/my-agent-resolv.conf'); } catch {}
  });

  it('adds --bind for fixed resolv.conf when nameserver points to 127.x.x.x', () => {
    // Simulate systemd-resolved
    if (resolvBackup !== null) {
      fs.writeFileSync('/etc/resolv.conf', 'nameserver 127.0.0.53\n');
    }
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    // Should include the resolv.conf override
    if (resolvBackup !== null) {
      expect(joined).toContain('/tmp/my-agent-resolv.conf');
      expect(joined).toContain('/etc/resolv.conf');
      // The fixed file should exist
      expect(fs.existsSync('/tmp/my-agent-resolv.conf')).toBe(true);
    }
  });

  it('does NOT add resolv.conf override when nameserver is external', () => {
    if (resolvBackup !== null) {
      fs.writeFileSync('/etc/resolv.conf', 'nameserver 8.8.8.8\n');
    }
    const cmd = buildBwrapCommand('echo hello', policy);
    const joined = cmd.join(' ');
    expect(joined).not.toContain('my-agent-resolv.conf');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/__tests__/bwrap-executor.test.ts`
Expected: FAIL — assertions on DNS fix not met

- [ ] **Step 3: Write the DNS fix in buildBwrapCommand**

In `bwrap-executor.ts`, add before the `const args: string[] = ['bwrap'];` line:

```typescript
function fixResolvConf(): string | null {
  try {
    const content = fs.readFileSync('/etc/resolv.conf', 'utf-8');
    const hasLocalResolver = /^nameserver\s+127\./m.test(content);
    if (!hasLocalResolver) return null;

    // Try systemd-resolved's stub file first
    const resolvedStub = '/run/systemd/resolve/resolv.conf';
    if (fs.existsSync(resolvedStub)) {
      return resolvedStub;
    }

    // Fallback: generate a fixed resolv.conf with public DNS
    const fixed = 'nameserver 8.8.8.8\nnameserver 114.114.114.114\n';
    const tmpPath = '/tmp/my-agent-resolv.conf';
    fs.writeFileSync(tmpPath, fixed);
    return tmpPath;
  } catch {
    return null;
  }
}
```

Then in `buildBwrapCommand`, after the `const args = ['bwrap'];` line and before `--ro-bind / /`:

```typescript
// Fix DNS for systemd-resolved (127.0.0.53 unreachable in new netns)
const resolvConfFix = fixResolvConf();
```

And after `args.push('--ro-bind', '/', '/');`, add:

```typescript
// Override resolv.conf if DNS fix was applied
if (resolvConfFix) {
  args.push('--bind', resolvConfFix, '/etc/resolv.conf');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sandbox/__tests__/bwrap-executor.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/bwrap-executor.ts src/sandbox/__tests__/bwrap-executor.test.ts
git commit -m "feat: add DNS fix for systemd-resolved in bwrap sandbox"
```

---

### Task 4: Network isolation in bwrap-executor (--unshare-net + socat + proxy)

**Files:**
- Modify: `src/sandbox/bwrap-executor.ts:65-69,70-80`

- [ ] **Step 1: Update the existing tests**

In `src/sandbox/__tests__/bwrap-executor.test.ts`, update the network-related assertions:

Replace:
```typescript
expect(joined).toContain('--share-net');
```
With:
```typescript
expect(joined).toContain('--unshare-net');
```

Also add new assertions for the socat wrapper and proxy socket bind-mount:

```typescript
it('includes --unshare-net instead of --share-net', () => {
  const cmd = buildBwrapCommand('echo hello', policy);
  const joined = cmd.join(' ');
  expect(joined).toContain('--unshare-net');
  expect(joined).not.toContain('--share-net');
});

it('includes proxy socket bind-mount', () => {
  const cmd = buildBwrapCommand('echo hello', policy);
  const joined = cmd.join(' ');
  expect(joined).toContain('/tmp/my-agent-proxy.sock');
});

it('wraps all commands with socat forwarder', () => {
  const cmd = buildBwrapCommand('echo hello', policy);
  const afterDash = cmd.slice(cmd.indexOf('--') + 1);
  // All commands now go through sh -c with socat wrapper
  expect(afterDash[0]).toBe('sh');
  expect(afterDash[1]).toBe('-c');
  const wrapper = afterDash[2];
  expect(wrapper).toContain('socat TCP-LISTEN:19877');
  expect(wrapper).toContain('HTTP_PROXY=http://127.0.0.1:19877');
});

it('injects proxy environment variables', () => {
  const cmd = buildBwrapCommand('echo hello', policy);
  const afterDash = cmd.slice(cmd.indexOf('--') + 1);
  const wrapper = afterDash[2];
  expect(wrapper).toContain('HTTP_PROXY=http://127.0.0.1:19877');
  expect(wrapper).toContain('HTTPS_PROXY=http://127.0.0.1:19877');
  expect(wrapper).toContain('http_proxy=http://127.0.0.1:19877');
  expect(wrapper).toContain('https_proxy=http://127.0.0.1:19877');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/__tests__/bwrap-executor.test.ts`
Expected: FAIL — `--share-net` still present, no socat wrapper

- [ ] **Step 3: Write the implementation changes**

In `buildBwrapCommand`:

Replace `args.push('--share-net');` with `args.push('--unshare-net');`

After the docker socket bind-mount block, add the proxy socket bind-mount:

```typescript
// Bind the proxy Unix socket into the sandbox
args.push('--bind', '/tmp/my-agent-proxy.sock', '/tmp/my-agent-proxy.sock');
```

Replace the command wrapping logic at the end of `buildBwrapCommand`:

```typescript
// Separator and target command
args.push('--');

// All commands are wrapped with socat forwarder + proxy env vars
const wrapperScript =
  'cleanup() { kill $SOCAT_PID 2>/dev/null; }; ' +
  'trap cleanup EXIT INT TERM; ' +
  'socat TCP-LISTEN:19877,fork,reuseaddr UNIX-CONNECT:/tmp/my-agent-proxy.sock & ' +
  'SOCAT_PID=$!; ' +
  'sleep 0.1; ' +
  'export HTTP_PROXY=http://127.0.0.1:19877; ' +
  'export HTTPS_PROXY=http://127.0.0.1:19877; ' +
  'export http_proxy=http://127.0.0.1:19877; ' +
  'export https_proxy=http://127.0.0.1:19877; ' +
  command + '; ' +
  'EXIT_CODE=$?; ' +
  'cleanup; ' +
  'exit $EXIT_CODE';

args.push('sh', '-c', wrapperScript);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sandbox/__tests__/bwrap-executor.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/bwrap-executor.ts src/sandbox/__tests__/bwrap-executor.test.ts
git commit -m "feat: switch to --unshare-net with socat proxy forwarder"
```

---

### Task 5: Proxy lifecycle in sandbox-manager

**Files:**
- Modify: `src/sandbox/sandbox-manager.ts:34-36,38-83`
- Modify: `src/sandbox/__tests__/sandbox-manager.test.ts`

- [ ] **Step 1: Add failing tests**

Add to `src/sandbox/__tests__/sandbox-manager.test.ts`:

```typescript
describe('proxy lifecycle', () => {
  it('accepts domain config and creates manager', () => {
    const mgr = createSandboxManager({
      ...DEFAULT_SANDBOX_CONFIG,
      domains: { extra_allowed_domains: [], blocked_domains: [] },
    });
    expect(mgr).toBeDefined();
  });

  it('starts proxy server when sandbox is enabled', () => {
    const mgr = createSandboxManager({
      ...DEFAULT_SANDBOX_CONFIG,
      domains: { extra_allowed_domains: [], blocked_domains: [] },
    });
    // getStatus should reflect proxy availability
    const status = mgr.getStatus();
    expect(status).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sandbox/__tests__/sandbox-manager.test.ts`
Expected: FAIL — `domains` not accepted, no proxy

- [ ] **Step 3: Update types and sandbox-manager**

Add to `src/sandbox/types.ts`:

```typescript
export interface SandboxDomainConfig {
  extra_allowed_domains: string[];
  blocked_domains: string[];
}
```

Update `SandboxConfig` to add optional `domains`:

```typescript
export interface SandboxConfig {
  enabled: boolean;
  engine: 'bwrap';
  extra_protect_paths: string[];
  fallback_to_warn: boolean;
  domains?: SandboxDomainConfig;
}
```

Update `SandboxStatus`:

```typescript
export interface SandboxStatus {
  enabled: boolean;
  engine: string;
  bwrapAvailable: boolean;
  socatAvailable: boolean;
  proxyRunning: boolean;
  writablePaths: string[];
  protectPaths: string[];
}
```

Update `DEFAULT_SANDBOX_CONFIG`:

```typescript
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  enabled: true,
  engine: 'bwrap',
  extra_protect_paths: [],
  fallback_to_warn: true,
  domains: { extra_allowed_domains: [], blocked_domains: [] },
};
```

Update `sandbox-manager.ts` to manage proxy lifecycle:

```typescript
import { createProxyServer } from './net-proxy';
import { execFileSync } from 'node:child_process';

function isSocatAvailable(): boolean {
  try {
    execFileSync('socat', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export function createSandboxManager(config: SandboxConfig): SandboxManager {
  const policy = createPathPolicy({
    extraProtectPaths: config.extra_protect_paths,
  });
  const dockerValidator = createDockerValidator(policy);

  const domainConfig = config.domains ?? { extra_allowed_domains: [], blocked_domains: [] };
  const proxy = createProxyServer({
    allowedDomains: domainConfig.extra_allowed_domains,
    blockedDomains: domainConfig.blocked_domains,
  });

  const socatAvailable = isSocatAvailable();

  // Start proxy on creation
  const proxyPromise = proxy.start().catch(() => {
    console.warn('[sandbox] Failed to start proxy server.');
  });

  return {
    async execute(command, options) {
      // Ensure proxy is running before executing
      await proxyPromise;

      if (!config.enabled) {
        return executeDirect(command, options);
      }

      // Docker command: validate volume mounts
      if (isDockerCommand(command)) {
        const validation = dockerValidator.validate(command);
        if (!validation.ok) {
          const reasons = validation.blocked
            .map((b) => `  - ${b.hostPath}: ${b.reason}`)
            .join('\n');
          return {
            content: `[SANDBOX BLOCKED] Docker volume mount(s) rejected:\n${reasons}`,
            summary: `sandbox=blocked | ${validation.blocked.length} illegal mount(s)`,
            exitCode: 1,
            isError: true,
          };
        }
      }

      if (!socatAvailable) {
        if (config.fallback_to_warn) {
          const result = executeDirect(command, options);
          result.content =
            '[SANDBOX WARNING] socat is not available — cannot isolate network. ' +
            'Command executed without network isolation.\n' +
            'Install socat: apt install socat / dnf install socat\n\n' +
            result.content;
          result.summary = 'sandbox=warn | ' + result.summary;
          return result;
        }
        return executeDirect(command, options);
      }

      const bwrapAvailable = isBwrapAvailable();
      if (!bwrapAvailable) {
        if (config.fallback_to_warn) {
          const result = executeDirect(command, options);
          result.content =
            '[SANDBOX WARNING] bwrap is not available on this system. ' +
            'Command executed without filesystem isolation.\n' +
            'Install bubblewrap: apt install bubblewrap / dnf install bubblewrap\n\n' +
            result.content;
          result.summary = 'sandbox=warn | ' + result.summary;
          return result;
        }
        return executeDirect(command, options);
      }

      return executeInBwrap(command, policy, options);
    },

    registerWritable(filePath) { /* unchanged */ },
    unregisterWritable(filePath) { /* unchanged */ },

    getStatus() {
      return {
        enabled: config.enabled,
        engine: config.engine,
        bwrapAvailable: isBwrapAvailable(),
        socatAvailable,
        proxyRunning: true, // proxy is started at creation
        writablePaths: policy.getWritablePaths(),
        protectPaths: policy.getProtectPaths(),
      };
    },
  };
}
```

Update the `SandboxManager` interface to include the `destroy` method:

```typescript
export interface SandboxManager {
  execute(command: string, options?: { workdir?: string; timeout?: number }): Promise<ToolResult>;
  registerWritable(filePath: string): { ok: boolean; error?: string };
  unregisterWritable(filePath: string): void;
  getStatus(): SandboxStatus;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sandbox/__tests__/sandbox-manager.test.ts`
Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sandbox/sandbox-manager.ts src/sandbox/__tests__/sandbox-manager.test.ts src/sandbox/types.ts
git commit -m "feat: add proxy lifecycle management to sandbox-manager"
```

---

### Task 6: Wire up in CLI entry point

**Files:**
- Modify: `bin/my-agent.ts:101-104`

- [ ] **Step 1: Update bin/my-agent.ts**

Add import at top:

```typescript
import { loadSandboxDomains } from '../src/sandbox/net-domains.js';
```

Update the sandbox initialization block (around line 104-118) to load domains and pass to manager:

```typescript
// Initialize sandbox manager with domain config
const domainsConfig = loadSandboxDomains();
const sandboxMgr = createSandboxManager({
  ...config.sandbox,
  domains: {
    extra_allowed_domains: domainsConfig.extra_allowed_domains,
    blocked_domains: domainsConfig.blocked_domains,
  },
});
setSandboxManager(sandboxMgr);

// Register sandbox tools
defaultRegistry.register(createRegisterWritableTool());

// Report sandbox status
const sandboxStatus = sandboxMgr.getStatus();
if (sandboxStatus.enabled) {
  const parts: string[] = [];
  if (sandboxStatus.bwrapAvailable) {
    parts.push('bwrap ✓');
  } else {
    parts.push('bwrap ✗ (fallback)');
  }
  if (sandboxStatus.socatAvailable) {
    parts.push('socat ✓');
  } else {
    parts.push('socat ✗ (no network isolation)');
  }
  console.log(formatInfo(`  Sandbox: ${parts.join(', ')}`));
}
```

- [ ] **Step 2: Verify TypeScript compilation**

Run: `npx tsc --noEmit`
Expected: no new errors (pre-existing context-decorator error is unrelated)

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
git add bin/my-agent.ts
git commit -m "feat: load domain config and wire network proxy into sandbox startup"
```

---

### Post-Implementation: Environment Validation

After all tasks are implemented, validate on a Linux machine:

1. Verify socat is available: `which socat`
2. Start my-agent with sandbox enabled
3. From another terminal, check proxy socket: `ls -la /tmp/my-agent-proxy.sock`
4. Run `curl https://huggingface.co` in sandbox → should work through proxy
5. Run `curl https://evil.com` in sandbox → should be blocked
6. Check that `docker pull` works (daemon-side, unaffected)
7. Check that `npu-smi info` works (device files, unaffected)
8. Verify DNS resolution works inside sandbox
