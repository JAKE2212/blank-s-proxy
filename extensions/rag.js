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
const { retrieve, retrieveLinked, indexTurn } = require("../lib/rag-retriever");
const { getPointCount } = require("../lib/rag-store");
const { extractCharNames, extractUserName } = require("../lib/character-detector");

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
  const match = text.match(/^\s*<emotion>([a-z]+)<\/emotion>\s*/i);
  if (!match) return { emotion: "neutral", cleanText: text };
  const label = match[1].toLowerCase();
  const emotion = VALID_EMOTIONS.has(label) ? label : "neutral";
  const cleanText = text.slice(0, match.index) + text.slice(match.index + match[0].length);
  return { emotion, cleanText };
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
const MAX_KNOWN_CHARS = 15; // cap to prevent memory bloat
let _turnState = {
  lastCharNames: [],       // all chars ever seen (for knowing which collections exist)
  activeSceneChars: [],    // chars from the LAST reply only (for retrieval)
  lastEmotion: "neutral",
  lastUserText: null,
};
let _turnStateLastActivity = Date.now();
const TURN_STATE_TTL_MS = 30 * 60 * 1000; // 30 minutes

function checkTurnStateReset() {
  if (Date.now() - _turnStateLastActivity > TURN_STATE_TTL_MS) {
    _turnState = { lastCharNames: [], activeSceneChars: [], lastEmotion: "neutral", lastUserText: null };
    console.log("[rag] Turn state reset — 30min idle timeout");
  }
  _turnStateLastActivity = Date.now();
}

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

  checkTurnStateReset();

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

  // Use ACTIVE scene chars for retrieval (only chars from the last reply)
  // Fall back to all known chars on first turn (when activeSceneChars is empty)
  const activeChars = _turnState.activeSceneChars;
  const knownCharNames = activeChars.length > 0 ? activeChars : _turnState.lastCharNames;
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

  // Also check for character names in the current user message
  // This catches cases where the user mentions a character not in the last reply
  const userMentionedChars = extractCharNames(userText, userName);
  const allKnownNames = _turnState.lastCharNames;
  const validUserMentions = userMentionedChars.filter(c => allKnownNames.includes(c));
  if (validUserMentions.length > 0) {
    const merged = [...new Set([...knownCharNames, ...validUserMentions])];
    knownCharNames.splice(0, knownCharNames.length, ...merged);
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

  // Retrieve context for known characters (cap at 5 to limit API calls)
  const MAX_RETRIEVE = 5;
  const contextBlocks = [];
  const linkedChars = new Set();
  const charsToRetrieve = knownCharNames.slice(0, MAX_RETRIEVE);

  for (const charName of charsToRetrieve) {
    linkedChars.add(charName);
    let result = null;
    try {
      result = await retrieve(
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

    if (result.context) {
      const trimmed = result.context.slice(0, config.maxInjectionChars);
      contextBlocks.push({ charName, context: trimmed });
      console.log(
        `[rag] Retrieved ${trimmed.length} chars for "${charName}" (emotion: ${currentEmotion})`,
      );

      // Track co-characters for cross-linking
      for (const co of result.coCharacters) {
        if (!linkedChars.has(co) && knownCharNames.includes(co)) {
          linkedChars.add(co);
        }
      }
    }
  }

  // Cross-character linking — retrieve context for co-occurring characters
  // Only fires when a retrieved chunk mentions another known character
  const MAX_LINKED = 4;
  const alreadyRetrieved = new Set(contextBlocks.map(b => b.charName));
  const charsToLink = [...linkedChars].filter(c => !alreadyRetrieved.has(c)).slice(0, MAX_LINKED);

  if (charsToLink.length > 0) {
    console.log(`[rag] Cross-character linking: ${charsToLink.join(", ")}`);
    for (const charName of charsToLink) {
      try {
        const linkedContext = await retrieveLinked(
          {
            charName,
            queryText,
            currentIndex: msgCount,
            emotion: currentEmotion,
            emotionBoost: config.emotionBoost,
            linkedTopK: 2,
          },
          config,
        );
        if (linkedContext) {
          const trimmed = linkedContext.slice(0, config.maxInjectionChars);
          contextBlocks.push({ charName, context: trimmed, linked: true });
          console.log(
            `[rag] Linked ${trimmed.length} chars for "${charName}" (co-character)`,
          );
        }
      } catch (e) {
        console.warn(
          `[rag] Linked retrieval failed for "${charName}" (non-fatal):`,
          e.message,
        );
      }
    }
  }

  if (contextBlocks.length === 0) {
    return { ...payload, messages: newMessages };
  }

  // Build combined injection — one labeled block per character
  // Enforce shared maxInjectionChars budget across all blocks
  const maxTotal = config.maxInjectionChars ?? 2000;
  let charBudget = maxTotal;
  const budgetedBlocks = [];

  for (const block of contextBlocks) {
    if (charBudget <= 0) break;
    const trimmed = block.context.slice(0, charBudget);
    budgetedBlocks.push({ ...block, context: trimmed });
    charBudget -= trimmed.length;
  }

  const combined = budgetedBlocks
    .map(
      ({ charName, context, linked }) =>
        `[Relevant Memory Context — ${charName}${linked ? " (linked)" : ""}]\n${context}\n[End Memory Context — ${charName}]`,
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

  const totalChars = budgetedBlocks.reduce(
    (sum, b) => sum + b.context.length,
    0,
  );
  const charList = budgetedBlocks.map((b) => `${b.charName}${b.linked ? " (linked)" : ""}`).join(", ");
  console.log(`[rag] Injected ${totalChars} total chars for: ${charList}`);

  _stats.lastInjectionChars = totalChars;
  _stats.lastActiveChars = budgetedBlocks.map((b) => b.charName);
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
  // Safety: clear any stale entries that might have accumulated
  if (_pendingMap.size > 10) {
    console.warn(`[rag] Clearing ${_pendingMap.size} stale pending entries`);
    _pendingMap.clear();
  }

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
  const foundNames = extractCharNames(cleanText, pending.userName);

  // Merge newly found names with known names from previous turns
  // Cap to prevent unbounded growth — keep most recent names
  const mergedNames = [
    ...new Set([..._turnState.lastCharNames, ...foundNames]),
  ].slice(-MAX_KNOWN_CHARS);

  if (foundNames.length > 0) {
    console.log(`[rag] Characters found in reply: ${foundNames.join(", ")}`);
  }

  // Always carry forward the latest merged list + emotion for next request
  _turnState.lastCharNames = mergedNames;
  _turnState.lastEmotion = emotion;
  // Track ONLY this reply's characters as the active scene for next retrieval
  _turnState.activeSceneChars = foundNames;

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

  // Build co-characters list — other characters in this same reply
  for (const charName of foundNames) {
    const coCharacters = foundNames.filter(n => n !== charName);
    try {
      await indexTurn(
        {
          charName,
          userText: pending.userText ?? "",
          assistantText: cleanText,
          messageIndex: pending.msgCount,
          emotion,
          temporallyBlind: isBlind,
          coCharacters,
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
