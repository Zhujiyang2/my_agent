# 上下文管理设计

## 一句话

上下文是一条不断变长的聊天记录，系统会自动做"修剪"和"压缩"让大模型能在有限窗口里看到最重要的信息。

## 三句话说清楚

1. **上下文是一条有序的消息流，每条消息有角色（用户/助手/工具）和权重**：所有对话、工具调用和结果都按时间顺序追加，系统提示词固定在最前面，重要的工具错误会被"钉住"防止被误删。
2. **超预算时分两层压缩：规则裁剪 + LLM 摘要**：先按规则删掉最旧的非钉住工具消息（保留助手思考过程）；不够再让大模型自己把历史对话压缩成一段摘要，用摘要替代原文。
3. **记忆系统独立于对话上下文，长短期分开管理**：用户主动记住的事实存入 MemoryStore（长期），工具输出和对话轮次用完即弃（短期），Compiler 在组装提示词时把相关记忆注入到系统提示词区域。

## 消息结构

```
[System Prompt]        ← 固定在最前，不可删除
[Memory Injection]     ← 每次组装时动态注入相关记忆
[User Message 1]
[Assistant + Tool Call 1]
[Tool Result 1]        ← 可能被 compact 删除（如果旧且未钉住）
[Tool Result 2] 🔒     ← 钉住（isError=true），不会被删除
[Assistant Final]
[User Message 2]
...
```

## 压缩策略

| 阶段 | 触发条件 | 方法 |
|------|---------|------|
| Rule Compact | 每轮工具执行后 | 删除最旧的未钉住工具消息，直到回到预算内 |
| LLM Compact | Rule Compact 后仍超预算 | 让大模型把历史压缩成一段摘要，替换原文 |
| Truncate | 异常回滚 | 截断到 snapshot 位置，恢复干净状态 |

## 关键组件

- `src/context/manager.ts` — 消息流的增删改查、compact、llmCompact、pin、truncateTo
- `src/context/assembler.ts` — 将内部消息数组组装成大模型可接受的格式
- `src/context/token-counter.ts` — 估算当前上下文的 token 数
- `src/context/llm-compact.ts` — 调用大模型将历史对话压缩成摘要
- `src/memory/` — 长期记忆系统（存储、召回、驱逐）
