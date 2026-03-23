// ============================================================
// dashboard-tunnelvision.js — TunnelVision lorebook status,
// tree list, tree editor, and all TV modals.
// ============================================================

let _tvEditorName = null;
let _tvEditorNodeId = null;

// ── Status ─────────────────────────────────────────────────
async function fetchTvStatus() {
  try {
    const data = await fetch("/extensions/tunnelvision/status").then((r) =>
      r.json(),
    );
    if (!data.ok) return;

    document.getElementById("tv-stat-active").textContent =
      data.activeName ?? "—";
    document.getElementById("tv-stat-nodes").textContent =
      data.nodeCount ?? "—";
    document.getElementById("tv-stat-entries").textContent = data.treeExists
      ? (data.entryCount ?? "—")
      : "—";
    document.getElementById("tv-stat-trees").textContent =
      data.trees?.length ?? "—";
    document.getElementById("tv-active-tree-input").placeholder =
      data.activeName ? `auto: ${data.activeName}` : "auto-detect";

    // Mandatory tools button
    const mandatory = data.config?.mandatoryTools ?? false;
    const mandatoryBtn = document.getElementById("tv-mandatory-btn");
    mandatoryBtn.textContent = mandatory
      ? "✓ Mandatory — Click to Disable"
      : "✗ Off — Click to Enable";
    mandatoryBtn.className = mandatory ? "btn success" : "btn";

    // Auto-summary button
    const autoSummary = data.config?.autoSummary ?? false;
    const autoBtn = document.getElementById("tv-autosummary-btn");
    autoBtn.textContent = autoSummary
      ? "✓ Enabled — Click to Disable"
      : "✗ Off — Click to Enable";
    autoBtn.className = autoSummary ? "btn success" : "btn";
    document.getElementById("tv-autosummary-options").style.display =
      autoSummary ? "block" : "none";

    const interval = data.config?.autoSummaryInterval ?? 20;
    document.getElementById("tv-summary-interval").value = interval;
    document.getElementById("tv-summary-interval-val").textContent = interval;
  } catch (e) {
    console.error("TV status:", e);
  }
}

// ── Mandatory tools toggle ─────────────────────────────────
async function tvToggleMandatory() {
  try {
    const data = await fetch("/extensions/tunnelvision/status").then((r) =>
      r.json(),
    );
    const current = data.config?.mandatoryTools ?? false;
    await fetch("/extensions/tunnelvision/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mandatoryTools: !current }),
    });
    fetchTvStatus();
  } catch (e) {
    console.error("TV mandatory toggle:", e);
  }
}

// ── Auto-summary toggle & save ─────────────────────────────
async function tvToggleAutoSummary() {
  try {
    const data = await fetch("/extensions/tunnelvision/status").then((r) =>
      r.json(),
    );
    const current = data.config?.autoSummary ?? false;
    await fetch("/extensions/tunnelvision/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoSummary: !current }),
    });
    fetchTvStatus();
  } catch (e) {
    console.error("TV auto-summary toggle:", e);
  }
}

async function tvSaveAutoSummary() {
  try {
    const interval = parseInt(
      document.getElementById("tv-summary-interval").value,
      10,
    );
    await fetch("/extensions/tunnelvision/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ autoSummaryInterval: interval }),
    });
    fetchTvStatus();
  } catch (e) {
    console.error("TV save auto-summary:", e);
  }
}

// ── Active tree override ───────────────────────────────────
async function tvSetActiveTree() {
  const name = document.getElementById("tv-active-tree-input").value.trim();
  try {
    await fetch("/extensions/tunnelvision/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeTree: name || null }),
    });
    fetchTvStatus();
  } catch (e) {
    console.error("TV set active:", e);
  }
}

async function tvClearActiveTree() {
  document.getElementById("tv-active-tree-input").value = "";
  try {
    await fetch("/extensions/tunnelvision/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ activeTree: null }),
    });
    fetchTvStatus();
  } catch (e) {
    console.error("TV clear active:", e);
  }
}

