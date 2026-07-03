// src/context/__tests__/multi-round-scenarios.test.ts
// Comprehensive multi-round tool-call scenario tests for Context Management V2
import { describe, it, expect } from 'vitest';
import { createContextManager } from '../manager';
import type { ContextConfig } from '../types';
import type { Message } from '../../llm/types';

const DEFAULT_CONFIG: ContextConfig = {
    max_context_tokens: 100000,
    recent_rounds: 3,
};

function user(content: string): Message {
    return { role: 'user', content };
}

function assistant(content: string): Message {
    return { role: 'assistant', content };
}

function toolMsg(
    content: string,
    callId: string,
    name: string,
    summary: string,
    exitCode = 0,
    keyOutput?: string,
): Message {
    return {
        role: 'tool',
        content,
        tool_call_id: callId,
        name,
        summary,
        exitCode,
        keyOutput,
    } as Message & { summary?: string; exitCode?: number; keyOutput?: string };
}

function errorTool(
    content: string,
    callId: string,
    name: string,
    summary: string,
): Message {
    return toolMsg(content, callId, name, summary, 1, content.slice(0, 300));
}

// ============================================================
// Scenario 1: 单轮对话无压缩 — 所有消息完整保留
// ============================================================
describe('Scenario 1: Single round — no compaction needed', () => {
    it('all messages from a single round are preserved intact', () => {
        const cm = createContextManager(DEFAULT_CONFIG);

        cm.append(user('check GPU status'));
        cm.append(assistant('Let me check that for you'));
        cm.append(toolMsg('GPU 0: 78% utilized, temp 65C', 'call_1', 'run_command', 'exit=0 | GPU 78%', 0));

        const result = cm.assemble();
        expect(result).toHaveLength(3);
        expect(result[0].role).toBe('user');
        expect(result[2].role).toBe('tool');
        expect(result[2].content).toBe('GPU 0: 78% utilized, temp 65C');
    });
});

// ============================================================
// Scenario 2: 多轮老化 — 旧轮次工具输出被摘要替换
// ============================================================
describe('Scenario 2: Multi-round aging — old tool outputs replaced by summaries', () => {
    it('tool messages beyond recent_rounds are compacted to summary only (no keyOutput)', () => {
        const cm = createContextManager({ max_context_tokens: 100000, recent_rounds: 3 });

        // Simulate 5 rounds of GPU monitoring — NO keyOutput, so compacted = pure summary
        for (let r = 0; r < 5; r++) {
            cm.append(user(`user query R${r}`));
            cm.append(assistant(`assistant response R${r}`));
            cm.append(toolMsg(
                `[R${r}] GPU detailed output: ${'X'.repeat(500)}`,
                `call_${r}`,
                'run_command',
                `exit=0 | GPU check R${r}: 78% used`,
                0,
                undefined, // no keyOutput
            ));
        }

        cm.compact();

        const result = cm.assemble();
        const toolMsgs = result.filter(m => m.role === 'tool');

        // R0, R1 beyond recent_rounds=3 → compacted to pure summary
        // (currentRound=5, so 5-1=4≥3 and 5-2=3≥3 → aged)
        expect(toolMsgs[0].content).toBe('exit=0 | GPU check R0: 78% used');
        expect(toolMsgs[0].content).not.toContain('XXXX');
        expect(toolMsgs[1].content).toBe('exit=0 | GPU check R1: 78% used');
        expect(toolMsgs[1].content).not.toContain('XXXX');

        // R2, R3, R4 within recent_rounds=3 → full raw content preserved
        // (5-3=2<3, 5-4=1<3, 5-5=0<3)
        expect(toolMsgs[2].content).toBe(`[R2] GPU detailed output: ${'X'.repeat(500)}`);
        expect(toolMsgs[3].content).toBe(`[R3] GPU detailed output: ${'X'.repeat(500)}`);
        expect(toolMsgs[4].content).toBe(`[R4] GPU detailed output: ${'X'.repeat(500)}`);
    });

    it('tool messages with keyOutput: compacted = summary | keyOutput_slice', () => {
        const cm = createContextManager({ max_context_tokens: 100000, recent_rounds: 0 });

        cm.append(user('query'));
        cm.append(assistant('answer'));
        cm.append(toolMsg(
            'VERY_LONG_OUTPUT_THAT_SHOULD_BE_COMPACTED_' + 'Z'.repeat(400),
            'call_1',
            'run_command',
            'exit=0 | short summary',
            0,
            'KEY: this is the important extracted output',
        ));

        cm.compact();

        const result = cm.assemble();
        const tool = result.find(m => m.role === 'tool')!;
        // Content = summary | keyOutput (200-char slice)
        expect(tool.content).toContain('exit=0 | short summary');
        expect(tool.content).toContain('KEY: this is the important');
        // Full raw content is gone
        expect(tool.content).not.toContain('VERY_LONG_OUTPUT_THAT_SHOULD_BE_COMPACTED');
    });

    it('recent_rounds=3 preserves last 3 rounds of tool output', () => {
        const cm = createContextManager({ max_context_tokens: 100000, recent_rounds: 3 });

        for (let r = 0; r < 6; r++) {
            cm.append(user(`q${r}`));
            cm.append(assistant(`a${r}`));
            cm.append(toolMsg(
                `[R${r}] LONG_OUTPUT_${'Y'.repeat(300)}`,
                `call_${r}`,
                'run_command',
                `exit=0 | R${r} summary`,
                0,
                undefined,
            ));
        }

        cm.compact();
        const toolMsgs = cm.assemble().filter(m => m.role === 'tool');

        // R0, R1, R2 (old) → summarized
        expect(toolMsgs[0].content).toContain('R0 summary');
        expect(toolMsgs[1].content).toContain('R1 summary');
        expect(toolMsgs[2].content).toContain('R2 summary');

        // R3, R4, R5 (recent) → full content
        expect(toolMsgs[3].content).toContain('LONG_OUTPUT');
        expect(toolMsgs[4].content).toContain('LONG_OUTPUT');
        expect(toolMsgs[5].content).toContain('LONG_OUTPUT');
    });
});

