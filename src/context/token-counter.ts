import { encoding_for_model } from 'tiktoken';
import type { Message } from '../llm/types';
import type { TiktokenModel } from 'tiktoken';

/**
 * Compute exact token count for messages using tiktoken.
 * Encodes each message as JSON (including role/key/name fields)
 * to capture framing overhead automatically.
 */
export function estimateTokens(messages: Message[], model: string): number {
    if (messages.length === 0) return 0;

    let enc;
    try {
        enc = encoding_for_model(model as TiktokenModel);
    } catch {
        enc = encoding_for_model('gpt-4o');
    }

    let total = 0;
    for (const msg of messages) {
        total += enc.encode(JSON.stringify(msg)).length;
    }
    enc.free();
    return total;
}
