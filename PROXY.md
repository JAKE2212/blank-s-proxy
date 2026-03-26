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
    - [dashboard-routes.js](#libdashboard-routesjs)
    - [prompt-cache.js](#libprompt-cachejs)
    - [queue.js](#libqueuejs)
    - [rag-embedder.js](#librag-embedderjs)
    - [rag-retriever.js](#librag-retrieverjs)
    - [rag-store.js](#librag-storejs)
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
- Node.js/Express running in Docker on Proxmox
- Exposed via Cloudflare Tunnel at `https://proxy.kiana-designs.com`
- Qdrant vector DB at `192.168.1.192:6333`
- Ollama at `192.168.1.193:11434` (mxbai-embed-large embeddings)

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
  ├─ primeTreeName()          ← TunnelVision extracts bot name early
  ├─ applyPromptCaching()     ← Claude only: add cache_control headers
  │
  ├─ transformRequest pipeline (priority order):
  │     ooc.js (10)
  │     regex.js (20)         ← no transformRequest hook
  │     rag.js (25)           ← inject emotion instruction + retrieve context
  │     tunnelvision.js (26)  ← inject tool definitions
  │     samplers.js (30)      ← inject sampler params
  │     prose-polisher.js (40)← inject slop avoidance note
  │     recast.js (45)        ← stash system prompt + context for later
  │
  ├─ wrapSendWithToolLoop()   ← TunnelVision tool loop (up to 6 rounds)
  │     Each round: OpenRouter → tool calls → execute → append → repeat
  │     Final round: narrative response
  │
  ├─ transformResponse pipeline (priority order):
  │     rag.js (25)           ← strip <emotion> tag, index turn
  │     tunnelvision.js (26)  ← no-op (cleanup handled in tool loop)
  │     prose-polisher.js (40)← analyze response, update ngram state
  │     recast.js (45)        ← run 4-step check/rewrite pipeline
  │
  ├─ Log token usage
  ├─ Duplicate detection
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
- Rate limiting (30 req/min per IP via `rateLimitMap`)
- Extension auto-discovery from `extensions/` folder
- Extension hot-reload via `fs.watch` (5s debounce)
- Request validation (max 2000 messages, max 2M chars)
- Calls `primeTreeName()` before the extension pipeline
- Calls `applyPromptCaching()` for Claude models
- Runs `transformRequest` pipeline
- Calls `wrapSendWithToolLoop()` or `sendToOpenRouter()` directly
- Runs `transformResponse` pipeline
- Log rotation (5MB cap, 7-day archive)
- Memory monitoring (warn at 400MB, restart at 600MB)
- Graceful shutdown on SIGTERM/SIGINT
- Dashboard bundle rebuild on startup via `execSync('node dashboard/build.js')`

**Critical variables:**
```js
START_TIME       // server start timestamp
lastRequestTime  // ISO string of last request
lastReply        // it now compares post-transform text.
RESTART_HISTORY  // array of { time, reason } restart records
```

**Extension loading order:**
1. `fs.readdirSync('extensions/')` — alphabetical
2. Sort by `priority` (ascending)
3. Mount any `router` properties at `/extensions/<filename>/`

**What can go wrong:**
- If an extension fails to load, it's skipped with a warning — the proxy still starts
- If `primeTreeName` crashes, TunnelVision won't work for that request
- If the dashboard bundle fails to build, the old bundle is used (non-fatal)
- Memory monitoring uses `setInterval(30s)` — a spike between checks won't trigger restart
- `rateLimitMap` is cleaned up every 60s via setInterval — stale entries are pruned automatically
- Bot log and duplicate detection now run after `transformResponse` — logs show final post-transform text
- Log rotation runs on a 5-minute interval, not per-write
- File writes to the log are async (non-blocking)

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

**What it does:** Applies Anthropic's prompt caching headers to Claude model requests. Splits the system prompt into paragraphs and adds `cache_control: { type: "ephemeral", ttl: "1h" }` to the last block. This tells Anthropic's API to cache the system prompt, significantly reducing token costs on long sessions.

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

**How it works:**
1. `enqueue()` pushes a `{ resolve, reject, queuedAt }` item to the queue
2. `next()` checks if a slot is available — if yes, resolves the oldest item with a `done` callback
3. Caller must call `done()` when their request finishes to free the slot
4. If a request waited longer than 60s, it's rejected with 408

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

**Config required:** `{ ollamaUrl, ollamaModel }`

**Important limits:**
- 30s timeout per embedding call (`AbortSignal.timeout(30_000)`)
- Empty/blank text throws immediately (doesn't call Ollama)
- `mxbai-embed-large` has a ~512 token context window — callers truncate to ~1800 chars before calling

**What can go wrong:**
- If Ollama container (192.168.1.193) is down, all RAG operations fail silently (logged as warnings, non-fatal)
- Uses Node.js native `fetch` (Node 18+)
- Ollama `/api/embed` returns `{ embeddings: [[...]] }` — if the shape changes, the extractor breaks

---

### lib/rag-retriever.js

**What it does:** The full RAG scoring pipeline. Takes a query, embeds it, searches Qdrant, applies temporal decay + keyword boost + emotion boost + conditional rules, deduplicates, and formats the result for injection.

**Key exports:**
```js
indexTurn(params, config)   // store a conversation turn in Qdrant
retrieve(params, config)    // query Qdrant and return formatted context string
sanitizeCollectionName(name) // sanitize char name for Qdrant collection naming
```

**Scoring pipeline (retrieve):**
1. Embed the query text (last N user messages joined)
2. Search Qdrant for top `topK * 2` candidates
3. For each hit:
   - Apply temporal decay: `score × max(floor, 0.5^(age/halfLife))` (exponential) or linear
   - Apply keyword boost: +0.05 per matching keyword, capped at +0.20
   - Apply emotion boost: +`emotionBoost` if chunk emotion matches current scene emotion
4. Filter by `scoreThreshold`
5. Apply conditional rules (emotion/keyword/recency conditions)
6. Sort descending, take top `topK`
7. Deduplicate by character-level similarity (>85% = duplicate)
8. Format as `[Relevant Memory Context]\nUser: ...\nCharacter: ...\n[End Memory Context]`

**indexTurn params:**
```js
{
  charName,       // character name (used for collection namespacing)
  userText,       // the user's message
  assistantText,  // the AI's reply (emotion tag already stripped)
  messageIndex,   // position in conversation
  emotion,        // detected emotion label
  temporallyBlind // if true, skip decay for this chunk (always retrieved at full score)
}
```

**What can go wrong:**
- If Qdrant is unreachable, `retrieve()` returns null and `indexTurn()` logs a warning — both are non-fatal
- The `similarity()` dedup function is a fast positional approximation — exact duplicates may slip through if text is shifted
- Temporal decay is calculated from `messageIndex` stored at index time vs `currentIndex` at retrieval time — if message count resets (new session), old chunks may appear with wrong ages

---

### lib/rag-store.js

**What it does:** Qdrant CRUD operations. Handles collection creation, upsert, search, and point count. All communication is via Qdrant's HTTP REST API.

**Key exports:**
```js
ensureCollection(collection, config)           // create if not exists (idempotent)
upsertPoint(collection, point, config)         // store a single vector + payload
queryPoints(collection, vector, topK, config)  // cosine similarity search
getPointCount(collection, config)              // count points in a collection
makePointId(charName, messageIndex, role)      // deterministic numeric ID
```

**Point ID generation:**
- `makePointId` generates a deterministic hash from `charName:messageIndex:role`
- This means re-indexing the same turn overwrites the existing point (upsert behavior)
- IDs are positive integers scaled to avoid JS integer overflow

**What can go wrong:**
- Qdrant requires `unsigned 64-bit integer` IDs — the hash function uses bitwise ops that can produce unexpected values for very long char names
- `ensureCollection` does a `GET` check before `PUT` — race condition if two requests try to create the same collection simultaneously (rare)
- All operations throw on non-OK responses — callers in `rag-retriever.js` wrap in try/catch

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
  summariesId: "summaries",   // always exists
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
  enabled, createdAt, updatedAt
}
```

**Key exports:**
```js
// I/O
loadTree(charName)          // load from disk or null
saveTree(tree)              // write to disk (auto-updates updatedAt)
getOrCreateTree(charName)   // load or create fresh
createTree(charName)        // create with root + summaries nodes
deleteTree(charName)        // delete file from disk
listTrees()                 // list all .json filenames (without extension)

// Node ops
addNode(tree, parentId, label, opts)   // add child node, saves tree
removeNode(tree, nodeId)               // remove node + descendants, orphan entries to root
moveNode(tree, nodeId, newParentId)    // reparent a node
getNode(tree, nodeId)                  // returns node or null
walkTree(tree, fn, startId)            // depth-first traversal
```

---

### extensions/ooc.js

**Priority:** 10 | **Hooks:** `transformRequest`

Handles out-of-character (OOC) messages from JanitorAI. Strips or routes OOC content before it reaches the model so it doesn't contaminate the roleplay context.

**Config file:** none  
**Routes:** none

---

### extensions/regex.js

**Priority:** 20 | **Hooks:** `transformResponse` | **Routes:** `/extensions/regex/*`

**What it does:** SillyTavern-compatible regex post-processor. Runs an ordered list of find/replace rules against every AI reply.

**Script processing:**
1. Load scripts from `data/regex-scripts.json`
2. For each enabled script, call `applyScript(text, script)`
3. `parseRegex()` handles both plain patterns and `/pattern/flags` format
4. `{{match}}` in replaceString is converted to `$&` (full match reference)
5. `trimStrings: true` trims whitespace from result

**Routes:** See `EXTENSIONS.md` for full route reference.

**What can go wrong:**
- Scripts are cached in memory with a dirty flag — disk reads only happen on first load
- Invalid regexes are rejected at creation/update/import time with a 400 error. If a script somehow has an invalid regex at runtime, it silently returns the original text unchanged.
- Scripts run in order — a script that modifies text can affect subsequent scripts
- `transformResponse` returns a new object — never mutates the original response body

---

### extensions/rag.js

**Priority:** 25 | **Hooks:** `transformRequest`, `transformResponse` | **Routes:** `/extensions/rag/*`

**What it does:** Semantic memory via Qdrant + Ollama. Full details in `EXTENSIONS.md`.

**State carried between hooks:**
```js
// Per-request state (transformRequest → transformResponse)
_pendingMap = Map<reqId, {
  userText,    // last user message (for indexing)
  msgCount,    // message count (for decay calculation)
  userName,    // user's name (for pronoun blocklisting)
  isReroll,    // true if same user message as last turn
}>

// Cross-turn state (persists across requests)
_turnState = {
  lastCharNames, // accumulated character names from all turns
  lastEmotion,   // emotion from previous turn
  lastUserText,  // for reroll detection
}
```

**Emotion flow:**
1. `transformRequest` injects `EMOTION_INSTRUCTION` into system prompt
2. Model prepends `<emotion>LABEL</emotion>` to its reply
3. `transformResponse` extracts and strips the tag before JanitorAI sees it
4. Emotion is stored with the indexed turn for future boost calculations

**Character name extraction:**
- Looks for `Name's ` possessive or `Name <action verb>` at start of lines
- Blocklists pronouns and the user's own name
- Falls back to last known name if extraction fails
- Names are sanitized for Qdrant collection naming

**What can go wrong:**
- Cross-turn state (`_turnState`) is still module-level — concurrent sessions with different characters would share accumulated names. Single-user usage avoids this.
- Per-request state uses `_pendingMap` with TTL cleanup — concurrent requests no longer overwrite each other's indexing data.
- Character name extraction relies on the AI starting sentences with the character's name — may fail for first-person narration
- If Ollama is slow, `transformRequest` blocks the entire request pipeline while waiting for the embedding
- `blindNextTurn` flag is written to disk and reset after use — if the proxy crashes between the write and the reset, it stays true permanently

---

### extensions/samplers.js

**Priority:** 30 | **Hooks:** `transformRequest` | **Routes:** `/extensions/samplers/*`

**What it does:** Injects sampler parameters (Top P, Top K, etc.) into outgoing requests based on saved config. Model-aware — Claude only gets `top_p` and `top_k`.

**Model family detection:**
- `claude` / `anthropic` → `"claude"` family → only `top_p`, `top_k`
- `gpt` / `openai` / `o1` / `o3` → `"openai"` family → full set
- Anything else → `"other"` family → full set

**Merge behavior:**
```js
return { ...payload, ...params };
```
Configured sampler values override JanitorAI defaults. Disable a sampler in the dashboard to let JanitorAI's value through.

**What can go wrong:**
- Config is loaded from disk on every request — no caching
- If `min_p` is enabled and Claude is the model, it's silently skipped (correct behavior, but confusing if you forget)
- The merge puts `params` first, so JanitorAI can override any sampler value

---

### extensions/prose-polisher.js

**Priority:** 40 | **Hooks:** `transformRequest`, `transformResponse`

**What it does:** Server-side repetition avoidance. Tracks n-grams (3 to `ngramMax` words) across responses. Builds a frequency + score map over time. Injects a style note into the system prompt listing the most overused phrases.

**Scoring factors per n-gram hit:**
- Base: `+1.0`
- Length bonus: `+(n-3) × 0.2` (longer phrases score higher)
- Uncommon word bonus: `+0.5` per word not in COMMON_WORDS
- Blacklist bonus: configurable per-phrase weights
- Not in dialogue: `×1.25` multiplier (narration repetition penalized more)

**Decay:** Applied every `decayInterval` messages. Each n-gram's score is multiplied by `(1 - decayRate/100)^cycles` where cycles = how many intervals since last seen.

**State files:**
- `data/prose-polisher-config.json` — thresholds, weights, whitelist, blacklist
- `data/prose-polisher-state.json` — live ngram frequency map

**What can go wrong:**
- State is loaded and saved synchronously on every response — adds latency at high message counts
- The state file can grow large over long sessions (many unique n-grams)
- `stripMarkup()` removes code blocks and HTML — if roleplay uses heavy markdown, this may strip too aggressively
- The injected slop list is in `transformRequest`, which runs before RAG context injection — so the slop note may be in the middle of a long system prompt

---

### extensions/tunnelvision.js

**Priority:** 26 | **Hooks:** `transformRequest`, `transformResponse` | **Routes:** `/extensions/tunnelvision/*`

**What it does:** Hierarchical lorebook memory via real Claude tool calls. Injects tool definitions into requests, runs the tool call loop, and manages the active tree.

**Bot name extraction:**
- Looks for `<BotName's Persona>` tag in the system message
- Pattern: `/<([A-Za-z][A-Za-z0-9 '_-]{0,39})'s Persona>/`
- Sanitizes the name with `sanitizeCharName()` for use as a filename

**Tool loop (`runToolLoop`):**
1. Send payload to OpenRouter
2. Check `finish_reason === "tool_calls"`
3. If tool calls present: execute against tree, append results, repeat
4. Cap at `MAX_TOOL_ROUNDS` (6) — forces `tool_choice: "none"` on final round
5. Return first non-tool-call response

**`primeTreeName(messages)`:**
- Called from `index.js` BEFORE the extension pipeline
- Ensures the tree is loaded before `rag.js` or other extensions modify messages
- Sets `_pendingTreeName` for use in `transformRequest` and `wrapSendWithToolLoop`

**`wrapSendWithToolLoop(payload, sendFn)`:**
- Called from `index.js` instead of `sendToOpenRouter` directly
- Only activates if TunnelVision tools are present in the payload
- Falls back to direct `sendFn` if no tree is loaded

**State:**
```js
_pendingTreeName  // module-level, set by primeTreeName, used by wrapSendWithToolLoop
_pendingTreeName  // set by primeTreeName, used by transformRequest + wrapSendWithToolLoop
_pendingTree      // cached tree reference, avoids redundant disk reads
_configCache      // config cached in memory, invalidated on save
```

**What can go wrong:**
- `_pendingTreeName` is module-level — concurrent requests overwrite each other (same problem as RAG's `_pending`)
- If `primeTreeName` doesn't find a `<BotName's Persona>` tag, TunnelVision won't activate for that request
- The tool loop appends to `messages` on each round — very deep tool call chains create long context

---

### extensions/recast.js

**Priority:** 45 | **Hooks:** `transformRequest`, `transformResponse` | **Routes:** `/extensions/recast/*`

**What it does:** "The 4 Steps of Roleplay" — a background quality-control pipeline. Runs last in the pipeline after all other extensions. Each step judges the fully post-processed reply with a fast YES/NO check. On failure, a rewrite pass runs and the check repeats up to `maxRetries` times. The final output silently replaces the reply before JanitorAI sees it.

**The 4 Steps:**

| Step | Name | Checks |
|------|------|--------|
| 1 | System Prompt Compliance | Format rules, response header, acoustic payload mandate, show-don't-tell, forbidden elements |
| 2 | Characters | Voice, speech patterns, personality consistency, proportional emotional reactions |
| 3 | World | Physical/causal coherence, no retcons, persistent environment, time/resource realism |
| 4 | Story Progression | Narrative momentum, no stagnation, no unearned intensity jumps, scene closure law |

**State carried between hooks:**
```js
_pending = {
  model,        // request model string (fallback if no checkModel/rewriteModel set)
  systemPrompt, // longest system message (original character card + framework)
  charCard,     // extracted character card block (with fallbacks for untagged cards)
  userPersona,  // extracted user persona block (with fallbacks)
  messages,     // full messages array for recent context extraction
}
```

**Character card extraction (with fallbacks):**
1. `<CharName's Persona>...</CharName's Persona>` — JanitorAI standard tagged format
2. `<CharName>...</CharName>` — bare inner tag only
3. First 3000 chars of system prompt — covers all untagged cards (character info always leads)

**User persona extraction (with fallbacks):**
1. `<UserPersona>...</UserPersona>` — standard tag
2. Last 500 chars of system prompt — JanitorAI always appends persona at the bottom

**Routes:** See `EXTENSIONS.md` for full route and config reference.

**What can go wrong:**
- `_pending` is module-level — concurrent requests overwrite each other's stashed context (same issue as rag.js and tunnelvision.js). Reduce `MAX_CONCURRENT` to 1 in `lib/queue.js` if this causes problems.
- Each failed step costs 2 extra OpenRouter calls (rewrite + recheck). Worst case with 4 steps and `maxRetries: 2` is 12 extra calls per response. Always set `checkModel` to a cheap fast model.
- If `checkModel` returns prose instead of YES/NO, it will never match `startsWith('YES')` and will always trigger rewrites. Use a model that reliably follows short instructions.
- Recast runs synchronously in `transformResponse` — the full pipeline must complete before the response is returned to JanitorAI. Long rewrite chains will noticeably delay responses.

---

### dashboard/index.html

**What it does:** The single-page dashboard HTML shell. Contains all modals, tab panels, and stat card markup. Loads CSS and JS from separate files.

**Tabs:** Overview, Logs, Settings

**Modals:**
- `#msg-modal` — full message text viewer
- `#script-modal` — regex script editor
- `#tv-entry-modal` — TunnelVision add entry
- `#tv-node-modal` — TunnelVision add channel

**Script load order** (bottom of body — must be in this order):
1. `dashboard-core.js` — defines `esc()`, clock, tabs, init
2. `dashboard-overview.js` — `fetchStats()`, `fetchHealth()`
3. `dashboard-logs.js` — `fetchLogs()`, `renderLogs()`
4. `dashboard-samplers.js` — `fetchSamplers()`, `drawGraph()`
5. `dashboard-regex.js` — `fetchRegexScripts()`
6. `dashboard-rag.js` — `fetchRagStatus()`
7. `dashboard-tunnelvision.js` — `fetchTvStatus()`, `fetchTvTrees()`

**What can go wrong:**
- Script load order matters — `esc()` from `core.js` is used by all other files
- In production, `dashboard.bundle.js` replaces all 7 script tags — if the bundle is stale, old code runs

---

### dashboard/dashboard.css

**What it does:** All styles for the dashboard. Frutiger Aero / glassmorphism aesthetic. Uses CSS variables from the body background for consistency.

**Key design tokens:**
- Glass cards: `rgba(255,255,255,0.62)` background, `blur(14px)` backdrop filter
- Primary gradient: `#1060a0` → `#0d9e8a` → `#1878c0`
- Success green: `#00d97e`
- Error red: `#ff4444`
- Warning orange: `#ffa500`

---

### dashboard/build.js

**What it does:** Concatenates all 7 dashboard JS files into `dashboard/dashboard.bundle.js` in the correct load order. Run automatically on proxy startup.

**File order (hardcoded):**
```js
const FILES = [
  'js/dashboard-core.js',
  'js/dashboard-overview.js',
  'js/dashboard-logs.js',
  'js/dashboard-samplers.js',
  'js/dashboard-regex.js',
  'js/dashboard-rag.js',
  'js/dashboard-tunnelvision.js',
];
```

**Adding a new JS file:** Add it to the `FILES` array in the correct position, then restart the proxy.

**What can go wrong:**
- If a file is missing, it's skipped with a warning and the bundle continues without it
- The bundle is auto-generated — never edit `dashboard.bundle.js` directly

---

### dashboard/js/dashboard-core.js

**What it does:** Bubble background animation, clock (America/New_York timezone), tab switching, proxy restart, and the shared `esc()` HTML escaping helper.

**Global functions exposed:**
```js
esc(s)              // HTML-escape a string — used by all other dashboard files
switchTab(name, btn) // switch visible tab + trigger data fetches
restartProxy()      // POST /dashboard/restart
updateClock()       // update clock display (runs every 1s)
```

**Init calls (bottom of file):**
```js
fetchStats();   // from dashboard-overview.js
fetchHealth();  // from dashboard-overview.js
setInterval(fetchStats, 30000);
setInterval(fetchHealth, 10000);
```

---

### dashboard/js/dashboard-overview.js

**What it does:** Fetches and renders the stats cards and health/extensions panel on the Overview tab.

**Functions:**
```js
fetchStats()   // reads /dashboard/logs, computes today's stats
fetchHealth()  // reads /health, renders uptime + extension chips
formatUptime(s) // seconds → "Xh Ym" string
```

---

### dashboard/js/dashboard-logs.js

**What it does:** Log viewer with type filters, pagination, expandable entries, and message preview modal.

**State:**
```js
activeFilters  // Set of active filter types
allLogs        // raw + parsed log array (reversed)
curPage        // current pagination page
msgStore       // { key: fullMessageText } for modal
```

**Functions:**
```js
fetchLogs()         // GET /dashboard/logs
renderLogs()        // filter + paginate + render
toggleFilter(type)  // toggle filter pill
clearLogs()         // DELETE /dashboard/logs
openModal(title, key) // show full message in modal
```

---

### dashboard/js/dashboard-samplers.js

**What it does:** Sampler sliders UI with model selector and live token probability graph.

**Functions:**
```js
fetchSamplers()   // GET /extensions/samplers/config?model=...
renderSamplers()  // build slider DOM elements
onSlider()        // update value displays + redraw graph
saveSamplers()    // POST /extensions/samplers/config
drawGraph()       // canvas-based probability distribution visualization
```

---

### dashboard/js/dashboard-regex.js

**What it does:** Regex script manager — list, create, edit, delete, toggle, reorder, import/export, and live test.

**State:**
```js
rxScripts    // current scripts array
rxEditingId  // ID of script being edited in modal (null = new)
```

---

### dashboard/js/dashboard-rag.js

**What it does:** RAG controls — enable/disable toggle, blind next turn, collections list with clear, and config sliders.

**State:**
```js
_ragConfig  // current config object (loaded from /extensions/rag/status)
```

---

### dashboard/js/dashboard-tunnelvision.js

**What it does:** TunnelVision status, tree list, tree editor with expandable nodes/entries, and add channel/entry modals.

**State:**
```js
_tvEditorName    // name of tree currently being edited
_tvEditorNodeId  // node ID for add-entry modal context
```

---

## Data Files

| File | Owner | Description |
|------|-------|-------------|
| `data/regex-scripts.json` | regex.js | Ordered array of regex script objects |
| `data/rag-config.json` | rag.js | RAG configuration including Qdrant/Ollama URLs |
| `data/sampler-config.json` | samplers.js | Per-sampler enabled + value settings |
| `data/prose-polisher-config.json` | prose-polisher.js | Thresholds, decay rates, whitelist, blacklist |
| `data/prose-polisher-state.json` | prose-polisher.js | Live n-gram frequency map |
| `data/tunnelvision-config.json` | tunnelvision.js | Active tree override, auto-detect flag |
| `data/tunnelvision/<charName>.json` | tv-tree.js | One tree per character, auto-created |
| `data/recast-config.json` | recast.js | Step enable flags, model overrides, retry cap |
| `logs/requests.log` | index.js | JSONL request log, rotated at 5MB |

**Important:** The `data/` folder is excluded from Git. Back it up separately.

---

## Common Errors & Fixes

**Proxy won't start / crashes on startup**
- Check Docker logs: `docker logs proxy -f`
- Most likely an extension failed to load — look for `[extensions] Failed to load`
- Check that `data/` directory exists and is writable

**Dashboard shows blank / CSS not loading**
- Check that `app.use('/dashboard', express.static(...))` is in `index.js`
- Check that `dashboard/dashboard.bundle.js` was built (look for `[proxy] ✦ Dashboard bundle built` in logs)

**TunnelVision not activating**
- Check that the bot card has a `<BotName's Persona>` tag in the system prompt
- Check `_pendingTreeName` — if it's null after `primeTreeName()`, the tree won't load
- Check `data/tunnelvision/` exists and the tree file is valid JSON

**RAG not injecting context**
- Check Qdrant is reachable: `curl http://192.168.1.192:6333/health`
- Check Ollama is reachable: `curl http://192.168.1.193:11434/api/tags`
- Check `data/rag-config.json` — `enabled` must be `true`
- First message of a new session won't inject (char name is "unknown" until first response)

**Circuit breaker keeps opening**
- OpenRouter is returning 5xx errors repeatedly
- Check OpenRouter status page
- Check your API key is valid and has credits
- The breaker resets after 30s automatically

**Memory keeps hitting 600MB / frequent restarts**
- A very long roleplay session is the most common cause
- TunnelVision's tool loop appends to messages each round — check `MAX_TOOL_ROUNDS`
- Prose Polisher state file may have grown large — delete `data/prose-polisher-state.json` to reset

**Regex scripts not applying**
- Check `data/regex-scripts.json` — scripts must have `enabled: true`
- Check the regex pattern is valid — invalid patterns silently return original text
- Remember `transformResponse` runs AFTER TunnelVision strips its tags

**Concurrent request issues (wrong character names, wrong tree)**
- rag.js uses `_pendingMap` for per-request state (safe) but `_turnState` for cross-turn state (shared)
- tunnelvision.js uses `_pendingTreeName` and `_pendingTree` which are module-level
- recast.js uses `_pending` which is module-level (documented as single-user safe)
- If two roleplay sessions run simultaneously, they share state
- The queue (`MAX_CONCURRENT = 3`) reduces but doesn't eliminate this
- Workaround: reduce `MAX_CONCURRENT` to 1 in `lib/queue.js`

**Recast keeps rewriting / responses are very slow**
- Check that `checkModel` is set to a fast cheap model (e.g. `anthropic/claude-haiku-4-5`)
- If left blank, recast uses the main request model for checks — expensive for a 100-token YES/NO call
- Lower `maxRetries` in `data/recast-config.json` to reduce worst-case extra calls
- Disable individual steps via `data/recast-config.json` if one step is consistently failing

**Recast always failing a step / infinite rewrites hitting cap**
- The check model may be ignoring the YES/NO instruction and writing prose — switch models
- The check prompt for that step may be too strict for your writing style — temporarily disable that step and re-enable after adjusting `maxRetries` down to 1
- Check proxy logs for `[recast] ⚠` lines to see exactly which step is failing and why