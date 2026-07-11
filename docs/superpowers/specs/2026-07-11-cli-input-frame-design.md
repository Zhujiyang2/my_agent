# CLI 输入框重构 — raw mode + 自主渲染

**日期**: 2026-07-11
**状态**: 设计完成

## 问题

当前 `bin/my-agent.ts` 使用 readline 管理输入，同时通过 ANSI cursor dance + monkey-patch `_refreshLine` 在 prompt 上下渲染分隔线 frame。readline 内部光标追踪与实际 ANSI 移动冲突，导致：

1. 初始启动时底部横杠和提示行消失
2. 多次提交尝试修复（7+ commits），换个终端或 Node 版本又出问题
3. monkey-patch 依赖 Node 内部实现细节，不可持续

## 目标

- 用户输入光标**始终**在两条横杠之间
- 输入后回显的用户消息带灰色底色
- 所有间距紧凑、无多余空行
- 不再依赖 readline 内部实现细节
- 不引入重量级 TUI 框架

## 帧结构

```
────────────────────────────────────────────  ← 上横杠
> 用户输入█                                    ← 光标在这行（两杠之间）
────────────────────────────────────────────  ← 下横杠
  /exit to quit | Ctrl+C to interrupt          ← 静态提示
```

用户打字时 frame 始终围绕输入行。按回车后：
- 输入行以灰色底色回显在对话历史中（无横杠包裹）
- LLM 流式输出时 frame 消失
- 流式输出结束后 frame 恢复

## 核心变化

### 新增：`src/cli/input-line.ts`

接管屏幕渲染和键盘输入，readline 降级为纯键盘事件源。

```
createInputLine(opts) → InputLine {
  // 内部状态
  line: string        // 当前输入内容
  cursor: int         // 光标在 line 中的位置（字符索引）

  // 渲染
  renderFrame()
    1. 清空当前行到屏幕底部的所有内容（\x1b[0J）
    2. 写上横杠（footer.renderSeparator()）
    3. 写 "\x1b[36m> \x1b[0m" + line（输入行）
    4. 写下横杠 + 提示（footer.render()）
    5. ANSI 光标上移（下横杠+提示共 N 行，回到输入行）
    6. ANSI 光标右移到 "> " 后 + cursor 位置

  // 键盘事件（通过 readline keypress 触发）
  onKeypress(str, key)
    普通字符 → line 插入到 cursor，cursor++
    Backspace → 删除 cursor-1 字符，cursor--
    Delete    → 删除 cursor 字符
    左箭头    → cursor = max(0, cursor-1)
    右箭头    → cursor = min(line.length, cursor+1)
    Ctrl+A    → cursor = 0
    Ctrl+E    → cursor = line.length
    Home      → cursor = 0
    End       → cursor = line.length
    Enter     → submit()
    每次操作后调用 renderFrame()

  // 提交
  submit()
    1. 保存当前 line 为 submitted
    2. 清空 line 和 cursor
    3. 灰色底色回显 submitted（\x1b[48;5;237m）
    4. 调用 onSubmit 回调

  // 恢复输入
  reset()
    清空 line 和 cursor，调用 renderFrame()
}
```

**为什么这里用 ANSI 光标移动不会出 bug：**
- 之前 readline 的 `_refreshLine` 在用户每次按键时也会移动光标，和我们自己的 ANSI 移动冲突
- 现在 readline 不参与渲染，只有 `renderFrame` 在控制光标——单一主人，没有冲突

**`renderFrame` 的光标路径：**
```
写上横杠        → 光标在行末
写输入行        → 光标在输入文本后
写下横杠        → 光标在下横杠行末
写提示          → 光标在最后一行行末
\x1b[N A       → 回到输入行行首
\x1b[M C       → 右移到 "> " + cursor 位置
```

### 新增：`src/cli/chat.ts` — 灰色底色格式化

```typescript
export function formatEchoedInput(content: string): string {
  return `\x1b[48;5;237m\x1b[36m> ${content}\x1b[0m`;
}
```

- `\x1b[48;5;237m` — 深灰底色（ANSI 256 色 #237）
- `\x1b[36m` — 青色 `> ` 前缀
- `\x1b[0m` — 重置

### 修改：`src/cli/footer.ts`

增加一个辅助方法 `renderFrameLines()` 返回 frame 总行数（不包含输入行），供 `renderFrame` 计算上移行数。

```typescript
function frameLineCount(): number {
  // 上横杠(1) + 下横杠(1) + 提示行数
  return 2 + (messages.length > 0 ? messages.length : 0);
}
```

### 修改：`bin/my-agent.ts`

删除：
- `reprompt()` 函数
- monkey-patch `_refreshLine`（172-176 行）
- `console.log('')` 多余空行（60 行）
- `console.log('')` LLM 前空行（270 行）
- `console.log('\n')` LLM 后空行（274 行）
- `rl.prompt` 的设置（81 行改为空字符串）

替换为：
- 创建 `InputLine` 实例
- `rl.on('line', ...)` → `inputLine.onSubmit(...)`
- 处理 Ctrl+C → `inputLine.reset()`

## 数据流

```
按键 → readline keypress → inputLine.onKeypress()
                              ↓
                        更新 line/cursor
                              ↓
                        renderFrame()
                        写 ANSI 到 stdout
                              ↓
                          按 Enter
                              ↓
                        submit()
                        灰色回显 + 调用 onSubmit
                              ↓
                        agent.send() → LLM 流式输出到 stdout
                              ↓
                        流式结束 → inputLine.reset()
                              ↓
                        renderFrame() 恢复 frame
```

## 测试要点

| 场景 | 预期 |
|------|------|
| 启动 | 欢迎信息 → 底部 frame（上横杠、`> `、下横杠、提示） |
| 输入普通字符 | 字符出现在 `> ` 后面，光标在字符后 |
| Backspace | 删除光标前字符，frame 保持 |
| 左右箭头 | 光标在文本中移动，不改变内容 |
| Ctrl+A / Home | 光标跳到行首（`> ` 之后） |
| Ctrl+E / End | 光标跳到行尾 |
| 回车 | 输入行以灰色底色回显，frame 消失，LLM 输出 |
| LLM 流式输出中 | frame 不显示，token 直接 stdout |
| LLM 完成 | frame 恢复，`> ` 等待新输入 |
| Ctrl+C 中断 | 显示 "Interrupted"，frame 恢复 |
| 多轮对话 | 每次输入都有灰色底色回显，frame 在底部 |
| 终端缩放 | 横杠宽度跟随终端宽度 |
| 空输入回车 | 不提交，重新显示 frame |

## 文件清单

| 文件 | 操作 |
|------|------|
| `src/cli/input-line.ts` | 新增 |
| `src/cli/__tests__/input-line.test.ts` | 新增 |
| `src/cli/chat.ts` | 修改（增加 formatEchoedInput） |
| `src/cli/__tests__/chat.test.ts` | 修改（增加测试） |
| `src/cli/footer.ts` | 修改（增加 frameLineCount） |
| `src/cli/__tests__/footer.test.ts` | 修改（增加测试） |
| `bin/my-agent.ts` | 修改（大量简化） |
