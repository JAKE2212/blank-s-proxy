// ============================================================
// index.js — JanitorAI Proxy Server
// Receives requests from JanitorAI and forwards them to
// OpenRouter, then returns the response back to JanitorAI.
// ============================================================
const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { applyPromptCaching } = require("./lib/prompt-cache");
const { enqueue, getStats: getQueueStats } = require("./lib/queue");
const {
  callWithBreaker,
  getStatus: getBreakerStatus,
} = require("./lib/circuit-breaker");
const registerDashboardRoutes = require("./lib/dashboard-routes");
const replyCache = require("./lib/reply-cache");
const { injectPrompt } = require("./lib/custom-prompt");

// ── Build dashboard bundle on startup ─────────────────────
const { execSync } = require("child_process");
try {
  execSync("node dashboard/build.js", { cwd: __dirname });
  console.log("[proxy] ✦ Dashboard bundle built");
} catch (e) {
  console.warn("[proxy] ⚠ Dashboard bundle build failed:", e.message);
}

// ── Extension auto-discovery ───────────────────────────────
// Scans the extensions/ folder and loads any .js files found.
// Each extension can export { router, transformRequest, transformResponse }
const EXTENSIONS_DIR = path.join(__dirname, "extensions");
const extensions = [];

if (fs.existsSync(EXTENSIONS_DIR)) {
  const files = fs.readdirSync(EXTENSIONS_DIR).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    try {
      const ext = require(path.join(EXTENSIONS_DIR, file));
      extensions.push({ filename: file, ...ext });
      const meta = ext.name ? `${ext.name} v${ext.version ?? "?"}` : file;
      console.log(`[extensions] Loaded: ${meta} (${file})`);
    } catch (e) {
      console.warn(`[extensions] Failed to load ${file}:`, e.message);
    }
  }
}

extensions.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));

// ── Load environment variables from .env ──────────────────
dotenv.config();
process.on("unhandledRejection", (reason) => {
  console.error("[proxy] Unhandled rejection:", reason?.message ?? reason);
});

// ── .env validation ────────────────────────────────────────
const REQUIRED_ENV = ["OPENROUTER_API_KEY", "DEFAULT_MODEL"];
for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.warn(`[proxy] ⚠ Missing required env var: ${key}`);
  }
}

const app = express();
const PORT = process.env.PORT || 3000;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const DEFAULT_MODEL = process.env.DEFAULT_MODEL;

