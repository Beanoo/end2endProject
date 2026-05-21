function planSolution() {
  return {
    name: "solution_planning",
    status: "completed",
    summary: "已生成 L1 前端增量方案，代码写入在 P1 作为受控 patch 执行。",
    data: {
      tasks: [
        "在 Conduit worktree 中创建隔离分支。",
        "定位文章详情页渲染文件。",
        "P1 增加字数/阅读时间计算 helper。",
        "P1 将结果渲染到文章正文下方。",
        "运行测试和前端构建。",
      ],
      humanGates: ["确认需求", "确认模块边界", "确认 patch 后再 PR"],
    },
  };
}

module.exports = planSolution;

