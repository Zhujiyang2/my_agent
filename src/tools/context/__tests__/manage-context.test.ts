// src/tools/context/__tests__/manage-context.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createManageContextTool } from '../manage-context';
import { createContextManager } from '../../../context/manager';
import type { ContextManager, ContextConfig } from '../../../context/types';

const CONFIG: ContextConfig = { max_context_tokens: 100000, recent_rounds: 3 };

function toolMsg(callId: string): any {
  return { role: 'tool', content: 'output', tool_call_id: callId, name: 'test_tool' };
}

describe('createManageContextTool', () => {
  let cm: ContextManager;

  beforeEach(() => {
    cm = createContextManager(CONFIG);
  });

  it('has the correct name and description', () => {
    const tool = createManageContextTool(cm);
    expect(tool.name).toBe('manage_context');
    expect(tool.description).toContain('Pin or unpin');
    expect(tool.parameters.type).toBe('object');
    expect(tool.parameters.properties.action.enum).toEqual(['pin', 'unpin']);
    expect(tool.parameters.required).toEqual(['action', 'tool_call_id']);
  });

  it('pins a message by tool_call_id', async () => {
    cm.append({ role: 'user', content: 'q' });
    cm.append(toolMsg('call_1'));

    const tool = createManageContextTool(cm);
    const result = await tool.handler({ action: 'pin', tool_call_id: 'call_1' });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain('pinned call_1');

    // Verify it's actually pinned: compact should not remove it
    cm.compact();
    const msgs = cm.assemble();
    const toolMsgs = msgs.filter(m => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
  });

  it('unpins a message by tool_call_id', async () => {
    cm.append({ role: 'user', content: 'q' });
    cm.append(toolMsg('call_1'));
    cm.pin(1); // pin it first

    const tool = createManageContextTool(cm);
    const result = await tool.handler({ action: 'unpin', tool_call_id: 'call_1' });

    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain('unpinned call_1');
  });

  it('returns error when tool_call_id is not found', async () => {
    const tool = createManageContextTool(cm);
    const result = await tool.handler({ action: 'unpin', tool_call_id: 'nonexistent' });

    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.content).toContain('no tool message found');
  });

  it('returns error when tool_call_id is not found (pin action)', async () => {
    const tool = createManageContextTool(cm);
    const result = await tool.handler({ action: 'pin', tool_call_id: 'nonexistent' });

    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.content).toContain('no tool message found');
  });

  it('returns error for invalid action', async () => {
    cm.append(toolMsg('call_1'));
    const tool = createManageContextTool(cm);
    const result = await tool.handler({ action: 'delete', tool_call_id: 'call_1' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unknown action');
  });
});
