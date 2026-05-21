# P0 使用说明

## 启动方式

```bash
cd /Users/doumengyao/work/end2endProject/ai-engineering-tool
npm start
```

启动后访问：

```text
http://localhost:4100
```

## 当前能力

当前 P0 已实现独立 AI 工程工具的最小端到端链路：

```text
PM 需求输入
  -> 独立 Node 后端 API
  -> Orchestrator
  -> Skill Registry
  -> 读取 Conduit git 状态
  -> 创建 Conduit worktree/branch
  -> 模块定位
  -> 测试计划
  -> 提测草案
  -> 知识草案
```

## API

### 查看目标仓库状态

```bash
curl -s http://localhost:4100/api/target/status
```

### 创建工作流

```bash
curl -s -X POST http://localhost:4100/api/workflows \
  -H 'Content-Type: application/json' \
  -d '{"requirement":"文章详情页新增字数统计：在文章正文下方显示本文共 XXX 字，预计阅读 X 分钟，前端基于 Article.body 计算。"}'
```

### 查看历史运行

```bash
curl -s http://localhost:4100/api/workflows/<runId>
```

## 产物位置

每次运行会写入：

```text
ai-engineering-tool/workspace/runs/<runId>/
├── events.jsonl
├── result.json
└── knowledge-draft.json
```

同时会为 Conduit 创建隔离 worktree：

```text
ai-engineering-tool/workspace/worktrees/<runId>
```

## 注意事项

- AI 工程工具是独立项目，不写入 Conduit 平台代码。
- Conduit 是目标 sandbox repo。
- 后续所有代码生成应该写入 run worktree。
- 主 Conduit 工作区只用于基线环境和人工查看，不应被 workflow 直接污染。