// ── Enable CORS for all origins ────────────────────────────
// Required for JanitorAI (browser-based) to reach the proxy
const ALLOWED_ORIGINS = [
  "https://janitorai.com",
  "https://www.janitorai.com",
  "https://proxy.kiana-designs.com",
];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. Portainer console, curl, mobile apps)
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`[proxy] Blocked CORS request from: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
  }),
);

// ── Parse incoming JSON request bodies ────────────────────
app.use(express.json({ limit: "10mb" }));
app.use("/dashboard", express.static(path.join(__dirname, "dashboard")));

// ── Proxy authentication ───────────────────────────────
app.use("/v1", (req, res, next) => {
  const auth = req.headers["authorization"] ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!process.env.PROXY_API_KEY || token === process.env.PROXY_API_KEY) {
    return next();
  }
  res.status(401).json({ error: "Unauthorized" });
});

// ── Rate limiting ──────────────────────────────────────
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 30; // max requests per window

app.use("/v1", (req, res, next) => {
  const ip = req.headers["cf-connecting-ip"] ?? req.ip;
  const now = Date.now();
  const rec = rateLimitMap.get(ip) ?? { count: 0, start: now };

  if (now - rec.start > RATE_LIMIT_WINDOW_MS) {
    rec.count = 0;
    rec.start = now;
  }

  rec.count++;
  rateLimitMap.set(ip, rec);

  if (rec.count > RATE_LIMIT_MAX) {
    return res.status(429).json({ error: "Too many requests — slow down." });
  }

  next();
});

setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of rateLimitMap) {
    if (now - rec.start > RATE_LIMIT_WINDOW_MS) rateLimitMap.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);

// ── Mount extension routes ─────────────────────────────────
// Each extension's router is mounted at /extensions/<name>
for (const ext of extensions) {
  if (ext.router) {
    const name = ext.filename.replace(".js", "");
    app.use(`/extensions/${name}`, ext.router);
    console.log(`[extensions] Mounted router: /extensions/${name}`);
  }
}
// ── Logging setup ──────────────────────────────────────────
const LOG_FILE = path.join(__dirname, "logs", "requests.log");

// ── Auto-create logs directory if missing ──────────────
if (!fs.existsSync(path.join(__dirname, "logs"))) {
  fs.mkdirSync(path.join(__dirname, "logs"), { recursive: true });
  console.log("[proxy] Created logs/ directory");
}

// ── Auto-create data directory if missing ──────────────
if (!fs.existsSync(path.join(__dirname, "data"))) {
  fs.mkdirSync(path.join(__dirname, "data"), { recursive: true });
  console.log("[proxy] Created data/ directory");
}

const LOG_MAX_BYTES = 5 * 1024 * 1024; // 5MB

function rotateLogs() {
  try {
    if (!fs.existsSync(LOG_FILE)) return;
    const size = fs.statSync(LOG_FILE).size;
    if (size < LOG_MAX_BYTES) return;
    const archive = LOG_FILE.replace(".log", `.${Date.now()}.log`);
    fs.renameSync(LOG_FILE, archive);
    console.log(`[proxy] Log rotated → ${path.basename(archive)}`);

    // ── Delete archives older than 7 days ──────────────
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    fs.readdirSync(path.join(__dirname, "logs"))
      .filter((f) => f.startsWith("requests.") && f.endsWith(".log"))
      .forEach((f) => {
        const filepath = path.join(__dirname, "logs", f);
        if (fs.statSync(filepath).mtimeMs < cutoff) {
          fs.unlinkSync(filepath);
          console.log(`[proxy] Deleted old log archive: ${f}`);
        }
      });
  } catch (e) {
    console.warn("[proxy] Log rotation failed:", e.message);
  }
}

setInterval(rotateLogs, 5 * 60 * 1000); // check every 5 minutes

// ── Sensitive content masking ──────────────────────────
const MASK_PATTERNS = [
  /sk-[a-zA-Z0-9\-]{10,}/g, // OpenAI/OpenRouter style keys
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g, // Bearer tokens
  /key["\s:=]+["']?[a-zA-Z0-9\-]{16,}/gi, // generic key= patterns
];

function maskSensitive(str) {
  let out = str;
  for (const pattern of MASK_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

function writeLog(entry) {
  const raw =
    typeof entry === "string"
      ? `{"timestamp":"${new Date().toISOString()}","message":${JSON.stringify(entry)}}`
      : JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
  const line = maskSensitive(raw) + "\n";
  fs.appendFile(LOG_FILE, line, "utf8", (err) => {
    if (err) console.error("[proxy] Failed to write log:", err.message);
  });
  console.log(
    typeof entry === "string" ? entry : "[proxy]" + JSON.stringify(entry),
  );
}

// ── Config ─────────────────────────────────────────────────
const CONFIG = {
  MAX_RETRIES: 3, // How many times to retry a failed request
  RETRY_DELAY_MS: 1000, // Base delay between retries (ms)
};

// ── Helper: delay for retries ──────────────────────────────
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Request ID ─────────────────────────────────────────────
function genRequestId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ── Model name normalization ───────────────────────────────
function normalizeModel(model) {
  return (model ?? "").replace(/^[a-z-]+\//, "");
}

// ── Helper: send request to OpenRouter with retry logic ────
async function sendToOpenRouter(payload) {
  let lastError;

  for (let attempt = 1; attempt <= CONFIG.MAX_RETRIES; attempt++) {
    try {
      writeLog({
        event: "system",
        message: `[proxy] Attempt ${attempt}/${CONFIG.MAX_RETRIES} — model: ${payload.model}`,
      });

      const response = await callWithBreaker(() =>
        fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENROUTER_API_KEY}`,
            "HTTP-Referer": "https://proxy.kiana-designs.com",
            "X-Title": "Kiana Proxy",
          },
          body: JSON.stringify(payload),
        }),
      );

      // ── Non-OK response from OpenRouter ───────────────────
      if (!response.ok) {
        const error = await response
          .json()
          .catch(() => ({ message: response.statusText }));
        writeLog({
          event: "system",
          message: `[proxy] OpenRouter error on attempt ${attempt}: ${JSON.stringify(error)}`,
        });
        lastError = { status: response.status, error };

        // Don't retry on 4xx errors — only on 5xx or network issues
        if (response.status < 500) break;

        await delay(CONFIG.RETRY_DELAY_MS * attempt); // backoff: 1s, 2s, 3s
        continue;
      }

      // ── Success ────────────────────────────────────────────
      const data = await response.json();
      writeLog({
        event: "system",
        message: `[proxy] Success on attempt ${attempt}`,
      });
      return { ok: true, data };
    } catch (err) {
      writeLog({
        event: "system",
        message: `[proxy] Fetch error on attempt ${attempt}: ${err.message}`,
      });
      lastError = { status: 500, error: { message: err.message } };
      await delay(CONFIG.RETRY_DELAY_MS * attempt);
    }
  }

  writeLog({ event: "system", message: "[proxy] All retries exhausted" });
  return { ok: false, ...lastError };
}

