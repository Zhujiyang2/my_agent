# 上下文管理设计

## 一句话

上下文是一个异步消息流——消息可以来自用户输入，也可以来自后台任务完成后的系统注入，通过同一个 `append()` 入口汇入，按同样的规则被压缩和保护。

## 消息流模型

ContextManager 不关心消息从哪里来。用户打字、工具返回、后台任务注入——都是 `append()` 一条消息。每条消息被包装为 FlowEntry：

```typescript
interface FlowEntry {
  message: Message;    // { role, content, tool_call_id?, name?, summary?, exitCode?, keyOutput? }
  round: number;       // role==='user' 时递增（包括异步注入的 user 消息）
  pinned: boolean;     // isError → pin，compact 全部跳过
}
```

**异步注入的消息为什么是 `role: 'user'`？** 因为 `role: 'tool'` 必须有对应的 `tool_call_id`（OpenAI API 硬约束），而异步任务完成时并没有关联的 tool_call。用 `role: 'user'` 天然避开了这个约束，同时也获得了和用户输入同等的上下文保护——compact 不摘要化 user 消息。

**异步注入会触发什么？** `append({ role: 'user', content })` → `currentRound++` → 本轮新消息。大模型在下一次 `chatStream` 调用中自然看到它，就像真的有人发了条消息。

## 四层组装

```
[0] system: config.systemPrompt    ← 系统身份，/clear 不清
[1] system: memory injection       ← MemoryManager.assemble() 实时注入
[2] system: state JSON             ← setState() 设置，非空时出现
[3] user: "真实用户输入"           ← flow 层
[4] assistant: { tool_calls }
[5] tool: { content, summary }
[6] assistant: { tool_calls }
[7] tool: { placeholder: "job-xxx spawned" }
[8] user: "job-xxx finished..."    ← ★ 异步注入，和用户输入同等待遇
```

**价值：**
- 记忆是 system 消息 → 不参与 `tool_call_id` 匹配、不影响 round 计数、compact 不遍历
- `/clear` 清 flow 层但保留系统提示词和记忆
- 异步注入的 user 消息和真实用户输入在 ContextManager 层面完全一致——不摘要、不删除

## 三层 compact

### Phase 1：年龄摘要化

遍历 flow，只处理 `role === 'tool'` 且 `!pinned` 且 `currentRound - round >= recent_rounds` 的消息。原始内容保存到 `_originalContent`，展示内容替换为 `summary`。

### Phase 2：相邻去重

连续两个 tool 消息的 `summary` 相同时，前一条标 `[merged]`。**不删除**——OpenAI API 要求每个 `tool_call_id` 都有对应 tool 消息。

### Phase 3：预算删除

仍超 `max_context_tokens` → 从旧到新删 unpinned tool 消息 → 直到回到预算或抛 BudgetError。

**价值：**
- 只压缩 tool 消息，user 和 assistant 不动——对话核心永远完整
- 异步注入的结果（`role: 'user'`）不被三个阶段中的任何一个触及——和用户输入一样被保护
- 去重不删消息——如果删了，OpenAI API 会因为 `tool_call_id` 悬空直接报错
- Pinned 消息在全部阶段中跳过——错误信息不会因压缩丢失

## LLM 全量压缩

规则压缩后仍超预算时自动触发，或 `/compact` 命令手动触发。把全部对话序列化发给大模型压缩成一段摘要，清空 flow 替换为一条 system 消息。

**价值：** 规则压缩是精确外科手术（不丢重要信息），LLM 压缩是兜底手段（什么都不剩的时候就全压了）。两层互补。

## 记忆系统

### 存储模型

```
.my_agent/memory/
  user/    ← 用户主动记住，有 user_budget 控制注入量，超限跳过但不删文件
  agent/   ← Agent 自动记录，有 agent_budget 控制总量，超限驱逐旧文件
```

每个记忆是一个 Markdown 文件，YAML frontmatter 存元数据（type、accessed_at、compressed），`MEMORY.md` 维护索引。

### 注入机制

每次 `assemble()` → `MemoryManager.assemble()` → 实时读全部记忆文件 → 按 `accessed_at` 排序 → 在 token budget 内从新到旧逐个加入 → 返回一条 system 消息注入上下文第二层。

**价值：**
- User 和 Agent 记忆分开管理：用户记忆由用户主动维护（超限不删），Agent 记忆自动 LRU 驱逐
- `accessed_at` 写入有 60s cooldown：高频对话不会产生大量文件 I/O，LRU 排序精度足够（1 分钟粒度）
- 使用率 ≥ 90% 时 warning 直接发给用户看，而不是发给大模型——用户自己决定要不要清理记忆
- 记忆文件就是 Markdown，用户可以直接编辑 `.my_agent/memory/` 下的文件

## Token 计数

用 `tiktoken` 精确计数。对每个 Message 对象做 `JSON.stringify` 后 `encode`，捕获 role/key/name/tool_call_id 等字段的 framing 开销，不是估算裸文本。

**价值：** compact 的删除/保留决策基于精确 token 数而非估算，不会因为误差导致过早删除或超出 API 限制。

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/context/manager.ts` | FlowEntry[] 全部操作：append/assemble/compact/llmCompact/pin/truncateTo |
| `src/context/assembler.ts` | 纯函数：state + flow → Message[] |
| `src/context/token-counter.ts` | tiktoken 精确计数 |
| `src/context/llm-compact.ts` | LLM 全量压缩 |
| `src/memory/index.ts` | MemoryManager：assemble/remember/forget/list |
| `src/memory/store.ts` | MemoryStore：文件读写 + frontmatter + 索引 |
| `src/memory/assembler.ts` | 记忆排序 + budget 控制 |
| `src/memory/evictor.ts` | Agent 记忆 LRU 驱逐 |
