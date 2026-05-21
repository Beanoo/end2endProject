# AI 工程工具超级个体技术方案

## 1. 项目背景

本项目目标是在 20 天内实现一个可以端到端交付全栈需求的 AI 工程系统。系统以开源全栈博客项目 Conduit/RealWorld 为实验田，让产品经理能够在平台内通过对话完成从需求澄清到代码提测的完整流程。

目标链路：

```text
需求澄清 -> 方案拆解 -> 模块定位 -> 代码生成 -> 自动化测试 -> 代码部署 -> 知识回写
```

系统要求：

- 支持产品经理通过自然语言提交需求。
- 支持各阶段人工介入，包括追加澄清、修订方案、调整模块边界、修订测试用例等。
- 能在 Conduit 仓库中稳定产出可提测代码。
- 能将交付过程中的需求、方案、代码、测试和经验回写知识库，反哺后续迭代。

## 2. 总体目标

本项目不是单纯代码生成工具，而是一个面向真实工程交付的 AI 工作流平台。核心目标包括：

1. 让 PM 可以用对话表达需求，并得到结构化需求文档。
2. 让系统自动拆解工程任务，明确前端、后端、数据库、测试和部署影响。
3. 让系统能够理解 Conduit 仓库结构，定位相关模块和文件。
4. 让系统能在隔离分支或 worktree 中生成代码变更。
5. 让系统能自动生成和运行测试，并根据失败日志进行修复。
6. 让人工可以在关键节点审阅、修改和批准。
7. 让每次交付沉淀为可检索知识。

## 3. Conduit Monorepo 硬约束

本项目必须以开源全栈博客仓库 Conduit 作为实验田，并且该仓库必须是前后端单仓 monorepo。这个约束不是技术选型建议，而是项目验收条件。

必须遵守：

- 实验对象必须是 Conduit/RealWorld 风格的全栈博客项目。
- 前端和后端必须位于同一个代码仓库中。
- 不得使用仅前端、仅后端、多仓拆分、非博客业务域的项目替代。
- 所有需求澄清、方案拆解、模块定位、代码生成、测试和知识回写，都必须围绕该 monorepo 落地验证。
- 最终交付必须在该 Conduit monorepo 上真实产生代码 diff、测试结果和提测材料。

候选依据：

- `gothinkster/realworld` 可作为 Conduit 标准规范和 API 契约参考。
- 需要选择或整理一个前后端单仓 monorepo 作为实际实验仓库。

实际实验仓库必须具备：

- 前后端在同一个仓库中。
- 有明确启动命令。
- 有 Docker 或可快速本地运行的数据库方案。
- 已包含基础测试，或可快速补齐 API/E2E 测试。
- 技术栈主流，便于 AI agent 理解和修改。

如果现成开源仓库不满足前后端单仓要求，可以基于 Conduit/RealWorld 标准实现整理一个 monorepo 镜像仓库，但业务域、API 语义和核心功能必须保持 Conduit。

## 4. 系统架构

整体架构分为五层：

```text
前端交互层
  |
工作流编排层
  |
Skill 能力层
  |
工程工具层
  |
数据与知识层
```

### 4.1 前端交互层

面向产品经理、研发和测试人员提供可视化操作界面。

核心页面：

- 需求对话页
- 工作流阶段看板
- 方案拆解页
- 模块定位页
- 代码 diff 页
- 测试报告页
- 知识回写页

推荐技术栈：

- Next.js
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Monaco Editor
- Xterm.js

### 4.2 工作流编排层

负责任务状态、阶段流转、人工审批、失败重试和暂停恢复。

推荐技术栈：

- LangGraph：主工作流状态机。
- PostgreSQL：持久化流程状态。
- Redis + BullMQ：异步任务队列。
- Git worktree：每个需求创建独立代码工作区。

工作流节点：

```text
需求录入
  -> 需求澄清
  -> 人工确认需求
  -> 方案拆解
  -> 人工确认方案
  -> 模块定位
  -> 人工确认改动边界
  -> 代码生成
  -> 代码 diff 审阅
  -> 测试生成
  -> 测试执行
  -> 自动修复
  -> 提测打包
  -> 知识回写
```

