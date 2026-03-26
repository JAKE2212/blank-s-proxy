"use strict";

/**
 * rag-retriever.js
 * The RAG scoring pipeline.
 * Handles: query embedding → Qdrant search → temporal decay → filter → format.
 * Single responsibility: given a query + config, return formatted context string.
 *
 * v1.3 — Cross-character linking
 *   - indexTurn accepts coCharacters array
 *   - retrieve returns coCharacters found in top chunks
 *   - retrieveLinked pulls context for co-occurring characters
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
 * @param {string}   params.charName      character name (used for collection namespacing)
 * @param {string}   params.userText      the user's message
 * @param {string}   params.assistantText the AI's reply
 * @param {number}   params.messageIndex  position in conversation (used for decay)
 * @param {string}   params.emotion       detected emotion label
 * @param {boolean}  params.temporallyBlind  if true, skip decay for this chunk
 * @param {string[]} params.coCharacters  other characters active in this same turn
 * @param {object} config               full rag config
 */
async function indexTurn(params, config) {
  const { charName, userText, assistantText, messageIndex, emotion, temporallyBlind, coCharacters = [] } = params;
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
            text: chunk.text.slice(0, 2000),
            role: chunk.role,
            charName,
            messageIndex,
            emotion: emotion ?? "neutral",
            temporallyBlind: temporallyBlind ?? false,
            coCharacters,
            timestamp: Date.now(),
          },
        },
        config,
      );
    } catch (e) {
      console.warn(
        `[rag-retriever] Failed to index ${chunk.role} chunk: ${e.message}`,
      );
    }
  }
}

// ── Keyword boosting ─────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a","an","the","and","or","but","in","on","at","to","for","of","with",
  "is","it","its","was","are","be","been","being","have","has","had",
  "do","does","did","will","would","could","should","may","might","shall",
  "i","you","he","she","we","they","me","him","her","us","them",
  "my","your","his","our","their","this","that","these","those",
  "what","how","why","when","where","who","which","not","no","so","if",
]);

function extractKeywords(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
}

function applyKeywordBoost(score, chunkText, keywords) {
  if (!keywords.length) return score;
  const lower = chunkText.toLowerCase();
  const matches = keywords.filter((kw) => lower.includes(kw)).length;
  if (!matches) return score;
  const boost = Math.min(matches * 0.05, 0.2);
  return score + boost;
}

// ── Conditional rules ─────────────────────────────────────────────────────────