// ── Trees list ─────────────────────────────────────────────
async function fetchTvTrees() {
  const el = document.getElementById("tv-trees-list");
  try {
    const data = await fetch("/extensions/tunnelvision/trees").then((r) =>
      r.json(),
    );
    if (!data.ok || !data.trees.length) {
      el.innerHTML =
        '<div class="empty-state">No trees yet. Start a roleplay and TunnelVision will auto-create one.</div>';
      return;
    }
    el.innerHTML = "";
    for (const t of data.trees) {
      const card = document.createElement("div");
      card.className = "tv-tree-card";
      card.innerHTML = `
        <div class="tv-tree-header">
          <span class="tv-tree-name">📺 ${esc(t.name)}</span>
        </div>
        <div class="tv-tree-meta">
          <span>🗂 ${t.nodeCount} nodes</span>
          <span>📝 ${t.entryCount} entries</span>
          <span>🕐 ${t.updatedAt ? new Date(t.updatedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—"}</span>
        </div>
        <div style="display:flex;gap:8px;margin-top:0.75rem;flex-wrap:wrap;">
          <button class="btn primary" onclick="openTvEditor('${esc(t.name)}')" style="font-size:0.76rem;">✏ Edit Tree</button>
          <button class="btn danger"  onclick="tvDeleteTree('${esc(t.name)}')" style="font-size:0.76rem;">✕ Delete</button>
        </div>`;
      el.appendChild(card);
    }
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Failed to load trees.</div>';
  }
}

// ── Tree editor ────────────────────────────────────────────
async function openTvEditor(name) {
  _tvEditorName = name;
  document.getElementById("tv-editor-name").textContent = name;
  document.getElementById("tv-editor-card").style.display = "block";
  document
    .getElementById("tv-editor-card")
    .scrollIntoView({ behavior: "smooth", block: "start" });
  await fetchTvTree(name);
}

async function fetchTvTree(name) {
  const el = document.getElementById("tv-tree-nodes");
  try {
    const data = await fetch(
      `/extensions/tunnelvision/tree/${encodeURIComponent(name)}`,
    ).then((r) => r.json());
    if (!data.ok) {
      el.innerHTML = '<div class="empty-state">Failed to load tree.</div>';
      return;
    }
    renderTvTree(data.tree);
  } catch (e) {
    el.innerHTML = '<div class="empty-state">Failed to load tree.</div>';
  }
}

function renderTvTree(tree) {
  const el = document.getElementById("tv-tree-nodes");
  el.innerHTML = "";
  if (!tree?.nodes) {
    el.innerHTML = '<div class="empty-state">Empty tree.</div>';
    return;
  }

  const root = tree.nodes[tree.rootId];
  if (!root) return;

  function renderNode(nodeId, depth) {
    const node = tree.nodes[nodeId];
    if (!node) return;

    const row = document.createElement("div");
    row.className = "tv-node-row";
    row.style.marginLeft = depth > 0 ? `${depth * 16}px` : "0";

    const entries = node.entries || [];
    const enabledEntries = entries.filter((e) => e.enabled !== false);
    const childCount = node.children.length;
    const totalItems = enabledEntries.length + childCount;
    const icon = node.isArc
      ? "🎬"
      : nodeId === tree.summariesId
        ? "📋"
        : nodeId === tree.rootId
          ? "🌳"
          : "📺";

    row.innerHTML = `
      <div class="tv-node-header" onclick="this.closest('.tv-node-row').classList.toggle('expanded')">
        <span class="tv-node-icon">${icon}</span>
        <span class="tv-node-label">${esc(node.label)}</span>
        ${totalItems > 0 ? `<span class="tv-node-count">${enabledEntries.length} entries${childCount > 0 ? ` · ${childCount} sub` : ""}</span>` : ""}
        <span class="tv-node-toggle">▶</span>
      </div>
      ${node.summary ? `<div class="tv-summary">${esc(node.summary)}</div>` : ""}
      <div class="tv-node-entries">
        <div style="display:flex;gap:6px;margin-bottom:0.6rem;flex-wrap:wrap;">
          <button class="btn primary" style="font-size:0.7rem;padding:3px 10px;"
            onclick="openTvEntryModal('${esc(tree.charName)}','${esc(nodeId)}')">+ Add Entry</button>
        </div>
        <div id="tv-entries-${esc(nodeId)}">${renderEntries(enabledEntries)}</div>
      </div>`;

    el.appendChild(row);
    for (const cid of node.children) renderNode(cid, depth + 1);
  }

  const rootEntries = (root.entries || []).filter((e) => e.enabled !== false);
  if (rootEntries.length > 0) renderNode(tree.rootId, 0);
  for (const cid of root.children) renderNode(cid, 0);
}

