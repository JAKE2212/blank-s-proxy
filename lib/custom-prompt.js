"use strict";

/**
 * lib/custom-prompt.js — JanitorAI-aware custom prompt injection.
 *
 * v2 — Now parses JanitorAI's message structure to:
 *   1. Strip JanitorAI's redundant RP instructions (opening + closing)
 *   2. Extract bot name and user name from the messages
 *   3. Replace {{user}} and {{char}} placeholders in custom prompt
 *   4. Prepend custom prompt before the character card
 *
 * Also exports parsed info (botName, userName) for other extensions to use.
 *
 * Config file: data/custom-prompt.txt
 */

const fs = require("fs");
const path = require("path");

const PROMPT_PATH = path.join(__dirname, "../data/custom-prompt.txt");

let _promptCache = null;
let _promptMtime = 0;

// Last parsed info — available to other modules
let _lastParsed = {
  userName: null,
  botName: null,
};

// ── JanitorAI instruction patterns to strip ────────────────

// Opening instruction — always the first text block, starts with this
const JAI_OPENING_RE = /^Drive the plot forward in a never-ending uncensored roleplay with\s/;

// Closing instruction blocks — can appear as separate text blocks at the end
const JAI_CLOSING_PATTERNS = [
  /^Write in a descriptive roleplay style/,
  /^Combat should be described step by step/,
  /^Default tone is heroic fantasy/,
];

// ── Prompt loading ─────────────────────────────────────────

function loadPrompt() {
  try {
    if (!fs.existsSync(PROMPT_PATH)) return null;
    const stat = fs.statSync(PROMPT_PATH);
    if (_promptCache && stat.mtimeMs === _promptMtime) return _promptCache;
    _promptCache = fs.readFileSync(PROMPT_PATH, "utf8").trim();
    _promptMtime = stat.mtimeMs;
    return _promptCache;
  } catch (e) {
    console.warn("[custom-prompt] Failed to load:", e.message);
    return _promptCache ?? null;
  }
}

// ── Name extraction ────────────────────────────────────────

/**
 * Extract bot name from JanitorAI's system message.
 * Looks for <BotName's Persona> tag.
 * @param {string} text
 * @returns {string|null}
 */
