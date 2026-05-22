const fs = require("fs");
const path = require("path");
const { chatCompletion } = require("../llm/arkClient");
const {
  existingTestsFor,
  listSourceFiles,
  selectCandidateFiles,
} = require("../repoIndex");
const { buildExploration } = require("../repoExplorer");

const allowedNewFilePrefixes = [
  "frontend/src/",
  "frontend/src/components/",
  "frontend/src/helpers/",
  "frontend/src/routes/",
  "frontend/src/services/",
  "backend/",
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

function buildRepositoryMap(files) {
  const grouped = new Map();
  for (const file of files) {
    const segment = file.split("/").slice(0, 3).join("/");
    if (!grouped.has(segment)) grouped.set(segment, []);
    grouped.get(segment).push(file);
  }

  return [...grouped.entries()]
    .map(([segment, segmentFiles]) => {
      const visible = segmentFiles.slice(0, 30).map((file) => `  - ${file}`).join("\n");
      const suffix = segmentFiles.length > 30 ? `\n  ... ${segmentFiles.length - 30} more` : "";
      return `${segment}\n${visible}${suffix}`;
    })
    .join("\n\n");
}

async function runAgenticExploration({ runDir, requirementText, feedbackText, allFiles, candidateSummary }) {
  const repoMap = buildRepositoryMap(allFiles);
  const content = await chatCompletion({
    runDir,
    purpose: feedbackText ? "agentic_repo_exploration_retry" : "agentic_repo_exploration",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "你是代码仓库探索 Agent。只输出 JSON，不要 markdown。",
      },
      {
        role: "user",
        content: [
          "请像工程师一样先探索仓库，不要急着收窄到少数文件。",
          "目标：基于需求判断还应该读取哪些文件、哪些文件可能需要修改、为什么。",
          "JSON 字段：filesToInspect(string[]), writeCandidates(string[]), searchTerms(string[]), rationale(string)。",
          "约束：只能选择仓库地图中存在的源码文件；不要选择 node_modules、dist、package-lock、.env、迁移文件。",
          "",
          "PM 需求：",
          requirementText,
          feedbackText ? ["", "失败反馈：", feedbackText].join("\n") : "",
          "",
          "关键词候选：",
          candidateSummary,
          "",
          "仓库地图：",
          repoMap,
        ].join("\n"),
      },
    ],
  });

  return parseJson(content) || {};
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

function rankBoundaryByIndex(files, index) {
  const scoreByFile = new Map(index.files.map((item) => [item.file, item.score]));
  return [...files].sort((a, b) => (scoreByFile.get(b) || 0) - (scoreByFile.get(a) || 0) || a.localeCompare(b));
}

function normalizeFeedback(feedback) {
  return [
    feedback?.reason,
    feedback?.summary,
    feedback?.error,
    ...(feedback?.failedFiles || []),
    ...(feedback?.missingFiles || []),
  ]
    .filter(Boolean)
    .join("\n");
}

function extractFailureFiles(text, allFiles) {
  const found = new Set();
  const sourcePathPattern = /(?:src\/|frontend\/src\/|backend\/)[A-Za-z0-9_./-]+\.(?:js|jsx|mjs|cjs|json|css)/g;
  const matches = String(text || "").match(sourcePathPattern) || [];
  for (const match of matches) {
    const normalized = match.startsWith("src/") ? `frontend/${match}` : match;
    if (allFiles.includes(normalized)) found.add(normalized);
  }
  return [...found];
}

function buildBoundarySets({ worktreePath, index, modelDecision, fallback, allFiles, requirementText, feedback }) {
  const sourceFileSet = new Set(allFiles);
  const modelEditBoundary = normalizeFiles(worktreePath, modelDecision?.editBoundary, sourceFileSet);
  const modelReadOnlyFiles = normalizeFiles(worktreePath, modelDecision?.readOnlyFiles, sourceFileSet);
  const agentWriteCandidates = normalizeFiles(worktreePath, modelDecision?.agenticExploration?.writeCandidates, sourceFileSet);
  const agentInspectFiles = normalizeFiles(worktreePath, modelDecision?.agenticExploration?.filesToInspect, sourceFileSet);
  const seedBoundary = [...new Set([
    ...(modelEditBoundary.length > 0 ? modelEditBoundary : fallback.editBoundary),
    ...agentWriteCandidates,
  ])];
  const feedbackText = normalizeFeedback(feedback);
  const feedbackFiles = extractFailureFiles(feedbackText, allFiles);
  const exploration = buildExploration(worktreePath, [...seedBoundary, ...feedbackFiles], index.terms);
  const editableExploredFiles = exploration
    .filter((item) => item.reason.startsWith("imports ") || item.reason === "structural file references seed module")
    .map((item) => item.file);
  const exploredFiles = exploration.map((item) => item.file);
  const candidateEditBoundary = rankBoundaryByIndex(
    [...new Set([...seedBoundary, ...feedbackFiles, ...editableExploredFiles])],
    index,
  ).slice(0, feedback ? 12 : 8);
  const readOnlyFiles = [
    ...agentInspectFiles,
    ...modelReadOnlyFiles,
    ...fallback.readOnlyFiles,
    ...exploredFiles.filter((file) => !candidateEditBoundary.includes(file)),
  ];

  return {
    editBoundary: candidateEditBoundary,
    readOnlyFiles: [...new Set(readOnlyFiles)].slice(0, 24),
    exploration,
    unconstrainedBoundary: seedBoundary,
  };
}

