# Agent Loop 设计

## 核心范式：从同步阻塞到异步注入

**重构前：** 大模型说要跑命令 → `execSync` 阻塞等结果 → 结果写入上下文 → 大模型看结果继续。一条命令跑三天，agent 卡三天。

**重构后：** 大模型说要跑命令 → `spawn` 后台进程，立即返回 task id placeholder → 大模型继续做其他事 → 进程结束后，结果以 `role: 'user'` **异步注入**上下文 → 大模型在后续轮次自然看到结果。

这不是简单的"把同步函数改成异步"——它改变了上下文的时序模型：**上下文不再是严格顺序的工具调用→工具结果配对，而是允许结果在未来的任意时刻出现。**

```
同步模型（旧）：
  user → assistant(tool_calls) → tool(结果) → assistant(tool_calls) → tool(结果) → assistant(回复)

异步模型（新）：
  user → assistant(tool_calls) → tool(placeholder: "job-xxx spawned")
       → assistant(调其他工具) → tool(其他结果)
       → assistant(继续工作)   → tool(更多结果)
       ── 后台任务完成 ──
       → user("job-xxx finished. exit=0. output: ...")  ← 异步注入
       → assistant(看到结果，继续)
```

## 架构：瘦 AgentSession + 命令直通 ContextManager

AgentSession 只暴露 `send()`、`history`、`contextManager`。CLI 命令拿到 `contextManager` 引用后直接操作——AgentSession 不充当中介。

```
bin/my-agent.ts
  │
  ├─ createAgent(config, { onToken, onToolCall })
  │   └─ 返回 { send, history, contextManager }
  │
  ├─ 用户输入 → dispatch()
  │   ├─ /xxx → command.execute(ctx)
  │   │         ctx.contextManager.clear() / llmCompact() / truncateTo()
  │   └─ 普通文本 → agent.send(input, signal)
  │
  └─ 二者操作同一个 ContextManager → 命令修改立刻对 loop 可见
```

## send() 完整流程

```
User Input
  │
  ▼
┌─ send(input, signal?) ──────────────────────────────────────────┐
│                                                                   │
│  snapshotLength = assemble().length   ← 异常回滚用                │
│  append({ role: 'user', content: input })                         │
│                                                                   │
│  for round = 0 … max_loop_rounds:                                │
│                                                                   │
│    ┌─ assemble() → 四层消息数组                                   │
│    │   system prompt → memory → state → flow                     │
│    │                                                              │
│    ├─ chatStream(config, messages, tools, onToken, signal)        │
│    │                                                              │
│    ├─ 无 tool_calls:                                             │
│    │   • content 为空 → retry（DeepSeek 首请求偶发空响应）        │
│    │   • append assistant, return content                        │
│    │                                                              │
│    └─ 有 tool_calls:                                             │
│        │                                                          │
│        for each tool_call:                                        │
│          ├─ tool.handler(args)                                    │
│          ├─ 高危确认 → 拒绝则跳过                                 │
│          ├─ append tool_result（带 summary/exitCode/keyOutput）   │
│          │                                                        │
│          ├─ ★ 异步注入：run_command 返回 task id → 注册回调       │
│          │   进程结束后以 role='user' 注入 stdout/stderr           │
│          │   append 触发 currentRound++ → 作为新轮次处理           │
│          │                                                        │
│          ├─ isError → pin(flowIdx)                                │
│          └─ consecutiveFailures 追踪                              │
│                                                                   │
│        compact()  ← 每轮自动                                      │
│        Phase 1: 旧 tool → summary                                │
│        Phase 2: 相邻相同 summary → [merged]                      │
│        Phase 3: 超预算 → 删最旧 unpinned tool                    │
│                                                                   │
│        仍超预算 → llmCompact() → flow 替换为一条 system 摘要      │
│                                                                   │
│  Error:                                                           │
│    限次/失败 → 透出                                               │
│    其他 → truncateTo(snapshotLength) 回滚 → 抛出                  │
└───────────────────────────────────────────────────────────────────┘
```