### 4.3 Skill 能力层

Skill 用于封装稳定、可复用、边界清楚的工程能力。工作流负责调度，skill 负责执行某一阶段的专业任务。

Skill 不负责：

- 全局状态机
- 权限系统
- 长期任务调度
- 数据库持久化
- 沙箱生命周期管理

Skill 负责：

- 专业流程说明
- 仓库知识
- 领域约束
- 输出格式规范
- 可复用脚本和参考资料

### 4.4 工程工具层

为 agent 和 skill 提供可调用工具能力。

核心工具：

- 文件读取与修改
- 代码搜索
- AST/符号索引
- Git branch/worktree 操作
- 依赖安装
- 服务启动
- 测试执行
- 日志读取
- PR 描述生成

推荐技术：

- ripgrep：快速文本搜索。
- tree-sitter：代码结构解析。
- Git worktree：需求级隔离开发环境。
- Docker Compose：运行 Conduit 依赖环境。
- Playwright：前端 E2E 和 API 测试。
- Jest/Vitest：单元测试。
- Newman 或 Playwright API：接口测试。

### 4.5 数据与知识层

存储需求、工作流状态、代码知识、测试结果和历史交付经验。

推荐技术栈：

- PostgreSQL：结构化数据。
- pgvector 或 Qdrant：语义检索。
- 对象存储或本地文件系统：日志、diff、测试报告。
- Neo4j 可选：代码模块关系图谱。

核心数据：

- 需求原文
- 澄清记录
- 验收标准
- 技术方案
- 人工决策
- 模块定位结果
- 代码 diff
- 测试用例
- 测试报告
- 修复记录
- 提测说明
- 可复用经验

## 5. Skill 拆分设计

建议将端到端交付能力拆成多个 skill，并由 LangGraph 工作流按阶段调用。

### 5.1 requirement-clarifier

职责：将 PM 的自然语言需求澄清为结构化需求。

输入：

- 用户原始需求
- 历史对话
- 当前产品上下文
- 已知系统能力

输出：

- 需求摘要
- 用户故事
- 验收标准
- 待确认问题
- 非目标范围
- 风险点

适用场景：

- 用户提交新需求。
- 需求描述模糊。
- 需要生成验收标准。
- 需要进入人工确认。

### 5.2 solution-planner

职责：将确认后的需求拆成工程方案和任务。

输入：

- 结构化需求
- 验收标准
- Conduit 项目背景
- 历史相似需求

输出：

- 技术方案
- 前端任务
- 后端任务
- 数据库任务
- 测试任务
- 部署影响
- 风险与假设

适用场景：

- 需求已确认，需要进入实现前设计。
- 需要人工评审技术方案。
- 需要拆解工程任务。

### 5.3 conduit-codebase-navigator

职责：专门理解 Conduit 仓库，定位模块、文件和调用链。

输入：

- 工程任务
- 当前仓库路径
- 代码索引结果
- 历史模块知识

输出：

- 相关领域模型
- 候选文件列表
- 前后端调用链
- 测试文件入口
- 建议改动边界
- 不建议修改区域

适用场景：

- 需要定位需求涉及哪些文件。
- 需要判断影响范围。
- 需要为代码生成提供上下文。

建议目录结构：

```text
conduit-codebase-navigator/
├── SKILL.md
├── references/
│   ├── domain-model.md
│   ├── api-routes.md
│   ├── frontend-structure.md
│   ├── backend-structure.md
│   └── testing-guide.md
└── scripts/
    ├── scan_modules.ts
    ├── find_related_files.ts
    └── build_dependency_map.ts
```

### 5.4 code-change-author

职责：根据已批准方案和模块定位结果生成代码变更。

输入：

- 已批准技术方案
- 任务列表
- 候选文件
- 代码上下文
- 项目代码规范

输出：

- 代码 diff
- 变更摘要
- 受影响文件列表
- 自测说明
- 待人工确认点

约束：

