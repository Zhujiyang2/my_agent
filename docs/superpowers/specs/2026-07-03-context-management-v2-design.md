# Context Management V2 — 设计文档

> 对 V1 实现的架构审查与重构设计。V1 代码位于 `feature/context-management-system` 分支。

## 1. 问题诊断（来自 V1 Code Review）

V1 实现存在三类问题：

| 类别 | 问题 | 处置 |
|------|------|------|
| **过度设计** | Summarizer 模块（LLM 异步摘要，6 文件）引入复杂度和不确定性 | 删除 |
| **策略不当** | compressed_history 截断 user/assistant 对，丢失因果链 | 删除 |
| **实现粗糙** | 字符÷4 估算 Token，MSG_OVERHEAD=92 虚高 | 换 tiktoken |
| **副作用** | assemble() 内部执行 compact，调用方不可控 | 分离为纯函数 |
| **功能缺失** | 关键诊断信息 3 轮后丢失；监控场景重复输出占预算 | 新增 pin + 去重 |
| **暂缓** | Knowledge 层（后续 RAG） | 移除 setKnowledge |
| **暂缓** | 会话持久化（序列化/恢复） | TODO |

## 2. 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  AgentLoop                                                  │
│                                                             │
│  send(input):                                               │
│    1. cm.append(user_msg)                                   │
│    2. msgs = cm.assemble()             ← 纯读，无副作用     │
│    3. result = await chatStream(msgs)                       │
│    4. if tool_calls: 执行工具 → 生成 summary → cm.append()  │
│    5. goto 2 (循环直到 LLM 返回文本)                        │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────────┐
│  ContextManager                                             │
│                                                             │
│  flowMessages[]  ······ (user / assistant / tool)           │
│  state{}          ······ (键值对, setState/getState)        │
│                                                             │
│  assemble(): Message[]    纯读——拼 state + flow 为一维数组   │
│  compact(): void          显式压缩——年龄+预算+去重          │
│  pin/unpin(i): void       消息锁定                           │
│  truncateTo(n): void      回滚用                            │
└───────────────────────────┬─────────────────────────────────┘
                            │
┌───────────────────────────┴─────────────────────────────────┐
│  Assembler (纯函数)                                         │
│                                                             │
│  assembleLayers({ flow, state }): Message[]                 │
│    Layer 1: state → system message                          │
│    Layer 2: flow → user/assistant/tool messages             │
│  Knowledge 层：搁置，后续 RAG 方案                           │
└─────────────────────────────────────────────────────────────┘
```

## 3. 核心流程详解

### 3.1 ToolResult 结构化

工具返回的每条结果自带确定性摘要，不需要 LLM。

```typescript
interface ToolResult {
  content: string;       // 完整原始输出
  summary: string;       // 结构化摘要（工具自己生成，确定性）
  exitCode?: number;     // 退出码
  keyOutput?: string;    // 关键输出行（头部 ~300 字符）
  isError?: boolean;
}
```

各工具摘要规则（不调 LLM）：

| 工具 | summary 格式 |
|------|-------------|
| run_command | `"exit={code} \| stdout前80字符"` |
| read_file | `"read {N} lines from {path}"` |
| glob | `"matched {N} files: {paths前80字符}"` |
| write_file | `"wrote {N} lines to {path}"` |

### 3.2 compact 策略

**触发时机：** `compact()` 由 loop 层每轮执行完 tool calls 后显式调用。

**执行逻辑：**

```
compact():
  对每条 flow 中的 tool 消息:
    ├─ pinned → 完整保留
    ├─ 距当前轮次 ≤ 3 → 完整保留
    └─ 距当前轮次 > 3 → content 切换为 summary + keyOutput

  去重:
    连续的、summary 完全相同的 tool 消息 → 合并
    保留最新一条 + 插入 system-note: “[R{a}-R{b}: {N}次相同结果已合并]”

  预算检查:
    算 token → 仍超 max_context_tokens → 从最旧的 unpinned tool 开始删
    还超 → 抛出 BudgetError
    user/assistant 消息永不压缩、永不删除
