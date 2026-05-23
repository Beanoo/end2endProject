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
  const arrayMatch = withoutFence.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    try {
      const parsed = JSON.parse(arrayMatch[0]);
      return Array.isArray(parsed) ? { files: parsed } : parsed;
    } catch {
      // Fall through to object parsing.
    }
  }
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

function isAllowed(
  file,
  allowedFiles,
  allowedNewFilePrefixes,
  { fileExists = true, allowedExistingSourceRoots = [] } = {},
) {
  if (file === "/dev/null") return true;
  if (isBlocked(file)) return false;
  if (allowedFiles.includes(file)) return true;
  if (fileExists && allowedExistingSourceRoots.some((root) => file.startsWith(root))) return true;
  return !fileExists && allowedNewFilePrefixes.some((prefix) => file.startsWith(prefix));
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

function validatePatch(patch, boundary, worktreePath) {
  const allowedFiles = boundary.allowedFiles || [];
  const allowedNewFilePrefixes = boundary.allowedNewFilePrefixes || defaultAllowedNewFilePrefixes;
  const allowedExistingSourceRoots = boundary.allowedExistingSourceRoots || [];
  const touchedFiles = [];
  const disallowed = [];

  for (const line of patch.split("\n")) {
    const match = line.match(/^(?:\+\+\+|---)\s+(.+)$/);
    if (!match) continue;
    const file = normalizePatchPath(match[1]);
    if (file === "/dev/null") continue;
    touchedFiles.push(file);
    const fileExists = fs.existsSync(path.join(worktreePath, file));
    if (!isAllowed(file, allowedFiles, allowedNewFilePrefixes, { fileExists, allowedExistingSourceRoots })) {
      disallowed.push(file);
    }
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

function readCurrentDiff({ gitRootPath, targetRelativePath }) {
  try {
    const pathspec = targetRelativePath || ".";
    return execFileSync("git", ["diff", "--", pathspec], {
      cwd: gitRootPath,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 4,
    });
  } catch {
    return "";
  }
}

function buildSliceFileContext(worktreePath, moduleStage, slice) {
  const data = moduleStage?.data || {};
  const allFiles = [...new Set([...(data.editBoundary || []), ...(data.readOnlyFiles || [])])];
  const prefixes = slice?.expectedFiles || [];
  const sliceFiles = allFiles.filter((file) => prefixes.some((prefix) => file.startsWith(prefix)));
  const selected = sliceFiles.length > 0 ? sliceFiles : allFiles;

  return selected
    .map((file) => {
      const content = readFilePreview(worktreePath, file, 12000);
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
    allowedExistingSourceRoots: data.writePolicy?.allowedExistingSourceRoots || [],
  };
}

function formatFeedback(feedback) {
  if (!feedback) return "";
  return JSON.stringify(feedback, null, 2);
}

function isPatchFormatFailure(feedback) {
  const errorText = String(feedback?.error || feedback?.summary || "").toLowerCase();
  return [
    "git apply",
    "corrupt patch",
    "patch fragment without header",
    "patch does not apply",
    "unrecognized input",
    "malformed patch",
  ].some((signal) => errorText.includes(signal));
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
        "如果上一次 patch 触碰了硬禁止文件，本次必须完全移除这些文件的 diff。",
        "优先修改稳定编辑边界内文件；若需求或失败反馈必须修改其它源码区既有文件，可以最小化修改并接受审计。",
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
    feedback?.currentDiff
      ? [
          "",
          "当前 worktree 已保留的累计 diff：",
          feedback.currentDiff,
          "",
          "增量修复要求：保留累计 diff 中已经正确的实现，只补齐失败反馈指出的缺口。",
        ].join("\n")
      : "",
    "",
    "稳定编辑边界（优先修改，不是唯一源码区）：",
    boundary.allowedFiles.map((file) => `- ${file}`).join("\n") || "- 无",
    "",
    "Audited Write Policy:",
    "既有文件优先修改稳定编辑边界；如果需求或失败反馈明确要求，可以修改 frontend/src/ 与 backend/ 下其它既有源码文件。",
    "当上一次失败反馈包含 requiredChanges 时，本轮只修 requiredChanges 指向的问题和文件，不要重写无关模块；如果当前 worktree 已有正确改动，必须保留并在其上增量修复。",
    "超出稳定编辑边界的既有源码改动会被记录为 audited_source_expansion，并由 code review 判断必要性。",
    "新增文件仅允许放在允许新增文件的源码目录前缀内，且必须被真实调用链接入。",
    "禁止修改 node_modules、dist/build、package.json、package-lock.json、.env、backend/migrations、backend/seeders。",
    "",
    "允许新增文件的源码目录前缀：",
    boundary.allowedNewFilePrefixes.map((prefix) => `- ${prefix}`).join("\n"),
    "",
    "绝对禁止发明未出现在相关文件上下文里的 import、service、helper 或组件文件。",
    "所有相对 import 路径指向的目标文件必须真实存在于仓库中，或者在本次 patch 中作为新增文件显式创建。",
    "如果需要接口数据，优先复用上下文中已有的服务函数，不要动态 import 一个根本不存在的文件。",
    "如果需要测试，优先新增或修改与变更逻辑直接相关的轻量测试文件。",
    "不要改变已有 helper 的公开返回结构，除非 PM 需求明确要求；例如 getArticleStats 必须只返回 { wordCount, readingMinutes }。",
    "修复测试失败时，优先修复实现与既有 API 契约，禁止通过给返回对象新增无需求字段来适配测试。",
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

async function askForFileWrites({
  runDir,
  requirementText,
  planStage,
  moduleStage,
  fileContext,
  previous,
  feedback,
  slice,
  excludedFiles = [],
  purpose = "code_file_rewrite_fallback",
}) {
  const boundary = buildBoundary(moduleStage);
  const sliceSection = slice
    ? [
        "",
        "当前只处理这个 implementation slice：",
        JSON.stringify(slice, null, 2),
        "",
        "只返回这个 slice 必需修改的文件；如果这个 slice 在当前代码中无需修改，返回 {\"files\":[]}.",
        excludedFiles.length > 0
          ? `以下文件已由其它 slice 处理，本 slice 禁止再次返回这些文件，避免完整文件覆盖：${excludedFiles.join(", ")}`
          : "",
      ].join("\n")
    : "";
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
    "4. 绝对禁止发明未出现在相关文件上下文里的 import、service、helper 或组件文件。所有相对 import 路径指向的目标文件必须真实存在于仓库中，或者在本次文件写入列表中显式创建。不要动态 import 一个根本不存在的文件。",
    "5. 只返回完成需求必需的文件。",
    "6. 不要改变已有 helper 的公开返回结构，除非 PM 需求明确要求；例如 getArticleStats 必须只返回 { wordCount, readingMinutes }。",
    "7. 修复测试失败时，优先修复实现与既有 API 契约，禁止通过给返回对象新增无需求字段来适配测试。",
    "",
    "PM 需求和澄清结果：",
    requirementText,
    sliceSection,
    "",
    "任务提示：",
    buildTaskHint(requirementText, moduleStage),
    "",
    "方案约束：",
    JSON.stringify(planStage?.data || {}, null, 2),
    feedback ? ["", "上一次失败反馈：", formatFeedback(feedback)].join("\n") : "",
    feedback?.currentDiff
      ? [
          "",
          "当前 worktree 已保留的累计 diff：",
          feedback.currentDiff,
          "",
          "增量修复要求：保留累计 diff 中已经正确的实现，只补齐失败反馈指出的缺口。",
        ].join("\n")
      : "",
    "",
    "稳定编辑边界（优先修改，不是唯一源码区）：",
    boundary.allowedFiles.map((file) => `- ${file}`).join("\n") || "- 无",
    "",
    "Audited Write Policy:",
    "既有文件优先修改稳定编辑边界；如果需求或失败反馈明确要求，可以修改 frontend/src/ 与 backend/ 下其它既有源码文件。",
    "当上一次失败反馈包含 requiredChanges 时，本轮只修 requiredChanges 指向的问题和文件，不要重写无关模块；如果当前 worktree 已有正确改动，必须保留并在其上增量修复。",
    "超出稳定编辑边界的既有源码改动会被记录为 audited_source_expansion，并由 code review 判断必要性。",
    "新增文件仅允许放在允许新增文件的源码目录前缀内，且必须被真实调用链接入。",
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

  const raw = await chatCompletion({
    runDir,
    purpose,
    temperature: 0.05,
    messages: [
      {
        role: "system",
        content: "你只输出 JSON：{\"files\":[{\"path\":\"...\",\"content\":\"...\"}]}。",
      },
      { role: "user", content: prompt },
    ],
  });

  return {
    raw,
    parsed: parseJson(raw),
  };
}

function applyFileWritesDetailed({
  worktreePath,
  boundary,
  fileWrites,
  allowEmpty = false,
  skipDisallowed = false,
}) {
  const files = Array.isArray(fileWrites?.files) ? fileWrites.files : [];
  const touchedFiles = [];
  const skippedFiles = [];

  if (files.length === 0) {
    if (allowEmpty) return { touchedFiles, skippedFiles };
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

    const fileExists = fs.existsSync(path.join(worktreePath, file));
    if (!isAllowed(file, boundary.allowedFiles, boundary.allowedNewFilePrefixes, {
      fileExists,
      allowedExistingSourceRoots: boundary.allowedExistingSourceRoots || [],
    })) {
      if (skipDisallowed) {
        skippedFiles.push({ file, reason: "disallowed_by_write_policy" });
        continue;
      }
      const error = new Error(`File rewrite fallback touches disallowed file: ${file}`);
      error.status = 422;
      throw error;
    }

    const absolutePath = path.join(worktreePath, file);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content.endsWith("\n") ? content : `${content}\n`);
    touchedFiles.push(file);
  }

  return {
    touchedFiles: [...new Set(touchedFiles)],
    skippedFiles,
  };
}

function applyFileWrites(args) {
  return applyFileWritesDetailed(args).touchedFiles;
}

async function applySlicedFileRewriteFallback({
  runDir,
  worktreePath,
  boundary,
  requirementText,
  planStage,
  moduleStage,
  previous,
  feedback,
}) {
  const slices = (planStage?.data?.implementationSlices || []).filter(
    (slice) => slice.id !== "verification-and-review",
  );
  const effectiveSlices = slices.length > 0
    ? slices
    : [{ id: "single-scope-change", goal: "完成本次需求的最小可行代码修改。" }];
  const touchedFiles = [];
  const sliceAttempts = [];

  for (const slice of effectiveSlices) {
    const fileContext = buildSliceFileContext(worktreePath, moduleStage, slice);
    const response = await askForFileWrites({
      runDir,
      requirementText,
      planStage,
      moduleStage,
      fileContext,
      previous,
      feedback,
      slice,
      excludedFiles: touchedFiles,
      purpose: `code_file_rewrite_slice_${slice.id}`,
    });
    const safeSliceId = String(slice.id || "slice").replace(/[^a-z0-9_-]/gi, "_");
    fs.writeFileSync(
      path.join(runDir, `model-file-rewrite-${safeSliceId}.json`),
      response.raw,
    );

    const parsedFiles = Array.isArray(response.parsed?.files) ? response.parsed.files : [];
    const duplicateFiles = parsedFiles
      .map((item) => String(item?.path || "").replace(/^\.\//, "").replaceAll("\\", "/"))
      .filter((file) => touchedFiles.includes(file));
    const dedupedResponse = {
      ...response.parsed,
      files: parsedFiles.filter((item) => {
        const file = String(item?.path || "").replace(/^\.\//, "").replaceAll("\\", "/");
        return !touchedFiles.includes(file);
      }),
    };

    const sliceResult = applyFileWritesDetailed({
      worktreePath,
      boundary,
      fileWrites: dedupedResponse,
      allowEmpty: true,
      skipDisallowed: true,
    });
    const sliceTouchedFiles = sliceResult.touchedFiles;
    touchedFiles.push(...sliceTouchedFiles);
    sliceAttempts.push({
      sliceId: slice.id,
      status: sliceTouchedFiles.length > 0 ? "applied" : "no_files",
      touchedFiles: sliceTouchedFiles,
      skippedFiles: [
        ...sliceResult.skippedFiles,
        ...duplicateFiles.map((file) => ({ file, reason: "already_written_by_previous_slice" })),
      ],
    });
  }

  if (touchedFiles.length === 0) {
    const error = new Error("Sliced file rewrite fallback returned no files");
    error.status = 422;
    error.sliceAttempts = sliceAttempts;
    throw error;
  }

  return {
    touchedFiles: [...new Set(touchedFiles)],
    sliceAttempts,
  };
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
  const currentDiff = readCurrentDiff({ gitRootPath, targetRelativePath });
  const effectiveFeedback = feedback && currentDiff ? { ...feedback, currentDiff } : feedback;
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

  const skipPatchGeneration = isPatchFormatFailure(feedback);
  if (skipPatchGeneration) {
    attempts.push({
      patchFile: null,
      status: "skipped",
      reason: "previous_patch_format_failure",
      applyMethod: "file_rewrite_required",
    });
  }

  for (let attempt = 0; !skipPatchGeneration && attempt < 3; attempt += 1) {
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
        feedback: effectiveFeedback,
      }),
    );
    savePatch(runDir, patchFile, patch);

    try {
      touchedFiles = validatePatch(patch, boundary, worktreePath);
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
    const slices = (planStage?.data?.implementationSlices || []).filter(
      (slice) => slice.id !== "verification-and-review",
    );
    const shouldUseSlicedFallback = slices.length > 2;

    if (shouldUseSlicedFallback) {
      const slicedResult = await applySlicedFileRewriteFallback({
        runDir,
        worktreePath,
        boundary,
        requirementText,
        planStage,
        moduleStage,
        previous,
        feedback: effectiveFeedback,
      });
      touchedFiles = slicedResult.touchedFiles;
      attempts.push({
        patchFile: "model-file-rewrite-*.json",
        status: "applied",
        touchedFiles,
        applyMethod: "sliced_file_rewrite",
        slices: slicedResult.sliceAttempts,
      });
    } else {
      const response = await askForFileWrites({
        runDir,
        requirementText,
        planStage,
        moduleStage,
        fileContext,
        previous,
        feedback: effectiveFeedback,
      });
      fs.writeFileSync(path.join(runDir, "model-file-rewrite.json"), response.raw);
      try {
        touchedFiles = applyFileWrites({ worktreePath, boundary, fileWrites: response.parsed });
        attempts.push({
          patchFile: "model-file-rewrite.json",
          status: "applied",
          touchedFiles,
          applyMethod: "file_rewrite",
        });
      } catch (error) {
        const slicedResult = await applySlicedFileRewriteFallback({
          runDir,
          worktreePath,
          boundary,
          requirementText,
          planStage,
          moduleStage,
          previous,
          feedback: effectiveFeedback,
        });
        touchedFiles = slicedResult.touchedFiles;
        attempts.push({
          patchFile: "model-file-rewrite-*.json",
          status: "applied",
          touchedFiles,
          applyMethod: "sliced_file_rewrite_after_whole_file_failure",
          wholeFileError: error.message,
          slices: slicedResult.sliceAttempts,
        });
      }
    }
    writeAudit = auditTouchedFiles(touchedFiles, moduleStage);
    appliedBy = shouldUseSlicedFallback
      ? "model_sliced_file_rewrite_fallback"
      : attempts.at(-1)?.applyMethod || "model_file_rewrite_fallback";
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
