/**
 * rag-embedder.js
 * Handles text embedding via Ollama mxbai-embed-large.
 * Single responsibility: text → float32 vector.
 */

"use strict";

const fetch = (...args) => import("node-fetch").then((m) => m.default(...args));

// mxbai-embed-large output dimension
const EMBEDDING_DIM = 1024;

/**
 * Embed a single string. Returns a float32 array.
 * Throws on network error or Ollama error response.
 * @param {string} text
 * @param {object} config  - must have ollamaUrl, ollamaModel
 * @returns {Promise<number[]>}
 */
async function embedText(text, config) {
  const { ollamaUrl, ollamaModel } = config;

  if (!text || !text.trim()) {
    throw new Error("[rag-embedder] Cannot embed empty text");
  }

  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel,
      input: text.trim(),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[rag-embedder] Ollama ${res.status}: ${body.slice(0, 200)}`,
    );
  }

  const data = await res.json();

  // Ollama /api/embed returns { embeddings: [[...]] }
  const vector = data?.embeddings?.[0];
  if (!Array.isArray(vector) || vector.length === 0) {
    throw new Error(
      `[rag-embedder] Unexpected Ollama response shape: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  return vector;
}

/**
 * Embed multiple strings in sequence.
 * Returns an array of vectors in the same order as inputs.
 * Skips empty strings — returns null in their place.
 * @param {string[]} texts
 * @param {object} config
 * @returns {Promise<(number[]|null)[]>}
 */
async function embedBatch(texts, config) {
  const results = [];
  for (const text of texts) {
    if (!text || !text.trim()) {
      results.push(null);
      continue;
    }
    const vec = await embedText(text, config);
    results.push(vec);
  }
  return results;
}

module.exports = { embedText, embedBatch, EMBEDDING_DIM };