```

**去重效果示例（监控场景）：**

```
压缩前:
  R100 tool: "exit=0 | GPU 78%, latency=12ms"
  R101 tool: "exit=0 | GPU 78%, latency=12ms"
  R102 tool: "exit=0 | GPU 78%, latency=12ms"
  R103 tool: "exit=0 | GPU 78%, latency=12ms"

压缩后:
  system-note: "[R100-R103: 4次相同监控结果已合并]"
  R103 tool: "exit=0 | GPU 78%, latency=12ms"
```

### 3.3 Pin（消息锁定）

**用途：** 标记关键诊断信息，永不压缩。

```typescript
interface ContextManager {
  pin(index: number): void;      // 锁第 N 条 flow 消息
  unpin(index: number): void;    // 解锁
}
```

**触发方式：**

| 方式 | 说明 |
|------|------|
| 自动 | `isError: true` 的 tool 结果自动 pin |
| Agent 主动 | 新增 `pin_message` 工具，agent 调用后锁定指定消息 |
| 用户手动 | 未来可扩展（`/pin` 命令等） |

**效果：** pinned 消息的所有字段（content、summary、exitCode、keyOutput）完整保留，不受 compact 影响。

### 3.4 Token 计数

用 `tiktoken` 替换字符÷4 估算。

```typescript
// token-counter.ts (替代 token-estimator.ts)
import { encoding_for_model } from 'tiktoken';

export function estimateTokens(messages: Message[], model: string): number {
  const enc = encoding_for_model(model);
  // 直接对整个 messages 数组编码，无需手工 overhead
  const tokens = messages.reduce((sum, m) => {
    return sum + enc.encode(JSON.stringify(m)).length;
  }, 0);
  enc.free();
  return tokens;
}
```

**收益：**
- 精确计数，消除 2-3x 误差
- 无需手工 MSG_OVERHEAD（原值 92 虚高，已删除）
- 自动包含 JSON 结构开销

### 3.5 assemble() 纯函数化

**V1 问题：** assemble() 内部调用 applyBudget()，读取操作有副作用。

**V2 设计：** assemble 和 compact 分离。

```
assemble(): Message[]    → 纯读，只拼装，不改内部状态
compact(): void          → 显式压缩，修改 flowMessages 内部
```

Loop 层调用顺序：

```
append() → assemble() → chatStream() → 执行工具 → append()
→ compact() → assemble() → chatStream() → ...
```

## 4. 接口定义

### ContextConfig

```typescript
interface ContextConfig {
  max_context_tokens: number;   // 0 = auto (80% of model window)
  recent_rounds: number;        // 保留原始输出的轮数，默认 3
}
```

### ContextManager

```typescript
interface ContextManager {
  // 消息操作
  append(message: Message): void;
  assemble(): Message[];           // 纯读

  // 压缩
  compact(): void;                 // 显式压缩：年龄 + 去重 + 预算

  // Pin
  pin(index: number): void;
  unpin(index: number): void;

  // 状态层
  setState(key: string, value: unknown): void;
  getState(): Record<string, unknown>;

  // 回滚
  truncateTo(count: number): void;

