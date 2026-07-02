// src/agent/loop.ts
import type { Config } from '../config/types';
import type { Message } from '../llm/types';
import { chatStream } from '../llm/client';

export interface AgentOptions {
  /** Called for each token received from the LLM. */
  onToken?: (token: string) => void;
}

export interface AgentSession {
  /** Send a user message, stream the assistant response, return the full reply. */
  send(input: string, signal?: AbortSignal): Promise<string>;
  /** Snapshot of current conversation history. */
  readonly history: ReadonlyArray<Message>;
}

export function createAgent(config: Config, options: AgentOptions = {}): AgentSession {
  const history: Message[] = [];

  async function send(input: string, signal?: AbortSignal): Promise<string> {
    // Build request messages without mutating history — if chatStream fails,
    // history must remain unchanged so subsequent sends see a valid state.
    const requestMessages: Message[] = [...history, { role: 'user', content: input }];

    let full = '';
    await chatStream(config, requestMessages, (token) => {
      full += token;
      options.onToken?.(token);
    }, signal);

    // Only commit after success
    history.push({ role: 'user', content: input });
    history.push({ role: 'assistant', content: full });
    return full;
  }

  return {
    send,
    get history() { return [...history]; },
  };
}
