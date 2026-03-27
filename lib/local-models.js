"use strict";

/**
 * lib/local-models.js
 * Shared local model config + Ollama API helper.
 *
 * Currently used by:
 *   - recast.js — local YES/NO checks via Ollama
 *   - tunnelvision.js — OpenRouter model override for tool calls
 *
 * Config file: data/local-models-config.json
 */

const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "../data/local-models-config.json");

const DEFAULT_CONFIG = {
  ollamaUrl: "http://192.168.1.193:11434",

  // Recast — local Ollama for YES/NO checks
  recastLocal: true,
  recastCheckModel: "qwen2.5:7b",

  // TunnelVision — override model on OpenRouter (null = use main RP model)
  tunnelvisionOpenRouterModel: null,
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
 * Used by recast.js for fast YES/NO checks.
 *
 * @param {string} systemPrompt
 * @param {string} userContent
 * @param {string} model         — Ollama model name e.g. "qwen2.5:7b"
 * @param {number} maxTokens     — passed as num_predict
 * @param {object} [extra]       — optional extra Ollama params
 * @returns {Promise<string>}    — response text
 */
async function callOllama(systemPrompt, userContent, model, maxTokens, extra = {}) {
  const cfg = loadConfig();
  const url = `${cfg.ollamaUrl}/api/chat`;
  const body = {
    model,
    stream: false,
    options: { num_predict: maxTokens, ...extra },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userContent },
    ],
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Ollama ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data?.message?.content?.trim() ?? "";
}

module.exports = {
  loadConfig,
  saveConfig,
  invalidateCache,
  callOllama,
};