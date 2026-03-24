const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const DATA_FILE = path.join(__dirname, "../data/regex-scripts.json");

function loadScripts() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    return [];
  }
}

function saveScripts(scripts) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(scripts, null, 2));
}

function parseRegex(findRegex, fallbackFlags) {
  const m = findRegex.match(/^\/(.+)\/([gimsuy]*)$/s);
  if (m) return { pattern: m[1], flags: m[2] || fallbackFlags || "g" };
  return { pattern: findRegex, flags: fallbackFlags || "g" };
}

function applyScript(text, script) {
  if (!script.enabled || !script.findRegex) return text;
  const { pattern, flags } = parseRegex(script.findRegex, script.flags);
  let re;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return text;
  }
  const replacement = (script.replaceString ?? "").replace(
    /\{\{match\}\}/g,
    "$&",
  );
  let result = text.replace(re, replacement);
  if (script.trimStrings) result = result.trim();
  return result;
}

function transformResponse(responseBody) {
  const scripts = loadScripts();
  if (!scripts.length) return responseBody;
  let text =
    responseBody?.choices?.[0]?.message?.content ??
    responseBody?.content?.[0]?.text ??
    null;
  if (typeof text !== "string") return responseBody;
  for (const script of scripts) {
    text = applyScript(text, script);
  }
  if (responseBody?.choices?.[0]?.message?.content !== undefined) {
    responseBody.choices[0].message.content = text;
  } else if (responseBody?.content?.[0]?.text !== undefined) {
    responseBody.content[0].text = text;
  }
  return responseBody;
}

router.get("/scripts", (req, res) => {
  res.json({ ok: true, scripts: loadScripts() });
});

router.post("/scripts", (req, res) => {
  const scripts = loadScripts();
  const script = {
    id: Date.now().toString(),
    description: req.body.description ?? "Untitled",
    findRegex: req.body.findRegex ?? "",
    replaceString: req.body.replaceString ?? "",
    flags: req.body.flags ?? "g",
    trimStrings: req.body.trimStrings ?? false,
    enabled: req.body.enabled ?? true,
  };
  scripts.push(script);
  saveScripts(scripts);
  res.status(201).json({ ok: true, script });
});

router.put("/scripts/:id", (req, res) => {
  const scripts = loadScripts();
  const idx = scripts.findIndex((s) => s.id === req.params.id);
  if (idx === -1)
    return res.status(404).json({ ok: false, error: "Not found" });
  scripts[idx] = { ...scripts[idx], ...req.body, id: scripts[idx].id };
  saveScripts(scripts);
  res.json({ ok: true, script: scripts[idx] });
});

router.delete("/scripts/:id", (req, res) => {
  let scripts = loadScripts();
  const before = scripts.length;
  scripts = scripts.filter((s) => s.id !== req.params.id);
  if (scripts.length === before)
    return res.status(404).json({ ok: false, error: "Not found" });
  saveScripts(scripts);
  res.json({ ok: true });
});

router.post("/reorder", (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids))
    return res.status(400).json({ ok: false, error: "ids must be array" });
  const map = Object.fromEntries(loadScripts().map((s) => [s.id, s]));
  const reordered = ids.map((id) => map[id]).filter(Boolean);
  saveScripts(reordered);
  res.json({ ok: true, scripts: reordered });
});

router.post("/test", (req, res) => {
  const { input, findRegex, replaceString, flags, trimStrings } = req.body;
  if (typeof input !== "string" || !findRegex)
    return res
      .status(400)
      .json({ ok: false, error: "input and findRegex required" });
  const output = applyScript(input, {
    enabled: true,
    findRegex,
    replaceString: replaceString ?? "",
    flags: flags ?? "g",
    trimStrings: trimStrings ?? false,
  });
  res.json({ ok: true, output });
});

router.post("/test-all", (req, res) => {
  const { input } = req.body;
  if (typeof input !== "string")
    return res.status(400).json({ ok: false, error: "input required" });
  const scripts = loadScripts().filter((s) => s.enabled);
  const output = scripts.reduce((text, s) => applyScript(text, s), input);
  res.json({ ok: true, output, scriptsRun: scripts.length });
});

router.post("/import", (req, res) => {
  if (!Array.isArray(req.body))
    return res.status(400).json({ ok: false, error: "Expected array" });
  const imported = req.body.map((s) => ({
    id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
    description: s.scriptName ?? s.description ?? "Imported",
    findRegex: s.findRegex ?? "",
    replaceString: s.replaceString ?? "",
    flags:
      s.flags ??
      ([s.global !== false ? "g" : "", s.caseInsensitive ? "i" : ""].join("") ||
        "g"),
    trimStrings: s.trimStrings ?? false,
    enabled: s.disabled !== true && (s.enabled ?? true),
  }));
  const merged = [...loadScripts(), ...imported];
  saveScripts(merged);
  res.json({ ok: true, scripts: merged });
});

router.get("/export", (req, res) => {
  res.setHeader(
    "Content-Disposition",
    'attachment; filename="regex-scripts.json"',
  );
  res.json(loadScripts());
});

// change the existing module.exports line to:
module.exports = {
  name: "Regex Processor",
  version: "1.0",
  priority: 20,
  router,
  transformResponse,
};
