function buildImplementationSlices(requirement) {
  const data = requirement?.data || {};
  const text = [
    data.title,
    data.userStory,
    ...(data.acceptanceCriteria || []),
    ...(data.openQuestions || []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const slices = [];

  if (/(模型|字段|schema|model|database|数据库|sequelize|持久化|migration)/i.test(text)) {
    slices.push({
      id: "backend-data-model",
      goal: "更新后端数据模型/实体字段，保证新增字段可以被持久化并兼容旧数据。",
      expectedFiles: ["backend/models/"],
      verificationFocus: ["模型字段可为空或有默认值", "不会破坏既有文章创建和读取"],
    });
  }

  if (/(接口|api|controller|route|校验|validation|入参|响应|序列化)/i.test(text)) {
    slices.push({
      id: "backend-api-contract",
      goal: "更新 API 入参、校验、序列化/响应字段，保持 RealWorld article contract 可用。",
      expectedFiles: ["backend/controllers/", "backend/routes/", "backend/helper/"],
      verificationFocus: ["创建/编辑接口接收新增字段", "详情/列表接口返回新增字段"],
    });
  }

  if (/(表单|输入|新建|编辑|editor|form|url)/i.test(text)) {
    slices.push({
      id: "frontend-editor-flow",
      goal: "更新文章新建/编辑表单和提交 payload，使 PM 输入能进入后端。",
      expectedFiles: ["frontend/src/routes/", "frontend/src/services/"],
      verificationFocus: ["新建文章可填写字段", "编辑文章能回显和保存字段"],
    });
  }

  if (/(列表|卡片|feed|preview|card)/i.test(text)) {
    slices.push({
      id: "frontend-list-rendering",
      goal: "更新文章列表/卡片展示，保证新增字段在 feed 中可见且旧数据不报错。",
      expectedFiles: ["frontend/src/components/", "frontend/src/routes/"],
      verificationFocus: ["列表存在新增展示", "无字段时使用空态或不展示"],
    });
  }

  if (/(详情|article page|页面|展示|body)/i.test(text)) {
    slices.push({
      id: "frontend-detail-rendering",
      goal: "更新文章详情页展示，保证新增字段在详情页可见且布局稳定。",
      expectedFiles: ["frontend/src/routes/", "frontend/src/components/"],
      verificationFocus: ["详情页展示新增字段", "旧文章详情页不崩溃"],
    });
  }

  if (slices.length === 0) {
    slices.push({
      id: "single-scope-change",
      goal: "按模块定位结果完成最小可行增量修改。",
      expectedFiles: ["由 module_location 动态决定"],
      verificationFocus: ["核心验收标准通过", "变更范围最小"],
    });
  }

  slices.push({
    id: "verification-and-review",
    goal: "根据实际变更运行测试/构建/API smoke，并执行 LLM code review。",
    expectedFiles: ["不限定源码文件"],
    verificationFocus: ["自动化验证结果可解释", "review pass 或给出 reject 风险与修改方向"],
  });

  return slices;
}

function planSolution({ requirement }) {
  const title = requirement?.data?.title || "Conduit 增量需求";
  const implementationSlices = buildImplementationSlices(requirement);
  return {
    name: "solution_planning",
    status: "completed",
    summary: `已生成通用需求处理方案：${title}`,
    data: {
      tasks: [
        "在 Conduit worktree 中创建隔离分支。",
        "基于需求和仓库索引定位前后端相关模块。",
        "由模型按 implementation slices 在动态编辑边界内生成代码。",
        "patch 应用失败时进入模型修复循环；复杂需求可降级为分片整文件写入。",
        "根据实际变更运行测试、构建并保存 diff。",
      ],
      constraints: [
        "AI 工程工具保持独立，不写入 Conduit 工具代码。",
        "代码修改必须发生在 Conduit worktree 中。",
        "禁止修改 node_modules、dist、lockfile、环境变量文件。",
        "复杂需求默认先输出需求确认 stage，确认后才进入代码生成。",
      ],
      humanGates: ["确认需求", "确认模块边界", "确认 patch 后再 PR"],
      implementationSlices,
    },
  };
}

module.exports = planSolution;