// ── Health check endpoint ──────────────────────────────────
app.get("/", (req, res) => {
  res.json({ ok: true, message: "Proxy is running!" });
});

const START_TIME = Date.now();
let lastRequestTime = null;
const RESTART_HISTORY = [{ time: new Date().toISOString(), reason: "startup" }];
let lastReply = null;

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    uptime: Math.floor((Date.now() - START_TIME) / 1000),
    lastRequest: lastRequestTime,
    breaker: getBreakerStatus(),
    queue: getQueueStats(),
    memory: {
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    },
    extensions: extensions.map((e) => ({
      name: e.name ?? e.filename,
      version: e.version ?? "?",
      priority: e.priority ?? 50,
      hooks: [
        e.transformRequest ? "transformRequest" : null,
        e.transformResponse ? "transformResponse" : null,
        e.router ? "router" : null,
      ].filter(Boolean),
    })),
  });
});

// ── Reply recovery endpoint ────────────────────────────────
app.get("/v1/last-reply", (req, res) => {
  const cached = replyCache.getLast();
  res.json({ ok: true, ...cached });
});

// ── Dashboard routes ───────────────────────────────────────
registerDashboardRoutes(app, {
  LOG_FILE,
  CONFIG,
  PORT,
  DEFAULT_MODEL,
  extensions,
  EXTENSIONS_DIR,
  RESTART_HISTORY,
  START_TIME,
  getBreakerStatus,
  getQueueStats,
  lastRequestTime: () => lastRequestTime,
});

