# Sandbox Network Isolation — 设计规格

## 1. 背景

当前沙箱使用 `bwrap --share-net`，Agent 直接共享宿主机网络栈。在启用了 Tavily MCP（沙箱外工具可访问任意 URL）的场景下，沙箱内实际需要的出站网络是有限的、可预测的：

| 沙箱内需求 | 域名 |
|-----------|------|
| Docker 镜像拉取 | `docker.io`, `registry-1.docker.io`, `quay.io` |
| 模型权重下载 | `huggingface.co`, `hf.co`, `cdn-lfs.huggingface.co`, `modelscope.cn` |
| Python 包安装 | `pypi.org`, `files.pythonhosted.org` |
| 代码克隆 | `github.com`, `raw.githubusercontent.com` |
| Node 包安装 | `registry.npmjs.org` |
| 用户自定义 | 通过配置追加 |

Tavily 搜索/网页抓取由 MCP 工具在沙箱外完成，不需要沙箱内直接访问任意外网。

**目标**：将沙箱从 `--share-net` 改为 `--unshare-net` + 域名白名单代理，在保留必要网络能力的同时防止 prompt injection 导致的数据外传。

## 2. 架构

```
宿主机 (Host)
┌───────────────────────────────────────────────────────────┐
│  ┌─────────────────────┐                                  │
│  │  ProxyServer         │  域名白名单 + 确认回调            │
│  │  监听 Unix socket:   │  docker.io ✓                    │
│  │  /tmp/agent-proxy    │  quay.io ✓                      │
│  │                      │  huggingface.co ✓               │
│  │  日志审计             │  modelscope.cn ✓                │
│  └──────────┬──────────┘  pypi.org ✓                      │
│             │              github.com ✓                    │
│             │              unknown → onConfirm 回调         │
│  ═══════════╪════════════ bwrap namespace ═══════════════ │
│             │ (--bind mount)                               │
│  ┌──────────▼──────────┐                                   │
│  │  socat               │  TCP → Unix socket 转发          │
│  │  TCP:19877 →         │                                   │
│  │  /tmp/agent-proxy    │                                   │
│  └──────────┬──────────┘                                   │
│             │                                              │
│  ┌──────────▼──────────┐                                   │
│  │  沙箱内进程            │                                  │
│  │  HTTP_PROXY=          │                                  │
│  │  http://127.0.0.1:19877│                                │
│  │  HTTPS_PROXY=         │                                  │
│  │  http://127.0.0.1:19877│                                │
│  └──────────────────────┘                                  │
│                                                            │
│  Docker socket ─── Unix socket, 不受 --unshare-net 影响     │
│  NPU devices ─── 设备文件, 不受 --unshare-net 影响           │
│  Tavily MCP    ─── 沙箱外, 不受限制                         │
└───────────────────────────────────────────────────────────┘
```

## 3. 模块设计

### 3.1 代理服务器 (net-proxy.ts)

```
export interface ProxyConfig {
  allowedDomains: string[];     // 白名单域名（支持 *.example.com 通配符）
  blockedDomains: string[];     // 黑名单（优先级高于白名单）
  onConfirm?: (domain: string) => Promise<boolean>;  // 未知域名确认回调
  logAccess: (entry: AccessLogEntry) => void;         // 审计日志
}

export interface AccessLogEntry {
  domain: string;
  timestamp: number;
  method: string;
  path: string;
  allowed: boolean;
  bytesSent: number;
}
```

- 监听 Unix domain socket (`/tmp/my-agent-proxy.sock`)
- HTTP CONNECT 隧道（支持 HTTPS 流量）
- 域名匹配优先级：黑名单 > 白名单 > onConfirm
- 支持 `*.example.com` 通配符匹配
- 每次请求记录审计日志

### 3.2 bwrap-executor 变更

在现有 bwrap 命令构造中：

1. `--share-net` → `--unshare-net`
2. 新增 `--bind /tmp/my-agent-proxy.sock /tmp/my-agent-proxy.sock`（透传代理 socket）
3. 命令包装：在目标命令前启动 socat 转发，注入代理环境变量

包装后的命令结构：

