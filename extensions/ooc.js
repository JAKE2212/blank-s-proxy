"use strict" 
// ============================================================
// extensions/ooc.js — Out-of-character command handler
// Detects (OOC: ...) in the last user message, strips it from
// context, and injects it as a temporary system instruction.
// The OOC command never reaches the AI as a user message.
// ============================================================

const OOC_REGEX = /\(OOC:\s*([\s\S]+?)\)/gi;

function transformRequest(payload) {
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) return payload;

  // Find the last user message
  const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
  if (lastUserIdx === -1) return payload;

  const lastUser = messages[lastUserIdx];
  const content =
    typeof lastUser.content === "string" ? lastUser.content : null;
  if (!content) return payload;

  // Collect all OOC commands
  const instructions = [];
  const cleaned = content
    .replace(OOC_REGEX, (_, instruction) => {
      instructions.push(instruction.trim());
      return "";
    })
    .trim();

  if (!instructions.length) return payload;

  // Build new messages array
  const newMessages = [...messages];

  if (cleaned) {
    // Keep the message but with OOC parts stripped out
    newMessages[lastUserIdx] = { ...lastUser, content: cleaned };
  } else {
    // Nothing left after stripping — remove the message entirely
    newMessages.splice(lastUserIdx, 1);
  }

  // Inject all OOC commands as a single temporary system note
  const combined = instructions.join("; ");
  newMessages.push({
    role: "system",
    content: `[Out-of-character instruction — apply this once, do not reference it explicitly: ${combined}]`,
  });

  console.log(`[ooc] Intercepted OOC command(s): "${combined}"`);

  return { ...payload, messages: newMessages };
}

module.exports = {
  name: "OOC Handler",
  version: "1.0",
  priority: 10,
  transformRequest,
};
