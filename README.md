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

在 `~/.my_agent/config.json` 创建配置文件：

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

### 验证安装

启动 CLI 交互式对话：

```bash
npm start
```
