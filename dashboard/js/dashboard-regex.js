// ============================================================
// dashboard-regex.js — Regex script manager v2.0
// Supports: stopOnMatch, dryRun, tags, hit counters,
// group enable/disable, import/export, live test.
// ============================================================

let rxScripts = [], rxEditingId = null;

// ── Fetch & render ─────────────────────────────────────────
async function fetchRegexScripts() {
  try {
    const data = await fetch('/extensions/regex/scripts').then(r => r.json());
    rxScripts = data.scripts ?? [];
    renderRegexScripts();
  } catch {
    document.getElementById('regex-script-list').innerHTML =
      '<div class="empty-state">Failed to load scripts.</div>';
  }
}

function renderRegexScripts() {
  const el = document.getElementById('regex-script-list');

  // ── Group summary bar ──────────────────────────────────
  const allTags = [...new Set(rxScripts.flatMap(s => s.tags ?? []))];
  let groupBarHtml = '';
  if (allTags.length) {
    const tagPills = allTags.map(tag => {
      const safeTag = esc(tag);
      return `<span style="display:inline-flex;gap:4px;align-items:center;background:rgba(60,140,240,0.1);border:1px solid rgba(60,140,240,0.25);border-radius:99px;padding:2px 8px;">
        <span style="font-size:0.71rem;font-weight:800;color:#0d3a8a;">${safeTag}</span>
        <button class="btn" style="font-size:0.62rem;padding:1px 6px;" onclick="rxGroupToggle(${JSON.stringify(tag)}, true)">on</button>
        <button class="btn danger" style="font-size:0.62rem;padding:1px 6px;" onclick="rxGroupToggle(${JSON.stringify(tag)}, false)">off</button>
      </span>`;
    }).join('');
    groupBarHtml = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:0.8rem;align-items:center;">
      <span style="font-size:0.7rem;font-weight:800;color:#3a6a88;text-transform:uppercase;letter-spacing:0.7px;">Groups:</span>
      ${tagPills}
      <button class="btn" onclick="rxResetCounters()" style="font-size:0.7rem;margin-left:auto;">↺ Reset Counters</button>
    </div>`;
  }

  if (!rxScripts.length) {
    el.innerHTML = groupBarHtml + '<div class="empty-state" style="padding:2rem 1rem;">No scripts yet. Click <strong>+ New Script</strong> to add one.</div>';
    return;
  }

  el.innerHTML = groupBarHtml;

  rxScripts.forEach(s => {
    const card = document.createElement('div');
    card.className = 'rx-script-card' + (s.enabled ? '' : ' disabled');

    const hits     = s.hits ?? 0;
    const hitBadge = hits > 0
      ? `<span style="font-size:0.62rem;font-weight:800;color:#0a6a4a;background:rgba(13,158,110,0.12);border:1px solid rgba(13,158,110,0.3);border-radius:99px;padding:2px 7px;">↯ ${hits}</span>`
      : '';
    const stopBadge = s.stopOnMatch
      ? `<span style="font-size:0.62rem;font-weight:800;color:#7a4a00;background:rgba(255,160,0,0.12);border:1px solid rgba(255,160,0,0.3);border-radius:99px;padding:2px 7px;">⊠ stop</span>`
      : '';
    const dryBadge = s.dryRun
      ? `<span style="font-size:0.62rem;font-weight:800;color:#4a0a8a;background:rgba(140,100,240,0.12);border:1px solid rgba(140,100,240,0.3);border-radius:99px;padding:2px 7px;">◎ dry</span>`
      : '';
    const tagBadges = (s.tags ?? []).map(t =>
      `<span style="font-size:0.6rem;font-weight:700;color:#0d3a8a;background:rgba(60,140,240,0.1);border:1px solid rgba(60,140,240,0.22);border-radius:99px;padding:1px 6px;">${esc(t)}</span>`
    ).join('');

    const safeId = esc(s.id);

    card.innerHTML = `
      <button class="rx-toggle ${s.enabled ? 'on' : ''}" title="Toggle" onclick="rxToggle(${JSON.stringify(s.id)})"></button>
      <div class="rx-script-info">
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;margin-bottom:3px;">
          <span class="rx-script-name">${esc(s.description || 'Untitled')}</span>
          ${hitBadge}${stopBadge}${dryBadge}${tagBadges}
        </div>
        <div class="rx-script-meta">
          <code>/${esc(s.findRegex)}/${esc(s.flags)}</code> → <code>${esc(s.replaceString || '(empty)')}</code>
          ${s.trimStrings ? ' · trim' : ''}
        </div>
      </div>
      <button class="rx-edit-btn" onclick="openScriptModal(${JSON.stringify(s.id)})">✏ Edit</button>`;
    el.appendChild(card);
  });
}

// ── Toggle enable/disable ──────────────────────────────────
async function rxToggle(id) {
  const s = rxScripts.find(x => x.id === id);
  if (!s) return;
  await fetch(`/extensions/regex/scripts/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: !s.enabled }),
  });
  await fetchRegexScripts();
}

