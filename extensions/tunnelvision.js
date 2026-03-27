"use strict";

/**
 * tunnelvision.js — TunnelVision extension (priority 26)
 * Hierarchical lorebook retrieval via real tool calls.
 *
 * transformRequest  → extract bot name → load tree → inject tool definitions
 * transformResponse → detect tool calls → dispatch → return results → loop until done
 * router            → dashboard API endpoints
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const { resolveAlias } = require("../lib/character-detector");

const {
  getOrCreateTree,
  loadTree,
  saveTree,
  sanitizeCharName,
  listTrees,
  buildTreeOverview,
  addNode,
  deleteTree,
  runDiagnostics,
} = require("../lib/tunnelvision/tv-tree");

const {
  buildToolDefinitions,
  dispatchToolCall,
} = require("../lib/tunnelvision/tv-tools");

const localModels = require("../lib/local-models");

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, "../data/tunnelvision-config.json");

const DEFAULT_CONFIG = {
  enabled: true,
  activeTree: null,
  autoDetect: true,
  injectContext: true,
  maxContextChars: 3000,
  searchMode: "auto",
  traversalThreshold: 15,
};

let _configCache = null;

function loadConfig() {
  if (_configCache) return _configCache;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      _configCache = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) };
      return _configCache;
    }
  } catch (e) {
    console.warn("[tunnelvision] Failed to load config, using defaults:", e.message);
  }
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  } catch {}
  _configCache = { ...DEFAULT_CONFIG };
  return _configCache;
}

function saveConfig(config) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
    _configCache = null;
  } catch (e) {
    console.warn("[tunnelvision] Failed to save config:", e.message);
  }
}

// ── Bot name extraction ───────────────────────────────────────────────────────

function extractBotName(messages) {
  const systemMsg = messages.find((m) => m.role === "system");
  if (!systemMsg) return null;

  const text =
    typeof systemMsg.content === "string"
      ? systemMsg.content
      : (systemMsg.content?.[0]?.text ?? "");

  const match = text.match(/<([A-Za-z][A-Za-z0-9 '_-]{0,39})'s Persona>/);
  if (!match) return null;

  return sanitizeCharName(resolveAlias(match[1].toLowerCase()));
}

// ── Tool call extraction ──────────────────────────────────────────────────────

function extractToolCalls(responseData) {
  const choice = responseData?.choices?.[0];
  if (!choice) return [];

  const toolCalls = choice.message?.tool_calls;
  if (Array.isArray(toolCalls) && toolCalls.length > 0) {
    return toolCalls
      .map((tc) => ({
        id: tc.id,
        name: tc.function?.name,
        args: (() => {
          try {
            return JSON.parse(tc.function?.arguments ?? "{}");
          } catch {
            return {};
          }
        })(),
      }))
      .filter((tc) => tc.name?.startsWith("TunnelVision_"));
  }

  return [];
}

// ── Tool call loop ────────────────────────────────────────────────────────────

function executeToolCalls(tree, toolCalls) {
  const results = [];
  for (const tc of toolCalls) {
    console.log(
      `[tunnelvision] Tool call: ${tc.name}`,
      JSON.stringify(tc.args).slice(0, 200),
    );
    const result = dispatchToolCall(tree, tc.name, tc.args);
    console.log(`[tunnelvision] Tool result: ${result.slice(0, 200)}`);
    results.push({
      tool_call_id: tc.id,
      role: "tool",
      content: result,
    });
  }
  return results;
}

const MAX_TOOL_ROUNDS = 6;

async function runToolLoop(payload, tree, sendFn) {
  let currentPayload = { ...payload };
  let round = 0;

  while (round < MAX_TOOL_ROUNDS) {
    const result = await sendFn(currentPayload);
    if (!result.ok) return result;

    const toolCalls = extractToolCalls(result.data);

    // No tool calls — this is the final narrative response
    if (!toolCalls.length) return result;

    round++;
    console.log(
      `[tunnelvision] Tool round ${round}/${MAX_TOOL_ROUNDS}: ${toolCalls.map((tc) => tc.name).join(", ")}`,
    );

    // Execute tool calls against the tree
    const toolResults = executeToolCalls(tree, toolCalls);

    // Append assistant tool call message + tool results to conversation
    currentPayload = {
      ...currentPayload,
      messages: [
        ...currentPayload.messages,
        {
          role: "assistant",
          content: result.data.choices[0].message.content ?? null,
          tool_calls: result.data.choices[0].message.tool_calls,
        },
        ...toolResults,
      ],
    };
  }

  console.warn(
    `[tunnelvision] Max tool rounds (${MAX_TOOL_ROUNDS}) reached — forcing final response`,
  );

  const finalPayload = {
    ...currentPayload,
    tool_choice: "none",
  };
  return sendFn(finalPayload);
}

// ── State ─────────────────────────────────────────────────────────────────────

let _pendingTreeName = null;
let _pendingTree = null;

// ── Tree priming ──────────────────────────────────────────────────────────────

function primeTreeName(messages) {
  const config = loadConfig();
  if (!config.enabled) return;
  const name =
    config.activeTree ?? (config.autoDetect ? extractBotName(messages) : null);
  if (name) {
    _pendingTreeName = name;
    _pendingTree = getOrCreateTree(name);
    console.log(`[tunnelvision] Primed tree: "${name}"`);
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

const router = express.Router();

router.get("/status", (req, res) => {
  const config = loadConfig();
  const trees = listTrees();
  const active = config.activeTree ?? _pendingTreeName;
  const tree = active ? loadTree(active) : null;

  res.json({
    ok: true,
    config,
    activeName: active,
    treeExists: !!tree,
    nodeCount: tree ? Object.keys(tree.nodes).length : 0,
    entryCount: tree
      ? Object.values(tree.nodes).reduce((s, n) => s + (n.entries?.filter(e => e.enabled !== false).length ?? 0), 0)
      : 0,
    trees,
  });
});

router.get("/trees", (req, res) => {
  const trees = listTrees().map((name) => {
    const tree = loadTree(name);
    return {
      name,
      nodeCount: tree ? Object.keys(tree.nodes).length : 0,
      entryCount: tree
        ? Object.values(tree.nodes).reduce(
            (s, n) => s + n.entries.filter((e) => e.enabled !== false).length,
            0,
          )
        : 0,
      updatedAt: tree?.updatedAt ?? null,
    };
  });
  res.json({ ok: true, trees });
});

router.get("/tree/:name", (req, res) => {
  const tree = loadTree(req.params.name);
  if (!tree)
    return res.status(404).json({ ok: false, error: "Tree not found" });
  res.json({ ok: true, tree });
});

router.get("/tree/:name/overview", (req, res) => {
  const tree = loadTree(req.params.name);
  if (!tree)
    return res.status(404).json({ ok: false, error: "Tree not found" });
  res.json({
    ok: true,
    overview: buildTreeOverview(tree, { includeEntryTitles: true }),
  });
});

router.post("/tree/:name/node", (req, res) => {
  const tree = loadTree(req.params.name);
  if (!tree)
    return res.status(404).json({ ok: false, error: "Tree not found" });
  const { parentId, label, summary, tags } = req.body;
  if (!label)
    return res.status(400).json({ ok: false, error: "label is required" });
  try {
    const node = addNode(tree, parentId ?? tree.rootId, label, {
      summary,
      tags,
    });
    res.json({ ok: true, node });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post("/config", (req, res) => {
  try {
    const current = loadConfig();
    const updated = { ...current, ...req.body };
    saveConfig(updated);
    res.json({ ok: true, config: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete("/tree/:name", (req, res) => {
  try {
    deleteTree(req.params.name);
    res.json({ ok: true, deleted: req.params.name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/tree/:name/diagnostics", (req, res) => {
  const tree = loadTree(req.params.name);
  if (!tree)
    return res.status(404).json({ ok: false, error: "Tree not found" });
  try {
    const result = runDiagnostics(tree);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/tree/:name/diagnostics", (req, res) => {
  const tree = loadTree(req.params.name);
  if (!tree)
    return res.status(404).json({ ok: false, error: "Tree not found" });
  try {
    const result = runDiagnostics(tree);
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Extension hooks ───────────────────────────────────────────────────────────

async function transformRequest(payload) {
  const config = loadConfig();
  if (!config.enabled) return payload;

  const messages = payload.messages ?? [];

  let treeName =
    _pendingTreeName ??
    config.activeTree ??
    (config.autoDetect ? extractBotName(messages) : null);

  if (!treeName) {
    console.log("[tunnelvision] No tree name resolved — skipping");
    return payload;
  }

  const tree = getOrCreateTree(treeName);
  _pendingTreeName = treeName;
  _pendingTree = tree;

  console.log(
    `[tunnelvision] Active tree: "${treeName}" (${Object.keys(tree.nodes).length} nodes)`,
  );

  const nodeCount = Object.keys(tree.nodes).length;
  const mode = config.searchMode ?? "auto";
  const forceTraversal = mode === "traversal" || (mode === "auto" && nodeCount >= (config.traversalThreshold ?? 15));
  const tools = buildToolDefinitions(tree, { forceTraversal });

  console.log(`[tunnelvision] Search mode: ${forceTraversal ? "traversal" : "collapsed"} (${nodeCount} nodes, config: ${mode})`);

  return {
    ...payload,
    tools: [...(payload.tools ?? []), ...tools],
    tool_choice: payload.tool_choice ?? "auto",
  };
}

// ── Tool loop integration ─────────────────────────────────────────────────────

/**
 * Build a custom sendFn for TunnelVision model override.
 * Bypasses account-level provider preferences (e.g. Bedrock)
 * by making a direct fetch with explicit provider settings.
 */
