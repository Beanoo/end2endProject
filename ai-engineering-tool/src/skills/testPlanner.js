function planTests() {
  return {
    name: "test_planning",
    status: "completed",
    summary: "已生成 P0/P1 验证命令。",
    data: {
      commands: ["npm run test", "npm run build -w frontend"],
      futureCommands: ["npm run dev", "manual check: article detail page"],
    },
  };
}

module.exports = planTests;

