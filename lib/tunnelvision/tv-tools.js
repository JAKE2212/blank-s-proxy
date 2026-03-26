"use strict";

/**
 * tv-tools.js — TunnelVision Tool Definitions + Action Functions
 *
 * Five tools the AI can call:
 *   TunnelVision_Search   — navigate the tree and retrieve entries
 *   TunnelVision_Remember — create a new entry (with trigram dedup warning)
 *   TunnelVision_Update   — edit an existing entry by UID
 *   TunnelVision_Forget   — disable an entry by UID
 *   TunnelVision_Summarize— create a scene summary under the Summaries node
 *
 * Each tool exports:
 *   definition(tree) → OpenAI-compatible tool definition object
 *   action(tree, args) → string result returned to the AI
 */

const {
  getNode,
  addNode,
  addEntry,
  findEntry,
  updateEntry,
  disableEntry,
  moveEntry,
  moveNode,
  retrieveNodeContent,
  buildTreeOverview,
  findSimilarEntries,
  getOrCreateArc,
  getAllEntries,
  saveTree,
} = require("./tv-tree");

// ── Tracker detection ─────────────────────────────────────────────────────────

/**
 * Find all tracker entries in the tree (title starts with [Tracker]).
 * Returns a formatted string for injection into tool descriptions.
 * @param {object} tree
 * @returns {string}
 */