function buildOverrideSendFn() {
  return async (p) => {
    const body = { ...p, provider: { allow_fallbacks: true } };
    try {
      console.log(`[tunnelvision] Sending to OpenRouter: ${body.model}`);
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "HTTP-Referer": "https://proxy.kiana-designs.com",
          "X-Title": "Kiana Proxy",
        },
        signal: AbortSignal.timeout(120_000),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        console.log(`[tunnelvision] OpenRouter error: ${res.status} ${txt.slice(0, 200)}`);
        return { ok: false, status: res.status, error: txt };
      }
      const data = await res.json();
      console.log(`[tunnelvision] OpenRouter success: ${body.model}`);
      return { ok: true, data };
    } catch (e) {
      console.log(`[tunnelvision] OpenRouter fetch error: ${e.message}`);
      return { ok: false, error: e.message };
    }
  };
}

async function wrapSendWithToolLoop(payload, sendFn) {
  const config = loadConfig();
  if (!config.enabled || !_pendingTreeName) {
    return sendFn(payload);
  }

  const tree = _pendingTree ?? loadTree(_pendingTreeName);
  if (!tree) return sendFn(payload);

  const hasTVTools = (payload.tools ?? []).some((t) =>
    t.function?.name?.startsWith("TunnelVision_"),
  );
  if (!hasTVTools) return sendFn(payload);

  // If a TV model override is configured, use a custom sendFn
  // that bypasses account-level provider preferences
  const lm = localModels.loadConfig();
  if (lm.tunnelvisionOpenRouterModel) {
    const tvPayload = { ...payload, model: lm.tunnelvisionOpenRouterModel };
    return runToolLoop(tvPayload, tree, buildOverrideSendFn());
  }

  return runToolLoop(payload, tree, sendFn);
}

module.exports = {
  name: "TunnelVision",
  version: "1.0.0",
  priority: 26,
  router,
  transformRequest,
  wrapSendWithToolLoop,
  extractBotName,
  primeTreeName,
};