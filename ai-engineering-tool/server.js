const fs = require("fs");
const http = require("http");
const path = require("path");
const { defaultTargetRepo, port, projectRoot } = require("./src/config");
const { getRepoStatus } = require("./src/git");
const { confirmWorkflow, readWorkflow, runWorkflow } = require("./src/orchestrator");

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
  });
}

function serveStatic(res) {
  const indexPath = path.join(projectRoot, "public", "index.html");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(indexPath));
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/target/status") {
      return sendJson(res, 200, {
        targetRepo: defaultTargetRepo,
        git: getRepoStatus(defaultTargetRepo),
      });
    }

    if (req.method === "POST" && req.url === "/api/workflows") {
      const body = await readBody(req);
      return sendJson(res, 201, await runWorkflow(body));
    }

    const confirmMatch = req.url.match(/^\/api\/workflows\/([^/]+)\/confirm$/);
    if (req.method === "POST" && confirmMatch) {
      const body = await readBody(req);
      return sendJson(res, 201, await confirmWorkflow(confirmMatch[1], body));
    }

    const workflowMatch = req.url.match(/^\/api\/workflows\/([^/]+)$/);
    if (req.method === "GET" && workflowMatch) {
      return sendJson(res, 200, readWorkflow(workflowMatch[1]));
    }

    if (req.method === "GET") {
      return serveStatic(res);
    }

    return sendJson(res, 404, { error: "not found" });
  } catch (error) {
    return sendJson(res, error.status || 500, {
      error: error.message,
    });
  }
});

server.listen(port, () => {
  console.log(`AI engineering tool running on http://localhost:${port}`);
  console.log(`Target Conduit repo: ${defaultTargetRepo}`);
});
