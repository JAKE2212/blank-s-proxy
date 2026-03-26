"use strict";
/**
 * lib/character-detector.js — Shared character name extraction
 *
 * Single source of truth for:
 *   - Extracting character names from AI replies
 *   - Extracting the user's name from JanitorAI messages
 *   - Resolving aliases to canonical names
 *   - Blocklisting false positives (pronouns, common words)
 *
 * Used by: rag.js, prose-polisher.js, tunnelvision.js
 */

const fs = require("fs");
const path = require("path");

const ALIAS_FILE = path.join(__dirname, "../data/character-aliases.json");

// ── Alias cache ────────────────────────────────────────────
let _aliasCache = null;
let _aliasMtime = 0;

function loadAliases() {
  try {
    if (!fs.existsSync(ALIAS_FILE)) return {};
    const stat = fs.statSync(ALIAS_FILE);
    if (_aliasCache && stat.mtimeMs === _aliasMtime) return _aliasCache;
    _aliasCache = JSON.parse(fs.readFileSync(ALIAS_FILE, "utf8"));
    _aliasMtime = stat.mtimeMs;
    return _aliasCache;
  } catch {
    return _aliasCache ?? {};
  }
}

/**
 * Resolve a name through the alias map.
 * Returns the canonical name if an alias exists, otherwise the original.
 * @param {string} name — lowercase name
 * @returns {string}
 */
function resolveAlias(name) {
  const aliases = loadAliases();
  return aliases[name] ?? name;
}

// ── Blocklist ──────────────────────────────────────────────
// Words that appear capitalized at sentence starts but are NOT character names.
const BLOCKLIST = new Set([
  // Pronouns
  "he","she","they","it","his","her","their","its",
  "him","them","we","us","our","my","your","i",
  // Articles & demonstratives
  "the","a","an","this","that","these","those",
  // Common sentence starters
  "there","here","how","just","please","you","still",
  "everyone","whoever","nobody","somebody","anyone",
  "everything","something","nothing","anything",
  "every","each","both","all","some","many","most",
  "now","never","always","also","only","even",
  "well","right","just","still","yet","already",
  // Numbers that start sentences
  "sit","sat","sixty","fifty","forty","thirty","twenty",
  "ten","hundred","thousand",
  // Question / conjunction words
  "why","who","which","whose","whom",
  "but","not","nor","for","yet","so",
  // Adverbs / intensifiers
  "very","much","more","less","too","quite",
  // Ordinals / determiners
  "first","last","next","other","another",
  // Common verbs that get capitalized at sentence start
  "before","after","above","below","between","through",
  "during","without","within","upon","into","onto",
  // Time / location words
  "today","tonight","tomorrow","yesterday","morning",
  "afternoon","evening","outside","inside","around",
  // Common RP false positives
  "god","jesus","christ","damn","shit","fuck","hell",
  "okay","sure","yeah","yes","no","oh","ah","um",
  // Additional false positives from testing
  "catastrophic","conversations","dangerous","suddenly","immediately",
  "meanwhile","unfortunately","apparently","absolutely","definitely",
  "certainly","obviously","seriously","literally","probably",
  "perhaps","especially","actually","basically","completely",
  "kch","tch","ugh","grr","tsk","pfft","hmm","huh","gah","bah","meh",
]);

// ── Action verbs for pattern matching ──────────────────────
// Used in the "Name <verb>" detection pattern.
const ACTION_VERBS = [
  "stepped","turned","said","looked","felt","moved","stood","walked","ran",
  "smiled","frowned","crossed","glanced","stared","grabbed","reached","spoke",
  "asked","replied","growled","snapped","sighed","laughed","narrowed","clenched",
  "exhaled","inhaled","shrugged","nodded","shook","leaned","pulled","pushed",
  "dropped","raised","lowered","tilted","pressed","placed","held","kept","let",
  "made","gave","took","came","went","sat","lay","rose","fell","spun","jerked",
  "flinched","tensed","relaxed","watched","waited","paused","stopped","started",
  "opened","closed","shifted","backed","stretched","twisted","arched","curled",
  "spread","folded","muttered","whispered","murmured","hissed","barked",
  "scoffed","grunted","groaned","winced","blinked","squinted","swallowed",
  "breathed","straightened","stumbled","staggered","lunged","darted","bolted",
  "froze","trembled","shivered","grinned","smirked","scowled","huffed",
].join("|");

const ACTION_VERB_RE = new RegExp(
  `\\b([A-Z][a-z]{1,20})\\s+(?:${ACTION_VERBS})\\b`, "g"
);

// ── Core extraction ────────────────────────────────────────

/**
 * Extract all unique character names from a reply.
 * Returns deduplicated array of lowercase canonical names.
 *
 * @param {string}      replyText — the AI's reply text
 * @param {string|null} userName  — the user's character name (excluded from results)
 * @param {object}      [opts]
 * @param {number}      [opts.maxChars=2000] — cap text length for performance
 * @returns {string[]}
 */
function extractCharNames(replyText, userName, opts = {}) {
  if (!replyText) return [];

  const maxChars = opts.maxChars ?? 2000;
  const text = replyText.slice(0, maxChars);
  const found = new Set();

  const lines = text
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/^[-—*#\[]+$/.test(l));

  for (const line of lines) {
    const clean = line.replace(/^\*+/, "").replace(/\[.*?\]/g, "").trim();

    // Pattern 1 — possessive: "Kurt's jaw tightened"
    for (const m of clean.matchAll(/\b([A-Z][a-z]{1,20})'s\b/g)) {
      addName(found, m[1], userName);
    }

    // Pattern 2 — action verb: "Kurt stepped forward"
    for (const m of clean.matchAll(ACTION_VERB_RE)) {
      addName(found, m[1], userName);
    }

    // Pattern 3 — dialogue attribution: `"text," Kurt said`
    for (const m of clean.matchAll(/["'][^"']+["']\s*[,.]?\s*([A-Z][a-z]{1,20})\b/g)) {
      addName(found, m[1], userName);
    }
  }

  // Resolve aliases and deduplicate again
  const resolved = new Set();
  for (const name of found) {
    resolved.add(resolveAlias(name));
  }

  return [...resolved];
}

/**
 * Add a candidate name to the found set if it passes validation.
 * @param {Set}         found
 * @param {string}      raw — raw matched name (e.g. "Kurt")
 * @param {string|null} userName — excluded name
 */
function addName(found, raw, userName) {
  const name = raw.toLowerCase();
  if (name === userName) return;
  if (BLOCKLIST.has(name)) return;
  if (name.length < 2) return;
  found.add(name);
}

// ── User name extraction ───────────────────────────────────

/**
 * Extract the user's character name from messages.
 * JanitorAI formats user messages as "Name : message text"
 * @param {object[]} messages
 * @returns {string|null}
 */
function extractUserName(messages) {
  const userMsgs = messages.filter(m => m.role === "user");
  for (const msg of userMsgs.slice(-3).reverse()) {
    const text = typeof msg.content === "string"
      ? msg.content
      : (msg.content?.[0]?.text ?? "");
    const match = text.match(/^([A-Z][a-zA-Z]{1,20})\s*:/);
    if (match) return match[1].toLowerCase();
  }
  return null;
}

module.exports = {
  extractCharNames,
  extractUserName,
  resolveAlias,
  loadAliases,
  BLOCKLIST,
};