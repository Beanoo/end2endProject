function writeKnowledge(context) {
  return {
    name: "knowledge_write",
    status: "completed",
    summary: "已沉淀 Conduit L1 前端增强模式知识草案。",
    data: {
      pattern: "frontend-only article detail enhancement",
      targetRepo: context.targetRepo,
      reusableFiles: ["frontend/src/routes/Article/Article.jsx"],
      nextStep: "P1 should apply a controlled patch in the worktree.",
    },
  };
}

module.exports = writeKnowledge;

