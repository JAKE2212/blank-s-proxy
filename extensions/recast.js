// extensions/recast.js
// "The 4 Steps of Roleplay" — a check/rewrite pipeline that runs after every
// AI response. Each step judges the reply with a fast YES/NO call. On failure,
// a rewrite pass runs, then the check re-runs. A per-step retry cap prevents
// infinite loops. The final output replaces the original reply.
//
// Priority 45 — runs after prose-polisher (40).

"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const router = express.Router();
const CONFIG_PATH = path.join(__dirname, "../data/recast-config.json");
const localModels = require("../lib/local-models");
const { loadTree, getAllEntries } = require("../lib/tunnelvision/tv-tree");
const { getLastParsed } = require("../lib/custom-prompt");
const replyCache = require("../lib/reply-cache");

// ── Defaults ───────────────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  enabled: true,
  maxRetries: 2, // max rewrite attempts per step before giving up
  checkModel: "", // model for YES/NO checks  ('' = use request model)
  rewriteModel: "", // model for rewrites       ('' = use request model)
  checkTokens: 100, // max tokens for check responses
  rewriteTokens: 2048, // max tokens for rewrite responses
  skipAfterPasses: 5, // skip a step after N consecutive passes (0 = never skip)

  steps: {
    step1: {
      enabled: true,
      name: "System Prompt Compliance",
      description:
        "Broad catch-all. Checks format rules, headers, acoustic payload, show-don't-tell, forbidden phrases.",
    },
    step2: {
      enabled: true,
      name: "Characters",
      description:
        "Voice, personality, speech patterns, proportional emotional reactions — all grounded in the character card.",
    },
    step3: {
      enabled: true,
      name: "World",
      description:
        "Physical/causal world coherence. No retcons, persistent environment, time progression, resource scarcity.",
    },
    step4: {
      enabled: true,
      name: "Story Progression",
      description:
        "Narrative momentum. Did something shift? No stagnation, no unearned intensity jumps, no philosophical endings.",
    },
  },
};

// ── Check prompts ──────────────────────────────────────────────────────────────
// Each returns a system prompt for the YES/NO check call.
// {{SYSTEM_PROMPT}}, {{CHAR_CARD}}, {{USER_PERSONA}}, {{RECENT}}, {{REPLY}}
// are replaced at runtime.

