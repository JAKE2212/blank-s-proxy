"use strict";

/**
 * rag.js — Advanced RAG extension (priority 25)
 * Semantic memory retrieval using Qdrant + Ollama.
 *
 * transformRequest  → inject emotion instruction → retrieve relevant context → inject into system prompt
 * transformResponse → extract emotion tag → strip it → index turn with emotion → store for next retrieval
 * router            → dashboard API endpoints
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const { retrieve, indexTurn } = require("../lib/rag-retriever");
const { getPointCount } = require("../lib/rag-store");

// ── Config ────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, "../data/rag-config.json");

const DEFAULT_CONFIG = {
  enabled: true,
  qdrantUrl: "http://192.168.1.192:6333",
  ollamaUrl: "http://192.168.1.193:11434",
  ollamaModel: "mxbai-embed-large",
  collectionPrefix: "rag_",
  topK: 5,
  queryDepth: 3,
  scoreThreshold: 0.3,
  decayEnabled: true,
  decayHalfLife: 50,
  decayFloor: 0.3,
  maxInjectionChars: 2000,
  emotionEnabled: true,
  emotionBoost: 0.1,
  decayMode: "exponential", // 'exponential' or 'linear'
  chunkingStrategy: "per_message", // 'per_message' or 'conversation_turns'
  rules: [], // conditional activation rules
  blindNextTurn: false, // if true, next indexed turn is marked temporally blind // score boost when emotion matches
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      return { ...DEFAULT_CONFIG, ...saved };
    }
  } catch (e) {
    console.warn("[rag] Failed to load config, using defaults:", e.message);
  }
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log("[rag] Created default config at data/rag-config.json");
  } catch {}
  return { ...DEFAULT_CONFIG };
}

// ── Emotion handling ──────────────────────────────────────────────────────────

const VALID_EMOTIONS = new Set([
  "neutral",
  "happy",
  "sad",
  "angry",
  "fearful",
  "tender",
  "anxious",
  "excited",
  "surprised",
  "disgusted",
]);

const EMOTION_INSTRUCTION = `Before your response, output exactly one line in this format:
<emotion>LABEL</emotion>
Where LABEL is one of: neutral, happy, sad, angry, fearful, tender, anxious, excited, surprised, disgusted
Choose the emotion that best describes the current scene's emotional tone.
This tag will be automatically stripped before the user sees it — do not mention it in your response.`;

/**
 * Extract and strip the <emotion> tag from the start of a reply.
 * Returns { emotion, cleanText }.
 * @param {string} text
 * @returns {{ emotion: string, cleanText: string }}
 */
function extractEmotion(text) {
  if (!text) return { emotion: "neutral", cleanText: text };

  const match = text.match(/^<emotion>([a-z]+)<\/emotion>\s*/i);
  if (!match) return { emotion: "neutral", cleanText: text };

  const label = match[1].toLowerCase();
  const emotion = VALID_EMOTIONS.has(label) ? label : "neutral";
  const cleanText = text.slice(match[0].length);

  return { emotion, cleanText };
}

// ── Character name extraction ─────────────────────────────────────────────────

/**
 * Extract the user's name from messages.
 * JanitorAI formats user messages as "Name : message text"
 * @param {object[]} messages
 * @returns {string|null}
 */
