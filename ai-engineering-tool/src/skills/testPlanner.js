function planTests({ moduleStage } = {}) {
  const editBoundary = moduleStage?.data?.editBoundary || [];
  const touchesFrontend = editBoundary.some((file) => file.startsWith("frontend/"));
  const touchesBackend = editBoundary.some((file) => file.startsWith("backend/"));
  const commands = ["npm run test"];

  if (touchesFrontend || !touchesBackend) {
    commands.push("npm run build -w frontend");
  }

  return {
    name: "test_planning",
    status: "completed",
    summary: "已根据动态模块边界生成验证命令。",
    data: {
      commands,
      touchedAreas: {
        frontend: touchesFrontend,
        backend: touchesBackend,
      },
      futureCommands: ["npm run dev", "manual browser/E2E check for changed user flow"],
    },
  };
}

module.exports = planTests;
