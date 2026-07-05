// src/agent/subagent/context-decorator.ts

import type { ContextManager } from '../../context/types';
import type { SubagentMessage } from './types';

/**
 * Wraps a ContextManager so that assemble() automatically prepends
 * unseen inbox messages as system messages. No side effects on inbox.
 */
export function createMessageInjector(
  base: ContextManager,
  getInbox: () => SubagentMessage[],
): ContextManager {
  const injectedIds = new Set<string>();

  return {
    append: base.append.bind(base),
    compact: base.compact.bind(base),
    pin: base.pin.bind(base),
    unpin: base.unpin.bind(base),
    findByToolCallId: base.findByToolCallId.bind(base),
    setState: base.setState.bind(base),
    getState: base.getState.bind(base),
    truncateTo: base.truncateTo.bind(base),
    cancelAll: base.cancelAll.bind(base),
    clear: base.clear.bind(base),
    getFlowEntries: base.getFlowEntries.bind(base),

    assemble(): ReturnType<ContextManager['assemble']> {
      const messages = base.assemble();
      const inbox = getInbox();

      for (const msg of inbox) {
        if (injectedIds.has(msg.id)) continue;

        messages.unshift({
          role: 'system',
          content: `[Incoming ${msg.type} from ${msg.from.slice(0, 12)}]: ${msg.payload}`,
        });
        injectedIds.add(msg.id);
      }

      // Prune stale IDs — messages removed from inbox
      const activeIds = new Set(inbox.map(m => m.id));
      for (const id of injectedIds) {
        if (!activeIds.has(id)) injectedIds.delete(id);
      }

      return messages;
    },
  };
}