function buildTrackerList(tree) {
  const trackers = [];
  for (const { entry } of getAllEntries(tree)) {
    if (entry.title.match(/^\[Tracker\]/i)) {
      trackers.push(`  • UID ${entry.uid}: ${entry.title}`);
    }
  }
  if (!trackers.length) return "";
  return `\n\nTRACKER ENTRIES (check and update these when relevant):\n${trackers.join("\n")}`;
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Build the collapsed tree overview string for injection into Search description.
 * Called fresh on each request so it always reflects the current tree state.
 * @param {object} tree
 * @returns {string}
 */
function buildSearchContext(tree) {
  return buildTreeOverview(tree, { maxDepth: 99, includeEntryTitles: false });
}

// ── Tool: Search ──────────────────────────────────────────────────────────────

/**
 * Build the Search tool definition.
 * The full collapsed tree overview is baked into the description so the AI
 * can see all channels at once and pick node IDs in a single call.
 * @param {object} tree
 * @returns {object}
 */
function searchDefinition(tree) {
  const overview = buildSearchContext(tree);
  const trackers = buildTrackerList(tree);
  return {
    type: "function",
    function: {
      name: "TunnelVision_Search",
      description: `Navigate the lorebook channel tree and retrieve relevant context entries.
Browse the tree overview below, identify the most relevant node IDs for the current scene, and retrieve their content.

TREE OVERVIEW:
${overview}${trackers}

USAGE RULES:
- Pick 1-4 node IDs that are most relevant to the current scene or user message
- Prefer specific leaf nodes over broad parent nodes
- You can retrieve multiple nodes in a single call
- Always search before Remember to avoid creating duplicate entries
- If nothing seems relevant, return an empty node_ids array`,
      parameters: {
        type: "object",
        properties: {
          node_ids: {
            type: "array",
            items: { type: "string" },
            description:
              "Array of node IDs to retrieve content from. Pick the most relevant nodes from the tree overview above.",
          },
          reason: {
            type: "string",
            description:
              "Brief explanation of why these nodes are relevant to the current scene.",
          },
        },
        required: ["node_ids"],
      },
    },
  };
}

/**
 * Execute a Search tool call.
 * @param {object} tree
 * @param {object} args  { node_ids: string[], reason?: string }
 * @returns {string}
 */
function searchAction(tree, args) {
  const { node_ids = [] } = args;

  if (!node_ids.length) {
    return "[TunnelVision] No nodes selected — no context retrieved.";
  }

  const results = [];
  const notFound = [];

  for (const nodeId of node_ids) {
    const node = getNode(tree, nodeId);
    if (!node) {
      notFound.push(nodeId);
      continue;
    }
    const content = retrieveNodeContent(tree, nodeId);
    if (content) {
      results.push(`=== ${node.label} [${nodeId}] ===\n${content}`);
    } else {
      results.push(`=== ${node.label} [${nodeId}] === (no entries)`);
    }
  }

  if (notFound.length) {
    results.push(`[TunnelVision] Node(s) not found: ${notFound.join(", ")}`);
  }

  if (!results.length) {
    return "[TunnelVision] No content found in selected nodes.";
  }

  return `[TunnelVision Retrieved Context]\n\n${results.join("\n\n")}`;
}

// ── Tool: Remember ────────────────────────────────────────────────────────────

function rememberDefinition() {
  return {
    type: "function",
    function: {
      name: "TunnelVision_Remember",
      description: `Save a new piece of information to the lorebook as a permanent entry.
Use this to record new facts, character developments, relationship changes, world details, or plot events that should persist across the conversation.

RULES:
- Always call TunnelVision_Search first to check if similar info already exists
- Prefer updating an existing entry (TunnelVision_Update) over creating a duplicate
- Keep entries focused — one topic per entry
- Use broad entries rather than many tiny ones
- Do NOT create entries for ephemeral dialogue or temporary states`,
      parameters: {
        type: "object",
        properties: {
          node_id: {
            type: "string",
            description:
              "ID of the tree node to file this entry under. Use the node that best matches the topic. If unsure, use 'root'.",
          },
          title: {
            type: "string",
            description:
              "Short descriptive title for this entry (e.g. 'Kurt — Personality & Background').",
          },
          content: {
            type: "string",
            description:
              "The full content to store. Write in third-person, factual style. Include all relevant details.",
          },
          keys: {
            type: "array",
            items: { type: "string" },
            description:
              "Search keywords for this entry (character names, locations, topics).",
          },
        },
        required: ["node_id", "title", "content"],
      },
    },
  };
}

/**
 * Execute a Remember tool call.
 * Runs trigram dedup check before creating — warns AI if similar entry exists.
 * @param {object} tree
 * @param {object} args
 * @returns {string}
 */
function rememberAction(tree, args) {
  const { node_id, title, content, keys = [] } = args;

  if (!title?.trim())
    return "[TunnelVision] Remember failed: title is required.";
  if (!content?.trim())
    return "[TunnelVision] Remember failed: content is required.";

  // Validate node exists, fall back to root
  const targetId = getNode(tree, node_id) ? node_id : tree.rootId;
  const targetNode = getNode(tree, targetId);

  // Trigram dedup check
  const similar = findSimilarEntries(tree, `${title} ${content}`, 0.6);
  if (similar.length > 0) {
    const top = similar[0];
    return `[TunnelVision] WARNING: Similar entry already exists (${Math.round(top.similarity * 100)}% match):
  UID ${top.entry.uid}: "${top.entry.title}" in node "${top.nodeLabel}"
  
Consider using TunnelVision_Update on UID ${top.entry.uid} instead of creating a duplicate.
If this is genuinely new/different information, call TunnelVision_Remember again with force=true to proceed anyway.`;
  }

  try {
    const entry = addEntry(tree, targetId, {
      title: title.trim(),
      content: content.trim(),
      keys,
    });
    return `[TunnelVision] Remembered: "${entry.title}" (UID ${entry.uid}) → filed under "${targetNode.label}" [${targetId}]`;
  } catch (e) {
    return `[TunnelVision] Remember failed: ${e.message}`;
  }
}

/**
 * Execute a Remember tool call with force=true (skip dedup warning).
 * @param {object} tree
 * @param {object} args
 * @returns {string}
 */
function rememberActionForced(tree, args) {
  const { node_id, title, content, keys = [] } = args;
  if (!title?.trim())
    return "[TunnelVision] Remember failed: title is required.";
  if (!content?.trim())
    return "[TunnelVision] Remember failed: content is required.";

  const targetId = getNode(tree, node_id) ? node_id : tree.rootId;
  const targetNode = getNode(tree, targetId);

  try {
    const entry = addEntry(tree, targetId, {
      title: title.trim(),
      content: content.trim(),
      keys,
    });
    return `[TunnelVision] Remembered (forced): "${entry.title}" (UID ${entry.uid}) → filed under "${targetNode.label}" [${targetId}]`;
  } catch (e) {
    return `[TunnelVision] Remember failed: ${e.message}`;
  }
}

// ── Tool: Update ──────────────────────────────────────────────────────────────

function updateDefinition(tree) {
  const trackers = buildTrackerList(tree);
  return {
    type: "function",
    function: {
      name: "TunnelVision_Update",
      description: `Edit an existing lorebook entry by its UID.
Use this when information has changed, needs correction, or should be expanded.
Always prefer Update over Remember when the information already exists.${trackers}

CRITICAL: When updating content, you MUST include ALL existing information that is still valid plus your changes.
Never write a partial update that drops existing facts — that destroys data.
If you only need to change the title or keys, omit the content field entirely.`,
      parameters: {
        type: "object",
        properties: {
          uid: {
            type: "number",
            description:
              "UID of the entry to update. Get this from a prior TunnelVision_Search call.",
          },
          title: {
            type: "string",
            description: "New title (optional — omit to keep existing title).",
          },
          content: {
            type: "string",
            description:
              "Complete new content replacing the existing content. Must include all still-valid existing info plus your additions/changes.",
          },
          keys: {
            type: "array",
            items: { type: "string" },
            description:
              "New keywords list (optional — omit to keep existing keys).",
          },
        },
        required: ["uid"],
      },
    },
  };
}

function updateAction(tree, args) {
  const { uid, title, content, keys } = args;
  if (uid === undefined || uid === null)
    return "[TunnelVision] Update failed: uid is required.";
  if (!title && !content && !keys)
    return "[TunnelVision] Update failed: provide at least one of title, content, or keys.";

  const updates = {};
  if (title?.trim()) updates.title = title.trim();
  if (content?.trim()) updates.content = content.trim();
  if (Array.isArray(keys)) updates.keys = keys;

  try {
    const entry = updateEntry(tree, Number(uid), updates);
    const changed = Object.keys(updates).join(", ");
    return `[TunnelVision] Updated UID ${entry.uid} "${entry.title}" — changed: ${changed}`;
  } catch (e) {
    return `[TunnelVision] Update failed: ${e.message}`;
  }
}

// ── Tool: Forget ──────────────────────────────────────────────────────────────

function forgetDefinition() {
  return {
    type: "function",
    function: {
      name: "TunnelVision_Forget",
      description: `Disable a lorebook entry so it no longer appears in retrieval.
Use this when information is definitively wrong, permanently irrelevant, or has been superseded.
The entry is soft-deleted (disabled) not permanently removed — it can be recovered if needed.

Use sparingly — only when information is definitively wrong or permanently irrelevant.
Prefer TunnelVision_Update when information just needs to be corrected.`,
      parameters: {
        type: "object",
        properties: {
          uid: {
            type: "number",
            description:
              "UID of the entry to disable. Get this from a prior TunnelVision_Search call.",
          },
          reason: {
            type: "string",
            description: "Brief reason why this entry should be forgotten.",
          },
        },
        required: ["uid", "reason"],
      },
    },
  };
}

function forgetAction(tree, args) {
  const { uid, reason } = args;
  if (uid === undefined || uid === null)
    return "[TunnelVision] Forget failed: uid is required.";
  if (!reason?.trim())
    return "[TunnelVision] Forget failed: reason is required.";

  try {
    const entry = disableEntry(tree, Number(uid));
    return `[TunnelVision] Forgotten: UID ${entry.uid} "${entry.title}" — reason: ${reason}`;
  } catch (e) {
    return `[TunnelVision] Forget failed: ${e.message}`;
  }
}

// ── Notebook store (in-memory, keyed by bot name) ────────────────────────────

const _notebooks = new Map(); // botName → { [title]: content }

function getNotebook(botName) {
  if (!_notebooks.has(botName)) _notebooks.set(botName, {});
  return _notebooks.get(botName);
}

/**
 * Build the notebook injection block for the system prompt.
 * Returns empty string if no notes exist.
 * @param {string} botName
 * @returns {string}
 */
function buildNotebookInjection(botName) {
  const notes = getNotebook(botName);
  const entries = Object.entries(notes);
  if (!entries.length) return "";
  const lines = ["[TunnelVision Notebook — Your Private Scratchpad]"];
  for (const [title, content] of entries) {
    lines.push(`• ${title}: ${content}`);
  }
  lines.push("[End Notebook]");
  return lines.join("\n");
}

// ── Tool: Notebook ────────────────────────────────────────────────────────────

function notebookDefinition() {
  return {
    type: "function",
    function: {
      name: "TunnelVision_Notebook",
      description: `Private scratchpad for temporary notes, plans, and follow-ups.
Notes are injected into your context every turn so you always see them, but they are NOT permanently stored in the lorebook — they reset when the server restarts.

Use this for:
- Tactical reminders ("check on X next turn")
- Narrative threads to follow up on
- Temporary tracking that doesn't warrant a permanent entry yet
- Plans for what to Remember or Summarize later

Actions:
- "write"   : Add or update a note (title + content)
- "delete"  : Remove a note by title
- "clear"   : Wipe all notes
- "promote" : Move a note permanently into the lorebook tree as a real entry (then deletes it from notebook)

Notes are visible only to you — the user never sees them directly.`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["write", "delete", "clear", "promote"],
            description: "What to do with the notebook.",
          },
          title: {
            type: "string",
            description: "Note title/key. Required for write, delete, promote.",
          },
          content: {
            type: "string",
            description: "Note content. Required for write.",
          },
          node_id: {
            type: "string",
            description:
              "Tree node to promote this note into. Required for promote. Use 'root' if unsure.",
          },
        },
        required: ["action"],
      },
    },
  };
}

