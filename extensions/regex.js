"use strict";
// ============================================================
// extensions/regex.js — SillyTavern-compatible regex processor
// Runs an ordered list of find/replace rules against every AI
// reply. Each script tests itself before applying — if no
// match, it's skipped entirely (Option B single-pass).
//
// New in v2.0:
//   - In-memory script cache with dirty flag (no disk read per response)
//   - Pure transformResponse (no in-place mutation)
//   - stopOnMatch flag — stops the chain when a script fires
//   - Script groups/tags for bulk enable/disable
//   - Named capture group support ($<name> in replaceString)
//   - dryRun flag per script — logs match without applying
//   - Per-script hit counters (in-memory, dashboard visible)
//   - Better error logging (which script failed + why)
//   - resetCounters API endpoint
// ============================================================

const express = require("express");
const fs      = require("fs");
const path    = require("path");

const router    = express.Router();
const DATA_FILE = path.join(__dirname, "../data/regex-scripts.json");

// ── In-memory cache ────────────────────────────────────────
let _cache      = null;   // loaded scripts array
let _dirty      = true;   // true = reload from disk on next access
let _counters   = {};     // { [scriptId]: number } — hit counts this session

function invalidateCache() { _dirty = true; }

function loadScripts() {
  if (!_dirty && _cache !== null) return _cache;
  if (!fs.existsSync(DATA_FILE)) { _cache = []; _dirty = false; return _cache; }
  try {
    _cache = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    _dirty = false;
    return _cache;
  } catch (e) {
    console.warn("[regex] Failed to load scripts:", e.message);
    return _cache ?? [];
  }
}

function saveScripts(scripts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(scripts, null, 2));
  _cache = scripts;
  _dirty = false;
}

// ── Regex parsing ──────────────────────────────────────────
// Supports both plain patterns and /pattern/flags format.
function parseRegex(findRegex, fallbackFlags) {
  const m = findRegex.match(/^\/(.+)\/([gimsuy]*)$/s);
  if (m) return { pattern: m[1], flags: m[2] || fallbackFlags || "g" };
  return { pattern: findRegex, flags: fallbackFlags || "g" };
}

// ── Named capture group support ────────────────────────────
// Converts $<name> syntax to the JS-native $<name> (already supported
// in modern Node) but also handles {{match}} → $& for ST compatibility.
function normalizeReplacement(replaceString) {
  return (replaceString ?? "").replace(/\{\{match\}\}/g, "$&");
}

// ── Single script application (test-then-apply) ────────────
// Returns { text, fired } where fired = true if the script matched.
function applyScript(text, script) {
  if (!script.enabled || !script.findRegex) return { text, fired: false };

  const { pattern, flags } = parseRegex(script.findRegex, script.flags);
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch (e) {
    console.warn(
      `[regex] Script "${script.description ?? script.id}" has invalid regex: ${e.message}`,
    );
    return { text, fired: false };
  }

  // ── Test before applying (Option B) ───────────────────
  if (!re.test(text)) return { text, fired: false };

  // Reset lastIndex after test (stateful regex with /g)
  re.lastIndex = 0;

  if (script.dryRun) {
    const matches = [...text.matchAll(new RegExp(pattern, flags.includes("g") ? flags : flags + "g"))];
    console.log(
      `[regex] DRY RUN "${script.description ?? script.id}" — would match ${matches.length} time(s):`,
      matches.map(m => JSON.stringify(m[0])).join(", "),
    );
    return { text, fired: true }; // fired = true (matched) but text unchanged
  }

  const replacement = normalizeReplacement(script.replaceString);
  let result = text.replace(re, replacement);
  if (script.trimStrings) result = result.trim();

  return { text: result, fired: true };
}

// ── Group enable/disable helper ────────────────────────────
// Returns scripts with enabled toggled for all matching the group tag.
function setGroupEnabled(scripts, group, enabled) {
  return scripts.map(s =>
    (s.tags ?? []).includes(group) ? { ...s, enabled } : s,
  );
}

// ── transformResponse ──────────────────────────────────────
function transformResponse(responseBody) {
  const scripts = loadScripts().filter(s => s.enabled);
  if (!scripts.length) return responseBody;

  // Extract text (pure — don't mutate original)
  const text =
    responseBody?.choices?.[0]?.message?.content ??
    responseBody?.content?.[0]?.text ??
    null;
  if (typeof text !== "string") return responseBody;

  let current  = text;
  let anyFired = false;

  for (const script of scripts) {
    const { text: next, fired } = applyScript(current, script);

    if (fired) {
      // Increment hit counter
      _counters[script.id] = (_counters[script.id] ?? 0) + 1;
      anyFired = true;

      if (!script.dryRun) {
        console.log(`[regex] Script "${script.description ?? script.id}" fired (hit #${_counters[script.id]})`);
        current = next;
      }

      // Stop chain if requested
      if (script.stopOnMatch) {
        console.log(`[regex] stopOnMatch — chain stopped at "${script.description ?? script.id}"`);
        break;
      }
    }
  }

  if (!anyFired) return responseBody;

  // Return a new object — never mutate the original
  if (responseBody?.choices?.[0]?.message?.content !== undefined) {
    return {
      ...responseBody,
      choices: responseBody.choices.map((c, i) =>
        i === 0
          ? { ...c, message: { ...c.message, content: current } }
          : c,
      ),
    };
  }
  if (responseBody?.content?.[0]?.text !== undefined) {
    return {
      ...responseBody,
      content: responseBody.content.map((b, i) =>
        i === 0 ? { ...b, text: current } : b,
      ),
    };
  }
  return responseBody;
}

// ── Routes ─────────────────────────────────────────────────