const CHECK_PROMPTS = {
  step1: `You are a lenient quality-control editor. You WANT responses to pass. You are looking for reasons to say YES, not reasons to say NO.

Only fail a response if there is a MAJOR, UNMISTAKABLE violation of one of these rules:

1. USER SOVEREIGNTY: The response wrote dialogue, thoughts, or decisions for the user character. This is the ONLY rule that should be checked strictly. Everything else gets the benefit of the doubt.

2. SCENE CLOSURE: The response ends with a philosophical summary paragraph that wraps up the scene's meaning. Ending on a mood, a lingering image, or an unresolved tension is FINE — only fail if the last paragraph literally explains the theme or moral.

3. FORMAT: Spoken dialogue should use "double quotes". This only matters if dialogue is clearly missing quotes entirely.

Rules that are NOT worth failing over:
- Missing or imperfect scene headers (nice to have, not required)
- Missing phonetic sounds on vocalizations (nice to have, not required)
- Prose style choices, word selection, pacing decisions
- Anything borderline or debatable

YOUR DEFAULT ANSWER IS YES. Only say NO if you are absolutely certain there is a clear, major violation. When in doubt, ALWAYS say YES.

SYSTEM PROMPT (for reference):
{{SYSTEM_PROMPT}}

AI RESPONSE:
{{REPLY}}

Answer with exactly one word: YES or NO.`,

  step2: `You are a character authenticity editor for AI roleplay responses.

You will be given:
- The character card describing the NPC's personality, voice, speech patterns, and psychology
- Lorebook data about characters and story events (if available)
- The user persona
- Recent conversation messages for context
- The AI's response

Your job: does every character act AND sound like themselves? Are emotional reactions proportional to what actually happened?

Focus on:
- Voice and speech patterns (vocabulary, verbal tics, sentence rhythm, era-appropriate language)
- Personality consistency (do their actions match their established psychology and wounds?)
- Proportional reactions (no crying or breaking down over minor things, no shrugging off genuinely devastating events)
- Behavioral patterns (do they use their established defense mechanisms, not generic ones?)
- If lorebook data is provided, check for contradictions with established character facts

IMPORTANT: Characters can surprise us — growth and contradiction are valid. Only fail if the character acts in a way that is fundamentally incompatible with who they are. When in doubt, pass it.

CHARACTER CARD:
{{CHAR_CARD}}
{{TV_CONTEXT}}

USER PERSONA:
{{USER_PERSONA}}

RECENT CONVERSATION:
{{RECENT}}

AI RESPONSE:
{{REPLY}}

Answer with exactly one word: YES (characters are consistent) or NO (there is a clear character violation).`,

  step3: `You are a world-coherence editor for AI roleplay responses.

You will be given:
- Recent conversation messages establishing the current world state
- The AI's response

Your job: does the physical and causal world hold together?

Focus on:
- No convenience physics (things happen because the plot needs them, not because they make sense)
- No retcons (contradicting something established earlier in the conversation)
- Persistent environment (objects, damage, scents, and traces from prior events are still present)
- Time progression logic (actions take realistic time, no teleporting between locations)
- Resource and injury realism (wounds don't vanish, things that were broken stay broken)

IMPORTANT: Creative license is fine. Only fail if there is a clear physical or logical contradiction that breaks the world's internal consistency.

RECENT CONVERSATION:
{{RECENT}}

AI RESPONSE:
{{REPLY}}

Answer with exactly one word: YES (world is coherent) or NO (there is a clear world violation).`,

  step4: `You are a narrative momentum editor for AI roleplay responses.

You will be given:
- Recent conversation messages establishing the current scene state
- The AI's response

Your job: is the story actually moving forward?

Focus on:
- Did something shift — tension, power dynamic, relationship, information, proximity?
- No unearned intensity jumps (scene went from 0 to 100 without building to it)
- No stagnation (exactly the same emotional/situational state as before, nothing changed)
- No philosophical endings (response ends with thematic summary or meaning-making statement instead of action/dialogue/environment)
- Scene closure law respected (cuts on action, spoken line, or environmental shift)

IMPORTANT: Slow burns and quiet moments are valid narrative strategies. Only fail if literally nothing changed and there is no forward hook, OR if the intensity jumped wildly without being earned.

RECENT CONVERSATION:
{{RECENT}}

AI RESPONSE:
{{REPLY}}

Answer with exactly one word: YES (story is progressing) or NO (there is a clear progression failure).`,
};

// ── Rewrite prompts ────────────────────────────────────────────────────────────

