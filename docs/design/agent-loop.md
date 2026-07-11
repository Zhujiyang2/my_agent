# Agent Loop 设计

## 一句话

Agent 把耗时命令丢到后台不等待，继续做其他事；等命令跑完了，结果自动注入对话历史，大模型在后续轮次自然看到。

## 完整流程

```
User Input
  │
  ▼
┌─ send(input, signal?) ──────────────────────────────────────────┐
│                                                                   │
│  snapshotLength = assemble().length   ← 记快照，异常时回滚        │
│  append({ role: 'user', content: input })                         │
│                                                                   │
│  for round = 0 … max_loop_rounds:                                │
│                                                                   │
│    assemble() → chatStream(config, messages, tools)               │
│                                                                   │
│    无 tool_calls → append assistant → return content              │
│    （content 为空时 retry，DeepSeek 偶发首请求空白）               │
│                                                                   │
│    有 tool_calls:                                                 │
│      for each tool:                                               │
│        ├─ tool.handler(args)                                      │
│        ├─ 高危命令 → 用户确认弹窗                                  │
│        ├─ append tool_result（带 summary/exitCode/keyOutput）     │
│        │                                                          │
│        ├─ run_command → spawn 后台进程 → 返回 task id placeholder │
│        │   注册 onTaskComplete 回调                                │
│        │   进程结束后以 role='user' 注入结果 → currentRound++     │
│        │                                                          │
│        ├─ isError → pin（compact 不碰）                           │
│        └─ 追踪 consecutiveFailures                                │
│                                                                   │
│      compact()  ← 每轮自动                                        │
│      Phase 1: 旧 tool → summary 替代                              │
│      Phase 2: 相邻相同 summary → 合并为 [merged]                  │
│      Phase 3: 仍超预算 → 删最旧 unpinned tool                     │
│                                                                   │
│      仍超 max_context_tokens → llmCompact() → flow 替换为摘要     │
│                                                                   │
│  Error:                                                           │
│    限次/连续失败 → 透出（合法终止）                               │
│    其他异常 → truncateTo(snapshotLength) → 抛出                   │
└───────────────────────────────────────────────────────────────────┘
```

## 核心设计决策

### 1. 命令异步执行 + 结果注入

`run_command` 不走同步阻塞——spawn 后台进程后立即返回 placeholder，agent 继续工作。进程结束后回调以 `role: 'user'` 把 stdout/stderr 注入上下文。

**价值：**
- Agent 不会被几小时甚至几天的长任务卡住，可以同时管理多个后台任务
- 用户不用等——agent 一边跑训练一边继续和你对话
- 结果注入用 `role: 'user'` 而不是 `role: 'tool'`，因为异步结果没有对应的 `tool_call_id`（OpenAI API 硬约束），用 user 角色不存在 API 兼容问题
- `role: 'user'` 自然触发 `currentRound++`，compact 不会摘要化它（只摘要 tool 消息），结果在上下文中和用户输入同等优先级

### 2. 瘦 AgentSession + ContextManager 直接暴露

AgentSession 只暴露 `send()`、`history`、`contextManager`。`/clear`、`/compact`、`/rewind` 等命令通过 `CommandContext` 拿到 `contextManager` 引用直接操作。

**价值：**
- AgentSession 接口极简，不需要为每个新命令开洞
- 命令可以自由组合上下文操作，灵活性不受 AgentSession 接口限制
- 命令和 loop 共享同一个 ContextManager 实例，命令的修改对 loop 立即可见，反之亦然

### 3. 上下文四层组装

```
system: 系统提示词          ← /clear 不清
system: 记忆注入            ← MemoryManager.assemble() 实时读取
system: state JSON          ← 非空时出现，setState() 控制
user/assistant/tool         ← flow 层，/clear 清空
```

**价值：**
- 记忆作为 system 消息不参与 `tool_call_id` 匹配、不影响 round 计数、compact 不遍历 system 层——比拼到 user 消息前面更干净
- 四层分离使得 `/clear` 可以只清 flow 层而保留系统提示词和记忆
- state 层夹在记忆和 flow 之间：大模型先接收"你是谁 + 你知道什么 + 当前状态"，再看对话历史

### 4. 两层压缩

| 层级 | 触发 | 做什么 |
|------|------|--------|
| Rule Compact | 每轮自动 | Phase1 旧 tool→summary → Phase2 去重 → Phase3 删旧 |
| LLM Compact | 规则压缩后仍超预算，`/compact` 命令也可手动触发 | 全量对话发给大模型压缩成摘要，替换整个 flow |

**价值：**
- Rule compact 只动 tool 消息、不动 user 和 assistant——用户输入和助理思考永远完整
- 去重不删消息（只标 `[merged]`）——否则 OpenAI API 会因为 `tool_call_id` 找不到对应 tool 消息报错
- LLM compact 作为最后手段：把整个历史压成一段摘要，后续对话还能继续

### 5. Pin + 异常回滚

- 工具返回 `isError` → 自动 pin，compact 全部跳过，错误信息始终可见
- `send()` 开始记 snapshot，非限次异常 → `truncateTo(snapshotLength)`，防止半截工具调用污染后续对话

**价值：**
- Pin 保证关键错误不因压缩而丢失，大模型在任何时候都能看到之前出了什么问题
- Snapshot 回滚比简单的 try-catch 更精确：不是清空上下文，而是精确恢复到本轮输入前的干净状态

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/agent/loop.ts` | createAgent → send() 主循环，含异步注入逻辑 |
| `src/context/manager.ts` | FlowEntry[] 全部操作 |
| `src/context/assembler.ts` | 纯函数：state + flow → Message[] |
| `src/context/llm-compact.ts` | LLM 全量压缩 |
| `src/context/token-counter.ts` | tiktoken 精确计数 |
| `src/tasks/registry.ts` | 后台任务生命周期 + onTaskComplete |
| `src/agent/status-line.ts` | 终端状态行 |
| `src/cli/commands/dispatcher.ts` | `/xxx` → command，其余 → agent.send() |
| `bin/my-agent.ts` | 入口 |
