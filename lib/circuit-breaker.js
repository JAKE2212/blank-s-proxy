// ============================================================
// lib/circuit-breaker.js — Circuit breaker + request timeout
// If OpenRouter fails FAILURE_THRESHOLD times in a row,
// the breaker opens and rejects all requests for RESET_MS.
// After that it lets one through to test if it's back.
// ============================================================

const FAILURE_THRESHOLD = 5; // failures before opening
const RESET_MS = 30000; // how long to stay open (30s)
const REQUEST_TIMEOUT_MS = 60000; // max time for a single request (60s)

const STATE = { CLOSED: "closed", OPEN: "open", HALF_OPEN: "half-open" };

let state = STATE.CLOSED;
let failures = 0;
let lastFailTime = null;
let lastError = null;

// ── Record a success ───────────────────────────────────────
function onSuccess() {
  failures = 0;
  lastError = null;
  if (state !== STATE.CLOSED) {
    console.log("[circuit-breaker] Closed — OpenRouter recovered");
    state = STATE.CLOSED;
  }
}

// ── Record a failure ───────────────────────────────────────
function onFailure(err) {
  failures++;
  lastFailTime = Date.now();
  lastError = err?.message ?? String(err);

  if (failures >= FAILURE_THRESHOLD && state === STATE.CLOSED) {
    state = STATE.OPEN;
    console.warn(
      `[circuit-breaker] OPEN — ${failures} failures in a row. Pausing for ${RESET_MS / 1000}s`,
    );
  }
}

// ── Check if a request is allowed through ─────────────────
function isAllowed() {
  if (state === STATE.CLOSED) return true;

  if (state === STATE.OPEN) {
    if (Date.now() - lastFailTime >= RESET_MS) {
      state = STATE.HALF_OPEN;
      console.log("[circuit-breaker] Half-open — testing OpenRouter...");
      return true; // let one probe through
    }
    return false;
  }

  if (state === STATE.HALF_OPEN) return true; // let the probe finish
  return false;
}

// ── Get current status ─────────────────────────────────────
function getStatus() {
  return {
    state,
    failures,
    lastFailTime,
    lastError,
    resetIn:
      state === STATE.OPEN
        ? Math.max(
            0,
            Math.round((RESET_MS - (Date.now() - lastFailTime)) / 1000),
          ) + "s"
        : null,
  };
}

// ── Wrap a fetch call with timeout + circuit breaker ───────
async function callWithBreaker(fn) {
  if (!isAllowed()) {
    const s = getStatus();
    throw {
      status: 503,
      error: {
        message: `Service unavailable — circuit breaker open. Retrying in ${s.resetIn}.`,
      },
      breaker: true,
    };
  }

  // Race the actual call against a timeout
  const timeout = new Promise((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`),
        ),
      REQUEST_TIMEOUT_MS,
    ),
  );

  try {
    const result = await Promise.race([fn(), timeout]);
    onSuccess();
    return result;
  } catch (err) {
    // Don't count 4xx client errors as circuit breaker failures
    if (err?.status >= 400 && err?.status < 500) throw err;
    onFailure(err);
    throw err;
  }
}

module.exports = { callWithBreaker, getStatus, onSuccess, onFailure, STATE };
