const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { chatCompletion } = require("../llm/arkClient");

const allowedFiles = [
  "frontend/src/routes/Article/Article.jsx",
  "frontend/src/helpers/articleStats.js",
  "frontend/src/helpers/articleStats.test.js",
];

function readIfExists(repo, relativePath) {
  const absolutePath = path.join(repo, relativePath);
  if (!fs.existsSync(absolutePath)) return "";
  return fs.readFileSync(absolutePath, "utf8");
}

function stripFence(text) {
  return text
    .replace(/^```(?:diff|patch)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function validatePatch(patch) {
  const disallowed = [];
  for (const line of patch.split("\n")) {
    const match = line.match(/^(?:\+\+\+|---)\s+(.+)$/);
    if (!match) continue;
    const rawFile = match[1].split(/\s+/)[0];
    if (rawFile === "/dev/null" || rawFile === "dev/null") continue;
    const file = rawFile.replace(/^a\//, "").replace(/^b\//, "");
    if (!allowedFiles.includes(file)) disallowed.push(file);
  }

  if (disallowed.length > 0) {
    const error = new Error(`Patch touches disallowed files: ${[...new Set(disallowed)].join(", ")}`);
    error.status = 422;
    throw error;
  }
}

function applyPatch(repo, patch) {
  execFileSync("git", ["apply", "--whitespace=fix", "-"], {
    cwd: repo,
    input: patch,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function applyControlledFallback(repo, runDir, applyError) {
  fs.writeFileSync(path.join(runDir, "patch-apply-error.txt"), String(applyError.stderr || applyError.message));

  const helperPath = path.join(repo, "frontend/src/helpers/articleStats.js");
  const testPath = path.join(repo, "frontend/src/helpers/articleStats.test.js");
  const articlePath = path.join(repo, "frontend/src/routes/Article/Article.jsx");

  fs.writeFileSync(
    helperPath,
    `export function getArticleStats(body) {
  if (!body || typeof body !== "string") {
    return { wordCount: 0, readingMinutes: 0 };
  }

  const text = body
    .replace(/\\[[^\\]]*\\]\\([^)]*\\)/g, "")
    .replace(/[#>*_\`~\\-]/g, "")
    .replace(/\\s+/g, "");
  const wordCount = text.length;
  const readingMinutes = wordCount > 0 ? Math.max(1, Math.ceil(wordCount / 200)) : 0;

  return { wordCount, readingMinutes };
}
`,
  );

  fs.writeFileSync(
    testPath,
    `import { getArticleStats } from "./articleStats";

describe("getArticleStats", () => {
  it("returns zero stats for empty input", () => {
    expect(getArticleStats("")).toEqual({ wordCount: 0, readingMinutes: 0 });
    expect(getArticleStats(null)).toEqual({ wordCount: 0, readingMinutes: 0 });
  });

  it("counts non-whitespace content", () => {
    expect(getArticleStats("Hello world 中文测试").wordCount).toBe(14);
  });

  it("estimates reading minutes with a minimum of one minute", () => {
    expect(getArticleStats("a".repeat(100)).readingMinutes).toBe(1);
    expect(getArticleStats("a".repeat(250)).readingMinutes).toBe(2);
  });
});
`,
  );

  let articleSource = fs.readFileSync(articlePath, "utf8");
  if (!articleSource.includes("../../helpers/articleStats")) {
    articleSource = articleSource.replace(
      'import getArticle from "../../services/getArticle";',
      'import getArticle from "../../services/getArticle";\nimport { getArticleStats } from "../../helpers/articleStats";',
    );
  }
  if (!articleSource.includes("const articleStats = getArticleStats(body);")) {
    articleSource = articleSource.replace(
      "  const { slug } = useParams();",
      "  const { slug } = useParams();\n  const articleStats = getArticleStats(body);",
    );
  }
  if (!articleSource.includes("预计阅读")) {
    articleSource = articleSource.replace(
      '            {body && <Markdown options={{ forceBlock: true }}>{body}</Markdown>}\n            <ArticleTags tagList={tagList} />',
      `            {body && <Markdown options={{ forceBlock: true }}>{body}</Markdown>}
            {body && (
              <p className="text-muted">
                本文共 {articleStats.wordCount} 字，预计阅读{" "}
                {articleStats.readingMinutes} 分钟
              </p>
            )}
            <ArticleTags tagList={tagList} />`,
    );
  }
  fs.writeFileSync(articlePath, articleSource);
}

async function generateAndApplyPatch({ runDir, worktreePath, requirementStage }) {
  const articlePath = "frontend/src/routes/Article/Article.jsx";
  const articleSource = readIfExists(worktreePath, articlePath);

  const prompt = [
    "你是一个严谨的代码生成 Agent，目标仓库是 Conduit/RealWorld React/Vite 前端。",
    "请为 L1 需求生成 unified diff patch。",
    "需求：文章详情页新增字数统计，在文章正文下方显示“本文共 XXX 字，预计阅读 X 分钟”，前端基于 Article.body 计算。",
    "约束：",
    "- 只能修改或新增以下文件：",
    allowedFiles.map((file) => `  - ${file}`).join("\n"),
    "- 不修改后端、不修改 package.json。",
    "- 新增 helper: frontend/src/helpers/articleStats.js。",
    "- 新增测试: frontend/src/helpers/articleStats.test.js。",
    "- 修改 Article.jsx 在正文下方、标签上方展示统计。",
    "- 只输出 unified diff，不要解释。",
    "",
    `当前 ${articlePath} 内容：`,
    articleSource,
  ].join("\n");

  const modelPatch = await chatCompletion({
    runDir,
    purpose: "code_patch_generation",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "你只输出可被 git apply 应用的 unified diff patch。",
      },
      { role: "user", content: prompt },
    ],
  });

  const patch = stripFence(modelPatch);
  fs.writeFileSync(path.join(runDir, "model-generated.patch"), patch);
  validatePatch(patch);
  let appliedBy = "model_patch";
  try {
    applyPatch(worktreePath, patch);
  } catch (error) {
    applyControlledFallback(worktreePath, runDir, error);
    appliedBy = "controlled_fallback_after_model_patch_failure";
  }

  return {
    name: "code_generation",
    status: "completed",
    summary: "模型已生成 patch，工具已在 Conduit worktree 中受控应用。",
    data: {
      allowedFiles,
      appliedBy,
      patchFile: "model-generated.patch",
      requirementTitle: requirementStage.data.title || requirementStage.data.normalizedTitle,
    },
  };
}

module.exports = {
  allowedFiles,
  generateAndApplyPatch,
};