// ============================================================
// Scenario 3: Pin 保护 — 错误信息不被压缩
// ============================================================
describe('Scenario 3: Pin protection — error messages survive compaction', () => {
    it('pinned error tool result retains full content across many rounds', () => {
        const cm = createContextManager({ max_context_tokens: 100000, recent_rounds: 1 });

        // Round 0: error occurs
        cm.append(user('start training'));
        cm.append(assistant('Starting training job...'));
        cm.append(errorTool(
            'CRITICAL: CUDA OOM at layer 12, allocated 38.5GB / 40GB\nTraceback: [...]',
            'call_err',
            'run_command',
            'exit=1 | CUDA OOM at layer 12',
        ));

        // Pin the error (index 2 = the tool message)
        cm.pin(2);

        // Rounds 1-5: normal monitoring
        for (let r = 1; r <= 5; r++) {
            cm.append(user(`monitor R${r}`));
            cm.append(assistant(`monitor status R${r}`));
            cm.append(toolMsg(
                `[R${r}] NPU status: 45% used, temp ok. ${'Z'.repeat(400)}`,
                `call_${r}`,
                'npu-smi',
                `exit=0 | NPU normal R${r}`,
                0,
                undefined, // no keyOutput
            ));
        }

        cm.compact();

        const result = cm.assemble();
        const toolMsgs = result.filter(m => m.role === 'tool');

        // Pinned error message (first tool) — preserved in full
        expect(toolMsgs[0].content).toContain('CUDA OOM at layer 12');
        expect(toolMsgs[0].content).toContain('Traceback');

        // Later monitoring messages beyond recent_rounds=1 → summarized to pure summary
        // (R1 monitoring is old, R2-R5 also old since recent_rounds=1 and we're at round 6)
        expect(toolMsgs[1].content).toContain('NPU normal');
        // Full raw content (with ZZZZ) should NOT be in compacted old messages
        expect(toolMsgs[1].content).not.toContain('ZZZZ');
    });

    it('unpin then compact — previously pinned message gets summarized', () => {
        const cm = createContextManager({ max_context_tokens: 100000, recent_rounds: 1 });

        cm.append(user('query'));
        cm.append(assistant('response'));
        cm.append(toolMsg(
            'VERY_IMPORTANT_OUTPUT_AAA',
            'call_1',
            'run_command',
            'exit=0 | important data',
            0,
            undefined,
        ));

        cm.pin(2);  // pin the tool

        // Rounds to push it beyond recent_rounds
        cm.append(user('extra1'));
        cm.append(assistant('extra a1'));
        cm.append(toolMsg('extra output 1', 'call_x1', 'echo', 'exit=0 | extra 1', 0, undefined));

        cm.append(user('extra2'));
        cm.append(assistant('extra a2'));
        cm.append(toolMsg('extra output 2', 'call_x2', 'echo', 'exit=0 | extra 2', 0, undefined));

        cm.compact();
        let toolMsgs = cm.assemble().filter(m => m.role === 'tool');
        // Still pinned → full content
        expect(toolMsgs[0].content).toBe('VERY_IMPORTANT_OUTPUT_AAA');

        // Now unpin and compact again
        cm.unpin(2);
        cm.compact();
        toolMsgs = cm.assemble().filter(m => m.role === 'tool');
        // Now summarized
        expect(toolMsgs[0].content).toContain('exit=0 | important data');
        expect(toolMsgs[0].content).not.toContain('VERY_IMPORTANT_OUTPUT');
    });
});

