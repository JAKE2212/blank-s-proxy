// lib/prompt-cache.js — Prompt caching helper for Claude models

// ── Helper: check if model is a Claude model ───────────────
function isClaudeModel(model) {
  return (
    model?.toLowerCase().includes("claude") ||
    model?.toLowerCase().includes("anthropic")
  );
}

// ── Helper: apply prompt caching to system messages ────────
// Only applied to Claude models, as other models don't support it.
// Uses 1-hour TTL to avoid needing a cache warmer.
// Splits system prompt into paragraphs for better cache recognition.
function applyPromptCaching(messages, model) {
  if (!isClaudeModel(model)) return messages;

  return messages.map((msg) => {
    if (msg.role === "system" && typeof msg.content === "string") {
      const paragraphs = msg.content
        .split(/\n\n+/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0); // ── No empty blocks

      if (paragraphs.length <= 1) {
        // ── Single block fallback ────────────────────────────
        return {
          ...msg,
          content: [
            {
              type: "text",
              text: msg.content,
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ],
        };
      }

      // ── Multi-block: cache_control only on the last block ──
      return {
        ...msg,
        content: paragraphs.map((text, i) => ({
          type: "text",
          text,
          ...(i === paragraphs.length - 1 && {
            cache_control: { type: "ephemeral", ttl: "1h" },
          }),
        })),
      };
    }
    return msg;
  });
}

module.exports = { isClaudeModel, applyPromptCaching };
