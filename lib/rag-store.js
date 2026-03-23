"use strict";

/**
 * rag-store.js
 * Qdrant CRUD operations for the RAG system.
 * Handles: collection creation, upsert, query.
 * Single responsibility: proxy ↔ Qdrant communication.
 */

const { EMBEDDING_DIM } = require("./rag-embedder");

/**
 * Build the base Qdrant URL for a collection.
 * @param {string} qdrantUrl  e.g. "http://192.168.1.192:6333"
 * @param {string} collection
 */
function collectionUrl(qdrantUrl, collection) {
  return `${qdrantUrl}/collections/${collection}`;
}

/**
 * Ensure a Qdrant collection exists. Creates it if not.
 * Safe to call on every request — checks before creating.
 * @param {string} collection
 * @param {object} config  must have qdrantUrl
 */
async function ensureCollection(collection, config) {
  const { qdrantUrl } = config;
  const url = collectionUrl(qdrantUrl, collection);

  // Check if it already exists
  const check = await fetch(url);
  if (check.ok) return; // already exists

  // Create it
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vectors: {
        size: EMBEDDING_DIM,
        distance: "Cosine",
      },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[rag-store] Failed to create collection "${collection}": ${res.status} ${body.slice(0, 200)}`,
    );
  }

  console.log(`[rag-store] Created collection: ${collection}`);
}

/**
 * Upsert a single chunk into Qdrant.
 * @param {string} collection
 * @param {object} point  { id, vector, payload }
 *   payload should include: { text, role, charName, messageIndex, timestamp }
 * @param {object} config
 */
async function upsertPoint(collection, point, config) {
  const { qdrantUrl } = config;
  const url = `${collectionUrl(qdrantUrl, collection)}/points`;

  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      points: [point],
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[rag-store] Upsert failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }
}

/**
 * Query Qdrant for the top-K most similar vectors.
 * Returns raw Qdrant hits: [{ id, score, payload }]
 * @param {string} collection
 * @param {number[]} vector       query embedding
 * @param {number}  topK          max results to return
 * @param {object}  config
 * @returns {Promise<Array>}
 */
async function queryPoints(collection, vector, topK, config) {
  const { qdrantUrl } = config;
  const url = `${collectionUrl(qdrantUrl, collection)}/points/search`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vector,
      limit: topK,
      with_payload: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `[rag-store] Query failed: ${res.status} ${body.slice(0, 200)}`,
    );
  }

  const data = await res.json();
  return data.result ?? [];
}

/**
 * Get the total number of points in a collection.
 * Returns 0 if the collection doesn't exist yet.
 * @param {string} collection
 * @param {object} config
 * @returns {Promise<number>}
 */
async function getPointCount(collection, config) {
  const { qdrantUrl } = config;
  const res = await fetch(collectionUrl(qdrantUrl, collection));
  if (!res.ok) return 0;
  const data = await res.json();
  return data.result?.points_count ?? 0;
}

/**
 * Generate a deterministic numeric ID for a point
 * from charName + messageIndex + role.
 * Qdrant requires unsigned 64-bit integer IDs.
 * We use a simple hash to stay within safe JS integer range.
 * @param {string} charName
 * @param {number} messageIndex
 * @param {string} role  'user' | 'assistant'
 * @returns {number}
 */
function makePointId(charName, messageIndex, role) {
  const str = `${charName}:${messageIndex}:${role}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  // Make positive and scale to a safe integer range
  return Math.abs(hash) * 100 + (role === "user" ? 1 : 2);
}

module.exports = {
  ensureCollection,
  upsertPoint,
  queryPoints,
  getPointCount,
  makePointId,
};
