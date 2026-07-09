---
name: vllm-ascend-single-node-service
description: 单节点vLLM-Ascend推理服务启动 — Docker容器部署、NPU设备映射、健康监控、推理验证、错误诊断
---

# 单节点 vLLM-Ascend 推理服务启动

当用户请求启动 vLLM-Ascend 推理服务（如"启动vllm""拉起vllm-ascend""部署vllm推理服务""启动Ascend推理"等类似语义）时，使用本技能。

本技能适用于**单节点**场景。多节点分布式推理不在本技能范围内。

## 核心原则

- **只问必要信息**：仅当用户未提供时才询问镜像名和模型权重路径。端口、NPU设备、vllm参数等使用默认最优配置
- **部署指导优先**：从 `/vllm-workspace` 读取模型对应的 README/deploy 文档，不假设标准启动命令
- **所有 NPU 卡必须可见**：检测宿主机所有 `davinciX` 设备并全部映射进容器
- **错误自动诊断**：任何阶段失败，立即分析原因并报告

## 执行流程

### Phase 1: 收集信息

只问以下两项（用户消息中已提供则跳过）：

1. **Docker 镜像名:tag**（必需）— 如 `vllm-ascend:0.7.3` 或 `registry.example.com/vllm-ascend:latest`
2. **模型权重路径**（必需）— 镜像内路径（如 `/data/models/Qwen3-8B`）或宿主机路径需挂载

**默认配置（不主动询问，仅当用户明确提及时才修改）：**
- 端口：8000
- 所有 NPU 设备自动映射
- vllm 参数根据部署指导选择最优值

### Phase 2: 确保 NPU 设备可见

1. 在宿主机执行 `npu-smi info` 检测 NPU 卡数量：

```bash
npu-smi info -t board -i 0 2>/dev/null | grep -i "Chip Count" || echo "0"
```

若返回 0 → 报错：宿主机未检测到 NPU 设备，无法继续。

2. 确认 NPU 卡数量后，构造 `--device` 参数，确保所有卡及配套设备映射进容器：

```bash
# 对每张卡 i (0..N-1)，添加：
--device=/dev/davinci${i}
# 配套设备（只需一次）：
--device=/dev/davinci_manager
--device=/dev/devmm_svm
--device=/dev/hisi_hdc
```

3. 建议同时挂载 CANN 相关目录（如果宿主机有），方便容器内访问 npu-smi 等工具：

```bash
-v /usr/local/Ascend:/usr/local/Ascend:ro
```

### Phase 3: 查阅部署指导

镜像内的 `/vllm-workspace` 目录通常包含 vllm 和 vllm-ascend 的开源代码仓。模型特定的部署指导（README、部署文档、Dockerfile、启动脚本等）就在其中。

1. **探索代码仓**：启动一个临时容器（不做推理），用 `docker exec` 或 `docker run --rm` 浏览 `/vllm-workspace` 的目录结构，找到与当前模型部署相关的文档和脚本。

   常用的探索方式：
   ```bash
   # 列出 /vllm-workspace 顶层结构
   docker run --rm --entrypoint "" <image>:<tag> ls /vllm-workspace/

   # 或启动临时容器深入查看
   docker run -d --name vllm-temp-inspect --entrypoint "sleep" <image>:<tag> infinity
   docker exec vllm-temp-inspect find /vllm-workspace -name "*.md" -o -name "*.sh" | head -20
   docker rm -f vllm-temp-inspect
   ```

2. **自行判断**：根据探索到的文件内容，自行决定需要读取哪些文档。重点关注与模型部署、启动参数、环境变量相关的部分。

3. **镜像内找不到**：若 `/vllm-workspace` 不存在或内容不完整，询问用户是否本地有 vllm-ascend 代码仓可以直接探索。

4. 从部署指导中提取关键信息：
   - vllm serve 启动命令及参数
   - 模型路径约定
   - 必需的环境变量
   - 推荐配置

### Phase 4: 构造并启动容器

基于收集的信息和部署指导，构造 `docker run` 命令：

```bash
docker run -d \
  --name vllm-ascend \
  --privileged \
  -p 8000:8000 \
  --device=/dev/davinci_manager \
  --device=/dev/devmm_svm \
  --device=/dev/hisi_hdc \
  --device=/dev/davinci${i} \  # 每张 NPU 卡（循环添加所有卡）
  ...（所有 NPU 卡遍历完毕） \
  -v /usr/local/Ascend:/usr/local/Ascend:ro \
  # 若模型权重在宿主机，取消下一行的注释：
  # -v /host/path/models:/data/models:ro \
  <image>:<tag> \
  <vllm serve 启动命令>
```