// ============================================================
// Scenario 4: Dedup — 相邻相同结果合并
// ============================================================
describe('Scenario 4: Dedup — adjacent identical summaries merged', () => {
    it('4 consecutive identical monitoring results → merged to 1', () => {
        const cm = createContextManager(DEFAULT_CONFIG);

        cm.append(user('monitor GPU every 10s for a minute'));
        cm.append(assistant('Checking...'));

        const summary = 'exit=0 | GPU 78%, temp 65C';
        for (let i = 0; i < 4; i++) {
            cm.append(assistant(`check #${i} looks same`));
            cm.append(toolMsg(
                `[check ${i}] GPU detailed: util=78%, temp=65C, memory=12GB/16GB, power=250W`,
                `call_${i}`,
                'run_command',
                summary,
            ));
        }
        cm.append(assistant('All checks complete — GPU stable'));

        cm.compact();

        const result = cm.assemble();
        const toolMsgs = result.filter(m => m.role === 'tool');

        // 4 → should be reduced
        expect(toolMsgs.length).toBeLessThan(4);
        // Merge notes present
        const mergeNotes = result.filter(m =>
            m.role === 'system' && (m.content?.includes('merged') || m.content?.includes('identical')),
        );
        expect(mergeNotes.length).toBeGreaterThanOrEqual(1);
    });

    it('different summaries are not deduplicated', () => {
        const cm = createContextManager(DEFAULT_CONFIG);

        cm.append(user('monitor GPU'));
        cm.append(assistant('Checking...'));
        cm.append(toolMsg('GPU normal', 'call_1', 'run_command', 'exit=0 | GPU 78%'));
        cm.append(assistant('Still monitoring...'));
        cm.append(toolMsg('GPU spiking', 'call_2', 'run_command', 'exit=0 | GPU 95%'));
        cm.append(assistant('Critical!'));
        cm.append(toolMsg('GPU OOM', 'call_3', 'run_command', 'exit=1 | CUDA OOM'));

        cm.compact();

        const toolMsgs = cm.assemble().filter(m => m.role === 'tool');
        // All 3 summaries are different → all preserved
        expect(toolMsgs).toHaveLength(3);
    });
});

// ============================================================
// Scenario 5: Budget — 超预算时逐出最旧的 tool 消息
// ============================================================
describe('Scenario 5: Budget enforcement — oldest tool messages evicted', () => {
    it('evicts oldest tools when over budget, keeps recent ones', () => {
        const cm = createContextManager({ max_context_tokens: 500, recent_rounds: 10 });

        // Append 8 tool messages with moderate content
        for (let i = 0; i < 8; i++) {
            cm.append(toolMsg(
                `tool output ${i}: ${'D'.repeat(80)}`,
                `call_${i}`,
                'run_command',
                `summary-${i}`,
            ));
        }

        cm.compact();

        const result = cm.assemble();
        const toolMsgs = result.filter(m => m.role === 'tool');

        // Some tools were evicted
        expect(toolMsgs.length).toBeLessThan(8);
        // At least 1 survives
        expect(toolMsgs.length).toBeGreaterThan(0);
    });

    it('user/assistant messages survive budget enforcement', () => {
        const cm = createContextManager({ max_context_tokens: 200, recent_rounds: 3 });

        cm.append(user('critical question'));
        cm.append(assistant('important answer'));
        cm.append(toolMsg(
            'big output ' + 'X'.repeat(500),
            'call_1',
            'run_command',
            'summary-1',
        ));
        cm.append(toolMsg(
            'big output ' + 'Y'.repeat(500),
            'call_2',
            'run_command',
            'summary-2',
        ));

        cm.compact();

        const result = cm.assemble();
        const roles = result.map(m => m.role);
        // user and assistant always survive
        expect(roles).toContain('user');
        expect(roles).toContain('assistant');
    });
});

