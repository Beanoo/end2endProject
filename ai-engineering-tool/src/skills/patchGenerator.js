const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chatCompletion } = require("../llm/arkClient");
const { readFilePreview } = require("../repoIndex");

const defaultAllowedNewFilePrefixes = [
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

function normalizeDiffPath(rawPath) {
  const file = String(rawPath || "")
    .trim()
    .replace(/^a\//, "")
    .replace(/^b\//, "")
    .replace(/^\/+dev\/null$/, "/dev/null");
  if (file === "dev/null") return "/dev/null";
  return file;
}

function formatDiffPath(prefix, file) {
  return file === "/dev/null" ? "/dev/null" : `${prefix}/${file}`;
}

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

    if (/^(?:new|deleted) file mode\s+/.test(lines[i] || "")) {
      i += 1;
      continue;
    }

    const oldFile = lines[i]?.match(/^---\s+(.+)$/);
    const newFile = lines[i + 1]?.match(/^\+\+\+\s+(.+)$/);
    if (oldFile && newFile) {
      const oldPath = normalizeDiffPath(oldFile[1]);
      const newPath = normalizeDiffPath(newFile[1]);
      const diffOldPath = oldPath === "/dev/null" ? newPath : oldPath;
      const diffNewPath = newPath === "/dev/null" ? oldPath : newPath;
      normalized.push(pendingDiffHeader || `diff --git a/${diffOldPath} b/${diffNewPath}`);
      normalized.push(`--- ${formatDiffPath("a", oldPath)}`);
      normalized.push(`+++ ${formatDiffPath("b", newPath)}`);
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
  const rawFile = normalizeDiffPath(String(rawPath || "").split(/\s+/)[0]);
  if (rawFile === "/dev/null") return rawFile;
  return rawFile.replace(/^a\//, "").replace(/^b\//, "").replace(/^\.\//, "").trim();
}

function isBlocked(file) {
  return blockedPathPatterns.some((pattern) => pattern.test(file));
}

function isAllowed(file, allowedFiles, allowedNewFilePrefixes) {
  if (file === "/dev/null") return true;
  if (isBlocked(file)) return false;
  if (allowedFiles.includes(file)) return true;
  return allowedNewFilePrefixes.some((prefix) => file.startsWith(prefix));
}

function auditTouchedFiles(touchedFiles, moduleStage) {
  const data = moduleStage?.data || {};
  const editBoundary = new Set(data.editBoundary || []);
  const readOnlyFiles = new Set(data.readOnlyFiles || []);
  const explorationReasons = new Map((data.exploration || []).map((item) => [item.file, item.reason]));
  const allowedRoots = data.writePolicy?.allowedExistingSourceRoots || ["frontend/src/", "backend/"];

  return touchedFiles.map((file) => {
    let classification = "outside_initial_boundary";
    if (editBoundary.has(file)) classification = "planned_edit_boundary";
    else if (readOnlyFiles.has(file)) classification = "promoted_from_read_context";
    else if (allowedRoots.some((root) => file.startsWith(root))) classification = "audited_source_expansion";

    return {
      file,
      classification,
      explorationReason: explorationReasons.get(file) || null,
      requiresHumanAttention: classification !== "planned_edit_boundary",
    };
  });
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
    if (file === "/dev/null") continue;
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

function formatFeedback(feedback) {
  if (!feedback) return "";
  return JSON.stringify(feedback, null, 2);
}

async function askForPatch({ runDir, purpose, requirementText, planStage, moduleStage, fileContext, previous, feedback }) {
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
    "新增文件必须使用 --- /dev/null 和 +++ b/path，不要输出 --- a//dev/null。",
    "",
    "PM 需求和澄清结果：",
    requirementText,
    "",
    "任务提示：",
    buildTaskHint(requirementText, moduleStage),
    "",
    "方案约束：",
    JSON.stringify(planStage?.data || {}, null, 2),
    feedback ? ["", "上一次失败反馈：", formatFeedback(feedback)].join("\n") : "",
    "",
    "建议优先修改的文件（不是唯一可修改范围）：",
    boundary.allowedFiles.map((file) => `- ${file}`).join("\n") || "- 无",
    "",
    "Audited Write Policy:",
    "你可以修改 frontend/src/ 与 backend/ 下的源码文件，但每个超出建议边界的修改都会被审计；必须保持最小必要改动。",
    "禁止修改 node_modules、dist/build、package.json、package-lock.json、.env、backend/migrations、backend/seeders。",
    "",
    "允许新增文件的源码目录前缀：",
    boundary.allowedNewFilePrefixes.map((prefix) => `- ${prefix}`).join("\n"),
    "",
    "禁止发明未出现在相关文件上下文里的 import、service、helper 或组件；需要接口数据时优先复用上下文中已有服务。",
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

async function askForFileWrites({ runDir, requirementText, planStage, moduleStage, fileContext, previous, feedback }) {
  const boundary = buildBoundary(moduleStage);
  const prompt = [
    "你是一个严谨的代码生成 Agent，目标仓库是 Conduit/RealWorld 全栈博客 monorepo。",
    "前面的 unified diff 多次应用失败。现在请改用结构化整文件写入方案。",
    "只输出 JSON，不要 markdown，不要解释。",
    "",
    "JSON 格式：",
    '{"files":[{"path":"frontend/src/example.jsx","content":"完整文件内容"}]}',
    "",
    "硬性约束：",
    "1. path 必须位于 frontend/src/ 或 backend/ 源码区内，且不能触碰硬禁止文件。",
    "2. content 必须是该文件的完整最终内容，不是 diff，不是片段。",
    "3. 既有文件必须基于下方“相关文件上下文”改写，不能假设另一个版本的源码。",
    "4. 禁止发明未出现在相关文件上下文里的 import、service、helper 或组件；需要接口数据时优先复用上下文中已有服务。",
    "5. 只返回完成需求必需的文件。",
    "",
    "PM 需求和澄清结果：",
    requirementText,
    "",
    "任务提示：",
    buildTaskHint(requirementText, moduleStage),
    "",
    "方案约束：",
    JSON.stringify(planStage?.data || {}, null, 2),
    feedback ? ["", "上一次失败反馈：", formatFeedback(feedback)].join("\n") : "",
    "",
    "建议优先修改的文件（不是唯一可修改范围）：",
    boundary.allowedFiles.map((file) => `- ${file}`).join("\n") || "- 无",
    "",
    "Audited Write Policy:",
    "可以修改 frontend/src/ 与 backend/ 下的源码文件，但每个超出建议边界的修改都会被审计；必须保持最小必要改动。",
    "禁止修改 node_modules、dist/build、package.json、package-lock.json、.env、backend/migrations、backend/seeders。",
    "",
    "允许新增文件的源码目录前缀：",
    boundary.allowedNewFilePrefixes.map((prefix) => `- ${prefix}`).join("\n"),
    "",
    "最后一次失败 patch:",
    previous?.patch || "",
    "",
    "最后一次错误信息:",
    previous?.error || "",
    "",
    "相关文件上下文：",
    fileContext,
  ].join("\n");

  return parseJson(
    await chatCompletion({
      runDir,
      purpose: "code_file_rewrite_fallback",
      temperature: 0.05,
      messages: [
        {
          role: "system",
          content: "你只输出 JSON：{\"files\":[{\"path\":\"...\",\"content\":\"...\"}]}。",
        },
        { role: "user", content: prompt },
      ],
    }),
  );
}

function applyFileWrites({ worktreePath, boundary, fileWrites }) {
  const files = Array.isArray(fileWrites?.files) ? fileWrites.files : [];
  const touchedFiles = [];

  if (files.length === 0) {
    const error = new Error("File rewrite fallback returned no files");
    error.status = 422;
    throw error;
  }

  for (const item of files) {
    const file = String(item?.path || "").replace(/^\.\//, "").replaceAll("\\", "/");
    const content = item?.content;

    if (!file || typeof content !== "string") {
      const error = new Error("File rewrite fallback returned invalid file item");
      error.status = 422;
      throw error;
    }

    if (!isAllowed(file, boundary.allowedFiles, boundary.allowedNewFilePrefixes)) {
      const error = new Error(`File rewrite fallback touches disallowed file: ${file}`);
      error.status = 422;
      throw error;
    }

    const absolutePath = path.join(worktreePath, file);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content.endsWith("\n") ? content : `${content}\n`);
    touchedFiles.push(file);
  }

  return [...new Set(touchedFiles)];
}

function savePatch(runDir, name, patch) {
  fs.writeFileSync(path.join(runDir, name), patch);
}

function getCumulativeTouchedFiles({ gitRootPath, targetRelativePath }) {
  const pathspec = targetRelativePath || ".";
  const output = execFileSync("git", ["diff", "--name-only", "--", pathspec], {
    cwd: gitRootPath,
    encoding: "utf8",
  });
  return output.split("\n").filter(Boolean);
}

async function generateAndApplyPatch({
  runDir,
  worktreePath,
  gitRootPath = worktreePath,
  targetRelativePath = "",
  requirementStage,
  planStage,
  moduleStage,
  feedback,
}) {
  const requirementText = getRequirementText(requirementStage);
  const fileContext = buildFileContext(worktreePath, moduleStage);
  const boundary = buildBoundary(moduleStage);
  let previous = null;
  let appliedBy = null;
  let touchedFiles = [];
  let writeAudit = [];
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
        feedback,
      }),
    );
    savePatch(runDir, patchFile, patch);

    try {
      touchedFiles = validatePatch(patch, boundary);
      const applyMethod = applyPatchWithFallbacks({ gitRootPath, targetRelativePath, patch });
      writeAudit = auditTouchedFiles(touchedFiles, moduleStage);
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
    const fileWrites = await askForFileWrites({
      runDir,
      requirementText,
      planStage,
      moduleStage,
      fileContext,
      previous,
      feedback,
    });
    fs.writeFileSync(path.join(runDir, "model-file-rewrite.json"), JSON.stringify(fileWrites, null, 2));
    touchedFiles = applyFileWrites({ worktreePath, boundary, fileWrites });
    writeAudit = auditTouchedFiles(touchedFiles, moduleStage);
    appliedBy = "model_file_rewrite_fallback";
    attempts.push({
      patchFile: "model-file-rewrite.json",
      status: "applied",
      touchedFiles,
      applyMethod: "file_rewrite",
    });
  }

  const cumulativeTouchedFiles = getCumulativeTouchedFiles({ gitRootPath, targetRelativePath });
  if (cumulativeTouchedFiles.length > 0) {
    touchedFiles = cumulativeTouchedFiles;
    writeAudit = auditTouchedFiles(touchedFiles, moduleStage);
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
      writeAudit,
      requirementTitle: requirementStage.data.title || requirementStage.data.normalizedTitle,
    },
  };
}

module.exports = {
  defaultAllowedNewFilePrefixes,
  generateAndApplyPatch,
};
