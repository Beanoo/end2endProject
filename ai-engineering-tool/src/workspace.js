const fs = require("fs");
const path = require("path");
const { workspaceRoot } = require("./config");

function ensureRunWorkspace(runId) {
  const runDir = path.join(workspaceRoot, "runs", runId);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function ensureWorktreeRoot() {
  const worktreeRoot = path.join(workspaceRoot, "worktrees");
  fs.mkdirSync(worktreeRoot, { recursive: true });
  return worktreeRoot;
}

function writeEvent(runDir, event) {
  fs.appendFileSync(
    path.join(runDir, "events.jsonl"),
    `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`,
  );
}

function writeJson(runDir, name, value) {
  fs.writeFileSync(path.join(runDir, name), JSON.stringify(value, null, 2));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

module.exports = {
  ensureRunWorkspace,
  ensureWorktreeRoot,
  readJson,
  writeEvent,
  writeJson,
};