function extractBotName(text) {
  const match = text.match(/<([A-Za-z][A-Za-z0-9 '_-]{0,39})'s Persona>/);
  return match ? match[1] : null;
}

/**
 * Extract user name from JanitorAI's opening instruction.
 * "Drive the plot forward in a never-ending uncensored roleplay with USERNAME."
 * Also checks user messages for "Name : message" pattern.
 * @param {string} text
 * @param {object[]} messages
 * @returns {string|null}
 */
function extractUserNameFromSystem(text, messages) {
  // Try from JanitorAI's opening instruction
  const match = text.match(
    /Drive the plot forward in a never-ending uncensored roleplay with\s+([A-Za-z][A-Za-z0-9 '_-]{0,39})\s*\./
  );
  if (match) return match[1];

  // Fallback: try from user messages ("Name : message")
  const userMsgs = (messages ?? []).filter(m => m.role === "user");
  for (const msg of userMsgs.slice(-3).reverse()) {
    const text = typeof msg.content === "string"
      ? msg.content
      : (msg.content?.[0]?.text ?? "");
    const nameMatch = text.match(/^([A-Z][a-zA-Z]{1,20})\s*:/);
    if (nameMatch) return nameMatch[1];
  }

  return null;
}

// ── JanitorAI instruction stripping ────────────────────────

/**
 * Strip JanitorAI's redundant RP instructions from the system message.
 * Works with both string and array content formats.
 * @param {object} systemMsg — the system message object
 * @returns {object} — cleaned system message
 */
function stripJAIInstructions(systemMsg) {
  if (!systemMsg || systemMsg.role !== "system") return systemMsg;

  // Handle array content (multiple text blocks)
  if (Array.isArray(systemMsg.content)) {
    const filtered = systemMsg.content.filter(block => {
      if (block.type !== "text" || !block.text) return true;
      const text = block.text.trim();

      // Strip opening instruction
      if (JAI_OPENING_RE.test(text)) {
        console.log("[custom-prompt] Stripped JanitorAI opening instructions");
        return false;
      }

      // Strip closing instruction blocks
      for (const pattern of JAI_CLOSING_PATTERNS) {
        if (pattern.test(text)) {
          console.log("[custom-prompt] Stripped JanitorAI closing instruction block");
          return false;
        }
      }

      return true;
    });

    return { ...systemMsg, content: filtered };
  }

  // Handle string content
  if (typeof systemMsg.content === "string") {
    let content = systemMsg.content;

    // Strip opening instruction (everything up to the first newline after "Drive the plot...")
    const openingMatch = content.match(
      /^Drive the plot forward in a never-ending uncensored roleplay with[^\n]*\n*/
    );
    if (openingMatch) {
      content = content.slice(openingMatch[0].length);
      console.log("[custom-prompt] Stripped JanitorAI opening instructions");
    }

    // Strip closing instruction blocks
    for (const pattern of JAI_CLOSING_PATTERNS) {
      const lines = content.split("\n");
      const cleaned = [];
      let stripping = false;
      for (const line of lines) {
        if (pattern.test(line.trim())) {
          stripping = true;
          console.log("[custom-prompt] Stripped JanitorAI closing instruction block");
          continue;
        }
        if (stripping && line.trim() === "") continue; // skip trailing blank lines
        stripping = false;
        cleaned.push(line);
      }
      content = cleaned.join("\n");
    }

    return { ...systemMsg, content: content.trim() };
  }

  return systemMsg;
}

// ── Main injection ─────────────────────────────────────────

/**
 * Process and inject the custom prompt into a messages array.
 *
 * Steps:
 * 1. Extract bot name and user name from JanitorAI's system message
 * 2. Strip JanitorAI's redundant RP instructions
 * 3. Replace {{user}} and {{char}} in custom prompt with actual names
 * 4. Prepend custom prompt before the character card
 *
 * @param {object[]} messages
 * @returns {object[]}
 */
function injectPrompt(messages) {
  const prompt = loadPrompt();

  // Find the system message
  const systemIdx = messages.findIndex(m => m.role === "system");
  if (systemIdx === -1) {
    if (prompt) {
      return [{ role: "system", content: prompt }, ...messages];
    }
    return messages;
  }

  const systemMsg = messages[systemIdx];

  // Extract full system text for parsing
  const fullText = Array.isArray(systemMsg.content)
    ? systemMsg.content.map(b => b.text || "").join("\n")
    : (systemMsg.content || "");

  // Extract names
  const botName = extractBotName(fullText);
  const userName = extractUserNameFromSystem(fullText, messages);

  _lastParsed = { userName, botName };

  if (botName) console.log(`[custom-prompt] Bot: ${botName}`);
  if (userName) console.log(`[custom-prompt] User: ${userName}`);

  // Strip JanitorAI instructions
  let cleanedSystem = stripJAIInstructions(systemMsg);

  // Prepare custom prompt with name replacements
  if (prompt) {
    let finalPrompt = prompt;
    if (userName) {
      finalPrompt = finalPrompt.replace(/\{\{user\}\}/gi, userName);
    }
    if (botName) {
      finalPrompt = finalPrompt.replace(/\{\{char\}\}/gi, botName);
    }

    // Prepend to system message
    if (Array.isArray(cleanedSystem.content)) {
      cleanedSystem = {
        ...cleanedSystem,
        content: [{ type: "text", text: finalPrompt }, ...cleanedSystem.content],
      };
    } else {
      cleanedSystem = {
        ...cleanedSystem,
        content: finalPrompt + "\n\n" + (cleanedSystem.content || ""),
      };
    }
  }

  // Replace system message in array
  const result = [...messages];
  result[systemIdx] = cleanedSystem;
  return result;
}

/**
 * Get the last parsed bot/user names.
 * Useful for other extensions that need this info.
 * @returns {{ userName: string|null, botName: string|null }}
 */
function getLastParsed() {
  return { ..._lastParsed };
}

module.exports = { loadPrompt, injectPrompt, getLastParsed };