function notebookAction(tree, args, botName) {
  const { action, title, content, node_id } = args;
  const notes = getNotebook(botName);

  switch (action) {
    case "write": {
      if (!title?.trim())
        return "[TunnelVision] Notebook failed: title is required.";
      if (!content?.trim())
        return "[TunnelVision] Notebook failed: content is required.";
      notes[title.trim()] = content.trim();
      return `[TunnelVision] Notebook: wrote "${title.trim()}" (${Object.keys(notes).length} note${Object.keys(notes).length !== 1 ? "s" : ""} total)`;
    }

    case "delete": {
      if (!title?.trim())
        return "[TunnelVision] Notebook failed: title is required for delete.";
      if (!notes[title.trim()])
        return `[TunnelVision] Notebook: note "${title}" not found.`;
      delete notes[title.trim()];
      return `[TunnelVision] Notebook: deleted "${title.trim()}" (${Object.keys(notes).length} note${Object.keys(notes).length !== 1 ? "s" : ""} remaining)`;
    }

    case "clear": {
      const count = Object.keys(notes).length;
      _notebooks.set(botName, {});
      return `[TunnelVision] Notebook: cleared ${count} note${count !== 1 ? "s" : ""}`;
    }

    case "promote": {
      if (!title?.trim())
        return "[TunnelVision] Notebook failed: title is required for promote.";
      if (!node_id)
        return "[TunnelVision] Notebook failed: node_id is required for promote.";
      const noteContent = notes[title.trim()];
      if (!noteContent)
        return `[TunnelVision] Notebook: note "${title}" not found.`;
      if (!tree.nodes[node_id])
        return `[TunnelVision] Notebook failed: node "${node_id}" not found in tree.`;
      try {
        const entry = addEntry(tree, node_id, {
          title: title.trim(),
          content: noteContent,
          keys: [],
        });
        delete notes[title.trim()];
        const targetNode = tree.nodes[node_id];
        return `[TunnelVision] Notebook: promoted "${title.trim()}" → permanent entry UID ${entry.uid} in "${targetNode?.label ?? node_id}" (removed from notebook)`;
      } catch (e) {
        return `[TunnelVision] Notebook promote failed: ${e.message}`;
      }
    }

    default:
      return `[TunnelVision] Notebook failed: unknown action "${action}". Use write, delete, clear, or promote.`;
  }
}

