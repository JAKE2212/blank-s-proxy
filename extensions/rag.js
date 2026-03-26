"use strict";

/**
 * rag.js — Advanced RAG extension (priority 25)
 * Semantic memory retrieval using Qdrant + Ollama.
 *
 * v1.2.0 — Multi-character support
 * Now extracts ALL named characters from each reply and indexes/retrieves
 * context separately per character. Each character gets their own Qdrant
 * collection and their own memory context block injected into the system prompt.
 *
 * transformRequest  → inject emotion instruction → retrieve context for each known char → inject into system prompt
 * transformResponse → extract emotion tag → strip it → extract all char names → index turn per character
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
  rules: [],
  blindNextTurn: false,
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
    console.warn("[rag] Failed to load config, using defaults:", e.message);
  }
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.log("[rag] Created default config at data/rag-config.json");
  } catch {}
  _configCache = { ...DEFAULT_CONFIG };
  return _configCache;
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
    const match = text.match(/^([A-Z][a-zA-Z]{1,20})\s*:/);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

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
  // Common non-name words that start sentences
  "the",
  "a",
  "an",
  "this",
  "that",
  "these",
  "those",
  "one",
  "two",
  "three",
  "then",
  "when",
  "where",
  "what",
]);

/**
 * Extract ALL unique character names from a reply.
 * Scans every line for possessive patterns and action verbs.
 * Returns a deduplicated array of lowercase names, excluding the user's name
 * and common pronouns/words.
 *
 * @param {string}      replyText
 * @param {string|null} userName   — blocklisted name (the user's character)
 * @returns {string[]}             — e.g. ['kurt', 'dale']
 */
