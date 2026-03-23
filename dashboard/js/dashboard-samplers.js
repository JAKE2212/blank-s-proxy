// ============================================================
// dashboard-samplers.js — Sampler sliders, model selector,
// and live token probability graph.
// ============================================================

let samplerDefs = {},
  samplerConfig = {};

// ── Fetch & render ─────────────────────────────────────────
async function fetchSamplers() {
  try {
    const model = document.getElementById("sampler-model").value;
    const data = await fetch(
      `/extensions/samplers/config?model=${encodeURIComponent(model)}`,
    ).then((r) => r.json());
    if (!data.ok) return;
    samplerDefs = data.defs;
    samplerConfig = data.config;
    renderSamplers();
    drawGraph();
  } catch (e) {
    console.error("Samplers:", e);
  }
}

function renderSamplers() {
  const wrap = document.getElementById("sampler-sliders");
  wrap.innerHTML = "";
  const keys = Object.keys(samplerDefs);
  if (!keys.length) {
    wrap.innerHTML =
      '<div class="empty-state" style="padding:0.8rem 0;">No samplers available for this model.</div>';
    return;
  }
  keys.forEach((key) => {
    const def = samplerDefs[key];
    const cfg = samplerConfig[key] || { enabled: false, value: def.default };
    const row = document.createElement("div");
    row.className = "sampler-row";
    row.innerHTML = `
      <div class="sampler-row-top">
        <div>
          <div class="sampler-name">${def.label}</div>
          <div class="sampler-desc">${def.description}</div>
        </div>
        <label class="sampler-enable">
          <input type="checkbox" id="en-${key}" ${cfg.enabled ? "checked" : ""} onchange="onSlider()">
          <span>Enable</span>
        </label>
      </div>
      <div class="sampler-slider-row">
        <input type="range" id="sl-${key}" min="${def.min}" max="${def.max}" step="${def.step}" value="${cfg.value}" oninput="onSlider()" style="opacity:${cfg.enabled ? 1 : 0.4}">
        <span class="sampler-val" id="vl-${key}">${cfg.value}</span>
      </div>`;
    wrap.appendChild(row);
  });
}

// ── Slider interaction ─────────────────────────────────────
function onSlider() {
  Object.keys(samplerDefs).forEach((key) => {
    const sl = document.getElementById(`sl-${key}`);
    const en = document.getElementById(`en-${key}`);
    const vl = document.getElementById(`vl-${key}`);
    if (!sl || !en || !vl) return;
    vl.textContent = sl.value;
    sl.style.opacity = en.checked ? "1" : "0.4";
  });
  drawGraph();
}

// ── Save ───────────────────────────────────────────────────
async function saveSamplers() {
  const payload = {};
  Object.keys(samplerDefs).forEach((key) => {
    const sl = document.getElementById(`sl-${key}`);
    const en = document.getElementById(`en-${key}`);
    if (sl && en)
      payload[key] = { enabled: en.checked, value: parseFloat(sl.value) };
  });
  try {
    const data = await fetch("/extensions/samplers/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).then((r) => r.json());
    if (data.ok) {
      samplerConfig = data.config;
      const s = document.getElementById("save-status");
      s.style.opacity = "1";
      setTimeout(() => (s.style.opacity = "0"), 2000);
    }
  } catch (e) {
    console.error("Save samplers:", e);
  }
}

// ── Probability graph ──────────────────────────────────────
function drawGraph() {
  const canvas = document.getElementById("sampler-graph");
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1,
    W = canvas.offsetWidth,
    H = 110;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const N = 200;
  const probs = Array.from({ length: N }, (_, i) => Math.exp(-i * 0.04));
  const sum = probs.reduce((a, b) => a + b, 0);
  const norm = probs.map((p) => p / sum);

  const topKOn = isEn("top_k"),
    topPOn = isEn("top_p");
  const kLimit = topKOn ? Math.min(Math.round(getSl("top_k", 200)), N) : N;
  let pLimit = N;
  if (topPOn) {
    let cs = 0;
    for (let i = 0; i < N; i++) {
      cs += norm[i];
      if (cs >= getSl("top_p", 1)) {
        pLimit = i + 1;
        break;
      }
    }
  }

  const limit = Math.min(kLimit, pLimit);
  const bw = W / N,
    maxP = norm[0];

  for (let i = 0; i < N; i++) {
    const bh = (norm[i] / maxP) * (H - 18),
      x = i * bw,
      y = H - bh - 4;
    if (i < limit) {
      const g = ctx.createLinearGradient(x, y, x, H);
      g.addColorStop(0, "rgba(26,111,168,0.88)");
      g.addColorStop(1, "rgba(13,158,138,0.38)");
      ctx.fillStyle = g;
    } else {
      ctx.fillStyle = "rgba(180,210,230,0.28)";
    }
    ctx.beginPath();
    ctx.roundRect(x + 0.5, y, Math.max(bw - 1, 1), bh, 1);
    ctx.fill();
  }

  if (limit < N) {
    ctx.beginPath();
    ctx.moveTo(limit * bw, 0);
    ctx.lineTo(limit * bw, H - 4);
    ctx.strokeStyle = "rgba(220,60,60,0.55)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const filters =
    [topKOn ? "Top K" : "", topPOn ? "Top P" : ""].filter(Boolean).join(", ") ||
    "none";
  document.getElementById("sampler-graph-label").textContent =
    `${limit} of ${N} tokens kept (${((limit / N) * 100).toFixed(0)}%) · filters: ${filters}`;
}

// ── Helpers ────────────────────────────────────────────────
function getSl(key, fb) {
  const el = document.getElementById(`sl-${key}`);
  return el ? parseFloat(el.value) : fb;
}

function isEn(key) {
  const el = document.getElementById(`en-${key}`);
  return el ? el.checked : false;
}
