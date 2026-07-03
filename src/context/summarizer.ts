// src/context/summarizer.ts
import type { Summarizer, ContextConfig } from './types';
import type { ToolResult } from '../tools/types';

const SHORT_OUTPUT_THRESHOLD = 200; // characters
const MAX_CONCURRENT = 5;

interface ApiConfig {
  api_url: string;
  api_key: string;
  model: string;
}

export function createSummarizer(
  contextConfig: ContextConfig,
  apiConfig: ApiConfig,
): Summarizer {
  const model = contextConfig.summarizer_model || apiConfig.model;
  let pending = 0;
  const queue: Array<() => void> = [];
  let aborted = false;

  function releaseSlot(): void {
    pending--;
    const next = queue.shift();
    if (next) next();
  }

  function acquireSlot(): Promise<void> {
    if (aborted) return Promise.reject(new Error('Summarizer cancelled'));
    if (pending < MAX_CONCURRENT) {
      pending++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(() => {
        if (aborted) return;
        pending++;
        resolve();
      });
    });
  }

  async function summarize(toolName: string, result: ToolResult): Promise<string> {
    // Short output optimization — no LLM call needed
    if (result.content.length < SHORT_OUTPUT_THRESHOLD) {
      return result.content;
    }

    try {
      await acquireSlot();

      if (aborted) return result.content;

      const systemPrompt = [
        'Summarize the following tool execution result in 1-2 sentences.',
        'Include: what was done, result/outcome, exit code.',
        'Do NOT include full logs, stack traces, or verbose output.',
      ].join(' ');

      const userPrompt = [
        `Tool: ${toolName}`,
        `Result: ${result.content}`,
      ].join('\n');

      const response = await fetch(`${apiConfig.api_url}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiConfig.api_key}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          stream: true,
        }),
      });

      if (!response.ok) {
        // API error — don't crash, return fallback
        console.warn(`[summarizer] API error (${response.status}), using truncated original`);
        return truncate(result.content);
      }

      const reader = response.body?.getReader();
      if (!reader) return truncate(result.content);

      const decoder = new TextDecoder();
      let buffer = '';
      let summary = '';

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
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);
            const content = parsed.choices?.[0]?.delta?.content;
            if (content) summary += content;
          } catch {
            // skip unparseable lines
          }
        }
      }

      if (!summary.trim()) return truncate(result.content);
      return summary.trim();
    } catch (e) {
      // Network or other error — return truncated fallback
      console.warn(`[summarizer] failed: ${e instanceof Error ? e.message : String(e)}`);
      return truncate(result.content);
    } finally {
      releaseSlot();
    }
  }

  function truncate(text: string): string {
    if (text.length <= 300) return text;
    return text.slice(0, 297) + '...';
  }

  function cancelAll(): void {
    aborted = true;
    queue.length = 0;
  }

  return { summarize, cancelAll };
}
