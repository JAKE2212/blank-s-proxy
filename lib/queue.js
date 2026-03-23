// ============================================================
// lib/queue.js — Request queue
// Replaces simple deduplication with a proper queue that
// processes up to MAX_CONCURRENT requests at once, and
// holds the rest until a slot opens up.
// ============================================================

const MAX_CONCURRENT = 3; // max simultaneous OpenRouter requests
const QUEUE_TIMEOUT_MS = 60000; // max time a request can wait in queue (60s)

let active = 0;
const queue = [];

// ── Stats ──────────────────────────────────────────────────
const stats = {
  totalQueued: 0,
  totalProcessed: 0,
  totalTimedOut: 0,
  totalRejected: 0,
  currentActive: () => active,
  currentWaiting: () => queue.length,
};

// ── Process next item in queue ─────────────────────────────
function next() {
  if (queue.length === 0 || active >= MAX_CONCURRENT) return;

  const item = queue.shift();

  // Check if request already timed out while waiting
  if (Date.now() - item.queuedAt > QUEUE_TIMEOUT_MS) {
    stats.totalTimedOut++;
    item.reject({
      status: 408,
      error: { message: "Request timed out in queue" },
    });
    next(); // try next item
    return;
  }

  active++;
  item.resolve(() => {
    active--;
    stats.totalProcessed++;
    next(); // free up a slot
  });
}

// ── Enqueue a request ──────────────────────────────────────
// Returns a promise that resolves with a `done` callback.
// Call done() when your request finishes to free the slot.
function enqueue() {
  stats.totalQueued++;

  return new Promise((resolve, reject) => {
    queue.push({ resolve, reject, queuedAt: Date.now() });
    next();
  });
}

// ── Get queue stats ────────────────────────────────────────
function getStats() {
  return {
    active: stats.currentActive(),
    waiting: stats.currentWaiting(),
    totalQueued: stats.totalQueued,
    totalProcessed: stats.totalProcessed,
    totalTimedOut: stats.totalTimedOut,
  };
}

module.exports = { enqueue, getStats, MAX_CONCURRENT };
