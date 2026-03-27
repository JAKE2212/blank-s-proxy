"use strict";
/**
 * lib/character-detector.js — Shared character name extraction
 * v1.1 — Multi-word alias matching + expanded blocklist
 *
 * Single source of truth for:
 *   - Extracting character names from AI replies
 *   - Extracting the user's name from JanitorAI messages
 *   - Resolving aliases to canonical names (including multi-word)
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
let _multiWordAliases = []; // sorted longest-first for greedy matching

function loadAliases() {
  try {
    if (!fs.existsSync(ALIAS_FILE)) return {};
    const stat = fs.statSync(ALIAS_FILE);
    if (_aliasCache && stat.mtimeMs === _aliasMtime) return _aliasCache;
    _aliasCache = JSON.parse(fs.readFileSync(ALIAS_FILE, "utf8"));
    _aliasMtime = stat.mtimeMs;
    // Pre-compute multi-word aliases sorted by length (longest first for greedy matching)
    _multiWordAliases = Object.entries(_aliasCache)
      .filter(([key]) => key.includes(" "))
      .sort((a, b) => b[0].length - a[0].length);
    return _aliasCache;
  } catch {
    return _aliasCache ?? {};
  }
}

/**
 * Resolve a single-word name through the alias map.
 * Returns the canonical name if an alias exists, otherwise the original.
 * @param {string} name — lowercase name
 * @returns {string}
 */
function resolveAlias(name) {
  const aliases = loadAliases();
  return aliases[name] ?? name;
}

/**
 * Scan text for multi-word aliases and collect the canonical names they map to.
 * Also returns the text with multi-word aliases removed so they don't get
 * re-detected as individual words by the single-word patterns.
 * @param {string} text
 * @returns {{ foundNames: Set<string>, cleanedText: string }}
 */
