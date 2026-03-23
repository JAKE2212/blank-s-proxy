"use strict";

/**
 * rag-retriever.js
 * The RAG scoring pipeline.
 * Handles: query embedding → Qdrant search → temporal decay → filter → format.
 * Single responsibility: given a query + config, return formatted context string.
 */

const { embedText } = require("./rag-embedder");
const {
  ensureCollection,
  upsertPoint,
  queryPoints,
  makePointId,
} = require("./rag-store");

// ── Temporal decay ────────────────────────────────────────────────────────────

/**
 * Apply temporal decay to a raw similarity score.
 * Exponential: score × max(floor, 0.5^(age / halfLife))
 * Linear:      score × max(floor, 1 - (age / halfLife))
 * @param {number} rawScore
 * @param {number} messageAge
 * @param {object} config  must have decayHalfLife, decayFloor, decayMode
 * @returns {number}
 */
function applyDecay(rawScore, messageAge, config) {
  const {
    decayHalfLife = 50,
    decayFloor = 0.3,
    decayMode = "exponential",
  } = config;
  let decayFactor;
  if (decayMode === "linear") {
    decayFactor = Math.max(decayFloor, 1 - messageAge / decayHalfLife);
  } else {
    decayFactor = Math.max(
      decayFloor,
      Math.pow(0.5, messageAge / decayHalfLife),
    );
  }
  return rawScore * decayFactor;
}

// ── Chunk indexing (store side) ───────────────────────────────────────────────

/**
 * Index a single message turn into Qdrant.
 * Called from transformResponse after each AI reply.
 *
 * @param {object} params
 * @param {string} params.charName      character name (used for collection namespacing)
 * @param {string} params.userText      the user's message
 * @param {string} params.assistantText the AI's reply
 * @param {number} params.messageIndex  position in conversation (used for decay)
 * @param {object} config               full rag config
 */
async function indexTurn(params, config) {
  const { charName, userText, assistantText, messageIndex } = params;
  const collection = `${config.collectionPrefix}${sanitizeCollectionName(charName)}`;

  await ensureCollection(collection, config);

  const chunks = [
    { role: "user", text: userText },
    { role: "assistant", text: assistantText },
  ].filter((c) => c.text && c.text.trim().length > 0);

  // mxbai-embed-large has a 512 token context window (~1800 chars safe limit)
  const MAX_EMBED_CHARS = 1800;

  for (const chunk of chunks) {
    try {
      const vector = await embedText(
        chunk.text.slice(0, MAX_EMBED_CHARS),
        config,
      );
      const id = makePointId(charName, messageIndex, chunk.role);
      await upsertPoint(
        collection,
        {
          id,
          vector,
          payload: {
            text: chunk.text.slice(0, 2000), // cap stored text
            role: chunk.role,
            charName,
            messageIndex,
            timestamp: Date.now(),
          },
        },
        config,
      );
    } catch (e) {
      // Non-fatal — log and continue
      console.warn(
        `[rag-retriever] Failed to index ${chunk.role} chunk: ${e.message}`,
      );
    }
  }
}

// ── Keyword boosting ─────────────────────────────────────────────────────────

/**
 * Extract meaningful keywords from a query string.
 * Strips stopwords and short tokens, returns lowercase array.
 * @param {string} text
 * @returns {string[]}
 */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "is",
  "it",
  "its",
  "was",
  "are",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "i",
  "you",
  "he",
  "she",
  "we",
  "they",
  "me",
  "him",
  "her",
  "us",
  "them",
  "my",
  "your",
  "his",
  "our",
  "their",
  "this",
  "that",
  "these",
  "those",
  "what",
  "how",
  "why",
  "when",
  "where",
  "who",
  "which",
  "not",
  "no",
  "so",
  "if",
]);

function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

/**
 * Apply keyword boost to a decayed score.
 * For each query keyword found in the chunk text, add a small boost.
 * Boost is capped so it can nudge but not dominate the vector score.
 * @param {number} score       already-decayed score
 * @param {string} chunkText   stored chunk text
 * @param {string[]} keywords  extracted from query
 * @returns {number}
 */
function applyKeywordBoost(score, chunkText, keywords) {
  if (!keywords.length) return score;
  const lower = chunkText.toLowerCase();
  const matches = keywords.filter((kw) => lower.includes(kw)).length;
  if (!matches) return score;
  // Each keyword match adds 0.05, capped at 0.20 total boost
  const boost = Math.min(matches * 0.05, 0.2);
  return score + boost;
}

// ── Conditional rules ─────────────────────────────────────────────────────────

/**
 * Evaluate a single condition against a chunk and current context.
 * @param {object} condition  { type, value, negate }
 * @param {object} hit        Qdrant hit with payload
 * @param {object} context    { emotion, keywords, currentIndex }
 * @returns {boolean}
 */
function evalCondition(condition, hit, context) {
  const { type, value, negate = false } = condition;
  let result = false;

  switch (type) {
    case "emotion":
      // "current" is a special value meaning "match whatever the current scene emotion is"
      result =
        value === "current"
          ? hit.payload?.emotion === context.emotion
          : hit.payload?.emotion === value;
      break;
    case "keyword":
      result = (hit.payload?.text ?? "")
        .toLowerCase()
        .includes(value.toLowerCase());
      break;
    case "recency": {
      const age = context.currentIndex - (hit.payload?.messageIndex ?? 0);
      result = age <= Number(value);
      break;
    }
    default:
      result = false;
  }

  return negate ? !result : result;
}

