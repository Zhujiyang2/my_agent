// src/llm/client.ts
import type { Config } from '../config/types';
import type { Message, ChatCompletionChunk, ToolCall } from './types';

export interface StreamResult {
  finishReason: string;
  content: string;
  toolCalls: ToolCall[];
}

export async function chatStream(
  config: Config,
  messages: Message[],
  tools: Array<Record<string, unknown>> | undefined,
  onToken: (token: string) => void,
  signal?: AbortSignal,
): Promise<StreamResult> {
  const url = `${config.api_url}/chat/completions`;

  const body: Record<string, unknown> = {
    model: config.model,
    messages,
    stream: true,
  };
  if (tools && tools.length > 0) {
    body.tools = tools;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.api_key}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '<unreadable>');
    throw new Error(`API request failed (${response.status}): ${errorBody}`);
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('Response body is empty');

  const decoder = new TextDecoder();
  let buffer = '';

  let content = '';
  let finishReason = 'stop';
  const toolCallMap = new Map<number, ToolCall>();

  let streamDone = false;
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
      if (data === '[DONE]') {
        streamDone = true;
        break;
      }

      try {
        const parsed = JSON.parse(data) as ChatCompletionChunk;
        const choice = parsed.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) {
          finishReason = choice.finish_reason;
        }

        const token = choice.delta?.content;
        if (token) {
          content += token;
          onToken(token);
        }

        const deltas = choice.delta?.tool_calls;
        if (deltas) {
          for (const delta of deltas) {
            const existing = toolCallMap.get(delta.index);
            if (existing) {
              if (delta.function?.arguments) {
                existing.function.arguments += delta.function.arguments;
              }
            } else if (delta.id) {
              toolCallMap.set(delta.index, {
                id: delta.id,
                type: 'function',
                function: {
                  name: delta.function?.name ?? '',
                  arguments: delta.function?.arguments ?? '',
                },
              });
            }
          }
        }
      } catch {
        // skip unparseable lines
      }
    }

    if (streamDone) break;
  }

  const toolCalls = Array.from(toolCallMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => tc);

  return { finishReason, content, toolCalls };
}