// ============================================================
// Scenario 6: BudgetError — 无可移除的 tool 消息时抛出
// ============================================================
describe('Scenario 6: BudgetError when no removable messages', () => {
    it('throws BudgetError with only user+assistant and tight budget', () => {
        const cm = createContextManager({ max_context_tokens: 1, recent_rounds: 3 });

        cm.append(user('what is the meaning of life?'));
        cm.append(assistant('42'));

        expect(() => cm.compact()).toThrow(/BudgetError/);
    });
});

// ============================================================
// Scenario 7: 三阶段综合 — 老化 + 去重 + 预算同时生效
// ============================================================
describe('Scenario 7: All 3 phases — age + dedup + budget combined', () => {
    it('all three compaction phases work together correctly', () => {
        const cm = createContextManager({ max_context_tokens: 1000, recent_rounds: 2 });

        // Round 0 (old): monitoring run — will be aged
        cm.append(user('start monitoring'));
        cm.append(assistant('Starting monitor'));
        cm.append(toolMsg(
            `GPU monitor: ${'X'.repeat(200)}`,
            'call_gpu_0',
            'run_command',
            'exit=0 | GPU 78%, temp 65C',
        ));

        // Round 1 (old): same result — will be aged AND dedup with R2
        cm.append(user('check again'));
        cm.append(assistant('Same result'));
        cm.append(toolMsg(
            `GPU check: ${'X'.repeat(200)}`,
            'call_gpu_1',
            'run_command',
            'exit=0 | GPU 78%, temp 65C',
        ));

        // Round 2 (old): same result again
        cm.append(user('check once more'));
        cm.append(assistant('Still the same'));
        cm.append(toolMsg(
            `GPU recheck: ${'X'.repeat(200)}`,
            'call_gpu_2',
            'run_command',
            'exit=0 | GPU 78%, temp 65C',
        ));

        // Round 3 (recent): different result
        cm.append(user('what about now?'));
        cm.append(assistant('Different'));
        cm.append(toolMsg(
            `GPU now: ${'X'.repeat(200)}`,
            'call_gpu_3',
            'run_command',
            'exit=0 | GPU 99%, temp 85C — WARNING',
        ));

        cm.compact();

        const result = cm.assemble();
        const toolMsgs = result.filter(m => m.role === 'tool');

        // R0-R2 are old (beyond recent_rounds=2), same summary → deduped
        // R3 is recent → preserved
        expect(toolMsgs.length).toBeLessThanOrEqual(3);

        // User/assistant messages always survive
        const userMsgs = result.filter(m => m.role === 'user');
        expect(userMsgs.length).toBe(4);
    });
});

// ============================================================
// Scenario 8: State 层 — setState 贯穿多轮保留
// ============================================================
describe('Scenario 8: State layer survives compaction across rounds', () => {
    it('state layer is always present in assemble regardless of compact', () => {
        const cm = createContextManager(DEFAULT_CONFIG);

        cm.setState('task', 'debug CUDA OOM on node3');
        cm.setState('context', 'training job #4582');

        // Add many rounds
        for (let r = 0; r < 10; r++) {
            cm.append(user(`q${r}`));
            cm.append(assistant(`a${r}`));
            cm.append(toolMsg(
                `[R${r}] NPU status: normal, ${'D'.repeat(200)}`,
                `call_${r}`,
                'npu-smi',
                `exit=0 | NPU normal R${r}`,
            ));
        }

        cm.compact();

        const result = cm.assemble();
        const stateMsg = result.find(m => m.role === 'system' && m.content?.includes('CUDA OOM'));
        expect(stateMsg).toBeDefined();
        expect(stateMsg!.content).toContain('node3');
        expect(stateMsg!.content).toContain('#4582');
    });

    it('getState returns shallow copy, immune to mutation', () => {
        const cm = createContextManager(DEFAULT_CONFIG);
        cm.setState('key', 'original');

        const copy = cm.getState();
        copy.key = 'mutated';

        expect(cm.getState().key).toBe('original');
    });
});

