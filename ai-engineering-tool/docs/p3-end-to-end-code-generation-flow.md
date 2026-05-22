# P3 端到端代码生成流程

本文描述 AI 工程工具从用户输入需求到生成 Conduit 代码的完整流程。

## 1. 用户提交需求

前端或接口向 AI 工程工具发起 workflow 请求：

```http
POST /api/workflows
{
  "requirement": "..."
}
```

工具会创建本次运行的 `runId`，并为后续阶段保存事件、模型调用、diff、review、验证结果和交付报告。

## 2. 创建 Git Worktree

工具从目标 Conduit 仓库创建独立 Git worktree。

默认目标仓库：

```text
/Users/doumengyao/work/Conduiteg
```

所有代码修改都发生在隔离 worktree 中，不直接污染 Conduit 主目录。

## 3. 需求澄清

LLM 将用户原始需求整理为结构化信息：

- `title`
- `userStory`
- `acceptanceCriteria`
- `openQuestions`
- `implementationLevel`

这些信息会作为后续模块探索、代码生成、code review 的基础输入。

## 4. 方案拆解

工具生成基础执行计划，包括：

- 模块定位
- 代码生成
- patch 修复
- LLM code review
- 自动化验证
- 交付打包
- 知识回写

## 5. Agentic Repository Exploration

工具扫描 Conduit 源码目录：

- `frontend/src/`
- `backend/`

然后组合多种信号探索相关模块。

### 5.1 关键词候选

根据需求词、领域词、文件路径、文件内容对源码文件打分，得到初始候选文件。

### 5.2 依赖探索

工具解析静态依赖：

- `import`
- `export ... from`
- `require`

并补充：

- 候选文件直接依赖的文件
- 直接引用候选文件的文件

### 5.3 入口探索

工具识别入口或注册文件，例如：

- `main.jsx`
- `App.jsx`
- `index.js`
- route/router 文件

这些文件通常决定页面、路由、组件是否真正接入。

### 5.4 LLM 探索输出

LLM 基于仓库地图输出：

- `filesToInspect`
- `writeCandidates`
- `searchTerms`
- `rationale`

这一步用于模拟工程师先阅读仓库、再决定修改位置的过程。

## 6. 模块定位

LLM 基于需求、候选文件、依赖探索结果、失败反馈生成模块定位结果：

- `editBoundary`：建议优先修改的文件
- `readOnlyFiles`：只读上下文文件
- `noEditAreas`：不应修改的区域
- `rationale`：模块定位理由
- `writePolicy`：写入策略

P3 之后，`editBoundary` 不再是唯一可写边界，而是优先建议边界。

## 7. 构建代码上下文

工具读取以下文件内容：

- `editBoundary`
- `readOnlyFiles`
- 探索补充的上下文文件

然后拼成代码生成 prompt 的上下文。

## 8. 代码生成

LLM 首先生成 unified diff patch。

工具依次尝试：

```text
git apply
git apply --recount
git apply --unidiff-zero
```

如果 patch 多次应用失败，工具进入结构化整文件写入 fallback。

fallback 格式：

```json
{
  "files": [
    {
      "path": "frontend/src/example.jsx",
      "content": "完整文件内容"
    }
  ]
}
```

## 9. Audited Write Policy

P3 写入策略从“少量文件硬边界”升级为“源码区可写 + 危险区硬禁 + 实际写入审计”。

### 9.1 可写源码区

- `frontend/src/`
- `backend/`

### 9.2 硬禁止区域

- `node_modules`
- `dist/build`
- `package.json`
- `package-lock.json`
- `.env`
- `backend/migrations`
- `backend/seeders`

### 9.3 写入审计

代码应用后，工具通过 `git diff --name-only` 统计所有实际变更文件，并生成 `writeAudit`。

审计分类包括：

- `planned_edit_boundary`
- `promoted_from_read_context`
- `audited_source_expansion`
- `outside_initial_boundary`

超出建议边界的改动会被标记为需要关注，并进入 code review。

## 10. LLM Code Review

工具把以下内容交给 LLM 审查：

- 需求澄清结果
- 方案约束
- 模块定位
- 代码生成结果
- `writeAudit`
- 本次 diff
- 相关文件上下文

review 结果只有：

- `pass`
- `reject`

如果发现功能错误、未接入新增文件、边界不合理、运行时风险、测试明显缺口，必须 reject。

## 11. 失败回流

以下情况会生成结构化 feedback，并回流到模块定位阶段重新探索：

- 代码生成失败
- LLM code review reject
- 自动化验证 blocked

feedback 会作为下一轮探索和代码生成的输入。

当前最多回流 3 轮，避免无限循环。

## 12. 自动化验证

review pass 后，工具运行自动验证：

- `vitest`
- `npm run build -w frontend`
- backend smoke test

验证结果决定最终状态：

- 全部通过：`completed_with_gates`
- review 拒绝：`rejected_by_code_review`
- 测试、构建或 smoke 失败：`blocked_by_verification`

## 13. 交付产物

每次 run 会保存：

- `result.json`
- `events.jsonl`
- `model-calls.jsonl`
- `changes.patch`
- `code-review.json`
- `delivery-report.md`
- `knowledge-draft.json`

`delivery-report.md` 会包含：

- 需求
- run 信息
- 变更文件
- 写入审计
- LLM code review 结论
- 验证结果
- 人工验收建议

## 14. 当前边界

P3 已经比 P2.5 更接近 Claude Code 式工作方式，但仍不是完全自由的本地 coding agent。

当前系统具备：

- 仓库地图探索
- 依赖图探索
- 入口文件探索
- 源码区审计写入
- 失败回流

仍需后续增强：

- 真实多轮 `search/read/analyze` 工具调用循环
- 更强的前端浏览器 E2E 验证
- 更细粒度的 AST 级依赖和调用链分析
- 更稳定的测试用例自动生成与回写
