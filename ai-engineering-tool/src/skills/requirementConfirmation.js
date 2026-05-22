function getRequirementSignals(requirementStage) {
  const data = requirementStage?.data || {};
  return [
    data.title,
    data.userStory,
    ...(data.acceptanceCriteria || []),
    ...(data.openQuestions || []),
    data.implementationLevel,
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
}

function requiresConfirmation(requirementStage) {
  const text = getRequirementSignals(requirementStage);
  const domainSignals = [
    ["data_model", ["模型", "字段", "schema", "model", "database", "数据库", "migration"]],
    ["backend_api", ["接口", "api", "controller", "route", "校验", "validation"]],
    ["frontend_form", ["表单", "输入", "新建", "编辑", "editor", "form"]],
    ["frontend_rendering", ["列表", "详情", "展示", "页面", "tab", "card"]],
    ["auth_or_permissions", ["权限", "认证", "登录", "token", "auth"]],
  ];
  const matchedDomains = domainSignals
    .filter(([, terms]) => terms.some((term) => text.includes(term)))
    .map(([domain]) => domain);
  const acceptanceCount = requirementStage?.data?.acceptanceCriteria?.length || 0;
  return matchedDomains.length >= 2 || acceptanceCount >= 3 || text.includes("全链路");
}

function buildConfirmationStage({ requirementStage, planStage, confirmationOverrides }) {
  const data = requirementStage?.data || {};
  const assumptions = [
    "只在 Conduit 仓库中做增量修改，AI 工程工具代码不写入目标仓库。",
    "保持最小可提测改动，禁止修改环境变量、依赖锁文件、构建产物和 node_modules。",
    "涉及数据库字段时，优先遵循目标仓库现有 Sequelize 模型/同步方式；只有仓库已有迁移约定时才纳入迁移讨论。",
    "涉及前后端链路时，必须同时覆盖数据持久化、API 入参/出参、前端表单提交、页面展示和验证建议。",
  ];

  return {
    name: "requirement_confirmation",
    status: "waiting_for_human",
    summary: `复杂需求需要确认后再生成代码：${data.title || "Conduit 增量需求"}`,
    data: {
      normalizedRequirement: {
        title: data.title || data.normalizedTitle || "Conduit 增量需求",
        userStory: data.userStory || "",
        acceptanceCriteria: data.acceptanceCriteria || [],
        openQuestions: data.openQuestions || [],
        implementationLevel: data.implementationLevel || "unknown",
      },
      proposedScope: planStage?.data?.implementationSlices || [],
      assumptions,
      confirmationInstructions: {
        api: "确认无误后重新 POST /api/workflows，并带上 confirmed:true。需要调整时可同时传 confirmationOverrides。",
        exampleBody: {
          requirement: data.title || "原始需求",
          confirmed: true,
          confirmationOverrides: {
            assumptions: ["可选：补充或覆盖关键假设"],
            acceptanceCriteria: ["可选：补充验收标准"],
          },
        },
      },
      confirmationOverrides: confirmationOverrides || null,
    },
  };
}

function completeConfirmationStage({ requirementStage, planStage, confirmationOverrides }) {
  const waitingStage = buildConfirmationStage({ requirementStage, planStage, confirmationOverrides });
  return {
    ...waitingStage,
    status: "confirmed",
    summary: `需求已确认，进入代码生成：${waitingStage.data.normalizedRequirement.title}`,
  };
}

module.exports = {
  buildConfirmationStage,
  completeConfirmationStage,
  requiresConfirmation,
};
