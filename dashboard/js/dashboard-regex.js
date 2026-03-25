// ============================================================
// dashboard-regex.js — Regex script manager, import/export,
// script editor modal, and live test panel.
// ============================================================

let rxScripts = [],
  rxEditingId = null;

// ── Fetch & render ─────────────────────────────────────────
async function fetchRegexScripts() {
  try {
    const data = await fetch("/extensions/regex/scripts").then((r) => r.json());
    rxScripts = data.scripts ?? [];
    renderRegexScripts();
  } catch {
    document.getElementById("regex-script-list").innerHTML =
      '<div class="empty-state">Failed to load scripts.</div>';
  }
}

function renderRegexScripts() {
  const el = document.getElementById("regex-script-list");
  if (!rxScripts.length) {
    el.innerHTML =
      '<div class="empty-state" style="padding:2rem 1rem;">No scripts yet. Click <strong>+ New Script</strong> to add one.</div>';
    return;
  }
  el.innerHTML = "";
  rxScripts.forEach((s) => {
    const card = document.createElement("div");
    card.className = "rx-script-card" + (s.enabled ? "" : " disabled");
    card.innerHTML = `
      <button class="rx-toggle ${s.enabled ? "on" : ""}" title="Toggle" onclick="rxToggle('${s.id}')"></button>
      <div class="rx-script-info">
        <div class="rx-script-name">${esc(s.description || "Untitled")}</div>
        <div class="rx-script-meta">
          <code>/${esc(s.findRegex)}/${esc(s.flags)}</code> → <code>${esc(s.replaceString || "(empty)")}</code>
          ${s.trimStrings ? " · trim" : ""}
        </div>
      </div>
      <button class="rx-edit-btn" onclick="openScriptModal('${s.id}')">✏ Edit</button>`;
    el.appendChild(card);
  });
}

// ── Toggle enable/disable ──────────────────────────────────
async function rxToggle(id) {
  const s = rxScripts.find((x) => x.id === id);
  if (!s) return;
  await fetch(`/extensions/regex/scripts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: !s.enabled }),
  });
  await fetchRegexScripts();
}

// ── Script editor modal ────────────────────────────────────
function openScriptModal(id) {
  rxEditingId = id;
  const s = id ? rxScripts.find((x) => x.id === id) : null;
  document.getElementById("script-modal-title").textContent = s
    ? "Edit Script"
    : "New Script";
  document.getElementById("sm-desc").value = s?.description ?? "";
  document.getElementById("sm-find").value = s?.findRegex ?? "";
  document.getElementById("sm-replace").value = s?.replaceString ?? "";
  document.getElementById("sm-flags").value = s?.flags ?? "g";
  document.getElementById("sm-trim").checked = s?.trimStrings ?? false;
  document.getElementById("sm-enabled").checked = s?.enabled ?? true;
  document.getElementById("sm-error").style.display = "none";
  document.getElementById("sm-delete-btn").style.display = s
    ? "inline-flex"
    : "none";
  document.getElementById("script-modal").classList.add("open");
}

function closeScriptModalDirect() {
  document.getElementById("script-modal").classList.remove("open");
}

function closeScriptModal(e) {
  if (e.target === document.getElementById("script-modal"))
    closeScriptModalDirect();
}

async function saveScriptModal() {
  const errEl = document.getElementById("sm-error");
  errEl.style.display = "none";
  const findRegex = document.getElementById("sm-find").value.trim();
  if (!findRegex) {
    showSmError("Find (regex) is required.");
    return;
  }
  try {
    new RegExp(findRegex, document.getElementById("sm-flags").value);
  } catch (e) {
    showSmError("Invalid regex: " + e.message);
    return;
  }

  const payload = {
    description: document.getElementById("sm-desc").value.trim() || "Untitled",
    findRegex,
    replaceString: document.getElementById("sm-replace").value,
    flags: document.getElementById("sm-flags").value || "g",
    trimStrings: document.getElementById("sm-trim").checked,
    enabled: document.getElementById("sm-enabled").checked,
  };

  try {
    if (rxEditingId) {
      await fetch(`/extensions/regex/scripts/${rxEditingId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await fetch("/extensions/regex/scripts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    closeScriptModalDirect();
    await fetchRegexScripts();
  } catch (e) {
    showSmError("Save failed: " + e.message);
  }
}

function showSmError(msg) {
  const el = document.getElementById("sm-error");
  el.textContent = msg;
  el.style.display = "block";
}

async function deleteScriptFromModal() {
  if (!rxEditingId || !confirm("Delete this script?")) return;
  await fetch(`/extensions/regex/scripts/${rxEditingId}`, { method: "DELETE" });
  closeScriptModalDirect();
  await fetchRegexScripts();
}

// ── Live test ──────────────────────────────────────────────
async function runTest() {
  const input = document.getElementById("test-input").value;
  if (!input) {
    document.getElementById("test-output").value =
      "⚠ Enter some input text first.";
    return;
  }
  try {
    const data = await fetch("/extensions/regex/test-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    }).then((r) => r.json());
    document.getElementById("test-output").value = data.ok
      ? data.output
      : "Error: " + data.error;
  } catch (e) {
    document.getElementById("test-output").value =
      "Request failed: " + e.message;
  }
}

// ── Import / Export ────────────────────────────────────────
async function regexImportHandle(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const arr = JSON.parse(await file.text());
    if (!Array.isArray(arr)) throw new Error("Expected a JSON array");
    await fetch("/extensions/regex/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(arr),
    });
    await fetchRegexScripts();
  } catch (e) {
    alert("Import failed: " + e.message);
  }
  e.target.value = "";
}

function regexExport() {
  const a = document.createElement("a");
  a.href = "/extensions/regex/export";
  a.download = "regex-scripts.json";
  a.click();
}