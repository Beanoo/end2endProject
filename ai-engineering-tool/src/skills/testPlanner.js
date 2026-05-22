function planTests({ moduleStage, codeStage } = {}) {
  const editBoundary = moduleStage?.data?.editBoundary || [];
  const touchedFiles = codeStage?.data?.touchedFiles || [];
  const files = [...new Set([...editBoundary, ...touchedFiles])];
  const touchesFrontend = files.some((file) => file.startsWith("frontend/"));
  const touchesBackend = files.some((file) => file.startsWith("backend/"));
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
