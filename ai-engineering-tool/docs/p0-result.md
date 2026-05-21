# P0 最小端到端工作流结果

## 概述

当前已经完成 P0：AI 工程工具作为独立项目运行，不再嵌入 Conduit 仓库。它通过 git 管理的 workflow run 操作 Conduit，包括读取目标仓库状态、创建隔离 worktree、执行需求澄清/方案拆解/模块定位/测试计划/提测草案/知识回写等阶段。

AI 工程工具项目：

```text
/Users/doumengyao/work/end2endProject/ai-engineering-tool
```

目标 Conduit 仓库：

```text
/Users/doumengyao/work/end2endProject/conduit-realworld-example-app-filtered
```

## 已验证运行

验证命令：

```bash
curl -s -X POST http://localhost:4100/api/workflows \
  -H 'Content-Type: application/json' \
  -d '{"requirement":"文章详情页新增字数统计：在文章正文下方显示本文共 XXX 字，预计阅读 X 分钟，前端基于 Article.body 计算。"}'
```

结果：

```text
runId: run_20260520163032459_abrd2u
status: completed_with_gates
```

已创建 Git worktree：

```text
branch: ai/run_20260520163032459_abrd2u-planning
path: /Users/doumengyao/work/end2endProject/ai-engineering-tool/workspace/worktrees/run_20260520163032459_abrd2u
```

持久化产物：

```text
workspace/runs/run_20260520163032459_abrd2u/events.jsonl
workspace/runs/run_20260520163032459_abrd2u/result.json
workspace/runs/run_20260520163032459_abrd2u/knowledge-draft.json
```

## 工作流阶段

本次 P0 工作流完成了以下确定性阶段：

1. `requirement_clarification`
2. `solution_planning`
3. `module_location`
4. `test_planning`
5. `delivery_packaging`
6. `knowledge_write`

## 目标 Conduit 仓库状态

运行时，工具读取到 Conduit 主工作区存在未提交改动：

```text
M backend/config/config.js
M package-lock.json
M package.json
?? docs/
```

工具没有直接修改 Conduit 主工作区，而是基于 `HEAD` 创建了独立 worktree 作为本次 run 的操作空间。后续代码生成和测试都应在该 worktree 中执行。

## 模块定位结果

工具已确认以下真实 Conduit 文件存在于本次 worktree 中：

```text
frontend/src/routes/Article/Article.jsx
frontend/src/services/getArticle.js
frontend/src/components/ArticleMeta/ArticleMeta.jsx
backend/controllers/articles.js
backend/routes/articles.js
backend/models/Article.js
```

P1 阶段建议的主要改动边界：

```text
frontend/src/routes/Article/Article.jsx
```

## 如何验证

启动独立 AI 工程工具：

```bash
cd /Users/doumengyao/work/end2endProject/ai-engineering-tool
npm start
```

浏览器打开：

```text
http://localhost:4100
```

也可以运行目标仓库状态检查：

```bash
npm run check
```

然后在页面中提交 L1 字数统计需求。

## 下一步

P1 应该在生成的 worktree 中应用真实代码 patch，而不是直接修改 Conduit 主工作区。代码生成、测试执行、diff 生成和提测报告都应该以本次 run 的 worktree 为目标。

建议 P1 实现：

1. 在 worktree 中实现文章详情页字数统计。
2. 增加前端 helper 和单元测试。
3. 运行 `npm run test`。
4. 运行 `npm run build -w frontend`。
5. 保存 `changes.patch`。
6. 生成中文提测说明。