const REWRITE_PROMPTS = {
  step1: `You are a prose editor. The response below has ONE of these issues:

1. It wrote dialogue, thoughts, or decisions for the user character — remove those parts
2. It ended with a philosophical summary paragraph — cut it and end on action, dialogue, or environment instead
3. Spoken dialogue is missing "double quotes" — add them

Fix ONLY the specific issue. Change as little as possible. Preserve all content, events, characters, plot, voice, and style.

Respond with only the corrected text. No commentary, no preamble.

SYSTEM PROMPT (for reference):
{{SYSTEM_PROMPT}}

RESPONSE TO FIX:
{{REPLY}}`,

  step2: `You are a character authenticity editor. The response below has a character consistency or proportional reaction problem.

Rewrite it so that:
- Every character acts and speaks in a way that is true to their established personality, psychology, and speech patterns
- Emotional reactions are proportional to what actually happened
- Dialogue sounds like that specific person (vocabulary, verbal tics, era-appropriate language)
- Defense mechanisms and behavioral patterns match the character card
- If lorebook data is provided, don't contradict established character facts

Preserve all plot events and narrative content. Only fix the character authenticity issues.
Respond with only the corrected text. No commentary, no preamble.

CHARACTER CARD:
{{CHAR_CARD}}
{{TV_CONTEXT}}

USER PERSONA:
{{USER_PERSONA}}

RECENT CONVERSATION:
{{RECENT}}

RESPONSE TO FIX:
{{REPLY}}`,

  step3: `You are a world-coherence editor. The response below has a physical or causal consistency problem.

Rewrite it so that:
- The physical world follows its own internal logic — no convenience physics
- Nothing contradicts what was established in the recent conversation
- Environmental details (damage, objects, scents, traces) persist from prior events
- Time and spatial movement are realistic
- Wounds, broken things, and depleted resources stay that way

Preserve all character voices and narrative intent. Only fix the world-coherence issues.
Respond with only the corrected text. No commentary, no preamble.

RECENT CONVERSATION:
{{RECENT}}

RESPONSE TO FIX:
{{REPLY}}`,

  step4: `You are a narrative momentum editor. The response below has a story progression problem — either nothing changed, the intensity jumped without being earned, or it ended with a philosophical summary.

Rewrite it so that:
- Something shifts — tension, power, relationship, information, or proximity
- If the scene was building, the intensity increase feels earned by what came before
- The response ends on action, a spoken line, or an environmental shift — NOT a thematic wrap-up
- There is a forward hook that leaves something unresolved

Preserve all character voices and world details. Only fix the narrative momentum issues.
Respond with only the corrected text. No commentary, no preamble.

RECENT CONVERSATION:
{{RECENT}}

RESPONSE TO FIX:
{{REPLY}}`,
};

// ── TunnelVision lorebook helper ───────────────────────────────────────────────

/**
 * Pull relevant character entries from TunnelVision for recast checks.
 * Returns a formatted string of character lorebook data, or empty string.
 */
function getTVCharacterContext() {
  try {
    const parsed = getLastParsed();
    if (!parsed.botName) return "";
    const tree = loadTree(parsed.botName.toLowerCase().replace(/[^a-z0-9_-]/g, "_"));
    if (!tree) return "";
    const entries = getAllEntries(tree);
    if (!entries.length) return "";

    // Pull character-relevant entries (skip summaries, keep personality/quirk/relationship entries)
    const charEntries = entries
      .filter(e => !e.nodeId.startsWith("summaries"))
      .slice(0, 10) // cap to avoid huge prompts
      .map(e => `[${e.entry.title}]\n${e.entry.content}`)
      .join("\n\n");

    const summaryEntries = entries
      .filter(e => e.nodeId === "summaries" || e.nodeLabel === "Summaries")
      .slice(0, 5)
      .map(e => `[${e.entry.title}]\n${e.entry.content}`)
      .join("\n\n");

    let result = "";
    if (charEntries) result += `\n\n[TunnelVision — Character Data]\n${charEntries}`;
    if (summaryEntries) result += `\n\n[TunnelVision — Story Summaries]\n${summaryEntries}`;
    return result;
  } catch {
    return "";
  }
}

// ── Pending context (stashed in transformRequest, used in transformResponse) ───
// Per-request context (transformRequest → transformResponse)
// Single-slot — safe for single-user, would need a map for concurrent requests
let _pending = null;

// Track consecutive pass streaks per step
const _passStreaks = { step1: 0, step2: 0, step3: 0, step4: 0 };

// ── Helpers ────────────────────────────────────────────────────────────────────

let _configCache = null;

