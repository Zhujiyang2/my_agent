# Sandbox Isolation — 设计规格

## 1. 背景与动机

My Agent 是一个终端交互式 AI 编程助手，主要运行在 Linux 环境中。核心任务场景是 **模型训推**——包括拉取镜像/权重、启动容器、运行训推命令（vllm 等）、做模型评测。Agent 在大量无人值守 / 自动化场景下运行。

目前 Agent 通过 `run_command` 工具直接在宿主机上执行 Shell 命令，仅靠模式匹配检测"高风险命令"。这种方案在无人值守场景下不够可靠——LLM 可以变通写法绕过模式匹配。

**目标**：引入内核级沙箱隔离，确保 Agent 无法破坏宿主机文件系统，同时保留其编排 Docker 容器和访问网络的能力。

## 2. 核心设计：两层隔离模型

```
┌──────────────────────────────────────────────────────────┐
│ Layer 1: Agent 沙箱 (bwrap mount namespace)               │
│                                                          │
│  约束 Agent 在宿主机上能读写哪些文件。                      │
│  整系统只读挂载，protect 列表屏蔽敏感路径，                │
│  工作区运行时动态注册为可写。                               │
│                                                          │
│  宿主机 /                    → 只读 (--ro-bind)           │
│  宿主机 /tmp                 → tmpfs 可读写                │
│  宿主机 /dev                 → 可访问 (GPU 设备)           │
│  宿主机 /var/run/docker.sock → 可访问 (编排容器)           │
│  宿主机 ~/.ssh, ~/.aws ...   → 不可见 (protect 列表)      │
│  宿主机 动态工作区             → 可读写 (运行时注册)        │
└──────────────────────────────────────────────────────────┘
                          │
                          │ docker run -v /host/path:/container/path
                          ▼
┌──────────────────────────────────────────────────────────┐
│ Layer 2: Docker 容器 (Docker 原生隔离)                    │
│                                                          │
│  容器内部文件系统由 Docker 管理，不受 Agent 沙箱约束。      │
│  唯一交集：docker -v 挂载的宿主机路径必须通过校验。         │
│                                                          │
│  容器内 /etc                → 镜像层 (只读)               │
│  容器内 /usr, /opt, /app... → overlay 上层 (可读写)       │
│  容器内 /models             → -v 挂载 (可读写)            │
│                                                          │
│  -v 宿主机路径校验：                                       │
│    ✓ 路径在 writable 名单内 或 为系统普通路径(如/etc/...) │
│    ✗ 路径在 protect 名单内                                │
│    ✗ 路径为 / 或整个家目录等越权挂载                       │
└──────────────────────────────────────────────────────────┘
```

### 为什么选 Bubblewrap（bwrap）而非 Docker 沙箱

Agent 本身就是 Docker 编排者——它需要操作 Docker daemon。如果 Agent 自身也跑在容器里，会陷入 Docker-in-Docker 的路径映射噩梦（容器内路径 vs 宿主机路径不一致）。bwrap 仅做 mount namespace 隔离，Agent 进程仍在宿主机上，Docker socket 通信不受影响。

### 为什么用 protect list 而非 allowlist

Agent 不预先知道各机器的磁盘布局（权重可能下到 `/mnt/nvme0`、`/data/ssd` 或用户口头指定的任意路径）。因此不能预先框定"只能访问哪些路径"。反向思路：全部只读可见，只屏蔽真正危险的凭证路径。

## 3. 路径策略

### 3.1 三类路径

| 类型 | 权限 | 定义方式 | 典型路径 |
|------|------|----------|----------|
| **protect** | 不可见 | 硬编码 + 可配置追加 | `~/.ssh`, `~/.aws`, `~/.kube`, `/root`, `/etc/shadow`, `/etc/ssl/private` |
| **explore** | 只读 | 整个 `/` 文件系统（隐式） | `/usr`, `/etc`, `/mnt`, `/data`, `/opt`, `/home/*` |
| **writable** | 可读写 | 运行时动态注册 | `$WORKSPACE/**`, `/tmp/**`（tmpfs） |

### 3.2 protect 列表（文件级精确屏蔽）

```
~/.ssh/*                     # SSH 私钥
~/.aws/credentials           # AWS 凭证
~/.kube/config               # Kubernetes 凭证
~/.gitconfig                 # 可能含 token
~/.docker/config.json        # Docker Hub 凭证
~/.config/gcloud/*           # GCP 凭证
/etc/shadow                  # 密码哈希
/etc/ssl/private/*           # 证书私钥
/root/*                      # Root 家目录
/proc/sys                    # 内核参数
/sys/kernel                  # 内核配置
```

