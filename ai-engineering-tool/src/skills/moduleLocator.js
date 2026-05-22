const fs = require("fs");
const path = require("path");
const { chatCompletion } = require("../llm/arkClient");
const {
  existingTestsFor,
  listSourceFiles,
  selectCandidateFiles,
} = require("../repoIndex");

const allowedNewFilePrefixes = [
  "frontend/src/components/",
  "frontend/src/helpers/",
  "frontend/src/routes/",
  "frontend/src/services/",
  "backend/controllers/",
  "backend/helper/",
  "backend/routes/",
  "backend/models/",
];

function parseJson(content) {
  const trimmed = String(content || "").trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  const match = withoutFence.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function normalizeFiles(worktreePath, files, allowedSet) {
  return [...new Set((files || []).filter(Boolean))]
    .map((file) => String(file).replace(/^\.\//, "").replaceAll("\\", "/"))
    .filter((file) => fs.existsSync(path.join(worktreePath, file)))
    .filter((file) => !allowedSet || allowedSet.has(file));
}

function fallbackBoundary(index) {
  const editBoundary = index.files
    .filter((item) => !item.file.endsWith(".test.js") && !item.file.endsWith(".test.jsx"))
    .slice(0, 8)
    .map((item) => item.file);

  return {
    editBoundary,
    readOnlyFiles: index.files.slice(0, 14).map((item) => item.file),
    noEditAreas: ["node_modules", "dist/build output", "package lockfiles", "environment files"],
    rationale: "模型模块定位不可用时，使用仓库索引和需求关键词评分选择候选边界。",
  };
}

function isSmallUiCopyRequirement(requirementText) {
  const text = String(requirementText || "").toLowerCase();
  const copySignals = ["文案", "标题", "辅助", "提示", "显示", "展示", "label", "text", "copy"];
  const structuralSignals = ["接口", "数据库", "权限", "认证", "新增页面", "schema", "api", "migration"];
  return copySignals.some((term) => text.includes(term)) && !structuralSignals.some((term) => text.includes(term));
}

function rankBoundaryByIndex(files, index) {
  const scoreByFile = new Map(index.files.map((item) => [item.file, item.score]));
  return [...files].sort((a, b) => (scoreByFile.get(b) || 0) - (scoreByFile.get(a) || 0) || a.localeCompare(b));
}

function constrainEditBoundary({ editBoundary, index, requirementText }) {
  if (!isSmallUiCopyRequirement(requirementText)) return editBoundary;
  const frontendOnly = editBoundary.filter((file) => file.startsWith("frontend/src/"));
  const candidates = frontendOnly.length > 0 ? frontendOnly : editBoundary;
  return rankBoundaryByIndex(candidates, index).slice(0, 2);
}

function needsFrontendRouteBoundary(requirementText) {
  const text = String(requirementText || "").toLowerCase();
  const routeSignals = ["tab", "route", "页面", "子路由", "导航", "nav", "about me", "favorited articles"];
  return text.includes("profile") && routeSignals.some((term) => text.includes(term));
}

function supplementEditBoundary({ editBoundary, worktreePath, requirementText }) {
  const supplemented = [...editBoundary];
  const routeRegistry = "frontend/src/main.jsx";
  if (
    needsFrontendRouteBoundary(requirementText) &&
    fs.existsSync(path.join(worktreePath, routeRegistry)) &&
    !supplemented.includes(routeRegistry)
  ) {
    supplemented.push(routeRegistry);
  }
  return supplemented;
}

function supplementReadOnlyFiles({ readOnlyFiles, worktreePath, requirementText }) {
  const supplemented = [...readOnlyFiles];
  const text = String(requirementText || "").toLowerCase();
  const profileContextFiles = [
    "frontend/src/components/AuthorInfo/AuthorInfo.jsx",
    "frontend/src/services/getProfile.js",
  ];

  if (text.includes("profile")) {
    for (const file of profileContextFiles) {
      if (fs.existsSync(path.join(worktreePath, file)) && !supplemented.includes(file)) {
        supplemented.push(file);
      }
    }
  }

  return supplemented;
}

async function locateModules(worktreePath, { requirementStage, runDir }) {
  const requirementText = [
    requirementStage?.data?.title,
    requirementStage?.data?.userStory,
    ...(requirementStage?.data?.acceptanceCriteria || []),
    ...(requirementStage?.data?.openQuestions || []),
  ]
    .filter(Boolean)
    .join("\n");
  const index = selectCandidateFiles(worktreePath, requirementText);
  const allFiles = listSourceFiles(worktreePath);
  const sourceFileSet = new Set(allFiles);
  const candidateSummary = index.files
    .map((item) => {
      const preview = item.preview.replace(/\s+/g, " ").slice(0, 500);
      return `- ${item.file} (score=${item.score})\n  preview: ${preview}`;
    })
    .join("\n");

  let modelDecision = null;
  try {
    const content = await chatCompletion({
      runDir,
      purpose: "module_location",
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content:
            "你是 Conduit 全栈仓库的模块定位 Agent。只输出 JSON，不要 markdown。",
        },
        {
          role: "user",
          content: [
            "请基于 PM 需求和候选源码文件，选择最小编辑边界。",
            "JSON 字段：editBoundary(string[]), readOnlyFiles(string[]), noEditAreas(string[]), rationale(string)。",
            "约束：editBoundary 只能选择候选文件中已经存在的源码文件；不要选择 node_modules、dist、package-lock、.env、迁移文件。",
            "",
            "PM 需求：",
            requirementText,
            "",
            "候选文件：",
            candidateSummary,
          ].join("\n"),
        },
      ],
    });
    modelDecision = parseJson(content);
  } catch (error) {
    modelDecision = {
      ...fallbackBoundary(index),
      modelError: error.message,
    };
  }

  const fallback = fallbackBoundary(index);
  const editBoundary = normalizeFiles(worktreePath, modelDecision?.editBoundary, sourceFileSet);
  const readOnlyFiles = normalizeFiles(worktreePath, modelDecision?.readOnlyFiles, sourceFileSet);
  const unconstrainedBoundary = editBoundary.length > 0 ? editBoundary : fallback.editBoundary;
  const constrainedEditBoundary = constrainEditBoundary({
    editBoundary: unconstrainedBoundary,
    index,
    requirementText,
  });
  const finalEditBoundary = supplementEditBoundary({
    editBoundary: constrainedEditBoundary,
    worktreePath,
    requirementText,
  });
  const finalReadOnlyFiles = supplementReadOnlyFiles({
    readOnlyFiles: readOnlyFiles.length > 0 ? readOnlyFiles : fallback.readOnlyFiles,
    worktreePath,
    requirementText,
  });
  const relatedTests = existingTestsFor(finalEditBoundary, allFiles);
  const files = [...new Set([...finalEditBoundary, ...finalReadOnlyFiles, ...relatedTests])]
    .map((file) => ({
      exists: fs.existsSync(path.join(worktreePath, file)),
      path: file,
      role: finalEditBoundary.includes(file) ? "editable" : "context",
    }));

  return {
    name: "module_location",
    status: finalEditBoundary.length > 0 ? "completed" : "blocked",
    summary: `已基于需求动态定位 ${finalEditBoundary.length} 个可编辑文件。`,
    data: {
      files,
      matchedDomains: index.matchedDomains,
      totalIndexedFiles: index.totalIndexedFiles,
      editBoundary: finalEditBoundary,
      primaryEditBoundary: finalEditBoundary,
      readOnlyFiles: finalReadOnlyFiles,
      relatedTests,
      allowedNewFilePrefixes,
      noEditAreas: modelDecision?.noEditAreas || fallback.noEditAreas,
      rationale: modelDecision?.rationale || fallback.rationale,
      unconstrainedEditBoundary: unconstrainedBoundary,
      locatedBy: modelDecision?.modelError ? "heuristic_after_model_failure" : "model_with_index",
    },
  };
}

module.exports = locateModules;
