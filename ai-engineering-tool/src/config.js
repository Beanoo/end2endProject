const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const defaultTargetRepo = path.resolve(
  process.env.TARGET_REPO || path.join(projectRoot, "..", "..", "Conduiteg"),
);

module.exports = {
  defaultTargetRepo,
  port: Number(process.env.PORT || 4100),
  projectRoot,
  workspaceRoot: path.join(projectRoot, "workspace"),
};