function loadConfig() {
  if (_configCache) return _configCache;
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
      const merged = { ...DEFAULT_CONFIG, ...saved };
      merged.steps = { ...DEFAULT_CONFIG.steps, ...(saved.steps || {}) };
      for (const k of Object.keys(DEFAULT_CONFIG.steps)) {
        merged.steps[k] = {
          ...DEFAULT_CONFIG.steps[k],
          ...(merged.steps[k] || {}),
        };
      }
      _configCache = merged;
      return _configCache;
    }
  } catch (e) {
    console.warn("[recast] Failed to load config:", e.message);
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2));
  _configCache = { ...DEFAULT_CONFIG };
  return _configCache;
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  _configCache = null;
}

/** Extract the longest system message (the original character card prompt). */
function extractSystemPrompt(messages) {
  if (!messages || !messages.length) return "";
  const sys = messages.filter((m) => m.role === "system");
  if (!sys.length) return "";
  return (
    sys.reduce((a, b) => {
      const al = typeof a.content === "string" ? a.content.length : 0;
      const bl = typeof b.content === "string" ? b.content.length : 0;
      return bl > al ? b : a;
    }).content || ""
  );
}

/** Extract <CharName's Persona>...</CharName's Persona> block.
 *  Falls back to the first 3000 chars of the system prompt if no tag is found —
 *  character info is always near the top regardless of formatting. */
function extractCharCard(systemPrompt) {
  if (!systemPrompt) return "";
  // Try <CharName's Persona> wrapper (JanitorAI standard)
  const tagged = systemPrompt.match(
    /<([^>]+?)'s Persona>([\s\S]*?)<\/\1's Persona>/,
  );
  if (tagged) return tagged[0];
  // Try bare <CharName>...</CharName> inner block
  const inner = systemPrompt.match(/<([A-Z][^>]{1,60})>([\s\S]*?)<\/\1>/);
  if (inner) return inner[0];
  // Fallback: first 3000 chars of system prompt covers the character info
  // in virtually all untagged bot cards
  return systemPrompt.slice(0, 3000);
}

/** Extract <UserPersona>...</UserPersona> block.
 *  Falls back to the last 500 chars of the system prompt — JanitorAI always
 *  appends the user persona at the very end, tagged or not. */
function extractUserPersona(systemPrompt) {
  if (!systemPrompt) return "";
  // Try standard <UserPersona> tag
  const tagged = systemPrompt.match(/<UserPersona>([\s\S]*?)<\/UserPersona>/);
  if (tagged) return tagged[0];
  // Fallback: last 500 chars (JanitorAI appends user persona at the bottom)
  const tail = systemPrompt.slice(-500).trim();
  return tail ? `[User Persona (untagged)]:\n${tail}` : "";
}

/** Get last N user/assistant messages as a formatted string. */
function extractRecentMessages(messages, n = 6) {
  if (!messages) return "";
  const turns = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => {
      const content =
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.map((b) => b.text || "").join("")
            : "";
      // Strip JanitorAI SYSTEM NOTEs appended to user messages
      const clean = content.replace(/\nSYSTEM NOTE:[^\n]*/gi, "").trim();
      return `[${m.role.toUpperCase()}]: ${clean}`;
    });
  return turns.slice(-n).join("\n\n");
}

/** Fill template placeholders. */
function fillTemplate(template, vars) {
  return template
    .replace(/\{\{SYSTEM_PROMPT\}\}/g, vars.systemPrompt || "")
    .replace(/\{\{CHAR_CARD\}\}/g, vars.charCard || "")
    .replace(/\{\{TV_CONTEXT\}\}/g, vars.tvContext || "")
    .replace(/\{\{USER_PERSONA\}\}/g, vars.userPersona || "")
    .replace(/\{\{RECENT\}\}/g, vars.recent || "")
    .replace(/\{\{REPLY\}\}/g, vars.reply || "");
}

