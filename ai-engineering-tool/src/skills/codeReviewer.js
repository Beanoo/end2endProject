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

function readChangedFiles({ gitRootPath, targetRelativePath }) {
  const pathspec = targetRelativePath || ".";
  const output = execFileSync("git", ["diff", "--name-status", "--", pathspec], {
    cwd: gitRootPath,
    encoding: "utf8",
  });
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [status, file] = line.split(/\s+/, 2);
      return { status, file };
    });
}

function moduleToken(file) {
  return path.basename(file, path.extname(file));
}

function readTextIfExists(filePath) {
  if (!fs.existsSync(filePath)) return "";
  return fs.readFileSync(filePath, "utf8");
}

function runBackendSyntaxChecks({ worktreePath, changedFiles }) {
  const findings = [];
  const backendFiles = changedFiles
    .map((item) => item.file)
    .filter((file) => file.startsWith("backend/") && file.endsWith(".js"));

  for (const file of backendFiles) {
    try {
      execFileSync("node", ["--check", path.join(worktreePath, file)], {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      findings.push({
        file,
        message: `后端 JS 语法检查失败：${String(error.stderr || error.message).trim()}`,
      });
    }
  }

  return findings;
}

function checkArticlesControllerExports({ worktreePath, changedFiles }) {
  const touched = changedFiles.some((item) => item.file === "backend/controllers/articles.js");
  if (!touched) return [];
  const file = "backend/controllers/articles.js";
  const content = readTextIfExists(path.join(worktreePath, file));
  const requiredExports = [
    "allArticles",
    "createArticle",
    "singleArticle",
    "updateArticle",
    "deleteArticle",
    "articlesFeed",
  ];
  const moduleExportsMatch = content.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);

  if (!moduleExportsMatch) {
    return [{ file, message: "articles controller 缺少完整的 module.exports = { ... }; 导出块。" }];
  }

  const exportBlock = moduleExportsMatch[1];
  const missing = requiredExports.filter((name) => !new RegExp(`\\b${name}\\b`).test(exportBlock));
  if (missing.length === 0) return [];
  return [{
    file,
    message: `articles controller 导出不完整，缺少：${missing.join(", ")}。`,
  }];
}

function checkUrlFieldStorage({ worktreePath, changedFiles, requirementStage }) {
  const text = [
    requirementStage?.data?.title,
    requirementStage?.data?.userStory,
    ...(requirementStage?.data?.acceptanceCriteria || []),
    ...(requirementStage?.data?.openQuestions || []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  const urlRequirement = /url|链接|图片|image|cover/.test(text);
  if (!urlRequirement) return [];

  return changedFiles
    .map((item) => item.file)
    .filter((file) => file.startsWith("backend/models/") && file.endsWith(".js"))
    .flatMap((file) => {
      const content = readTextIfExists(path.join(worktreePath, file));
      const findings = [];
      const urlStringFieldPattern =
        /(?:coverImage|imageUrl|imageURL|coverUrl|coverURL|.*Url|.*URL)\s*:\s*(?:DataTypes\.STRING|\{\s*type:\s*DataTypes\.STRING)/g;
      const matches = content.match(urlStringFieldPattern) || [];

      if (matches.length > 0) {
        findings.push({
          file,
          message:
            "URL/图片链接类字段使用了 DataTypes.STRING，Postgres 会映射为 varchar(255)，长图片链接会保存失败；应使用 DataTypes.TEXT 或显式足够长度。",
        });
      }
      return findings;
    });
}

function checkErrorMessagePropagation({ worktreePath, changedFiles }) {
  const touched = changedFiles.some(
    (item) => item.file === "frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx",
  );
  if (!touched) return [];

  const file = "frontend/src/components/ArticleEditorForm/ArticleEditorForm.jsx";
  const content = readTextIfExists(path.join(worktreePath, file));
  const swallowsThrownString =
    content.includes("Submit article failed") &&
    content.includes("err?.response?.data") &&
    !content.includes("typeof err === \"string\"") &&
    !content.includes("typeof err === 'string'");

  if (!swallowsThrownString) return [];
  return [{
    file,
    message:
      "提交失败处理只读取 err.response，无法展示 errorHandler 抛出的字符串错误，会把真实后端错误降级成 Submit article failed。",
  }];
}

function extractDestructuredProps(content, componentName) {
  const match = content.match(new RegExp(`function\\s+${componentName}\\s*\\(\\s*\\{([\\s\\S]*?)\\}\\s*\\)`));
  if (!match) return new Set();
  return new Set(
    match[1]
      .split(",")
      .map((item) => item.trim().replace(/\s*=.*$/, ""))
      .filter(Boolean),
  );
}

function checkFormFieldsetCompatibility({ gitRootPath, worktreePath, changedFiles }) {
  const file = "frontend/src/components/FormFieldset/FormFieldset.jsx";
  const changedFileNames = changedFiles.map((item) => item.file);
  const currentContent = readTextIfExists(path.join(worktreePath, file));
  if (!currentContent) return [];

  let baseContent = "";
  try {
    baseContent = execFileSync("git", ["show", `HEAD:${file}`], {
      cwd: gitRootPath,
      encoding: "utf8",
    });
  } catch {
    baseContent = "";
  }

  const currentProps = extractDestructuredProps(currentContent, "FormFieldset");
  const baseProps = extractDestructuredProps(baseContent, "FormFieldset");
  const findings = [];
  const removedProps = [...baseProps].filter((prop) => !currentProps.has(prop));

  if (changedFileNames.includes(file) && removedProps.length > 0) {
    findings.push({
      file,
      message: `FormFieldset 移除了既有 props：${removedProps.join(", ")}，会破坏现有表单调用。`,
    });
  }

  const filesToScan = changedFileNames.filter((changedFile) => changedFile.startsWith("frontend/src/"));
  const unsupportedUsages = [];
  for (const changedFile of filesToScan) {
    const content = readTextIfExists(path.join(worktreePath, changedFile));
    const matches = content.matchAll(/<FormFieldset\s+([^>]*?)\/?>/gs);
    for (const match of matches) {
      const attrs = [...match[1].matchAll(/\s([A-Za-z_$][\w$-]*)=/g)].map((attr) => attr[1]);
      const unsupported = attrs.filter((attr) => !currentProps.has(attr));
      if (unsupported.length > 0) {
        unsupportedUsages.push(`${changedFile}: ${unsupported.join(", ")}`);
      }
    }
  }

  if (unsupportedUsages.length > 0) {
    findings.push({
      file,
      message: `FormFieldset 调用传入了组件未声明的 props：${unsupportedUsages.join("；")}。`,
    });
  }

  return findings;
}

function deterministicReview({ gitRootPath, worktreePath, changedFiles, requirementStage }) {
  const addedFrontendFiles = changedFiles
    .filter((item) => item.status === "A" && item.file.startsWith("frontend/src/"))
    .map((item) => item.file);
  const changedExistingFiles = changedFiles
    .filter((item) => item.status !== "A")
    .map((item) => item.file);

  const orphanFiles = addedFrontendFiles.filter((file) => {
    const token = moduleToken(file);
    return !changedExistingFiles.some((changedFile) => {
      const content = readFilePreview(worktreePath, changedFile, 20000);
      return content.includes(token) || content.includes(file.replace(/^frontend\/src\//, "./"));
    });
  });

  if (orphanFiles.length > 0) {
    return {
      verdict: "reject",
      summary: `新增前端文件未被任何既有变更文件接入：${orphanFiles.join(", ")}`,
      changedScope: changedFiles.map((item) => item.file),
      estimatedImpact: "新增文件可能只是孤立源码，build 可通过但功能不会在真实页面或路由中生效。",
      risks: ["存在未接入真实入口的新增前端文件，人工访问目标页面时可能看不到需求效果。"],
      suggestions: ["在既有路由入口、页面组件或真实调用链中接入新增文件，或直接修改现有已接入文件。"],
      requiredChanges: [`接入或移除孤立新增文件：${orphanFiles.join(", ")}`],
    };
  }

  const findings = [
    ...runBackendSyntaxChecks({ worktreePath, changedFiles }),
    ...checkArticlesControllerExports({ worktreePath, changedFiles }),
    ...checkUrlFieldStorage({ worktreePath, changedFiles, requirementStage }),
    ...checkErrorMessagePropagation({ worktreePath, changedFiles }),
    ...checkFormFieldsetCompatibility({ gitRootPath, worktreePath, changedFiles }),
  ];

  if (findings.length > 0) {
    return {
      verdict: "reject",
      summary: `确定性检查发现 ${findings.length} 个阻断问题。`,
      changedScope: changedFiles.map((item) => item.file),
      estimatedImpact: "这些问题会导致服务启动失败、表单交互失效或核心模块导出不完整，必须在进入 LLM review 前修复。",
      risks: findings.map((finding) => `${finding.file}: ${finding.message}`),
      suggestions: ["优先修复确定性检查列出的文件，再重新进入代码生成或 review。"],
      requiredChanges: findings.map((finding) => `${finding.file}: ${finding.message}`),
    };
  }

  return null;
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
  let verdict = String(parsed?.verdict || "").toLowerCase() === "pass" ? "pass" : "reject";
  const risks = Array.isArray(parsed?.risks) ? parsed.risks : [];
  const suggestions = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];
  const requiredChanges = Array.isArray(parsed?.requiredChanges) ? parsed.requiredChanges : [];
  const reviewText = [...risks, ...suggestions, ...requiredChanges].join("\n");
  const blockingSignals = [
    "破坏",
    "回归",
    "不符合",
    "无法",
    "报错",
    "误删",
    "丢失",
    "阻断",
    "必须",
    "移除",
    "restore",
    "regression",
    "breaking",
  ];

  if (verdict === "pass" && requiredChanges.length > 0) {
    verdict = "reject";
  }
  if (verdict === "pass" && blockingSignals.some((signal) => reviewText.toLowerCase().includes(signal))) {
    verdict = "reject";
  }

  return {
    verdict,
    summary: parsed?.summary || "",
    changedScope: Array.isArray(parsed?.changedScope) ? parsed.changedScope : [],
    estimatedImpact: parsed?.estimatedImpact || "",
    risks,
    suggestions,
    requiredChanges,
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
  const changedFiles = readChangedFiles({ gitRootPath, targetRelativePath });
  const deterministicRejection = deterministicReview({
    gitRootPath,
    worktreePath,
    changedFiles,
    requirementStage,
  });
  if (deterministicRejection) {
    fs.writeFileSync(path.join(runDir, "code-review-raw.json"), JSON.stringify(deterministicRejection, null, 2));
    fs.writeFileSync(path.join(runDir, "code-review.json"), JSON.stringify(deterministicRejection, null, 2));
    return {
      name: "code_review",
      status: "blocked",
      summary: `确定性 code review 拒绝：${deterministicRejection.summary}`,
      data: {
        ...deterministicRejection,
        diffFile: "code-review-diff.patch",
        rawFile: "code-review-raw.json",
        reviewFile: "code-review.json",
      },
    };
  }
  const context = buildReviewContext({ worktreePath, moduleStage, codeStage });
  const prompt = [
    "你是一个严格的 AI Code Review Agent，目标仓库是 Conduit/RealWorld 全栈博客。",
    "请只基于本次需求、模块边界、代码 diff 和相关上下文做审查。",
    "不要挑纯风格偏好；重点审查功能正确性、回归风险、边界条件、安全/数据风险、测试缺口、是否越界修改。",
    "如果发现会导致功能错误、运行时错误、测试明显缺失或修改边界不合理的问题，verdict 必须是 reject。",
    "如果风险或建议中包含破坏原有交互、回归、不符合产品逻辑、必须恢复/移除某段行为，verdict 必须是 reject，不能 pass。",
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
    "写入审计:",
    JSON.stringify(codeStage?.data?.writeAudit || [], null, 2),
    "",
    "审计要求:",
    "如果 writeAudit 中存在 requiresHumanAttention=true 的文件，请判断它是否确实由需求或失败反馈驱动；若无法解释必要性，verdict 必须 reject。",
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