- 不扩大需求范围。
- 不做无关重构。
- 不覆盖人工已有改动。
- 优先遵循现有代码风格。
- 优先生成可审阅的小 diff。

### 5.5 test-case-designer

职责：根据需求和验收标准生成测试计划和测试用例。

输入：

- 结构化需求
- 验收标准
- 技术方案
- 代码改动范围
- Conduit API 规范

输出：

- 单元测试建议
- API 测试用例
- E2E 测试用例
- 回归测试清单
- 人工验收清单

适用场景：

- 代码实现前生成测试计划。
- 代码实现后补齐测试。
- 需要人工确认测试覆盖范围。

### 5.6 test-runner-debugger

职责：执行测试、分析失败、反馈修复建议。

输入：

- 测试命令
- 测试日志
- 代码 diff
- 历史失败记录

输出：

- 测试结果
- 失败归因
- 修复建议
- 是否需要重新执行代码生成
- 是否需要人工介入

失败类型：

- 代码实现错误
- 测试用例错误
- 环境配置错误
- 数据库状态错误
- 依赖版本问题
- 需求或方案本身不完整

### 5.7 delivery-packager

职责：将一次需求交付打包成可提测结果。

输入：

- 需求文档
- 技术方案
- 代码 diff
- 测试报告
- 人工审批记录

输出：

- PR 描述
- 提测说明
- 部署说明
- 风险说明
- 回滚建议
- 验收 checklist

### 5.8 knowledge-writer

职责：将本次交付过程沉淀为后续可复用知识。

输入：

- 需求澄清记录
- 技术方案
- 模块定位结果
- 代码 diff
- 测试报告
- 修复记录
- 人工决策

输出：

- 需求知识
- 模块知识
- 测试知识
- 踩坑记录
- 相似需求检索索引
- 下次迭代建议

## 6. 工作流与 Skill 协作方式

推荐协作模型：

```text
LangGraph Workflow
  |
  |-- requirement-clarifier
  |-- solution-planner
  |-- conduit-codebase-navigator
  |-- code-change-author
  |-- test-case-designer
  |-- test-runner-debugger
  |-- delivery-packager
  |-- knowledge-writer
```

示例流程：

1. PM 提交需求。
2. 工作流调用 `requirement-clarifier` 输出结构化需求和追问。
3. PM 确认需求。
4. 工作流调用 `solution-planner` 输出技术方案。
5. 研发或 PM 确认方案。
6. 工作流调用 `conduit-codebase-navigator` 定位模块和文件。
7. 人工确认改动边界。
8. 工作流调用 `code-change-author` 生成 diff。
9. 工作流调用 `test-case-designer` 生成测试用例。
10. 工作流调用 `test-runner-debugger` 执行测试并分析失败。
11. 如测试失败，回到代码生成或测试修订节点。
12. 测试通过后调用 `delivery-packager` 生成提测材料。
13. 最后调用 `knowledge-writer` 完成知识回写。

## 7. 核心数据模型

### 7.1 Requirement

```json
{
  "id": "req_xxx",
  "title": "string",
  "raw_input": "string",
  "summary": "string",
  "status": "draft | clarifying | confirmed | in_progress | delivered",
  "acceptance_criteria": [],
  "open_questions": [],
  "created_by": "user_id"
}
```

### 7.2 WorkflowRun

```json
{
  "id": "run_xxx",
  "requirement_id": "req_xxx",
  "current_stage": "requirement_clarification",
  "status": "running | waiting_for_human | failed | completed",
  "checkpoint_id": "checkpoint_xxx",
  "created_at": "datetime",
  "updated_at": "datetime"
}
```

### 7.3 EngineeringPlan

```json
{
  "id": "plan_xxx",
  "requirement_id": "req_xxx",
  "frontend_tasks": [],
  "backend_tasks": [],
  "database_tasks": [],
  "test_tasks": [],
  "risks": [],
  "assumptions": []
}
```

### 7.4 CodeChange