// ── Tool: Merge/Split ─────────────────────────────────────────────────────────

function mergeSplitDefinition() {
  return {
    type: "function",
    function: {
      name: "TunnelVision_MergeSplit",
      description: `Merge two entries into one, or split one entry into two.

Actions:
- "merge" : Combine two entries. The keep_uid entry absorbs the remove_uid entry. Provide merged_content with all combined information.
- "split" : Divide one entry into two focused entries. Provide keep_content for the original and new_content + new_title for the split-off entry.

When to merge:
- Two entries cover the same topic (duplicates)
- One entry is a subset of another
- Related facts are scattered across multiple small entries

When to split:
- One entry has grown to cover multiple unrelated topics
- An entry is too long and hard to parse
- Part of an entry belongs in a different channel`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["merge", "split"],
            description: "Whether to merge two entries or split one entry.",
          },
          // Merge params
          keep_uid: {
            type: "number",
            description: "UID of the entry to keep. Required for merge.",
          },
          remove_uid: {
            type: "number",
            description:
              "UID of the entry to absorb and disable. Required for merge.",
          },
          merged_content: {
            type: "string",
            description:
              "Complete merged content combining both entries. Required for merge. Must include all valid information from both.",
          },
          merged_title: {
            type: "string",
            description: "Optional new title for the merged entry.",
          },
          // Split params
          uid: {
            type: "number",
            description: "UID of the entry to split. Required for split.",
          },
          keep_content: {
            type: "string",
            description:
              "Content that stays in the original entry. Required for split.",
          },
          keep_title: {
            type: "string",
            description:
              "Optional new title for the original entry after split.",
          },
          new_content: {
            type: "string",
            description:
              "Content for the new split-off entry. Required for split.",
          },
          new_title: {
            type: "string",
            description:
              "Title for the new split-off entry. Required for split.",
          },
          new_node_id: {
            type: "string",
            description:
              "Optional node to place the new split-off entry in. Defaults to same node as original.",
          },
        },
        required: ["action"],
      },
    },
  };
}

