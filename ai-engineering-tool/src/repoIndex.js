const fs = require("fs");
const path = require("path");

const sourceRoots = ["frontend/src", "backend"];
const ignoredSegments = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".vite",
  "workspace",
]);
const sourceExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
]);

const domainHints = [
  {
    name: "article",
    terms: ["article", "articles", "文章", "正文", "发布", "编辑文章", "收藏文章"],
    paths: ["Article", "ArticleEditor", "articles", "ArticleMeta", "ArticleTags"],
  },
  {
    name: "comment",
    terms: ["comment", "comments", "评论", "留言"],
    paths: ["Comment", "comments"],
  },
  {
    name: "profile",
    terms: ["profile", "profiles", "个人主页", "资料", "关注", "作者"],
    paths: ["Profile", "profiles", "Follow", "Author"],
  },
  {
    name: "auth",
    terms: ["login", "sign up", "signup", "register", "登录", "注册", "认证", "密码"],
    paths: ["Login", "SignUp", "AuthPageContainer", "LoginForm", "SignUpForm", "user", "users", "authentication", "jwt"],
  },
  {
    name: "settings",
    terms: ["settings", "设置", "用户设置", "头像", "bio", "简介"],
    paths: ["Settings", "SettingsForm", "userUpdate"],
  },
  {
    name: "tag",
    terms: ["tag", "tags", "标签", "热门标签"],
    paths: ["Tag", "tags", "PopularTags"],
  },
  {
    name: "feed",
    terms: ["feed", "home", "首页", "列表", "分页", "信息流"],
    paths: ["Home", "Feed", "ArticlesPreview", "ArticlesPagination", "useArticles"],
  },
];

function shouldIgnore(relativePath) {
  const normalized = relativePath.split(path.sep).join("/");
  if (normalized.startsWith("backend/migrations/") || normalized.startsWith("backend/seeders/")) {
    return true;
  }
  return relativePath.split(path.sep).some((segment) => ignoredSegments.has(segment));
}

function walk(dir, root, files = []) {
  if (!fs.existsSync(dir)) return files;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const absolutePath = path.join(dir, entry.name);
    const relativePath = path.relative(root, absolutePath);
    if (shouldIgnore(relativePath)) continue;

    if (entry.isDirectory()) {
      walk(absolutePath, root, files);
      continue;
    }

    if (entry.isFile() && sourceExtensions.has(path.extname(entry.name))) {
      files.push(relativePath.split(path.sep).join("/"));
    }
  }

  return files;
}

function listSourceFiles(repo) {
  return sourceRoots.flatMap((root) => walk(path.join(repo, root), repo));
}

function readFilePreview(repo, relativePath, maxChars = 6000) {
  const absolutePath = path.join(repo, relativePath);
  if (!fs.existsSync(absolutePath)) return "";
  const content = fs.readFileSync(absolutePath, "utf8");
  return content.length > maxChars ? content.slice(0, maxChars) : content;
}

function tokenize(text) {
  const normalized = String(text || "").toLowerCase();
  const asciiTerms = normalized.match(/[a-z0-9_./-]{2,}/g) || [];
  const chineseTerms = [];

  for (const hint of domainHints) {
    for (const term of hint.terms) {
      if (/[\u4e00-\u9fff]/.test(term) && normalized.includes(term)) {
        chineseTerms.push(term);
      }
    }
  }

  return [...new Set([...asciiTerms, ...chineseTerms])];
}

function detectDomains(requirement) {
  const lower = String(requirement || "").toLowerCase();
  return domainHints
    .map((hint) => {
      const matchedTerms = hint.terms.filter((term) => lower.includes(term.toLowerCase()));
      return matchedTerms.length > 0 ? { name: hint.name, matchedTerms, paths: hint.paths } : null;
    })
    .filter(Boolean);
}

function scoreFile({ file, content, terms, matchedDomains }) {
  const haystack = `${file}\n${content}`.toLowerCase();
  let score = 0;

  for (const term of terms) {
    const normalized = term.toLowerCase();
    if (file.toLowerCase().includes(normalized)) score += 8;
    if (haystack.includes(normalized)) score += 2;
  }

  for (const domain of matchedDomains) {
    for (const pathHint of domain.paths) {
      if (file.toLowerCase().includes(pathHint.toLowerCase())) score += 10;
    }
  }

  if (file.includes("/routes/")) score += 3;
  if (file.includes("/components/")) score += 2;
  if (file.includes("/controllers/") || file.includes("/routes/")) score += 2;
  if (file.endsWith(".test.js") || file.endsWith(".test.jsx")) score -= 2;
  if (
    matchedDomains.some((domain) => domain.name === "auth") &&
    terms.some((term) => ["登录", "login", "sign", "signin"].includes(term)) &&
    file === "frontend/src/routes/Login.jsx"
  ) {
    score += 30;
  }
  if (
    matchedDomains.some((domain) => domain.name === "auth") &&
    terms.some((term) => ["注册", "signup", "register"].includes(term)) &&
    file === "frontend/src/routes/SignUp.jsx"
  ) {
    score += 30;
  }

  return score;
}

function selectCandidateFiles(repo, requirement, limit = 18) {
  const files = listSourceFiles(repo);
  const terms = tokenize(requirement);
  const matchedDomains = detectDomains(requirement);

  const ranked = files
    .map((file) => {
      const content = readFilePreview(repo, file, 2500);
      return {
        file,
        score: scoreFile({ file, content, terms, matchedDomains }),
        preview: content.slice(0, 1200),
      };
    })
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));

  const positive = ranked.filter((item) => item.score > 0);
  const selected = positive.length > 0 ? positive.slice(0, limit) : ranked.slice(0, limit);

  return {
    files: selected,
    matchedDomains,
    terms,
    totalIndexedFiles: files.length,
  };
}

function existingTestsFor(files, allFiles) {
  const all = new Set(allFiles);
  const tests = [];

  for (const file of files) {
    const ext = path.extname(file);
    const base = file.slice(0, -ext.length);
    for (const candidate of [`${base}.test${ext}`, `${base}.spec${ext}`]) {
      if (all.has(candidate)) tests.push(candidate);
    }
  }

  return [...new Set(tests)];
}

module.exports = {
  detectDomains,
  existingTestsFor,
  listSourceFiles,
  readFilePreview,
  selectCandidateFiles,
};