```json
{
  "id": "change_xxx",
  "requirement_id": "req_xxx",
  "worktree_path": "string",
  "branch_name": "string",
  "changed_files": [],
  "diff_summary": "string",
  "status": "draft | reviewed | test_passed | ready_for_pr"
}
```

### 7.5 TestRun

```json
{
  "id": "test_xxx",
  "requirement_id": "req_xxx",
  "commands": [],
  "status": "passed | failed | skipped",
  "failed_cases": [],
  "log_path": "string",
  "analysis": "string"
}
```

### 7.6 KnowledgeEntry

```json
{
  "id": "knowledge_xxx",
  "type": "requirement | decision | module | test | incident",
  "title": "string",
  "content": "string",
  "tags": [],
  "embedding_id": "vector_xxx",
  "source_run_id": "run_xxx"
}
```

## 8. MVP 范围

20 天周期内建议控制范围，优先证明端到端闭环。

MVP 必须支持：

- 一个固定的 Conduit 前后端单仓 monorepo。
- 需求对话和澄清。
- 结构化需求输出。
- 技术方案拆解。
- 模块定位。
- Git worktree 隔离修改。
- 代码 diff 展示。
- API 或 E2E 测试执行。
- 测试失败分析。
- 提测报告生成。
- 知识回写。

MVP 支持的需求类型：

1. 新增或修改文章字段展示。
2. 新增简单业务规则。
3. 修改评论、文章、用户资料相关流程。

暂不优先支持：

- 多仓库协同修改。
- 大规模架构重构。
- 复杂权限系统。
- 多环境生产部署。
- 自动合并主分支。
- 完全无人值守交付。

## 9. 20 天实施计划

### 第 1-3 天：实验田和基线

目标：

- 固定 Conduit 前后端单仓 monorepo。
- 跑通本地启动。
- 跑通数据库和测试。
- 梳理前后端目录结构。
- 整理核心业务模块。

交付物：

- 仓库运行文档。
- 模块地图。
- 测试基线报告。
- 第一版 Conduit 项目知识。

### 第 4-6 天：代码索引与模块定位

目标：

- 实现文件扫描。
- 实现代码搜索封装。
- 接入 tree-sitter 或轻量符号索引。
- 实现模块定位能力。
- 初步沉淀 `conduit-codebase-navigator`。

交付物：

- 模块定位 API。
- 代码上下文检索能力。
- Conduit 模块知识参考文件。

### 第 7-9 天：需求澄清与方案拆解

目标：

- 实现 PM 对话入口。
- 实现结构化需求输出。
- 实现自动追问。
- 实现方案拆解。
- 加入人工确认节点。
- 初步沉淀 `requirement-clarifier` 和 `solution-planner`。

交付物：

- 需求澄清页面。
- 技术方案页面。
- 人工确认流程。

### 第 10-13 天：代码生成闭环

目标：

- 实现 Git worktree。
- 实现按任务生成代码 diff。
- 实现 diff 展示和人工反馈。
- 初步沉淀 `code-change-author`。

交付物：

- 一个简单需求可自动产出 diff。
- 支持人工反馈后重新生成。
- 变更摘要和文件列表。

### 第 14-16 天：测试与自动修复

目标：

- 接入测试命令。
- 生成 API/E2E 测试用例。
- 执行测试并采集日志。
- 分析失败原因。
- 触发代码修复或测试修订。
- 初步沉淀 `test-case-designer` 和 `test-runner-debugger`。

交付物：

- 自动测试报告。
- 失败分析报告。
- 一次失败到修复的闭环演示。

### 第 17-18 天：知识回写

目标：

- 回写需求、方案、模块定位、diff、测试结果。
- 建立相似需求检索。
- 初步沉淀 `knowledge-writer`。

交付物：

- 知识回写记录。
- 历史需求检索能力。
- 模块经验沉淀。

### 第 19-20 天：端到端演示和稳定性

目标：

- 准备 2-3 个真实需求。
- 跑通完整链路。
- 固化演示脚本。
- 补齐异常兜底。
- 完成项目报告。

交付物：

- 端到端 demo。
- 提测报告样例。
- 技术总结。
- 下一阶段规划。

