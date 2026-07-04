// src/mcp/transports/stdio.ts
import { spawn, type ChildProcess } from 'node:child_process';
import type { Transport, JSONRPCMessage } from '../types';

// ── Environment defaults (same as MCP SDK) ──

const DEFAULT_INHERITED_ENV_VARS = process.platform === 'win32'
  ? [
    'APPDATA', 'HOMEDRIVE', 'HOMEPATH', 'LOCALAPPDATA', 'PATH',
    'PROCESSOR_ARCHITECTURE', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP',
    'USERNAME', 'USERPROFILE',
  ]
  : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];

function getDefaultEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    const value = process.env[key];
    if (value !== undefined && !value.startsWith('()')) {
      env[key] = value;
    }
  }
  return env;
}

// ── ReadBuffer: splits incoming data into newline-delimited JSON lines ──

class ReadBuffer {
  private buffer = '';

  append(chunk: Buffer): void {
    this.buffer += chunk.toString('utf-8');
  }

  readMessage(): JSONRPCMessage | null {
    const idx = this.buffer.indexOf('\n');
    if (idx === -1) return null;
    const line = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + 1);
    if (!line.trim()) return null;
    return JSON.parse(line) as JSONRPCMessage;
  }

  clear(): void {
    this.buffer = '';
  }
}

function serializeMessage(message: JSONRPCMessage): string {
  return JSON.stringify(message) + '\n';
}

// ── StdioTransportOptions ──

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: 'inherit' | 'ignore' | 'pipe';
}

// ── StdioTransport ──

export class StdioTransport implements Transport {
  private process: ChildProcess | null = null;
  private readBuffer = new ReadBuffer();
  private _options: StdioTransportOptions;
  private started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options: StdioTransportOptions) {
    this._options = options;
  }

  async start(): Promise<void> {
    if (this.started) return;

    const { command, args = [], env: userEnv, cwd, stderr = 'inherit' } = this._options;

    // Merge user env with defaults so PATH/HOME/etc. are preserved
    const defaultEnv = getDefaultEnvironment();
    const mergedEnv = userEnv ? { ...defaultEnv, ...userEnv } : undefined;

    return new Promise((resolve, reject) => {
      this.process = spawn(command, args, {
        env: mergedEnv ?? defaultEnv,
        stdio: ['pipe', 'pipe', stderr],
        shell: false,
        cwd,
      });

      this.process.on('error', (err) => {
        reject(err);
        this.onerror?.(err);
      });

      this.process.on('spawn', () => {
        this.started = true;
        resolve();
      });

      this.process.on('close', () => {
        this.process = null;
        this.started = false;
        this.onclose?.();
      });

      this.process.stdin?.on('error', (err) => {
        this.onerror?.(err);
      });

      this.process.stdout?.on('data', (chunk: Buffer) => {
        this.readBuffer.append(chunk);
        this._processReadBuffer();
      });

      this.process.stdout?.on('error', (err) => {
        this.onerror?.(err);
      });
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin) {
        reject(new Error('StdioTransport: not connected'));
        return;
      }
      const data = serializeMessage(message);
      if (this.process.stdin.write(data)) {
        resolve();
      } else {
        this.process.stdin.once('drain', () => resolve());
      }
    });
  }

  async close(): Promise<void> {
    this.process?.kill();
    this.process = null;
    this.started = false;
    this.readBuffer.clear();
    this.onclose?.();
  }

  private _processReadBuffer(): void {
    while (true) {
      try {
        const msg = this.readBuffer.readMessage();
        if (msg === null) break;
        this.onmessage?.(msg);
      } catch (err) {
        this.onerror?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
}
