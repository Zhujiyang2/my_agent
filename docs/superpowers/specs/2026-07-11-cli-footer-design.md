# CLI Footer — 输入框回显重构

**日期**: 2026-07-11
**状态**: 设计完成

## 问题

1. `status-line.ts` 的轮询刷新把 `✓ job-xxx: completed` 写到 stderr，与 readline 的 stdout prompt 共享终端光标位置，导致 ANSI 清除码 `\x1b[1A\x1b[2K` 定位失败 — 旧行残留、新行追加，形成重复回显
2. 完成消息占用输入行上方空间，与 `[y/N]` 确认提示抢位置
3. 只显示 job id，无法判断任务内容

## 目标

- job 完成消息改为事件驱动的一次性回显，不再轮询刷新
- 输入框下方使用 Claude Code 风格的双分隔线 footer 区域
- 显示 `task.command` 让用户知道哪个任务完成
- 消除重复回显 bug

## 帧结构

每次 `rl.prompt()` 前渲染完整的一帧：

```
────────────────────────────────────────────────────────────────────────────────  ← 顶部分隔线
> _                                                                              ← readline prompt
────────────────────────────────────────────────────────────────────────────────  ← 底部分隔线
  Ctrl+O expand tasks                                                            ← 静态提示
✓ python train.py --epochs 100: completed (12.3s)                                ← 动态状态消息
✗ npm run build: failed (2.7s)
```

无消息时只显示分隔线和提示，无消息区域。

## 架构

### 新增：`src/cli/footer.ts`

Footer 消息缓冲区模块，纯数据管理 + 字符串渲染，不碰 ANSI 控制码。

```typescript
interface FooterMessage {
  id: string;   // task.id，用于去重
  icon: string; // "✓" | "✗"
  text: string; // 完整显示文本
}

function createFooter() {
  upsert(msg: FooterMessage): void;   // 同 id 替换，防重复
  remove(id: string): void;           // 预留，暂不使用
  render(): string;                   // 返回完整 footer 字符串
  clear(): void;                      // 清空全部消息
}
```

**去重 + 滚动策略：**
- `upsert` 以 `id` 去重，同 id 直接替换
- 缓冲区保留最近 5 条，超出丢弃最旧
- 消息不主动删除，自然被新消息顶出

**render 输出：**
- 终端宽度 80 列用 `─` 填充分隔线
- `task.command` 截断到 60 字符
- 耗时从 `finishedAt - createdAt` 计算，单位秒

### 修改：`src/agent/status-line.ts`

**职责收窄** — 只显示运行中任务。

**collapsed 视图：** 去掉 `│ ✓ job-xxx: completed` 部分，仅保留：
```
┃ ⚡ 2 running
```

**expanded 视图：** 不变，Ctrl+O 展开后仍可看到已完成任务历史。

**refresh 清除修复：** 将裸 `\x1b[1A\x1b[2K` 替换为 `readline.cursorTo(process.stderr, 0)` + `readline.clearScreenDown(process.stderr)`，避免光标位置漂移导致残留。如果当前行不是行首，先换行再清除。

### 修改：`bin/my-agent.ts`

**渲染时机：** 在每个 `rl.prompt()` 调用前输出 footer。

**事件绑定：** 注册 TaskRegistry 的完成回调，填入 footer 缓冲区：

```typescript
taskReg.onTaskComplete((task) => {
  const elapsed = ((task.finishedAt! - task.createdAt) / 1000).toFixed(1);
  footer.upsert({
    id: task.id,
    icon: task.status === 'completed' ? '✓' : '✗',
    text: `${icon} ${truncate(task.command, 60)}: ${task.status} (${elapsed}s)`,
  });
});
```

### 不改：`src/agent/loop.ts`

现有的 task 完成回调（注入 stdout/stderr 结果到上下文）保持不变，与 footer 显示解耦。

## 数据流

```
Task 完成
  ├─ registry.ts: onTaskComplete callback
  │    ├─ loop.ts: 注入 stdout/stderr 到 LLM 上下文（不变）
  │    └─ bin/my-agent.ts: footer.upsert({...})  ← 新增
  │
  └─ 下一次 rl.prompt() 时
       └─ console.log(footer.render())
       └─ rl.prompt()
```

## 测试要点

| 场景 | 预期 |
|------|------|
| 单个任务完成 | footer 显示 `✓ <command>: completed (X.Xs)` |
| 多个任务完成 | 按完成时间排列，最多 5 条 |
| 同一任务重复触发完成事件 | `upsert` 去重，不会重复显示 |
| 无运行中任务 | 状态行 collapsed 视图只显示提示，不显示已完成 |
| Ctrl+O 展开 | 状态行 expanded 视图仍列出已完成任务详情 |
| 终端窗口变窄 | 消息截断适配，分隔线正确 |
| 无任何任务 | footer 只显示分隔线和 Ctrl+O 提示 |

## 文件清单

| 文件 | 操作 |
|------|------|
| `src/cli/footer.ts` | 新增 |
| `src/cli/__tests__/footer.test.ts` | 新增 |
| `src/agent/status-line.ts` | 修改 |
| `src/agent/__tests__/status-line.test.ts` | 修改 |
| `bin/my-agent.ts` | 修改 |