  // 中断
  cancelAll(): void;
}
```

**删除的接口：**
- `setKnowledge()` — Knowledge 层搁置
- `scheduleSummarize()` — Summarizer 删除
- `flushPendingSummaries()` — 异步摘要删除

## 5. 文件变更清单

### 新增

| 文件 | 说明 |
|------|------|
| `src/context/token-counter.ts` | tiktoken 精确计数 |
| `src/context/__tests__/token-counter.test.ts` | 测试 |

### 修改

| 文件 | 变更 |
|------|------|
| `src/context/types.ts` | 删除 Summarizer/scheduleSummarize/setKnowledge，新增 pin/unpin/compact |
| `src/context/manager.ts` | 重写：compact 逻辑（pin+去重+年龄），assemble 纯函数化 |
| `src/context/assembler.ts` | 简化：只做拼装 |
| `src/context/__tests__/manager.test.ts` | 跟进 API 变更 |
| `src/context/__tests__/assembler.test.ts` | 跟进 API 变更 |
| `src/tools/types.ts` | ToolResult 新增 summary/exitCode/keyOutput |
| `src/tools/shell/run-command.ts` | 实现 summary 生成 |
| `src/tools/files/read-file.ts` | 实现 summary 生成 |
| `src/tools/files/write-file.ts` | 实现 summary 生成 |
| `src/tools/files/glob.ts` | 实现 summary 生成 |
| `src/agent/loop.ts` | 移除 Summarizer 注入，新增 compact 调用, pin auto-pin |
| `src/agent/__tests__/loop.test.ts` | 跟进 API 变更 |
| `src/config/types.ts` | ContextConfig 删除 summarizer_model, flow_rounds，新增 recent_rounds |
| `src/config/loader.ts` | 跟进 config 默认值 |

### 删除

| 文件 | 说明 |
|------|------|
| `src/context/summarizer.ts` | LLM 摘要模块 |
| `src/context/token-estimator.ts` | 字符估算模块 |
| `src/context/__tests__/summarizer.test.ts` | |
| `src/context/__tests__/token-estimator.test.ts` | |

## 6. 边界条件 & 测试覆盖

| 场景 | 预期行为 |
|------|---------|
| 空消息列表 | assemble() 返回 `[]` |
| 近 3 轮内 tool 消息 | 完整保留 content |
| 超 3 轮 tool 消息 | 切换为 summary |
| pinned tool 消息超 3 轮 | 完整保留 |
| isError=true 自动 pin | tool 结果 isError → 自动 pin |
| 连续相同摘要 | 去重合并，插入合并标记 |
| 预算超限 | 从最旧 unpinned tool 开始删 |
| budget 极限（无 tool 可删） | BudgetError |
| user/assistant 消息 | 永不压缩、永不删除 |
| truncateTo 回滚 | 恢复到指定消息数 |
| 空状态 | 不注入 system 消息 |
| compact 无操作 | 不修改任何内容 |

## 7. V1 vs V2 对比

| 维度 | V1 | V2 |
|------|----|----|
| 摘要方式 | LLM 异步，有幻觉风险 | 工具确定性生成 |
| Token 计数 | 字符÷4 + MSG_OVERHEAD=92 | tiktoken 精确 |
| 压缩粒度 | 删 tool + 截断 user/assistant | 只压缩 tool |
| user/assistant | 会被截断到 200 字符 | 永不压缩 |
| 关键信息保护 | 无 | pin + auto-pin(isError) |
| 重复输出 | 无处理 | 相邻相同摘要去重 |
| 并发模型 | FIFO 队列 (上限5) | 无队列（无异步） |
| Knowledge 层 | 静态字符串注入 | 搁置 (RAG) |
| 持久化 | 无 | TODO |
| 模块数量 | 4 src 文件 + 4 test 文件 | 3 src 文件 + 3 test 文件 |

## 8. 不纳入本次的范围

- Language Layer 实现（按需 RAG 检索）- 后续
- 会话持久化（序列化/恢复）- TODO
- 用户消息的日志粘贴截断 - 后续
- 按语义重要性做驱逐排序 - 后续

## 9. 自我审查

- [x] 无 TBD/TODO 占位符（除明确标记"后续"的项）
- [x] 架构图与接口定义一致（assemble/compact 分离）
- [x] 无内部矛盾（compact 不会动 user/assistant，pin 覆盖全流程）
- [x] 范围可控：3 新文件 + 修改现有文件 + 删除 4 文件
- [x] 所有边界条件在 §6 列出
- [x] `summarizer_model` 和 `flow_rounds` 配置字段已从 ContextConfig 中移除
