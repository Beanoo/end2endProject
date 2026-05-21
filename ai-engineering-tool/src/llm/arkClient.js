const { writeFileSync, appendFileSync } = require("fs");
const path = require("path");

const defaultBaseUrl = "https://ark.cn-beijing.volces.com/api/v3";
const defaultModel = "ep-20260514110933-mzh58";

function getArkConfig() {
  return {
    apiKey: process.env.ARK_API_KEY,
    baseUrl: process.env.ARK_BASE_URL || defaultBaseUrl,
    model: process.env.ARK_MODEL || defaultModel,
  };
}

function requireArkConfig() {
  const config = getArkConfig();
  if (!config.apiKey) {
    const error = new Error("ARK_API_KEY is required for model-backed P1 workflow");
    error.status = 500;
    throw error;
  }
  return config;
}

function writeModelCall(runDir, payload) {
  appendFileSync(
    path.join(runDir, "model-calls.jsonl"),
    `${JSON.stringify(payload)}\n`,
  );
}

async function chatCompletion({ messages, runDir, purpose, temperature = 0.2 }) {
  const config = requireArkConfig();
  const started = Date.now();
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      temperature,
    }),
  });
  const latencyMs = Date.now() - started;
  const body = await response.json();

  writeModelCall(runDir, {
    purpose,
    model: config.model,
    status: response.status,
    latencyMs,
    usage: body.usage || null,
    createdAt: new Date().toISOString(),
  });

  if (!response.ok) {
    writeFileSync(
      path.join(runDir, `${purpose}-model-error.json`),
      JSON.stringify(body, null, 2),
    );
    const error = new Error(body.error?.message || `Model call failed: ${response.status}`);
    error.status = 502;
    throw error;
  }

  return body.choices?.[0]?.message?.content || "";
}

module.exports = {
  chatCompletion,
  getArkConfig,
};