```
sh -c '
  socat TCP-LISTEN:19877,fork,reuseaddr UNIX-CONNECT:/tmp/my-agent-proxy.sock &
  SOCAT_PID=$!
  export HTTP_PROXY=http://127.0.0.1:19877
  export HTTPS_PROXY=http://127.0.0.1:19877
  export http_proxy=http://127.0.0.1:19877
  export https_proxy=http://127.0.0.1:19877
  <原始命令>
  EXIT_CODE=$?
  kill $SOCAT_PID 2>/dev/null
  exit $EXIT_CODE
'
```

### 3.3 sandbox-manager 变更

- `createSandboxManager` 时创建代理实例并启动
- `execute` 流程不变（docker 校验 → bwrap 执行）
- 代理生命周期随 sandbox-manager 的销毁而关闭

### 3.4 如果 socat 不可用

- 启动时检测 `socat` 可用性
- 如果 socat 不存在且 `fallback_to_warn: true`：回退到 `--share-net` + 警告
- 如果 socat 不存在且 `fallback_to_warn: false`：拒绝启动

## 4. 配置

`~/.my_agent/config.json`：

```json
{
  "sandbox": {
    "enabled": true,
    "engine": "bwrap",
    "network": {
      "extra_allowed_domains": [
        "mirrors.aliyun.com",
        "my-registry.internal.io"
      ],
      "blocked_domains": [
        "pastebin.com",
        "termbin.com"
      ]
    },
    "extra_protect_paths": [],
    "fallback_to_warn": true
  }
}
```

新增 `SandboxNetworkConfig`：

```typescript
export interface SandboxNetworkConfig {
  extra_allowed_domains: string[];
  blocked_domains: string[];
}
```

默认值：

```typescript
const DEFAULT_NETWORK_CONFIG: SandboxNetworkConfig = {
  extra_allowed_domains: [],
  blocked_domains: [],
};
```

## 5. 内置白名单

```
docker.io
registry-1.docker.io
quay.io
huggingface.co
hf.co
cdn-lfs.huggingface.co
modelscope.cn
*.modelscope.cn
pypi.org
files.pythonhosted.org
github.com
raw.githubusercontent.com
registry.npmjs.org
```

## 6. 文件清单

| 操作 | 文件 | 内容 |
|------|------|------|
| 新增 | `src/sandbox/net-proxy.ts` | 代理服务器 |
| 新增 | `src/sandbox/__tests__/net-proxy.test.ts` | 代理测试 |
| 修改 | `src/sandbox/types.ts` | SandboxConfig 增加 network 字段 |
| 修改 | `src/sandbox/bwrap-executor.ts` | --unshare-net、socat 转发、环境变量 |
| 修改 | `src/sandbox/sandbox-manager.ts` | 代理生命周期 |
| 修改 | `src/config/types.ts` | SandboxNetworkConfig 类型 |
| 修改 | `src/config/loader.ts` | 解析 network 配置 |
| 修改 | `bin/my-agent.ts` | 初始化代理，注入 onConfirm 回调 |

## 7. 测试策略

| 层级 | 测试内容 |
|------|---------|
| net-proxy 单元测试 | 白名单匹配（精确 + 通配符）、黑名单优先、CONNECT 隧道 |
| bwrap-executor 单元测试 | --unshare-net 参数、socat 命令生成、环境变量注入 |
| sandbox-manager 集成测试 | 代理启动/停止、execute 流程 |
| 环境验证 | 沙箱内 docker pull / pip install / wget 白名单域名成功、被拒域名失败 |

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| socat 不可用（某些精简 Linux 发行版） | `fallback_to_warn` 回退到 `--share-net` |
| 白名单不完整导致训推任务中断 | 用户可通过 `extra_allowed_domains` 追加；错误日志明确指出被拒域名 |
| prompt injection 通过 Tavily MCP 外传数据 | Tavily 在沙箱外运行，不受网络限制影响；文件系统保护（protect 列表）阻止读取凭证文件 |
| 代理进程崩溃 | sandbox-manager 在 execute 前检查代理是否存活，不可用时回退 |
| DNS 泄露（域名解析） | 不在本阶段处理——bwrap 默认继承宿主机 /etc/resolv.conf，DNS 查询走宿主机 |
