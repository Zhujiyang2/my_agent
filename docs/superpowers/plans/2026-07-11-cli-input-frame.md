# CLI 输入框重构 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 raw mode + 自主渲染替代 readline cursor dance，用户光标始终在两条横杠之间，输入回显带灰色底色。

**Architecture:** 新增 `src/cli/input-line.ts` 接管屏幕渲染和键盘输入，readline 降级为 SIGINT/close/question 支持。所有光标控制由 InputLine 单一模块管理，无状态冲突。

**Tech Stack:** TypeScript, Node.js readline (仅 keypress/SIGINT/question), ANSI escape codes, Vitest

---

### Task 1: formatEchoedInput — 灰色底色格式化

**Files:**
- Modify: `src/cli/chat.ts`
- Modify: `src/cli/__tests__/chat.test.ts`

- [ ] **Step 1: Write failing test for formatEchoedInput**

在 `src/cli/__tests__/chat.test.ts` 末尾添加：

```typescript
import { formatEchoedInput } from '../chat';

describe('formatEchoedInput', () => {
  it('wraps user input with gray background', () => {
    const result = formatEchoedInput('你好');
    // ANSI 256-color background 237 = dark gray
    expect(result).toContain('\x1b[48;5;237m');
    expect(result).toContain('> 你好');
    expect(result).toContain('\x1b[0m');
    // Gray bg must come before the content
    const bgIdx = result.indexOf('\x1b[48;5;237m');
    const resetIdx = result.indexOf('\x1b[0m');
    expect(bgIdx).toBeLessThan(resetIdx);
  });

  it('handles empty string', () => {
    const result = formatEchoedInput('');
    expect(result).toContain('\x1b[48;5;237m');
    expect(result).toContain('> ');
    expect(result).toContain('\x1b[0m');
  });
});
```

