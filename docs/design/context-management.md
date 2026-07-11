# 上下文管理设计

## 核心理念

所有消息——用户输入、工具结果、后台异步任务——统一通过 `append()` 汇入同一个消息流，按相同规则被压缩和保护。ContextManager 不关心消息来源。

## 消息模型

每条消息有三个元属性：

- **round** —— 消息所在的对话轮次。`role: 'user'` 的消息进来时 +1（包括异步注入）。
- **pinned** —— Agent Loop 在收到 `isError: true` 的工具结果后自动调用 `pin()` 置为 true，compact 全过程跳过，不会被压缩或删除。
- **summary** —— compact 后存放的摘要文本，替代原始内容展示给模型。

异步任务完成后的注入消息使用 `role: 'user'` 而非 `role: 'tool'`，因为 OpenAI API 要求每条 tool 消息必须有对应的 `tool_call_id`，而异步任务没有关联的 tool call。用 user 角色天然绕开了这个约束，同时也享受和用户输入同等的保护——compact 不会摘要化 user 消息。

## 组装结构

每次请求时，上下文从四个来源分层组装：

```
[system]  系统提示词        —— /clear 不清空
[system]  记忆注入          —— MemoryManager 实时组装
[system]  状态 JSON         —— 有状态时出现，无状态时不存在
[user]    用户/异步消息     —— flow 层正文
[assistant]  模型回复
[tool]      工具结果
[assistant]  模型回复
[tool]      工具结果（占位）
[user]    异步完成通知      —— 和普通用户消息同等待遇
```

四层分离的价值：
- 记忆是 system 消息，不参与 tool_call_id 匹配，不影响 round 计数，compact 不遍历
- `/clear` 只清 flow 层，系统提示词和记忆不受影响
- 异步注入的 user 消息在 compact 层面与真实用户输入完全一致

## Compact 三步压缩

当上下文逼近 token 上限时，分三步压缩。三步都只处理 `role: 'tool'` 且 `!pinned` 的消息。

**第一步：年龄摘要化。** 超过 `recent_rounds` 的 tool 消息，原始内容存到 `_originalContent`，展示内容替换为 `summary`。新对话轮次看到的是摘要，不是原始数据。

**第二步：相邻去重。** 连续两条 tool 消息摘要相同时，前一条标 `[merged]`。只标记不删除——OpenAI API 要求每条 tool 消息对应一个 tool_call_id，删除会导致调用链断裂。

**第三步：预算删除。** 仍超预算时，从旧到新逐条删除 unpinned tool 消息，直到回到预算内或抛出 BudgetError。

关键保证：
- user 和 assistant 消息贯穿全程不动——对话核心永远完整
- pinned 消息三步全部跳过——错误信息不会因压缩丢失
- 异步注入的 user 消息三步都不触及——和用户输入一样被保护

## LLM 全量压缩

三步压缩后仍超预算时自动触发（或 `/compact` 手动触发）。将全部对话序列化发给大模型，压缩成一段摘要，清空 flow 替换为一条 system 消息。

规则压缩是精确手术，LLM 压缩是兜底手段——两者互补。

## 记忆系统

### 存储

记忆以 Markdown 文件存在 `.my_agent/memory/` 下，分两个目录：

- `user/` —— 用户主动创建的记忆，数量受 `user_budget` 控制，超限时跳过注入但不删文件
- `agent/` —— Agent 自动记录，受 `agent_budget` 控制总量，超限时按 LRU 驱逐旧文件

每个文件用 YAML frontmatter 存元数据（type、accessed_at、compressed），`MEMORY.md` 维护索引。

### 注入

每次请求时，`MemoryManager.assemble()` 读全部记忆文件，按 `accessed_at` 排序，在 token budget 内从新到旧逐个注入，返回一条 system 消息挂到上下文的记忆层。

细节：
- `accessed_at` 写入有 60 秒冷却期，避免高频对话产生大量 I/O
- 使用率 ≥ 90% 时直接向用户发警告，不发给模型——用户自己决定是否清理
- 记忆文件就是 Markdown，用户可用编辑器直接修改

## Token 计数

用 `tiktoken` 精确计数。对完整 Message JSON 编码，覆盖 role、key、name、tool_call_id 等 framing 字段的开销，而非仅估算裸文本。compact 的删除/保留决策基于精确数字，避免过早删除或超出 API 限制。

## 核心文件

| 文件 | 职责 |
|------|------|
| `src/context/manager.ts` | FlowEntry 全部操作：append / assemble / compact / llmCompact / pin / truncateTo |
| `src/context/assembler.ts` | 纯函数：state + flow → Message[] |
| `src/context/token-counter.ts` | tiktoken 精确计数 |
| `src/context/llm-compact.ts` | LLM 全量压缩 |
| `src/memory/index.ts` | MemoryManager：assemble / remember / forget / list |
| `src/memory/store.ts` | 文件读写 + frontmatter + 索引维护 |
| `src/memory/assembler.ts` | 记忆排序 + budget 控制 |
| `src/memory/evictor.ts` | Agent 记忆 LRU 驱逐 |