// ============================================================
// Scenario 9: 错误恢复 — truncateTo 回滚
// ============================================================
describe('Scenario 9: Error rollback via truncateTo', () => {
    it('rolls back partial round on unexpected error', () => {
        const cm = createContextManager(DEFAULT_CONFIG);

        // Successful round
        cm.append(user('q1'));
        cm.append(assistant('a1'));
        cm.append(toolMsg('output1', 'call_1', 'echo', 'exit=0 | ok'));

        // Snapshot before second round
        const snapshot = cm.assemble().length; // 3

        // Start second round — partial before error
        cm.append(user('q2'));
        cm.append(assistant('a2'));

        // Error! Rollback to snapshot
        cm.truncateTo(snapshot);

        const result = cm.assemble();
        expect(result).toHaveLength(3);
        expect(result[0].content).toBe('q1');
        expect(result[2].content).toBe('output1');
    });
});

// ============================================================
// Scenario 10: 真实调试场景模拟 — 混合成功/失败/重复监控
// ============================================================
describe('Scenario 10: Realistic debug session simulation', () => {
    it('simulates a complete debug session: check → fail → diagnose → fix → verify', () => {
        const cm = createContextManager({ max_context_tokens: 100000, recent_rounds: 3 });

        // === Round 0: Initial check — error found ===
        cm.append(user('why did training job #4582 fail?'));
        cm.append(assistant('Let me check the logs.'));
        cm.append(errorTool(
            'Job #4582: FAILED at step 12500\nError: CUDA out of memory at layer 12\nGPU: 38.5GB allocated / 40GB total',
            'call_0',
            'run_command',
            'exit=1 | Job #4582 FAILED — CUDA OOM at layer 12',
        ));
        cm.pin(2); // Pin this key diagnostic

        cm.append(assistant('The job failed due to CUDA OOM at layer 12. Let me check GPU memory.'));

        // === Round 1: Diagnose GPU state ===
        cm.append(user('check GPU memory across all nodes'));
        cm.append(assistant('Checking...'));
        cm.append(toolMsg(
            'GPU 0: 38.5/40GB, GPU 1: 39.2/40GB, GPU 2: 39.8/40GB, GPU 3: 12.1/40GB',
            'call_1a',
            'run_command',
            'exit=0 | GPU memory: 3/4 nearly full, GPU3 has room',
            0,
            'GPU 0: 38.5/40GB, GPU 1: 39.2/40GB, GPU 2: 39.8/40GB, GPU 3: 12.1/40GB',
        ));
        cm.append(assistant('GPUs 0-2 are nearly full. Let me check what processes are using them.'));

        // === Round 2: Check processes ===
        cm.append(user('list GPU processes'));
        cm.append(assistant('Listing...'));
        cm.append(toolMsg(
            'GPU 0: pid=12345 (training #4581) 20GB, pid=12346 (inference) 18GB\nGPU 1: pid=12347 (training #4582) 25GB, pid=12348 (eval) 14GB',
            'call_2a',
            'run_command',
            'exit=0 | Found: training #4581 on GPU0 (20GB), #4582 on GPU1 (25GB)',
            0,
            'GPU 0: pid=12345 (training #4581) 20GB',
        ));
        cm.append(assistant('Job #4582 is on GPU1 with 25GB. Let me try reducing batch size and re-running.'));

        // === Round 3: Fix attempt ===
        cm.append(user('reduce batch_size from 32 to 16 and restart on GPU3'));
        cm.append(assistant('Applying fix...'));
        cm.append(toolMsg(
            'Updated config: batch_size=16, device=cuda:3\nJob #4582 restarted as pid=12350',
            'call_3a',
            'write_file',
            'exit=0 | wrote 3 lines to config.yaml',
            0,
            'Updated config: batch_size=16, device=cuda:3',
        ));

        // === Round 4-7: Monitor (same check 4 times — should dedup) ===
        cm.append(user('monitor job status every 5s'));
        for (let r = 4; r <= 7; r++) {
            cm.append(assistant(`Monitoring check ${r - 3}...`));
            cm.append(toolMsg(
                `Job #4582: RUNNING, step ${12500 + (r - 4) * 100}/20000, loss=0.${42 - (r - 4) * 3}`,
                `call_${r}a`,
                'run_command',
                'exit=0 | Job #4582 RUNNING, loss decreasing',
                0,
                `Step ${12500 + (r - 4) * 100}: loss=0.${42 - (r - 4) * 3}`,
            ));
        }

        // === Round 5: Verify fix ===
        cm.append(user('did the fix work?'));
        cm.append(assistant('Let me check final status.'));
        cm.append(toolMsg(
            'Job #4582: COMPLETED, steps=20000, final_loss=0.15, accuracy=0.94',
            'call_8a',
            'run_command',
            'exit=0 | Job #4582 COMPLETED — accuracy 94%',
            0,
            'Job #4582: COMPLETED, final_loss=0.15, accuracy=0.94',
        ));

        cm.compact();

        const result = cm.assemble();
        const toolMsgs = result.filter(m => m.role === 'tool');
        const systemMsgs = result.filter(m => m.role === 'system');
        const userMsgs = result.filter(m => m.role === 'user');

        // === Assertions ===

        // 1. Pinned error message (R0) still has full content
        const errorMsg = toolMsgs.find(m =>
            (m as Message & { summary?: string }).summary?.includes('CUDA OOM'),
        );
        expect(errorMsg).toBeDefined();
        expect(errorMsg!.content).toContain('38.5GB allocated');

        // 2. All user messages preserved (6 queries: R0-R5)
        expect(userMsgs.length).toBe(6);

        // 3. Dedup merged monitoring messages (R4-R7 identical summaries)
        const monitoringTools = toolMsgs.filter(m =>
            (m as Message & { summary?: string }).summary?.includes('loss decreasing'),
        );
        // 4 identical → should be reduced
        expect(monitoringTools.length).toBeLessThan(4);

        // 4. Merge notes generated for dedup
        const mergeNote = systemMsgs.find(m => m.content?.includes('merged'));
        expect(mergeNote).toBeDefined();

        // 5. assemble() is deterministic — second call returns same result
        const r2 = cm.assemble();
        expect(r2).toEqual(result);
    });
});

