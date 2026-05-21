# AI 工程工具实现方案调研

## 1. 调研目的

上一版技术方案主要基于端到端工程 agent 的通用架构推导，并没有系统参考 Claude Code、OpenClaw、OpenHands、SWE-agent、aider、goose 等工具的实现方案。

本调研用于补齐这部分依据，目标是提炼当前优秀 AI 工程工具的通用架构模式，并反推本项目在 20 天内应该采用哪些设计。

调研原则：

- 优先参考官方文档、开源仓库文档和论文。
- 不依赖泄露源码、反编译仓库或来源不清的复刻项目。
- 区分“可直接借鉴的工程结构”和“当前 MVP 不应过早实现的复杂能力”。
- 所有调研结论必须服务于 Conduit 前后端单仓 monorepo 实验田，不能偏离为通用 AI coding 平台方案。

硬约束：

- 实验仓库必须是 Conduit/RealWorld 风格的开源全栈博客项目。
- 前端和后端必须位于同一个 monorepo。
- 不能用仅前端、仅后端、多仓拆分或非博客业务域项目替代。
- 调研中借鉴的 hooks、workspace、repo map、sandbox、skills 等设计，最终都必须在该 Conduit monorepo 上验证。

## 2. 参考对象

### 2.1 Claude Code

参考资料：

- Claude Code Subagents: https://code.claude.com/docs/en/subagents
- Claude Code Hooks: https://code.claude.com/docs/en/hooks
- Claude Code MCP docs: https://code.claude.com/docs/en/mcp

核心观察：

- Claude Code 将专业能力拆成 subagents，用于任务专用工作流和上下文隔离。
- Hooks 可以拦截和控制 agent 行为，尤其适合在工具调用前后做审计、权限控制、日志记录和人工确认。
- MCP 被作为外部工具接入方式，工具名、服务名和动作之间有明确映射。

可借鉴点：

- 将需求澄清、方案拆解、代码审查、测试分析拆成专业 agent 或 skill。
- 在高风险工具调用前增加 hook，例如写文件、执行 shell、创建 PR、部署。
- 工具调用必须有事件日志，记录 session、cwd、tool_name、tool_input、tool_result。

对本项目的影响：

- 原方案中的 skill 拆分方向是合理的，但需要补充“hook/control layer”。
- 不能只靠 prompt 约束 agent，需要在工具层增加硬性拦截。

### 2.2 OpenClaw

参考资料：

- OpenClaw Agent Runtime: https://docs.openclaw.ai/concepts/agent
- OpenClaw Skills: https://docs.openclaw.ai/tools/skills
- OpenClaw GitHub: https://github.com/openclaw/openclaw

核心观察：

