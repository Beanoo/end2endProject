function packageDelivery(context) {
  return {
    name: "delivery_packaging",
    status: "gated",
    summary: "已生成 PR-ready 草案；P1 接入真实 patch 和 diff。",
    data: {
      branch: context.gitWorktree.branch,
      worktree: context.gitWorktree.path,
      prTitle: "[L1] Add article word count estimate",
      verification: ["npm run test", "npm run build -w frontend"],
    },
  };
}

module.exports = packageDelivery;

