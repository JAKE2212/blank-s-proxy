// ============================================================
// dashboard-core.js — Bubble background, clock, tab switching,
// shared helpers, and page init.
// Must be loaded FIRST before all other dashboard JS files.
// ============================================================

// ── Bubble background ──────────────────────────────────────
(function () {
  const canvas = document.getElementById('bg-canvas');
  const ctx = canvas.getContext('2d');
  let W, H, bubbles = [];

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
  }

  function spawn() {
    const r = 18 + Math.random() * 55;
    bubbles.push({
      x: Math.random() * W, y: H + r, r,
      speed: 0.22 + Math.random() * 0.42,
      drift: (Math.random() - 0.5) * 0.32,
      alpha: 0.1 + Math.random() * 0.2,
      wobble: Math.random() * Math.PI * 2,
      ws: 0.018 + Math.random() * 0.018,
    });
  }

  function draw(b) {
    const g = ctx.createRadialGradient(b.x - b.r * .3, b.y - b.r * .3, b.r * .05, b.x, b.y, b.r);
    g.addColorStop(0,    `rgba(255,255,255,${b.alpha * 2.2})`);
    g.addColorStop(0.35, `rgba(210,240,255,${b.alpha * .9})`);
    g.addColorStop(0.75, `rgba(150,210,240,${b.alpha * .3})`);
    g.addColorStop(1,    'rgba(100,180,220,0)');
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,255,255,${b.alpha * 1.7})`; ctx.lineWidth = 1.1; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(b.x - b.r * .28, b.y - b.r * .3, b.r * .27, b.r * .13, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255,255,255,${b.alpha * 2.4})`; ctx.fill();
  }

  function animate() {
    ctx.clearRect(0, 0, W, H);
    bubbles.forEach(b => {
      b.wobble += b.ws;
      b.y -= b.speed;
      b.x += b.drift + Math.sin(b.wobble) * .28;
      draw(b);
    });
    bubbles = bubbles.filter(b => b.y + b.r > 0);
    if (Math.random() < 0.016) spawn();
    requestAnimationFrame(animate);
  }

  resize();
  window.addEventListener('resize', resize);
  for (let i = 0; i < 10; i++) { spawn(); bubbles[i].y = Math.random() * H; }
  animate();
})();

// ── Clock ──────────────────────────────────────────────────
function updateClock() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: '2-digit', hour12: true,
    weekday: 'short', month: 'short', day: 'numeric',
  }).formatToParts(now);
  const get = t => parts.find(p => p.type === t)?.value || '';
  document.getElementById('clock-text').textContent =
    `${get('hour')}:${get('minute')} ${get('dayPeriod')} · ${get('weekday')} ${get('month')} ${get('day')}`;
}
updateClock();
setInterval(updateClock, 1000);

// ── Tab switching ──────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  if (name === 'logs')     fetchLogs();
  if (name === 'overview') { fetchStats(); fetchHealth(); }
  if (name === 'settings') {
    fetchSamplers();
    fetchRegexScripts();
    fetchRagStatus();
    fetchRagCollections();
    fetchTvStatus();
    fetchTvTrees();
  }
}

// ── Confirm modal (replaces browser confirm()) ─────────────
function showConfirm(message) {
  return new Promise(resolve => {
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-modal').classList.add('open');
    const ok     = document.getElementById('confirm-ok');
    const cancel = document.getElementById('confirm-cancel');
    function cleanup(result) {
      document.getElementById('confirm-modal').classList.remove('open');
      ok.replaceWith(ok.cloneNode(true));
      cancel.replaceWith(cancel.cloneNode(true));
      resolve(result);
    }
    document.getElementById('confirm-ok').onclick     = () => cleanup(true);
    document.getElementById('confirm-cancel').onclick = () => cleanup(false);
  });
}

// ── Proxy restart ──────────────────────────────────────────
async function restartProxy() {
  if (!await showConfirm('Restart the proxy?')) return;
  await fetch('/dashboard/restart', { method: 'POST' });
  document.getElementById('status-text').textContent = 'Restarting…';
  setTimeout(checkStatus, 2500);
}

async function checkStatus() {
  try {
    const d = await fetch('/').then(r => r.json());
    if (d.ok) document.getElementById('status-text').textContent = 'Online';
  } catch {
    setTimeout(checkStatus, 2000);
  }
}

// ── Shared helper ──────────────────────────────────────────
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Page init ──────────────────────────────────────────────
fetchStats();
fetchHealth();
setInterval(fetchStats, 30000);
setInterval(fetchHealth, 10000);