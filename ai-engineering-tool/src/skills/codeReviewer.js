const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chatCompletion } = require("../llm/arkClient");
const { readFilePreview } = require("../repoIndex");

function stripFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function parseJson(content) {
  const stripped = stripFence(content);
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function saveReviewDiff({ gitRootPath, targetRelativePath, runDir }) {
  const pathspec = targetRelativePath || ".";
  execFileSync("git", ["add", "-N", pathspec], {
    cwd: gitRootPath,
    encoding: "utf8",
  });
  const diff = execFileSync("git", ["diff", "--", pathspec], {
    cwd: gitRootPath,
    encoding: "utf8",
  });
  fs.writeFileSync(path.join(runDir, "code-review-diff.patch"), diff);
  return diff;
}

function buildReviewContext({ worktreePath, moduleStage, codeStage }) {
  const files = [
    ...(codeStage?.data?.touchedFiles || []),
    ...(moduleStage?.data?.editBoundary || []),
    ...(moduleStage?.data?.readOnlyFiles || []),
  ];

  return [...new Set(files)]
    .slice(0, 14)
    .map((file) => {
      const content = readFilePreview(worktreePath, file, 7000);
      return [`--- FILE: ${file} ---`, content].join("\n");
    })
    .join("\n\n");
}

function normalizeReview(parsed) {
  const verdict = String(parsed?.verdict || "").toLowerCase() === "pass" ? "pass" : "reject";
  return {
    verdict,
    summary: parsed?.summary || "",
    changedScope: Array.isArray(parsed?.changedScope) ? parsed.changedScope : [],
    estimatedImpact: parsed?.estimatedImpact || "",
    risks: Array.isArray(parsed?.risks) ? parsed.risks : [],
    suggestions: Array.isArray(parsed?.suggestions) ? parsed.suggestions : [],
    requiredChanges: Array.isArray(parsed?.requiredChanges) ? parsed.requiredChanges : [],
  };
}

async function reviewGeneratedCode({
  runDir,
  worktreePath,
  gitRootPath = worktreePath,
  targetRelativePath = ".",
  requirementStage,
  planStage,
  moduleStage,
  codeStage,
}) {
  const diff = saveReviewDiff({ gitRootPath, targetRelativePath, runDir });
  const context = buildReviewContext({ worktreePath, moduleStage, codeStage });
  const prompt = [
    "你是一个严格的 AI Code Review Agent，目标仓库是 Conduit/RealWorld 全栈博客。",
    "请只基于本次需求、模块边界、代码 diff 和相关上下文做审查。",
    "不要挑纯风格偏好；重点审查功能正确性、回归风险、边界条件、安全/数据风险、测试缺口、是否越界修改。",
    "如果发现会导致功能错误、运行时错误、测试明显缺失或修改边界不合理的问题，verdict 必须是 reject。",
    "如果没有阻断性问题，verdict 为 pass，并说明代码变动范围和预估影响。",
    "只输出 JSON，不要 markdown。",
    "",
    "JSON schema:",
    JSON.stringify(
      {
        verdict: "pass | reject",
        summary: "一句话总结",
        changedScope: ["代码变动范围"],
        estimatedImpact: "预估影响",
        risks: ["风险点；pass 时可为空或低风险"],
        suggestions: ["建议修改方向；pass 时可为空"],
        requiredChanges: ["reject 时必须修改项；pass 时为空"],
      },
      null,
      2,
    ),
    "",
    "需求澄清结果:",
    JSON.stringify(requirementStage?.data || {}, null, 2),
    "",
    "方案约束:",
    JSON.stringify(planStage?.data || {}, null, 2),
    "",
    "模块定位:",
    JSON.stringify(moduleStage?.data || {}, null, 2),
    "",
    "代码生成结果:",
    JSON.stringify(codeStage?.data || {}, null, 2),
    "",
    "本次 diff:",
    diff,
    "",
    "相关文件上下文:",
    context,
  ].join("\n");

  const content = await chatCompletion({
    runDir,
    purpose: "code_review",
    temperature: 0.05,
    messages: [
      {
        role: "system",
        content: "你是严谨的一票否决式代码审查 Agent。只输出合法 JSON。",
      },
      { role: "user", content: prompt },
    ],
  });
  fs.writeFileSync(path.join(runDir, "code-review-raw.json"), content);

  const parsed = parseJson(content);
  const review = normalizeReview(parsed);
  fs.writeFileSync(path.join(runDir, "code-review.json"), JSON.stringify(review, null, 2));

  return {
    name: "code_review",
    status: review.verdict === "pass" ? "completed" : "blocked",
    summary:
      review.verdict === "pass"
        ? `LLM code review 通过：${review.summary || "未发现阻断性问题"}`
        : `LLM code review 拒绝：${review.summary || "存在阻断性风险"}`,
    data: {
      ...review,
      diffFile: "code-review-diff.patch",
      rawFile: "code-review-raw.json",
      reviewFile: "code-review.json",
    },
  };
}

module.exports = {
  reviewGeneratedCode,
};
