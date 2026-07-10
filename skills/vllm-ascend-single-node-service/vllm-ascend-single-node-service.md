---
name: vllm-ascend-single-node-service
description: 单节点vLLM-Ascend推理服务启动 — Docker容器部署、NPU设备映射、健康监控、推理验证、错误诊断
---

# 单节点 vLLM-Ascend 推理服务启动

当用户请求启动 vLLM-Ascend 推理服务（如"启动vllm""拉起vllm-ascend""部署vllm推理服务""启动Ascend推理"等类似语义）时，使用本技能。

本技能适用于**单节点**场景。多节点分布式推理不在本技能范围内。

## 核心原则

- **只问必要信息**：仅当用户未提供时才询问镜像名和模型权重路径。其余使用默认最优配置，不主动询问额外参数
- **部署指导优先**：优先从容器内 `/vllm-workspace` 探索 vllm/vllm-ascend 源码仓的部署文档；若镜像内没有代码仓，则根据自己的知识构造启动命令
- **所有 NPU 卡必须可见**：检测宿主机所有 `davinciX` 设备并全部映射进容器（包括配套设备 `davinci_manager`、`devmm_svm`、`hisi_hdc`）
- **错误自动诊断**：任何阶段失败，立即分析 `docker logs`、容器状态、NPU 可见性等，给出具体原因和修复建议

## 执行流程

### Phase 1: 收集信息

只问以下两项（用户消息中已提供则跳过）：
1. Docker 镜像名:tag
2. 模型权重路径（镜像内路径或宿主机挂载路径）

默认端口 8000。仅当用户明确提及时才修改。

### Phase 2: 确保 NPU 设备可见

用 `npu-smi` 检测宿主机 NPU 卡数量。若为 0 → 报错终止。

将所有 `davinciX` 卡及配套设备（`davinci_manager`、`devmm_svm`、`hisi_hdc`）通过 `--device` 映射进容器。建议挂载 `/usr/local/Ascend` 以复用宿主 CANN 工具。

### Phase 3: 查阅部署指导

探索容器内 `/vllm-workspace` 目录（vllm/vllm-ascend 源码仓），自行判断需要读取哪些部署文档。

若镜像内没有代码仓，根据自己的知识构造启动命令。不要询问用户。

关注：vllm serve 命令、模型路径约定、环境变量、推荐参数。

### Phase 4: 构造并启动容器

基于前述信息构造 `docker run -d` 命令（需 `--privileged`）。**启动前将完整命令展示给用户确认**。

端口冲突时自动选择下一个可用端口。启动后立即检查容器是否退出，若 `Exited` 则直接进入 Phase 7。

### Phase 5: 监控服务就绪（从宿主机）

轮询 `curl http://localhost:<port>/health`，每 5 秒一次，最长等 5 分钟。每 10 次输出进度。

超时则检查 `docker logs` 中是否有 "Application startup complete" / "Uvicorn running" 等标记。无标记 → Phase 7。

### Phase 6: 验证推理

从宿主机 `curl /v1/chat/completions` 发送一条简单请求，验证：HTTP 200、响应含 `choices`、回复内容合理（非空非乱码）。

成功时向用户报告：服务端口、容器名、NPU 卡数、模型回复内容。

异常 → Phase 7。

### Phase 7: 错误诊断

任何阶段失败，按以下方向排查并给出**具体原因和解决方案**（不要只说"报错了"）：

| 失败点 | 排查方向 |
|--------|----------|
| 镜像拉取失败 | 镜像名、registry 可达性、`docker login` 状态 |
| NPU 缺失 | 宿主机无 NPU，无法继续 |
| 容器启动失败 | `/dev/davinciX` 权限、端口冲突、`docker logs` |
| 服务启动超时 | 容器日志：OOM、HCCL 错误、驱动版本、模型路径 |
| 推理异常 | vllm 日志、容器内模型路径是否存在、容器内 NPU 是否可见 |
