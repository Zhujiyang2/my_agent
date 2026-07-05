# Skill 系统设计

## 概述

为 Agent 新增 Skill 系统，允许通过 markdown 文件定义可复用的任务指导规范。Skill 本质是 prompt + 自然语言指令，由 LLM 通过工具调用按需加载，不持久占用上下文。

**核心原则：** 极简。Skill 是 markdown 文件，加载即 tool result，退出靠 compaction。不引入状态管理、不引入生命周期栈。

## Skill 文件格式

位置：`.my-agent/skills/<name>.md`

```markdown
---
name: brainstorming
description: 帮助将想法转化为完整设计文档
---

# Brainstorming Ideas Into Designs

...自然语言指令...

完成后调用 writing-plans skill。
```

### Frontmatter 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 唯一标识，对应 Skill 工具 enum 值 |
| `description` | 是 | 一句话描述，出现在工具描述中供 LLM 判断适用性 |

内容自由自然语言，无格式约束。Skill 间串联通过内容中的自然语言引导（如 "完成后调用 xxx skill"），不强依赖。

## 架构

```
启动时:
  扫描 .my-agent/skills/*.md → 解析 frontmatter → Map<name, {name, description, path}>

注册 1 个工具:
  Skill({ name })  // name 是 enum，从扫描到的 skill 列表动态生成

LLM 调用 Skill 工具:
  handler 读文件 → 返回原始内容作为 ToolResult.content
```

无 SkillManager 单例，无 enter/exit 栈，无状态追踪。

### 文件结构

```
src/skills/
  skill-tool.ts          ← 唯一新文件（扫描 + 工具注册）
  __tests__/
    skill-tool.test.ts   ← 测试
```

`bin/my-agent.ts` 加一行 `import '../src/skills/skill-tool.js'` 触发副作用注册。

## 完整生命周期

### 1. 启动阶段

```
loadSkills() 扫描 .my-agent/skills/*.md
  │
  ├─ 目录不存在 → 静默跳过, skill 功能不可用
  ├─ 文件无有效 frontmatter → 跳过该文件, 打印 warn 到 stderr
  ├─ name 重复 → 后发现的覆盖, 打印 warn 到 stderr
  └─ 正常 → 收集到 Map<name, {name, description, path}>

注册 Skill 工具到 defaultRegistry
  name: "Skill"
  parameters.name.enum = 所有已扫描 name
  enum 为空 → 不注册工具, skill 功能静默不可用
```

### 2. 发现阶段

- system prompt 中**不**列出 skill 列表
- LLM 通过 Skill 工具的 enum 参数发现可用 skill
- 工具描述中包含每个 skill 的 name + description，供 LLM 判断何时使用

### 3. 激活阶段

```
LLM 判断某个 skill 适用 → 调用 Skill({ name: "brainstorming" })

handler 执行:
  1. 根据 name 找到文件路径（enum 约束保证 name 一定存在）
  2. fs.readFile(path) → 完整内容（含 frontmatter）
  3. 返回 ToolResult { content, summary: "已激活技能: brainstorming" }

内容作为 tool result 进入 Flow 层:
  [assistant] tool_call: Skill(name="brainstorming")
  [tool]     已激活技能: brainstorming
             # Brainstorming Ideas Into Designs
             ...完整 skill 内容...
  [assistant] 好的，让我先探索项目上下文...
```

### 4. 执行阶段

- Skill 内容是 Flow 层的一条 tool result
- LLM 在每个 round 装配上下文时都能看到
- 如果内容中写了 "完成后调用 xxx skill"，LLM 自行判断时机串联调用
- 多个 skill 的内容可同时存在于 Flow 层，LLM 按优先级自行裁决

### 5. 退出阶段（自然退出）

没有显式 exit 工具。退出由现有 compaction 机制自然处理：

