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

function extractCommonJsExports(content) {
  const match = content.match(/module\.exports\s*=\s*\{([\s\S]*?)\};/);
  if (!match) return null;
  return new Set(
    match[1]
      .split(",")
      .map((item) => item.trim().split(":")[0].trim())
      .filter(Boolean),
  );
}

function checkCommonJsExportCompatibility({ gitRootPath, worktreePath, changedFiles }) {
  return changedFiles
    .map((item) => item.file)
    .filter((file) => file.startsWith("backend/") && file.endsWith(".js"))
    .flatMap((file) => {
      let baseContent = "";
      try {
        baseContent = execFileSync("git", ["show", `HEAD:${file}`], {
          cwd: gitRootPath,
          encoding: "utf8",
        });
      } catch {
        baseContent = "";
      }

      const baseExports = extractCommonJsExports(baseContent);
      if (!baseExports || baseExports.size === 0) return [];

      const currentContent = readTextIfExists(path.join(worktreePath, file));
      const currentExports = extractCommonJsExports(currentContent);
      if (!currentExports) {
        return [{ file, message: "原文件存在 CommonJS 导出块，当前版本缺少完整 module.exports 导出块。" }];
      }

      const missing = [...baseExports].filter((name) => !currentExports.has(name));
      if (missing.length === 0) return [];
      return [{
        file,
        message: `CommonJS 导出不兼容，缺少原有导出：${missing.join(", ")}。`,
      }];
    });
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

function componentNameFromFile(file) {
  return path.basename(file, path.extname(file));
}

function resolveRelativeImport({ worktreePath, fromFile, importPath }) {
  if (!importPath.startsWith(".")) return { valid: true, resolvedPath: null };
  const basePath = path.resolve(worktreePath, path.dirname(fromFile), importPath);
  const existingFile = (candidate) => {
    if (!fs.existsSync(candidate)) return false;
    return fs.statSync(candidate).isFile();
  };
  const candidates = [
    `${basePath}.js`,
    `${basePath}.jsx`,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.json`,
    path.join(basePath, "index.js"),
    path.join(basePath, "index.jsx"),
    path.join(basePath, "index.ts"),
    path.join(basePath, "index.tsx"),
    basePath,
  ];
  const resolved = candidates.find(existingFile);
  return { valid: !!resolved, resolvedPath: resolved || null };
}

function collectAllExistingSourceFiles(worktreePath) {
  const frontendSrc = path.join(worktreePath, "frontend", "src");
  const backendDir = path.join(worktreePath, "backend");
  const existing = new Set();

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (/\.(js|jsx|ts|tsx|json)$/.test(entry.name)) {
        existing.add(path.relative(worktreePath, fullPath).split(path.sep).join("/"));
      }
    }
  }
  walk(frontendSrc);
  walk(backendDir);
  return existing;
}

function checkRelativeImportResolution({ worktreePath, changedFiles }) {
  const existingSourceFiles = collectAllExistingSourceFiles(worktreePath);
  const findings = [];

  for (const changedFileItem of changedFiles) {
    const file = changedFileItem.file;
    if (!file.startsWith("frontend/src/") && !file.startsWith("backend/")) continue;
    if (!/\.(js|jsx|ts|tsx)$/.test(file)) continue;

    const content = readTextIfExists(path.join(worktreePath, file));
    const importPatterns = [
      /import\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
      /import\(\s*["']([^"']+)["']\s*\)/g,
      /require\(\s*["']([^"']+)["']\s*\)/g,
    ];

    for (const pattern of importPatterns) {
      for (const match of content.matchAll(pattern)) {
        const importPath = match[1];
        const { valid, resolvedPath } = resolveRelativeImport({ worktreePath, fromFile: file, importPath });

        if (importPath.startsWith(".") && !valid) {
          findings.push({
            file,
            message: `相对 import 指向不存在的文件：${importPath}。AI 禁止发明新的未在上下文中出现的 service/helper/组件文件。`,
          });
          continue;
        }

        if (resolvedPath) {
          const resolvedRelative = resolvedPath.replace(worktreePath, "").split(path.sep).join("/").replace(/^\//, "");
          const isNewlyCreated = changedFiles.some((item) => item.status === "A" && item.file === resolvedRelative);
          const existedBefore = existingSourceFiles.has(resolvedRelative);

          if (!existedBefore && !isNewlyCreated) {
            findings.push({
              file,
              message: `import 指向的目标文件在变更范围外且不存在：${importPath} → ${resolvedRelative}。必须要么复用仓库已有文件，要么在本次变更中显式创建该文件。`,
            });
          }
        }
      }
    }
  }

  return findings;
}

function checkReactComponentPropCompatibility({ gitRootPath, worktreePath, changedFiles }) {
  const changedFileNames = changedFiles.map((item) => item.file);
  const componentFiles = changedFileNames.filter(
    (file) => file.startsWith("frontend/src/") && /\.(jsx|tsx)$/.test(file),
  );
  const findings = [];

  for (const file of componentFiles) {
    const currentContent = readTextIfExists(path.join(worktreePath, file));
    const componentName = componentNameFromFile(file);
    if (!currentContent || !currentContent.includes(`function ${componentName}`)) continue;

    let baseContent = "";
    try {
      baseContent = execFileSync("git", ["show", `HEAD:${file}`], {
        cwd: gitRootPath,
        encoding: "utf8",
      });
    } catch {
      baseContent = "";
    }

    const currentProps = extractDestructuredProps(currentContent, componentName);
    const baseProps = extractDestructuredProps(baseContent, componentName);
    const removedProps = [...baseProps].filter((prop) => !currentProps.has(prop));

    if (removedProps.length > 0) {
      findings.push({
        file,
        message: `${componentName} 移除了既有 props：${removedProps.join(", ")}，可能破坏现有调用方。`,
      });
    }

    if (currentProps.size === 0) continue;

    const unsupportedUsages = [];
    const usagePattern = new RegExp(`<${componentName}\\s+([^>]*?)\\/?>`, "gs");
    for (const changedFile of changedFileNames.filter((name) => name.startsWith("frontend/src/"))) {
      const content = readTextIfExists(path.join(worktreePath, changedFile));
      const matches = content.matchAll(usagePattern);
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
        message: `${componentName} 调用传入了组件未声明的 props：${unsupportedUsages.join("；")}。`,
      });
    }
  }

  return findings;
}

function checkFrontendImportPathChurn({ gitRootPath, worktreePath, changedFiles }) {
  const findings = [];
  const frontendFiles = changedFiles
    .map((item) => item.file)
    .filter((file) => file.startsWith("frontend/src/") && /\.(jsx?|tsx?)$/.test(file));

  for (const file of frontendFiles) {
    let baseContent = "";
    try {
      baseContent = execFileSync("git", ["show", `HEAD:${file}`], {
        cwd: gitRootPath,
        encoding: "utf8",
      });
    } catch {
      baseContent = "";
    }
    if (!baseContent) continue;

    const currentContent = readTextIfExists(path.join(worktreePath, file));
    const baseImports = [...baseContent.matchAll(/^import\s+(.+?)\s+from\s+["'](.+)["'];?$/gm)];
    for (const [, importSpec, importPath] of baseImports) {
      if (!importPath.startsWith(".")) continue;
      const escapedSpec = importSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const currentImport = currentContent.match(new RegExp(`^import\\s+${escapedSpec}\\s+from\\s+["'](.+)["'];?$`, "m"));
      if (!currentImport || currentImport[1] === importPath) continue;

      const previousResolved = resolveRelativeImport({ worktreePath, fromFile: file, importPath }).resolvedPath;
      const currentResolved = resolveRelativeImport({
        worktreePath,
        fromFile: file,
        importPath: currentImport[1],
      }).resolvedPath;
      if (previousResolved && currentResolved && previousResolved !== currentResolved) {
        findings.push({
          file,
          message: `无需求驱动的 import 路径改写：${importSpec} 从 ${importPath} 改为 ${currentImport[1]}，应恢复原路径以避免入口导出语义回归。`,
        });
      }
    }
  }

  return findings;
}

function scanModelSchemaConstraints(worktreePath) {
  const modelsDir = path.join(worktreePath, "backend", "models");
  if (!fs.existsSync(modelsDir)) return new Map();

  const constraints = new Map();

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".js")) {
        const content = readTextIfExists(fullPath);
        const modelMatches = content.matchAll(/(?:const\s+|class\s+)(\w+)\s*=\s*sequelize\.define\s*\(\s*['"](\w+)['"]/g);
        for (const modelMatch of modelMatches) {
          const modelName = modelMatch[1];
          const tableName = modelMatch[2];
          const fieldMatches = content.matchAll(/(\w+)\s*:\s*\{[\s\S]*?(?:DataTypes\.STRING|type:\s*DataTypes\.STRING)[\s\S]*?(?:validate:\s*\{[\s\S]*?len:\s*(\d+)|allowNull:\s*(true|false))?/g);
          for (const fieldMatch of fieldMatches) {
            const fieldName = fieldMatch[1];
            const maxLength = fieldMatch[2] ? Number(fieldMatch[2]) : 255;
            constraints.set(`${tableName}.${fieldName}`, { tableName, fieldName, maxLength });
          }
        }
      }
    }
  }
  walk(modelsDir);
  return constraints;
}

function checkBackendInputBoundarySafety({ worktreePath, changedFiles, schemaConstraints }) {
  const findings = [];
  const backendControllerFiles = changedFiles
    .map((item) => item.file)
    .filter((file) => file.startsWith("backend/controllers/") && file.endsWith(".js"));

  for (const file of backendControllerFiles) {
    const content = readTextIfExists(path.join(worktreePath, file));
    for (const [key, constraint] of schemaConstraints.entries()) {
      const { tableName, fieldName, maxLength } = constraint;
      if (maxLength <= 255) {
        const unsafePattern = new RegExp(`(?:req\\.body\\.${fieldName}|data\\.${fieldName}|payload\\.${fieldName})\\s*=\\s*[^;]{100,}`, "g");
        if (unsafePattern.test(content)) {
          findings.push({
            file,
            message: `控制器中直接赋值给 ${tableName}.${fieldName} 字段的值可能超过数据库 varchar(${maxLength}) 限制，必须增加长度截断或校验。`,
          });
        }
      }
    }

    const longUrlPattern = /https?:\/\/[^\s'"]{250,}/g;
    for (const match of content.matchAll(longUrlPattern)) {
      findings.push({
        file,
        message: `代码中出现超长 URL（长度 >250），直接存入 varchar(255) 字段会触发 PostgreSQL 22001 错误，必须截断或改用 TEXT 类型。`,
      });
    }
  }

  return findings;
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

function checkRequirementCoverage({ worktreePath, changedFiles, requirementStage }) {
  const text = getRequirementText(requirementStage).toLowerCase();
  const files = changedFiles.map((item) => item.file);
  const findings = [];

  const needsArticleBodyStats =
    /(字数|word count|reading|阅读时间|阅读)/i.test(text) &&
    /(article\.body|正文|body)/i.test(text) &&
    /(详情|article page|页面|展示|显示|下方)/i.test(text);

  if (needsArticleBodyStats) {
    const articleFile = "frontend/src/routes/Article/Article.jsx";
    const articleContent = readTextIfExists(path.join(worktreePath, articleFile));
    const articleAlreadyShowsStats =
      articleContent.includes("getArticleStats") &&
      articleContent.includes("本文共") &&
      articleContent.includes("预计阅读");

    if (!articleAlreadyShowsStats && !files.includes(articleFile)) {
      findings.push({
        file: articleFile,
        message: "需求要求在文章详情页正文下方展示字数统计和预计阅读时间，但当前最终文件未集成文章详情页展示，用户不可见。",
      });
    }
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

  const schemaConstraints = scanModelSchemaConstraints(worktreePath);
  const findings = [
    ...checkRequirementCoverage({ worktreePath, changedFiles, requirementStage }),
    ...runBackendSyntaxChecks({ worktreePath, changedFiles }),
    ...checkCommonJsExportCompatibility({ gitRootPath, worktreePath, changedFiles }),
    ...checkRelativeImportResolution({ worktreePath, changedFiles }),
    ...checkFrontendImportPathChurn({ gitRootPath, worktreePath, changedFiles }),
    ...checkReactComponentPropCompatibility({ gitRootPath, worktreePath, changedFiles }),
    ...checkBackendInputBoundarySafety({ worktreePath, changedFiles, schemaConstraints }),
  ];

  if (findings.length > 0) {
    return {
      verdict: "reject",
      summary: `确定性检查发现 ${findings.length} 个阻断问题。`,
      changedScope: changedFiles.map((item) => item.file),
      estimatedImpact: "这些问题会导致服务启动失败、表单交互失效、数据库插入报错或核心模块导出不完整，必须在进入 LLM review 前修复。",
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
  const reviewText = [
    parsed?.summary || "",
    parsed?.estimatedImpact || "",
    ...risks,
    ...suggestions,
    ...requiredChanges,
  ].join("\n");
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
  const nonBlockingText = reviewText
    .toLowerCase()
    .replace(/无阻断性风险/g, "")
    .replace(/无阻断性问题/g, "")
    .replace(/无阻断风险/g, "")
    .replace(/无阻断问题/g, "")
    .replace(/无回归风险/g, "")
    .replace(/没有回归风险/g, "")
    .replace(/没有阻断性问题/g, "")
    .replace(/没有阻断问题/g, "")
    .replace(/可能不符合[^，。\n]*/g, "")
    .replace(/no blocking (risk|risks|issue|issues)/g, "");
  const hasBlockingSignal = blockingSignals.some((signal) => nonBlockingText.includes(signal));

  if (verdict === "pass" && requiredChanges.length > 0) {
    verdict = "reject";
  }
  if (verdict === "pass" && hasBlockingSignal) {
    verdict = "reject";
  }
  if (verdict === "reject" && requiredChanges.length === 0) {
    verdict = "pass";
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

function removeSatisfiedFalsePositives({ review, worktreePath }) {
  const articleContent = readTextIfExists(
    path.join(worktreePath, "frontend/src/routes/Article/Article.jsx"),
  );
  const statsContent = readTextIfExists(
    path.join(worktreePath, "frontend/src/helpers/articleStats.js"),
  );
  const articleShowsStats =
    articleContent.includes("getArticleStats") &&
    articleContent.includes("本文共") &&
    articleContent.includes("预计阅读");
  const statsDefendsNonString = statsContent.includes("typeof body !== \"string\"");

  const isSatisfiedClaim = (text) => {
    const value = String(text || "");
    if (
      articleShowsStats &&
      /(未在文章详情页展示|未.*详情页.*展示|未.*集成|功能缺失|用户不可见|统计信息不展示|未展示|不会显示|无法看到|必须在.*显示|调用 getArticleStats 并显示)/.test(value)
    ) {
      return true;
    }
    if (statsDefendsNonString && /(非字符串|运行时错误|undefined|null)/.test(value)) {
      return true;
    }
    return false;
  };

  const requiredChanges = (review.requiredChanges || []).filter((item) => !isSatisfiedClaim(item));
  const risks = (review.risks || []).filter((item) => !isSatisfiedClaim(item));
  const suggestions = (review.suggestions || []).filter((item) => !isSatisfiedClaim(item));

  if (
    review.verdict === "reject" &&
    review.requiredChanges?.length > 0 &&
    requiredChanges.length === 0
  ) {
    return {
      ...review,
      verdict: "pass",
      summary: "最终 worktree 状态已满足可确定验证的展示和边界要求，LLM review 的阻断项已由文件事实核对消解。",
      risks,
      suggestions,
      requiredChanges,
    };
  }

  return {
    ...review,
    risks,
    suggestions,
    requiredChanges,
    verdict: requiredChanges.length > 0 ? review.verdict : review.verdict,
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
    "必须根据需求推导边界输入和真实使用场景，例如长文本、长 URL、空值、重复值、直接访问页面、无权限访问、旧数据兼容等；不要只审查 happy path。",
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
  const review = removeSatisfiedFalsePositives({
    review: normalizeReview(parsed),
    worktreePath,
  });
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
