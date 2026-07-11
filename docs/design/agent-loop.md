# Agent Loop 设计

## 一句话

Agent 把耗时命令丢到后台继续工作，命令跑完后结果自动注入对话，大模型在后续轮次自然看到。

## 异步执行链路

当大模型决定执行 `run_command("python train.py")`，一条命令经过四层接力，最终结果异步回到对话中：

```
大模型说：跑 python train.py
        │
  ① 工具层   检查参数 → 如有 sandbox 就包一层隔离 → 交给任务注册表
        │
  ② 注册表   生成任务 ID，分配日志文件路径，启动子进程
        │        任务状态：running
        │        返回："Task started: job-abc123"（placeholder，不等待）
        │
  ③ 子进程   后台运行，stdout/stderr 流式写入文件
        │        大模型继续做其他事，不被阻塞
        │        …几秒、几小时、几天后…
        │        进程退出 → 通知注册表
        │
  ④ 注册表   读退出码，标记 completed / failed / killed / timeout
        │        触发回调
        │
  ⑤ 回调     读 stdout/stderr 文件 → 以 user 角色注入对话
        │
        ▼
大模型在下一轮看到："job-abc123 跑完了，exit=0，输出是..."
就像有人把结果发给了它
```

## 为什么要分四层

- **工具层**只管协议——校验参数、格式化返回值，不知道进程怎么启动
- **注册表**只管生命周期——状态管理、超时、杀死、回调，不知道进程细节
- **子进程层**只管进程——spawn、管道、退出事件，不知道上层业务
- **回调层**只管集成——读结果、注入上下文，不知道进程和文件细节

**价值：** 每层独立可测。换掉进程启动方式（比如以后换成 docker exec）只改子进程层；换掉结果注入方式（比如以后改成 tool 消息）只改回调层。

## 关键设计

### 结果为什么以 "user" 角色注入

OpenAI 协议要求每个 tool 消息必须对应一个 `tool_call_id`。异步任务完成时那个 `run_command` 调用早已返回了——没有活跃的 tool_call 可以关联。

用 `user` 角色注入没有这个约束。而且副作用恰好是想要的：user 消息不被上下文压缩影响（压缩只处理 tool 消息），和用户输入同等的留存优先级。

### Placeholder 为什么不能省略

OpenAI 协议要求每个 tool_call 都必须有 tool 消息回应。Placeholder（"Task started: job-abc123"）满足协议，同时告诉大模型"已启动，可以用 lookup_task 看进度"。

### 超时和杀死

- 超时：spawn 时设闹钟 → 到点发 SIGTERM → 5 秒后升级 SIGKILL
- 手动杀：发 SIGTERM → 标记 killed，进程退出后不再覆盖为 completed

### 崩溃恢复

Agent 重启时从磁盘恢复所有任务记录，逐个检查：进程还活着的继续监控，已经死了的从退出文件恢复最终状态，找不到退出文件的标为 lost。

### 终端状态行

每 3 秒刷新，渲染到 stderr（不和 LLM 输出抢 stdout）：

```
收折：┃ ⚡ 2 running │ ✓ 最近完成: completed
展开：┃ ⚡ train.py  120s  45%  python train.py --epochs=100
      ┃ ⚡ build     30s       npm run build
      ┃ ✓ train.py  completed  180s  exit=0
```

## 核心文件

| 文件 | 做什么 |
|------|--------|
| `src/agent/loop.ts` | 注册回调，结果注入对话 |
| `src/tools/shell/run-command.ts` | 工具入口：校验、sandbox 包装、启动任务 |
| `src/tasks/registry.ts` | 任务生命周期：创建、杀死、超时、回调、恢复 |
| `src/tasks/shell-task.ts` | 子进程：spawn、管道、退出通知 |
| `src/tasks/store.ts` | 磁盘持久化，原子写入 |
| `src/agent/status-line.ts` | 终端状态行 |
| `bin/my-agent.ts` | 启动时初始化注册表、恢复任务、启动状态行 |
