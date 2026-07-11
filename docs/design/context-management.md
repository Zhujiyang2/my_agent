# 上下文管理设计

## 核心范式：上下文是异步消息流，不再是同步调用链

**重构前：** 上下文是严格同步的——大模型调工具 → 阻塞等结果 → 结果写入 → 大模型看结果继续。消息流是线性的、可预测的，tool 调用和 tool 结果一一配对。

**重构后：** 工具调用可能只返回 placeholder（`"job-xxx spawned"`），真正的结果在未来的某个时刻以 `role: 'user'` 的形态注入上下文。上下文不再是同步调用链，而是一个**异步消息流**：消息可以来自用户，也可以来自系统（任务完成回调），两种来源通过同一个 `append()` 入口汇入 flow。

```
同步模型（旧）：                        异步模型（新）：
  user ──┐                                user ──┐
  assistant(tool_call)                     assistant(tool_calls)
  tool(result) ←── 阻塞等待                tool(placeholder) ←── 立即返回
  assistant(tool_call)                     assistant(调其他工具)
  tool(result) ←── 阻塞等待                tool(其他结果)
  assistant(回复)                          user("job-xxx finished") ←── ★ 异步注入
                                           assistant(看到结果)
```

这个范式转变意味着 ContextManager 不再假设消息之间有固定的时序关系——它只负责管理消息流的增删改查和压缩，不关心消息从哪里来。

## FlowEntry 结构

每一条进入上下文的消息被包装为 FlowEntry：

```typescript
interface FlowEntry {
  message: Message;    // { role, content, tool_call_id?, name?, summary?, exitCode?, keyOutput? }
  round: number;       // append 时 role==='user' 就 ++，包括异步注入的 user 消息
  pinned: boolean;     // isError → pin(index)，compact 全部跳过
}
```

- `round` 由 `append()` 自动维护：`role === 'user'` 时 `currentRound++`
- 异步注入的结果也是 `role: 'user'`，所以会自然触发新轮次
- `pinned` 由 agent loop 在工具返回 `isError` 时设置，compact 全部跳过

## 四层组装（assemble）

每次调用 `assemble()` 重新构建完整数组，从四个层级依次拼接：

```
[0] system: config.systemPrompt    ← 系统身份，/clear 不清
[1] system: memory injection       ← MemoryManager.assemble() 实时注入
[2] system: state JSON             ← setState() 设置，非空时出现
[3] user: "真实用户输入"           ← flow 层开始
[4] assistant: { tool_calls }
[5] tool: { content, summary }
[6] assistant: { tool_calls }
[7] tool: { placeholder: "job-xxx spawned" }   ← 后台任务 placeholder
[8] user: "Background task finished..."        ← ★ 异步注入，role='user'
[9] assistant: "收到结果，下一步..."
```

**为什么 memory 是 system 消息而不是拼到 user 前面？** system 消息不参与 `tool_call_id` 匹配（OpenAI API 硬约束）、不影响 `round` 计数、compact 不遍历 system 层。

**异步注入结果为什么被当作普通 user 消息处理？** 对 ContextManager 来说，`append({ role: 'user', content: ... })` 就是一条 user 消息。至于这条消息是用户打字还是系统注入——ContextManager 不需要知道。`currentRound++`、不被 compact 摘要化、不被 Phase 3 删除——这些行为对"用户输入"是正确的，对"任务结果注入"也是正确的。

## 三层 compact

### Phase 1：年龄摘要化

```typescript
for (const entry of flow) {
  if (entry.pinned) continue;
  if (entry.message.role !== 'tool') continue;  // 只处理 tool 消息
  if (currentRound - entry.round < config.recent_rounds) continue;

  // 保存原始内容 → 替换为 summary
  entry.message.content = summary + (keyOutput ? ` | ${keyOutput.slice(0, 200)}` : '');
}
```

**只摘要 tool 消息，不动 user 和 assistant。** 这意味着：
- 用户输入永远完整保留
- 助理思考永远完整保留
- **异步注入的任务结果（role='user'）永远完整保留**
- 只有工具输出（往往很长且信息密度低）会被压缩

### Phase 2：相邻去重

两个相邻 tool 消息的 summary 相同时，前一条的 content 变为 `[merged]` 前缀。**不删除**——OpenAI API 要求每个 `tool_call_id` 都有对应 tool 消息。

### Phase 3：预算删除

```typescript
while (estimateTokens(assemble()) > max_context_tokens) {
  找最旧的 unpinned tool 消息 → 删除
  找不到 → BudgetError
}
```

只删 tool、不删 user 和 assistant。**异步注入的结果不会被删除。**

## LLM 全量压缩（llmCompact）

Phase 1-3 后仍超预算时触发（自动或 `/compact` 命令）：

```
全部对话 → 序列化 → 发给大模型 → 返回摘要
→ contextManager.llmCompact(summary)
  → flow.length = 0
  → flow.push({ role: 'system', content: '[Compressed context]\n\n' + summary })
```

压缩后 flow 只剩一条 system 消息——之前的对话（包括异步注入的任务结果）全部被压缩进摘要。

## 记忆系统

### 两条路径

```
.my_agent/memory/
  user/    ← 用户主动记住（user_budget 控制注入量，超限不删文件）
  agent/   ← Agent 自动记录（agent_budget 控制总量，超限驱逐旧文件）
```

### 文件格式：Markdown + YAML frontmatter

```markdown
---
name: my-stack
description: Project tech stack
metadata:
  type: user
  accessed_at: 2026-07-11T12:00:00.000Z
  compressed: false
---
React + TypeScript + Express
```

每个文件有一条索引记录在 `MEMORY.md` 中。accessed_at 写入有 60s cooldown 以减少 I/O。

### 注入：动态 + 预算控制

每次 `assemble()` 调用 `MemoryManager.assemble()` → 实时读取所有记忆文件 → 按 `accessed_at` 排序 → 在 token budget 内从新到旧逐个加入 → 组装为一条 system 消息注入到上下文第二层。

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/context/manager.ts` | FlowEntry[] 全部操作：append/assemble/compact/llmCompact/pin/truncateTo |
| `src/context/assembler.ts` | 纯函数：state + flow → Message[] |
| `src/context/token-counter.ts` | tiktoken 精确计数（JSON.stringify 后 encode） |
| `src/context/llm-compact.ts` | 调大模型压缩全量对话 |
| `src/memory/index.ts` | MemoryManager：assemble/remember/forget/list |
| `src/memory/store.ts` | MemoryStore：文件读写 + frontmatter + MEMORY.md 索引 |
| `src/memory/assembler.ts` | 记忆排序 + budget 控制 + warning 生成 |
| `src/memory/evictor.ts` | Agent 记忆 LRU 驱逐 |
