// ============================================================
// extensions/prose-polisher.js — Slop detection & injection
// Stage 1: Core engine + transformResponse + transformRequest
// ============================================================
const fs = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "../data/prose-polisher-config.json");
const STATE_FILE = path.join(__dirname, "../data/prose-polisher-state.json");

// ── Default config ─────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled: true,
  ngramMax: 10,
  slopThreshold: 3.0,
  decayRate: 10, // % decay per interval
  decayInterval: 10, // messages between decay applications
  patternMinCommon: 3, // min shared prefix words to merge patterns
  injectSlop: true, // inject slop list into outgoing prompts
  maxInjected: 10, // max phrases to inject
  whitelist: [],
  blacklist: {}, // { "phrase": weight }
};

// ── Persistence ────────────────────────────────────────────
function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    return {
      ...DEFAULT_CONFIG,
      ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")),
    };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE))
      return { ngramFrequencies: {}, totalMessages: 0 };
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { ngramFrequencies: {}, totalMessages: 0 };
  }
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
  } catch (e) {
    console.warn("[prose-polisher] Failed to save state:", e.message);
  }
}

// ── Bundled data ───────────────────────────────────────────

const COMMON_WORDS = new Set([
  "the",
  "of",
  "to",
  "and",
  "a",
  "in",
  "is",
  "it",
  "you",
  "that",
  "he",
  "was",
  "for",
  "on",
  "are",
  "with",
  "as",
  "his",
  "they",
  "be",
  "at",
  "one",
  "have",
  "this",
  "from",
  "or",
  "had",
  "by",
  "not",
  "but",
  "what",
  "some",
  "we",
  "can",
  "out",
  "other",
  "were",
  "all",
  "there",
  "when",
  "up",
  "use",
  "your",
  "how",
  "said",
  "an",
  "each",
  "she",
  "which",
  "do",
  "their",
  "time",
  "if",
  "will",
  "way",
  "about",
  "many",
  "then",
  "them",
  "would",
  "like",
  "so",
  "these",
  "her",
  "long",
  "make",
  "see",
  "him",
  "two",
  "has",
  "look",
  "more",
  "day",
  "could",
  "go",
  "come",
  "did",
  "no",
  "most",
  "people",
  "my",
  "over",
  "know",
  "than",
  "call",
  "first",
  "who",
  "may",
  "down",
  "been",
  "now",
  "find",
  "any",
  "new",
  "work",
  "part",
  "take",
  "get",
  "place",
  "made",
  "live",
  "where",
  "after",
  "back",
  "little",
  "only",
  "man",
  "year",
  "came",
  "show",
  "every",
  "good",
  "me",
  "give",
  "our",
  "under",
  "name",
  "very",
  "through",
  "just",
  "think",
  "say",
  "help",
  "turn",
  "much",
  "mean",
  "before",
  "move",
  "right",
  "old",
  "too",
  "same",
  "tell",
  "does",
  "set",
  "want",
  "well",
  "also",
  "play",
  "small",
  "end",
  "put",
  "home",
  "read",
  "hand",
  "large",
  "even",
  "here",
  "must",
  "big",
  "high",
  "such",
  "follow",
  "why",
  "ask",
  "change",
  "went",
  "light",
  "off",
  "need",
  "house",
  "try",
  "us",
  "again",
  "point",
  "should",
  "found",
  "keep",
  "eye",
  "never",
  "last",
  "let",
  "thought",
  "left",
  "late",
  "run",
  "while",
  "close",
  "night",
  "real",
  "life",
  "few",
  "open",
  "seem",
  "together",
  "next",
  "white",
  "begin",
  "got",
  "walk",
  "both",
  "often",
  "until",
  "second",
  "book",
  "carry",
  "took",
  "eat",
  "room",
  "began",
  "idea",
  "stop",
  "once",
  "hear",
  "cut",
  "sure",
  "watch",
  "face",
  "main",
  "enough",
  "feel",
  "talk",
  "soon",
  "body",
  "door",
  "short",
  "class",
  "wind",
  "happen",
  "ship",
  "half",
  "rock",
  "order",
  "fire",
  "since",
  "top",
  "whole",
  "heard",
  "best",
  "hour",
  "better",
  "true",
  "during",
  "remember",
  "early",
  "hold",
  "ground",
  "reach",
  "fast",
  "morning",
  "simple",
  "toward",
  "lay",
  "against",
  "slow",
  "love",
  "person",
  "appear",
  "road",
  "rule",
  "pull",
  "cold",
  "notice",
  "voice",
  "unit",
  "power",
  "town",
  "fine",
  "certain",
  "fly",
  "fall",
  "lead",
  "cry",
  "dark",
  "note",
  "wait",
  "plan",
  "star",
  "field",
  "rest",
  "able",
  "done",
  "drive",
  "stood",
  "front",
  "teach",
  "week",
  "gave",
  "green",
  "quick",
  "warm",
  "free",
  "minute",
  "strong",
  "mind",
  "behind",
  "clear",
  "fact",
  "street",
  "nothing",
  "course",
  "stay",
  "full",
  "force",
  "blue",
  "object",
  "deep",
  "moon",
  "foot",
  "busy",
  "test",
  "boat",
  "common",
  "possible",
  "dry",
  "wonder",
  "ago",
  "ran",
  "check",
  "game",
  "shape",
  "hot",
  "miss",
  "brought",
  "heat",
  "snow",
  "bring",
  "yes",
  "fill",
  "east",
  "among",
  "ball",
  "yet",
  "wave",
  "drop",
  "heart",
  "present",
  "heavy",
  "arm",
  "wide",
  "sail",
  "size",
  "vary",
  "speak",
  "weight",
  "matter",
  "circle",
  "include",
  "felt",
  "perhaps",
  "pick",
  "count",
  "reason",
  "length",
  "bed",
  "brother",
  "egg",
  "ride",
  "sit",
  "race",
  "window",
  "store",
  "summer",
  "train",
  "sleep",
  "leg",
  "wall",
  "catch",
  "wish",
  "sky",
  "board",
  "joy",
  "winter",
  "sat",
  "wild",
  "kept",
  "glass",
  "grass",
  "job",
  "edge",
  "sign",
  "past",
  "soft",
  "fun",
  "bright",
  "weather",
  "month",
  "bear",
  "finish",
  "happy",
  "hope",
  "flower",
  "jump",
  "baby",
  "meet",
  "root",
  "buy",
  "raise",
  "bone",
  "rail",
  "imagine",
  "provide",
  "agree",
  "chair",
  "fruit",
  "rich",
  "thick",
  "process",
  "guess",
  "sharp",
  "wing",
  "create",
  "wash",
  "crowd",
  "compare",
  "string",
  "bell",
  "meat",
  "tube",
  "famous",
  "stream",
  "fear",
  "sight",
  "thin",
  "planet",
  "hurry",
  "clock",
  "mine",
  "tie",
  "enter",
  "fresh",
  "search",
  "send",
  "allow",
  "print",
  "dead",
  "spot",
  "suit",
  "current",
  "lift",
  "rose",
  "block",
  "hat",
  "sell",
  "swim",
  "term",
  "wife",
  "shoe",
  "shoulder",
  "spread",
  "camp",
  "born",
  ["noise"],
  "level",
  "chance",
  "gather",
  "shop",
  "throw",
  "shine",
  "column",
  "select",
  "wrong",
  "gray",
  "repeat",
  "require",
  "broad",
  "prepare",
  "salt",
  "nose",
  "anger",
  "claim",
  "oxygen",
  "death",
  "pretty",
  "skill",
  "season",
  "silver",
  "thank",
  "branch",
  "match",
  "afraid",
  "huge",
  "steel",
  "discuss",
  "forward",
  "similar",
  "score",
  "bought",
  "coat",
  "mass",
  "card",
  "band",
  "rope",
  "slip",
  "win",
  "dream",
  "evening",
  "tool",
  "total",
  "basic",
  "smell",
  "seat",
  "arrive",
  "master",
  "track",
  "parent",
  "shore",
  "sheet",
  "post",
  "spend",
  "fat",
  "glad",
  "share",
  "station",
  "dad",
  "bread",
  "charge",
  "bar",
  "offer",
  "duck",
  "instant",
  "degree",
  "dear",
  "enemy",
  "reply",
  "drink",
  "occur",
  "support",
  "speech",
  "nature",
  "range",
  "steam",
  "motion",
  "path",
  "liquid",
  "meant",
  "teeth",
  "shell",
  "neck",
]);