function extractAllCharNamesFromReply(replyText, userName) {
  if (!replyText) return [];

  const found = new Set();

  const lines = replyText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-—*#\[]+$/.test(l));

  for (const line of lines) {
    const clean = line
      .replace(/^\*+/, "")
      .replace(/\[.*?\]/g, "")
      .trim();

    // Pattern 1 — possessive: "Kurt's jaw tightened"
    const possessiveMatches = clean.matchAll(/\b([A-Z][a-z]{1,20})'s\b/g);
    for (const m of possessiveMatches) {
      const name = m[1].toLowerCase();
      if (name !== userName && !PRONOUN_BLOCKLIST.has(name)) {
        found.add(name);
      }
    }

    // Pattern 2 — action verb: "Kurt stepped forward"
    const actionMatches = clean.matchAll(
      /\b([A-Z][a-z]{1,20})\s+(?:stepped|turned|said|looked|felt|moved|stood|walked|ran|smiled|frowned|crossed|glanced|stared|grabbed|reached|spoke|asked|replied|growled|snapped|sighed|laughed|narrowed|clenched|exhaled|inhaled|shrugged|nodded|shook|leaned|pulled|pushed|dropped|raised|lowered|tilted|pressed|placed|held|kept|let|made|gave|took|came|went|sat|lay|rose|fell|spun|jerked|flinched|tensed|relaxed|watched|waited|paused|stopped|started|opened|closed|turned|moved|shifted|stepped|backed|leaned|reached|stretched|twisted|arched|curled|spread|folded|crossed)\b/g,
    );
    for (const m of actionMatches) {
      const name = m[1].toLowerCase();
      if (name !== userName && !PRONOUN_BLOCKLIST.has(name)) {
        found.add(name);
      }
    }

    // Pattern 3 — dialogue attribution: `"text," Kurt said` or `"text." Kurt`
    const dialogueMatches = clean.matchAll(
      /["'][^"']+["']\s*[,.]?\s*([A-Z][a-z]{1,20})\b/g,
    );
    for (const m of dialogueMatches) {
      const name = m[1].toLowerCase();
      if (name !== userName && !PRONOUN_BLOCKLIST.has(name)) {
        found.add(name);
      }
    }
  }

  return [...found];
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
  lastActiveChars: [],
  lastInjectionMsg: 0,
  lastIndexedChars: [],
  lastIndexedMsg: 0,
  lastEmotion: "none",
  totalInjections: 0,
  totalIndexed: 0,
};

// Per-request state (transformRequest → transformResponse)
const _pendingMap = new Map();
const PENDING_TTL_MS = 5 * 60 * 1000;

function cleanupPending() {
  const now = Date.now();
  for (const [key, val] of _pendingMap) {
    if (now - val.timestamp > PENDING_TTL_MS) _pendingMap.delete(key);
  }
}

// Cross-turn state (accumulated char names, emotion, reroll detection)
let _turnState = {
  lastCharNames: [],
  lastEmotion: "neutral",
  lastUserText: null,
};

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

router.post("/blind-next", (req, res) => {
  try {
    const current = loadConfig();
    fs.writeFileSync(
      CONFIG_PATH,
      JSON.stringify({ ...current, blindNextTurn: true }, null, 2),
    );
    _configCache = null;
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
    _configCache = null;
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

  // Grab last user message text for indexing later
  const lastUserMsg = messages.findLast((m) => m.role === "user");
  const userText =
    typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : (lastUserMsg?.content?.[0]?.text ?? "");

  // Carry known char names + emotion from previous turn
  const knownCharNames = _turnState.lastCharNames;
  const currentEmotion = _turnState.lastEmotion;

  // Detect reroll — same user message as last time
  const isReroll = userText && userText === _turnState.lastUserText;
  if (isReroll) {
    console.log("[rag] Reroll detected — skipping index this turn");
  }
  _turnState.lastUserText = userText || _turnState.lastUserText;

    // Stash per-request state for transformResponse
  const reqId = payload._ragReqId ?? (payload._ragReqId = Math.random().toString(36).slice(2, 8));
  cleanupPending();
  _pendingMap.set(reqId, {
    userText,
    msgCount,
    userName,
    isReroll,
    timestamp: Date.now(),
  });

  // Inject emotion instruction into system prompt
  let newMessages = messages;
  if (config.emotionEnabled) {
    newMessages = messages.map((m) => {
      if (m.role !== "system") return m;
      const existing = typeof m.content === "string" ? m.content : "";
      return { ...m, content: `${existing}\n\n${EMOTION_INSTRUCTION}` };
    });
  }

  // Skip retrieval if no query or no known characters yet
  if (!queryText || knownCharNames.length === 0) {
    if (knownCharNames.length === 0) {
      console.log(
        "[rag] No known characters yet — skipping retrieval this turn",
      );
    }
    return { ...payload, messages: newMessages };
  }

  // Retrieve context for each known character independently
  const contextBlocks = [];
  for (const charName of knownCharNames) {
    let context = null;
    try {
      context = await retrieve(
        {
          charName,
          queryText,
          currentIndex: msgCount,
          emotion: currentEmotion,
          emotionBoost: config.emotionBoost,
        },
        config,
      );
    } catch (e) {
      console.warn(
        `[rag] Retrieval failed for "${charName}" (non-fatal):`,
        e.message,
      );
      continue;
    }

    if (context) {
      const trimmed = context.slice(0, config.maxInjectionChars);
      contextBlocks.push({ charName, context: trimmed });
      console.log(
        `[rag] Retrieved ${trimmed.length} chars for "${charName}" (emotion: ${currentEmotion})`,
      );
    }
  }

  if (contextBlocks.length === 0) {
    return { ...payload, messages: newMessages };
  }

  // Build combined injection — one labeled block per character
  const combined = contextBlocks
    .map(
      ({ charName, context }) =>
        `[Relevant Memory Context — ${charName}]\n${context}\n[End Memory Context — ${charName}]`,
    )
    .join("\n\n");

  // Prepend combined context to system prompt
  newMessages = newMessages.map((m) => {
    if (m.role !== "system") return m;
    const existing = typeof m.content === "string" ? m.content : "";
    return { ...m, content: `${combined}\n\n${existing}` };
  });

  if (!newMessages.find((m) => m.role === "system")) {
    newMessages.unshift({ role: "system", content: combined });
  }

  const totalChars = contextBlocks.reduce(
    (sum, b) => sum + b.context.length,
    0,
  );
  const charList = contextBlocks.map((b) => b.charName).join(", ");
  console.log(`[rag] Injected ${totalChars} total chars for: ${charList}`);

  _stats.lastInjectionChars = totalChars;
  _stats.lastActiveChars = contextBlocks.map((b) => b.charName);
  _stats.lastInjectionMsg = msgCount;
  _stats.totalInjections++;

  return { ...payload, messages: newMessages };
}

async function transformResponse(data) {
  const config = loadConfig();
  if (!config.enabled) return data;

  // Find pending state — grab the most recent entry
  const pendingEntry = _pendingMap.size > 0
    ? [..._pendingMap.entries()].pop()
    : null;
  if (!pendingEntry) return data;
  const [pendingKey, pending] = pendingEntry;
  _pendingMap.delete(pendingKey);

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

  // Extract ALL character names from the clean reply
  const foundNames = extractAllCharNamesFromReply(cleanText, pending.userName);

  // Merge newly found names with known names from previous turns
  // Use a Set to deduplicate — characters accumulate over the session
  const mergedNames = [
    ...new Set([..._turnState.lastCharNames, ...foundNames]),
  ];

  if (foundNames.length > 0) {
    console.log(`[rag] Characters found in reply: ${foundNames.join(", ")}`);
  }

  // Always carry forward the latest merged list + emotion for next request
  _turnState.lastCharNames = mergedNames;
  _turnState.lastEmotion = emotion;

  // Skip indexing on rerolls
  if (pending.isReroll) {
    return finalData;
  }

  // Index the turn once per character found in THIS reply
  // (Only index chars active in this specific message, not all historical chars)
  if (foundNames.length === 0) {
    console.log("[rag] No character names found in reply — skipping index");
    return finalData;
  }

  const isBlind = config.blindNextTurn === true;
  const indexedNames = [];

  for (const charName of foundNames) {
    try {
      await indexTurn(
        {
          charName,
          userText: pending.userText ?? "",
          assistantText: cleanText,
          messageIndex: pending.msgCount,
          emotion,
          temporallyBlind: isBlind,
        },
        config,
      );
      indexedNames.push(charName);
    } catch (e) {
      console.warn(
        `[rag] Index failed for "${charName}" (non-fatal):`,
        e.message,
      );
    }
  }

  // Auto-reset blindNextTurn after use
  if (isBlind && indexedNames.length > 0) {
    try {
      const current = loadConfig();
      fs.writeFileSync(
        CONFIG_PATH,
        JSON.stringify({ ...current, blindNextTurn: false }, null, 2),
      );
      _configCache = null;
      console.log("[rag] Temporally blind turn indexed — flag reset");
    } catch {}
  }

  if (indexedNames.length > 0) {
    console.log(
      `[rag] Indexed turn for: ${indexedNames.join(", ")} (msg ${pending.msgCount}, emotion: ${emotion})`,
    );
    _stats.lastIndexedChars = indexedNames;
    _stats.lastIndexedMsg = pending.msgCount;
    _stats.totalIndexed += indexedNames.length;
  }

  return finalData;
}

module.exports = {
  name: "Retrieval-Augmented Generation (RAG)",
  version: "1.2.0",
  priority: 25,
  router,
  transformRequest,
  transformResponse,
};