function renderEntries(entries) {
  if (!entries.length)
    return '<div style="font-size:0.72rem;color:#8aaaaa;padding:4px 0;">No entries yet.</div>';
  return entries
    .map(
      (e) => `
    <div class="tv-entry-row ${e.enabled === false ? "tv-entry-disabled" : ""}">
      <span class="tv-entry-uid">#${e.uid}</span>
      <div class="tv-entry-info">
        <div class="tv-entry-title">${esc(e.title)}</div>
        <div class="tv-entry-content">${esc(e.content.slice(0, 200))}${e.content.length > 200 ? "…" : ""}</div>
        ${e.keys?.length ? `<div class="tv-entry-keys">${e.keys.map((k) => `<span class="tv-entry-key">${esc(k)}</span>`).join("")}</div>` : ""}
      </div>
    </div>`,
    )
    .join("");
}

// ── Delete tree ────────────────────────────────────────────
async function tvDeleteTree(name) {
  if (!confirm(`Delete tree "${name}"? This cannot be undone.`)) return;
  try {
    await fetch(`/extensions/tunnelvision/tree/${encodeURIComponent(name)}`, {
      method: "DELETE",
    });
    if (_tvEditorName === name) {
      _tvEditorName = null;
      document.getElementById("tv-editor-card").style.display = "none";
    }
    fetchTvStatus();
    fetchTvTrees();
  } catch (e) {
    console.error("TV delete:", e);
  }
}

// ── Add Channel modal ──────────────────────────────────────
function openTvNodeModal() {
  document.getElementById("tv-nm-label").value = "";
  document.getElementById("tv-nm-summary").value = "";
  document.getElementById("tv-nm-error").style.display = "none";
  document.getElementById("tv-node-modal").classList.add("open");
}
function closeTvNodeModalDirect() {
  document.getElementById("tv-node-modal").classList.remove("open");
}
function closeTvNodeModal(e) {
  if (e.target === document.getElementById("tv-node-modal"))
    closeTvNodeModalDirect();
}

async function saveTvNode() {
  const label = document.getElementById("tv-nm-label").value.trim();
  const summary = document.getElementById("tv-nm-summary").value.trim();
  const errEl = document.getElementById("tv-nm-error");
  if (!label) {
    errEl.textContent = "Channel name is required.";
    errEl.style.display = "block";
    return;
  }
  if (!_tvEditorName) {
    errEl.textContent = "No tree selected.";
    errEl.style.display = "block";
    return;
  }
  try {
    const data = await fetch(
      `/extensions/tunnelvision/tree/${encodeURIComponent(_tvEditorName)}/node`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, summary }),
      },
    ).then((r) => r.json());
    if (!data.ok) {
      errEl.textContent = data.error || "Failed.";
      errEl.style.display = "block";
      return;
    }
    closeTvNodeModalDirect();
    fetchTvTree(_tvEditorName);
    fetchTvStatus();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = "block";
  }
}

// ── Add Entry modal ────────────────────────────────────────
function openTvEntryModal(charName, nodeId) {
  _tvEditorName = charName;
  _tvEditorNodeId = nodeId;
  document.getElementById("tv-entry-modal-title").textContent = "Add Entry";
  document.getElementById("tv-em-title").value = "";
  document.getElementById("tv-em-content").value = "";
  document.getElementById("tv-em-keys").value = "";
  document.getElementById("tv-em-error").style.display = "none";
  document.getElementById("tv-entry-modal").classList.add("open");
}
function closeTvEntryModalDirect() {
  document.getElementById("tv-entry-modal").classList.remove("open");
}
function closeTvEntryModal(e) {
  if (e.target === document.getElementById("tv-entry-modal"))
    closeTvEntryModalDirect();
}

async function saveTvEntry() {
  const title = document.getElementById("tv-em-title").value.trim();
  const content = document.getElementById("tv-em-content").value.trim();
  const keys = document
    .getElementById("tv-em-keys")
    .value.split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const errEl = document.getElementById("tv-em-error");
  if (!title) {
    errEl.textContent = "Title is required.";
    errEl.style.display = "block";
    return;
  }
  if (!content) {
    errEl.textContent = "Content is required.";
    errEl.style.display = "block";
    return;
  }
  try {
    const data = await fetch(
      `/extensions/tunnelvision/tree/${encodeURIComponent(_tvEditorName)}/node/${encodeURIComponent(_tvEditorNodeId)}/entry`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, keys }),
      },
    ).then((r) => r.json());
    if (!data.ok) {
      errEl.textContent = data.error || "Failed.";
      errEl.style.display = "block";
      return;
    }
    closeTvEntryModalDirect();
    fetchTvTree(_tvEditorName);
    fetchTvStatus();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = "block";
  }
}
