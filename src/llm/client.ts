// src/llm/client.ts
import type { Config } from '../config/types';
import type { Message } from './types';

export async function chatStream(
  config: Config,
  messages: Message[],
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${config.api_url}/chat/completions`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable>');
    throw new Error(`API request failed (${response.status}): ${body}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is empty');

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data: ')) continue;

      const data = trimmed.slice(6);
      if (data === '[DONE]') return;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content;
        if (content && content.length > 0) onToken(content);
      } catch {
        // skip unparseable lines
      }
    }
  }
}
