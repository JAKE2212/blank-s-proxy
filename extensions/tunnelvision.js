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

const {
  getOrCreateTree,
  loadTree,
  saveTree,
  sanitizeCharName,
  listTrees,
  buildTreeOverview,
  addNode,
  deleteTree,
} = require("../lib/tunnelvision/tv-tree");

const {
  buildToolDefinitions,
  dispatchToolCall,
} = require("../lib/tunnelvision/tv-tools");

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, "../data/tunnelvision-config.json");

const DEFAULT_CONFIG = {
  enabled: true,
  activeTree: null, // manually set via dashboard — overrides auto-detection
  autoDetect: true, // extract bot name from <BotName's Persona> tag
  injectContext: true, // prepend retrieved context into system prompt
  maxContextChars: 3000, // cap on injected context length
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
    console.warn(
      "[tunnelvision] Failed to load config, using defaults:",
      e.message,
    );
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

/**
 * Extract the bot name from the system prompt.
 * JanitorAI wraps every bot card in <BotName's Persona><BotName>...</BotName></BotName's Persona>
 * We extract "BotName" from that tag.
 *
 * @param {object[]} messages
 * @returns {string|null}
 */
function extractBotName(messages) {
  const systemMsg = messages.find((m) => m.role === "system");
  if (!systemMsg) return null;

  const text =
    typeof systemMsg.content === "string"
      ? systemMsg.content
      : (systemMsg.content?.[0]?.text ?? "");

  // Match <BotName's Persona> — name is 1-40 chars, starts with uppercase
  const match = text.match(/<([A-Za-z][A-Za-z0-9 '_-]{0,39})'s Persona>/);
  if (!match) return null;

  return sanitizeCharName(match[1]);
}

// ── Tool call extraction ──────────────────────────────────────────────────────

/**
 * Extract tool calls from an OpenRouter response.
 * Handles both the standard tool_calls array and text-embedded JSON fallback.
 * @param {object} responseData
 * @returns {Array<{ id, name, args }>}
 */
function extractToolCalls(responseData) {
  const choice = responseData?.choices?.[0];
  if (!choice) return [];

  // Standard OpenAI tool_calls format
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

/**
 * Execute all tool calls in a response, return their results.
 * @param {object} tree
 * @param {Array<{ id, name, args }>} toolCalls
 * @returns {Array<{ tool_call_id, role, content }>}
 */
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

/**
 * Run the tool call loop: send request → get tool call → execute → send results → repeat.
 * Caps at MAX_TOOL_ROUNDS to prevent infinite loops.
 * Returns the final non-tool-call response.
 *
 * @param {object} payload     — the full request payload (with tools injected)
 * @param {object} tree        — the active tree
 * @param {function} sendFn    — async fn(payload) → { ok, data } (sendToOpenRouter)
 * @returns {Promise<object>}  — final response data
 */
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
        // The assistant's tool call message
        {
          role: "assistant",
          content: result.data.choices[0].message.content ?? null,
          tool_calls: result.data.choices[0].message.tool_calls,
        },
        // Tool results
        ...toolResults,
      ],
    };
  }

  console.warn(
    `[tunnelvision] Max tool rounds (${MAX_TOOL_ROUNDS}) reached — forcing final response`,
  );

  // Force a final response with tools disabled
  const finalPayload = {
    ...currentPayload,
    tool_choice: "none",
  };
  return sendFn(finalPayload);
}

// ── State ─────────────────────────────────────────────────────────────────────

// Carries the active tree name across request→response within the same turn
let _pendingTreeName = null;
let _pendingTree = null;

// ── Tree priming ──────────────────────────────────────────────────────────────

/**
 * Pre-extract bot name from raw messages before extensions transform them.
 * Called from index.js before the extension pipeline runs.
 * @param {object[]} messages
 */
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

// GET /extensions/tunnelvision/status
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

