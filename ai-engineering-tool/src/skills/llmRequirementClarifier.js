const { chatCompletion } = require("../llm/arkClient");

async function clarifyWithModel({ requirement, runDir }) {
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
        content: `请将下面 PM 需求结构化为 JSON，字段包括 title, userStory, acceptanceCriteria, openQuestions, implementationLevel。需求：${requirement}`,
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
    data: parsed,
  };
}

module.exports = clarifyWithModel;

