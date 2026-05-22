const { execFileSync, spawn } = require("child_process");
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

function linkIfExists({ from, to }) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return null;
  fs.symlinkSync(from, to);
  return { from, to, status: "linked" };
}

function ensureLocalRuntimeFiles({ worktreePath, targetRepo, runDir }) {
  const links = [
    linkIfExists({
      from: path.join(targetRepo, ".env"),
      to: path.join(worktreePath, ".env"),
    }),
    linkIfExists({
      from: path.join(targetRepo, "backend", ".env"),
      to: path.join(worktreePath, "backend", ".env"),
    }),
  ].filter(Boolean);

  const result = {
    status: links.length > 0 ? "linked" : "unchanged",
    links,
    expectedFiles: [".env", "backend/.env"],
  };
  fs.writeFileSync(path.join(runDir, "runtime-bootstrap.json"), JSON.stringify(result, null, 2));
  return result;
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

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function requestSmokeTarget({ baseUrl, target }) {
  const response = await fetch(`${baseUrl}${target.path}`);
  const body = await response.text();
  return {
    name: target.name,
    path: target.path,
    statusCode: response.status,
    passed: response.status >= 200 && response.status < 400,
    body: body.slice(0, 500),
  };
}

async function waitForBackend({ baseUrl, child, timeoutMs }) {
  const started = Date.now();
  let lastError = "";

  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`backend exited before health check passed, exitCode=${child.exitCode}`);
    }

    try {
      const response = await requestSmokeTarget({
        baseUrl,
        target: { name: "backend-root", path: "/" },
      });
      if (response.passed) return response;
      lastError = `status=${response.statusCode}`;
    } catch (error) {
      lastError = error.message;
    }

    await wait(500);
  }

  throw new Error(`backend smoke timed out: ${lastError}`);
}

function hasAnyPath(moduleStage, patterns) {
  const files = moduleStage?.data?.files || [];
  const paths = [
    ...(moduleStage?.data?.editBoundary || []),
    ...(moduleStage?.data?.readOnlyFiles || []),
    ...files.map((file) => file.path),
  ];
  return paths.some((file) => patterns.some((pattern) => pattern.test(file)));
}

function hasDomain(moduleStage, name) {
  return (moduleStage?.data?.matchedDomains || []).some((domain) => domain.name === name);
}

function planBackendSmokeTargets(moduleStage) {
  const targets = [{ name: "backend-root", path: "/" }];

  if (
    hasDomain(moduleStage, "tag") ||
    hasAnyPath(moduleStage, [/backend\/routes\/tags\.js$/, /frontend\/src\/services\/getTags\.js$/])
  ) {
    targets.push({ name: "tags-index", path: "/api/tags" });
  }

  if (
    hasDomain(moduleStage, "article") ||
    hasAnyPath(moduleStage, [
      /backend\/routes\/articles/,
      /backend\/controllers\/articles\.js$/,
      /frontend\/src\/services\/getArticles\.js$/,
    ])
  ) {
    targets.push({ name: "articles-index", path: "/api/articles?limit=1&offset=0" });
  }

  return [...new Map(targets.map((target) => [target.path, target])).values()];
}

function stopProcess(child) {
  if (!child.pid || child.killed) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Best effort cleanup for smoke-test processes.
    }
  }
}

async function runBackendSmoke({ worktreePath, runDir, moduleStage }) {
  const port = String(3101 + Math.floor(Math.random() * 700));
  const targets = planBackendSmokeTargets(moduleStage);
  const output = [];
  const child = spawn("npm", ["run", "dev", "-w", "backend"], {
    cwd: worktreePath,
    detached: true,
    env: {
      ...process.env,
      PORT: port,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk) => output.push(chunk.toString()));

  try {
    const baseUrl = `http://localhost:${port}`;
    const health = await waitForBackend({
      baseUrl,
      child,
      timeoutMs: 15000,
    });
    const checks = [];
    for (const target of targets) {
      checks.push(await requestSmokeTarget({ baseUrl, target }));
    }
    const failed = checks.filter((check) => !check.passed);
    if (failed.length > 0) {
      throw new Error(`backend smoke target failed: ${failed.map((item) => item.path).join(", ")}`);
    }
    return {
      command: `PORT=${port} npm run dev -w backend`,
      status: "passed",
      fileName: "backend-smoke-output.txt",
      health,
      targets,
      checks,
    };
  } catch (error) {
    return {
      command: `PORT=${port} npm run dev -w backend`,
      status: "failed",
      fileName: "backend-smoke-output.txt",
      targets,
      error: error.message,
    };
  } finally {
    stopProcess(child);
    fs.writeFileSync(path.join(runDir, "backend-smoke-output.txt"), output.join(""));
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

async function runVerification({
  worktreePath,
  gitRootPath = worktreePath,
  targetRelativePath = ".",
  targetRepo,
  runDir,
  moduleStage,
}) {
  const dependencies = ensureNodeModules({ worktreePath, targetRepo, runDir });
  const runtime = ensureLocalRuntimeFiles({ worktreePath, targetRepo, runDir });
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
  const backendSmoke = await runBackendSmoke({ worktreePath, runDir, moduleStage });
  const diff = saveDiff({ gitRootPath, targetRelativePath, runDir });
  const passed =
    test.status === "passed" && build.status === "passed" && backendSmoke.status === "passed";

  return {
    name: "verification",
    status: passed ? "completed" : "blocked",
    summary: `测试 ${test.status}，前端构建 ${build.status}，后端 smoke ${backendSmoke.status}。`,
    data: {
      test,
      build,
      backendSmoke,
      dependencies,
      runtime,
      diffBytes: Buffer.byteLength(diff),
      diffFile: "changes.patch",
    },
  };
}

module.exports = {
  runVerification,
};