// GET /extensions/tunnelvision/trees
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

// GET /extensions/tunnelvision/tree/:name
router.get("/tree/:name", (req, res) => {
  const tree = loadTree(req.params.name);
  if (!tree)
    return res.status(404).json({ ok: false, error: "Tree not found" });
  res.json({ ok: true, tree });
});

// GET /extensions/tunnelvision/tree/:name/overview
router.get("/tree/:name/overview", (req, res) => {
  const tree = loadTree(req.params.name);
  if (!tree)
    return res.status(404).json({ ok: false, error: "Tree not found" });
  res.json({
    ok: true,
    overview: buildTreeOverview(tree, { includeEntryTitles: true }),
  });
});

// POST /extensions/tunnelvision/tree/:name/node — add a node
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

// POST /extensions/tunnelvision/config — update config
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

// DELETE /extensions/tunnelvision/tree/:name — delete a tree
router.delete("/tree/:name", (req, res) => {
  try {
    deleteTree(req.params.name);
    res.json({ ok: true, deleted: req.params.name });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Extension hooks ───────────────────────────────────────────────────────────

/**
 * transformRequest — called before the request goes to OpenRouter.
 * Injects TunnelVision tool definitions into the payload.
 * Does NOT run the tool loop here — that happens in transformResponse
 * by intercepting at a higher level. Instead we just inject the tools
 * and let the model decide whether to call them.
 *
 * NOTE: Because our tool loop needs to call OpenRouter multiple times,
 * we export a custom `handleRequest` that wraps the full cycle.
 * transformRequest here just tags state and injects tools.
 */
async function transformRequest(payload) {
  const config = loadConfig();
  if (!config.enabled) return payload;

  const messages = payload.messages ?? [];

  // Use primed tree name if already set, otherwise resolve now
  let treeName =
    _pendingTreeName ??
    config.activeTree ??
    (config.autoDetect ? extractBotName(messages) : null);

  if (!treeName) {
    console.log("[tunnelvision] No tree name resolved — skipping");
    return payload;
  }

  // Load or create tree
  const tree = getOrCreateTree(treeName);
  _pendingTreeName = treeName;
  _pendingTree = tree;

  console.log(
    `[tunnelvision] Active tree: "${treeName}" (${Object.keys(tree.nodes).length} nodes)`,
  );

  // Inject tool definitions
  const tools = buildToolDefinitions(tree);

  return {
    ...payload,
    tools: [...(payload.tools ?? []), ...tools],
    tool_choice: payload.tool_choice ?? "auto",
  };
}

/**
 * transformResponse — called after OpenRouter returns a response.
 * At this point the tool loop has already been handled by the proxy's
 * main handler via our exported runToolLoop. This hook handles any
 * final cleanup (e.g. stripping tool metadata from the response).
 */

// ── Tool loop integration ─────────────────────────────────────────────────────

/**
 * Wrap sendToOpenRouter with TunnelVision's tool loop.
 * Called from index.js instead of sendToOpenRouter directly when TV is active.
 *
 * Usage in index.js:
 *   const { wrapSendWithToolLoop } = require("./extensions/tunnelvision");
 *   const result = await wrapSendWithToolLoop(transformedPayload, sendToOpenRouter);
 *
 * @param {object}   payload
 * @param {function} sendFn
 * @returns {Promise<{ ok, data?, status?, error? }>}
 */
async function wrapSendWithToolLoop(payload, sendFn) {
  const config = loadConfig();
  if (!config.enabled || !_pendingTreeName) {
    return sendFn(payload);
  }

  const tree = _pendingTree ?? loadTree(_pendingTreeName);
  if (!tree) return sendFn(payload);

  // Check if any TunnelVision tools are in this payload
  const hasTVTools = (payload.tools ?? []).some((t) =>
    t.function?.name?.startsWith("TunnelVision_"),
  );
  if (!hasTVTools) return sendFn(payload);

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
