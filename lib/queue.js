"use strict";
// ============================================================
// lib/queue.js — Request queue
// Processes up to MAX_CONCURRENT requests at once, holds the
// rest in a FIFO queue until a slot opens up.
// ============================================================

const MAX_CONCURRENT = 3;
const QUEUE_TIMEOUT_MS = 60000; // max time a request can wait (60s)

let active = 0;
const queue = [];

const stats = {
  totalQueued: 0,
  totalProcessed: 0,
  totalTimedOut: 0,
};

function next() {
  if (queue.length === 0 || active >= MAX_CONCURRENT) return;

  const item = queue.shift();

  // Check if request timed out while waiting
  if (Date.now() - item.queuedAt > QUEUE_TIMEOUT_MS) {
    stats.totalTimedOut++;
    item.reject({
      status: 408,
      error: { message: "Request timed out in queue" },
    });
    next();
    return;
  }

  active++;
  item.resolve(() => {
    active--;
    stats.totalProcessed++;
    next();
  });
}

/**
 * Enqueue a request. Returns a promise that resolves with a
 * done() callback. Call done() when your request finishes.
 * @returns {Promise<Function>}
 */
function enqueue() {
  stats.totalQueued++;
  return new Promise((resolve, reject) => {
    queue.push({ resolve, reject, queuedAt: Date.now() });
    next();
  });
}

function getStats() {
  return {
    active,
    waiting: queue.length,
    totalQueued: stats.totalQueued,
    totalProcessed: stats.totalProcessed,
    totalTimedOut: stats.totalTimedOut,
  };
}

module.exports = { enqueue, getStats, MAX_CONCURRENT };