const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chatCompletion } = require("./llm/arkClient");

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

function bootstrapWorktreeRuntime({ worktreePath, targetRepo, runDir }) {
  const targetNodeModules = path.join(targetRepo, "node_modules");
  const worktreeNodeModules = path.join(worktreePath, "node_modules");
  let dependencies = { status: "missing", expectedSource: targetNodeModules };

  if (fs.existsSync(worktreeNodeModules)) {
    dependencies = { status: "exists", path: worktreeNodeModules };
  } else if (fs.existsSync(targetNodeModules)) {
    fs.symlinkSync(targetNodeModules, worktreeNodeModules, "dir");
    dependencies = {
      status: "linked",
      from: targetNodeModules,
      to: worktreeNodeModules,
    };
  }

  const runtime = ensureLocalRuntimeFiles({ worktreePath, targetRepo, runDir });
  const result = { dependencies, runtime };
  fs.writeFileSync(path.join(runDir, "worktree-runtime-bootstrap.json"), JSON.stringify(result, null, 2));
  return result;
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

async function requestJson({ baseUrl, path: requestPath, method = "GET", headers = {}, body }) {
  const response = await fetch(`${baseUrl}${requestPath}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return {
    statusCode: response.status,
    passed: response.status >= 200 && response.status < 400,
    body: text.slice(0, 700),
    json,
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

function renderProbeValue(value, variables) {
  if (typeof value === "string") {
    return value.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (_, key) => variables[key] || "");
  }
  if (Array.isArray(value)) return value.map((item) => renderProbeValue(item, variables));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, renderProbeValue(item, variables)]),
    );
  }
  return value;
}

async function requestBackendProbe({ baseUrl, probe }) {
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const variables = {
    nonce,
    longText: `long-text-${nonce}-${"x".repeat(700)}`,
    longUrl: `https://example.com/assets/${nonce}/${"x".repeat(520)}.jpg?source=ai-verification-probe`,
  };

  if (probe.setup === "signup") {
    const username = `probe${nonce}`;
    const email = `probe${nonce}@example.com`;
    variables.username = username;
    variables.email = email;
    variables.password = "password123";

    const signUp = await requestJson({
      baseUrl,
      path: "/api/users",
      method: "POST",
      body: {
        user: {
          username,
          email,
          password: variables.password,
        },
      },
    });

    if (!signUp.passed) {
      return {
        name: probe.name,
        path: probe.path,
        statusCode: signUp.statusCode,
        passed: false,
        body: `signup failed: ${signUp.body}`,
      };
    }

    variables.token = signUp.json?.user?.token || "";
  }

  const headers = renderProbeValue(probe.headers || {}, variables);
  const body = renderProbeValue(probe.body || null, variables);
  const expectedStatus = Number(probe.expectedStatus || 200);
  const responseContains = (probe.responseContains || []).map((item) => renderProbeValue(item, variables));
  const response = await requestJson({
    baseUrl,
    path: probe.path,
    method: probe.method || "GET",
    headers,
    body,
  });
  const missingText = responseContains.filter((item) => item && !response.body.includes(item));

  return {
    name: probe.name,
    path: probe.path,
    statusCode: response.statusCode,
    passed: response.statusCode === expectedStatus && missingText.length === 0,
    body: response.body,
    expectedStatus,
    missingText,
  };
}

async function planDynamicBackendProbes({ runDir, requirementStage, moduleStage, diff }) {
  const touchesBackend = hasAnyPath(moduleStage, [
    /backend\/controllers\//,
    /backend\/routes\//,
    /backend\/models\//,
  ]);
  if (!touchesBackend) return [];

  const prompt = [
    "你是 Conduit/RealWorld 仓库的验证用例规划 Agent。只输出 JSON，不要 markdown。",
    "目标：根据 PM 需求和本次 diff 生成最多 2 个后端 smoke probe，覆盖最可能漏掉的真实用户边界输入。",
    "不要针对某个固定需求写死；请从需求本身推导输入，例如长文本、长 URL、空值、重复值、权限、旧数据兼容。",
    "只允许使用本地 Conduit API；不得请求外网。",
    "可用占位符：{{nonce}}, {{token}}, {{username}}, {{email}}, {{password}}, {{longText}}, {{longUrl}}。",
    "如果需要登录态，setup 使用 signup，Authorization header 写成 Token {{token}}。",
    "",
    "JSON schema:",
    JSON.stringify(
      {
        backendProbes: [
          {
            name: "probe name",
            setup: "signup | none",
            method: "POST",
            path: "/api/articles",
            headers: { Authorization: "Token {{token}}" },
            body: {},
            expectedStatus: 201,
            responseContains: ["optional expected response substring"],
          },
        ],
      },
      null,
      2,
    ),
    "",
    "PM 需求澄清:",
    JSON.stringify(requirementStage?.data || {}, null, 2),
    "",
    "模块定位:",
    JSON.stringify({
      matchedDomains: moduleStage?.data?.matchedDomains || [],
      editBoundary: moduleStage?.data?.editBoundary || [],
    }, null, 2),
    "",
    "本次 diff:",
    diff.slice(0, 16000),
  ].join("\n");

  const content = await chatCompletion({
    runDir,
    purpose: "verification_probe_planning",
    temperature: 0.05,
    messages: [
      { role: "system", content: "你只输出合法 JSON。" },
      { role: "user", content: prompt },
    ],
  });
  fs.writeFileSync(path.join(runDir, "verification-probes-raw.json"), content);

  const parsed = parseJson(content) || {};
  const probes = Array.isArray(parsed.backendProbes) ? parsed.backendProbes : [];
  const safeProbes = probes
    .filter((probe) => probe && typeof probe.path === "string" && probe.path.startsWith("/api/"))
    .filter((probe) => ["GET", "POST", "PUT", "DELETE", undefined].includes(probe.method))
    .slice(0, 2);
  fs.writeFileSync(path.join(runDir, "verification-probes.json"), JSON.stringify(safeProbes, null, 2));
  return safeProbes;
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

async function runBackendSmoke({ worktreePath, runDir, moduleStage, dynamicProbes = [] }) {
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
    for (const probe of dynamicProbes) {
      checks.push(await requestBackendProbe({ baseUrl, probe }));
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
  requirementStage,
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
  const diff = saveDiff({ gitRootPath, targetRelativePath, runDir });
  const dynamicProbes = await planDynamicBackendProbes({ runDir, requirementStage, moduleStage, diff });
  const backendSmoke = await runBackendSmoke({ worktreePath, runDir, moduleStage, dynamicProbes });
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
      dynamicProbes,
      dependencies,
      runtime,
      diffBytes: Buffer.byteLength(diff),
      diffFile: "changes.patch",
    },
  };
}

module.exports = {
  bootstrapWorktreeRuntime,
  runVerification,
};
