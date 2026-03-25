// ============================================================
// extensions/prose-polisher.js — Slop detection & injection
// v2.0 — Per-character n-gram tracking
//
// Each character gets their own n-gram pool. The global pool
// tracks scene-level/environmental repetition shared across all
// characters. Style notes injected into the prompt are labeled
// per character so the model knows whose voice to vary.
// ============================================================

const fs   = require("fs");
const path = require("path");

const CONFIG_FILE = path.join(__dirname, "../data/prose-polisher-config.json");
const STATE_FILE  = path.join(__dirname, "../data/prose-polisher-state.json");

// ── Default config ─────────────────────────────────────────

const DEFAULT_CONFIG = {
  enabled:          true,
  ngramMax:         10,
  slopThreshold:    3.0,
  decayRate:        10,       // % decay per interval
  decayInterval:    10,       // messages between decay applications
  patternMinCommon: 3,        // min shared prefix words to merge patterns
  injectSlop:       true,     // inject slop list into outgoing prompts
  maxInjected:      10,       // max phrases to inject per character
  maxCharsInjected: 5,        // max characters to inject style notes for
  whitelist:        [],
  blacklist:        {},       // { "phrase": weight }
};

// ── Persistence ────────────────────────────────────────────

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return { ...DEFAULT_CONFIG };
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

/**
 * Load state. Automatically migrates old flat format to new per-character format.
 * Old: { ngramFrequencies: {}, totalMessages: 0 }
 * New: { chars: { charName: { ngramFrequencies: {}, totalMessages: 0 } }, global: { ... } }
 */
function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return freshState();
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));

    // ── Migration: old flat format ──
    if (raw.ngramFrequencies !== undefined) {
      console.log("[prose-polisher] Migrating state to per-character format...");
      const migrated = freshState();
      migrated.global = {
        ngramFrequencies: raw.ngramFrequencies || {},
        totalMessages:    raw.totalMessages    || 0,
      };
      saveState(migrated);
      return migrated;
    }

    // Ensure both keys exist in case state was partially written
    if (!raw.chars)  raw.chars  = {};
    if (!raw.global) raw.global = freshCharState();
    return raw;
  } catch {
    return freshState();
  }
}

function freshCharState() {
  return { ngramFrequencies: {}, totalMessages: 0 };
}

function freshState() {
  return { chars: {}, global: freshCharState() };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state), "utf8");
  } catch (e) {
    console.warn("[prose-polisher] Failed to save state:", e.message);
  }
}

// ── Character name extraction ──────────────────────────────
// Reuses the same patterns as rag.js so both extensions
// agree on who is speaking in a given reply.

const PRONOUN_BLOCKLIST = new Set([
  "he", "she", "they", "it", "his", "her", "their", "its",
  "him", "them", "we", "us", "our", "my", "your", "i",
  "the", "a", "an", "this", "that", "these", "those",
  "one", "two", "three", "then", "when", "where", "what",
]);

/**
 * Extract all unique character names from a reply.
 * @param {string}      replyText
 * @param {string|null} userName   — user's character name (blocklisted)
 * @returns {string[]}
 */
