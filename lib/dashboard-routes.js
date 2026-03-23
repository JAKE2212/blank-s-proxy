// ============================================================
// lib/dashboard-routes.js — All /dashboard/* routes
// Mounted by index.js after extensions are loaded.
// ============================================================
const express = require("express");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");

module.exports = function registerDashboardRoutes(
  app,
  {
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
    lastRequestTime,
  },
) {
  // ── Serve dashboard ──────────────────────────────────────
  app.get("/dashboard", (req, res) => {
    res.setHeader(
      "Cache-Control",
      "no-store, no-cache, must-revalidate, proxy-revalidate",
    );
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Surrogate-Control", "no-store");
    res.sendFile(path.join(__dirname, "../dashboard/index.html"));
  });

  // ── Get logs ─────────────────────────────────────────────
  app.get("/dashboard/logs", (req, res) => {
    try {
      const raw = fs.readFileSync(LOG_FILE, "utf8");
      const logs = raw.trim().split("\n").filter(Boolean);
      res.json({ ok: true, logs });
    } catch {
      res.json({ ok: true, logs: [] });
    }
  });

  // ── Clear logs ────────────────────────────────────────────
  app.delete("/dashboard/logs", (req, res) => {
    fs.writeFileSync(LOG_FILE, "", "utf8");
    res.json({ ok: true });
  });

  // ── Log search ────────────────────────────────────────────
  app.get("/dashboard/logs/search", (req, res) => {
    const q = (req.query.q ?? "").toLowerCase().trim();
    if (!q) return res.status(400).json({ ok: false, error: "q is required" });
    try {
      const raw = fs.readFileSync(LOG_FILE, "utf8");
      const logs = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .filter((line) => line.toLowerCase().includes(q));
      res.json({ ok: true, query: q, count: logs.length, logs });
    } catch {
      res.json({ ok: true, query: q, count: 0, logs: [] });
    }
  });

  // ── Log export ────────────────────────────────────────────
  app.get("/dashboard/logs/export", (req, res) => {
    try {
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="requests.log"',
      );
      res.setHeader("Content-Type", "text/plain");
      res.sendFile(LOG_FILE);
    } catch {
      res.status(500).json({ error: "Log file not found" });
    }
  });

  // ── Restart proxy ─────────────────────────────────────────
  app.post("/dashboard/restart", (req, res) => {
    res.json({ ok: true });
    setTimeout(() => process.exit(0), 500);
  });

  // ── View config ───────────────────────────────────────────
  app.get("/dashboard/config", (req, res) => {
    res.json({
      ok: true,
      config: CONFIG,
      env: {
        PORT,
        DEFAULT_MODEL,
        HAS_API_KEY: !!process.env.PROXY_API_KEY,
        HAS_OPENROUTER_KEY: !!process.env.OPENROUTER_API_KEY,
      },
    });
  });

  // ── Stats ─────────────────────────────────────────────────
  app.get("/dashboard/stats", (req, res) => {
    try {
      const raw = fs.readFileSync(LOG_FILE, "utf8");
      const logs = raw
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const today = new Date().toDateString();
      const bot = logs.filter((l) => l.event === "bot");
      const botToday = bot.filter(
        (l) => new Date(l.timestamp).toDateString() === today,
      );
      const reqToday = logs.filter(
        (l) =>
          l.event === "user" && new Date(l.timestamp).toDateString() === today,
      );
      const totalTokens = bot.reduce((s, l) => s + (l.total_tokens || 0), 0);
      const tokensToday = botToday.reduce(
        (s, l) => s + (l.total_tokens || 0),
        0,
      );
      const cacheHits = bot.filter((l) => l.cache_read > 0).length;
      const errors = logs.filter((l) => l.event === "error").length;
      res.json({
        ok: true,
        allTime: {
          totalRequests: logs.filter((l) => l.event === "user").length,
          totalTokens,
          totalErrors: errors,
          cacheHitRate: bot.length
            ? Math.round((cacheHits / bot.length) * 100) + "%"
            : "0%",
          tokensSaved: bot.reduce((s, l) => s + (l.cache_read || 0), 0),
        },
        today: {
          requests: reqToday.length,
          tokens: tokensToday,
          estCost: "$" + ((tokensToday / 1e6) * 3).toFixed(4),
        },
      });
    } catch {
      res.json({ ok: true, allTime: {}, today: {} });
    }
  });

  // ── Extensions metadata ───────────────────────────────────
  app.get("/dashboard/extensions", (req, res) => {
    res.json({
      ok: true,
      extensions: extensions.map((e) => ({
        filename: e.filename,
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

  // ── Config hot-reload ─────────────────────────────────────
  app.post("/dashboard/env-reload", (req, res) => {
    try {
      dotenv.config({ override: true });
      console.log("[proxy] .env reloaded");
      res.json({ ok: true, message: ".env reloaded" });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── Uptime history ────────────────────────────────────────
  app.get("/dashboard/uptime-history", (req, res) => {
    res.json({ ok: true, restarts: RESTART_HISTORY });
  });

  // ── Extension reload ──────────────────────────────────────
  app.post("/dashboard/extensions/reload", (req, res) => {
    try {
      extensions.length = 0;
      app._router.stack = app._router.stack.filter(
        (layer) => !layer?.regexp?.toString().includes("extensions"),
      );
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
          console.log(`[proxy] Reloaded: ${file}`);
        } catch (e) {
          console.warn(`[proxy] Failed to reload ${file}:`, e.message);
        }
      }
      extensions.sort((a, b) => (a.priority ?? 50) - (b.priority ?? 50));
      console.log(
        `[proxy] Extension reload complete — ${extensions.length} loaded`,
      );
      res.json({ ok: true, extensions: extensions.map((e) => e.filename) });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
};
