// ============================================================
// dashboard-logs.js — Log viewer, filters, pagination,
// and the message preview modal.
// ============================================================

const activeFilters = new Set(["user", "bot", "system", "error"]);
let allLogs = [],
  curPage = 1,
  msgStore = {};
const PAGE = 10;

// ── Filter pills ───────────────────────────────────────────
function toggleFilter(type, el) {
  activeFilters.has(type)
    ? activeFilters.delete(type)
    : activeFilters.add(type);
  el.classList.toggle("active");
  renderLogs();
}

// ── Fetch & render ─────────────────────────────────────────
async function fetchLogs() {
  try {
    const data = await fetch("/dashboard/logs").then((r) => r.json());
    allLogs = (data.logs || [])
      .map((l, i) => ({ raw: l, idx: i, obj: tryParse(l) }))
      .reverse();
    document.getElementById("log-count").textContent =
      (data.logs || []).length + " entries";
    curPage = 1;
    renderLogs();
  } catch {
    document.getElementById("log-list").innerHTML =
      '<div class="empty-state">Failed to load logs.</div>';
  }
}

function renderLogs() {
  const list = document.getElementById("log-list");
  const pgDiv = document.getElementById("pagination");
  const vis = allLogs.filter(({ obj }) => activeFilters.has(getType(obj)));

  if (!vis.length) {
    list.innerHTML = '<div class="empty-state">No logs match filters.</div>';
    pgDiv.innerHTML = "";
    return;
  }

  const total = Math.ceil(vis.length / PAGE);
  if (curPage > total) curPage = total;
  const start = (curPage - 1) * PAGE;

  list.innerHTML = "";
  vis
    .slice(start, start + PAGE)
    .forEach(({ obj, raw, idx }) => list.appendChild(makeEntry(obj, raw, idx)));

  // Pagination controls
  pgDiv.innerHTML = "";
  pgDiv.appendChild(
    mkPageBtn("← Prev", curPage === 1, () => {
      curPage--;
      renderLogs();
    }),
  );
  for (
    let p = Math.max(1, curPage - 2);
    p <= Math.min(total, curPage + 2);
    p++
  ) {
    const b = mkPageBtn(
      p,
      false,
      (() => {
        const _p = p;
        return () => {
          curPage = _p;
          renderLogs();
        };
      })(),
    );
    if (p === curPage) b.classList.add("active");
    pgDiv.appendChild(b);
  }
  const info = document.createElement("span");
  info.className = "page-info";
  info.textContent = `${start + 1}–${Math.min(start + PAGE, vis.length)} of ${vis.length}`;
  pgDiv.appendChild(info);
  pgDiv.appendChild(
    mkPageBtn("Next →", curPage === total, () => {
      curPage++;
      renderLogs();
    }),
  );
}

function mkPageBtn(label, disabled, fn) {
  const b = document.createElement("button");
  b.className = "page-btn";
  b.textContent = label;
  b.disabled = disabled;
  b.onclick = fn;
  return b;
}

// ── Log entry helpers ──────────────────────────────────────
function getType(obj) {
  if (!obj) return "system";
  if (obj.event === "user" || obj.event === "request") return "user";
  if (obj.event === "bot" || obj.event === "success") return "bot";
  if (obj.event === "error") return "error";
  return "system";
}

function tryParse(str) {
  try {
    const p = JSON.parse(str);
    return typeof p === "object" && p ? p : null;
  } catch {
    return null;
  }
}

function makeEntry(obj, raw, idx) {
  const el = document.createElement("div");
  const type = getType(obj);
  el.className = `log-entry type-${type}`;
  el.id = "log-" + idx;

  const time = obj?.timestamp
    ? new Date(obj.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "--:--:--";
  const labels = {
    user: "👤 User",
    bot: "✦ Bot",
    error: "✗ Err",
    system: "⚙ Sys",
  };
  const cached = obj?.cache_read > 0;

  let summary = "";
  if (type === "user")
    summary = obj.user
      ? obj.user.slice(0, 80)
      : `${obj.messages || 0} messages`;
  if (type === "bot")
    summary = obj.char
      ? obj.char.slice(0, 80)
      : `${obj.total_tokens || 0} tokens`;
  if (type === "error")
    summary = obj.error?.message || String(obj.error || "Error");
  if (type === "system") summary = obj.message || raw;

  el.innerHTML = `
    <div class="log-header" onclick="toggleEntry('log-${idx}')">
      <span class="log-pill pill-${type}">${labels[type]}</span>
      <span class="log-time">${time}</span>
      <span class="log-summary">${esc(summary)}</span>
      ${cached ? '<span class="log-cached">✦ cached</span>' : ""}
      <span class="log-chevron">▶</span>
    </div>
    <div class="log-detail">${makeDetail(obj, type, idx)}</div>`;
  return el;
}

function makeDetail(obj, type, idx) {
  if (!obj) return "";
  if (type === "system")
    return `<div class="sys-msg">${esc(obj.message || "")}</div>`;

  const fields = [
    ["Model", obj.model?.replace("anthropic/", "").replace("openai/", "")],
    ["Prompt", obj.prompt_tokens],
    ["Completion", obj.completion_tokens],
    ["Total", obj.total_tokens],
    ["Cache", obj.cache_read],
    ["Msgs", obj.messages],
  ];
  const chips = fields
    .filter(([, v]) => v != null)
    .map(
      ([l, v]) =>
        `<div class="detail-chip"><div class="chip-label">${l}</div><div class="chip-value">${esc(String(v))}</div></div>`,
    )
    .join("");

  let msgs = "";
  if (obj.user) {
    const k = `u${idx}`;
    msgStore[k] = obj.user;
    msgs += `<div class="msg-block"><span class="msg-label user">👤 User</span><span class="msg-preview">${esc(obj.user.slice(0, 80))}${obj.user.length > 80 ? "…" : ""}</span><button class="msg-btn" onclick="openModal('👤 User Message','${k}')">View</button></div>`;
  }
  if (obj.char) {
    const k = `c${idx}`;
    msgStore[k] = obj.char;
    msgs += `<div class="msg-block"><span class="msg-label bot">✦ Char</span><span class="msg-preview">${esc(obj.char.slice(0, 80))}${obj.char.length > 80 ? "…" : ""}</span><button class="msg-btn" onclick="openModal('✦ Character Reply','${k}')">View</button></div>`;
  }
  return `<div class="detail-grid">${chips}</div>${msgs}`;
}

function toggleEntry(id) {
  document.getElementById(id)?.classList.toggle("expanded");
}

async function clearLogs() {
  if (!await showConfirm("Clear all logs?")) return;
  await fetch("/dashboard/logs", { method: "DELETE" });
  allLogs = [];
  renderLogs();
  fetchStats();
}

// ── Message modal ──────────────────────────────────────────
function openModal(title, key) {
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-text").textContent =
    msgStore[key] || "(no content)";
  document.getElementById("msg-modal").classList.add("open");
}

function closeModalDirect() {
  document.getElementById("msg-modal").classList.remove("open");
}

function closeModal(e) {
  if (e.target === document.getElementById("msg-modal")) closeModalDirect();
}