## 10. 关键技术选型

| 模块 | 推荐技术 |
| --- | --- |
| 工作流编排 | LangGraph |
| Agent 执行 | OpenAI API / OpenAI Agents SDK |
| 后端服务 | NestJS 或 Fastify |
| 前端平台 | Next.js + React + TypeScript |
| UI 组件 | shadcn/ui + Tailwind CSS |
| 编辑器 | Monaco Editor |
| 终端日志 | Xterm.js |
| 数据库 | PostgreSQL |
| 向量检索 | pgvector 或 Qdrant |
| 队列 | Redis + BullMQ |
| 代码搜索 | ripgrep |
| 代码解析 | tree-sitter |
| 测试 | Playwright + Jest/Vitest + Newman |
| 隔离执行 | Git worktree + Docker Compose |
| 知识图谱 | Neo4j，可选 |

## 11. 风险与应对

### 11.1 AI 修改范围失控

风险：agent 可能修改无关文件或做额外重构。

应对：

- 代码生成前必须有模块定位结果。
- 人工确认改动边界。
- 限制可写文件范围。
- diff 过大时强制人工审批。

### 11.2 测试环境不稳定

风险：Conduit 仓库依赖、数据库、端口和测试数据可能导致测试不稳定。

应对：

- 使用 Docker Compose 固化环境。
- 初始化固定测试数据。
- 保存测试日志。
- 将环境错误和代码错误分开归因。

### 11.3 需求澄清不足

风险：需求不清导致后续代码实现偏离预期。

应对：

- requirement-clarifier 必须输出 open questions。
- 验收标准未确认前不进入代码生成。
- 支持人工追加澄清。

### 11.4 知识回写质量不高

风险：知识库堆积大量低价值内容，后续检索效果差。

应对：

- 知识分类型存储。
- 每条知识必须关联来源 run。
- 只回写决策、模块关系、失败修复、可复用经验。
- 定期合并重复知识。

### 11.5 20 天范围过大

风险：完整平台能力过多，无法按期交付。

应对：

- 固定一个 Conduit 前后端单仓 monorepo。
- 固定 2-3 类需求。
- 优先端到端闭环。
- 平台体验够用即可，不追求完整商业产品形态。

## 12. 成功标准

项目结束时，至少满足：

1. PM 可以通过对话提交需求。
2. 系统可以输出结构化需求和验收标准。
3. 系统可以拆解技术方案。
4. 系统可以定位 Conduit 中相关模块和文件。
5. 系统可以在隔离 worktree 中生成代码 diff。
6. 系统可以执行至少一种自动化测试。
7. 测试失败时系统可以给出失败归因和修复建议。
8. 测试通过后可以生成提测报告。
9. 本次交付知识可以回写并在后续需求中被检索。
10. 至少一个真实需求完整跑通端到端链路。

## 13. 推荐首个演示需求

建议选择低风险、覆盖前后端、容易验证的需求。

示例：

```text
作为登录用户，我希望在文章详情页看到文章字数统计，以便判断阅读成本。
```

可能涉及：

- 后端文章实体增加或计算 `wordCount`。
- 文章详情 API 返回 `wordCount`。
- 前端文章详情页展示字数。
- API 测试验证返回字段。
- E2E 测试验证页面展示。
- 知识库记录 article 模块的字段扩展方式。

该需求适合作为 MVP demo，因为范围小，但能覆盖需求、方案、模块定位、代码修改、测试和知识回写。

## 14. 下一步落地顺序

建议下一步按以下顺序推进：

1. 确定 Conduit 前后端单仓 monorepo 实验仓库。
2. 拉取仓库并跑通本地环境。
3. 输出 Conduit 模块地图。
4. 创建前 4 个核心 skill：
   - `requirement-clarifier`
   - `solution-planner`
   - `conduit-codebase-navigator`
   - `test-runner-debugger`
5. 实现最小 LangGraph 工作流。
6. 跑通首个演示需求。
7. 再补齐代码生成、提测打包和知识回写。
