# Extensions

This document describes how the Kiana Proxy extension system works, how to write a new extension, and provides a reference for all built-in extensions.

---

## Table of Contents

- [How It Works](#how-it-works)
- [Extension Lifecycle](#extension-lifecycle)
- [Writing an Extension](#writing-an-extension)
  - [Minimal Template](#minimal-template)
  - [Full Template](#full-template)
  - [Hook Signatures](#hook-signatures)
  - [Config Persistence](#config-persistence)
  - [Registering a Router](#registering-a-router)
- [Priority Ordering](#priority-ordering)
- [Auto-Discovery & Hot-Reload](#auto-discovery--hot-reload)
- [Extension Reference](#extension-reference)
  - [ooc.js](#oocjs)
  - [regex.js](#regexjs)
  - [rag.js](#ragjs)
  - [tunnelvision.js](#tunnelvisionjs)
  - [samplers.js](#samplersjs)
  - [prose-polisher.js](#prose-polisherjs)
  - [recast.js](#recastjs)

---

## How It Works

Every `.js` file placed in the `extensions/` folder is automatically loaded when the proxy starts. Extensions can hook into the request/response pipeline, register their own Express routes, and persist configuration to `data/`.

The proxy scans `extensions/` at startup, sorts by priority, and mounts any routers before the main proxy endpoint. If a file fails to load, it is skipped with a warning — it will not crash the proxy.

---

## Extension Lifecycle

```
JanitorAI → POST /v1/chat/completions
               ↓
         injectPrompt()       (strip JanitorAI instructions, inject custom prompt)
               ↓
         transformRequest     (3-phase pipeline)
           Phase 1: priority < 25 (ooc)
           Phase 2: RAG + TunnelVision in parallel
           Phase 3: priority >= 25, excl. RAG/TV (samplers, prose-polisher, recast)
               ↓
         OpenRouter API call (+ TunnelVision tool loop if active)
               ↓
         transformResponse    (all extensions, priority order)
               ↓
         res.json → JanitorAI
```

Each hook is `async` and receives the full payload/response. If a hook throws, the error is caught and logged — the pipeline continues with the previous value unchanged.

**Important:** RAG and TunnelVision run in parallel during Phase 2. RAG modifies messages (system prompt content) while TunnelVision adds tools. Results are merged: messages from RAG, tools from TunnelVision.

---

## Writing an Extension

### Minimal Template

```js
// extensions/my-extension.js
module.exports = {
  name:     'My Extension',
  version:  '1.0',
  priority: 50,
};
```

This is a valid (no-op) extension. It will appear in the dashboard's Extensions panel.

---

### Full Template

```js
// extensions/my-extension.js
const express = require('express');
const fs      = require('fs');
const path    = require('path');

const router      = express.Router();
const CONFIG_PATH = path.join(__dirname, '../data/my-extension-config.json');

const DEFAULT_CONFIG = {
  enabled: true,
  someOption: 42,
};

let _configCache = null;

function loadConfig() {
  if (_configCache) return _configCache;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      _configCache = { ...DEFAULT_CONFIG, ...saved };
      return _configCache;
    }
  } catch (e) {
    console.warn('[my-extension] Failed to load config:', e.message);
  }
  _configCache = { ...DEFAULT_CONFIG };
  return _configCache;
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  _configCache = config; // keep cache warm
}

// ── Hooks ──────────────────────────────────────────────────

async function transformRequest(payload) {
  const config = loadConfig();
  if (!config.enabled) return payload;

  // Modify payload.messages, payload.model, etc.
  // Must return the (modified) payload object.
  // Never mutate the original — return { ...payload, ... }
  return payload;
}

async function transformResponse(data) {
  const config = loadConfig();
  if (!config.enabled) return data;

  // Modify data.choices[0].message.content, etc.
  // Must return the (modified) data object.
  // Never mutate the original — return a new object.
  return data;
}

// ── Router ─────────────────────────────────────────────────
// Mounted at /extensions/my-extension/*

router.get('/status', (req, res) => {
  res.json({ ok: true, config: loadConfig() });
});

router.post('/config', (req, res) => {
  try {
    const updated = { ...loadConfig(), ...req.body };
    saveConfig(updated);
    res.json({ ok: true, config: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Export ─────────────────────────────────────────────────

module.exports = {
  name:              'My Extension',
  version:           '1.0',
  priority:          50,
  router,            // optional — omit if no routes needed
  transformRequest,  // optional — omit if not hooking requests
  transformResponse, // optional — omit if not hooking responses
};
```

---

### Hook Signatures

#### `transformRequest(payload) → payload`

Called before the request is sent to OpenRouter. Receives and must return the full OpenRouter-compatible request payload.

```js
// payload shape
{
  model:    string,           // e.g. 'anthropic/claude-opus-4-6'
  messages: Array<{
    role:    'system' | 'user' | 'assistant',
    content: string | Array,  // may be string or content block array
  }>,
  stream:   false,            // always forced off by the proxy
  // ...any other OpenRouter params
}
```

Common uses: inject system prompt additions, modify messages, add sampler params, prepend context.

**Important:** Never mutate the incoming payload directly. Always return a new object: `return { ...payload, messages: newMessages }`.

#### `transformResponse(data) → data`

Called after a successful response from OpenRouter (after all tool loop rounds for TunnelVision). Receives and must return the full OpenAI-compatible response object.

```js
// data shape
{
  choices: [{
    message: {
      role:    'assistant',
      content: string,
    },
    finish_reason: string,
  }],
  usage: {
    prompt_tokens:     number,
    completion_tokens: number,
    total_tokens:      number,
    prompt_tokens_details: { cached_tokens: number },
  },
}
```

Common uses: post-process reply text (regex, stripping tags), index turn data, update state.

**Important:** Never mutate the incoming data directly. Return a new object with spread syntax.

---

### Config Persistence

Store config in `data/<your-extension>-config.json`. Use a `DEFAULT_CONFIG` object and merge saved values over it so new keys are always available after updates:

```js
const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
return { ...DEFAULT_CONFIG, ...saved }; // saved values win, new defaults fill gaps
```

**Best practices:**
- Cache config in memory (`_configCache`) to avoid disk reads per request
- After saving, set `_configCache = config` to keep the cache warm (avoids unnecessary re-read)
- Use `fs.writeFile` (async) for writes that happen in the request hot path
- Use `fs.writeFileSync` only for config saves from dashboard routes (where the response depends on the write completing)

---

### Registering a Router

Export a `router` property. It will be auto-mounted at `/extensions/<filename-without-.js>/`.

```js
// extensions/my-extension.js → routes at /extensions/my-extension/*
module.exports = { ..., router };
```

Standard Express router — use `router.get`, `router.post`, `router.put`, `router.delete` as normal.

---

## Priority Ordering

Lower number = runs earlier in the pipeline.

| Priority | Extension         | Phase |
|----------|-------------------|-------|
| 10       | ooc.js            | 1 (pre-RAG/TV) |
| 20       | regex.js          | 1 (pre-RAG/TV, response only) |
| 25       | rag.js            | 2 (parallel) |
| 26       | tunnelvision.js   | 2 (parallel) |
| 30       | samplers.js       | 3 (post-RAG/TV) |
| 40       | prose-polisher.js | 3 (post-RAG/TV) |
| 45       | recast.js         | 3 (post-RAG/TV) |

**transformRequest** runs in 3 phases:
- Phase 1: priority < 25 (before RAG/TV)
- Phase 2: RAG (25) + TunnelVision (26) in parallel
- Phase 3: priority >= 25, excluding RAG/TV

**transformResponse** runs in standard priority order (lowest first).

Pick a priority that makes sense relative to others. Leave gaps between values so you can insert new extensions without renumbering.

---

## Auto-Discovery & Hot-Reload

The proxy watches the `extensions/` folder using `fs.watch`. If any `.js` file changes, all extensions are reloaded after a 5-second debounce. No restart required for extension code changes.

The dashboard's **Settings → Proxy Controls → Restart** also triggers a full reload and bundle rebuild.

---

## Extension Reference

### ooc.js

**Priority:** 10 | **Hooks:** `transformRequest`

Handles out-of-character (OOC) messages from JanitorAI. Detects `(OOC: ...)` patterns in the last user message, strips them from context, and injects all commands as a single temporary system instruction. Multiple OOC commands in one message are combined with semicolons.

**Config file:** none  
**Routes:** none

---

### regex.js

**Priority:** 20 | **Hooks:** `transformResponse` | **Routes:** `/extensions/regex/*`

SillyTavern-compatible regex post-processor. Runs an ordered list of find/replace rules against every AI reply after generation. In-memory script cache with dirty flag (no disk read per response).

**Config file:** `data/regex-scripts.json`

```js
// Script shape
{
  id:            string,   // timestamp-based unique ID
  description:   string,   // human-readable label
  findRegex:     string,   // regex pattern (or /pattern/flags format)
  replaceString: string,   // replacement string, supports $1 capture groups + {{match}}
  flags:         string,   // regex flags e.g. 'g', 'gi'
  trimStrings:   boolean,  // trim whitespace from result
  enabled:       boolean,
  stopOnMatch:   boolean,  // stop chain when this script fires
  dryRun:        boolean,  // log matches without applying
  tags:          string[], // group tags for bulk enable/disable
}
```

**Features:**
- Test-before-apply (skip scripts that don't match)
- `stopOnMatch` flag to halt the chain
- `dryRun` mode for debugging
- Per-script hit counters (in-memory, visible in dashboard)
- Group enable/disable by tag
- SillyTavern JSON import/export compatibility

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/scripts`          | List all scripts (with live hit counts) |
| `POST`   | `/scripts`          | Create a new script |
| `PUT`    | `/scripts/:id`      | Update a script |
| `DELETE` | `/scripts/:id`      | Delete a script |
| `POST`   | `/reorder`          | Reorder scripts by ID array |
| `POST`   | `/test`             | Test a single script against input |
| `POST`   | `/test-all`         | Run all enabled scripts against input |
| `POST`   | `/import`           | Import array of scripts (ST JSON compatible) |
| `GET`    | `/export`           | Download scripts as JSON file |
| `POST`   | `/group/:tag/enable`  | Bulk enable all scripts with tag |
| `POST`   | `/group/:tag/disable` | Bulk disable all scripts with tag |
| `GET`    | `/counters`           | Live per-script hit counts |
| `POST`   | `/counters/reset`     | Reset all hit counters |

---

### rag.js

**Priority:** 25 | **Hooks:** `transformRequest`, `transformResponse` | **Routes:** `/extensions/rag/*`

Semantic memory via Qdrant + Ollama. Indexes every conversation turn as a 1024-dim vector embedding. Before each request retrieves the most relevant past turns and injects them into the system prompt as `[Relevant Memory Context]`.

Scoring pipeline: cosine similarity → temporal decay → keyword boost → emotion boost → conditional rules → dedup.

**Config file:** `data/rag-config.json`

```js
// Config shape
{
  enabled:           boolean,  // master on/off switch
  qdrantUrl:         string,   // e.g. 'http://192.168.1.192:6333'
  ollamaUrl:         string,   // e.g. 'http://192.168.1.193:11434'
  ollamaModel:       string,   // e.g. 'mxbai-embed-large'
  collectionPrefix:  string,   // Qdrant collection prefix, default 'rag_'
  topK:              number,   // max chunks to inject
  queryDepth:        number,   // recent user messages used as query
  scoreThreshold:    number,   // minimum similarity score (0–1)
  decayEnabled:      boolean,
  decayHalfLife:     number,   // messages until relevance halves
  decayFloor:        number,   // minimum relevance after decay (0–1)
  decayMode:         'exponential' | 'linear',
  maxInjectionChars: number,   // shared budget across all character blocks
  emotionEnabled:    boolean,
  emotionBoost:      number,   // score boost when emotion matches (0–0.5)
  blindNextTurn:     boolean,  // if true, next indexed turn is decay-immune
  maxCollections:    number,   // auto-prune smallest when cap is hit (default 20)
  rules:             Array,    // conditional activation rules
}
```

**Emotion detection:** Injects an `<emotion>LABEL</emotion>` instruction into the system prompt. The tag is automatically extracted and stripped from the reply before JanitorAI sees it. Valid labels: `neutral, happy, sad, angry, fearful, tender, anxious, excited, surprised, disgusted`.

**Scene-aware retrieval:** Only characters from the last reply (`activeSceneChars`) are used for retrieval. Falls back to all known characters on first turn. User-mentioned characters that are already known are merged in.

**Cross-character linking:** When retrieved chunks mention other known characters (via `coCharacters` payload), those characters' memories are retrieved with reduced topK. Injection budget is shared across all blocks.

**Collection pruning:** When collections exceed `maxCollections`, the smallest (fewest points) are deleted automatically after indexing.

**Reroll detection:** If the user message is identical to the previous turn, indexing is skipped to avoid duplicate entries.

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/status`              | Config + live stats |
| `POST`   | `/config`              | Update config |
| `GET`    | `/collections`         | List Qdrant collections with point counts |
| `DELETE` | `/collections/:name`   | Clear a character's memory |
| `POST`   | `/blind-next`          | Mark next turn as temporally blind |

---

### tunnelvision.js

**Priority:** 26 | **Hooks:** `transformRequest` | **Routes:** `/extensions/tunnelvision/*`

Hierarchical lorebook memory via real Claude tool calls. Maintains a tree of knowledge nodes (channels) and entries per bot character. Claude can search, read, create, update, merge, split, reorganize, and summarize entries during generation via a tool loop (up to 6 rounds per request).

**Config file:** `data/tunnelvision-config.json`

```js
{
  enabled:            boolean,
  activeTree:         string | null,  // override tree name (null = auto-detect)
  autoDetect:         boolean,        // extract bot name from system prompt
  injectContext:      boolean,
  maxContextChars:    number,
  searchMode:         'auto' | 'collapsed' | 'traversal',
  traversalThreshold: number,         // node count threshold for traversal mode (default 15)
}
```

**Tree files:** `data/tunnelvision/<botname>.json` (one per character, auto-created)

**Tool loop flow:**
1. `primeTreeName()` called from `index.js` before extension pipeline
2. `transformRequest` loads tree, injects tool definitions
3. `wrapSendWithToolLoop()` replaces `sendToOpenRouter()` — runs up to 6 tool rounds
4. Each round: send to OpenRouter → extract tool calls → execute against tree → append results → repeat
5. Final round: forces `tool_choice: "none"` for narrative response

**Model override:** If `tunnelvisionOpenRouterModel` is set in `data/local-models-config.json`, tool calls use that model via a custom `sendFn` that bypasses account-level provider preferences.

**8 Tools:** Search, Remember, Update, Forget, Summarize, Notebook, MergeSplit, Reorganize

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/status`                    | Config + active tree stats |
| `POST`   | `/config`                    | Update config |
| `GET`    | `/trees`                     | List all trees with stats |
| `GET`    | `/tree/:name`                | Get full tree data |
| `GET`    | `/tree/:name/overview`       | Get tree overview text |
| `DELETE` | `/tree/:name`                | Delete a tree |
| `POST`   | `/tree/:name/node`           | Add a channel node |
| `GET`    | `/tree/:name/diagnostics`    | Run diagnostic checks |
| `POST`   | `/tree/:name/diagnostics`    | Run diagnostic checks (POST alias) |

---

### samplers.js

**Priority:** 30 | **Hooks:** `transformRequest` | **Routes:** `/extensions/samplers/*`

Model-aware sampler controls. Applies enabled sampler parameters (Top P, Top K, Min P, penalties) to outgoing requests. Claude via OpenRouter only supports Top P and Top K — unsupported samplers are silently skipped.

**Config file:** `data/sampler-config.json`

```js
// Config shape — keyed by sampler name
{
  top_p:              { enabled: boolean, value: number },
  top_k:              { enabled: boolean, value: number },
  min_p:              { enabled: boolean, value: number },
  presence_penalty:   { enabled: boolean, value: number },
  frequency_penalty:  { enabled: boolean, value: number },
  repetition_penalty: { enabled: boolean, value: number },
}
```

**Model family detection:**
- `claude` / `anthropic` → only `top_p`, `top_k`, `presence_penalty`, `frequency_penalty`, `repetition_penalty`
- `gpt` / `openai` / `o1` / `o3` → full set
- Anything else → full set

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/config?model=...` | Get sampler defs + current config for a model family |
| `POST` | `/config`           | Save sampler config |

---

### prose-polisher.js

**Priority:** 40 | **Hooks:** `transformRequest`, `transformResponse`

Server-side repetition avoidance. Tracks n-grams (3 to `ngramMax` words) across responses with per-character pools and a global pool. Uses exponential decay to age out old patterns. Injects a style note listing overused phrases into the system prompt.

**Config file:** `data/prose-polisher-config.json`  
**State file:** `data/prose-polisher-state.json`

**Scoring factors per n-gram hit:**
- Base: `+1.0`
- Length bonus: `+(n-3) × 0.2` (longer phrases score higher)
- Uncommon word bonus: `+0.5` per word not in COMMON_WORDS
- Blacklist bonus: configurable per-phrase weights
- Not in dialogue: `×1.25` multiplier

**Features:**
- Per-character n-gram tracking (each character gets their own frequency map)
- Global pool for scene-wide patterns
- Session char accumulator with 30min TTL reset
- Lemmatization for common verbs/nouns (reduces false negatives)
- Low-quality filter (skips phrases with common names, all-common-words)
- Config and state cached in memory (async state writes)

**Routes:** none

---

### recast.js

**Priority:** 45 | **Hooks:** `transformRequest`, `transformResponse` | **Routes:** `/extensions/recast/*`

"The 4 Steps of Roleplay" — a background quality-control pipeline that runs after every AI response. Each step judges the fully post-processed reply with a fast YES/NO check call. On failure, a rewrite pass runs and the check repeats. A configurable retry cap prevents infinite loops.

Runs last in the pipeline (priority 45) so it checks the fully post-processed reply after all other extensions have had their turn.

**The 4 Steps:**

| Step | Name | Checks |
|------|------|--------|
| 1 | System Prompt Compliance | User sovereignty (no writing for user character), scene closure (no philosophical summaries), format (double quotes on dialogue) |
| 2 | Characters | Voice, speech patterns, personality consistency, proportional emotional reactions. Uses TunnelVision lorebook data if available. |
| 3 | World | Physical/causal coherence, no retcons, persistent environment, time/resource realism |
| 4 | Story Progression | Narrative momentum, no stagnation, no unearned intensity jumps, scene closure law |

**Check flow per step:**
```
Check (YES/NO) → PASS: increment streak, move to next step
              → FAIL: reset streak, Rewrite → Recheck → PASS: move on
                              → FAIL again: retry up to maxRetries, then pass through
```

**Consecutive pass streaks:** Steps that pass `skipAfterPasses` times in a row are auto-skipped. Streak resets on any failure.

**Local model support:** YES/NO checks can use local Ollama models (via `lib/local-models.js`) when `recastLocal: true`. Rewrites always use OpenRouter.

**TunnelVision integration:** Pulls character entries and story summaries from the active TunnelVision tree for step 2 (Characters) checks and rewrites.

**Reroll optimization:** Uses `reply-cache.js` to skip the entire recast pipeline on rerolls when the previous reply already passed all checks.

**Character card extraction** (with fallbacks for untagged cards):
1. `<CharName's Persona>...</CharName's Persona>` — JanitorAI standard
2. `<CharName>...</CharName>` — bare inner tag
3. First 3000 chars of system prompt — untagged cards always lead with character info

**User persona extraction** (with fallbacks):
1. `<UserPersona>...</UserPersona>` — standard tag
2. Last 500 chars of system prompt — JanitorAI always appends user persona at the bottom

**Raw system prompt:** Recast uses the system prompt stashed by `index.js` before extensions modified it (via `_rawSystemPrompt`). This ensures checks run against the original character card, not the RAG/TunnelVision-augmented version.

**Config file:** `data/recast-config.json`

```js
{
  enabled:          boolean,  // master on/off
  maxRetries:       number,   // max rewrite attempts per step (default: 2)
  checkModel:       string,   // model for YES/NO checks — '' = use request model
  rewriteModel:     string,   // model for rewrites — '' = use request model
  checkTokens:      number,   // max tokens for check responses (default: 100)
  rewriteTokens:    number,   // max tokens for rewrite responses (default: 2048)
  skipAfterPasses:  number,   // auto-skip step after N consecutive passes (0 = never)
  steps: {
    step1: { enabled: boolean, name: string, description: string },
    step2: { enabled: boolean, name: string, description: string },
    step3: { enabled: boolean, name: string, description: string },
    step4: { enabled: boolean, name: string, description: string },
  }
}
```

**Recommended model config:**
- `recastLocal: true` + `recastCheckModel: "qwen2.5:7b"` in `data/local-models-config.json` (fast, free checks)
- `rewriteModel`: a strong model — e.g. `anthropic/claude-sonnet-4-6` (rewrites need quality)
- If not using local models, set `checkModel` to a fast cheap model like `anthropic/claude-haiku-4-5`

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/status`  | Enabled state, step list, current model config, maxRetries |
| `GET`  | `/config`  | Full config object |
| `POST` | `/config`  | Update config (supports partial + deep step updates) |

**Console log output:**
```
[recast] ✦ Finished response! Checking message through 4 steps...
[recast] 🔍 Doing check 1 — Step 1 — System Prompt Compliance...
[recast] ✅ Step 1 — System Prompt Compliance — PASSED! Moving to next check... (streak: 3)
[recast] ⏭  Step 2 — Characters — skipped (5 consecutive passes)
[recast] 🔍 Doing check 3 — Step 3 — World...
[recast] ❌ Step 3 — World — FAILED! Rewriting... (attempt 1/2)
[recast] ✏  Step 3 — World — Rewrite done. Rechecking...
[recast] ✅ Step 3 — World — PASSED! Moving to next check... (streak: 1)
[recast] 🎉 All checks done! Sending message to JanitorAI.
```

**What can go wrong:**
- `_pending` is module-level — concurrent requests will overwrite each other's stashed context. Reduce `MAX_CONCURRENT` to 1 if this causes problems.
- Each failed step costs 2 extra API calls (rewrite + recheck). With 4 steps and `maxRetries: 2`, worst case is 12 extra calls per response.
- If the check model writes prose instead of YES/NO, it will never match `startsWith('YES')` and will always trigger rewrites.
- Recast runs synchronously in `transformResponse` — the full pipeline must complete before the response is returned to JanitorAI.
- The emotion tag stripping at the end of recast catches cases where a rewrite re-introduces the `<emotion>` tag.