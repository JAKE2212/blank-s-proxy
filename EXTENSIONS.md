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

---

## How It Works

Every `.js` file placed in the `extensions/` folder is automatically loaded when the proxy starts. Extensions can hook into the request/response pipeline, register their own Express routes, and persist configuration to `data/`.

The proxy scans `extensions/` at startup, sorts by priority, and mounts any routers before the main proxy endpoint. If a file fails to load, it is skipped with a warning — it will not crash the proxy.

---

## Extension Lifecycle

```
JanitorAI → POST /v1/chat/completions
               ↓
         transformRequest   (all extensions, priority order)
               ↓
         OpenRouter API call (+ TunnelVision tool loop if active)
               ↓
         transformResponse  (all extensions, priority order)
               ↓
         res.json → JanitorAI
```

Each hook is `async` and receives the full payload/response. If a hook throws, the error is caught and logged — the pipeline continues with the previous value unchanged.

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

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return { ...DEFAULT_CONFIG, ...saved };
    }
  } catch (e) {
    console.warn('[my-extension] Failed to load config:', e.message);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  return { ...DEFAULT_CONFIG };
}

// ── Hooks ──────────────────────────────────────────────────

async function transformRequest(payload) {
  const config = loadConfig();
  if (!config.enabled) return payload;

  // Modify payload.messages, payload.model, etc.
  // Must return the (modified) payload object.
  return payload;
}