const LEMMA_MAP = new Map([
  ["is", "be"],
  ["was", "be"],
  ["are", "be"],
  ["were", "be"],
  ["being", "be"],
  ["been", "be"],
  ["looked", "look"],
  ["looks", "look"],
  ["looking", "look"],
  ["smiled", "smile"],
  ["smiles", "smile"],
  ["smiling", "smile"],
  ["seemed", "seem"],
  ["seems", "seem"],
  ["seeming", "seem"],
  ["felt", "feel"],
  ["feels", "feel"],
  ["feeling", "feel"],
  ["said", "say"],
  ["says", "say"],
  ["saying", "say"],
  ["went", "go"],
  ["goes", "go"],
  ["going", "go"],
  ["had", "have"],
  ["has", "have"],
  ["having", "have"],
  ["did", "do"],
  ["does", "do"],
  ["doing", "do"],
  ["knew", "know"],
  ["knows", "know"],
  ["knowing", "know"],
  ["took", "take"],
  ["takes", "take"],
  ["taking", "take"],
  ["saw", "see"],
  ["sees", "see"],
  ["seeing", "see"],
  ["came", "come"],
  ["comes", "come"],
  ["coming", "come"],
  ["thought", "think"],
  ["thinks", "think"],
  ["thinking", "think"],
  ["gave", "give"],
  ["gives", "give"],
  ["giving", "give"],
  ["told", "tell"],
  ["tells", "tell"],
  ["telling", "tell"],
  ["made", "make"],
  ["makes", "make"],
  ["making", "make"],
  ["used", "use"],
  ["uses", "use"],
  ["using", "use"],
  ["wanted", "want"],
  ["wants", "want"],
  ["wanting", "want"],
  ["asked", "ask"],
  ["asks", "ask"],
  ["asking", "ask"],
  ["tried", "try"],
  ["tries", "try"],
  ["trying", "try"],
  ["called", "call"],
  ["calls", "call"],
  ["calling", "call"],
  ["turned", "turn"],
  ["turns", "turn"],
  ["turning", "turn"],
  ["started", "start"],
  ["starts", "start"],
  ["starting", "start"],
  ["moved", "move"],
  ["moves", "move"],
  ["moving", "move"],
  ["lived", "live"],
  ["lives", "live"],
  ["living", "live"],
  ["happened", "happen"],
  ["happens", "happen"],
  ["happening", "happen"],
  ["sat", "sit"],
  ["sits", "sit"],
  ["sitting", "sit"],
  ["stood", "stand"],
  ["stands", "stand"],
  ["standing", "stand"],
  ["lost", "lose"],
  ["loses", "lose"],
  ["losing", "lose"],
  ["fell", "fall"],
  ["falls", "fall"],
  ["falling", "fall"],
  ["reached", "reach"],
  ["reaches", "reach"],
  ["reaching", "reach"],
  ["remained", "remain"],
  ["remains", "remain"],
  ["remaining", "remain"],
  ["appeared", "appear"],
  ["appears", "appear"],
  ["appearing", "appear"],
  ["waited", "wait"],
  ["waits", "wait"],
  ["waiting", "wait"],
  ["watched", "watch"],
  ["watches", "watch"],
  ["watching", "watch"],
  ["followed", "follow"],
  ["follows", "follow"],
  ["following", "follow"],
  ["stopped", "stop"],
  ["stops", "stop"],
  ["stopping", "stop"],
  ["walked", "walk"],
  ["walks", "walk"],
  ["walking", "walk"],
  ["loved", "love"],
  ["loves", "love"],
  ["loving", "love"],
  ["eyes", "eye"],
  ["years", "year"],
  ["ways", "way"],
  ["days", "day"],
  ["hands", "hand"],
  ["words", "word"],
  ["things", "thing"],
  ["times", "time"],
  ["lips", "lip"],
  ["cheeks", "cheek"],
  ["shoulders", "shoulder"],
  ["arms", "arm"],
  ["legs", "leg"],
  ["fingers", "finger"],
  ["thoughts", "thought"],
  ["moments", "moment"],
  ["steps", "step"],
  ["voices", "voice"],
  ["rooms", "room"],
  ["doors", "door"],
  ["walls", "wall"],
  ["tears", "tear"],
  ["fears", "fear"],
  ["hopes", "hope"],
  ["dreams", "dream"],
]);