**启动前：**
1. 将完整的 `docker run` 命令展示给用户确认
2. 如果端口 8000 被占用，自动选择下一个可用端口（8001, 8002...）：

```bash
# 检查端口是否被占用
ss -tlnp | awk '$4 ~ /:8000$/' | grep -q . && echo "port 8000 is in use" || echo "port 8000 is free"
```

**启动后**：
1. 检查容器是否立即退出：
```bash
docker ps -a --filter "name=vllm-ascend" --format "{{.Status}}"
```
2. 若状态为 `Exited`，立即进入 Phase 7 错误诊断

### Phase 5: 监控服务就绪（从宿主机）

服务启动后，轮询健康检查端口：

```bash
# 每 5 秒检查一次，最多 60 次（5 分钟）
for i in $(seq 1 60); do
  if curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/health 2>/dev/null | grep -q "200"; then
    echo "Service is ready (health check passed at attempt $i)"
    break
  fi
  if [ $((i % 10)) -eq 0 ]; then
    echo "Waiting for service... attempt $i/60"
  fi
  if [ "$i" -eq 60 ]; then
    echo "Health check timeout after 5 minutes"
    echo "--- Container logs (last 50 lines) ---"
    docker logs --tail 50 vllm-ascend
    return 1 2>/dev/null || exit 1
  fi
  sleep 5
done
```

如果健康检查超时，查看容器日志中是否有成功启动的标记：

```bash
docker logs vllm-ascend 2>&1 | grep -i -E "(Application startup complete|Uvicorn running|server started)"
```

若日志也无成功标记 → 进入 Phase 7 错误诊断。

### Phase 6: 验证推理

用 curl 从宿主机发送一条简单的 Chat Completions 请求：

```bash
curl -s http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "default",
    "messages": [{"role": "user", "content": "你好，请用一句话介绍你自己。"}],
    "max_tokens": 128
  }'
```

验证标准：
- HTTP 状态码 200
- 响应体包含 `choices` 数组
- `choices[0].message.content` 内容合理（非空、非乱码、语义通顺）

若返回异常 → 进入 Phase 7 错误诊断。

成功时向用户报告：
- 服务已启动，端口 8000
- 容器名 `vllm-ascend`
- NPU 卡数量
- 推理测试结果简要展示（模型回复内容）

### Phase 7: 错误诊断

任何阶段失败时，按以下矩阵定位问题：

| 失败点 | 症状 | 排查动作 |
|--------|------|----------|
| 镜像拉取 | `docker pull` 非零退出 | 检查镜像名拼写、registry 可达性、`docker login` 状态 |
| NPU 缺失 | `npu-smi` 返回 0 芯片 | 报告用户：宿主机未检测到 NPU，无法继续 |
| 容器启动失败 | `docker run` 非零退出或立即 Exited | 检查 `/dev/davinciX` 权限、端口冲突、`--privileged` 是否必需、分析 `docker logs vllm-ascend` |
| 服务启动超时 | 健康检查 5 分钟重试耗尽 | `docker logs --tail 50 vllm-ascend`：排查 OOM-killer、HCCL 初始化错误、驱动版本不匹配、模型文件未找到 |
| 推理返回异常 | curl 返回非 200 或无 choices | 检查 vllm 服务日志、验证模型路径容器内是否存在、在容器内执行 `npu-smi info` 确认 NPU 可见 |

**通用排查命令：**

```bash
# 查看完整容器日志
docker logs vllm-ascend 2>&1 | tail -100

# 检查容器内 NPU 是否可见
docker exec vllm-ascend npu-smi info 2>/dev/null || echo "npu-smi not available in container"

# 检查容器内模型路径
docker exec vllm-ascend ls <模型路径> 2>/dev/null || echo "Model path not found"

# 进入容器交互排查
docker exec -it vllm-ascend /bin/bash
```

将诊断结果和容器日志关键报错行展示给用户，给出明确的修复建议。不要只说"报错了"，要指出具体原因和解决方案。

## 注意事项

- 仅适用于**单节点** Ascend NPU 推理，不涉及多机分布式
- 需要使用 `--privileged` 模式以确保 NPU 设备访问权限
- 模型权重路径必须确保容器内可访问（镜像内置或挂载）
- 第一次启动可能因为镜像拉取和模型加载耗时较长，给足够的时间等待