async function transformResponse(data) {
  const config = loadConfig();
  if (!config.enabled) return data;

  // Modify data.choices[0].message.content, etc.
  // Must return the (modified) data object.
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
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(updated, null, 2));
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
  model:    string,           // e.g. 'anthropic/claude-opus-4-5'
  messages: Array<{
    role:    'system' | 'user' | 'assistant',
    content: string | Array,  // may be string or content block array
  }>,
  stream:   false,            // always forced off by the proxy
  // ...any other OpenRouter params
}
```

Common uses: inject system prompt additions, modify messages, add sampler params, prepend context.

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

---

### Config Persistence

Store config in `data/<your-extension>-config.json`. Use a `DEFAULT_CONFIG` object and merge saved values over it so new keys are always available after updates:

```js
const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
return { ...DEFAULT_CONFIG, ...saved }; // saved values win, new defaults fill gaps
```

Never mutate config in memory across requests without writing to disk — the proxy can restart at any time.

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

| Priority | Extension        |
|----------|-----------------|
| 10       | ooc.js           |
| 20       | regex.js         |
| 25       | rag.js           |
| 26       | tunnelvision.js  |
| 30       | samplers.js      |
| 40       | prose-polisher.js|

`transformRequest` runs lowest → highest (10 first, 40 last).  
`transformResponse` runs in the same order (10 first, 40 last).

Pick a priority that makes sense relative to others. Leave gaps between values so you can insert new extensions without renumbering.

---

## Auto-Discovery & Hot-Reload

The proxy watches the `extensions/` folder using `fs.watch`. If any `.js` file changes, all extensions are reloaded after a 5-second debounce. No restart required for extension code changes.

The dashboard's **Settings → Proxy Controls → Restart** also triggers a full reload and bundle rebuild.

---

## Extension Reference

### ooc.js

**Priority:** 10 | **Hooks:** `transformRequest`

Handles out-of-character (OOC) messages from JanitorAI. Strips or routes OOC content before it reaches the model so it doesn't contaminate the roleplay context.

**Config file:** none  
**Routes:** none

---

### regex.js

**Priority:** 20 | **Hooks:** `transformResponse` | **Routes:** `/extensions/regex/*`

SillyTavern-compatible regex post-processor. Runs an ordered list of find/replace rules against every AI reply after generation. Supports full regex flags, `trimStrings`, per-script enable/disable, and ST JSON import/export.

**Config file:** `data/regex-scripts.json`

```js
// Script shape
{
  id:            string,   // timestamp-based unique ID
  description:   string,   // human-readable label
  findRegex:     string,   // regex pattern (or /pattern/flags format)
  replaceString: string,   // replacement string, supports $1 capture groups
  flags:         string,   // regex flags e.g. 'g', 'gi'
  trimStrings:   boolean,  // trim whitespace from result
  enabled:       boolean,
}
```

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/scripts`          | List all scripts |
| `POST`   | `/scripts`          | Create a new script |
| `PUT`    | `/scripts/:id`      | Update a script |
| `DELETE` | `/scripts/:id`      | Delete a script |
| `POST`   | `/reorder`          | Reorder scripts by ID array |
| `POST`   | `/test`             | Test a single script against input |
| `POST`   | `/test-all`         | Run all enabled scripts against input |
| `POST`   | `/import`           | Import array of scripts (ST JSON compatible) |
| `GET`    | `/export`           | Download scripts as JSON file |

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
  maxInjectionChars: number,   // cap on injected context length
  emotionEnabled:    boolean,
  emotionBoost:      number,   // score boost when emotion matches (0–0.5)
  blindNextTurn:     boolean,  // if true, next indexed turn is decay-immune
  rules:             Array,    // conditional activation rules
}
```

**Emotion detection:** Injects an `<emotion>LABEL</emotion>` instruction into the system prompt. The tag is automatically extracted and stripped from the reply before JanitorAI sees it. Valid labels: `neutral, happy, sad, angry, fearful, tender, anxious, excited, surprised, disgusted`.

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/status`              | Config + live stats |
| `POST`   | `/config`              | Update config |
| `GET`    | `/collections`         | List Qdrant collections |
| `DELETE` | `/collections/:name`   | Clear a character's memory |
| `POST`   | `/blind-next`          | Mark next turn as temporally blind |

---

### tunnelvision.js

**Priority:** 26 | **Hooks:** `transformRequest`, `transformResponse` | **Routes:** `/extensions/tunnelvision/*`

Hierarchical lorebook memory via real Claude tool calls. Maintains a tree of knowledge nodes (channels) and entries per bot character. Claude can search, read, create, and update entries during generation via a tool loop (up to 6 rounds per request).

**Config file:** `data/tunnelvision-config.json`  
**Tree files:** `data/tunnelvision/<botname>.json` (one per character, auto-created)

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/status`                                    | Config + active tree stats |
| `POST`   | `/config`                                    | Update config (mandatoryTools, autoSummary, autoSummaryInterval, activeTree) |
| `GET`    | `/trees`                                     | List all trees |
| `GET`    | `/tree/:name`                                | Get full tree data |
| `DELETE` | `/tree/:name`                                | Delete a tree |
| `POST`   | `/tree/:name/node`                           | Add a channel node |
| `POST`   | `/tree/:name/node/:nodeId/entry`             | Add an entry to a node |

---

### samplers.js

**Priority:** 30 | **Hooks:** `transformRequest` | **Routes:** `/extensions/samplers/*`

Model-aware sampler controls. Applies enabled sampler parameters (Top P, Top K, temperature, etc.) to outgoing requests. Claude via OpenRouter only supports Top P and Top K — the UI reflects this automatically.

**Config file:** `data/sampler-config.json`

```js
// Config shape — keyed by model string
{
  "anthropic/claude-opus-4-5": {
    top_p: { enabled: boolean, value: number },
    top_k: { enabled: boolean, value: number },
  },
  // ...other models
}
```

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/config?model=...` | Get sampler defs + current config for a model |
| `POST` | `/config`           | Save sampler config |

---

### prose-polisher.js

**Priority:** 40 | **Hooks:** `transformRequest`, `transformResponse`

Server-side repetition avoidance. Tracks n-grams across responses with exponential decay and penalises repeated phrases. Regex-aware to avoid false positives on structured content. Helps keep long roleplay sessions feeling fresh without manual intervention.

**Config file:** `data/prose-polisher-config.json`  
**State file:** `data/prose-polisher-state.json`

**Routes:** none