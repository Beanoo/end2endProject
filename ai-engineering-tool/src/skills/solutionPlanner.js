function planSolution({ requirement }) {
  const title = requirement?.data?.title || "Conduit 增量需求";
  return {
    name: "solution_planning",
    status: "completed",
    summary: `已生成通用需求处理方案：${title}`,
    data: {
      tasks: [
        "在 Conduit worktree 中创建隔离分支。",
        "基于需求和仓库索引定位前后端相关模块。",
        "由模型在动态编辑边界内生成 unified diff patch。",
        "patch 应用失败时进入模型修复循环。",
        "根据实际变更运行测试、构建并保存 diff。",
      ],
      constraints: [
        "AI 工程工具保持独立，不写入 Conduit 工具代码。",
        "代码修改必须发生在 Conduit worktree 中。",
        "禁止修改 node_modules、dist、lockfile、环境变量文件。",
        "P2 暂不实现可交互人工确认节点，但保留 stage 数据结构。",
      ],
      humanGates: ["确认需求", "确认模块边界", "确认 patch 后再 PR"],
    },
  };
}

module.exports = planSolution;
