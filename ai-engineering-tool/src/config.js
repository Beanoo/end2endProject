const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const defaultTargetRepo = path.resolve(
  projectRoot,
  "..",
  "conduit-realworld-example-app-filtered",
);

module.exports = {
  defaultTargetRepo,
  port: Number(process.env.PORT || 4100),
  projectRoot,
  workspaceRoot: path.join(projectRoot, "workspace"),
};

