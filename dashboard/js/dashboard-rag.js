// ============================================================
// dashboard-rag.js — RAG memory toggle, blind next turn,
// collections list, and config sliders.
// ============================================================

let _ragConfig = {};

const RAG_SLIDERS = [
  {
    key: "topK",
    label: "Top K",
    desc: "Max chunks to inject per request",
    min: 1,
    max: 15,
    step: 1,
    fmt: (v) => v,
  },
  {
    key: "queryDepth",
    label: "Query Depth",
    desc: "Recent user messages used as search query",
    min: 1,
    max: 10,
    step: 1,
    fmt: (v) => v,
  },
  {
    key: "scoreThreshold",
    label: "Score Threshold",
    desc: "Minimum similarity score (0–1)",
    min: 0,
    max: 1,
    step: 0.05,
    fmt: (v) => parseFloat(v).toFixed(2),
  },
  {
    key: "decayHalfLife",
    label: "Decay Half-Life",
    desc: "Messages until relevance halves",
    min: 5,
    max: 200,
    step: 5,
    fmt: (v) => v,
  },
  {
    key: "decayFloor",
    label: "Decay Floor",
    desc: "Minimum relevance after decay (0–1)",
    min: 0,
    max: 1,
    step: 0.05,
    fmt: (v) => parseFloat(v).toFixed(2),
  },
  {
    key: "emotionBoost",
    label: "Emotion Boost",
    desc: "Score boost for matching emotion (0–0.5)",
    min: 0,
    max: 0.5,
    step: 0.05,
    fmt: (v) => parseFloat(v).toFixed(2),
  },
  {
    key: "maxInjectionChars",
    label: "Max Injection Chars",
    desc: "Cap on injected context length",
    min: 500,
    max: 6000,
    step: 100,
    fmt: (v) => v,
  },
];

// ── Fetch status & render ──────────────────────────────────
async function fetchRagStatus() {
  try {
    const data = await fetch("/extensions/rag/status").then((r) => r.json());
    if (!data.ok) return;
    _ragConfig = data.config;
    const s = data.stats;
    const enabled = _ragConfig.enabled;

    const btn = document.getElementById("rag-toggle-btn");
    btn.textContent = enabled
      ? "✓ Enabled — Click to Disable"
      : "✗ Disabled — Click to Enable";
    btn.className = enabled ? "btn" : "btn danger";

    document.getElementById("rag-stat-char").textContent =
      s.lastInjectionChar !== "none" ? s.lastInjectionChar : "—";
    document.getElementById("rag-stat-chars").textContent =
      s.lastInjectionChars || "0";
    document.getElementById("rag-stat-msg").textContent =
      s.lastInjectionMsg || "—";
    document.getElementById("rag-stat-total").textContent =
      s.totalInjections || "0";
    document.getElementById("rag-stat-indexed").textContent =
      s.totalIndexed || "0";

    renderRagConfigSliders();
  } catch (e) {
    console.error("RAG status:", e);
  }
}

// ── Toggle enable ──────────────────────────────────────────
async function ragToggle() {
  try {
    const data = await fetch("/extensions/rag/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !_ragConfig.enabled }),
    }).then((r) => r.json());
    if (data.ok) {
      _ragConfig = data.config;
      fetchRagStatus();
    }
  } catch (e) {
    console.error("RAG toggle:", e);
  }
}

// ── Blind next turn ────────────────────────────────────────
async function ragBlindNext() {
  try {
    const data = await fetch("/extensions/rag/blind-next", {
      method: "POST",
    }).then((r) => r.json());
    if (data.ok) {
      const btn = document.getElementById("rag-blind-btn");
      const orig = {
        text: btn.textContent,
        bg: btn.style.background,
        border: btn.style.borderColor,
        color: btn.style.color,
      };
      btn.textContent = "✓ Next turn protected!";
      btn.style.background = "rgba(13,158,110,0.2)";
      btn.style.borderColor = "rgba(13,158,110,0.5)";
      btn.style.color = "#0a6a4a";
      setTimeout(() => {
        btn.textContent = orig.text;
        btn.style.background = orig.bg;
        btn.style.borderColor = orig.border;
        btn.style.color = orig.color;
      }, 3000);
    }
  } catch (e) {
    console.error("RAG blind next:", e);
  }
}

// ── Collections ────────────────────────────────────────────
async function fetchRagCollections() {
  const el = document.getElementById("rag-collections");
  try {
    const data = await fetch("/extensions/rag/collections").then((r) =>
      r.json(),
    );
    if (!data.ok || !data.collections.length) {
      el.innerHTML =
        '<div class="empty-state">No collections yet. Start a roleplay to create one.</div>';
      return;
    }
    el.innerHTML = data.collections
      .map(
        (c) =>
          `<div class="rx-script-card">
        <div class="rx-script-info">
          <div class="rx-script-name">🧠 ${esc(c.char)}</div>
          <div class="rx-script-meta">${c.chunks} chunk${c.chunks !== 1 ? "s" : ""} · <code>${esc(c.name)}</code></div>
        </div>
        <button class="btn danger" onclick="ragClearCollection('${esc(c.name)}')">✕ Clear</button>
      </div>`,
      )
      .join("");
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Failed to load collections.</div>';
  }
}

async function ragClearCollection(name) {
  if (!confirm(`Clear all memory for "${name}"? This cannot be undone.`))
    return;
  try {
    const data = await fetch(
      `/extensions/rag/collections/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    ).then((r) => r.json());
    if (data.ok) fetchRagCollections();
    else alert("Failed to clear: " + (data.error || "unknown error"));
  } catch (e) {
    console.error("RAG clear:", e);
  }
}

// ── Config sliders ─────────────────────────────────────────
function renderRagConfigSliders() {
  const wrap = document.getElementById("rag-config-sliders");
  wrap.innerHTML = "";
  for (const def of RAG_SLIDERS) {
    const val = _ragConfig[def.key] ?? def.min;
    const row = document.createElement("div");
    row.className = "rag-slider-row";
    row.innerHTML = `
      <div class="rag-slider-top">
        <div>
          <div class="rag-slider-name">${def.label}</div>
          <div class="rag-slider-desc">${def.desc}</div>
        </div>
      </div>
      <div class="rag-slider-inner">
        <input type="range" id="rag-sl-${def.key}" min="${def.min}" max="${def.max}" step="${def.step}" value="${val}" oninput="ragOnSlider('${def.key}')">
        <span class="rag-slider-val" id="rag-vl-${def.key}">${def.fmt(val)}</span>
      </div>`;
    wrap.appendChild(row);
  }
}

function ragOnSlider(key) {
  const def = RAG_SLIDERS.find((d) => d.key === key);
  const val = document.getElementById(`rag-sl-${key}`)?.value;
  if (def && val !== undefined)
    document.getElementById(`rag-vl-${key}`).textContent = def.fmt(val);
}

async function ragSaveConfig() {
  const payload = { ..._ragConfig };
  for (const def of RAG_SLIDERS) {
    const el = document.getElementById(`rag-sl-${def.key}`);
    if (el) payload[def.key] = parseFloat(el.value);
  }
  try {
    const data = await fetch("/extensions/rag/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json());
    if (data.ok) {
      _ragConfig = data.config;
      const s = document.getElementById("rag-save-status");
      s.style.opacity = "1";
      setTimeout(() => (s.style.opacity = "0"), 2000);
    }
  } catch (e) {
    console.error("RAG save:", e);
  }
}
