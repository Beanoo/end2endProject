const { writeFileSync, appendFileSync } = require("fs");
const path = require("path");
const { loadLocalEnv } = require("../env");

loadLocalEnv();

const defaultBaseUrl = "https://ark.cn-beijing.volces.com/api/v3";
const defaultModel = "ep-20260514110933-mzh58";

function firstPresent(...values) {
  return values.find((value) => typeof value === "string" && value.trim());
}

function normalizeBaseUrl(baseUrl) {
  return baseUrl.replace(/\/+$/, "");
}

function getLlmConfig() {
  return {
    apiKey: firstPresent(
      process.env.LLM_API_KEY,
      process.env.DEEPSEEK_API_KEY,
      process.env.ARK_API_KEY,
    ),
    baseUrl: normalizeBaseUrl(
      firstPresent(
        process.env.LLM_BASE_URL,
        process.env.DEEPSEEK_BASE_URL,
        process.env.ARK_BASE_URL,
        defaultBaseUrl,
      ),
    ),
    model: firstPresent(
      process.env.LLM_MODEL,
      process.env.DEEPSEEK_MODEL,
      process.env.ARK_MODEL,
      defaultModel,
    ),
  };
}

function requireLlmConfig() {
  const config = getLlmConfig();
  if (!config.apiKey) {
    const error = new Error(
      "LLM_API_KEY is required for model-backed workflow. " +
        "DEEPSEEK_API_KEY and ARK_API_KEY are also supported.",
    );
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
  const config = requireLlmConfig();
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
  const rawBody = await response.text();
  let body = {};
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = { raw: rawBody };
  }

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
  getArkConfig: getLlmConfig,
  getLlmConfig,
};