function extractUserName(messages) {
  const userMsgs = messages.filter((m) => m.role === "user");
  for (const msg of userMsgs.slice(-3).reverse()) {
    const text =
      typeof msg.content === "string"
        ? msg.content
        : (msg.content?.[0]?.text ?? "");
    // Match "Name : " pattern at start of message
    const match = text.match(/^([A-Z][a-zA-Z]{1,20})\s*:/);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

/**
 * Extract character name from the AI's reply text.
 * Skips any name that matches the user's name.
 * @param {string} replyText
 * @param {string|null} userName  — blocklisted name
 * @returns {string}
 */

const PRONOUN_BLOCKLIST = new Set([
  "he",
  "she",
  "they",
  "it",
  "his",
  "her",
  "their",
  "its",
  "him",
  "them",
  "we",
  "us",
  "our",
  "my",
  "your",
  "i",
]);

function extractCharNameFromReply(replyText, userName) {
  if (!replyText) return "unknown";

  const lines = replyText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-—*#\[]+$/.test(l));

  for (const line of lines) {
    const clean = line
      .replace(/^\*+/, "")
      .replace(/\[.*?\]/g, "")
      .trim();

    const possessive = clean.match(/^([A-Z][a-z]{1,20})'s\b/);
    if (possessive) {
      const name = possessive[1].toLowerCase();
      if (name !== userName && !PRONOUN_BLOCKLIST.has(name)) return name;
    }

    const action = clean.match(
      /^([A-Z][a-z]{1,20})\s+(?:stepped|turned|said|looked|felt|moved|stood|walked|ran|smiled|frowned|crossed|glanced|stared|grabbed|reached|spoke|asked|replied|growled|snapped|sighed|laughed|narrowed|clenched|exhaled|inhaled|shrugged|nodded|shook)/,
    );
    if (action) {
      const name = action[1].toLowerCase();
      if (name !== userName && !PRONOUN_BLOCKLIST.has(name)) return name;
    }
  }

  return "unknown";
}

/**
 * Build query text from the last N user messages.
 * @param {object[]} messages
 * @param {number}   depth
 * @returns {string}
 */
function buildQueryText(messages, depth) {
  return messages
    .filter((m) => m.role === "user")
    .slice(-depth)
    .map((m) =>
      typeof m.content === "string" ? m.content : (m.content?.[0]?.text ?? ""),
    )
    .filter(Boolean)
    .join(" ")
    .slice(0, 1000);
}

// ── State ─────────────────────────────────────────────────────────────────────
const _stats = {
  lastInjectionChars: 0,
  lastInjectionChar: "none",
  lastInjectionMsg: 0,
  lastIndexedChar: "none",
  lastIndexedMsg: 0,
  lastEmotion: "none",
  totalInjections: 0,
  totalIndexed: 0,
};

// Carries data from transformRequest → transformResponse within the same turn.
let _pending = null;
// Track last user message to detect rerolls
let _lastUserText = null;

// ── Router ────────────────────────────────────────────────────────────────────
const router = express.Router();

router.get("/status", (req, res) => {
  const config = loadConfig();
  res.json({ ok: true, config, stats: _stats });
});

router.get("/collections", async (req, res) => {
  const config = loadConfig();
  try {
    const response = await fetch(`${config.qdrantUrl}/collections`);
    if (!response.ok)
      return res.json({ ok: false, error: "Qdrant unreachable" });
    const data = await response.json();
    const all = data.result?.collections ?? [];
    const rag = all.filter((c) => c.name.startsWith(config.collectionPrefix));
    const collections = await Promise.all(
      rag.map(async (c) => ({
        name: c.name,
        char: c.name.replace(config.collectionPrefix, ""),
        chunks: await getPointCount(c.name, config),
      })),
    );
    res.json({ ok: true, collections });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

router.delete("/collections/:name", async (req, res) => {
  const config = loadConfig();
  const name = req.params.name;
  if (!name.startsWith(config.collectionPrefix)) {
    return res
      .status(400)
      .json({ ok: false, error: "Invalid collection name" });
  }
  try {
    const response = await fetch(`${config.qdrantUrl}/collections/${name}`, {
      method: "DELETE",
    });
    if (!response.ok) return res.json({ ok: false, error: "Delete failed" });
    res.json({ ok: true, deleted: name });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// POST /extensions/rag/blind-next — mark next indexed turn as temporally blind
router.post("/blind-next", (req, res) => {
  try {
    const current = loadConfig();
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ ...current, blindNextTurn: true }, null, 2),
    );
    res.json({
      ok: true,
      message: "Next turn will be indexed as temporally blind",
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/config", (req, res) => {
  try {
    const current = loadConfig();
    const updated = { ...current, ...req.body };
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
    res.json({ ok: true, config: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Extension hooks ───────────────────────────────────────────────────────────

async function transformRequest(payload) {
  const config = loadConfig();
  if (!config.enabled) return payload;

  const messages = payload.messages ?? [];
  const msgCount = messages.length;
  const queryText = buildQueryText(messages, config.queryDepth);

  // Extract user name for blocklisting
  const userName = extractUserName(messages);

  // Grab last user message for indexing later
  const lastUserMsg = messages.findLast((m) => m.role === "user");
  const userText =
    typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : (lastUserMsg?.content?.[0]?.text ?? "");

  // Use char name + emotion from previous turn
  const knownCharName = _pending?.lastCharName ?? "unknown";
  const currentEmotion = _pending?.lastEmotion ?? "neutral";

  // Carry state forward to transformResponse
  _pending = {
    userText,
    msgCount,
    lastCharName: knownCharName,
    lastEmotion: currentEmotion,
    userName,
  };

  // Detect reroll — same user message as last time, skip indexing this turn
  const isReroll = userText && userText === _lastUserText;
  if (isReroll) {
    console.log("[rag] Reroll detected — skipping index this turn");
    _pending.isReroll = true;
  }
  _lastUserText = userText || _lastUserText;

  // Inject emotion instruction into system prompt
  let newMessages = messages;
  if (config.emotionEnabled) {
    newMessages = messages.map((m) => {
      if (m.role !== "system") return m;
      const existing = typeof m.content === "string" ? m.content : "";
      return { ...m, content: `${existing}\n\n${EMOTION_INSTRUCTION}` };
    });
  }

  // Skip retrieval on first message or no query
  if (!queryText || knownCharName === "unknown") {
    return { ...payload, messages: newMessages };
  }

  let context = null;
  try {
    context = await retrieve(
      {
        charName: knownCharName,
        queryText,
        currentIndex: msgCount,
        emotion: currentEmotion,
        emotionBoost: config.emotionBoost,
      },
      config,
    );
  } catch (e) {
    console.warn("[rag] Retrieval failed (non-fatal):", e.message);
    return { ...payload, messages: newMessages };
  }

  if (!context) return { ...payload, messages: newMessages };

  const injected = context.slice(0, config.maxInjectionChars);

  // Prepend context to system prompt
  newMessages = newMessages.map((m) => {
    if (m.role !== "system") return m;
    const existing = typeof m.content === "string" ? m.content : "";
    return { ...m, content: `${injected}\n\n${existing}` };
  });

  if (!newMessages.find((m) => m.role === "system")) {
    newMessages.unshift({ role: "system", content: injected });
  }

  console.log(
    `[rag] Injected ${injected.length} chars for "${knownCharName}" (emotion: ${currentEmotion})`,
  );
  _stats.lastInjectionChars = injected.length;
  _stats.lastInjectionChar = knownCharName;
  _stats.lastInjectionMsg = msgCount;
  _stats.totalInjections++;

  return { ...payload, messages: newMessages };
}

async function transformResponse(data) {
  const config = loadConfig();
  if (!config.enabled || !_pending) return data;

  const rawText = data?.choices?.[0]?.message?.content ?? "";
  if (!rawText) return data;

  // Extract and strip emotion tag
  const { emotion, cleanText } = extractEmotion(rawText);
  if (emotion !== "neutral" || rawText.startsWith("<emotion>")) {
    console.log(`[rag] Emotion detected: ${emotion}`);
    _stats.lastEmotion = emotion;
  }

  // Write clean text back into response
  let finalData = data;
  if (cleanText !== rawText) {
    finalData = {
      ...data,
      choices: data.choices.map((c, i) =>
        i === 0 ? { ...c, message: { ...c.message, content: cleanText } } : c,
      ),
    };
  }

  // Extract char name from clean reply (emotion tag already stripped)
  const charName = extractCharNameFromReply(cleanText, _pending.userName);
  if (charName !== "unknown") _pending.lastCharName = charName;
  const effectiveCharName = _pending.lastCharName ?? charName;
  _pending.lastEmotion = emotion;

  // Skip indexing on rerolls — don't store duplicate responses
  if (_pending.isReroll) {
    if (charName !== "unknown") _pending.lastCharName = charName;
    _pending.lastEmotion = emotion;
    return finalData;
  }

  // Index the turn with emotion
  try {
    await indexTurn(
      {
        charName: effectiveCharName,
        userText: _pending.userText ?? "",
        assistantText: cleanText,
        messageIndex: _pending.msgCount,
        emotion,
        temporallyBlind: config.blindNextTurn === true,
      },
      config,
    );
    // Auto-reset blindNextTurn after use
    if (config.blindNextTurn) {
      const current = loadConfig();
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ ...current, blindNextTurn: false }, null, 2),
      );
      console.log("[rag] Temporally blind turn indexed — flag reset");
    }
    console.log(
      `[rag] Indexed turn for "${effectiveCharName}" (msg ${_pending.msgCount}, emotion: ${emotion})`,
    );
    _stats.lastIndexedChar = charName;
    _stats.lastIndexedMsg = _pending.msgCount;
    _stats.totalIndexed++;
  } catch (e) {
    console.warn("[rag] Index failed (non-fatal):", e.message);
  }

  return finalData;
}

module.exports = {
  name: "Retrieval-Augmented Generation (RAG)",
  version: "1.1.0",
  priority: 25,
  router,
  transformRequest,
  transformResponse,
};