function mergeSplitAction(tree, args) {
  const { action } = args;

  if (action === "merge") {
    const { keep_uid, remove_uid, merged_content, merged_title } = args;
    if (keep_uid === undefined || keep_uid === null)
      return "[TunnelVision] MergeSplit failed: keep_uid is required for merge.";
    if (remove_uid === undefined || remove_uid === null)
      return "[TunnelVision] MergeSplit failed: remove_uid is required for merge.";
    if (!merged_content?.trim())
      return "[TunnelVision] MergeSplit failed: merged_content is required for merge.";
    if (keep_uid === remove_uid)
      return "[TunnelVision] MergeSplit failed: keep_uid and remove_uid must be different.";

    try {
      const keepFound = findEntry(tree, Number(keep_uid));
      const removeFound = findEntry(tree, Number(remove_uid));
      if (!keepFound)
        return `[TunnelVision] MergeSplit failed: entry UID ${keep_uid} not found.`;
      if (!removeFound)
        return `[TunnelVision] MergeSplit failed: entry UID ${remove_uid} not found.`;

      // Update keep entry with merged content
      const updates = { content: merged_content.trim() };
      if (merged_title?.trim()) updates.title = merged_title.trim();
      updateEntry(tree, Number(keep_uid), updates);

      // Disable the absorbed entry
      disableEntry(tree, Number(remove_uid));

      return `[TunnelVision] Merged UID ${remove_uid} ("${removeFound.entry.title}") into UID ${keep_uid} ("${keepFound.entry.title}")`;
    } catch (e) {
      return `[TunnelVision] MergeSplit failed: ${e.message}`;
    }
  }

  if (action === "split") {
    const {
      uid,
      keep_content,
      keep_title,
      new_content,
      new_title,
      new_node_id,
    } = args;
    if (uid === undefined || uid === null)
      return "[TunnelVision] MergeSplit failed: uid is required for split.";
    if (!keep_content?.trim())
      return "[TunnelVision] MergeSplit failed: keep_content is required for split.";
    if (!new_content?.trim())
      return "[TunnelVision] MergeSplit failed: new_content is required for split.";
    if (!new_title?.trim())
      return "[TunnelVision] MergeSplit failed: new_title is required for split.";

    try {
      const found = findEntry(tree, Number(uid));
      if (!found)
        return `[TunnelVision] MergeSplit failed: entry UID ${uid} not found.`;

      // Update original with kept content
      const updates = { content: keep_content.trim() };
      if (keep_title?.trim()) updates.title = keep_title.trim();
      updateEntry(tree, Number(uid), updates);

      // Create new split-off entry in same node (or specified node)
      const targetNodeId =
        new_node_id && tree.nodes[new_node_id] ? new_node_id : found.node.id;

      const newEntry = addEntry(tree, targetNodeId, {
        title: new_title.trim(),
        content: new_content.trim(),
        keys: [],
      });

      const targetNode = tree.nodes[targetNodeId];
      return `[TunnelVision] Split UID ${uid} → kept "${found.entry.title}", created UID ${newEntry.uid} "${newEntry.title}" in "${targetNode?.label ?? targetNodeId}"`;
    } catch (e) {
      return `[TunnelVision] MergeSplit failed: ${e.message}`;
    }
  }

  return `[TunnelVision] MergeSplit failed: unknown action "${action}". Use merge or split.`;
}

