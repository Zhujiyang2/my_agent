# My Agent

终端交互式 AI 对话助手。

## 安装

### 前置要求

- **Node.js** >= 18

### 步骤

```bash
# 1. 克隆仓库
git clone <repo-url>
cd my-agent

# 2. 安装依赖
npm install
```

## 配置

所有配置文件位于项目根目录的 `.my_agent/` 目录下（已加入 `.gitignore`，不会提交到仓库）。

### 目录结构

```
.my_agent/
├── config.json             # API 配置（必需）
├── mcp.json                # MCP 服务器配置（可选）
├── sandbox-domains.json    # 沙箱网络域名配置（可选）
├── memory/                 # Memory 存储（自动维护）
└── tavily-mcp-server/      # MCP Tavily server 依赖（npm install）
```

### config.json（必需）

```json
{
  "api_url": "https://api.openai.com/v1",
  "model": "gpt-4o",
  "api_key": "sk-your-api-key"
}
```

| 字段 | 说明 |
|------|------|
| `api_url` | OpenAI 兼容 API 地址 |
| `model` | 模型 ID |
| `api_key` | API 密钥 |

支持任意 OpenAI 兼容接口（OpenAI、Ollama、vLLM 等），只需修改以上三个字段。

### mcp.json（可选）

配置 MCP（Model Context Protocol）服务器，用于扩展工具能力。

```json
{
  "mcpServers": {
    "tavily": {
      "transport": "streamable-http",
      "url": "https://mcp.tavily.com/mcp/",
      "headers": {
        "Authorization": "Bearer <your-tavily-api-key>"
      },
      "connectTimeoutMs": 30000,
      "idleTimeoutMs": 300000
    }
  }
}
```

| 字段 | 说明 |
|------|------|
| `mcpServers.<name>.transport` | 传输类型：`stdio`、`sse`、`streamable-http` |
| `mcpServers.<name>.url` | 服务器 URL（sse/streamable-http） |
| `mcpServers.<name>.command` | 启动命令（stdio） |
| `mcpServers.<name>.args` | 命令参数（stdio） |
| `mcpServers.<name>.headers` | HTTP 请求头 |
| `mcpServers.<name>.connectTimeoutMs` | 连接超时（毫秒，默认 30000） |
| `mcpServers.<name>.idleTimeoutMs` | 空闲超时（毫秒，默认 300000） |
| `mcpServers.<name>.disabled` | 是否禁用该服务器 |

### sandbox-domains.json（可选）

控制沙箱的网络访问策略（文件不存在时允许所有域名）。

```json
{
  "extra_allowed_domains": ["example.com"],
  "blocked_domains": ["malware.com"]
}
```

### 安装 tavily-mcp-server

```bash
mkdir -p .my_agent/tavily-mcp-server
cd .my_agent/tavily-mcp-server
npm install tavily-mcp
```

### 验证安装

启动 CLI 交互式对话：

```bash
npm start
```
