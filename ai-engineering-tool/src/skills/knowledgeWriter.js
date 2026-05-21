function writeKnowledge(context) {
  const editBoundary = context.moduleStage?.data?.editBoundary || [];
  const matchedDomains = context.moduleStage?.data?.matchedDomains || [];
  return {
    name: "knowledge_write",
    status: "completed",
    summary: "已沉淀 Conduit 通用需求处理知识草案。",
    data: {
      pattern: "conduit dynamic requirement delivery",
      targetRepo: context.targetRepo,
      matchedDomains: matchedDomains.map((domain) => domain.name),
      reusableFiles: editBoundary,
      editBoundary,
      nextStep: "P2 should index this knowledge for future module-location retrieval.",
    },
  };
}

module.exports = writeKnowledge;