// ── Tool: Reorganize ─────────────────────────────────────────────────────────

function reorganizeDefinition() {
  return {
    type: "function",
    function: {
      name: "TunnelVision_Reorganize",
      description: `Reorganize the lorebook tree structure. Move entries between channels, create new channels, or move entire channels.
Use this when the tree structure no longer fits the growing lorebook — entries are in the wrong place, a channel is too broad, or a new category is needed.

Actions:
- "move_entry"  : Move an entry by UID to a different node
- "move_node"   : Move an entire channel/node to a different parent
- "create_node" : Create a new channel under a parent node

When to use:
- An entry was saved to the wrong channel
- A channel has grown too large and needs a sub-channel
- Related entries are scattered and should be grouped together
- The AI naturally organized things in a way that no longer fits`,
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["move_entry", "move_node", "create_node"],
            description: "What reorganization action to perform.",
          },
          uid: {
            type: "number",
            description: "Entry UID to move. Required for move_entry.",
          },
          node_id: {
            type: "string",
            description: "Node ID to move. Required for move_node.",
          },
          target_node_id: {
            type: "string",
            description:
              "Destination node ID. Required for move_entry and move_node.",
          },
          parent_node_id: {
            type: "string",
            description:
              "Parent node ID for the new channel. Required for create_node. Use 'root' for top-level.",
          },
          label: {
            type: "string",
            description: "Name for the new channel. Required for create_node.",
          },
          summary: {
            type: "string",
            description: "Optional description for the new channel.",
          },
        },
        required: ["action"],
      },
    },
  };
}

function reorganizeAction(tree, args) {
  const {
    action,
    uid,
    node_id,
    target_node_id,
    parent_node_id,
    label,
    summary,
  } = args;

  switch (action) {
    case "move_entry": {
      if (uid === undefined || uid === null)
        return "[TunnelVision] Reorganize failed: uid is required for move_entry.";
      if (!target_node_id)
        return "[TunnelVision] Reorganize failed: target_node_id is required for move_entry.";
      try {
        moveEntry(tree, Number(uid), target_node_id);
        const targetNode = tree.nodes[target_node_id];
        return `[TunnelVision] Moved entry UID ${uid} → "${targetNode?.label ?? target_node_id}"`;
      } catch (e) {
        return `[TunnelVision] Reorganize failed: ${e.message}`;
      }
    }

    case "move_node": {
      if (!node_id)
        return "[TunnelVision] Reorganize failed: node_id is required for move_node.";
      if (!target_node_id)
        return "[TunnelVision] Reorganize failed: target_node_id is required for move_node.";
      try {
        const node = tree.nodes[node_id];
        moveNode(tree, node_id, target_node_id);
        const targetNode = tree.nodes[target_node_id];
        return `[TunnelVision] Moved channel "${node?.label ?? node_id}" → under "${targetNode?.label ?? target_node_id}"`;
      } catch (e) {
        return `[TunnelVision] Reorganize failed: ${e.message}`;
      }
    }

    case "create_node": {
      if (!label?.trim())
        return "[TunnelVision] Reorganize failed: label is required for create_node.";
      const parentId = parent_node_id ?? tree.rootId;
      if (!tree.nodes[parentId])
        return `[TunnelVision] Reorganize failed: parent node "${parentId}" not found.`;
      try {
        const node = addNode(tree, parentId, label.trim(), {
          summary: summary?.trim() ?? "",
        });
        const parentNode = tree.nodes[parentId];
        return `[TunnelVision] Created channel "${node.label}" [${node.id}] under "${parentNode?.label ?? parentId}"`;
      } catch (e) {
        return `[TunnelVision] Reorganize failed: ${e.message}`;
      }
    }

    default:
      return `[TunnelVision] Reorganize failed: unknown action "${action}". Use move_entry, move_node, or create_node.`;
  }
}

// ── Tool: Summarize ───────────────────────────────────────────────────────────

