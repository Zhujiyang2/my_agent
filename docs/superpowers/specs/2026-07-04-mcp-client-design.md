# MCP Client 功能设计

## 概述

为 Agent 新增 MCP Client 能力，使其能连接外部 MCP Server，按需发现并调用其提供的 Tool/Resource。

## 核心原则

- **纯按需加载**：启动时仅解析配置，不连接任何 MCP Server
- **LLM 自主决策**：由 LLM 决定何时连接哪个 server、调用哪个工具
- **透明重连**：工具调用时自动确保连接可用，对 LLM 无感

## 配置文件

位置：`~/.my_agent/mcp.json`

文件不存在时跳过（不报错），MCP 功能静默不可用。

```json
{
  "mcpServers": {
    "tavily": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic/tavily-mcp"],
      "env": { "TAVILY_API_KEY": "xxx" }
    },
    "remote-db": {
      "transport": "sse",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer xxx" },
      "idleTimeoutMs": 600000
    }
  }
}
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `transport` | `"stdio"` \| `"sse"` | 是 | 传输方式 |
| `command` | string | stdio 必填 | 启动命令 |
| `args` | string[] | 否 | 命令参数 |
| `env` | Record<string,string> | 否 | 环境变量 |
| `url` | string | sse 必填 | MCP Server 地址 |
| `headers` | Record<string,string> | 否 | HTTP 请求头 |
| `idleTimeoutMs` | number | 否 | 空闲超时（ms），默认 300000（5分钟）|

## 系统架构

```
~/.my_agent/mcp.json
        │
        ▼
  MCPConfigLoader.load() → McpConfig
        │
        ▼
  MCPManager (单例, src/mcp/manager.ts)
        │
        ├─ MCPConnection["tavily"]    (src/mcp/connection.ts)
        │    ├─ transport: StdioClientTransport
        │    ├─ client: Client (@modelcontextprotocol/sdk)
        │    ├─ schemas: ToolSchema[] (connect 后缓存)
        │    └─ state: idle | connected | failed
        │
        ├─ MCPConnection["remote-db"]
        │    ├─ transport: SSEClientTransport
        │    └─ ...
        │
        └─ 工具注册 (通过 defaultRegistry)
              ├─ mcp_list_servers    (始终注册)
              ├─ mcp_connect         (始终注册)
              └─ mcp__<server>__<tool>  (connect 后动态注册)
```

## 文件结构

```
src/mcp/
├── config.ts         # MCP 配置加载 + 类型
├── connection.ts     # MCPConnection: 单连接生命周期
├── manager.ts        # MCPManager: 多连接管理 + 工具注册
└── __tests__/
    ├── config.test.ts
    ├── connection.test.ts
    └── manager.test.ts
```

## 核心流程

### 启动

```
1. MCPManager.initialize(mcpConfig)
2. 解析 mcp.json，创建 MCPConnection 对象（不连接）
3. 注册 2 个管理工具到 defaultRegistry:
   - mcp_list_servers
   - mcp_connect
```

### 连接 + 发现

```
LLM 调用 mcp_connect({ server: "tavily" })
  → MCPManager.connect("tavily")
    → connection.connect()
      → new StdioClientTransport(...)
      → Client.connect(transport)
      → client.request({ method: "initialize", ... })
      → client.request({ method: "tools/list", ... })
      → client.request({ method: "resources/list", ... })
      → 缓存 ToolSchema[]
    → 遍历 ToolSchema，注册到 defaultRegistry:
      名称: mcp__tavily__search → handler 内嵌懒连接逻辑
      名称: mcp__tavily__extract → 同上
      ...
    → 启动空闲超时计时器
    → 返回已注册的工具列表
```

### 工具调用

```
LLM 调用 mcp__tavily__search({ query: "..." })
  → handler:
    conn = manager.getConnection("tavily")
    if conn.state !== 'connected':
      conn.connect()  // 透明重连
    result = conn.callTool("search", { query: "..." })
    return { content: result.content, summary: ..., exitCode: 0 }
  → 重置空闲计时器