注意：`/etc` **不**在 protect 中——Docker 容器经常需要挂载 `/etc/localtime`、`/etc/hosts` 等系统配置，这些路径只读可见。

### 3.3 writable 动态注册

Agent 在探索阶段发现可用存储空间后，调用 `register_writable_path` 工具显式声明工作区。该工具触发以下流程：

1. **校验**：目标路径不在 protect 名单中，不在系统关键路径中（`/etc`、`/boot`、`/sys`、`/proc`）
2. **注册**：路径加入 writable 列表
3. **重建**：bwrap 实例重建，新增对应的 `--bind` 挂载，使该路径可读写

注册后的路径同时获得：
1. 宿主机层面可读写（bwrap `--bind`）
2. `docker -v` 挂载校验放行

## 4. 工作流

### Phase 1 — Discovery（探索阶段）

Agent 在只读沙箱中探索磁盘布局：

```
$ df -h                    ← ✓ 只读，正常返回
$ ls /mnt/                 ← ✓ 只读
$ cat /etc/os-release      ← ✓ 只读
$ cat ~/.ssh/id_rsa        ← ✗ protect，文件不可见
$ ls /root/                ← ✗ protect，目录不可见
```

Agent 从 `df -h` / `mount` 输出中发现 `/mnt/nvme0` 有 2TB 可用空间。

### Phase 2 — Claim（注册工作区）

Agent 在探索阶段发现可用存储后，调用 `register_writable_path` 工具显式声明工作区：

1. Agent 调用 `register_writable_path("/mnt/nvme0/my-agent-workspace")`
2. Sandbox-manager 校验该路径不在 protect 名单中
3. 路径加入 writable 列表
4. bwrap 实例重建，新增 `--bind /mnt/nvme0/my-agent-workspace /mnt/nvme0/my-agent-workspace`

> **设计决策**：不采用"自动注册"机制。因为 bwrap 以只读挂载整个根文件系统，Agent 在路径被 `--bind` 暴露之前无法对其进行任何写操作（包括 mkdir）。显式注册避免了鸡生蛋问题，同时给 Agent 一个清晰的语义："我要在这里工作了"。

### Phase 3 — Execute（正常执行）

Agent 在沙箱中执行完整任务流：下载权重、拉取镜像、启动容器、运行训推命令。

## 5. Docker Mount 校验器

每次 Agent 执行 `docker run`（或 `docker create`）时，校验器解析 `-v` / `--mount` 参数中的宿主机路径：

```
校验规则：
  1. 提取 -v HOST_PATH:CONTAINER_PATH 中的 HOST_PATH
  2. HOST_PATH 在 protect 名单中       → ✗ 阻止
  3. HOST_PATH 在 writable 名单中      → ✓ 放行
  4. HOST_PATH 是系统常用路径(/etc/...)→ ✓ 放行（只读可见，无安全隐患）
  5. 其余情况                          → ✗ 阻止
```

## 6. 模块架构

新模块放在 `src/sandbox/` 下，不影响现有模块：

```
src/sandbox/
├── types.ts            # SandboxConfig, WritableRegistration 等类型
├── bwrap-executor.ts   # 构造 bwrap 命令行并执行
├── path-policy.ts      # protect 列表管理 + 路径分类判定
├── docker-validator.ts # docker run -v 参数解析与校验
├── sandbox-manager.ts  # 对外暴露的统一入口
└── __tests__/
    ├── path-policy.test.ts
    ├── bwrap-executor.test.ts
    ├── docker-validator.test.ts
    └── sandbox-manager.test.ts
```

### 6.1 各模块职责

**path-policy.ts**
- 维护 protect 列表（硬编码 + 用户可配置追加）
- 维护 writable 列表（运行时动态增删）
- 提供 `classify(path) → 'protect' | 'writable' | 'explore'`

**bwrap-executor.ts**
- 接收命令字符串 + 路径策略
- 构造 bwrap 命令：
  ```
  bwrap \
    --ro-bind / / \
    --tmpfs /tmp \
    --dev /dev \
    --bind /var/run/docker.sock /var/run/docker.sock \
    --bind <writable-path> <writable-path> \
    --unshare-pid \
    --share-net \
    -- <command>
  ```
- 自动跳过 protect 路径的 bind mount
- 如果 bwrap 不可用，降级为只读警告模式（保留现有高风险检测）