/**
 * Evaluate a rule (array of conditions) against a chunk.
 * operator 'AND' — all conditions must pass
 * operator 'OR'  — at least one condition must pass
 * @param {object} rule   { operator: 'AND'|'OR', conditions: [] }
 * @param {object} hit
 * @param {object} context
 * @returns {boolean}
 */
function evalRule(rule, hit, context) {
  const { operator = "AND", conditions = [] } = rule;
  if (!conditions.length) return true;
  if (operator === "OR") {
    return conditions.some((c) => evalCondition(c, hit, context));
  }
  return conditions.every((c) => evalCondition(c, hit, context));
}

/**
 * Check if a chunk passes all active rules.
 * Rules are AND-ed together at the top level.
 * An empty rules array means no filtering — all chunks pass.
 * @param {object[]} rules
 * @param {object}   hit
 * @param {object}   context
 * @returns {boolean}
 */
function passesRules(rules, hit, context) {
  if (!rules || !rules.length) return true;
  return rules.every((rule) => evalRule(rule, hit, context));
}

// ── Retrieval (query side) ────────────────────────────────────────────────────

/**
 * Retrieve relevant context for the current conversation turn.
 * Returns a formatted string ready to inject into the system prompt,
 * or null if nothing relevant was found.
 *
 * @param {object} params
 * @param {string} params.charName       character name
 * @param {string} params.queryText      text to search for (recent user messages joined)
 * @param {number} params.currentIndex   current message count (for decay calculation)
 * @param {object} config                full rag config
 * @returns {Promise<string|null>}
 */
async function retrieve(params, config) {
  const {
    charName,
    queryText,
    currentIndex,
    emotion = "neutral",
    emotionBoost = 0.1,
  } = params;
  const rules = config.rules ?? [];
  const collection = `${config.collectionPrefix}${sanitizeCollectionName(charName)}`;

  // Embed the query
  let queryVector;
  try {
    queryVector = await embedText(queryText, config);
  } catch (e) {
    console.warn(`[rag-retriever] Failed to embed query: ${e.message}`);
    return null;
  }

  // Search Qdrant
  let hits;
  try {
    hits = await queryPoints(collection, queryVector, config.topK * 2, config);
  } catch (e) {
    // Collection may not exist yet (first message) — not an error
    if (e.message.includes("404") || e.message.includes("Not found"))
      return null;
    console.warn(`[rag-retriever] Query failed: ${e.message}`);
    return null;
  }

  if (!hits.length) return null;

  // Extract keywords from query for boosting
  const keywords = extractKeywords(queryText);

  // Apply temporal decay, keyword boost, emotion boost, and score threshold
  const scored = hits
    .map((hit) => {
      const age = currentIndex - (hit.payload?.messageIndex ?? 0);
      const isBlind = hit.payload?.temporallyBlind === true;
      const decayedScore =
        config.decayEnabled && !isBlind
          ? applyDecay(hit.score, age, config)
          : hit.score;
      const keywordScore = applyKeywordBoost(
        decayedScore,
        hit.payload?.text ?? "",
        keywords,
      );
      const chunkEmotion = hit.payload?.emotion ?? "neutral";
      const emotionScore =
        emotion !== "neutral" && chunkEmotion === emotion
          ? keywordScore + emotionBoost
          : keywordScore;
      return { ...hit, finalScore: emotionScore };
    })
    .filter((hit) => hit.finalScore >= config.scoreThreshold)
    .filter((hit) =>
      passesRules(rules, hit, { emotion, keywords, currentIndex }),
    )
    .sort((a, b) => b.finalScore - a.finalScore)
    .slice(0, config.topK);

  if (!scored.length) return null;

  const unique = [];
  for (const hit of scored) {
    const text = hit.payload?.text ?? "";
    const isDupe = unique.some(
      (u) => similarity(u.payload?.text ?? "", text) > 0.85,
    );
    if (!isDupe) unique.push(hit);
  }

  if (!unique.length) return null;

  // Format into injection block
  return formatContext(unique);
}

// ── Formatting ────────────────────────────────────────────────────────────────

/**
 * Format retrieved chunks into a clean context block for injection.
 * @param {Array} hits  scored + filtered Qdrant hits
 * @returns {string}
 */
function formatContext(hits) {
  const lines = ["[Relevant Memory Context]"];
  for (const hit of hits) {
    const role = hit.payload?.role === "user" ? "User" : "Character";
    const text = (hit.payload?.text ?? "").trim();
    lines.push(`${role}: ${text}`);
  }
  lines.push("[End Memory Context]");
  return lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Sanitize a character name for use as a Qdrant collection name segment.
 * Qdrant collection names must match [a-zA-Z0-9_-].
 * @param {string} name
 * @returns {string}
 */
function sanitizeCollectionName(name) {
  return (name ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 40);
}

/**
 * Simple character-level similarity check for deduplication.
 * Returns 0–1. Fast and good enough for near-duplicate detection.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function similarity(a, b) {
  if (!a || !b) return 0;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.length === 0) return 1;
  // Count matching chars at same positions (fast approximation)
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) matches++;
  }
  return matches / longer.length;
}

module.exports = { indexTurn, retrieve, sanitizeCollectionName };