// ── Main proxy endpoint ────────────────────────────────────
// JanitorAI sends requests to /v1/chat/completions
app.post("/v1/chat/completions", async (req, res) => {
  let done;
  try {
    const body = req.body;
    const model = body.model || DEFAULT_MODEL;
    const requestId = genRequestId();

    // ── Request validation ─────────────────────────────
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return res
        .status(400)
        .json({ error: "messages must be a non-empty array" });
    }
    if (body.messages.length > 2000) {
      return res.status(400).json({ error: "Too many messages — max 2000" });
    }
    const totalChars = body.messages.reduce((sum, m) => {
      const content =
        typeof m.content === "string"
          ? m.content
          : JSON.stringify(m.content ?? "");
      return sum + content.length;
    }, 0);
    if (totalChars > 2_000_000) {
      return res
        .status(400)
        .json({ error: "Request too large — max 2M characters" });
    }

    // ── Queue the request ──────────────────────────────────
    try {
      done = await enqueue();
    } catch (qErr) {
      return res.status(qErr.status ?? 503).json(qErr.error);
    }

    // ── Log incoming request ───────────────────────────────
    const lastUserMsg = body.messages?.findLast((m) => m.role === "user");
    lastRequestTime = new Date().toISOString();
    writeLog({
      event: "user",
      requestId,
      model: normalizeModel(model),
      messages: body.messages?.length,
      user:
        typeof lastUserMsg?.content === "string"
          ? lastUserMsg.content.slice(0, 300)
          : null,
    });

    const messages = applyPromptCaching(body.messages ?? [], model);

    // ── Build payload — force streaming off ────────────────
    const payload = {
      ...body,
      model,
      messages,
      stream: false,
    };

    // ── Inject custom system prompt (also strips JanitorAI instructions) ──
    payload.messages = injectPrompt(payload.messages);

    // ── Stash raw system prompt for recast (before extensions modify it)
    const recastExt = extensions.find((e) => e.filename === "recast.js");
    if (recastExt) {
      const sysMsg = payload.messages.find(m => m.role === "system");
      const rawPrompt = typeof sysMsg?.content === "string"
        ? sysMsg.content
        : Array.isArray(sysMsg?.content)
          ? sysMsg.content.map(b => b.text || "").join("\n\n")
          : "";
      recastExt._rawSystemPrompt = rawPrompt;
    }
    
    // ── Pre-extract bot name for TunnelVision before extensions transform messages
    const tvExt = extensions.find((e) => e.filename === "tunnelvision.js");
    if (tvExt?.primeTreeName) {
      tvExt.primeTreeName(body.messages);
    }

    // ── Run through extension pipeline ─────────────────────
    // RAG and TunnelVision run in parallel since they modify different
    // parts of the payload (RAG = system prompt content, TV = tools).
    // All other extensions run sequentially in priority order.
    let transformedPayload = payload;

    const ragExt = extensions.find(e => e.filename === "rag.js");
    const tvExtPipeline = extensions.find(e => e.filename === "tunnelvision.js");
    const parallelSet = new Set(["rag.js", "tunnelvision.js"]);

    // Phase 1: Run extensions BEFORE RAG/TV (priority < 25)
    for (const ext of extensions) {
      if (parallelSet.has(ext.filename)) continue;
      if ((ext.priority ?? 50) >= 25) continue;
      if (ext.transformRequest) {
        try {
          transformedPayload = await ext.transformRequest(transformedPayload);
        } catch (e) {
          writeLog({
            event: "error",
            message: `[extensions] ${ext.name ?? ext.filename} transformRequest failed: ${e.message}`,
          });
        }
      }
    }

    // Phase 2: Run RAG + TunnelVision in parallel
    if (ragExt?.transformRequest || tvExtPipeline?.transformRequest) {
      const parallelPayload = { ...transformedPayload };
      const [ragResult, tvResult] = await Promise.allSettled([
        ragExt?.transformRequest
          ? ragExt.transformRequest({ ...parallelPayload })
          : Promise.resolve(parallelPayload),
        tvExtPipeline?.transformRequest
          ? tvExtPipeline.transformRequest({ ...parallelPayload })
          : Promise.resolve(parallelPayload),
      ]);

      // Merge results: RAG modifies messages (system prompt content), TV adds tools
      const ragPayload = ragResult.status === "fulfilled" ? ragResult.value : parallelPayload;
      const tvPayload = tvResult.status === "fulfilled" ? tvResult.value : parallelPayload;

      if (ragResult.status === "rejected") {
        writeLog({ event: "error", message: `[extensions] RAG transformRequest failed: ${ragResult.reason?.message}` });
      }
      if (tvResult.status === "rejected") {
        writeLog({ event: "error", message: `[extensions] TunnelVision transformRequest failed: ${tvResult.reason?.message}` });
      }

      // Take messages from RAG (has injected memory context)
      // Take tools + tool_choice from TV (has injected tool definitions)
      transformedPayload = {
        ...ragPayload,
        tools: tvPayload.tools ?? ragPayload.tools,
        tool_choice: tvPayload.tool_choice ?? ragPayload.tool_choice,
      };
    }

    // Phase 3: Run extensions AFTER RAG/TV (priority > 26)
    for (const ext of extensions) {
      if (parallelSet.has(ext.filename)) continue;
      if ((ext.priority ?? 50) < 25) continue;
      if (ext.transformRequest) {
        try {
          transformedPayload = await ext.transformRequest(transformedPayload);
        } catch (e) {
          writeLog({
            event: "error",
            message: `[extensions] ${ext.name ?? ext.filename} transformRequest failed: ${e.message}`,
          });
        }
      }
    }

    let result;
    try {
      result = tvExt?.wrapSendWithToolLoop
        ? await tvExt.wrapSendWithToolLoop(
            transformedPayload,
            sendToOpenRouter,
          )
        : await sendToOpenRouter(transformedPayload);
    } catch (tvErr) {
      console.error(
        "[tunnelvision] Tool loop failed, falling back to direct send:",
        tvErr.message,
      );
      result = await sendToOpenRouter(transformedPayload);
    }

    if (!result.ok) {
      writeLog({
        event: "error",
        requestId,
        model: normalizeModel(model),
        status: result.status,
        error: result.error,
      });
      done();
      return res.status(result.status).json(result.error);
    }

    // ── Truncation warning ─────────────────────────────────
    const stopReason = result.data?.choices?.[0]?.finish_reason;
    if (stopReason === "length") {
      writeLog({
        event: "system",
        requestId,
        message: `[proxy] ⚠ Response truncated at token limit — model: ${normalizeModel(model)}`,
      });
    }

// ── Cache raw reply before recast runs ─────────────────
    const rawReply = result.data?.choices?.[0]?.message?.content;
    const lastUserMsgText = typeof lastUserMsg?.content === "string"
      ? lastUserMsg.content
      : (lastUserMsg?.content?.[0]?.text ?? "");
    if (rawReply) {
      replyCache.cacheRaw(rawReply, lastUserMsgText);
    }

    // ── Run transformResponse pipeline ─────────────────────
    let finalData = result.data;
    for (const ext of extensions) {
      if (ext.transformResponse) {
        try {
          finalData = await ext.transformResponse(finalData);
        } catch (e) {
          writeLog({
            event: "error",
            requestId,
            message: `[extensions] ${ext.name} transformResponse failed: ${e.message}`,
          });
        }
      }
    }

    // ── Log token usage (post-transform) ───────────────────
    const usage = result.data?.usage;
    const finalReply = finalData?.choices?.[0]?.message?.content;
    writeLog({
      event: "bot",
      requestId,
      model: normalizeModel(model),
      prompt_tokens: usage?.prompt_tokens,
      completion_tokens: usage?.completion_tokens,
      total_tokens: usage?.total_tokens,
      cache_read: usage?.prompt_tokens_details?.cached_tokens,
      char: typeof finalReply === "string" ? finalReply.slice(0, 300) : null,
    });

   // ── Cache final reply after pipeline ───────────────────
    if (finalReply) {
      replyCache.cacheFinal(finalReply);
    }

    // ── Duplicate response detection ───────────────────────
    if (lastReply && finalReply && typeof finalReply === "string") {
      const len = Math.min(finalReply.length, lastReply.length);
      let matches = 0;
      for (let i = 0; i < len; i++) {
        if (finalReply[i] === lastReply[i]) matches++;
      }
      const similarity = matches / Math.max(finalReply.length, lastReply.length);
      if (similarity > 0.9) {
        writeLog({
          event: "system",
          requestId,
          message: `[proxy] ⚠ Possible looping response detected — ${Math.round(similarity * 100)}% similar to last reply`,
        });
      }
    }
    lastReply = finalReply ?? null;

    done();
    res.json(finalData);
  } catch (err) {
    done?.();
    writeLog({ event: "error", error: err.message });
    console.error("[proxy] Unexpected error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Auto-reload extensions on file change ──────────────
let reloadTimer = null;
const RELOAD_DELAY_MS = 5000; // 5 second debounce

fs.watch(EXTENSIONS_DIR, (eventType, filename) => {
  if (!filename?.endsWith(".js")) return;
  console.log(
    `[extensions] Change detected in ${filename} — reloading in ${RELOAD_DELAY_MS / 1000}s...`,
  );

  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(async () => {
    try {
      console.log("[extensions] Auto-reloading extensions...");

      extensions.length = 0;
      if (app._router?.stack) {
        app._router.stack = app._router.stack.filter(
          (layer) => !layer?.regexp?.toString().includes("extensions"),
        );
      }

      const files = fs
        .readdirSync(EXTENSIONS_DIR)
        .filter((f) => f.endsWith(".js"));
      for (const file of files) {
        const fullPath = path.join(EXTENSIONS_DIR, file);
        delete require.cache[require.resolve(fullPath)];
        try {
          const ext = require(fullPath);
          extensions.push({ filename: file, ...ext });
          if (ext.router) {
            const name = file.replace(".js", "");
            app.use(`/extensions/${name}`, ext.router);
          }
          console.log(`[extensions] Auto-reloaded: ${file}`);
        } catch (e) {
          console.warn(`[extensions] Failed to reload ${file}:`, e.message);
        }
      }

      extensions.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
      console.log(
        `[extensions] Auto-reload complete — ${extensions.length} loaded`,
      );
    } catch (e) {
      console.error("[extensions] Auto-reload failed:", e.message);
    }
  }, RELOAD_DELAY_MS);
});

// ── Startup health check ───────────────────────────────
async function checkOpenRouter() {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}` },
    });
    if (res.ok) {
      console.log("[proxy] ✦ OpenRouter reachable — API key valid");
    } else {
      console.warn(
        `[proxy] ⚠ OpenRouter returned ${res.status} — check your API key`,
      );
    }
  } catch (e) {
    console.warn("[proxy] ⚠ OpenRouter unreachable on startup:", e.message);
  }
}

// ── Start the server ───────────────────────────────────────
const server = app.listen(PORT, () => {
  const line = "─".repeat(48);
  console.log(`[proxy] ${line}`);
  console.log(`[proxy] ✦ Kiana Proxy started on port ${PORT}`);
  console.log(`[proxy] ✦ Default model: ${DEFAULT_MODEL}`);
  console.log(`[proxy] ${line}`);
  console.log(`[proxy] Extensions loaded (${extensions.length}):`);
  for (const ext of extensions) {
    const hooks = [
      ext.transformRequest ? "transformRequest" : null,
      ext.transformResponse ? "transformResponse" : null,
      ext.router ? "router" : null,
    ]
      .filter(Boolean)
      .join(", ");
    console.log(
      `[proxy]   · ${ext.name ?? ext.filename} v${ext.version ?? "?"} (priority ${ext.priority ?? 50}) — ${hooks}`,
    );
  }
  console.log(`[proxy] ${line}`);
  checkOpenRouter();
});

// ── Graceful shutdown ──────────────────────────────────
function shutdown(signal) {
  RESTART_HISTORY.push({ time: new Date().toISOString(), reason: signal });
  console.log(`[proxy] ${signal} received — shutting down gracefully`);
  server.close(() => {
    console.log("[proxy] Server closed — exiting");
    process.exit(0);
  });
  // Force exit after 10s if server hasn't closed
  setTimeout(() => {
    console.warn("[proxy] Forcing exit after timeout");
    process.exit(1);
  }, 10000);
}

// ── Periodic garbage collection ────────────────────────────
if (global.gc) {
  setInterval(() => {
    global.gc();
  }, 60_000);
}

// ── Memory monitoring ──────────────────────────────────────
const MEMORY_WARN_MB = 400;
const MEMORY_RESTART_MB = 600;

setInterval(() => {
  const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  if (mb >= MEMORY_RESTART_MB) {
    console.error(`[proxy] ⚠ Memory critical (${mb}MB) — restarting`);
    shutdown("OOM");
  } else if (mb >= MEMORY_WARN_MB) {
    console.warn(`[proxy] ⚠ Memory high: ${mb}MB`);
  }
}, 30000); // check every 30s

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
