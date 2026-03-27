"use strict";

/**
 * lib/local-models.js
 * Shared local model config + Ollama API helper.
 * Used by recast.js (checks) and tunnelvision.js (tool loop).
 *
 * Config file: data/local-models-config.json
 */

const fs   = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "../data/local-models-config.json");

const DEFAULT_CONFIG = {
  enabled: true,                          // master switch — false = all extensions fall back to OpenRouter
  ollamaUrl: "http://192.168.1.193:11434",

  // Per-task model overrides
  recastCheckModel:   "qwen2.5:7b",       // YES/NO checks in recast.js
  tunnelvisionModel:  "glm-4.7-flash",    // tool loop in tunnelvision.js
};

let _cache = null;

function loadConfig() {
  if (_cache) return _cache;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      _cache = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
      return _cache;
    }
  } catch (e) {
    console.warn("[local-models] Failed to load config:", e.message);
  }
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  } catch {}
  _cache = { ...DEFAULT_CONFIG };
  return _cache;
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  _cache = null;
}

function invalidateCache() {
  _cache = null;
}

/**
 * Call Ollama's /api/chat endpoint.
 * Mirrors the callOpenRouter() signature used in recast.js.
 *
 * @param {string} systemPrompt 
 * @param {string} userContent
 * @param {string} model         - Ollama model name e.g. "qwen2.5:7b"
 * @param {number} maxTokens     - passed as num_predict
 * @param {object} [extra]       - optional extra Ollama params
 * @returns {Promise<string>}    - response text
 */
async function callOllama(systemPrompt, userContent, model, maxTokens, extra = {}) {
  const cfg = loadConfig();
  const url = `${cfg.ollamaUrl}/api/chat`;

  const body = {
    model,
    stream: false,
    options: { num_predict: maxTokens, ...extra },
    messages: [
      { role: "system",  content: systemPrompt },
      { role: "user",    content: userContent  },
    ],
  };

  const res = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    signal:  AbortSignal.timeout(120_000),   // 2 min — CPU inference can be slow
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${txt}`);
  }

  const data = await res.json();
  return data?.message?.content?.trim() ?? "";
}

/**
 * Call Ollama's /api/chat endpoint with tool support (for TunnelVision).
 * Uses the OpenAI-compatible /v1/chat/completions endpoint that Ollama exposes,
 * so tool_calls come back in the standard format the tool loop already handles.
 *
 * @param {object} payload  - full OpenAI-compatible payload (messages, tools, tool_choice, etc.)
 * @param {string} model    - Ollama model name
 * @returns {Promise<{ ok: boolean, data?: object, status?: number, error?: string }>}
 */
async function callOllamaWithTools(payload, model) {
  const cfg = loadConfig();
  const url = `${cfg.ollamaUrl}/v1/chat/completions`;

  const body = {
    ...payload,
    model,
    stream: false,
  };

  try {
    const res = await fetch(url, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      signal:  AbortSignal.timeout(300_000),  // 5 min — 32B on CPU needs time
      body:    JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, status: res.status, error: txt };
    }

    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = {
  loadConfig,
  saveConfig,
  invalidateCache,
  callOllama,
  callOllamaWithTools,
};