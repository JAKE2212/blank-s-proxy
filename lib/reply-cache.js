"use strict";

/**
 * lib/reply-cache.js — Catches and caches the last successful reply.
 *
 * Purpose:
 *   1. If recast/pipeline takes too long and JanitorAI times out,
 *      the reply is still saved and can be recovered.
 *   2. On rerolls, if the previous reply already passed all checks,
 *      recast can be skipped entirely.
 *
 * Usage:
 *   - After the main model response comes back (before recast), call cacheRaw()
 *   - After recast finishes, call cacheFinal()
 *   - In recast, call shouldSkip() to check if this is a reroll of a passed reply
 *   - Dashboard/API can call getLast() to recover the last reply
 */

const fs = require("fs");
const path = require("path");

const CACHE_FILE = path.join(__dirname, "../data/reply-cache.json");

let _cache = {
  raw: null,         // reply straight from the model (before recast)
  final: null,       // reply after recast passed
  userText: null,    // the user message that triggered this reply
  timestamp: null,
  recastPassed: false,
};

/**
 * Cache the raw model reply before recast runs.
 * @param {string} reply — the raw reply text
 * @param {string} userText — the user's message
 */
function cacheRaw(reply, userText) {
  _cache.raw = reply;
  _cache.userText = userText;
  _cache.timestamp = Date.now();
  _cache.recastPassed = false;
  _cache.final = null;
  _writeToDisk();
}

/**
 * Cache the final reply after recast passes.
 * @param {string} reply — the final reply text
 */
function cacheFinal(reply) {
  _cache.final = reply;
  _cache.recastPassed = true;
  _writeToDisk();
}

/**
 * Check if recast should be skipped on a reroll.
 * Returns true if the user message is the same AND the previous reply passed recast.
 * @param {string} userText — current user message
 * @returns {boolean}
 */
function shouldSkipRecast(userText) {
  return (
    _cache.recastPassed &&
    _cache.userText !== null &&
    userText === _cache.userText
  );
}

/**
 * Get the last cached reply (for recovery).
 * @returns {{ raw: string|null, final: string|null, userText: string|null, timestamp: number|null, recastPassed: boolean }}
 */
function getLast() {
  return { ..._cache };
}

/**
 * Write cache to disk so it survives restarts.
 */
function _writeToDisk() {
  fs.writeFile(CACHE_FILE, JSON.stringify(_cache, null, 2), "utf8", (err) => {
    if (err) console.warn("[reply-cache] Failed to write cache:", err.message);
  });
}

/**
 * Load cache from disk on startup.
 */
function _loadFromDisk() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
      _cache = { ..._cache, ...data };
    }
  } catch {}
}

// Load on require
_loadFromDisk();

module.exports = {
  cacheRaw,
  cacheFinal,
  shouldSkipRecast,
  getLast,
};