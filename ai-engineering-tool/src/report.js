const fs = require("fs");
const path = require("path");

function writeDeliveryReport({ runDir, result }) {
  const verification = result.stages.find((stage) => stage.name === "verification");
  const codeGeneration = result.stages.find((stage) => stage.name === "code_generation");
  const report = `# P1 提测说明

## 需求

${result.requirement}

## 运行信息

- runId: ${result.runId}
- branch: ${result.gitWorktree.branch}
- worktree: ${result.gitWorktree.path}

## 代码生成

- 状态: ${codeGeneration?.status || "unknown"}
- 说明: ${codeGeneration?.summary || ""}

## 验证结果

- 测试: ${verification?.data?.test?.status || "unknown"}
- 构建: ${verification?.data?.build?.status || "unknown"}
- diff: ${verification?.data?.diffFile || "changes.patch"}

## 验证命令

\`\`\`bash
npm run test
npm run build -w frontend
\`\`\`

## 人工验收

1. 打开文章详情页。
2. 确认正文下方展示“本文共 XXX 字，预计阅读 X 分钟”。
3. 确认文章标签仍正常展示。
4. 确认未修改后端接口和数据库 schema。
`;

  fs.writeFileSync(path.join(runDir, "delivery-report.md"), report);
}

module.exports = {
  writeDeliveryReport,
};

