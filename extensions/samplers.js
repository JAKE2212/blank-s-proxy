"use strict";
// ============================================================
// extensions/samplers.js — Sampler Settings Extension
// Injects sampler parameters into outgoing requests.
// Exposes a REST API for the dashboard to read/write settings.
// Claude models only support top_p and top_k via OpenRouter.
// Other models (OpenAI etc.) support the full set.
// ============================================================
const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();

// ── Config file path ───────────────────────────────────────
const CONFIG_FILE = path.join(__dirname, "..", "data", "sampler-config.json");

// ── Sampler definitions ────────────────────────────────────
// Each entry has a default value, enabled state, valid range,
// step size, and which model families support it.
const SAMPLER_DEFS = {
  top_p: {
    label: "Top P",
    description:
      "Nucleus sampling — keeps tokens until cumulative probability hits this value.",
    default: 0.9,
    min: 0.0,
    max: 1.0,
    step: 0.01,
    models: ["claude", "openai", "other"], // supported by all
  },
  top_k: {
    label: "Top K",
    description:
      "Hard limit on how many tokens can be considered. Lower = more focused.",
    default: 40,
    min: 1,
    max: 200,
    step: 1,
    models: ["claude", "openai", "other"],
  },
  min_p: {
    label: "Min P",
    description:
      "Filters tokens below this fraction of the top token's probability.",
    default: 0.05,
    min: 0.0,
    max: 1.0,
    step: 0.01,
    models: ["openai", "other"], // NOT supported by Claude via OpenRouter
  },
  presence_penalty: {
    label: "Presence Penalty",
    description: "Discourages any token that has appeared at least once.",
    default: 0.0,
    min: -2.0,
    max: 2.0,
    step: 0.05,
    models: ["claude", "openai", "other"],
  },
  frequency_penalty: {
    label: "Frequency Penalty",
    description: "Progressively discourages tokens the more often they appear.",
    default: 0.0,
    min: -2.0,
    max: 2.0,
    step: 0.05,
    models: ["claude", "openai", "other"],
  },
  repetition_penalty: {
    label: "Repetition Penalty",
    description:
      "Asymmetric penalty — divides positive logits, multiplies negative ones.",
    default: 1.0,
    min: 1.0,
    max: 1.5,
    step: 0.01,
    models: ["claude", "openai", "other"],
  },
};

// ── Detect model family from model string ──────────────────
// Returns "claude", "openai", or "other"
function getModelFamily(model) {
  if (!model) return "other";
  const m = model.toLowerCase();
  if (m.includes("claude") || m.includes("anthropic")) return "claude";
  if (
    m.includes("gpt") ||
    m.includes("openai") ||
    m.includes("o1") ||
    m.includes("o3")
  )
    return "openai";
  return "other";
}

// ── Build default config ───────────────────────────────────
// Generates the full config object from SAMPLER_DEFS
function buildDefaults() {
  const defaults = {};
  for (const [key, def] of Object.entries(SAMPLER_DEFS)) {
    defaults[key] = { enabled: false, value: def.default };
  }
  return defaults;
}
let _configCache = null;

function loadConfig() {
  if (_configCache) return _configCache;
  try {
    if (!fs.existsSync(CONFIG_FILE)) { _configCache = buildDefaults(); return _configCache; }
    _configCache = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return _configCache;
  } catch (e) {
    console.warn("[samplers] Failed to load config, using defaults:", e.message);
    _configCache = buildDefaults();
    return _configCache;
  }
}

// ── Save config to disk ────────────────────────────────────
function saveConfig(config) {
  try {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), "utf8");
    _configCache = null;
  } catch (e) {
    console.warn("[samplers] Failed to save config:", e.message);
  }
}

// ── GET /extensions/samplers/config ───────────────────────
// Returns current config + sampler definitions for the dashboard
// Accepts optional ?model= query param to filter supported samplers
router.get("/config", (req, res) => {
  const model = req.query.model || "";
  const family = getModelFamily(model);
  const config = loadConfig();

  // Filter SAMPLER_DEFS to only those supported by this model family
  const supported = {};
  for (const [key, def] of Object.entries(SAMPLER_DEFS)) {
    if (def.models.includes(family)) {
      supported[key] = def;
    }
  }

  res.json({ ok: true, config, defs: supported, family });
});

// ── POST /extensions/samplers/config ──────────────────────
// Saves updated sampler settings from the dashboard
router.post("/config", (req, res) => {
  try {
    const incoming = req.body;
    const valid = {};

    for (const key of Object.keys(SAMPLER_DEFS)) {
      if (incoming[key] !== undefined) {
        valid[key] = {
          enabled: Boolean(incoming[key].enabled),
          value: Number(incoming[key].value),
        };
      }
    }

    const merged = { ...loadConfig(), ...valid };
    saveConfig(merged);
    res.json({ ok: true, config: merged });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── transformRequest ───────────────────────────────────────
// Called by index.js before every outgoing request.
// Only injects samplers that are supported by the model family.
function transformRequest(payload) {
  const config = loadConfig();
  const family = getModelFamily(payload.model);
  const params = {};

  for (const [key, setting] of Object.entries(config)) {
    // Skip if disabled
    if (!setting.enabled) continue;

    // Skip if this sampler isn't supported by the model family
    const def = SAMPLER_DEFS[key];
    if (!def || !def.models.includes(family)) continue;

    params[key] = setting.value;
  }

  // Merge — configured sampler values override payload defaults
  return { ...payload, ...params };
}

// ── Export ─────────────────────────────────────────────────
// change the existing module.exports line to:
module.exports = {
  name: "Samplers",
  version: "1.0",
  priority: 30,
  router,
  transformRequest,
};