**docker-validator.ts**
- 解析 `docker run` / `docker create` 命令字符串中的 `-v` / `--mount` 参数
- 对照 path-policy 判定每个宿主机路径是否合法
- 不合法时返回具体拦截原因（给 LLM 或用户）

**sandbox-manager.ts**
- 统一入口：`SandboxManager.execute(command, options)`
- 内部流程：Docker 越权校验 → bwrap 包装 → 执行
- 暴露 `registerWritable(path)` 和 `unregisterWritable(path)` 供 `register_writable_path` 工具调用

### 6.2 与现有系统的集成

```
run_command tool handler
    │
    ├── 现有逻辑：高风险命令检测（保留为降级方案）
    │
    └── 新增：沙箱通道
         │
         SandboxManager.execute(command)
           ├──· 非 docker 命令 → bwrap 包装执行
           ├──· docker 命令   → docker-validator 校验 → bwrap 包装执行
           └──· bwrap 不可用  → 降级到现有模式（warn）
```

### 6.3 暴露给 Agent 的新工具

| 工具名 | 功能 | 关键参数 |
|--------|------|----------|
| `register_writable_path` | 注册工作区为可读写 | `path`（宿主机绝对路径） |

Agent 在探索后调用此工具声明工作区，sandbox-manager 校验路径后重建 bwrap 实例使该路径可写。`run_command` 的行为变化（进入沙箱执行）对 LLM 是透明的。

## 7. 配置

在 `~/.my_agent/config.json` 中新增 `sandbox` 段：

```json
{
  "sandbox": {
    "enabled": true,
    "engine": "bwrap",
    "extra_protect_paths": [
      "/opt/secrets",
      "/data/private"
    ],
    "fallback_to_warn": true
  }
}
```

| 字段 | 默认值 | 说明 |
|------|--------|------|
| `enabled` | `true` | 是否启用沙箱 |
| `engine` | `"bwrap"` | 沙箱引擎（当前仅 bwrap） |
| `extra_protect_paths` | `[]` | 用户自定义追加的 protect 路径 |
| `fallback_to_warn` | `true` | bwrap 不可用时降级为现有 warn 模式 |

## 8. 待验证项（环境验证时关注）

1. **GPU 设备透传**：bwrap 中 `--dev /dev` 能否正常访问 `/dev/nvidia*`，容器内 CUDA 是否正常工作
2. **Docker socket 权限**：bwrap namespace 内能否正常与 Docker daemon 通信
3. **bwrap + Docker -v 路径映射**：宿主机路径通过 bwrap 的 `--bind` 挂载后，Docker `-v` 指定的宿主机路径是否正确解析
4. **网络模型下载**：bwrap `--share-net` 下 `huggingface-cli download`、`wget` 等是否正常工作
5. **bwrap 可用性**：目标 Linux 发行版（Ubuntu 20.04/22.04、CentOS 7/8、Debian 等）是否内置 bwrap
6. **嵌套 bwrap**：Docker 容器内的进程是否会再被 bwrap 包装（不应发生——Docker 内命令由容器内 Shell 执行，不经 agent 的 sandbox-manager）
7. **性能**：bwrap 对 I/O 密集型操作（下载权重、读写模型文件）的性能影响

## 9. 测试策略

遵循 TDD 原则，先写测试再实现：

| 测试范围 | 测试内容 |
|----------|----------|
| path-policy | protect 列表匹配、writable 注册/注销、路径分类边界条件 |
| bwrap-executor | bwrap 命令行参数生成、bwrap 可用性检测、降级行为 |
| docker-validator | `-v` 参数解析、`--mount` 参数解析、路径合法性校验 |
| sandbox-manager | 完整执行流程、docker 命令拦截、writable 注册/注销行为 |
| 集成测试 | 真实 bwrap 沙箱中执行命令、文件系统隔离验证 |

## 10. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| bwrap 在目标环境不可用 | `fallback_to_warn` 降级到现有模式 |
| protect 列表不完整遗漏凭证路径 | 允许用户通过 `extra_protect_paths` 自定义追加 |
| Docker -v 校验被绕过（如 `--mount` 语法） | 覆盖 `-v`、`--mount`、`--volume` 三种写法 |
| `register_writable_path` 被 LLM 滥用以注册敏感路径 | 注册前校验路径不在 protect 名单中；不在 `/etc`、`/boot`、`/sys` 等系统关键路径中 |
| bwrap 影响训推性能 | `--share-net` 不隔离网络栈、不设 cgroup 限制、只做 mount namespace |