// GET /extensions/regex/scripts
router.get("/scripts", (req, res) => {
  const scripts = loadScripts();
  // Attach live hit counts
  const withCounts = scripts.map(s => ({
    ...s,
    hits: _counters[s.id] ?? 0,
  }));
  res.json({ ok: true, scripts: withCounts });
});

// POST /extensions/regex/scripts
router.post("/scripts", (req, res) => {
  const scripts = loadScripts();
  const script = {
    id:            Date.now().toString(),
    description:   req.body.description   ?? "Untitled",
    findRegex:     req.body.findRegex     ?? "",
    replaceString: req.body.replaceString ?? "",
    flags:         req.body.flags         ?? "g",
    trimStrings:   req.body.trimStrings   ?? false,
    enabled:       req.body.enabled       ?? true,
    stopOnMatch:   req.body.stopOnMatch   ?? false,
    dryRun:        req.body.dryRun        ?? false,
    tags:          req.body.tags          ?? [],
  };
  scripts.push(script);
  saveScripts(scripts);
  res.status(201).json({ ok: true, script });
});

// PUT /extensions/regex/scripts/:id
router.put("/scripts/:id", (req, res) => {
  const scripts = loadScripts();
  const idx = scripts.findIndex(s => s.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Not found" });
  scripts[idx] = { ...scripts[idx], ...req.body, id: scripts[idx].id };
  saveScripts(scripts);
  res.json({ ok: true, script: scripts[idx] });
});

// DELETE /extensions/regex/scripts/:id
router.delete("/scripts/:id", (req, res) => {
  let scripts = loadScripts();
  const before = scripts.length;
  scripts = scripts.filter(s => s.id !== req.params.id);
  if (scripts.length === before)
    return res.status(404).json({ ok: false, error: "Not found" });
  delete _counters[req.params.id];
  saveScripts(scripts);
  res.json({ ok: true });
});

// POST /extensions/regex/reorder
router.post("/reorder", (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids))
    return res.status(400).json({ ok: false, error: "ids must be array" });
  const map = Object.fromEntries(loadScripts().map(s => [s.id, s]));
  const reordered = ids.map(id => map[id]).filter(Boolean);
  saveScripts(reordered);
  res.json({ ok: true, scripts: reordered });
});

// POST /extensions/regex/test — test a single script
router.post("/test", (req, res) => {
  const { input, findRegex, replaceString, flags, trimStrings } = req.body;
  if (typeof input !== "string" || !findRegex)
    return res.status(400).json({ ok: false, error: "input and findRegex required" });
  const { text: output, fired } = applyScript(input, {
    enabled:       true,
    findRegex,
    replaceString: replaceString ?? "",
    flags:         flags         ?? "g",
    trimStrings:   trimStrings   ?? false,
    dryRun:        false,
  });
  res.json({ ok: true, output, matched: fired });
});

// POST /extensions/regex/test-all — run all enabled scripts
router.post("/test-all", (req, res) => {
  const { input } = req.body;
  if (typeof input !== "string")
    return res.status(400).json({ ok: false, error: "input required" });
  const scripts    = loadScripts().filter(s => s.enabled);
  let   current    = input;
  let   scriptsRun = 0;
  for (const s of scripts) {
    const { text: next, fired } = applyScript(current, s);
    if (fired) { current = next; scriptsRun++; }
    if (fired && s.stopOnMatch) break;
  }
  res.json({ ok: true, output: current, scriptsRun });
});

// POST /extensions/regex/import — ST-compatible JSON import
router.post("/import", (req, res) => {
  if (!Array.isArray(req.body))
    return res.status(400).json({ ok: false, error: "Expected array" });
  const imported = req.body.map(s => ({
    id:            Date.now().toString() + Math.random().toString(36).slice(2, 6),
    description:   s.scriptName   ?? s.description ?? "Imported",
    findRegex:     s.findRegex    ?? "",
    replaceString: s.replaceString ?? "",
    flags:         s.flags ?? ([s.global !== false ? "g" : "", s.caseInsensitive ? "i" : ""].join("") || "g"),
    trimStrings:   s.trimStrings  ?? false,
    enabled:       s.disabled !== true && (s.enabled ?? true),
    stopOnMatch:   s.stopOnMatch  ?? false,
    dryRun:        false,
    tags:          s.tags         ?? [],
  }));
  const merged = [...loadScripts(), ...imported];
  saveScripts(merged);
  res.json({ ok: true, scripts: merged });
});

// GET /extensions/regex/export
router.get("/export", (req, res) => {
  res.setHeader("Content-Disposition", 'attachment; filename="regex-scripts.json"');
  res.json(loadScripts());
});

// POST /extensions/regex/group/:tag/enable — bulk enable a tag group
router.post("/group/:tag/enable", (req, res) => {
  const scripts = setGroupEnabled(loadScripts(), req.params.tag, true);
  saveScripts(scripts);
  res.json({ ok: true, scripts });
});

// POST /extensions/regex/group/:tag/disable — bulk disable a tag group
router.post("/group/:tag/disable", (req, res) => {
  const scripts = setGroupEnabled(loadScripts(), req.params.tag, false);
  saveScripts(scripts);
  res.json({ ok: true, scripts });
});

// GET /extensions/regex/counters — live hit counts
router.get("/counters", (req, res) => {
  res.json({ ok: true, counters: _counters });
});

// POST /extensions/regex/counters/reset — reset all counters
router.post("/counters/reset", (req, res) => {
  _counters = {};
  res.json({ ok: true });
});

// ── Export ─────────────────────────────────────────────────
module.exports = {
  name: "Regex Processor",
  version: "2.0",
  priority: 20,
  router,
  transformResponse,
};