// ── Group toggle ───────────────────────────────────────────
async function rxGroupToggle(tag, enabled) {
  await fetch(`/extensions/regex/group/${encodeURIComponent(tag)}/${enabled ? 'enable' : 'disable'}`, {
    method: 'POST',
  });
  await fetchRegexScripts();
}

// ── Reset counters ─────────────────────────────────────────
async function rxResetCounters() {
  await fetch('/extensions/regex/counters/reset', { method: 'POST' });
  await fetchRegexScripts();
}

// ── Script editor modal ────────────────────────────────────
function openScriptModal(id) {
  rxEditingId = id;
  const s = id ? rxScripts.find(x => x.id === id) : null;
  document.getElementById('script-modal-title').textContent  = s ? 'Edit Script' : 'New Script';
  document.getElementById('sm-desc').value                   = s?.description   ?? '';
  document.getElementById('sm-find').value                   = s?.findRegex     ?? '';
  document.getElementById('sm-replace').value                = s?.replaceString ?? '';
  document.getElementById('sm-flags').value                  = s?.flags         ?? 'g';
  document.getElementById('sm-trim').checked                 = s?.trimStrings   ?? false;
  document.getElementById('sm-enabled').checked              = s?.enabled       ?? true;
  document.getElementById('sm-stop').checked                 = s?.stopOnMatch   ?? false;
  document.getElementById('sm-dryrun').checked               = s?.dryRun        ?? false;
  document.getElementById('sm-tags').value                   = (s?.tags ?? []).join(', ');
  document.getElementById('sm-error').style.display          = 'none';
  document.getElementById('sm-delete-btn').style.display     = s ? 'inline-flex' : 'none';
  document.getElementById('script-modal').classList.add('open');
}

function closeScriptModalDirect() {
  document.getElementById('script-modal').classList.remove('open');
}

function closeScriptModal(e) {
  if (e.target === document.getElementById('script-modal')) closeScriptModalDirect();
}

async function saveScriptModal() {
  const errEl = document.getElementById('sm-error');
  errEl.style.display = 'none';
  const findRegex = document.getElementById('sm-find').value.trim();
  if (!findRegex) { showSmError('Find (regex) is required.'); return; }
  try { new RegExp(findRegex, document.getElementById('sm-flags').value); }
  catch (e) { showSmError('Invalid regex: ' + e.message); return; }

  const tagsRaw = document.getElementById('sm-tags').value.trim();
  const tags    = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];

  const payload = {
    description:   document.getElementById('sm-desc').value.trim() || 'Untitled',
    findRegex,
    replaceString: document.getElementById('sm-replace').value,
    flags:         document.getElementById('sm-flags').value || 'g',
    trimStrings:   document.getElementById('sm-trim').checked,
    enabled:       document.getElementById('sm-enabled').checked,
    stopOnMatch:   document.getElementById('sm-stop').checked,
    dryRun:        document.getElementById('sm-dryrun').checked,
    tags,
  };

  try {
    if (rxEditingId) {
      await fetch(`/extensions/regex/scripts/${rxEditingId}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    } else {
      await fetch('/extensions/regex/scripts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
    }
    closeScriptModalDirect();
    await fetchRegexScripts();
  } catch (e) {
    showSmError('Save failed: ' + e.message);
  }
}

function showSmError(msg) {
  const el = document.getElementById('sm-error');
  el.textContent = msg;
  el.style.display = 'block';
}

async function deleteScriptFromModal() {
  if (!rxEditingId || !confirm('Delete this script?')) return;
  await fetch(`/extensions/regex/scripts/${rxEditingId}`, { method: 'DELETE' });
  closeScriptModalDirect();
  await fetchRegexScripts();
}

// ── Live test ──────────────────────────────────────────────
async function runTest() {
  const input = document.getElementById('test-input').value;
  if (!input) { document.getElementById('test-output').value = '⚠ Enter some input text first.'; return; }
  try {
    const data = await fetch('/extensions/regex/test-all', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    }).then(r => r.json());
    document.getElementById('test-output').value = data.ok
      ? `${data.output}\n\n— ${data.scriptsRun} script(s) matched`
      : 'Error: ' + data.error;
  } catch (e) {
    document.getElementById('test-output').value = 'Request failed: ' + e.message;
  }
}

// ── Import / Export ────────────────────────────────────────
async function regexImportHandle(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const arr = JSON.parse(await file.text());
    if (!Array.isArray(arr)) throw new Error('Expected a JSON array');
    await fetch('/extensions/regex/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(arr),
    });
    await fetchRegexScripts();
  } catch (e) {
    alert('Import failed: ' + e.message);
  }
  e.target.value = '';
}

function regexExport() {
  const a = document.createElement('a');
  a.href = '/extensions/regex/export';
  a.download = 'regex-scripts.json';
  a.click();
}