function summarizeDefinition() {
  return {
    type: "function",
    function: {
      name: "TunnelVision_Summarize",
      description: `Create a scene or event summary and file it under the Summaries channel.
Use this for significant narrative beats: important conversations, relationship shifts, discoveries, confrontations, turning points.
Summaries are organized into arcs (narrative threads). The AI decides which arc a summary belongs to.

When to summarize:
- A significant scene just concluded
- An important relationship shift occurred  
- A major plot event happened
- Something that should be remembered for future scenes`,
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description:
              "Descriptive title for this summary (e.g. 'Kurt and Dwight's First Confrontation at the Arcade').",
          },
          summary: {
            type: "string",
            description:
              "What happened, written in past tense. Include who was involved, what occurred, and why it matters narratively.",
          },
          arc: {
            type: "string",
            description:
              "Name of the narrative arc this summary belongs to (e.g. 'The Arcade Arc', 'Dale's Scheme'). Creates the arc if it doesn't exist.",
          },
          participants: {
            type: "array",
            items: { type: "string" },
            description: "Names of characters involved in this scene.",
          },
          significance: {
            type: "string",
            enum: ["minor", "moderate", "major", "critical"],
            description:
              "How significant this event is to the overall narrative.",
          },
        },
        required: ["title", "summary", "arc"],
      },
    },
  };
}

function summarizeAction(tree, args) {
  const {
    title,
    summary,
    arc,
    participants = [],
    significance = "moderate",
  } = args;
  if (!title?.trim())
    return "[TunnelVision] Summarize failed: title is required.";
  if (!summary?.trim())
    return "[TunnelVision] Summarize failed: summary is required.";
  if (!arc?.trim()) return "[TunnelVision] Summarize failed: arc is required.";

  try {
    // Get or create the arc node under Summaries
    const arcNode = getOrCreateArc(tree, arc.trim());

    // Build full content with metadata
    const participantStr = participants.length
      ? participants.join(", ")
      : "Unknown";
    const content = `[${significance.toUpperCase()}] ${summary.trim()}

Participants: ${participantStr}`;

    const entry = addEntry(tree, arcNode.id, {
      title: title.trim(),
      content,
      keys: [...participants, arc.trim()],
    });

    return `[TunnelVision] Summary saved: "${entry.title}" (UID ${entry.uid}) → Arc: "${arc}" [${significance}]`;
  } catch (e) {
    return `[TunnelVision] Summarize failed: ${e.message}`;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Build all tool definitions for injection into the OpenRouter API call.
 * Called fresh on each request so the Search overview is always current.
 * @param {object} tree
 * @returns {object[]}  OpenAI-compatible tools array
 */
function buildToolDefinitions(tree) {
  return [
    searchDefinition(tree),
    rememberDefinition(),
    updateDefinition(tree),
    forgetDefinition(),
    reorganizeDefinition(),
    mergeSplitDefinition(),
    summarizeDefinition(),
    notebookDefinition(),
  ];
}

/**
 * Dispatch a tool call to its action function.
 * @param {object} tree
 * @param {string} toolName
 * @param {object} args
 * @param {string} [botName]  — required for Notebook tool
 * @returns {string}
 */
function dispatchToolCall(tree, toolName, args, botName) {
  if (toolName === "TunnelVision_Remember" && args.force === true) {
    return rememberActionForced(tree, args);
  }

  switch (toolName) {
    case "TunnelVision_Search":
      return searchAction(tree, args);
    case "TunnelVision_Remember":
      return rememberAction(tree, args);
    case "TunnelVision_Update":
      return updateAction(tree, args);
    case "TunnelVision_Forget":
      return forgetAction(tree, args);
    case "TunnelVision_Reorganize":
      return reorganizeAction(tree, args);
    case "TunnelVision_MergeSplit":
      return mergeSplitAction(tree, args);
    case "TunnelVision_Summarize":
      return summarizeAction(tree, args);
    case "TunnelVision_Notebook":
      return notebookAction(tree, args, botName ?? "unknown");
    default:
      return `[TunnelVision] Unknown tool: ${toolName}`;
  }
}

module.exports = {
  buildToolDefinitions,
  dispatchToolCall,
  buildNotebookInjection,
  searchDefinition,
  searchAction,
  rememberAction,
  updateAction,
  forgetAction,
  reorganizeAction,
  mergeSplitAction,
  notebookAction,
  summarizeAction,
};
