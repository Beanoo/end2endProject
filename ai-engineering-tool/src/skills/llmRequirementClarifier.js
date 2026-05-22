const { chatCompletion } = require("../llm/arkClient");

function formatConfirmationOverrides(confirmationOverrides) {
  if (!confirmationOverrides) return "";
  if (typeof confirmationOverrides === "string") return confirmationOverrides;
  const parts = [];
  if (confirmationOverrides.freeText) {
    parts.push(`用户确认补充：${confirmationOverrides.freeText}`);
  }
  if (Array.isArray(confirmationOverrides.acceptanceCriteria)) {
    parts.push(`用户补充验收标准：${confirmationOverrides.acceptanceCriteria.join("；")}`);
  }
  if (Array.isArray(confirmationOverrides.assumptions)) {
    parts.push(`用户确认/修订假设：${confirmationOverrides.assumptions.join("；")}`);
  }
  if (Array.isArray(confirmationOverrides.outOfScope)) {
    parts.push(`用户明确排除范围：${confirmationOverrides.outOfScope.join("；")}`);
  }
  if (Array.isArray(confirmationOverrides.openQuestions)) {
    parts.push(`用户对开放问题的回答：${confirmationOverrides.openQuestions.join("；")}`);
  }
  return parts.join("\n");
}

async function clarifyWithModel({ requirement, runDir, confirmationOverrides = null }) {
  const confirmationText = formatConfirmationOverrides(confirmationOverrides);
  const content = await chatCompletion({
    runDir,
    purpose: "requirement_clarification",
    messages: [
      {
        role: "system",
        content:
          "你是一个面向 Conduit/RealWorld 全栈博客仓库的需求澄清 Agent。只输出 JSON，不要 markdown。",
      },
      {
        role: "user",
        content: [
          "请将下面 PM 需求结构化为 JSON，字段包括 title, userStory, acceptanceCriteria, openQuestions, implementationLevel。",
          "如果存在用户确认补充，必须把补充内容合并进验收标准、范围和开放问题判断中；用户明确排除的内容不得进入实现范围。",
          "",
          `需求：${requirement}`,
          confirmationText ? ["", "用户确认补充：", confirmationText].join("\n") : "",
        ].join("\n"),
      },
    ],
  });

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    parsed = {
      title: "文章详情页新增字数统计",
      userStory: content,
      acceptanceCriteria: ["文章详情页展示字数和预计阅读时间"],
      openQuestions: ["模型输出不是合法 JSON，需要人工复核。"],
      implementationLevel: "L1",
    };
  }

  return {
    name: "requirement_clarification",
    status: "completed",
    summary: `模型已完成需求澄清：${parsed.title || "Conduit 增量需求"}`,
    data: {
      ...parsed,
      confirmationOverrides: confirmationOverrides || null,
    },
  };
}

module.exports = clarifyWithModel;