function extractMultiWordAliases(text) {
  const aliases = loadAliases();
  const found = new Set();
  let cleaned = text;

  for (const [alias, canonical] of _multiWordAliases) {
    // Case-insensitive search for the multi-word alias
    const re = new RegExp(`\\b${escapeRegex(alias)}\\b`, "gi");
    if (re.test(cleaned)) {
      found.add(canonical);
      // Remove matched alias from text so individual words don't get re-detected
      cleaned = cleaned.replace(re, " ");
    }
  }

  return { foundNames: found, cleanedText: cleaned };
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Blocklist ──────────────────────────────────────────────
// Words that appear capitalized at sentence starts but are NOT character names.
const BLOCKLIST = new Set([
  // Pronouns & possessives
  "he","she","they","it","his","her","their","its",
  "him","them","we","us","our","my","your","i","me","you",
  // Articles & demonstratives
  "the","a","an","this","that","these","those",
  // Conjunctions & prepositions
  "but","not","nor","for","yet","so","or","and",
  "of","in","on","at","to","by","with","from",
  "before","after","above","below","between","through",
  "during","without","within","upon","into","onto",
  "away","off","down","out","over","around","back",
  // Common sentence starters
  "there","here","how","just","please","still",
  "everyone","whoever","nobody","somebody","anyone",
  "everything","something","nothing","anything",
  "every","each","both","all","some","many","most",
  "now","never","always","also","only","even",
  "well","right","already","again",
  "what","like","much","enough","dude",
  // Question words
  "why","who","which","whose","whom","when","where",
  // Numbers & ordinals
  "one","two","three","ten","twenty","thirty","forty",
  "fifty","sixty","hundred","thousand",
  "first","last","next","other","another","second",
  // Adverbs & intensifiers
  "very","too","quite","really","almost","nearly","barely",
  "quickly","slowly","suddenly","carefully","quietly","loudly",
  "finally","immediately","meanwhile","unfortunately",
  "apparently","absolutely","definitely","certainly",
  "obviously","seriously","literally","probably",
  "perhaps","especially","actually","basically","completely",
  // Adjectives commonly starting sentences
  "good","bad","wrong","right","true","false","real","fake",
  "old","new","young","dark","light","cold","hot","warm",
  "hard","soft","fast","slow","long","short","big","small",
  "open","close","dead","alive","alone","together","apart",
  "full","dangerous","catastrophic",
  // Time & location words
  "today","tonight","tomorrow","yesterday","morning",
  "afternoon","evening","outside","inside","forward","backward",
  "moment","instant","minute","hour",
  "february","march","april","may","june","july","august", "september","october","november","december", "january",
  // Common RP narration words that get capitalized
  "did","then","hey","might","peace","hero","girl","boy",
  "man","woman","team","chairs","rush","silence","conversations",
  "nobody","okay","sure","yeah","yes","no",
  "someone","no one",
  // Sound effects & exclamations
  "oh","ah","um","uh","god","damn","hell","shit","fuck","christ","jesus",
  "kch","tch","ugh","grr","tsk","pfft","hmm","huh","gah","bah","meh",
  "sigh","sighs","groan","groans","whisper","whispers","mutter","mutters",
  // MHA-specific false positives
  "beta","ground","quirk","quirks","hero","heroes","villain","villains",
  "plus","ultra","smash","detroit","delaware","manchester",
  "raccoon","hamster","sweat","sweats","sweating",
  "smoke","flame","flames","ice","lightning","shock","earthquake",
  "nomu",
  // Common words that get capitalized at sentence starts
  "if","come","came","go","went","about","zone","sweat","according",
  "erasure","because","since","while","although","though","until",
  "unless","once","been","being","have","has","had","are","was","were",
  "would","could","should","shall","will","can","does","done",
  "think","know","want","need","feel","see","get","got","put","let",
  "say","tell","talk","hear","give","take","make","find","keep",
  "try","call","run","set","turn","move","look","show","help","play",
  "work","seem","leave","begin","end","bring","hold","stand","lose",
  "pay","meet","lead","grow","live","happen","follow","stop","cut",
  "speak","read","spend","rise","send","wear","break","hang",
  // Body parts & physical descriptors (common in RP narration)
  "blood","bone","bones","skin","eyes","face","hand","hands","head",
  "arm","arms","leg","legs","chest","throat","jaw","shoulder","shoulders",
  "stomach","heart","lip","lips","mouth","teeth","tongue","finger","fingers",
  "fist","fists","palm","palms","wrist","knee","knees","foot","feet",
  "neck","hair","cheek","cheeks","brow","brows","spine","rib","ribs",
  // Emotions & states
  "anger","fear","panic","relief","shock","surprise","horror","rage",
  "grief","pain","guilt","shame","pride","hope","love","hate","joy",
  "calm","stress","tension","worry","doubt","trust","confusion",
  // RP narration nouns
  "air","sky","sun","moon","wind","rain","fire","water","ice","dust",
  "floor","wall","walls","door","doors","window","windows","room",
  "ground","table","chair","desk","bed","seat","step","steps",
  "hallway","corridor","building","class","classroom","street",
  "voice","sound","noise","word","words","name","question","answer",
  "thought","memory","moment","beat","breath","pause","silence",
  "crowd","group","class","people","students","others","rest",
  "attack","defense","power","energy","force","impact","hit",
  "fight","battle","combat","blow","strike","punch","kick",
  "truth","lie","secret","promise","deal","plan",
  "kid","sir","ma","miss","mister","bro","bruh","chief",
  "friend","friends","enemy","enemies","stranger","partner",
  "teacher","student","class","master","sensei","captain",
  "reinforcements","backup","civilians","survivors","rescue",
  "hole","wound","scar","mark","tattoo","clothing","uniform",
]);

// ── Action verbs for pattern matching ──────────────────────
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
 * Flow:
 * 1. Scan for multi-word aliases first ("All Might" → "toshinori")
 * 2. Run single-word patterns on the remaining text
 * 3. Resolve single-word aliases ("shoto" → "todoroki")
 * 4. Deduplicate and return
 *
 * @param {string}      replyText — the AI's reply text
 * @param {string|null} userName  — the user's character name (excluded from results)
 * @param {object}      [opts]
 * @param {number}      [opts.maxChars=3000] — cap text length for performance
 * @returns {string[]}
 */
function extractCharNames(replyText, userName, opts = {}) {
  if (!replyText) return [];

  const maxChars = opts.maxChars ?? 3000;
  const text = replyText.slice(0, maxChars);

  // Phase 1: Extract multi-word aliases
  const { foundNames: multiWordFound, cleanedText } = extractMultiWordAliases(text);

  // Phase 2: Single-word extraction on the cleaned text
  const singleWordFound = new Set();

  const lines = cleanedText
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length > 0 && !/^[-—*#\[]+$/.test(l));

  for (const line of lines) {
    const clean = line.replace(/^\*+/, "").replace(/\[.*?\]/g, "").trim();

    // Pattern 1 — possessive: "Kurt's jaw tightened"
    for (const m of clean.matchAll(/\b([A-Z][a-z]{1,20})'s\b/g)) {
      addName(singleWordFound, m[1], userName);
    }

    // Pattern 2 — action verb: "Kurt stepped forward"
    for (const m of clean.matchAll(ACTION_VERB_RE)) {
      addName(singleWordFound, m[1], userName);
    }

    // Pattern 3 — dialogue attribution: `"text," Kurt said`
    for (const m of clean.matchAll(/["'][^"']+["']\s*[,.]?\s*([A-Z][a-z]{1,20})\b/g)) {
      addName(singleWordFound, m[1], userName);
    }
  }

  // Phase 3: Resolve single-word aliases and merge with multi-word results
  const resolved = new Set(multiWordFound);
  for (const name of singleWordFound) {
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