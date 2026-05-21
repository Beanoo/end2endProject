const fs = require("fs");
const path = require("path");

const candidateFiles = [
  "frontend/src/routes/Article/Article.jsx",
  "frontend/src/services/getArticle.js",
  "frontend/src/components/ArticleMeta/ArticleMeta.jsx",
  "backend/controllers/articles.js",
  "backend/routes/articles.js",
  "backend/models/Article.js",
];

function locateModules(worktreePath) {
  const files = candidateFiles.map((file) => ({
    exists: fs.existsSync(path.join(worktreePath, file)),
    path: file,
  }));

  return {
    name: "module_location",
    status: files.every((file) => file.exists) ? "completed" : "blocked",
    summary: "已在 Conduit worktree 中定位需求相关真实文件。",
    data: {
      files,
      primaryEditBoundary: ["frontend/src/routes/Article/Article.jsx"],
      noEditAreas: ["authentication", "database schema", "article API contract"],
    },
  };
}

module.exports = locateModules;

