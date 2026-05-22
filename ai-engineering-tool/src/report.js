const fs = require("fs");
const path = require("path");

function writeDeliveryReport({ runDir, result }) {
  const verification = result.stages.find((stage) => stage.name === "verification");
  const codeGeneration = result.stages.find((stage) => stage.name === "code_generation");
  const codeReview = result.stages.find((stage) => stage.name === "code_review");
  const moduleLocation = result.stages.find((stage) => stage.name === "module_location");
  const touchedFiles = codeGeneration?.data?.touchedFiles || moduleLocation?.data?.editBoundary || [];
  const report = `# AI 工程工具提测说明

## 需求

${result.requirement || "未记录原始需求"}

## 运行信息

- runId: ${result.runId}
- branch: ${result.gitWorktree.branch}
- worktree: ${result.gitWorktree.path}

## 代码生成

- 状态: ${codeGeneration?.status || "unknown"}
- 说明: ${codeGeneration?.summary || ""}
- 应用方式: ${codeGeneration?.data?.appliedBy || "unknown"}

## 变更文件

${touchedFiles.map((file) => `- ${file}`).join("\n") || "- 未记录"}

## LLM Code Review

- 结论: ${codeReview?.data?.verdict || "unknown"}
- 摘要: ${codeReview?.data?.summary || ""}
- 预估影响: ${codeReview?.data?.estimatedImpact || ""}
- 风险点: ${(codeReview?.data?.risks || []).join("；") || "无"}
- 建议修改方向: ${(codeReview?.data?.suggestions || []).join("；") || "无"}

## 验证结果

- 测试: ${verification?.data?.test?.status || "unknown"}
- 构建: ${verification?.data?.build?.status || "unknown"}
- 后端 smoke: ${verification?.data?.backendSmoke?.status || "unknown"}
- diff: ${verification?.data?.diffFile || "changes.patch"}

## 验证命令

\`\`\`bash
npm run test
npm run build -w frontend
PORT=3101 npm run dev -w backend
\`\`\`

## 人工验收

1. 根据需求打开受影响的 Conduit 页面或 API。
2. 对照验收标准检查核心行为。
3. 检查本次 diff 是否只落在模块定位阶段给出的边界内。
4. 如果涉及后端接口，补充 API 手工验证或 E2E 验证。
`;

  fs.writeFileSync(path.join(runDir, "delivery-report.md"), report);
}

module.exports = {
  writeDeliveryReport,
};