function evalCondition(condition, hit, context) {
  const { type, value, negate = false } = condition;
  let result = false;
  switch (type) {
    case "emotion":
      result = value === "current"
        ? hit.payload?.emotion === context.emotion
        : hit.payload?.emotion === value;
      break;
    case "keyword":
      result = (hit.payload?.text ?? "").toLowerCase().includes(value.toLowerCase());
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

function evalRule(rule, hit, context) {
  const { operator = "AND", conditions = [] } = rule;
  if (!conditions.length) return true;
  if (operator === "OR") return conditions.some((c) => evalCondition(c, hit, context));
  return conditions.every((c) => evalCondition(c, hit, context));
}

function passesRules(rules, hit, context) {
  if (!rules || !rules.length) return true;
  return rules.every((rule) => evalRule(rule, hit, context));
}

// ── Core scoring pipeline ─────────────────────────────────────────────────────

/**
 * Score and filter raw Qdrant hits through the full pipeline.
 * Shared by both retrieve() and retrieveLinked().
 * @param {Array}  hits         raw Qdrant hits
 * @param {object} params       { currentIndex, emotion, emotionBoost }
 * @param {object} config       full rag config
 * @param {string} queryText    for keyword extraction
 * @returns {Array}             scored, filtered, deduped hits
 */
function scoreAndFilter(hits, params, config, queryText) {
  const { currentIndex, emotion = "neutral", emotionBoost = 0.1 } = params;
  const rules = config.rules ?? [];
  const keywords = extractKeywords(queryText);

  const scored = hits
    .map((hit) => {
      const age = currentIndex - (hit.payload?.messageIndex ?? 0);
      const isBlind = hit.payload?.temporallyBlind === true;
      const decayedScore = config.decayEnabled && !isBlind
        ? applyDecay(hit.score, age, config)
        : hit.score;
      const keywordScore = applyKeywordBoost(decayedScore, hit.payload?.text ?? "", keywords);
      const chunkEmotion = hit.payload?.emotion ?? "neutral";
      const emotionScore = emotion !== "neutral" && chunkEmotion === emotion
        ? keywordScore + emotionBoost
        : keywordScore;
      return { ...hit, finalScore: emotionScore };
    })
    .filter((hit) => hit.finalScore >= config.scoreThreshold)
    .filter((hit) => passesRules(rules, hit, { emotion, keywords, currentIndex }))
    .sort((a, b) => b.finalScore - a.finalScore);

  // Deduplicate
  const unique = [];
  for (const hit of scored) {
    const text = hit.payload?.text ?? "";
    const isDupe = unique.some((u) => similarity(u.payload?.text ?? "", text) > 0.85);
    if (!isDupe) unique.push(hit);
  }

  return unique;
}

// ── Retrieval (query side) ────────────────────────────────────────────────────

/**
 * Retrieve relevant context for a single character.
 * Returns { context, coCharacters } where coCharacters is a deduplicated
 * list of other characters found in the top chunks' coCharacters arrays.
 *
 * @param {object} params
 * @param {string} params.charName
 * @param {string} params.queryText
 * @param {number} params.currentIndex
 * @param {string} params.emotion
 * @param {number} params.emotionBoost
 * @param {object} config
 * @returns {Promise<{ context: string|null, coCharacters: string[] }>}
 */
async function retrieve(params, config) {
  const { charName, queryText, currentIndex, emotion = "neutral", emotionBoost = 0.1 } = params;
  const collection = `${config.collectionPrefix}${sanitizeCollectionName(charName)}`;

  let queryVector;
  try {
    queryVector = await embedText(queryText, config);
  } catch (e) {
    console.warn(`[rag-retriever] Failed to embed query: ${e.message}`);
    return { context: null, coCharacters: [] };
  }

  let hits;
  try {
    hits = await queryPoints(collection, queryVector, config.topK * 2, config);
  } catch (e) {
    if (e.message.includes("404") || e.message.includes("Not found"))
      return { context: null, coCharacters: [] };
    console.warn(`[rag-retriever] Query failed: ${e.message}`);
    return { context: null, coCharacters: [] };
  }

  if (!hits.length) return { context: null, coCharacters: [] };

  const unique = scoreAndFilter(hits, { currentIndex, emotion, emotionBoost }, config, queryText);
  const topHits = unique.slice(0, config.topK);

  if (!topHits.length) return { context: null, coCharacters: [] };

  // Collect co-characters from top hits
  const coChars = new Set();
  for (const hit of topHits) {
    const co = hit.payload?.coCharacters ?? [];
    for (const name of co) {
      if (name !== charName) coChars.add(name);
    }
  }

  return {
    context: formatContext(topHits),
    coCharacters: [...coChars],
  };
}

/**
 * Retrieve linked context for co-occurring characters.
 * Called after the primary retrieval when cross-character interactions are detected.
 * Uses a reduced topK to stay within the shared injection budget.
 *
 * @param {object} params
 * @param {string}   params.charName       the linked character to retrieve for
 * @param {string}   params.queryText      same query as primary retrieval
 * @param {number}   params.currentIndex
 * @param {string}   params.emotion
 * @param {number}   params.emotionBoost
 * @param {number}   params.linkedTopK     reduced topK for linked retrieval (default 2)
 * @param {object} config
 * @returns {Promise<string|null>}
 */
async function retrieveLinked(params, config) {
  const {
    charName, queryText, currentIndex,
    emotion = "neutral", emotionBoost = 0.1,
    linkedTopK = 2,
  } = params;
  const collection = `${config.collectionPrefix}${sanitizeCollectionName(charName)}`;

  let queryVector;
  try {
    queryVector = await embedText(queryText, config);
  } catch (e) {
    console.warn(`[rag-retriever] Failed to embed linked query: ${e.message}`);
    return null;
  }

  let hits;
  try {
    hits = await queryPoints(collection, queryVector, linkedTopK * 2, config);
  } catch (e) {
    if (e.message.includes("404") || e.message.includes("Not found")) return null;
    console.warn(`[rag-retriever] Linked query failed: ${e.message}`);
    return null;
  }

  if (!hits.length) return null;

  const unique = scoreAndFilter(hits, { currentIndex, emotion, emotionBoost }, config, queryText);
  const topHits = unique.slice(0, linkedTopK);

  if (!topHits.length) return null;

  return formatContext(topHits);
}

// ── Formatting ────────────────────────────────────────────────────────────────

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

function sanitizeCollectionName(name) {
  return (name ?? "unknown")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .slice(0, 40);
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.length === 0) return 1;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) matches++;
  }
  return matches / longer.length;
}

module.exports = { indexTurn, retrieve, retrieveLinked, sanitizeCollectionName };