- OpenClaw 使用单个嵌入式 agent runtime，由 Gateway 层承接 channel、session、tool wiring 和消息投递。
- Workspace 是 agent 的核心工作目录，包含 `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`USER.md` 等 bootstrap 文件。
- Skills 有多级加载来源和优先级，例如 workspace、project、personal、managed、bundled。
- Skills 支持 per-agent allowlist，可以控制不同 agent 能使用哪些能力。
- Session 以 JSONL 形式持久化，便于恢复、审计和回放。

可借鉴点：

- 引入 workspace 作为每次需求运行的隔离上下文。
- 将项目级 skill 放在仓库内，将通用 skill 放在用户或平台级目录。
- 为每个 agent 配 skill allowlist，避免所有 agent 都拥有全部能力。
- 保存 session transcript，用于审计、知识回写和失败复盘。

对本项目的影响：

- `conduit-codebase-navigator` 应该是项目级 skill。
- `requirement-clarifier`、`solution-planner`、`test-runner-debugger` 可以是平台级通用 skill。
- 工作流状态库之外，还需要保存 agent session 日志。

### 2.3 OpenHands

参考资料：

- OpenHands Runtime Architecture: https://docs.openhands.dev/openhands/usage/architecture/runtime
- OpenHands Skills Overview: https://docs.openhands.dev/overview/skills
- OpenHands SDK Architecture: https://docs.openhands.dev/sdk/arch/overview
- OpenHands paper: https://arxiv.org/abs/2407.16741

核心观察：

- OpenHands 将代码执行放在 Docker sandbox 中，解决安全、环境一致性、资源隔离和复现问题。
- Runtime 使用 client-server 架构，agent 后端和沙箱环境之间通过 API 通信。
- OpenHands 支持 skills/microagents，将项目知识和行为约束注入 agent。
- 官方明确区分 CLI、SDK、本地 GUI、Cloud 中 skill 的配置方式。

可借鉴点：

- 本项目不能只用本机 shell，需要有隔离执行环境。
- Git worktree 只能解决代码隔离，不能解决依赖、数据库、端口、资源限制问题。
- 对测试、服务启动、依赖安装这类操作，应该优先放入 Docker sandbox。

对本项目的影响：

- 原方案中的 “Git worktree + Docker Compose” 是正确方向，但要进一步明确：
  - Git worktree 管代码变更隔离。
  - Docker sandbox 管执行环境隔离。
  - 二者需要共同组成每次需求的运行环境。

### 2.4 SWE-agent

参考资料：

- SWE-agent paper: https://arxiv.org/abs/2405.15793
- SWE-agent GitHub: https://github.com/SWE-agent/SWE-agent

核心观察：

- SWE-agent 强调 Agent-Computer Interface，认为 agent 能力很大程度取决于它使用计算机的接口设计。
- 它通过自定义命令和编辑接口提升 agent 在代码导航、文件编辑、测试执行中的表现。
- 重点不是“让模型更聪明”，而是设计更适合 agent 的 shell/file/test 交互界面。

可借鉴点：

- 不应该直接把裸 shell 完整暴露给 agent。
- 应该提供面向工程任务的窄接口，例如：
  - `search_code`
  - `read_file`
  - `apply_patch`
  - `run_test`
  - `inspect_failure`
  - `list_changed_files`
- 每个工具的输入输出要短、结构化、可被后续步骤消费。

对本项目的影响：

- 需要新增“Agent-Computer Interface 设计”章节。
- 工具层不只是能力集合，而是影响交付质量的关键产品设计。

### 2.5 aider

参考资料：

- aider Repository Map: https://aider.chat/docs/repomap.html
- aider GitHub: https://github.com/Aider-AI/aider

核心观察：

- aider 使用 repo map 给 LLM 提供仓库级上下文。
- repo map 包含重要类、函数、签名和文件关系。
- 对大仓库，aider 会按 token budget 选择最相关的 repo map 片段。
- repo map 帮助模型在没有读取全部文件的情况下理解项目结构。

可借鉴点：

- Conduit 项目必须先构建 repo map，再进入代码生成。
- 模块定位不能只靠全文检索，需要结合符号、调用关系和重要性排序。
- 上下文预算应该是动态的：需求越小，读入上下文越少。

对本项目的影响：

- `conduit-codebase-navigator` 应该包含 repo map 生成能力。
- 代码生成前必须产出“当前任务上下文包”，而不是把一堆文件直接塞给模型。

### 2.6 goose

参考资料：

- goose Architecture: https://goose-docs.ai/docs/goose-architecture/
- goose Extensions: https://block.github.io/goose/docs/getting-started/using-extensions/
- goose GitHub: https://github.com/block/goose

核心观察：

- goose 将能力扩展建立在 MCP 之上。
- extensions 通过 tools 暴露能力，agent 通过工具完成开发、文件、浏览器、自动化等操作。
- goose 支持作为 ACP server，也可以委托给外部 ACP agents。

可借鉴点：

- 工具扩展层应该尽量协议化，避免把 GitHub、数据库、测试、部署等能力写死进主流程。
- MCP 适合作为工具插件协议，尤其是 GitHub、浏览器、数据库、知识库等外部系统。

对本项目的影响：

- 20 天 MVP 可以先用本地工具函数。
- 架构上应预留 MCP/插件接口，后续将 GitHub、CI、部署、知识库查询做成可插拔工具。

## 3. 横向对比

| 工具 | 关键设计 | 最值得借鉴 |
| --- | --- | --- |
| Claude Code | subagents、hooks、MCP | 专业 agent 分工和工具调用控制 |
| OpenClaw | workspace、skills、gateway、session JSONL | skill 优先级、allowlist、长会话审计 |
| OpenHands | Docker sandbox、runtime API、skills | 安全隔离执行环境 |
| SWE-agent | Agent-Computer Interface | 面向 agent 优化的工程工具接口 |
| aider | repo map、token budget | 仓库级上下文压缩和模块定位 |
| goose | MCP extensions、ACP | 工具插件化和外部 agent 互操作 |

## 4. 对本项目技术方案的修正

基于调研，原技术方案应增加以下设计。

### 4.1 增加 Control Layer

位置：

```text
工作流编排层
  |
Control Layer
  |
Skill / Agent
  |
