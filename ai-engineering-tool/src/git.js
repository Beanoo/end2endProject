const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { ensureWorktreeRoot } = require("./workspace");

function git(repo, args) {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function getRepoStatus(repo) {
  const gitDir = git(repo, ["rev-parse", "--git-dir"]);
  const root = git(repo, ["rev-parse", "--show-toplevel"]);
  const branch = git(repo, ["branch", "--show-current"]) || "detached";
  const head = git(repo, ["rev-parse", "HEAD"]);
  const porcelain = git(repo, ["status", "--short"]);

  return {
    branch,
    gitDir,
    head,
    isDirty: porcelain.length > 0,
    root,
    status: porcelain ? porcelain.split("\n") : [],
  };
}

function createPlanningWorktree(repo, runId) {
  const worktreeRoot = ensureWorktreeRoot();
  const worktreePath = path.join(worktreeRoot, runId);
  const branch = `ai/${runId}-planning`;

  if (fs.existsSync(worktreePath)) {
    return {
      branch,
      created: false,
      path: worktreePath,
    };
  }

  git(repo, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);

  return {
    branch,
    created: true,
    path: worktreePath,
  };
}

module.exports = {
  createPlanningWorktree,
  getRepoStatus,
  git,
};

