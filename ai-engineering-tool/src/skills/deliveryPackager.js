function packageDelivery(context) {
  const title = context.requirementStage?.data?.title || "Conduit increment";
  const touchedFiles = context.codeStage?.data?.touchedFiles || context.moduleStage?.data?.editBoundary || [];
  return {
    name: "delivery_packaging",
    status: "gated",
    summary: "已生成 PR-ready 草案；P2 使用动态模块边界和模型修复循环。",
    data: {
      branch: context.gitWorktree.branch,
      worktree: context.gitWorktree.path,
      prTitle: `[AI] ${title}`,
      touchedFiles,
      verification: ["npm run test", "npm run build -w frontend"],
    },
  };
}

module.exports = packageDelivery;