工具层
```

职责：

- 工具调用前审批。
- 高风险命令拦截。
- 文件写入范围校验。
- shell 命令白名单。
- 外部网络访问控制。
- 部署和 PR 创建审批。
- 工具调用日志记录。

高风险动作：

- 修改文件。
- 删除文件。
- 安装依赖。
- 执行数据库 migration。
- 调用外部 API。
- push 代码。
- 创建 PR。
- 部署服务。

### 4.2 增加 Workspace 模型

每个需求运行拥有独立 workspace：

```text
workspace/
├── repo/
├── session.jsonl
├── requirement.json
├── plan.json
├── context-pack/
├── test-reports/
├── patches/
└── knowledge-draft/
```

职责：

- 保存本次需求的所有中间产物。
- 支持暂停恢复。
- 支持审计回放。
- 支持失败复盘。
- 支持知识回写。

### 4.3 增加 Repo Map

Conduit 仓库需要先生成 repo map：

```json
{
  "files": [],
  "symbols": [],
  "routes": [],
  "api_contracts": [],
  "test_entrypoints": [],
  "dependencies": []
}
```

用途：

- 模块定位。
- 代码生成上下文压缩。
- 测试影响分析。
- 知识回写。

### 4.4 明确 Skill 分层

Skill 分为三类：

1. 平台级通用 skill
   - `requirement-clarifier`
   - `solution-planner`
   - `test-runner-debugger`
   - `delivery-packager`

2. 项目级 skill
   - `conduit-codebase-navigator`
   - `conduit-api-contract`
   - `conduit-testing-guide`

3. 任务级临时 skill
   - 当前需求的业务背景。
   - 当前方案的人工决策。
   - 当前测试约束。

### 4.5 改造工具层为 ACI

工具层不应直接暴露杂乱命令，而应提供 Agent-Computer Interface：

```text
search_code(query)
read_file(path)
build_repo_map()
create_worktree(requirement_id)
apply_patch(patch)
run_command(command_id)
run_test(test_suite)
collect_logs(run_id)
analyze_failure(test_run_id)
list_changed_files()
generate_pr_summary()
```

其中 `run_command` 不接收任意 shell 字符串，而是接收平台登记过的 command_id。

### 4.6 明确 Sandbox 策略

隔离分两层：

- Git worktree：隔离代码改动。
- Docker sandbox：隔离命令执行、依赖安装、数据库和测试环境。

MVP 可以先用 Docker Compose，但设计上要保留 sandbox provider：

```text
sandbox_provider = local_process | docker | remote
```

默认建议：

- 本地开发 demo：Docker Compose。
- 多用户平台：Docker sandbox。
- 后续 SaaS 化：remote sandbox。

## 5. 调整后的 MVP 架构

```text
Next.js UI
  |
Backend API
  |
LangGraph Workflow
  |
Control Layer
  |
Skill Router
  |
Agent-Computer Interface
  |
Worktree + Docker Sandbox
  |
PostgreSQL + pgvector + Session Logs
```

该 MVP 架构只在一个固定的 Conduit 前后端单仓 monorepo 上验收。平台可以保留通用化扩展点，但 20 天内不以多仓库、多项目、多业务域适配作为目标。

## 6. 调整后的 20 天优先级

相比上一版，建议前置三件事：

1. 先构建 repo map，不要直接进入代码生成。
2. 先实现 ACI，不要直接暴露 shell。
3. 先实现 workspace/session 日志，不要等知识回写阶段再补。

调整后排期：

- 第 1-3 天：Conduit 环境、Docker Compose、baseline 测试。
- 第 4-5 天：workspace、session log、Git worktree。
- 第 6-8 天：repo map、模块定位、`conduit-codebase-navigator`。
- 第 9-10 天：需求澄清、方案拆解、人工确认。
- 第 11-13 天：ACI、受控代码修改、diff 展示。
- 第 14-16 天：测试执行、日志分析、自动修复。
- 第 17-18 天：知识回写、相似需求检索。
- 第 19-20 天：端到端 demo、稳定性和项目报告。

## 7. 结论

调研后，原方案的大方向成立，但需要补强四个关键点：

1. 引入类似 Claude Code hooks 的控制层，管理工具调用风险。
2. 引入类似 OpenClaw 的 workspace、skill 优先级、session transcript。
3. 引入类似 OpenHands 的 sandbox 执行环境。
4. 引入类似 aider/SWE-agent 的 repo map 和 Agent-Computer Interface。

这些补强不是为了构建泛化 AI IDE，而是为了让系统能在 Conduit 前后端单仓 monorepo 上稳定完成真实需求交付。验收时必须证明完整链路能作用于 Conduit 的前端、后端、测试和知识回写。

最终本项目不应设计成“多个 prompt 串起来”，而应设计成：

```text
有状态工作流 + 受控工具接口 + 隔离执行环境 + 项目知识 skill + 测试反馈闭环 + 可回放知识沉淀
```
