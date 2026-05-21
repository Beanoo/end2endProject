const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function ensureNodeModules({ worktreePath, targetRepo, runDir }) {
  const worktreeNodeModules = path.join(worktreePath, "node_modules");
  const targetNodeModules = path.join(targetRepo, "node_modules");

  if (fs.existsSync(worktreeNodeModules)) {
    return { status: "exists", path: worktreeNodeModules };
  }

  if (fs.existsSync(targetNodeModules)) {
    fs.symlinkSync(targetNodeModules, worktreeNodeModules, "dir");
    const result = {
      status: "linked",
      from: targetNodeModules,
      to: worktreeNodeModules,
    };
    fs.writeFileSync(path.join(runDir, "dependency-bootstrap.json"), JSON.stringify(result, null, 2));
    return result;
  }

  return runCommand({
    cwd: worktreePath,
    args: ["npm", "install"],
    fileName: "install-output.txt",
    runDir,
  });
}

function runCommand({ cwd, args, fileName, runDir }) {
  try {
    const output = execFileSync(args[0], args.slice(1), {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    fs.writeFileSync(path.join(runDir, fileName), output);
    return { command: args.join(" "), status: "passed", fileName };
  } catch (error) {
    const output = `${error.stdout || ""}\n${error.stderr || ""}`;
    fs.writeFileSync(path.join(runDir, fileName), output);
    return { command: args.join(" "), status: "failed", fileName };
  }
}

function saveDiff({ gitRootPath, targetRelativePath, runDir }) {
  const pathspec = targetRelativePath || ".";
  execFileSync("git", ["add", "-N", pathspec], {
    cwd: gitRootPath,
    encoding: "utf8",
  });
  const diff = execFileSync("git", ["diff", "--", pathspec], {
    cwd: gitRootPath,
    encoding: "utf8",
  });
  fs.writeFileSync(path.join(runDir, "changes.patch"), diff);
  return diff;
}

function runVerification({
  worktreePath,
  gitRootPath = worktreePath,
  targetRelativePath = ".",
  targetRepo,
  runDir,
}) {
  const dependencies = ensureNodeModules({ worktreePath, targetRepo, runDir });
  const vitestConfig = path.join(worktreePath, ".vitest-p1.config.mjs");
  fs.writeFileSync(
    vitestConfig,
    `export default {
  test: {
    globals: true,
    environment: "jsdom",
    css: true,
  },
};
`,
  );
  const test = runCommand({
    cwd: worktreePath,
    args: ["./node_modules/.bin/vitest", "--run", "--config", vitestConfig],
    fileName: "test-output.txt",
    runDir,
  });
  fs.rmSync(vitestConfig, { force: true });
  const build = runCommand({
    cwd: worktreePath,
    args: ["npm", "run", "build", "-w", "frontend"],
    fileName: "build-output.txt",
    runDir,
  });
  const diff = saveDiff({ gitRootPath, targetRelativePath, runDir });

  return {
    name: "verification",
    status: test.status === "passed" && build.status === "passed" ? "completed" : "blocked",
    summary: `测试 ${test.status}，前端构建 ${build.status}。`,
    data: {
      test,
      build,
      dependencies,
      diffBytes: Buffer.byteLength(diff),
      diffFile: "changes.patch",
    },
  };
}

module.exports = {
  runVerification,
};
