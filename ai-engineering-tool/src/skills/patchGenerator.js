const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chatCompletion } = require("../llm/arkClient");
const { readFilePreview } = require("../repoIndex");

const defaultAllowedNewFilePrefixes = [
  "frontend/src/components/",
  "frontend/src/helpers/",
  "frontend/src/routes/",
  "frontend/src/services/",
  "backend/controllers/",
  "backend/helper/",
  "backend/routes/",
  "backend/models/",
];
const blockedPathPatterns = [
  /^node_modules\//,
  /^frontend\/dist\//,
  /^dist\//,
  /^build\//,
  /^\.env/,
  /\/\.env/,
  /package-lock\.json$/,
  /package\.json$/,
  /^backend\/migrations\//,
  /^backend\/seeders\//,
];

function stripFence(text) {
  return String(text || "")
    .trim()
    .replace(/^```(?:diff|patch)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function normalizeUnifiedDiff(patch) {
  const trimmed = stripFence(patch);
  const lines = trimmed.split("\n");
  const normalized = [];
  let i = 0;
  let pendingDiffHeader = null;

  while (i < lines.length) {
    const diffHeader = lines[i]?.match(/^diff --git\s+a\/(.+)\s+b\/(.+)$/);
    if (diffHeader) {
      pendingDiffHeader = lines[i];
      i += 1;
      continue;
    }

    if (/^index\s+/.test(lines[i] || "")) {
      i += 1;
      continue;
    }

    const oldFile = lines[i]?.match(/^---\s+(?:a\/)?(.+)$/);
    const newFile = lines[i + 1]?.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (oldFile && newFile) {
      const oldPath = oldFile[1].trim();
      const newPath = newFile[1].trim();
      normalized.push(pendingDiffHeader || `diff --git a/${oldPath} b/${newPath}`);
      normalized.push(`--- a/${oldPath}`);
      normalized.push(`+++ b/${newPath}`);
      pendingDiffHeader = null;
      i += 2;
      continue;
    }
    if (pendingDiffHeader) {
      normalized.push(pendingDiffHeader);
      pendingDiffHeader = null;
    }
    normalized.push(lines[i]);
    i += 1;
  }

  return normalized.join("\n").trimEnd() + "\n";
}

function normalizePatchPath(rawPath) {
  const rawFile = String(rawPath || "").split(/\s+/)[0];
  if (rawFile === "/dev/null" || rawFile === "dev/null") return rawFile;
  return rawFile.replace(/^a\//, "").replace(/^b\//, "").replace(/^\.\//, "").trim();
}

function isBlocked(file) {
  return blockedPathPatterns.some((pattern) => pattern.test(file));
}

function isAllowed(file, allowedFiles, allowedNewFilePrefixes) {
  if (file === "/dev/null" || file === "dev/null") return true;
  if (isBlocked(file)) return false;
  if (allowedFiles.includes(file)) return true;
  return allowedNewFilePrefixes.some((prefix) => file.startsWith(prefix));
}

function validatePatch(patch, boundary) {
  const allowedFiles = boundary.allowedFiles || [];
  const allowedNewFilePrefixes = boundary.allowedNewFilePrefixes || defaultAllowedNewFilePrefixes;
  const touchedFiles = [];
  const disallowed = [];

  for (const line of patch.split("\n")) {
    const match = line.match(/^(?:\+\+\+|---)\s+(.+)$/);
    if (!match) continue;
    const file = normalizePatchPath(match[1]);
    if (file === "/dev/null" || file === "dev/null") continue;
    touchedFiles.push(file);
    if (!isAllowed(file, allowedFiles, allowedNewFilePrefixes)) disallowed.push(file);
  }

  if (disallowed.length > 0) {
    const error = new Error(`Patch touches disallowed files: ${[...new Set(disallowed)].join(", ")}`);
    error.status = 422;
    throw error;
  }

  if (touchedFiles.length === 0) {
    const error = new Error("Patch does not touch any files");
    error.status = 422;
    throw error;
  }

  return [...new Set(touchedFiles)];
}

function applyPatch({ gitRootPath, targetRelativePath, patch }) {
  const args = ["apply", "--whitespace=fix"];
  if (targetRelativePath) {
    args.push(`--directory=${targetRelativePath}`);
  }
  args.push("-");

  execFileSync("git", args, {
    cwd: gitRootPath,
    input: patch,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function applyPatchWithFallbacks({ gitRootPath, targetRelativePath, patch }) {
  try {
    applyPatch({ gitRootPath, targetRelativePath, patch });
    return "git_apply";
  } catch (firstError) {
    const recountArgs = ["apply", "--whitespace=fix", "--recount"];
    if (targetRelativePath) {
      recountArgs.push(`--directory=${targetRelativePath}`);
    }
    recountArgs.push("-");

    try {
      execFileSync("git", recountArgs, {
        cwd: gitRootPath,
        input: patch,
        stdio: ["pipe", "pipe", "pipe"],
      });
      return "git_apply_recount";
    } catch {
      const zeroArgs = ["apply", "--whitespace=fix", "--unidiff-zero"];
      if (targetRelativePath) {
        zeroArgs.push(`--directory=${targetRelativePath}`);
      }
      zeroArgs.push("-");

      try {
        execFileSync("git", zeroArgs, {
          cwd: gitRootPath,
          input: patch,
          stdio: ["pipe", "pipe", "pipe"],
        });
        return "git_apply_unidiff_zero";
      } catch {
        throw firstError;
      }
    }
  }
}

function getRequirementText(requirementStage) {
  const data = requirementStage?.data || {};
  return [
    data.title,
    data.userStory,
    ...(data.acceptanceCriteria || []),
    ...(data.openQuestions || []),
    data.implementationLevel,
  ]
    .filter(Boolean)
    .join("\n");
}

function isSmallUiCopyRequirement(requirementText) {
  const text = String(requirementText || "").toLowerCase();
  const copySignals = ["文案", "标题", "辅助", "提示", "显示", "展示", "label", "text", "copy"];
  const structuralSignals = ["接口", "数据库", "权限", "认证", "新增页面", "schema", "api", "migration"];
  return copySignals.some((term) => text.includes(term)) && !structuralSignals.some((term) => text.includes(term));
}

function buildTaskHint(requirementText, moduleStage) {
  if (!isSmallUiCopyRequirement(requirementText)) return "无特殊提示。";
  const boundary = moduleStage?.data?.editBoundary || [];
  return [
    "这是一个小型 UI 文案需求。",
    "必须优先在已允许的页面/组件文件内直接完成，不要为了复用而修改共享容器组件。",
    `本次只能改这些文件：${boundary.join(", ")}`,
  ].join("\n");
}

function buildFileContext(worktreePath, moduleStage) {
  const data = moduleStage?.data || {};
  const files = [...new Set([...(data.editBoundary || []), ...(data.readOnlyFiles || [])])];

  return files
    .map((file) => {
      const content = readFilePreview(worktreePath, file, 9000);
      return [`--- FILE: ${file} ---`, content].join("\n");
    })
    .join("\n\n");
}

function buildBoundary(moduleStage) {
  const data = moduleStage?.data || {};
  const allowedFiles = [...new Set([...(data.editBoundary || []), ...(data.relatedTests || [])])];
  return {
    allowedFiles,
    allowedNewFilePrefixes: data.allowedNewFilePrefixes || defaultAllowedNewFilePrefixes,
  };
}

async function askForPatch({ runDir, purpose, requirementText, planStage, moduleStage, fileContext, previous }) {
  const boundary = buildBoundary(moduleStage);
  const repairSection = previous
    ? [
        "",
        "上一次 patch 应用失败，请基于错误信息修复。",
        "失败 patch:",
        previous.patch,
        "",
        "错误信息:",
        previous.error,
        "",
        "修复要求：",
        "如果上一次 patch 触碰了不允许文件，本次必须完全移除这些文件的 diff。",
        "本次输出只能包含上面“可修改的既有文件”和允许新增目录内的文件。",
      ].join("\n")
    : "";

  const prompt = [
    "你是一个严谨的代码生成 Agent，目标仓库是 Conduit/RealWorld 全栈博客 monorepo。",
    "请根据 PM 需求生成最小可行的 unified diff patch。",
    "只输出可被 git apply 应用的 unified diff，不要解释，不要 markdown。",
    "diff 必须包含标准文件头，例如：diff --git a/path b/path、--- a/path、+++ b/path、@@ hunk header。",
    "",
    "PM 需求和澄清结果：",
    requirementText,
    "",
    "任务提示：",
    buildTaskHint(requirementText, moduleStage),
    "",
    "方案约束：",
    JSON.stringify(planStage?.data || {}, null, 2),
    "",
    "可修改的既有文件：",
    boundary.allowedFiles.map((file) => `- ${file}`).join("\n") || "- 无",
    "",
    "允许新增文件的目录前缀：",
    boundary.allowedNewFilePrefixes.map((prefix) => `- ${prefix}`).join("\n"),
    "",
    "禁止修改：node_modules、dist/build、package.json、package-lock.json、.env、迁移和 seed 文件。",
    "如果需要测试，优先新增或修改与变更逻辑直接相关的轻量测试文件。",
    "",
    "相关文件上下文：",
    fileContext,
    repairSection,
  ].join("\n");

  return stripFence(
    await chatCompletion({
      runDir,
      purpose,
      temperature: previous ? 0.05 : 0.1,
      messages: [
        {
          role: "system",
          content: "你只输出可被 git apply 应用的 unified diff patch。",
        },
        { role: "user", content: prompt },
      ],
    }),
  );
}

function savePatch(runDir, name, patch) {
  fs.writeFileSync(path.join(runDir, name), patch);
}

async function generateAndApplyPatch({
  runDir,
  worktreePath,
  gitRootPath = worktreePath,
  targetRelativePath = "",
  requirementStage,
  planStage,
  moduleStage,
}) {
  const requirementText = getRequirementText(requirementStage);
  const fileContext = buildFileContext(worktreePath, moduleStage);
  const boundary = buildBoundary(moduleStage);
  let previous = null;
  let appliedBy = null;
  let touchedFiles = [];
  const attempts = [];

  if (boundary.allowedFiles.length === 0) {
    const error = new Error("No editable files were selected by module location stage");
    error.status = 422;
    throw error;
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const patchFile = attempt === 0 ? "model-generated.patch" : `model-repaired-${attempt}.patch`;
    const patch = normalizeUnifiedDiff(
      await askForPatch({
        runDir,
        purpose: attempt === 0 ? "code_patch_generation" : `code_patch_repair_${attempt}`,
        requirementText,
        planStage,
        moduleStage,
        fileContext,
        previous,
      }),
    );
    savePatch(runDir, patchFile, patch);

    try {
      touchedFiles = validatePatch(patch, boundary);
      const applyMethod = applyPatchWithFallbacks({ gitRootPath, targetRelativePath, patch });
      appliedBy = attempt === 0 ? "model_patch" : `model_patch_repair_${attempt}`;
      attempts.push({ patchFile, status: "applied", touchedFiles, applyMethod });
      break;
    } catch (error) {
      const errorText = String(error.stderr || error.message);
      fs.writeFileSync(path.join(runDir, `patch-apply-error-${attempt}.txt`), errorText);
      attempts.push({ patchFile, status: "failed", error: error.message });
      previous = { patch, error: errorText };
    }
  }

  if (!appliedBy) {
    const error = new Error("Model patch could not be applied after repair attempts");
    error.status = 422;
    throw error;
  }

  return {
    name: "code_generation",
    status: "completed",
    summary: `模型已在动态边界内生成并应用 patch：${appliedBy}。`,
    data: {
      allowedFiles: boundary.allowedFiles,
      allowedNewFilePrefixes: boundary.allowedNewFilePrefixes,
      appliedBy,
      attempts,
      touchedFiles,
      requirementTitle: requirementStage.data.title || requirementStage.data.normalizedTitle,
    },
  };
}

module.exports = {
  defaultAllowedNewFilePrefixes,
  generateAndApplyPatch,
};
