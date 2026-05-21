# P1 结果报告：模型接入与代码修改闭环

## 当前结论

P1 的工程实现已经接入：

- 火山方舟 Chat Completions API 客户端。
- `doubao-seed-2.0 lite` 模型配置。
- 模型调用日志记录。
- LLM 需求澄清 Skill。
- LLM patch 生成 Skill。
- patch 文件边界校验。
- worktree 内受控应用 patch。
- 测试/构建执行模块。
- diff 和提测报告生成模块。

使用新的有效 API key 后，P1 已完成真实端到端代码修改闭环：

```text
PM 需求 -> 模型澄清 -> git worktree -> 模型生成 patch -> 受控应用代码 -> 测试 -> 构建 -> diff -> 提测报告
```

## 模型配置

当前代码默认使用：

```text
ARK_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
ARK_MODEL=ep-20260514110933-mzh58
```

API key 不写入源码，也不写入报告，通过环境变量传入：

```bash
ARK_API_KEY=...
```

## 成功运行结果

运行需求：

```text
文章详情页新增字数统计：在文章正文下方显示本文共 XXX 字，预计阅读 X 分钟，前端基于 Article.body 计算。
```

成功 run：

```text
run_20260521065432796_4n4ay4
```

结果文件：

```text
workspace/runs/run_20260521065432796_4n4ay4/result.json
workspace/runs/run_20260521065432796_4n4ay4/model-calls.jsonl
workspace/runs/run_20260521065432796_4n4ay4/model-generated.patch
workspace/runs/run_20260521065432796_4n4ay4/changes.patch
workspace/runs/run_20260521065432796_4n4ay4/test-output.txt
workspace/runs/run_20260521065432796_4n4ay4/build-output.txt
workspace/runs/run_20260521065432796_4n4ay4/delivery-report.md
```

工作分支和 worktree：

```text
branch: ai/run_20260521065432796_4n4ay4-planning
worktree: /Users/doumengyao/work/end2endProject/ai-engineering-tool/workspace/worktrees/run_20260521065432796_4n4ay4
```

## 模型调用记录

```text
requirement_clarification:
  status: 200
  latencyMs: 28295
  total_tokens: 863

code_patch_generation:
  status: 200
  latencyMs: 76876
  total_tokens: 3480
```

## 代码变更

最终 `changes.patch` 包含以下 Conduit 文件：

```text
frontend/src/helpers/articleStats.js
frontend/src/helpers/articleStats.test.js
frontend/src/routes/Article/Article.jsx
```

实现内容：

- 新增 `getArticleStats(body)` helper。
- 基于 `Article.body` 计算非空白正文长度。
- 预计阅读时间按 200 字/分钟向上取整，最低 1 分钟。
- 在文章详情正文下方、标签上方展示：

```text
本文共 XXX 字，预计阅读 X 分钟
```

## 验证结果

测试：

```text
Test Files  4 passed (4)
Tests       15 passed (15)
```

构建：

```text
npm run build -w frontend
✓ built in 1.08s
```

## 过程中的工程修复

P1 过程中发现并修复了三个工具层问题：

1. 无效 API key 时没有生成最终 `result.json`。
   - 已修复为任意失败都会写 `result.json` 和 `run_failed` 事件。

2. 模型生成的 patch 对新增文件使用 `/dev/null`，校验器误判为非法文件。
   - 已修复 `/dev/null` 识别。

3. 模型生成的 patch 格式不满足 `git apply`。
   - 已保留 `model-generated.patch`。
   - 工具在允许文件边界内执行受控 fallback，并记录 `patch-apply-error.txt`。

4. worktree 没有独立 `node_modules`，测试/构建命令找不到依赖。
   - 已在验证阶段链接目标仓库 `node_modules`。
   - 测试使用 run 临时 Vitest config，避免路径解析到主工作区。

5. 初版 `changes.patch` 未包含新增文件。
   - 已通过 `git add -N .` 修复 diff 生成，当前 patch 包含新增 helper 和测试文件。

## 已新增代码

模型客户端：

```text
src/llm/arkClient.js
```

模型化需求澄清：

```text
src/skills/llmRequirementClarifier.js
```

模型生成 patch：

```text
src/skills/patchGenerator.js
```

测试/构建执行：

```text
src/verification.js
```

提测报告生成：

```text
src/report.js
```

Orchestrator 升级：

```text
src/orchestrator.js
server.js
```

## 当前 P1 状态

```text
模型接入代码：完成
模型真实调用：完成
代码 patch 生成：完成
worktree 代码修改：完成
测试执行：通过
构建执行：通过
PR-ready 报告：已生成
```

## 下一步

下一步 P2 应补齐：

```text
1. 将 patch 应用失败后的 fallback 改为模型二次修复，而不是固定兜底。
2. 增加人工确认节点。
3. 增加 stage replay。
4. 增加 PR 创建能力。
5. 增加可视化 token / latency / cost 面板。
```
