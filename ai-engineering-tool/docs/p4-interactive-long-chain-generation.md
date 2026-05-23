# P4：交互确认与长链路代码生成

## 背景

复杂 PM 需求通常不是单文件修改，而是跨越数据模型、API contract、前端表单、服务层、列表展示、详情页展示和验证链路。此前流程虽然已经具备动态边界和审计写入策略，但在“文章加封面图字段”这类长链路需求上暴露两个问题：

- 需求没有正式确认节点，模型会直接进入代码生成，关键假设无法被 PM 修订。
- 一次性生成大 patch 时容易出现 diff hunk 不稳定；整文件 fallback 又一次性要求模型返回多文件，结果可能返回空文件集合。

## 新流程

```mermaid
flowchart TD
  A["PM 输入需求"] --> B["需求澄清"]
  B --> C["方案拆解"]
  C --> D{"是否复杂需求"}
  D -- "是，未 confirmed" --> E["需求确认 stage: needs_confirmation"]
  E --> F["PM 确认或补充 overrides"]
  F --> G["重新提交 confirmed:true"]
  D -- "否或已确认" --> H["创建 Conduit git worktree"]
  G --> H
  H --> I["Agentic Repository Exploration"]
  I --> J["Audited Module Boundary"]
  J --> K["按 implementation slices 生成代码"]
  K --> L{"patch 可应用"}
  L -- "是" --> M["LLM Code Review"]
  L -- "否" --> N["分片整文件 fallback"]
  N --> M
  M --> O{"review pass"}
  O -- "reject" --> I
  O -- "pass" --> P["测试/构建/API smoke"]
  P --> Q{"验证通过"}
  Q -- "失败" --> I
  Q -- "通过" --> R["交付报告 + 知识回写"]
```

## 需求确认节点

复杂需求默认先返回 `needs_confirmation`，不创建 Conduit worktree，也不写目标仓库。返回内容包括：

- 结构化后的需求标题、用户故事、验收标准、开放问题。
- 本次建议的 implementation slices。
- 工具侧假设，例如只做 Conduit 增量改动、禁止修改环境文件和依赖锁文件。
- 给 PM 的确认问题：验收标准是否准确、开放问题如何回答、是否允许修改共享模块。
- 下一步 API 操作：`POST /api/workflows/:runId/confirm`，携带用户输入的 `confirmationOverrides`。

示例：

```json
{
  "confirmationOverrides": {
    "freeText": "coverImage 可为空；只允许 http/https URL；暂不做本地上传；不要修改共享错误类。",
    "acceptanceCriteria": [
      "coverImage 为可选 URL",
      "旧文章无封面图时页面不报错",
      "新建和编辑文章均可保存封面图"
    ],
    "outOfScope": [
      "本期不做本地图片上传"
    ]
  }
}
```

兼容直接重新提交：

```json
{
  "requirement": "原始 PM 需求",
  "confirmed": true,
  "confirmationOverrides": {
    "freeText": "PM 对开放问题的回答"
  }
}
```

## 长链路分片

`solution_planning` 会生成 `implementationSlices`。对于封面图需求，典型分片是：

- `backend-data-model`：Article 模型字段和兼容旧数据。
- `backend-api-contract`：创建、编辑、详情、列表接口的入参/出参。
- `frontend-editor-flow`：新建/编辑表单输入 URL，并提交 payload。
- `frontend-list-rendering`：列表卡片展示封面图或空态。
- `frontend-detail-rendering`：详情页展示封面图。
- `verification-and-review`：测试、构建、API smoke、LLM review。

这些 slices 会进入代码生成 prompt。patch 失败后，fallback 不再一次性要求模型重写所有文件，而是逐 slice 请求整文件写入，并在每个 slice 后把文件写回 worktree。后续 slice 读取的是已经被前序 slice 修改后的当前文件内容。

## 写入策略

P4 沿用 P3 的 Audited Write Policy：

- 可以修改 `frontend/src/` 和 `backend/` 下源码。
- 禁止修改 `node_modules`、构建产物、`package.json`、lockfile、`.env`、`backend/migrations`、`backend/seeders`。
- 超出初始模块边界但位于允许源码根内的文件会被标记为 `audited_source_expansion`，在交付报告中提示人工关注。

## 验收方式

每次 run 完成后，报告仍会输出：

- 本次变更文件。
- 写入审计结果。
- LLM Code Review 的 pass/reject 结论。
- 自动验证结果。
- 本次人工验收建议。

LLM review 使用一票否决策略：如果模型在 `risks` 或 `suggestions` 中提到破坏原有交互、回归、不符合产品逻辑、必须恢复/移除某段行为，即使它误判 `verdict=pass`，工具侧也会归一化为 `reject` 并进入失败回流。

在 LLM review 前还会执行确定性检查：

- 后端变更文件执行 `node --check`，提前发现语法错误。
- `backend/controllers/articles.js` 必须完整导出 `allArticles/createArticle/singleArticle/updateArticle/deleteArticle/articlesFeed`。
- `FormFieldset` 修改不得删除既有 props，且调用方不得传入未被组件支持的 props。
- URL/图片链接类字段不能默认使用 `DataTypes.STRING`，因为 Postgres 会映射为 `varchar(255)`；应使用 `DataTypes.TEXT` 或显式足够长度。
- 提交失败时必须保留后端真实错误，不能把所有错误都降级成 `Submit article failed`。

后端 smoke 会在检测到 `coverImage` 支持时额外创建一篇带长图片 URL 的文章，覆盖 Google 图片结果页这类长链接输入，避免数据库字段长度问题漏过。

对于封面图需求，人工验收建议至少包括：

1. 启动 Conduit。
2. 新建文章，填写封面图 URL。
3. 检查列表卡片展示封面图。
4. 进入详情页检查封面图展示。
5. 编辑文章修改封面图 URL，保存后重新打开确认回显。