const DEFAULT_NAMES = new Set([
  "aaron",
  "adam",
  "alex",
  "alexander",
  "andrew",
  "anthony",
  "arthur",
  "ben",
  "benjamin",
  "bob",
  "brandon",
  "brian",
  "caleb",
  "cameron",
  "charles",
  "charlie",
  "chris",
  "christopher",
  "daniel",
  "david",
  "dylan",
  "edward",
  "eli",
  "elijah",
  "eric",
  "ethan",
  "evan",
  "felix",
  "frank",
  "gabriel",
  "george",
  "harry",
  "henry",
  "hunter",
  "ian",
  "isaac",
  "jack",
  "jackson",
  "jacob",
  "jake",
  "james",
  "jason",
  "jeremy",
  "jesse",
  "joe",
  "john",
  "jonathan",
  "jordan",
  "joseph",
  "joshua",
  "julian",
  "justin",
  "kevin",
  "kyle",
  "leo",
  "levi",
  "liam",
  "lincoln",
  "logan",
  "lucas",
  "luke",
  "marcus",
  "mark",
  "mason",
  "matthew",
  "max",
  "michael",
  "miles",
  "nathan",
  "nicholas",
  "nick",
  "noah",
  "nolan",
  "oliver",
  "owen",
  "patrick",
  "paul",
  "peter",
  "robert",
  "ryan",
  "sam",
  "samuel",
  "scott",
  "sean",
  "sebastian",
  "seth",
  "thomas",
  "timothy",
  "tyler",
  "victor",
  "vincent",
  "will",
  "william",
  "zachary",
  "abigail",
  "alexis",
  "alice",
  "allison",
  "amanda",
  "amber",
  "amelia",
  "amy",
  "anna",
  "aria",
  "ariana",
  "ashley",
  "ava",
  "avery",
  "bella",
  "brianna",
  "brooke",
  "camila",
  "charlotte",
  "chloe",
  "claire",
  "courtney",
  "diana",
  "elena",
  "elizabeth",
  "ella",
  "emily",
  "emma",
  "eva",
  "evelyn",
  "faith",
  "grace",
  "hailey",
  "hannah",
  "harper",
  "hazel",
  "isabella",
  "jade",
  "jessica",
  "julia",
  "katie",
  "kayla",
  "kelly",
  "laura",
  "lauren",
  "layla",
  "leah",
  "lily",
  "linda",
  "lisa",
  "luna",
  "madison",
  "megan",
  "mia",
  "michelle",
  "mila",
  "molly",
  "morgan",
  "natalie",
  "nicole",
  "olivia",
  "paige",
  "rachel",
  "rebecca",
  "riley",
  "rose",
  "ruby",
  "sadie",
  "samantha",
  "sarah",
  "savannah",
  "scarlett",
  "sophia",
  "sophie",
  "stella",
  "taylor",
  "victoria",
  "violet",
  "zoe",
  // fantasy/anime common names
  "deku",
  "bakugo",
  "izuku",
  "katsuki",
  "shoto",
  "ochaco",
  "uraraka",
  "todoroki",
  "midoriya",
  "naruto",
  "sasuke",
  "sakura",
  "kakashi",
  "itachi",
  "luffy",
  "zoro",
  "nami",
  "goku",
  "vegeta",
  "geralt",
  "ciri",
  "yennefer",
  "link",
  "zelda",
  "cloud",
  "tifa",
  "aerith",
  "sephiroth",
]);