同时在 `src/cli/__tests__/chat.test.ts` 顶部 import 中加上 `formatEchoedInput`。

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/cli/__tests__/chat.test.ts 2>&1
```
Expected: FAIL — `formatEchoedInput is not exported`

- [ ] **Step 3: Implement formatEchoedInput**

在 `src/cli/chat.ts` 末尾添加：

```typescript
export function formatEchoedInput(content: string): string {
  return `\x1b[48;5;237m\x1b[36m> ${content}\x1b[0m`;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/cli/__tests__/chat.test.ts 2>&1
```
Expected: PASS (all tests including new ones)

- [ ] **Step 5: Commit**

```bash
git add src/cli/chat.ts src/cli/__tests__/chat.test.ts
git commit -m "feat: add formatEchoedInput with gray background for user input echo"
```

---

### Task 2: frameLineCount — footer 行数计算

**Files:**
- Modify: `src/cli/footer.ts`
- Modify: `src/cli/__tests__/footer.test.ts`

- [ ] **Step 1: Write failing test for frameLineCount**

在 `src/cli/__tests__/footer.test.ts` 末尾添加：

```typescript
  describe('frameLineCount', () => {
    beforeEach(() => {
      footer = createFooter();
    });

    it('returns 2 when no messages (top sep + bottom sep/hint)', () => {
      // top sep = 1, bottom = 1 (sep + hint on same conceptual row...)
      // Actually: top sep(1) + bottom content lines
      // bottom.render() with no messages = sep(1) + hint(1) = 2 lines
      // Total = topSep(1) + bottom(2) = 3
      expect(footer.frameLineCount()).toBe(3);
    });

    it('includes message lines in count', () => {
      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd: done' });
      // bottom.render() = sep(1) + hint(1) + msg(1) = 3 lines
      // Total = topSep(1) + 3 = 4
      expect(footer.frameLineCount()).toBe(4);
    });

    it('includes multiple messages', () => {
      footer.upsert({ id: 'job-1', icon: '✓', text: 'cmd1: done' });
      footer.upsert({ id: 'job-2', icon: '✗', text: 'cmd2: failed' });
      // bottom.render() = sep(1) + hint(1) + msg(2) = 4 lines
      // Total = topSep(1) + 4 = 5
      expect(footer.frameLineCount()).toBe(5);
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/cli/__tests__/footer.test.ts 2>&1
```
Expected: FAIL — `footer.frameLineCount is not a function`

- [ ] **Step 3: Implement frameLineCount**

在 `src/cli/footer.ts` 的 `createFooter` 返回对象中添加方法。在 `clear` 方法后面添加：

```typescript
  /** Total lines in the frame (top sep + bottom content). Used by InputLine to
   *  calculate cursor-up offset after rendering the full frame. */
  function frameLineCount(): number {
    // top separator = 1 line
    // bottom = separator(1) + hint(1) + messages
    return 1 + 1 + 1 + messages.length;
  }
```

并在 return 对象中添加：

```typescript
return { upsert, remove, render, renderSeparator, clear, frameLineCount };
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/cli/__tests__/footer.test.ts 2>&1
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/footer.ts src/cli/__tests__/footer.test.ts
git commit -m "feat: add frameLineCount to footer for cursor-dance offset calculation"
```

---

### Task 3: InputLine 模块 — 核心输入渲染器

**Files:**
- Create: `src/cli/input-line.ts`
- Create: `src/cli/__tests__/input-line.test.ts`

这是本次重构的核心。InputLine 接管：
- 屏幕渲染（frame + 输入行）
- 键盘事件处理（字符输入、编辑、提交）
- 光标管理（始终在两条横杠之间）

依赖：`footer` 对象（提供 `renderSeparator()`, `render()`, `frameLineCount()`）

- [ ] **Step 1: Write test file**

创建 `src/cli/__tests__/input-line.test.ts`：

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createInputLine } from '../input-line';
import type { FooterMessage } from '../footer';

// Minimal footer stub matching the real interface
function createStubFooter(messages: FooterMessage[] = []) {
  return {
    messages,
    upsert(msg: FooterMessage) {
      const idx = messages.findIndex(m => m.id === msg.id);
      if (idx >= 0) messages[idx] = msg;
      else messages.push(msg);
    },
    remove(_id: string) {},
    clear() { messages.length = 0; },
    renderSeparator() {
      return '─'.repeat(80);
    },
    render() {
      const sep = '─'.repeat(80);
      const lines = [sep, '  /exit to quit | Ctrl+C to interrupt | Ctrl+O tasks'];
      for (const msg of messages) {
        lines.push(`${msg.icon} ${msg.text}`);
      }
      return lines.join('\n');
    },
    frameLineCount() {
      // top sep(1) + bottom sep(1) + hint(1) + messages
      return 3 + messages.length;
    },
  };
}

describe('createInputLine', () => {
  let footer: ReturnType<typeof createStubFooter>;
  let onWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    footer = createStubFooter();
    onWrite = vi.fn();
  });

  describe('initial state', () => {
    it('has empty line and cursor at 0', () => {
      const il = createInputLine({ footer, onWrite });
      expect(il.getLine()).toBe('');
      expect(il.getCursor()).toBe(0);
    });
  });

  describe('character input', () => {
    it('inserts character at cursor position', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      expect(il.getLine()).toBe('你');
      expect(il.getCursor()).toBe(1);
    });

    it('inserts multiple characters in order', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      expect(il.getLine()).toBe('你好');
      expect(il.getCursor()).toBe(2);
    });

    it('writes frame on each keypress', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      expect(onWrite).toHaveBeenCalled();
      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      expect(output).toContain('> a');
      expect(output).toContain('─'.repeat(80));
    });
  });

  describe('backspace', () => {
    it('deletes character before cursor', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'backspace', ctrl: false, meta: false, shift: false });
      expect(il.getLine()).toBe('你');
      expect(il.getCursor()).toBe(1);
    });

    it('does nothing when line is empty', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('', { name: 'backspace', ctrl: false, meta: false, shift: false });
      expect(il.getLine()).toBe('');
      expect(il.getCursor()).toBe(0);
    });
  });

  describe('delete', () => {
    it('deletes character at cursor', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      // Move cursor left first to test delete at non-end position
      il.onKeypress('', { name: 'left', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'delete', ctrl: false, meta: false, shift: false });
      expect(il.getLine()).toBe('好');
      expect(il.getCursor()).toBe(0);
    });
  });

  describe('cursor movement', () => {
    it('moves cursor left', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'left', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(1);
    });

    it('moves cursor right', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'left', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'right', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(1);
    });

    it('does not move past start (cursor = 0)', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('', { name: 'left', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(0);
    });

    it('does not move past end (cursor = line.length)', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'right', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(1);
    });

    it('Ctrl+A / Home jumps to start', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'home', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(0);
    });

    it('Ctrl+E / End jumps to end', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'left', ctrl: false, meta: false, shift: false });
      il.onKeypress('', { name: 'end', ctrl: false, meta: false, shift: false });
      expect(il.getCursor()).toBe(2);
    });
  });

  describe('submit', () => {
    it('echoes input with gray background on Enter', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.onKeypress('好', { name: '好', ctrl: false, meta: false, shift: false });

      const submitted = il.submit();
      expect(submitted).toBe('你好');

      // Check gray background echo was written
      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      expect(output).toContain('\x1b[48;5;237m');
      expect(output).toContain('> 你好');
    });

    it('clears internal state after submit', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('你', { name: '你', ctrl: false, meta: false, shift: false });
      il.submit();
      expect(il.getLine()).toBe('');
      expect(il.getCursor()).toBe(0);
    });

    it('skips empty input (does not echo)', () => {
      const il = createInputLine({ footer, onWrite });
      const submitted = il.submit();
      expect(submitted).toBe('');
    });

    it('returns empty string for whitespace-only input', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress(' ', { name: ' ', ctrl: false, meta: false, shift: false });
      const submitted = il.submit();
      expect(submitted).toBe(' ');
    });
  });

  describe('reset', () => {
    it('clears line and renders frame', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('a', { name: 'a', ctrl: false, meta: false, shift: false });
      onWrite.mockClear();
      il.reset();
      expect(il.getLine()).toBe('');
      expect(il.getCursor()).toBe(0);
      // Should render frame (called during reset)
      expect(onWrite).toHaveBeenCalled();
    });
  });

  describe('renderFrame', () => {
    it('renders top sep, prompt with line, bottom frame', () => {
      const il = createInputLine({ footer, onWrite });
      il.onKeypress('hello', { name: 'h', ctrl: false, meta: false, shift: false });
      onWrite.mockClear();

      il.renderFrame();

      const output = onWrite.mock.calls.map((c: string[]) => c[0]).join('');
      expect(output).toContain('> hello');
      expect(output).toContain('─'.repeat(80));
      expect(output).toContain('/exit to quit');
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run src/cli/__tests__/input-line.test.ts 2>&1
```
Expected: FAIL — `Cannot find module '../input-line'`

- [ ] **Step 3: Implement InputLine**

创建 `src/cli/input-line.ts`：

```typescript
import type { createFooter } from './footer.js';

type Footer = ReturnType<typeof createFooter>;

export interface InputLineOpts {
  footer: Footer;
  onWrite: (text: string) => void;
}

export interface InputLine {
  getLine(): string;
  getCursor(): number;
  onKeypress(str: string, key: { name: string; ctrl: boolean; meta: boolean; shift: boolean }): void;
  submit(): string;
  reset(): void;
  renderFrame(): void;
}

export function createInputLine(opts: InputLineOpts): InputLine {
  const { footer, onWrite } = opts;

  let line = '';
  let cursor = 0;

  function getLine(): string {
    return line;
  }

  function getCursor(): number {
    return cursor;
  }

  /** Render the full frame with input line between separators.
   *
   *  Layout:
   *    ────────────────  ← top sep
   *    > {line}█         ← input line (cursor here)
   *    ────────────────  ← bottom sep
   *      hints/messages  ← footer content
   *
   *  After writing everything top-to-bottom, we ANSI-cursor-up back to the
   *  input line and right to the correct cursor column. Since readline is NOT
   *  involved in rendering (we only use its keypress events), there's no
   *  conflicting cursor state — we are the sole owner of stdout positioning.
   */
  function renderFrame(): void {
    const topSep = footer.renderSeparator();
    const bottom = footer.render();
    const frameLines = footer.frameLineCount();

    // Write frame top-to-bottom
    onWrite('\x1b[0J'); // clear from cursor to end of screen (removes stale frame)
    onWrite(topSep + '\n');
    onWrite(`\x1b[36m> ${line}\x1b[0m\n`);
    onWrite(bottom + '\n');

    // Cursor is now at the start of the line AFTER `bottom`.
    // Move up `frameLines` rows to the input line (the line we just wrote `> ` on).
    // `frameLines` = topSep(1) + bottom lines. The input line is right above
    // the first bottom line, so we move up `bottomLines` rows.
    // bottom lines = footer.render().split('\n').length
    const bottomLines = bottom.split('\n').length;
    // Move cursor up: skip past the bottom content to land on the input line
    onWrite(`\x1b[${bottomLines}A`);
    // Move right: past "> " (2 chars) + cursor offset within line
    onWrite(`\x1b[${2 + cursor}C`);
  }

  function onKeypress(
    str: string,
    key: { name: string; ctrl: boolean; meta: boolean; shift: boolean },
  ): void {
    if (key.name === 'return' || key.name === 'enter') {
      // Handled externally via submit()
      return;
    }

    if (key.name === 'backspace') {
      if (cursor > 0) {
        line = line.slice(0, cursor - 1) + line.slice(cursor);
        cursor--;
      }
    } else if (key.name === 'delete') {
      if (cursor < line.length) {
        line = line.slice(0, cursor) + line.slice(cursor + 1);
      }
    } else if (key.name === 'left') {
      if (cursor > 0) cursor--;
    } else if (key.name === 'right') {
      if (cursor < line.length) cursor++;
    } else if (key.name === 'home' || (key.ctrl && key.name === 'a')) {
      cursor = 0;
    } else if (key.name === 'end' || (key.ctrl && key.name === 'e')) {
      cursor = line.length;
    } else if (str && str.length === 1) {
      // Ordinary character
      line = line.slice(0, cursor) + str + line.slice(cursor);
      cursor++;
    }

    renderFrame();
  }

  /** Submit current line. Returns the submitted content.
   *  Echoes with gray background, clears internal state. */
  function submit(): string {
    const submitted = line.trim();
    if (submitted.length > 0) {
      // Gray background echo
      onWrite(`\x1b[48;5;237m\x1b[36m> ${submitted}\x1b[0m\n`);
    }
    line = '';
    cursor = 0;
    return submitted;
  }

  /** Reset state and re-render frame (e.g. after LLM finishes streaming). */
  function reset(): void {
    line = '';
    cursor = 0;
    renderFrame();
  }

  return { getLine, getCursor, onKeypress, submit, reset, renderFrame };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run src/cli/__tests__/input-line.test.ts 2>&1
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/input-line.ts src/cli/__tests__/input-line.test.ts
git commit -m "feat: add InputLine module — raw mode input with self-managed frame rendering"
```

---

### Task 4: bin/my-agent.ts 集成

**Files:**
- Modify: `bin/my-agent.ts`

- [ ] **Step 1: Rewrite bin/my-agent.ts to use InputLine**

`bin/my-agent.ts` 的完整新内容：

```typescript
#!/usr/bin/env node

// My Agent CLI - terminal AI assistant
// Usage: npm start  or  node --import tsx bin/my-agent.ts

// Bootstrap proxy support (via global-agent) — set GLOBAL_AGENT_HTTP_PROXY env var to activate
import 'global-agent/bootstrap';

import path from 'node:path';
import readline from 'node:readline';
import { loadConfig } from '../src/config/loader';
import { createAgent } from '../src/agent/loop';
import {
  formatWelcome,
  formatError,
  formatInfo,
  formatToolCall,
  formatEchoedInput,
} from '../src/cli/chat';
import { createCommandRegistry } from '../src/cli/commands/index.js';
import { dispatch } from '../src/cli/commands/dispatcher.js';

// Load tools — side-effect imports trigger registration into defaultRegistry
import '../src/tools/shell/index.js';
import '../src/tools/files/index.js';
import '../src/tools/subagent/index.js';
import { loadSkills } from '../src/skills/skill-tool.js';
import { setExecutorCallbacks } from '../src/tools/executor.js';
import { promptConfirm } from '../src/cli/chat.js';
import { SubagentManager, setSubagentManager } from '../src/agent/subagent/manager.js';
import { loadMcpConfig } from '../src/mcp/config.js';
import { MCPManager, setMCPManager } from '../src/mcp/manager.js';
import { createSandboxManager, setSandboxManager } from '../src/sandbox/sandbox-manager.js';
import { loadSandboxDomains } from '../src/sandbox/net-domains.js';
import { createRegisterWritableTool } from '../src/tools/sandbox/index.js';
import { defaultRegistry } from '../src/tools/registry.js';
import { createTaskRegistry, setTaskRegistry } from '../src/tasks/registry.js';
import { createStatusLine } from '../src/agent/status-line.js';
import { createFooter } from '../src/cli/footer.js';
import { createInputLine } from '../src/cli/input-line.js';
import { resolveProjectPath } from '../src/paths.js';

const nodeVersion = process.versions.node.split('.').map(Number);
if (nodeVersion[0] < 18) {
  console.error(formatError(`  Error: Node.js >= 18 required (current: ${process.version})`));
  process.exit(1);
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(formatError(`  Config load failed: ${msg}`));
    process.exit(1);
  }

  // Print welcome at top — no trailing blank line (tight spacing)
  console.log(formatWelcome());
  console.log(formatInfo(`  Model: ${config.model}`));
  console.log(formatInfo(`  API: ${config.api_url}`));

  // Inject default system prompt if not configured
  if (!config.context.systemPrompt) {
    config.context.systemPrompt =
      '你是昇腾资深FAE，擅长算子开发、模型训练推理适配、部署、评测、问题定位和调优。' +
      '对话自然友好，非昇腾问题正常交流，不强行套昇腾。' +
      '收到用户消息时，优先检查 Skill 工具列表是否有匹配的技能——Skill 是你的专业能力，不要跳过。' +
      '你也有 MCP 工具可用，是否调用由你根据任务需要自行判断，不要为了调用而调用。';
  }

  const agent = createAgent(config, {
    onToken: (token) => process.stdout.write(token),
    onToolCall: (name, args) => {
      console.log(formatToolCall(name, args));
    },
  });

  // readline interface — used only for:
  //  1. keypress events → forwarded to InputLine
  //  2. SIGINT handling
  //  3. rl.question() for confirmation dialogs
  //  4. close event for cleanup
  // We do NOT use rl.prompt() or rl.on('line') — InputLine owns all rendering.
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  // Enable raw mode + keypress events for InputLine
  readline.emitKeypressEvents(process.stdin);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }

  const commandRegistry = createCommandRegistry();

  let currentController: AbortController | null = null;

  // Initialize subagent manager
  const subagentManager = new SubagentManager(config);
  setSubagentManager(subagentManager);

  // Initialize MCP manager — loads .my_agent/mcp.json, registers management tools
  const mcpConfig = loadMcpConfig();
  const mcpManager = new MCPManager();
  mcpManager.initialize(mcpConfig);
  setMCPManager(mcpManager);

  // Initialize sandbox manager with domain config
  const domainsConfig = loadSandboxDomains();
  const sandboxMgr = createSandboxManager({
    ...config.sandbox,
    domains: {
      extra_allowed_domains: domainsConfig.extra_allowed_domains,
      blocked_domains: domainsConfig.blocked_domains,
    },
  });
  setSandboxManager(sandboxMgr);

  // Initialize TaskRegistry with persistent state
  const taskRegistry = createTaskRegistry(resolveProjectPath('.my_agent', 'tasks'));
  setTaskRegistry(taskRegistry);
  await taskRegistry.restore();
  await taskRegistry.recover();

  // Register sandbox tools
  defaultRegistry.register(createRegisterWritableTool());

  // Load skills from project directory
  loadSkills(path.join(process.cwd(), 'skills'));

  // Initialize footer for job completion messages + frame rendering
  const footer = createFooter();
  taskRegistry.onTaskComplete((task) => {
    const icon = task.status === 'completed' ? '✓' : '✗';
    const elapsed = ((task.finishedAt! - task.createdAt) / 1000).toFixed(1);
    const cmd = task.command.length > 60
      ? task.command.slice(0, 57) + '...'
      : task.command;
    footer.upsert({
      id: task.id,
      icon,
      text: `${cmd}: ${task.status} (${elapsed}s)`,
    });
  });

  // InputLine: self-managed frame + cursor, readline only provides keypress events
  const inputLine = createInputLine({
    footer,
    onWrite: (text: string) => process.stdout.write(text),
  });

  // Render initial frame at the bottom of the welcome output
  inputLine.renderFrame();

  // Set up safety confirmation — temporarily leave raw mode for rl.question()
  setExecutorCallbacks({
    onConfirm: async (command: string, category: string) => {
      process.stdout.write(promptConfirm(command, category) + '\n');
      // Exit raw mode so rl.question() gets 'line' events
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      const answer = await new Promise<string>((resolve) => {
        rl.question('> ', resolve);
      });
      // Back to raw mode for InputLine
      if (process.stdin.isTTY) process.stdin.setRawMode(true);
      return answer.trim().toLowerCase().startsWith('y');
    },
  });

  // Start task status-line (stderr to avoid mixing with LLM output on stdout)
  const statusLine = createStatusLine({ intervalMs: 3000 });
  statusLine.start();

  // Ctrl+O toggles task status-line expand/collapse
  process.stdin.on('keypress', (_ch, key) => {
    if (key && key.ctrl && !key.meta && key.name === 'o') {
      statusLine.toggle();
      return;
    }

    // Ctrl+C: abort current LLM call
    if (key && key.ctrl && key.name === 'c') {
      if (currentController) {
        currentController.abort();
        currentController = null;
        console.log(formatInfo('\n  Interrupted'));
      }
      inputLine.reset();
      return;
    }

    // Enter: submit input
    if (key && key.name === 'return') {
      handleSubmit();
      return;
    }

    // All other keys → InputLine
    inputLine.onKeypress(_ch || '', key || { name: '', ctrl: false, meta: false, shift: false });
  });

  async function handleSubmit(): Promise<void> {
    const input = inputLine.submit();
    if (!input) {
      inputLine.renderFrame();
      return;
    }

    // Build command context (shared for all commands)
    const cmdCtx = {
      agent,
      contextManager: agent.contextManager,
      config,
      output: {
        info: (text: string) => console.log(formatInfo(`  ${text}`)),
        error: (text: string) => console.log(formatError(`  ${text}`)),
      },
      ui: {
        prompt: async (text: string) => {
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          const answer = await new Promise<string>((resolve) => {
            rl.question(text, resolve);
          });
          if (process.stdin.isTTY) process.stdin.setRawMode(true);
          return answer;
        },
        write: (text: string) => {
          process.stdout.write(text);
        },
      },
    };

    const result = await dispatch(input, commandRegistry, cmdCtx);

    if (result.action === 'exit') {
      console.log(formatInfo('  Goodbye!\n'));
      rl.close();
      return;
    }

    if (result.action === 'continue') {
      inputLine.renderFrame();
      return;
    }

    // action === 'send_to_agent'
    currentController = new AbortController();

    try {
      await agent.send(result.input, currentController.signal);
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // interrupted by Ctrl+C — no extra message needed
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(formatError(`  Error: ${msg}`));
      }
    } finally {
      currentController = null;
    }

    // After LLM output, restore the input frame
    inputLine.renderFrame();
  }

  // Handle SIGINT from the OS (Ctrl+C in raw mode comes through keypress above)
  rl.on('SIGINT', () => {
    if (currentController) {
      currentController.abort();
      currentController = null;
      console.log(formatInfo('\n  Interrupted'));
    }
    inputLine.reset();
  });

  rl.on('close', () => {
    statusLine.stop();
    taskRegistry.destroy();
    subagentManager.destroy();
    mcpManager.destroy().catch(() => {});
    sandboxMgr.destroy().catch(() => {});
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(formatError(`  Fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
```

- [ ] **Step 2: Verify existing tests still pass**

```bash
npx vitest run 2>&1
```
Expected: All existing tests PASS (new InputLine module doesn't affect existing tests)

- [ ] **Step 3: Run the app to visually verify**

```bash
npm start
```
Visual checks:
- Welcome message appears at top
- Frame (top sep + `> ` + bottom sep + hints) at bottom, no gap
- Type characters → appear between separators
- Backspace → deletes correctly
- Enter with input → gray background echo, LLM streams
- After LLM → frame reappears at bottom
- Ctrl+C → "Interrupted", frame reappears
- Empty Enter → frame stays, nothing submitted

- [ ] **Step 4: Commit**

```bash
git add bin/my-agent.ts
git commit -m "refactor: replace readline cursor dance with InputLine self-managed rendering"
```

---

### 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/cli/chat.ts` | 修改 | 新增 `formatEchoedInput` |
| `src/cli/__tests__/chat.test.ts` | 修改 | 新增 `formatEchoedInput` 测试 |
| `src/cli/footer.ts` | 修改 | 新增 `frameLineCount` |
| `src/cli/__tests__/footer.test.ts` | 修改 | 新增 `frameLineCount` 测试 |
| `src/cli/input-line.ts` | **新增** | 核心模块：raw mode 输入 + 自主渲染 |
| `src/cli/__tests__/input-line.test.ts` | **新增** | InputLine 单元测试 |
| `bin/my-agent.ts` | 修改 | 删除 cursor dance，集成 InputLine |