1. LLM 完成任务 → 输出结果给用户
2. 用户发新消息 → 上下文自然往前滚动
3. `compact()` 触发：
   - Phase 1（摘要化）：skill 的 tool result 超过 `recent_rounds` → 内容被摘要替代
   - Phase 2（去重）：重复摘要合并
   - Phase 3（预算强制）：需要时移除最旧的未 pin 消息

最终 skill 内容从上下文中消失，无需额外代码。

## Tool 定义

```typescript
{
  name: "Skill",
  description: `调用一个技能获取特定领域的指导和规范。可用技能:\nbrainstorming - 帮助将想法转化为完整设计文档\nwriting-plans - 编写实现计划\n...`,
  parameters: {
    type: "object",
    properties: {
      name: {
        type: "string",
        enum: ["brainstorming", "writing-plans", ...], // 启动时动态生成
        description: "要激活的技能名称"
      }
    },
    required: ["name"]
  },
  handler: async (params) => {
    const skill = skills.get(params.name);
    const content = await fs.readFile(skill.path, 'utf-8');
    return {
      content,
      summary: `已激活技能: ${skill.name}`,
      exitCode: 0
    };
  }
}
```

## 错误处理

| 场景 | 行为 |
|------|------|
| `.my-agent/skills/` 目录不存在 | 静默跳过，Skill 工具不注册 |
| 目录为空（无 .md 文件） | enum=[]，不注册 Skill 工具 |
| 文件无有效 frontmatter | warn stderr，跳过该文件 |
| name 重复 | warn stderr，后者覆盖前者 |
| LLM 调用不存在的 name | enum 约束保证此情况不出现 |
| 文件被启动后删除 | handler 返回 `isError: true` + 包含文件名的错误信息 |
| 空文件 | 正常返回空 content |

## 边界场景

| 场景 | 行为 |
|------|------|
| skill 内再调用 skill（串联） | 新 skill 内容追加到 Flow 层，多条 skill 指令同时可见 |
| 多次调用同一 skill | 每次都是新的 tool result，LLM 会看到重复内容。Skill 内容中通过自然语言告知 LLM 不要重复调用 |
| 热更新（运行时新增/删除 skill 文件） | 不支持。skill 列表启动时扫描，需重启生效 |
| 子代理使用 skill | 子代理的 ToolRegistry 默认不包含 Skill 工具。如需支持后续扩展 |

## 文件变更清单

### 新建文件

```
src/skills/skill-tool.ts                — 扫描 + Skill 工具注册
src/skills/__tests__/skill-tool.test.ts — 测试
```

### 修改文件

```
bin/my-agent.ts  — 加一行 import '../src/skills/skill-tool.js'
```

### 不变文件

```
src/agent/loop.ts           — 不改
src/context/manager.ts      — 不改
src/tools/registry.ts       — 不改
src/tools/types.ts          — 不改
src/config/types.ts         — 不改
```

## 依赖

无新依赖。

## 测试策略

遵循 TDD 原则：

### 单元测试

| 测试对象 | 覆盖内容 |
|---------|---------|
| 目录扫描 | 正常目录、空目录、目录不存在 |
| frontmatter 解析 | 正常解析、缺失 name、缺失 description、无 frontmatter、格式错误 |
| 工具注册 | enum 正确生成、空列表不注册工具 |
| handler | 正常读取、文件缺失、空文件、大文件、name 重复覆盖 |
| description 拼接 | 多个 skill 时 description 格式正确 |

### 集成测试

| 场景 | 验证点 |
|------|-------|
| 启动不阻塞 | 目录不存在/为空时，Agent 正常启动 |
| 端到端 | LLM 调用 Skill → 内容返回 → LLM 按指令执行 |

## 不在此版本范围内

- 热更新（运行时重载 skill 列表）
- 子代理 skill 支持
- Skill 间显式依赖声明
- Skill 工具/资源声明
- Skill 打包分发/插件化
- 用户全局 skill 目录