// ── Analyzer helpers ───────────────────────────────────────

function stripMarkup(text) {
  if (!text) return "";
  return text
    .replace(/(?:```|~~~)\w*[\s\S]*?(?:```|~~~)/g, " ")
    .replace(/<([^>]+)>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+\/>/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/(?:\*|_|~|`)+(.+?)(?:\*|_|~|`)+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function generateNgrams(words, n) {
  const out = [];
  for (let i = 0; i <= words.length - n; i++) {
    out.push(words.slice(i, i + n).join(" "));
  }
  return out;
}

function isLowQuality(phrase, userWhitelist) {
  const words = phrase.toLowerCase().split(" ");
  if (words.length < 3) return true;
  if (words.some((w) => DEFAULT_NAMES.has(w) || userWhitelist.has(w)))
    return true;
  if (words.every((w) => COMMON_WORDS.has(w))) return true;
  return false;
}

function getBlacklistWeight(phrase, blacklist) {
  const lower = phrase.toLowerCase();
  let max = 0;
  for (const [term, weight] of Object.entries(blacklist)) {
    if (lower.includes(term)) max = Math.max(max, weight);
  }
  return max;
}

// ── Core analysis ──────────────────────────────────────────

function analyzeText(text, state, config) {
  const clean = stripMarkup(text);
  if (!clean.trim()) return state;

  const userWhitelist = new Set(
    (config.whitelist || []).map((w) => w.toLowerCase()),
  );
  const sentences = clean.match(/[^.!?]+[.!?]+["']?/g) || [clean];

  for (const sentence of sentences) {
    if (!sentence.trim()) continue;
    const isDialogue = /["']/.test(sentence.trim().substring(0, 10));
    const words = sentence
      .replace(/[.,!?]/g, "")
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    const lemmas = words.map((w) => LEMMA_MAP.get(w) || w);

    for (let n = 3; n <= config.ngramMax; n++) {
      if (words.length < n) continue;
      const origNgrams = generateNgrams(words, n);
      const lemNgrams = generateNgrams(lemmas, n);

      for (let i = 0; i < origNgrams.length; i++) {
        const orig = origNgrams[i];
        const lem = lemNgrams[i];
        if (isLowQuality(orig, userWhitelist)) continue;

        const cur = state.ngramFrequencies[lem] || {
          count: 0,
          score: 0,
          last: 0,
          original: orig,
        };
        let inc = 1.0;
        inc += (n - 3) * 0.2;
        const uncommon = orig
          .split(" ")
          .filter((w) => !COMMON_WORDS.has(w)).length;
        inc += uncommon * 0.5;
        inc += getBlacklistWeight(orig, config.blacklist || {});
        if (!isDialogue) inc *= 1.25;

        state.ngramFrequencies[lem] = {
          count: cur.count + 1,
          score: cur.score + inc,
          last: state.totalMessages,
          original: orig,
        };
      }
    }
  }

  state.totalMessages++;

  // Apply decay periodically
  if (state.totalMessages % config.decayInterval === 0) {
    applyDecay(state, config);
  }

  return state;
}

function applyDecay(state, config) {
  const mult = 1 - config.decayRate / 100;
  for (const [key, data] of Object.entries(state.ngramFrequencies)) {
    const age = state.totalMessages - data.last;
    const cycles = Math.floor(age / config.decayInterval);
    if (cycles > 0) {
      state.ngramFrequencies[key].score *= Math.pow(mult, cycles);
    }
  }
}

// ── Slop list builder ──────────────────────────────────────

function buildSlopList(state, config) {
  const threshold = config.slopThreshold;
  const entries = Object.values(state.ngramFrequencies)
    .filter((d) => d.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  // Simple substring culling — remove shorter phrases contained in higher-scoring longer ones
  const kept = [];
  for (const entry of entries) {
    const dominated = kept.some(
      (k) =>
        k.original.includes(entry.original) && k.score >= entry.score * 0.8,
    );
    if (!dominated) kept.push(entry);
  }

  return kept.slice(0, config.maxInjected).map((e) => e.original);
}

// ── Pipeline hooks ─────────────────────────────────────────

function transformRequest(payload) {
  const config = loadConfig();
  if (!config.enabled || !config.injectSlop) return payload;

  const state = loadState();
  const slopList = buildSlopList(state, config);
  if (!slopList.length) return payload;

  const note = `[Style note: Avoid repeating these overused phrases: ${slopList.join("; ")}]`;

  // Inject into the last system message, or prepend a new one
  const messages = payload.messages || [];
  const lastSys = [...messages].reverse().find((m) => m.role === "system");

  if (lastSys) {
    if (Array.isArray(lastSys.content)) {
      lastSys.content.push({ type: "text", text: note });
    } else {
      lastSys.content = (lastSys.content || "") + "\n\n" + note;
    }
  } else {
    messages.unshift({ role: "system", content: note });
  }

  return { ...payload, messages };
}

function transformResponse(responseBody) {
  const config = loadConfig();
  if (!config.enabled) return responseBody;

  const text =
    responseBody?.choices?.[0]?.message?.content ??
    responseBody?.content?.[0]?.text ??
    null;

  if (typeof text !== "string") return responseBody;

  const state = loadState();
  const updated = analyzeText(text, state, config);
  saveState(updated);

  return responseBody;
}

// change the existing module.exports line to:
module.exports = {
  name: "Prose Polisher",
  version: "1.0",
  priority: 40,
  transformRequest,
  transformResponse,
};