// ============================================================
// Scenario 11: keyOutput 保留 — 关键输出片段不丢失
// ============================================================
describe('Scenario 11: keyOutput preserved in compacted content', () => {
    it('after age summarization with keyOutput, summary + keyOutput appended', () => {
        const cm = createContextManager({ max_context_tokens: 100000, recent_rounds: 0 });

        cm.append(user('check training status'));
        cm.append(assistant('Checking...'));
        cm.append(toolMsg(
            `Training log: ${'LOG'.repeat(500)}`,
            'call_1',
            'run_command',
            'exit=0 | Training started',
            0,
            'Epoch 1/10: loss=0.42 — Epoch 5/10: loss=0.15',
        ));

        cm.compact();

        const result = cm.assemble();
        const toolMsgResult = result.find(m => m.role === 'tool')!;
        // Summary is first
        expect(toolMsgResult.content).toContain('exit=0 | Training started');
        // Key output snippet is appended (200-char slice)
        expect(toolMsgResult.content).toContain('Epoch 1/10: loss=0.42');
        // Full raw logs are gone
        expect(toolMsgResult.content).not.toContain('LOGLOGLOG');
    });

    it('tool without keyOutput works fine (appends nothing extra)', () => {
        const cm = createContextManager({ max_context_tokens: 100000, recent_rounds: 0 });

        cm.append(user('query'));
        cm.append(assistant('answer'));
        cm.append(toolMsg(
            'OUTPUT_NO_KEY',
            'call_1',
            'echo',
            'exit=0 | echo done',
            0,
            undefined,
        ));

        cm.compact();

        const result = cm.assemble();
        const toolMsgResult = result.find(m => m.role === 'tool')!;
        // Summary without keyOutput — clean, no pipe separator
        expect(toolMsgResult.content).toBe('exit=0 | echo done');
    });
});