async function locateModules(worktreePath, { requirementStage, runDir, feedback } = {}) {
  const requirementText = [
    requirementStage?.data?.title,
    requirementStage?.data?.userStory,
    ...(requirementStage?.data?.acceptanceCriteria || []),
    ...(requirementStage?.data?.openQuestions || []),
  ]
    .filter(Boolean)
    .join("\n");
  const feedbackText = normalizeFeedback(feedback);
  const locationText = [requirementText, feedbackText].filter(Boolean).join("\n\n失败反馈：\n");
  const index = selectCandidateFiles(worktreePath, locationText);
  const allFiles = listSourceFiles(worktreePath);
  const candidateSummary = index.files
    .map((item) => {
      const preview = item.preview.replace(/\s+/g, " ").slice(0, 500);
      return `- ${item.file} (score=${item.score})\n  preview: ${preview}`;
    })
    .join("\n");
  const agenticExploration = await runAgenticExploration({
    runDir,
    requirementText,
    feedbackText,
    allFiles,
    candidateSummary,
  });

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
            "如果需求涉及路由、Tab、导航、API 调用链、组件复用，必须把对应入口、被调用服务、被渲染组件纳入 editBoundary 或 readOnlyFiles。",
            "",
            "PM 需求：",
            requirementText,
            feedbackText ? ["", "上一次失败反馈：", feedbackText].join("\n") : "",
            "",
            "候选文件：",
            candidateSummary,
          ].join("\n"),
        },
      ],
    });
    modelDecision = parseJson(content);
    if (modelDecision) modelDecision.agenticExploration = agenticExploration;
  } catch (error) {
    modelDecision = {
      ...fallbackBoundary(index),
      agenticExploration,
      modelError: error.message,
    };
  }

  const fallback = fallbackBoundary(index);
  const boundarySets = buildBoundarySets({
    worktreePath,
    index,
    modelDecision,
    fallback,
    allFiles,
    requirementText,
    feedback,
  });
  const relatedTests = existingTestsFor(boundarySets.editBoundary, allFiles);
  const files = [...new Set([...boundarySets.editBoundary, ...boundarySets.readOnlyFiles, ...relatedTests])]
    .map((file) => ({
      exists: fs.existsSync(path.join(worktreePath, file)),
      path: file,
      role: boundarySets.editBoundary.includes(file) ? "editable" : "context",
    }));

  return {
    name: "module_location",
    status: boundarySets.editBoundary.length > 0 ? "completed" : "blocked",
    summary: `已基于探索式边界定位 ${boundarySets.editBoundary.length} 个可编辑文件。`,
    data: {
      files,
      matchedDomains: index.matchedDomains,
      totalIndexedFiles: index.totalIndexedFiles,
      editBoundary: boundarySets.editBoundary,
      primaryEditBoundary: boundarySets.editBoundary,
      readOnlyFiles: boundarySets.readOnlyFiles,
      relatedTests,
      allowedNewFilePrefixes,
      noEditAreas: modelDecision?.noEditAreas || fallback.noEditAreas,
      rationale: modelDecision?.rationale || fallback.rationale,
      exploration: boundarySets.exploration,
      agenticExploration,
      writePolicy: {
        mode: "audited_source",
        hardBlocked: ["node_modules", "dist/build output", "package lockfiles", "environment files", "backend migrations/seeders"],
        allowedExistingSourceRoots: ["frontend/src/", "backend/"],
        allowedNewFilePrefixes,
      },
      failureFeedback: feedback || null,
      unconstrainedEditBoundary: boundarySets.unconstrainedBoundary,
      locatedBy: modelDecision?.modelError ? "heuristic_after_model_failure" : "model_with_index",
    },
  };
}

module.exports = locateModules;
