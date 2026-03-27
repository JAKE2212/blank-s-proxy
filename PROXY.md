# Proxy Codebase Reference

This document describes every file in the Kiana Proxy codebase — what it does, how it works, what it depends on, and what can go wrong. Use this as a debugging reference and onboarding guide.

---

## Table of Contents

- [Project Overview](#project-overview)
- [Request Lifecycle](#request-lifecycle)
- [File Reference](#file-reference)
  - [index.js](#indexjs)
  - [lib/](#lib)
    - [circuit-breaker.js](#libcircuit-breakerjs)
    - [custom-prompt.js](#libcustom-promptjs)
    - [dashboard-routes.js](#libdashboard-routesjs)
    - [local-models.js](#liblocal-modelsjs)
    - [prompt-cache.js](#libprompt-cachejs)
    - [queue.js](#libqueuejs)
    - [rag-embedder.js](#librag-embedderjs)
    - [rag-retriever.js](#librag-retrieverjs)
    - [rag-store.js](#librag-storejs)
    - [reply-cache.js](#libreply-cachejs)
    - [character-detector.js](#libcharacter-detectorjs)
    - [tunnelvision/tv-tree.js](#libtunnelvisiontv-treejs)
    - [tunnelvision/tv-tools.js](#libtunnelvisiontv-toolsjs)
  - [extensions/](#extensions)
    - [ooc.js](#extensionsoocjs)
    - [regex.js](#extensionsregexjs)
    - [rag.js](#extensionsragjs)
    - [samplers.js](#extensionssamplersjs)
    - [prose-polisher.js](#extensionsprose-polisherjs)
    - [tunnelvision.js](#extensionstunnelvisionjs)
    - [recast.js](#extensionsrecastjs)
  - [dashboard/](#dashboard)
    - [index.html](#dashboardindexhtml)
    - [dashboard.css](#dashboarddashboardcss)
    - [build.js](#dashboardbuildjs)
    - [js/dashboard-core.js](#dashboardjsdashboard-corejs)
    - [js/dashboard-overview.js](#dashboardjsdashboard-overviewjs)
    - [js/dashboard-logs.js](#dashboardjsdashboard-logsjs)
    - [js/dashboard-samplers.js](#dashboardjsdashboard-samplersjs)
    - [js/dashboard-regex.js](#dashboardjsdashboard-regexjs)
    - [js/dashboard-rag.js](#dashboardjsdashboard-ragjs)
    - [js/dashboard-tunnelvision.js](#dashboardjsdashboard-tunnelvisionjs)
- [Data Files](#data-files)
- [Common Errors & Fixes](#common-errors--fixes)

---

## Project Overview

A self-hosted Node.js/Express proxy that sits between JanitorAI and OpenRouter. Every request from JanitorAI passes through an extension pipeline before reaching OpenRouter, and every response passes back through it before returning to JanitorAI.

```
JanitorAI → Proxy → Extension Pipeline → OpenRouter
                                        ↕ (tool loop for TunnelVision)
JanitorAI ← Proxy ← Extension Pipeline ← OpenRouter
```

**Infrastructure:**
- Node.js 18+ / Express running in Docker on Proxmox (LXC container 100, files at `/opt/proxy/`)
- Exposed via Cloudflare Tunnel at `https://proxy.kiana-designs.com`
- SSH access at `ssh.kiana-designs.com`
- Qdrant vector DB at `192.168.1.192:6333`
- Ollama at `192.168.1.193:11434` (mxbai-embed-large embeddings, qwen2.5:7b for recast checks)
- Managed via Portainer, edited via VS Code Remote SSH
- Private GitHub repo (username: JAKE2212)
- Uptime Kuma for health monitoring
- Proxmox UI at `proxmox.kiana-designs.com`

---

## Request Lifecycle

```
POST /v1/chat/completions
  │
  ├─ Auth check (PROXY_API_KEY)
  ├─ Rate limit (30 req/min per IP)
  ├─ Queue (MAX_CONCURRENT = 3)
  ├─ Request validation (message count, char limits)
  │
  ├─ applyPromptCaching()     ← Claude only: add cache_control headers
  ├─ injectPrompt()           ← Strip JanitorAI instructions, inject custom prompt
  ├─ Stash raw system prompt  ← For recast (before extensions modify it)
  ├─ primeTreeName()          ← TunnelVision extracts bot name early
  │
  ├─ transformRequest pipeline (3-phase):
  │   Phase 1 — Pre-RAG/TV (priority < 25):
  │     ooc.js (10)           ← strip OOC commands, inject as system note
  │     regex.js (20)         ← no transformRequest hook
  │   Phase 2 — RAG + TunnelVision in parallel:
  │     rag.js (25)           ← inject emotion instruction + retrieve context
  │     tunnelvision.js (26)  ← inject tool definitions
  │   Phase 3 — Post-RAG/TV (priority >= 25, excluding RAG/TV):
  │     samplers.js (30)      ← inject sampler params
  │     prose-polisher.js (40)← inject slop avoidance note
  │     recast.js (45)        ← stash system prompt + context for later
  │
  ├─ wrapSendWithToolLoop()   ← TunnelVision tool loop (up to 6 rounds)
  │     Each round: OpenRouter → tool calls → execute → append → repeat
  │     Final round: narrative response
  │
  ├─ Cache raw reply           ← reply-cache.js (before recast)
  │
  ├─ transformResponse pipeline (priority order):
  │     regex.js (20)         ← run regex scripts on reply
  │     rag.js (25)           ← strip <emotion> tag, index turn
  │     prose-polisher.js (40)← analyze response, update ngram state
  │     recast.js (45)        ← run 4-step check/rewrite pipeline
  │
  ├─ Cache final reply         ← reply-cache.js (after recast)
  ├─ Log token usage (post-transform)
  ├─ Duplicate detection (post-transform)
  ├─ Queue release (done())
  └─ res.json(finalData) → JanitorAI
```

---

## File Reference

### index.js

**What it does:** The main orchestrator. Starts the Express server, loads extensions, wires everything together, and handles the main `/v1/chat/completions` endpoint.

**Key responsibilities:**
- CORS for JanitorAI's browser origin
- Proxy auth via `PROXY_API_KEY`
- Rate limiting (30 req/min per IP via `rateLimitMap`, cleaned up every 60s)
- Extension auto-discovery from `extensions/` folder
- Extension hot-reload via `fs.watch` (5s debounce)
- Request validation (max 2000 messages, max 2M chars)
- Calls `injectPrompt()` to strip JanitorAI instructions and inject custom prompt
- Stashes raw system prompt for recast before extensions modify it
- Calls `primeTreeName()` before the extension pipeline
- Calls `applyPromptCaching()` for Claude models
- 3-phase `transformRequest` pipeline (pre-RAG/TV → RAG+TV parallel → post-RAG/TV)
- Calls `wrapSendWithToolLoop()` or `sendToOpenRouter()` directly
- Caches raw reply before recast via `reply-cache.js`
- Runs `transformResponse` pipeline
- Caches final reply after recast via `reply-cache.js`
- Bot log and duplicate detection run post-transform (logs show final text)
- Log rotation (5MB cap, 7-day archive, checked every 5 minutes)
- Async log file writes (non-blocking)
- Memory monitoring (warn at 512MB throttled to once per 5 min, restart at 768MB)
- Graceful shutdown on SIGTERM/SIGINT
- Dashboard bundle rebuild on startup via `execSync('node dashboard/build.js')`

**Critical variables:**
```js
START_TIME       // server start timestamp
lastRequestTime  // ISO string of last request
lastReply        // post-transform text for duplicate detection
lastMemoryWarn   // timestamp of last memory warning (throttle)
RESTART_HISTORY  // array of { time, reason } restart records
```

**Extension loading order:**
1. `fs.readdirSync('extensions/')` — alphabetical
2. Sort by `priority` (ascending)
3. Mount any `router` properties at `/extensions/<filename>/`

**3-phase transformRequest pipeline:**
- Phase 1: Extensions with priority < 25 (before RAG/TV)
- Phase 2: RAG + TunnelVision run in parallel via `Promise.allSettled`, results merged (RAG provides messages, TV provides tools)
- Phase 3: Extensions with priority >= 25 (after RAG/TV, excluding RAG/TV themselves)

**What can go wrong:**
- If an extension fails to load, it's skipped with a warning — the proxy still starts
- If `primeTreeName` crashes, TunnelVision won't work for that request
- If the dashboard bundle fails to build, the old bundle is used (non-fatal)
- Memory monitoring uses `setInterval(30s)` — a spike between checks won't trigger restart
- Memory warnings are throttled to once per 5 minutes to avoid log spam
- `rateLimitMap` is cleaned up every 60s via setInterval — stale entries are pruned automatically
- Bot log and duplicate detection now run after `transformResponse` — logs show final post-transform text
- Log rotation runs on a 5-minute interval, not per-write
- File writes to the log are async (non-blocking)
- The `recastExt._rawSystemPrompt` pattern mutates the extension object directly — fragile if recast is reloaded mid-request

---

### lib/circuit-breaker.js

**What it does:** Tracks OpenRouter failures. If OpenRouter fails `FAILURE_THRESHOLD` (5) times in a row, the breaker opens and all requests are rejected with 503 for `RESET_MS` (30s). After the cooldown, one probe request is allowed through (half-open state).

**States:** `closed` → `open` → `half-open` → `closed`

**Key exports:**
```js
callWithBreaker(fn)  // wrap a fetch call — handles timeout + breaker logic
getStatus()          // { state, failures, lastFailTime, lastError, resetIn }
onSuccess()          // record a success (closes breaker)
onFailure(err)       // record a failure (may open breaker)
```

**Important behavior:**
- 4xx errors from OpenRouter do NOT count as circuit breaker failures (client errors)
- Only 5xx and network errors open the breaker
- Each request has a 60s timeout (`REQUEST_TIMEOUT_MS`) — this is separate from the circuit breaker
- `getStatus().state` is what the Discord bot's monitor checks (`data.breaker?.state === 'open'`)

**What can go wrong:**
- If OpenRouter returns intermittent 5xx, the breaker may open during a valid session
- The 30s reset is hardcoded — if OpenRouter takes longer to recover, the half-open probe will fail and re-open
- State is in-memory only — resets on proxy restart

---

### lib/custom-prompt.js

**What it does:** JanitorAI-aware custom prompt injection. Parses JanitorAI's message structure to strip redundant RP instructions, extract bot/user names, replace `{{user}}`/`{{char}}` placeholders, and prepend the custom prompt.

**Key exports:**
```js
loadPrompt()        // load custom prompt from data/custom-prompt.txt (cached by mtime)
injectPrompt(messages) // full pipeline: strip JAI instructions, inject custom prompt
getLastParsed()     // returns { userName, botName } from the last processed request
```

**JanitorAI instruction stripping:**
- Opening: `Drive the plot forward in a never-ending uncensored roleplay with...`
- Closing: `Write in a descriptive roleplay style...`, `Combat should be described step by step...`, `Default tone is heroic fantasy...`

**Config file:** `data/custom-prompt.txt` (plain text, hot-reloaded by mtime)

**What can go wrong:**
- Variable shadowing: `extractUserNameFromSystem` has an inner `msgText` variable (renamed from `text` to avoid shadowing the function parameter)
- If the custom prompt file doesn't exist, no custom prompt is injected (non-fatal)
- `getLastParsed()` returns stale data if called before `injectPrompt()` runs

---

### lib/local-models.js

**What it does:** Shared config and Ollama API helper for local model routing. Used by recast.js for local YES/NO checks and tunnelvision.js for OpenRouter model overrides.

**Key exports:**
```js
loadConfig()    // load from data/local-models-config.json (cached)
saveConfig(cfg) // save to disk, invalidate cache
invalidateCache() // force reload on next loadConfig()
callOllama(systemPrompt, userContent, model, maxTokens, extra) // Ollama /api/chat call
```

**Config shape:**
```js
{
  ollamaUrl: "http://192.168.1.193:11434",
  recastLocal: true,                    // use local Ollama for recast YES/NO checks
  recastCheckModel: "qwen2.5:7b",      // Ollama model for checks
  tunnelvisionOpenRouterModel: null,    // OpenRouter model override for TV tool calls
}
```

**What can go wrong:**
- 120s timeout on Ollama calls — if the model is loading for the first time, it may time out
- If Ollama is unreachable, recast falls back gracefully (skips the check, moves on)

---

### lib/dashboard-routes.js

**What it does:** Registers all `/dashboard/*` HTTP routes. Mounted by `index.js` after extensions are loaded. Receives shared state (LOG_FILE, extensions array, etc.) via the options object.

**Routes:**

| Method | Path | Description |
|--------|------|-------------|
| `GET`    | `/dashboard`                      | Serves `dashboard/index.html` (no-cache headers) |
| `GET`    | `/dashboard/logs`                 | Returns all log entries as JSON array |
| `DELETE` | `/dashboard/logs`                 | Clears the log file |
| `GET`    | `/dashboard/logs/search?q=`       | Filters logs by search string |
| `GET`    | `/dashboard/logs/export`          | Downloads the raw log file |
| `POST`   | `/dashboard/restart`              | Calls `process.exit(0)` after 500ms |
| `GET`    | `/dashboard/config`               | Returns CONFIG + env vars (API key presence only) |
| `GET`    | `/dashboard/stats`                | Aggregated token/request stats from logs |
| `GET`    | `/dashboard/extensions`           | Extension metadata (name, version, hooks) |
| `POST`   | `/dashboard/env-reload`           | Hot-reloads `.env` via dotenv |
| `GET`    | `/dashboard/uptime-history`       | Returns RESTART_HISTORY array |
| `POST`   | `/dashboard/extensions/reload`    | Clears and re-requires all extension files |

**What can go wrong:**
- `/dashboard/restart` sends 200 before exiting — if Docker doesn't auto-restart the container, the proxy is just gone
- `/dashboard/extensions/reload` manually removes extension routes from `app._router.stack` — this is fragile and may not remove all routes cleanly if extension names change
- Log endpoints read the whole file synchronously — on very large log files this can be slow

---

### lib/prompt-cache.js

**What it does:** Applies Anthropic's prompt caching headers to Claude model requests. Splits the system prompt into paragraphs and adds `cache_control: { type: "ephemeral", ttl: "1h" }` to the last block.

**Key exports:**
```js
isClaudeModel(model)              // returns true if model string contains "claude" or "anthropic"
applyPromptCaching(messages, model) // transforms messages array, returns new array
```

**How caching works:**
- Only applied to Claude models — other models are returned unchanged
- System prompt split on `\n\n+` into paragraphs
- `cache_control` added only to the last paragraph (triggers cache at that boundary)
- Single-block system prompts get cache_control on the whole block
- Non-system messages are returned unchanged

**What can go wrong:**
- If a system prompt has no `\n\n` separators, it's treated as a single block
- Cache invalidates if the system prompt changes at all (e.g. RAG injects different context each turn)
- OpenRouter passes cache headers to Anthropic but may not always return `cache_read` in usage stats

---

### lib/queue.js

**What it does:** Simple async request queue. Allows up to `MAX_CONCURRENT` (3) simultaneous OpenRouter requests. Additional requests wait in a FIFO queue with a 60s timeout.

**Key exports:**
```js
enqueue()   // returns Promise<doneFn> — call doneFn() when request completes
getStats()  // { active, waiting, totalQueued, totalProcessed, totalTimedOut }
```

**What can go wrong:**
- If `done()` is never called (exception before the call), the slot is leaked and the queue will eventually fill
- `index.js` wraps everything in try/catch and calls `done?.()` in the catch block, so this should be rare
- The timeout check only runs when `next()` processes an item — a timed-out request sitting behind other long requests won't be evicted until it reaches the front

---

### lib/rag-embedder.js

**What it does:** Converts text to 1024-dimensional float vectors using Ollama's `mxbai-embed-large` model. Single responsibility — text in, vector out.

**Key exports:**
```js
embedText(text, config)      // string → number[] (throws on failure)
embedBatch(texts, config)    // string[] → (number[]|null)[]
EMBEDDING_DIM                // 1024
```

**Important limits:**
- 30s timeout per embedding call
- Empty/blank text throws immediately (doesn't call Ollama)
- `mxbai-embed-large` has a ~512 token context window — callers truncate to ~1800 chars before calling

**What can go wrong:**
- If Ollama container (192.168.1.193) is down, all RAG operations fail silently (logged as warnings, non-fatal)
- Uses Node.js native `fetch` (Node 18+)

---

### lib/rag-retriever.js

**What it does:** The full RAG scoring pipeline. Takes a query, embeds it, searches Qdrant, applies temporal decay + keyword boost + emotion boost + conditional rules, deduplicates, and formats the result for injection.

**Key exports:**
```js
indexTurn(params, config)          // store a conversation turn in Qdrant
retrieve(params, config)           // query and return { context, coCharacters }
retrieveLinked(params, config)     // retrieve for co-occurring characters (reduced topK)
sanitizeCollectionName(name)       // sanitize char name for Qdrant collection naming
```

**Scoring pipeline (retrieve):**
1. Embed the query text (last N user messages joined)
2. Search Qdrant for top `topK * 2` candidates
3. For each hit: temporal decay → keyword boost → emotion boost
4. Filter by `scoreThreshold`
5. Apply conditional rules (emotion/keyword/recency conditions)
6. Sort descending, take top `topK`
7. Deduplicate by character-level similarity (>85% = duplicate)
8. Collect co-characters from top hits for cross-character linking

**Cross-character linking:**
- `retrieve()` returns `coCharacters` — other character names found in top chunks' `coCharacters` arrays
- `retrieveLinked()` performs a secondary retrieval for co-occurring characters with reduced `linkedTopK` (default 2)
- This allows RAG to surface relevant memories from related characters' collections

**indexTurn params:**
```js
{
  charName,        // character name (used for collection namespacing)
  userText,        // the user's message
  assistantText,   // the AI's reply (emotion tag already stripped)
  messageIndex,    // position in conversation
  emotion,         // detected emotion label
  temporallyBlind, // if true, skip decay for this chunk
  coCharacters,    // other characters active in the same turn
}
```

**What can go wrong:**
- If Qdrant is unreachable, `retrieve()` returns null and `indexTurn()` logs a warning — both are non-fatal
- The `similarity()` dedup function is a fast positional approximation — not perfect but good enough
- Temporal decay uses `messageIndex` — if message count resets (new session), old chunks may appear with wrong ages

---

### lib/rag-store.js

**What it does:** Qdrant CRUD operations. Handles collection creation, upsert, search, and point count. All communication is via Qdrant's HTTP REST API.

**Key exports:**
```js
ensureCollection(collection, config)           // create if not exists (idempotent)
upsertPoint(collection, point, config)         // store a single vector + payload
queryPoints(collection, vector, topK, config)  // cosine similarity search
getPointCount(collection, config)              // count points in a collection
makePointId(charName, messageIndex, role)       // deterministic numeric ID
```

**What can go wrong:**
- `makePointId` uses bitwise ops — unexpected values for very long char names (unlikely with sanitization)
- `ensureCollection` does a GET check before PUT — race condition if two requests try to create the same collection simultaneously (rare)
- All operations throw on non-OK responses — callers wrap in try/catch

---

### lib/reply-cache.js

**What it does:** Catches and caches the last successful reply for recovery and reroll optimization.

**Key exports:**
```js
cacheRaw(reply, userText)    // cache raw reply before recast runs
cacheFinal(reply)            // cache final reply after recast passes
shouldSkipRecast(userText)   // true if reroll of a previously passed reply
getLast()                    // get last cached reply (for /v1/last-reply endpoint)
```

**Persistence:** Writes to `data/reply-cache.json` asynchronously. Loaded from disk on startup.

**What can go wrong:**
- Cache is a single slot — only the most recent reply is stored
- If the proxy crashes between `cacheRaw` and `cacheFinal`, the raw reply is still recoverable

---

### lib/character-detector.js

**What it does:** Shared character name extraction used by RAG, prose-polisher, and TunnelVision. Single source of truth for name detection, alias resolution, and false positive blocklisting.

**Key exports:**
```js
extractCharNames(replyText, userName, opts)  // extract character names from AI reply
extractUserName(messages)                     // extract user name from JanitorAI messages
resolveAlias(name)                            // resolve alias to canonical name
loadAliases()                                 // load alias map from data/character-aliases.json
BLOCKLIST                                     // Set of blocked false-positive words
```

**Extraction flow:**
1. Scan for multi-word aliases ("All Might" → "toshinori") — longest first, greedy
2. Remove matched multi-word aliases from text to prevent re-detection as individual words
3. Run single-word patterns: possessive (`Kurt's`), action verb (`Kurt stepped`), dialogue attribution (`"text," Kurt said`)
4. Resolve single-word aliases and merge with multi-word results
5. Deduplicate, blocklist filter, return lowercase canonical names

**Config file:** `data/character-aliases.json` (hot-reloaded by mtime)

**What can go wrong:**
- First-person narration won't trigger name extraction (relies on third-person patterns)
- Very common names that happen to match blocklist entries will be filtered out
- Multi-word aliases must be exact matches (case-insensitive but otherwise literal)

---

### lib/tunnelvision/tv-tree.js

**What it does:** The TunnelVision data layer. Manages per-character tree JSON files in `data/tunnelvision/<charName>.json`. Handles all tree and entry CRUD operations.

**Tree shape:**
```js
{
  version:     1,
  charName:    string,         // sanitized lowercase
  nodes:       { [id]: Node }, // flat id→node map
  rootId:      "root",         // always exists
  summariesId: "summaries",    // always exists
  nextUid:     number,         // auto-increment for entry UIDs
  createdAt:   number,
  updatedAt:   number,
}
```

**Node shape:**
```js
{
  id, label, summary, parentId, children,
  tags, entries, isArc, createdAt, updatedAt
}
```

**Entry shape:**
```js
{
  uid, title, content, keys,
  enabled, isTracker, createdAt, updatedAt
}
```

**Diagnostics (`runDiagnostics`):** Auto-fixes orphaned nodes, stale child references, missing summaries node, and nextUid inconsistencies. Reports duplicate UIDs, empty entries, and oversized entries.

**Key exports:**
```js
// I/O
loadTree, saveTree, getOrCreateTree, createTree, deleteTree, listTrees, sanitizeCharName

// Node ops
addNode, removeNode, moveNode, getNode, walkTree

// Entry ops
addEntry, findEntry, updateEntry, disableEntry, moveEntry, getAllEntries

// Tree overview / retrieval
buildTreeOverview, retrieveNodeContent

// Dedup
trigramSimilarity, findSimilarEntries

// Summaries arcs
getOrCreateArc

// Diagnostics
runDiagnostics
```

---

### lib/tunnelvision/tv-tools.js

**What it does:** Defines all 8 TunnelVision tools and their action handlers.

**Tools:**

| Tool | Description |
|------|-------------|
| `TunnelVision_Search` | Navigate tree and retrieve entries (collapsed or traversal mode) |
| `TunnelVision_Remember` | Create new entry with trigram dedup warning |
| `TunnelVision_Update` | Edit existing entry by UID |
| `TunnelVision_Forget` | Soft-delete entry by UID |
| `TunnelVision_Summarize` | Create scene summary under arc node |
| `TunnelVision_Notebook` | Private scratchpad (write/delete/clear/promote) |
| `TunnelVision_MergeSplit` | Merge two entries or split one into two |
| `TunnelVision_Reorganize` | Move entries/nodes, create new channels |

**Search modes:**
- **Collapsed** (< `TRAVERSAL_THRESHOLD` nodes): Full tree overview in tool description, AI picks node IDs in one call
- **Traversal** (>= `TRAVERSAL_THRESHOLD` nodes): Shows only current level, AI drills down step by step

**Tracker entries:** Entries with `isTracker: true` or title starting with `[Tracker]` are listed in tool descriptions as reminders to check/update them.

---

## Extensions

### extensions/ooc.js

**Priority:** 10 | **Hooks:** `transformRequest`

Handles out-of-character (OOC) messages from JanitorAI. Detects `(OOC: ...)` in the last user message, strips it from context, and injects it as a temporary system instruction. The OOC command never reaches the AI as a user message.

**Config file:** none  
**Routes:** none

---

### extensions/regex.js

**Priority:** 20 | **Hooks:** `transformResponse` | **Routes:** `/extensions/regex/*`

SillyTavern-compatible regex post-processor. Runs an ordered list of find/replace rules against every AI reply. Features: in-memory cache with dirty flag, `stopOnMatch`, script groups/tags, named capture groups, `dryRun` mode, per-script hit counters.

**Config file:** `data/regex-scripts.json`

---

### extensions/rag.js

**Priority:** 25 | **Hooks:** `transformRequest`, `transformResponse` | **Routes:** `/extensions/rag/*`

Semantic memory via Qdrant + Ollama. Full details in `EXTENSIONS.md`.

**State carried between hooks:**
```js
// Per-request state (transformRequest → transformResponse)
_pendingMap = Map<reqId, {
  userText, msgCount, userName, isReroll, timestamp
}>

// Cross-turn state (persists across requests, 30min TTL)
_turnState = {
  lastCharNames,     // accumulated character names from all turns (capped at 15)
  activeSceneChars,  // chars from the LAST reply only (used for next retrieval)
  lastEmotion,       // emotion from previous turn
  lastUserText,      // for reroll detection
}
```

**Scene-aware retrieval:** Only characters from the last reply (`activeSceneChars`) are used for retrieval on the next turn. Falls back to all known characters on first turn. User-mentioned characters that are already known are also included.

**Cross-character linking:** When retrieved chunks mention other known characters, those characters' memories are also retrieved with reduced topK.

**Collection pruning:** When the number of RAG collections exceeds `maxCollections` (default 20), the smallest collections are automatically deleted.

**What can go wrong:**
- `knownCharNames` is now copied from `_turnState` arrays (not a direct reference) — the old splice-based mutation was fragile
- Cross-turn state (`_turnState`) is module-level — concurrent sessions with different characters would share state
- Per-request state uses `_pendingMap` with TTL cleanup and hard cap of 3 entries
- `blindNextTurn` flag is reset asynchronously after use

---

### extensions/samplers.js

**Priority:** 30 | **Hooks:** `transformRequest` | **Routes:** `/extensions/samplers/*`

Model-aware sampler controls. Config is cached in memory (warm cache after save).

---

### extensions/prose-polisher.js

**Priority:** 40 | **Hooks:** `transformRequest`, `transformResponse`

Server-side repetition avoidance with per-character n-gram tracking. Uses shared `lib/character-detector.js` for name extraction. Session char accumulator with 30min TTL reset. Config and state cached in memory.

**Config file:** `data/prose-polisher-config.json`  
**State file:** `data/prose-polisher-state.json`

---

### extensions/tunnelvision.js

**Priority:** 26 | **Hooks:** `transformRequest` | **Routes:** `/extensions/tunnelvision/*`

Hierarchical lorebook memory via real Claude tool calls. Supports local model routing via `lib/local-models.js` — tool calls can use a separate OpenRouter model override.

**Search mode selection:**
- `auto` (default): collapsed if < 15 nodes, traversal if >= 15
- `collapsed`: always show full tree overview
- `traversal`: always drill-down navigation

---

### extensions/recast.js

**Priority:** 45 | **Hooks:** `transformRequest`, `transformResponse` | **Routes:** `/extensions/recast/*`

"The 4 Steps of Roleplay" quality-control pipeline. Supports local Ollama models for YES/NO checks (via `lib/local-models.js`) and OpenRouter for rewrites. Features consecutive pass streak tracking — steps that pass consistently are auto-skipped.

**TunnelVision integration:** Pulls character entries and summaries from TunnelVision trees for character authenticity checks (step 2).

**Reroll optimization:** Uses `reply-cache.js` to skip recast on rerolls when the previous reply already passed all checks.

---

## Dashboard

### dashboard/index.html

The single-page dashboard HTML shell with Frutiger Aero / glassmorphism aesthetic.

### dashboard/dashboard.css

All styles. Glass cards with `blur(14px)` backdrop filter, aurora background, floating particles.

### dashboard/build.js

Concatenates 7 dashboard JS files into `dashboard.bundle.js` in correct load order. Run on startup.

### dashboard/js/dashboard-core.js

Bubble background animation, clock (America/New_York), tab switching, `esc()` helper.

### dashboard/js/dashboard-overview.js

Stats cards and health/extensions panel.

### dashboard/js/dashboard-logs.js

Log viewer with type filters, pagination, expandable entries.

### dashboard/js/dashboard-samplers.js

Sampler sliders UI with model selector and live probability graph.

### dashboard/js/dashboard-regex.js

Regex script manager — CRUD, reorder, import/export, live test.

### dashboard/js/dashboard-rag.js

RAG controls — enable/disable, blind next turn, collections list, config sliders.

### dashboard/js/dashboard-tunnelvision.js

TunnelVision tree editor with expandable nodes/entries.

---

## Data Files

| File | Owner | Description |
|------|-------|-------------|
| `data/custom-prompt.txt` | custom-prompt.js | Custom system prompt (plain text, hot-reloaded) |
| `data/character-aliases.json` | character-detector.js | Multi-word and single-word alias map |
| `data/regex-scripts.json` | regex.js | Ordered array of regex script objects |
| `data/rag-config.json` | rag.js | RAG configuration including Qdrant/Ollama URLs |
| `data/sampler-config.json` | samplers.js | Per-sampler enabled + value settings |
| `data/prose-polisher-config.json` | prose-polisher.js | Thresholds, decay rates, whitelist, blacklist |
| `data/prose-polisher-state.json` | prose-polisher.js | Live n-gram frequency map (deletable to reset) |
| `data/tunnelvision-config.json` | tunnelvision.js | Active tree override, search mode, auto-detect flag |
| `data/tunnelvision/<charName>.json` | tv-tree.js | One tree per character, auto-created |
| `data/recast-config.json` | recast.js | Step enable flags, model overrides, retry cap |
| `data/local-models-config.json` | local-models.js | Ollama URL, recast/TV model routing |
| `data/reply-cache.json` | reply-cache.js | Last raw + final reply for recovery |
| `logs/requests.log` | index.js | JSONL request log, rotated at 5MB |

**Important:** The `data/` folder is excluded from Git. Back it up separately.

---

## Common Errors & Fixes

**Proxy won't start / crashes on startup**
- Check Docker logs: `docker logs proxy -f`
- Most likely an extension failed to load — look for `[extensions] Failed to load`
- Check that `data/` directory exists and is writable

**Dashboard shows blank / CSS not loading**
- Check that `dashboard/dashboard.bundle.js` was built (look for `[proxy] ✦ Dashboard bundle built` in logs)

**TunnelVision not activating**
- Check that the bot card has a `<BotName's Persona>` tag in the system prompt
- Check `_pendingTreeName` — if it's null after `primeTreeName()`, the tree won't load
- Check `data/tunnelvision/` exists and the tree file is valid JSON

**RAG not injecting context**
- Check Qdrant is reachable: `curl http://192.168.1.192:6333/health`
- Check Ollama is reachable: `curl http://192.168.1.193:11434/api/tags`
- Check `data/rag-config.json` — `enabled` must be `true`
- First message of a new session won't inject (no characters known until first response)
- Check for junk collections (common words as names) — delete via dashboard

**Circuit breaker keeps opening**
- OpenRouter is returning 5xx errors repeatedly
- Check OpenRouter status page
- Check your API key is valid and has credits
- The breaker resets after 30s automatically

**Memory keeps hitting threshold / frequent restarts**
- Warning threshold is 512MB, restart threshold is 768MB
- Long roleplay sessions are the most common cause
- TunnelVision's tool loop appends to messages each round — check `MAX_TOOL_ROUNDS`
- Delete `data/prose-polisher-state.json` to reset accumulated n-gram data
- Clean up junk RAG collections via dashboard

**Regex scripts not applying**
- Check `data/regex-scripts.json` — scripts must have `enabled: true`
- Check the regex pattern is valid — invalid patterns silently return original text
- `transformResponse` runs in priority order — regex (20) runs before recast (45)

**Concurrent request issues (wrong character names, wrong tree)**
- rag.js uses `_pendingMap` for per-request state (safe) but `_turnState` for cross-turn state (shared)
- tunnelvision.js uses `_pendingTreeName` and `_pendingTree` which are module-level
- recast.js uses `_pending` which is module-level (documented as single-user safe)
- Workaround: reduce `MAX_CONCURRENT` to 1 in `lib/queue.js`

**Recast keeps rewriting / responses are very slow**
- Default: local Ollama `qwen2.5:7b` for YES/NO checks (fast, free)
- If `recastLocal` is false, set `checkModel` to a fast cheap model
- Lower `maxRetries` to reduce worst-case extra calls
- Disable individual steps if one is consistently failing
- Check for consecutive pass streak skipping (`skipAfterPasses` config)

**Recast always failing a step**
- The check model may be writing prose instead of YES/NO — switch models
- The step's check prompt may be too strict — lower `maxRetries` to 1 or disable the step
- Check proxy logs for `[recast] ⚠` lines to identify the failing step