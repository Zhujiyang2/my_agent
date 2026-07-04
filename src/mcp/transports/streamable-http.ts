// src/mcp/transports/streamable-http.ts
import type { Transport, JSONRPCMessage } from '../types';

export interface StreamableHTTPOptions {
  url: string;
  headers?: Record<string, string>;
}

/**
 * Streamable HTTP transport for MCP (spec 2024-11-05).
 *
 * Sends JSON-RPC messages via HTTP POST. If the server responds with
 * `Content-Type: text/event-stream`, the response body is parsed as an
 * SSE stream and each `data:` line is emitted as a message.
 */
export class StreamableHTTPTransport implements Transport {
  private _url: string;
  private _headers: Record<string, string>;
  private _sessionId?: string;
  private _abortController = new AbortController();

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(options: StreamableHTTPOptions) {
    this._url = options.url;
    this._headers = { ...options.headers };
  }

  async start(): Promise<void> {
    // Streamable HTTP has no persistent connection — ready immediately.
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...this._headers,
    };

    if (this._sessionId) {
      headers['Mcp-Session-Id'] = this._sessionId;
    }

    const response = await fetch(this._url, {
      method: 'POST',
      headers,
      body: JSON.stringify(message),
      signal: this._abortController.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '<unreadable>');
      throw new Error(`MCP request failed (HTTP ${response.status}): ${text}`);
    }

    // Capture session ID for subsequent requests
    const sid = response.headers.get('Mcp-Session-Id');
    if (sid) this._sessionId = sid;

    const contentType = response.headers.get('Content-Type') || '';

    if (contentType.includes('text/event-stream')) {
      await this._handleSSEStream(response);
    } else {
      const data = await response.json().catch(() => null);
      if (data) {
        this.onmessage?.(data as JSONRPCMessage);
      }
    }
  }

  async close(): Promise<void> {
    this._abortController.abort();
    this.onclose?.();
  }

  // ── Private ──

  private async _handleSSEStream(response: Response): Promise<void> {
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('StreamableHTTPTransport: no response body for SSE stream');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const payload = line.slice(6);
            try {
              const parsed = JSON.parse(payload);
              this.onmessage?.(parsed as JSONRPCMessage);
            } catch {
              // Skip unparseable lines in the stream
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