## ★ 异步任务注入：改变上下文时序模型

这是本次重构最核心的变化。

### 注入机制

```typescript
// loop.ts — tool 执行后
if (tc.function.name === 'run_command' && !toolResult.isError) {
  const taskId = toolResult.keyOutput?.match(/task (job-\d+-\w+) spawned/)?.[1];
  if (taskId) {
    const cleanup = taskReg.onTaskComplete(async (completed) => {
      if (completed.id !== taskId) return;
      cleanup();

      const [stdout, stderr] = await Promise.all([
        taskReg.readOutput(taskId, 'stdout', 200),
        taskReg.readOutput(taskId, 'stderr', 200),
      ]);

      contextManager.append({
        role: 'user',   // ★ 以 user 角色注入
        content: [
          `Background task ${taskId} finished.`,
          `status: ${completed.status}`,
          `exit code: ${completed.exitCode}`,
          stdout ? `\n--- stdout ---\n${stdout.slice(-2000)}` : '',
          stderr ? `\n--- stderr ---\n${stderr.slice(-2000)}` : '',
        ].join('\n'),
      });
    });
  }
}
```

### 为什么用 `role: 'user'` 而不是 `role: 'tool'`？

`role: 'tool'` 消息**必须**有对应的 `tool_call_id`——OpenAI API 要求每个 assistant `tool_calls` 的每个 `tool_call_id` 都需要一个匹配的 tool 消息。异步任务完成时没有关联的 tool_call，硬造一个 id 会让 API 报错。

`role: 'user'` 没有这个约束。注入后 `append` 检测到 `role === 'user'` → `currentRound++`，大模型在下一轮当成新用户输入处理——这正是我们想要的：大模型看到"有新信息了"，然后据此继续决策。

### 对 compact 的影响

注入的消息是 `role: 'user'`，compact Phase 1 只处理 `role: 'tool'`——所以注入的任务结果**永远不会被摘要化**，始终保持完整内容。Phase 3 也只删 tool 消息——user 消息不会被删除。这意味着异步注入的结果在上下文中的存活期和用户输入一样长。

## 上下文四层组装

```
[0] system: config.systemPrompt    ← 系统身份，/clear 不清
[1] system: memory injection       ← MemoryManager.assemble() 实时注入
[2] system: state JSON             ← setState() 设置，非空时出现
[3] user: ...                      ← flow 层
[4] assistant: { tool_calls }
[5] tool: { content, summary, ... }
[6] user: "task job-xxx finished"  ← ★ 异步注入的消息也在这里
[7] assistant: "收到，继续..."
```

Flow 层内部每条 entry 带 `round` 和 `pinned` 标记，用于 compact 决策。

## 两层压缩

| 层级 | 触发 | 做什么 |
|------|------|--------|
| Rule Compact | 每轮自动 | Phase1 旧 tool→summary → Phase2 相邻去重 → Phase3 删最旧 unpinned |
| LLM Compact | 规则压缩后仍超预算，或 `/compact` 命令 | 全量对话发给大模型压缩成摘要，替换整个 flow |

## Pin + 异常回滚

- `isError` 的 tool 结果自动 pin → compact 全部跳过
- `send()` 开始时记 snapshot，非限次异常时 `truncateTo(snapshotLength)` 回滚

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/agent/loop.ts` | createAgent → send() 主循环，含异步注入逻辑 |
| `src/context/manager.ts` | FlowEntry[] 全部操作 |
| `src/context/assembler.ts` | 纯函数：state + flow → Message[] |
| `src/context/llm-compact.ts` | LLM 全量压缩 |
| `src/tasks/registry.ts` | 后台任务生命周期 + onTaskComplete 回调 |
| `src/cli/commands/dispatcher.ts` | `/xxx` → command，其余 → agent.send() |
| `bin/my-agent.ts` | 入口 |