/** Single OpenRouter call. Returns response text or throws. */
async function callOpenRouter(systemPrompt, userContent, model, maxTokens) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("No OPENROUTER_API_KEY");

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${txt}`);
  }

  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

const STEP_LABELS = {
  step1: "Step 1 — System Prompt Compliance",
  step2: "Step 2 — Characters",
  step3: "Step 3 — World",
  step4: "Step 4 — Story Progression",
};

/** Run one step: check → maybe rewrite → recheck. Returns final reply text. */
async function runStep(stepKey, stepNumber, reply, vars, config, requestModel) {
  const stepCfg = config.steps[stepKey];
  const label = STEP_LABELS[stepKey] || stepKey;

  if (!stepCfg?.enabled) {
    console.log(`[recast] ⏭  ${label} — skipped (disabled)`);
    return reply;
  }

  // Skip steps that have been passing consistently
  const skipAfter = config.skipAfterPasses ?? 0;
  if (skipAfter > 0 && _passStreaks[stepKey] >= skipAfter) {
    console.log(`[recast] ⏭  ${label} — skipped (${_passStreaks[stepKey]} consecutive passes)`);
    return reply;
  }

  console.log(`[recast] 🔍 Doing check ${stepNumber} — ${label}...`);

  const checkModel = config.checkModel || requestModel;
  const rewriteModel = config.rewriteModel || requestModel;
  const maxRetries = config.maxRetries ?? 2;

  let current = reply;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // ── Check ──
    const checkPrompt = fillTemplate(CHECK_PROMPTS[stepKey], {
      ...vars,
      reply: current,
    });
    let verdict = "";
    try {
      const lm = localModels.loadConfig();
      if (lm.recastLocal) {
        verdict = await localModels.callOllama(
          "You are a strict but fair quality-control judge. Answer only YES or NO.",
          checkPrompt,
          lm.recastCheckModel,
          config.checkTokens ?? 100,
        );
      } else {
        verdict = await callOpenRouter(
          "You are a strict but fair quality-control judge. Answer only YES or NO.",
          checkPrompt,
          checkModel,
          config.checkTokens ?? 100,
        );
      }
    } catch (e) {
      console.warn(
        `[recast] ⚠  ${label} — check error (attempt ${attempt + 1}): ${e.message}`,
      );
      console.log(`[recast] ↪  ${label} — skipping due to error, moving on.`);
      return current;
    }

    const passed = verdict.toUpperCase().startsWith("YES");

    if (passed) {
      _passStreaks[stepKey]++;
      console.log(`[recast] ✅ ${label} — PASSED! Moving to next check... (streak: ${_passStreaks[stepKey]})`);
      return current;
    }

    // Failed — reset the streak
    _passStreaks[stepKey] = 0;

    if (attempt === maxRetries) {
      console.warn(
        `[recast] ⚠  ${label} — FAILED after ${maxRetries + 1} attempt(s), passing through anyway.`,
      );
      return current;
    }

    // ── Rewrite ──
    console.log(
      `[recast] ❌ ${label} — FAILED! Rewriting... (attempt ${attempt + 1}/${maxRetries})`,
    );
    const rewritePrompt = fillTemplate(REWRITE_PROMPTS[stepKey], {
      ...vars,
      reply: current,
    });
    try {
      const rewritten = await callOpenRouter(
        "You are a precise prose editor. Output only the corrected text, nothing else.",
        rewritePrompt,
        rewriteModel,
        config.rewriteTokens ?? 2048,
      );
      if (rewritten) {
        current = rewritten;
        console.log(`[recast] ✏  ${label} — Rewrite done. Rechecking...`);
      }
    } catch (e) {
      console.warn(
        `[recast] ⚠  ${label} — rewrite error (attempt ${attempt + 1}): ${e.message}`,
      );
      console.log(
        `[recast] ↪  ${label} — skipping remaining retries, moving on.`,
      );
      return current;
    }
  }

  return current;
}

// ── Hooks ──────────────────────────────────────────────────────────────────────

async function transformRequest(payload) {
  // Stash context for use in transformResponse
  try {
    // Prefer raw system prompt stashed by index.js (before extensions modified it)
    const systemPrompt = module.exports._rawSystemPrompt ?? extractSystemPrompt(payload.messages);
    module.exports._rawSystemPrompt = null; // consume it
    _pending = {
      model: payload.model || "",
      systemPrompt,
      charCard: extractCharCard(systemPrompt),
      userPersona: extractUserPersona(systemPrompt),
      messages: payload.messages || [],
    };
  } catch (e) {
    console.warn("[recast] transformRequest stash error:", e.message);
    _pending = null;
  }
  return payload;
}

async function transformResponse(data) {
  const config = loadConfig();
  if (!config.enabled) return data;
  if (!_pending) return data;

  const originalReply = data?.choices?.[0]?.message?.content;
  if (!originalReply || typeof originalReply !== "string") return data;

  // Skip recast on rerolls if the previous reply already passed all checks
  const userText = typeof _pending.messages?.findLast?.(m => m.role === "user")?.content === "string"
    ? _pending.messages.findLast(m => m.role === "user").content
    : "";
  if (replyCache.shouldSkipRecast(userText)) {
    console.log("[recast] ⏭  Skipping — reroll of a previously passed reply");
    _pending = null;
    return data;
  }

  const vars = {
    systemPrompt: _pending.systemPrompt,
    charCard: _pending.charCard,
    tvContext: getTVCharacterContext(),
    userPersona: _pending.userPersona,
    recent: extractRecentMessages(_pending.messages, 6),
  };

  const requestModel = _pending.model;
  _pending = null;

  let reply = originalReply;

  try {
    console.log(
      `[recast] ✦ Finished response! Checking message through 4 steps...`,
    );
    const stepKeys = ["step1", "step2", "step3", "step4"];
    for (let i = 0; i < stepKeys.length; i++) {
      reply = await runStep(
        stepKeys[i],
        i + 1,
        reply,
        vars,
        config,
        requestModel,
      );
    }
    console.log(`[recast] 🎉 All checks done! Sending message to JanitorAI.`);
  } catch (e) {
    console.error("[recast] 💥 Pipeline error:", e.message);
    return data; // return original on catastrophic failure
  }

  // Strip any emotion tag that rewrite may have re-introduced
    const cleanReply = reply.replace(/<emotion>[a-z]+<\/emotion>\s*/i, "").trimStart();

    if (cleanReply === originalReply) return data;
    return {
      ...data,
      choices: data.choices.map((c, i) =>
        i === 0 ? { ...c, message: { ...c.message, content: cleanReply } } : c,
      ),
    };
}

// ── Routes ─────────────────────────────────────────────────────────────────────

router.get("/config", (req, res) => {
  res.json({ ok: true, config: loadConfig() });
});

router.post("/config", (req, res) => {
  try {
    const current = loadConfig();
    const updated = { ...current, ...req.body };
    // Preserve deep step structure
    if (req.body.steps) {
      updated.steps = { ...current.steps };
      for (const [k, v] of Object.entries(req.body.steps)) {
        updated.steps[k] = { ...current.steps[k], ...v };
      }
    }
    saveConfig(updated);
    res.json({ ok: true, config: updated });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get("/status", (req, res) => {
  const config = loadConfig();
  res.json({
    ok: true,
    enabled: config.enabled,
    steps: Object.entries(config.steps).map(([key, s]) => ({
      key,
      name: s.name,
      description: s.description,
      enabled: s.enabled,
    })),
    models: {
      check: config.checkModel || "(uses request model)",
      rewrite: config.rewriteModel || "(uses request model)",
    },
    maxRetries: config.maxRetries,
  });
});

// ── Export ─────────────────────────────────────────────────────────────────────

module.exports = {
  name: "Recast — 4 Steps of Roleplay",
  version: "1.0",
  priority: 45,
  router,
  transformRequest,
  transformResponse,
};