function extractAllCharNames(replyText, userName) {
  if (!replyText) return [];
  const found = new Set();

  const lines = replyText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^[-—*#\[]+$/.test(l));

  for (const line of lines) {
    const clean = line.replace(/^\*+/, "").replace(/\[.*?\]/g, "").trim();

    // Possessive: "Kurt's jaw tightened"
    for (const m of clean.matchAll(/\b([A-Z][a-z]{1,20})'s\b/g)) {
      const name = m[1].toLowerCase();
      if (name !== userName && !PRONOUN_BLOCKLIST.has(name)) found.add(name);
    }

    // Action verb: "Kurt stepped forward"
    for (const m of clean.matchAll(
      /\b([A-Z][a-z]{1,20})\s+(?:stepped|turned|said|looked|felt|moved|stood|walked|ran|smiled|frowned|crossed|glanced|stared|grabbed|reached|spoke|asked|replied|growled|snapped|sighed|laughed|narrowed|clenched|exhaled|inhaled|shrugged|nodded|shook|leaned|pulled|pushed|dropped|raised|lowered|tilted|pressed|placed|held|kept|let|made|gave|took|came|went|sat|lay|rose|fell|spun|jerked|flinched|tensed|relaxed|watched|waited|paused|stopped|started|opened|closed|shifted|backed|stretched|twisted|arched|curled|spread|folded)\b/g,
    )) {
      const name = m[1].toLowerCase();
      if (name !== userName && !PRONOUN_BLOCKLIST.has(name)) found.add(name);
    }

    // Dialogue attribution: `"text," Kurt said`
    for (const m of clean.matchAll(/["'][^"']+["']\s*[,.]?\s*([A-Z][a-z]{1,20})\b/g)) {
      const name = m[1].toLowerCase();
      if (name !== userName && !PRONOUN_BLOCKLIST.has(name)) found.add(name);
    }
  }

  return [...found];
}

// ── Bundled data ───────────────────────────────────────────

const COMMON_WORDS = new Set([
  "the","of","to","and","a","in","is","it","you","that","he","was","for","on",
  "are","with","as","his","they","be","at","one","have","this","from","or","had",
  "by","not","but","what","some","we","can","out","other","were","all","there",
  "when","up","use","your","how","said","an","each","she","which","do","their",
  "time","if","will","way","about","many","then","them","would","like","so",
  "these","her","long","make","see","him","two","has","look","more","day",
  "could","go","come","did","no","most","people","my","over","know","than",
  "call","first","who","may","down","been","now","find","any","new","work",
  "part","take","get","place","made","live","where","after","back","little",
  "only","man","year","came","show","every","good","me","give","our","under",
  "name","very","through","just","think","say","help","turn","much","mean",
  "before","move","right","old","too","same","tell","does","set","want","well",
  "also","play","small","end","put","home","read","hand","large","even","here",
  "must","big","high","such","follow","why","ask","change","went","light","off",
  "need","house","try","us","again","point","should","found","keep","eye",
  "never","last","let","thought","left","late","run","while","close","night",
  "real","life","few","open","seem","together","next","white","begin","got",
  "walk","both","often","until","second","book","carry","took","eat","room",
  "began","idea","stop","once","hear","cut","sure","watch","face","main",
  "enough","feel","talk","soon","body","door","short","wind","happen","half",
  "order","fire","since","top","whole","heard","best","hour","better","true",
  "during","remember","early","hold","ground","reach","fast","morning","simple",
  "toward","lay","against","slow","love","person","appear","road","rule","pull",
  "cold","notice","voice","power","town","fine","certain","fly","fall","lead",
  "cry","dark","note","wait","plan","star","field","rest","able","done","drive",
  "stood","front","teach","week","gave","green","quick","warm","free","minute",
  "strong","mind","behind","clear","fact","street","nothing","course","stay",
  "full","force","blue","object","deep","moon","foot","busy","test","boat",
  "common","possible","dry","wonder","ago","ran","check","game","shape","hot",
  "miss","brought","heat","snow","bring","yes","fill","east","among","ball",
  "yet","wave","drop","heart","present","heavy","arm","wide","size","vary",
  "speak","weight","matter","circle","include","felt","perhaps","pick","count",
  "reason","length","bed","brother","egg","ride","sit","race","window","store",
  "summer","train","sleep","leg","wall","catch","wish","sky","board","joy",
  "winter","sat","wild","kept","glass","grass","job","edge","sign","past",
  "soft","fun","bright","weather","month","bear","finish","happy","hope",
  "flower","jump","baby","meet","root","buy","raise","bone","rail","imagine",
  "provide","agree","chair","fruit","rich","thick","process","guess","sharp",
  "wing","create","wash","crowd","compare","string","bell","meat","tube",
  "famous","stream","fear","sight","thin","planet","hurry","clock","mine",
  "tie","enter","fresh","search","send","allow","print","dead","spot","suit",
  "current","lift","rose","block","hat","sell","swim","term","wife","shoe",
  "shoulder","spread","camp","born","level","chance","gather","shop","throw",
  "shine","column","select","wrong","gray","repeat","require","broad","prepare",
  "salt","nose","anger","claim","oxygen","death","pretty","skill","season",
  "silver","thank","branch","match","afraid","huge","steel","discuss","forward",
  "similar","score","bought","coat","mass","card","band","rope","slip","win",
  "dream","evening","tool","total","basic","smell","seat","arrive","master",
  "track","parent","shore","sheet","post","spend","fat","glad","share",
  "station","dad","bread","charge","bar","offer","duck","instant","degree",
  "dear","enemy","reply","drink","occur","support","speech","nature","range",
  "steam","motion","path","liquid","meant","teeth","shell","neck",
]);

const LEMMA_MAP = new Map([
  ["is","be"],["was","be"],["are","be"],["were","be"],["being","be"],["been","be"],
  ["looked","look"],["looks","look"],["looking","look"],
  ["smiled","smile"],["smiles","smile"],["smiling","smile"],
  ["seemed","seem"],["seems","seem"],["seeming","seem"],
  ["felt","feel"],["feels","feel"],["feeling","feel"],
  ["said","say"],["says","say"],["saying","say"],
  ["went","go"],["goes","go"],["going","go"],
  ["had","have"],["has","have"],["having","have"],
  ["did","do"],["does","do"],["doing","do"],
  ["knew","know"],["knows","know"],["knowing","know"],
  ["took","take"],["takes","take"],["taking","take"],
  ["saw","see"],["sees","see"],["seeing","see"],
  ["came","come"],["comes","come"],["coming","come"],
  ["thought","think"],["thinks","think"],["thinking","think"],
  ["gave","give"],["gives","give"],["giving","give"],
  ["told","tell"],["tells","tell"],["telling","tell"],
  ["made","make"],["makes","make"],["making","make"],
  ["used","use"],["uses","use"],["using","use"],
  ["wanted","want"],["wants","want"],["wanting","want"],
  ["asked","ask"],["asks","ask"],["asking","ask"],
  ["tried","try"],["tries","try"],["trying","try"],
  ["called","call"],["calls","call"],["calling","call"],
  ["turned","turn"],["turns","turn"],["turning","turn"],
  ["started","start"],["starts","start"],["starting","start"],
  ["moved","move"],["moves","move"],["moving","move"],
  ["lived","live"],["lives","live"],["living","live"],
  ["happened","happen"],["happens","happen"],["happening","happen"],
  ["sat","sit"],["sits","sit"],["sitting","sit"],
  ["stood","stand"],["stands","stand"],["standing","stand"],
  ["lost","lose"],["loses","lose"],["losing","lose"],
  ["fell","fall"],["falls","fall"],["falling","fall"],
  ["reached","reach"],["reaches","reach"],["reaching","reach"],
  ["remained","remain"],["remains","remain"],["remaining","remain"],
  ["appeared","appear"],["appears","appear"],["appearing","appear"],
  ["waited","wait"],["waits","wait"],["waiting","wait"],
  ["watched","watch"],["watches","watch"],["watching","watch"],
  ["followed","follow"],["follows","follow"],["following","follow"],
  ["stopped","stop"],["stops","stop"],["stopping","stop"],
  ["walked","walk"],["walks","walk"],["walking","walk"],
  ["loved","love"],["loves","love"],["loving","love"],
  ["eyes","eye"],["years","year"],["ways","way"],["days","day"],
  ["hands","hand"],["words","word"],["things","thing"],["times","time"],
  ["lips","lip"],["cheeks","cheek"],["shoulders","shoulder"],
  ["arms","arm"],["legs","leg"],["fingers","finger"],
  ["thoughts","thought"],["moments","moment"],["steps","step"],
  ["voices","voice"],["rooms","room"],["doors","door"],
  ["walls","wall"],["tears","tear"],["fears","fear"],
  ["hopes","hope"],["dreams","dream"],
]);

const DEFAULT_NAMES = new Set([
  "aaron","adam","alex","alexander","andrew","anthony","arthur","ben","benjamin",
  "bob","brandon","brian","caleb","cameron","charles","charlie","chris",
  "christopher","daniel","david","dylan","edward","eli","elijah","eric","ethan",
  "evan","felix","frank","gabriel","george","harry","henry","hunter","ian",
  "isaac","jack","jackson","jacob","jake","james","jason","jeremy","jesse","joe",
  "john","jonathan","jordan","joseph","joshua","julian","justin","kevin","kyle",
  "leo","levi","liam","lincoln","logan","lucas","luke","marcus","mark","mason",
  "matthew","max","michael","miles","nathan","nicholas","nick","noah","nolan",
  "oliver","owen","patrick","paul","peter","robert","ryan","sam","samuel",
  "scott","sean","sebastian","seth","thomas","timothy","tyler","victor",
  "vincent","will","william","zachary","abigail","alexis","alice","allison",
  "amanda","amber","amelia","amy","anna","aria","ariana","ashley","ava","avery",
  "bella","brianna","brooke","camila","charlotte","chloe","claire","courtney",
  "diana","elena","elizabeth","ella","emily","emma","eva","evelyn","faith",
  "grace","hailey","hannah","harper","hazel","isabella","jade","jessica","julia",
  "katie","kayla","kelly","laura","lauren","layla","leah","lily","linda","lisa",
  "luna","madison","megan","mia","michelle","mila","molly","morgan","natalie",
  "nicole","olivia","paige","rachel","rebecca","riley","rose","ruby","sadie",
  "samantha","sarah","savannah","scarlett","sophia","sophie","stella","taylor",
  "victoria","violet","zoe",
  // fantasy/anime
  "deku","bakugo","izuku","katsuki","shoto","ochaco","uraraka","todoroki",
  "midoriya","naruto","sasuke","sakura","kakashi","itachi","luffy","zoro","nami",
  "goku","vegeta","geralt","ciri","yennefer","link","zelda","cloud","tifa",
  "aerith","sephiroth",
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
  if (words.some((w) => DEFAULT_NAMES.has(w) || userWhitelist.has(w))) return true;
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

/**
 * Analyze text and update a single charState pool.
 * @param {string} text
 * @param {object} charState  — { ngramFrequencies, totalMessages }
 * @param {object} config
 * @returns {object} updated charState
 */
function analyzeText(text, charState, config) {
  const clean = stripMarkup(text);
  if (!clean.trim()) return charState;

  const userWhitelist = new Set((config.whitelist || []).map((w) => w.toLowerCase()));
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
      const lemNgrams  = generateNgrams(lemmas, n);

      for (let i = 0; i < origNgrams.length; i++) {
        const orig = origNgrams[i];
        const lem  = lemNgrams[i];
        if (isLowQuality(orig, userWhitelist)) continue;

        const cur = charState.ngramFrequencies[lem] || {
          count: 0, score: 0, last: 0, original: orig,
        };

        let inc = 1.0;
        inc += (n - 3) * 0.2;
        const uncommon = orig.split(" ").filter((w) => !COMMON_WORDS.has(w)).length;
        inc += uncommon * 0.5;
        inc += getBlacklistWeight(orig, config.blacklist || {});
        if (!isDialogue) inc *= 1.25;

        charState.ngramFrequencies[lem] = {
          count:    cur.count + 1,
          score:    cur.score + inc,
          last:     charState.totalMessages,
          original: orig,
        };
      }
    }
  }

  charState.totalMessages++;

  if (charState.totalMessages % config.decayInterval === 0) {
    applyDecay(charState, config);
  }

  return charState;
}

function applyDecay(charState, config) {
  const mult = 1 - config.decayRate / 100;
  for (const data of Object.values(charState.ngramFrequencies)) {
    const age    = charState.totalMessages - data.last;
    const cycles = Math.floor(age / config.decayInterval);
    if (cycles > 0) data.score *= Math.pow(mult, cycles);
  }
}

// ── Slop list builder ──────────────────────────────────────

function buildSlopList(charState, config) {
  const entries = Object.values(charState.ngramFrequencies)
    .filter((d) => d.score >= config.slopThreshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);

  const kept = [];
  for (const entry of entries) {
    const dominated = kept.some(
      (k) => k.original.includes(entry.original) && k.score >= entry.score * 0.8,
    );
    if (!dominated) kept.push(entry);
  }

  return kept.slice(0, config.maxInjected).map((e) => e.original);
}

// ── Pending state ──────────────────────────────────────────
// Carries known char names from transformRequest → transformResponse.

let _pending = null;

// ── Pipeline hooks ─────────────────────────────────────────

function transformRequest(payload) {
  const config = loadConfig();
  if (!config.enabled || !config.injectSlop) return payload;

  const state    = loadState();
  const messages = payload.messages || [];

  // Build per-character style notes
  const notes = [];

  // Known characters from previous turns (stashed in _pending by last transformResponse)
  const knownChars = _pending?.lastCharNames ?? [];

  // Inject per-character notes (capped at maxCharsInjected)
  const charsToInject = knownChars.slice(0, config.maxCharsInjected ?? 5);
  for (const charName of charsToInject) {
    const charState = state.chars[charName];
    if (!charState) continue;
    const slopList = buildSlopList(charState, config);
    if (slopList.length > 0) {
      notes.push(
        `[Style note for ${charName}: avoid repeating — ${slopList.join("; ")}]`,
      );
    }
  }

  // Global scene-level note
  const globalSlop = buildSlopList(state.global, config);
  if (globalSlop.length > 0) {
    notes.push(`[Style note (scene): avoid repeating — ${globalSlop.join("; ")}]`);
  }

  if (notes.length === 0) return payload;

  const note = notes.join("\n");

  // Inject into the last system message
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

  // Extract all character names from this reply
  const charNames = extractAllCharNames(text, null);

  if (charNames.length > 0) {
    console.log(`[prose-polisher] Analyzing reply for: ${charNames.join(", ")}`);

    // Analyze text once per character found in this reply
    for (const charName of charNames) {
      if (!state.chars[charName]) {
        state.chars[charName] = freshCharState();
        console.log(`[prose-polisher] New character pool created: ${charName}`);
      }
      state.chars[charName] = analyzeText(text, state.chars[charName], config);
    }
  } else {
    console.log("[prose-polisher] No character names found — analyzing into global pool");
  }

  // Always analyze into global pool for scene-level tracking
  state.global = analyzeText(text, state.global, config);

  saveState(state);

  // Stash char names for next transformRequest
  _pending = {
    lastCharNames: [
      ...new Set([...(_pending?.lastCharNames ?? []), ...charNames]),
    ],
  };

  return responseBody;
}

module.exports = {
  name:              "Prose Polisher",
  version:           "2.0",
  priority:          40,
  transformRequest,
  transformResponse,
};