```

### 空闲超时

```
每次 tools/call → 重置计时器
计时器触发 → connection.disconnect()（不注销已注册工具）
下次调用 → 自动重连
```

## 模块设计

### MCPConnection

```typescript
interface MCPConnection {
  readonly name: string;
  readonly config: McpServerConfig;
  readonly state: 'idle' | 'connected' | 'failed';

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  readResource(uri: string): Promise<string>;
  listTools(): ToolSchema[];    // 返回缓存的 schema（需 connected）
  listResources(): ResourceSchema[];
}
```

- 使用 `@modelcontextprotocol/sdk` 的 `Client`
- `StdioClientTransport` 用于 stdio
- `SSEClientTransport` 用于 HTTP SSE
- 连接失败时状态标记为 `failed`，返回描述性错误信息

### MCPManager

```typescript
interface MCPManager {
  initialize(config: McpConfig): void;
  connect(serverName: string): Promise<McpConnectResult>;
  disconnect(serverName: string): Promise<void>;
  listServers(): McpServerStatus[];
  getConnection(name: string): MCPConnection | undefined;
}
```

- 单例模式，参照 `SubagentManager` 的实现
- `connect()` 返回已注册的工具列表，供 LLM 了解新增了哪些工具
- `listServers()` 返回配置中所有 server 及其当前状态

### 工具定义

#### mcp_list_servers

```
description: 列出所有配置的 MCP server 及其连接状态
parameters: 无
```

返回示例：
```
MCP Servers:
  tavily — connected, 3 tools available
  filesystem — idle (not connected)
  remote-db — error: connection refused
```

#### mcp_connect

```
description: 连接到指定的 MCP server 并发现其工具
parameters:
  server (string, required): MCP server 名称，与 mcp.json 中配置一致
```

返回示例：
```
Connected to tavily. Registered 3 tools:
  mcp__tavily__search — Search the web
  mcp__tavily__extract — Extract content from URLs
  mcp__tavily__crawl — Crawl a website
```

#### mcp__\<server\>__\<tool\>

动态注册的 MCP 工具，handler 内置懒连接逻辑：
1. 检查连接状态
2. 未连接则自动重连
3. 调用 `MCPConnection.callTool()`
4. 将 MCP 返回结果转换为 `ToolResult` 格式
5. 重置空闲计时器

## 子代理集成

- `spawn_agent` 支持在 `tools` 参数中指定 MCP 工具：
  - 精确指定：`"mcp__tavily__search"`
  - 通配符：`"mcp:tavily"` 表示该 server 所有已注册工具
- 子代理的 MCP 工具 handler 复用 MCPManager 的连接池
- 子代理终结不影响 MCP 连接（连接池生命周期由主 Agent 管理）

## 错误处理

| 场景 | 行为 |
|------|------|
| `mcp.json` 文件不存在 | 静默跳过，MCP 功能不可用 |
| `mcp.json` 格式错误 | 打印警告到 stderr，MCP 功能不可用 |
| 单个 server 配置无效 | 跳过该 server，不影响其他 server |
| `mcp_connect` 连接失败 | 返回错误信息，状态标记为 `failed` |
| `tools/call` 时连接断开 | 自动重连一次，仍失败则返回错误给 LLM |
| MCP Server 返回 error | 包装为 `ToolResult`（isError: true），触发 auto-pin |
| 子代理指定了未连接的 MCP 工具 | 自动触发 connect |

## 依赖

- `@modelcontextprotocol/sdk` — 新引入的唯一依赖

## 测试策略

遵循 TDD 原则：

1. **config.test.ts** — 配置加载、格式校验、文件不存在
2. **connection.test.ts** — 连接生命周期、connect/disconnect、callTool、空闲超时、重连。使用 mock MCP server（本地起的简单 stdio 进程）
3. **manager.test.ts** — 多 server 管理、工具注册/注销、listServers、并发连接

## 不会做的

- 不实现 MCP Server 端（不与外部共享本 Agent 的工具）
- 不实现 Prompt 模板支持（当前阶段仅 Tool 和 Resource）
- 不实现 Resource 暴露工具（connection 层保留 `readResource()` 接口，但不注册为 LLM 可调用工具，后续按需扩展）
- 不实现 `mcp_disconnect` 工具（管理工具仅 list + connect，连接通过空闲超时自动回收）
- 不持久化工具注册状态到磁盘
