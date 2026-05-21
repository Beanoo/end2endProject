# P2 结果报告：通用需求处理框架

## 当前结论

P2 已经把 P1 的固定文章页样例扩展为通用需求处理框架。

现在工作流可以针对 Conduit 前后端源码执行：

```text
模型澄清需求
-> 仓库源码索引
-> 模型选择动态模块边界
-> 模型生成 patch
-> patch 失败后模型修复
-> worktree 内应用代码
-> 测试/构建
-> 交付报告和知识草案
```

本阶段按要求暂未实现可交互人工节点。

## 已实现能力

新增仓库索引：

```text
src/repoIndex.js
```

改造模块定位：

```text
src/skills/moduleLocator.js
```

改造通用 patch 生成和修复循环：

```text
src/skills/patchGenerator.js
```

改造通用方案、测试计划、交付报告、知识回写：

```text
src/skills/solutionPlanner.js
src/skills/testPlanner.js
src/skills/deliveryPackager.js
src/skills/knowledgeWriter.js
src/report.js
```

修复 Conduit 作为总仓库子目录后的 worktree 映射：

```text
src/orchestrator.js
src/verification.js
```

## 关键工程修复

P2 验证时 Conduit 仍是总仓库 `end2endProject` 下的普通目录：

```text
conduit-realworld-example-app-filtered
```

因此 Git worktree 创建出来的是总仓库根目录，而不是 Conduit 子目录本身。

P2 修复后，每次 workflow 会记录：

```text
gitWorktree.path
gitWorktree.targetPath
gitWorktree.targetRelativePath
```

其中代码扫描、测试、构建发生在：

```text
gitWorktree.targetPath
```

patch 应用和 diff 保存发生在 Git worktree 根目录，并通过 `targetRelativePath` 限定到 Conduit 子目录。

后续已进一步拆分为独立仓库：

```text
/Users/doumengyao/work/Conduiteg
git@github.com:Beanoo/Conduiteg.git
```

AI 工程工具默认目标仓库已改为独立 Conduit 仓库，并可通过环境变量覆盖：

```text
TARGET_REPO=/path/to/conduit
```

迁移后已重新运行一次端到端 workflow：

```text
runId: run_20260521142246741_97ix7p
targetRepo: /Users/doumengyao/work/Conduiteg
targetRelativePath: .
status: completed_with_gates
```

## 成功验证

验证需求不是 P1 的文章字数统计，而是一个新的 PM 需求：

```text
热门标签区域为空时显示占位文案：当接口返回空标签列表时，
在首页右侧热门标签模块显示 暂无标签，而不是空白。
```

成功 run：

```text
runId: run_20260521093313923_ovkzec
status: completed_with_gates
branch: ai/run_20260521093313923_ovkzec-planning
```

动态模块定位结果：

```text
editBoundary:
  frontend/src/components/PopularTags/PopularTags.jsx

readOnlyFiles:
  frontend/src/components/PopularTags/index.js
  frontend/src/components/PopularTags/TagButton.jsx
  backend/routes/tags.js
  frontend/src/services/getTags.js
  frontend/src/routes/Home.jsx
  ...

locatedBy:
  model_with_index
```

代码生成结果：

```text
appliedBy: model_patch
touchedFiles:
  frontend/src/components/PopularTags/PopularTags.jsx
```

生成 diff：

```diff
-            <p>Tags list not available</p>
+            <p>暂无标签</p>
```

验证结果：

```text
Vitest: passed
frontend build: passed
changes.patch diffBytes: 665
```

## 模型调用

本次成功 run 包含 3 次模型调用：

```text
requirement_clarification
module_location
code_patch_generation
```

模型调用日志：

```text
workspace/runs/run_20260521093313923_ovkzec/model-calls.jsonl
```

## 产物

```text
workspace/runs/run_20260521093313923_ovkzec/result.json
workspace/runs/run_20260521093313923_ovkzec/events.jsonl
workspace/runs/run_20260521093313923_ovkzec/model-generated.patch
workspace/runs/run_20260521093313923_ovkzec/changes.patch
workspace/runs/run_20260521093313923_ovkzec/test-output.txt
workspace/runs/run_20260521093313923_ovkzec/build-output.txt
workspace/runs/run_20260521093313923_ovkzec/delivery-report.md
workspace/runs/run_20260521093313923_ovkzec/knowledge-draft.json
```

## 当前边界

P2 已经不局限于文档里的文章详情页样例，但它仍然不是无限制的任意代码修改器。

当前适合处理：

```text
Conduit 前端组件/页面小型需求
Conduit service 层小型需求
Conduit 后端 route/controller/helper/model 小型增量
轻量测试新增或修改
```

当前仍需谨慎处理：

```text
数据库迁移
新增第三方依赖
认证协议大改
跨多个业务域的大型重构
部署流水线
```

这些能力需要 P3 引入人工确认节点、测试失败修复循环和更严格的验收门禁。
