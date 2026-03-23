// ============================================================
// dashboard-overview.js — Stats cards and health/extensions
// panel on the Overview tab.
// ============================================================

// ── Stats ──────────────────────────────────────────────────
async function fetchStats() {
  try {
    const data = await fetch("/dashboard/logs").then((r) => r.json());
    const logs = (data.logs || [])
      .map((l) => {
        try {
          const p = JSON.parse(l);
          return typeof p === "object" && p ? p : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const today = new Date().toDateString();
    const bot = logs.filter(
      (l) =>
        (l.event === "bot" || l.event === "success") &&
        new Date(l.timestamp).toDateString() === today,
    );
    const req = logs.filter(
      (l) =>
        (l.event === "user" || l.event === "request") &&
        new Date(l.timestamp).toDateString() === today,
    );
    const tot = bot.reduce((s, l) => s + (l.total_tokens || 0), 0);
    const hits = bot.filter((l) => l.cache_read > 0).length;

    const fmt = (n) =>
      n > 1000 ? (n / 1000).toFixed(1) + "k" : String(n || 0);

    document.getElementById("stat-requests").textContent = req.length || "0";
    document.getElementById("stat-tokens").textContent = fmt(tot);
    document.getElementById("stat-cache").textContent = bot.length
      ? Math.round((hits / bot.length) * 100) + "%"
      : "0%";
    document.getElementById("stat-avg").textContent = fmt(
      bot.length ? Math.round(tot / bot.length) : 0,
    );
    document.getElementById("stat-cost").textContent =
      "$" + ((tot / 1e6) * 3).toFixed(3);
    document.getElementById("stat-saved").textContent = fmt(
      bot.reduce((s, l) => s + (l.cache_read || 0), 0),
    );
  } catch (e) {
    console.error("Stats:", e);
  }
}

// ── Health & extensions ────────────────────────────────────
function formatUptime(s) {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

async function fetchHealth() {
  try {
    const data = await fetch("/health").then((r) => r.json());

    document.getElementById("health-uptime").textContent = formatUptime(
      data.uptime ?? 0,
    );
    document.getElementById("health-last").textContent = data.lastRequest
      ? new Date(data.lastRequest).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : "None yet";

    const el = document.getElementById("health-extensions");
    if (!data.extensions?.length) {
      el.innerHTML =
        '<div class="empty-state" style="padding:.5rem 0;">No extensions loaded.</div>';
      return;
    }
    el.innerHTML = data.extensions
      .map(
        (e) =>
          `<div class="ext-chip">
        <span class="ext-chip-name">${esc(e.name)}</span>
        <span class="ext-chip-version">v${esc(String(e.version))}</span>
        <span class="ext-chip-priority">p${e.priority}</span>
        <span class="ext-chip-hooks">${e.hooks.join(", ")}</span>
      </div>`,
      )
      .join("");
  } catch (e) {
    console.error("Health:", e);
  }
}
