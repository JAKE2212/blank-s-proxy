"use strict";

/**
 * tv-tree.js — TunnelVision Tree Store
 *
 * Manages per-character tree JSON files in data/tunnelvision/<charName>.json
 *
 * ── Tree shape ──────────────────────────────────────────────────────────────
 * {
 *   version:      1,
 *   charName:     string,        // canonical character name (lowercase)
 *   nodes:        { [id]: Node },// flat id→node map (source of truth)
 *   rootId:       "root",        // always exists
 *   summariesId:  "summaries",   // always exists, reserved for Summarize tool
 *   nextUid:      number,        // auto-increment counter for entry UIDs
 *   createdAt:    number,
 *   updatedAt:    number,
 * }
 *
 * ── Node shape ───────────────────────────────────────────────────────────────
 * {
 *   id:        string,           // unique, e.g. "root", "summaries", "tv_<rand>"
 *   label:     string,           // display name
 *   summary:   string,           // LLM-generated description of contents
 *   parentId:  string | null,    // null only for root
 *   children:  string[],         // ordered child node IDs
 *   tags:      string[],         // optional search tags
 *   entries:   Entry[],          // entries live here (no separate lorebook file)
 *   isArc:     boolean,          // true for summary arc sub-nodes
 *   createdAt: number,
 *   updatedAt: number,
 * }
 *
 * ── Entry shape ──────────────────────────────────────────────────────────────
 * {
 *   uid:       number,           // unique within this tree
 *   title:     string,
 *   content:   string,
 *   keys:      string[],         // search keywords
 *   enabled:   boolean,
 *   createdAt: number,
 *   updatedAt: number,
 * }
 */

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "../../data/tunnelvision");

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function treePath(charName) {
  const safe = sanitizeCharName(charName);
  return path.join(DATA_DIR, `${safe}.json`);
}

/** Sanitize a character name for use as a filename. */
function sanitizeCharName(name) {
  return (
    (name ?? "unknown")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 60) || "unknown"
  );
}

/** Generate a short random node ID. */
function genNodeId() {
  const rand = Math.random().toString(36).slice(2, 10);
  return `tv_${Date.now().toString(36)}_${rand}`;
}

function now() {
  return Date.now();
}

// ── Tree I/O ──────────────────────────────────────────────────────────────────

/**
 * Load a tree from disk. Returns null if no tree exists for this character.
 * @param {string} charName
 * @returns {object|null}
 */
function loadTree(charName) {
  const p = treePath(charName);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.warn(`[tv-tree] Failed to load tree for "${charName}":`, e.message);
    return null;
  }
}

/**
 * Save a tree to disk.
 * @param {object} tree
 */
function saveTree(tree) {
  ensureDataDir();
  tree.updatedAt = now();
  const p = treePath(tree.charName);
  fs.writeFileSync(p, JSON.stringify(tree, null, 2), "utf8");
}

/**
 * Load a tree or create a fresh one if it doesn't exist.
 * @param {string} charName
 * @returns {object}
 */
function getOrCreateTree(charName) {
  return loadTree(charName) ?? createTree(charName);
}

/**
 * Create a fresh tree with root + summaries nodes.
 * @param {string} charName
 * @returns {object}
 */
function createTree(charName) {
  const t = now();
  const root = makeNode("root", "Root", null);
  const summaries = makeNode("summaries", "Summaries", "root");
  root.children.push("summaries");

  const tree = {
    version: 1,
    charName: sanitizeCharName(charName),
    nodes: { root, summaries },
    rootId: "root",
    summariesId: "summaries",
    nextUid: 1,
    createdAt: t,
    updatedAt: t,
  };

  saveTree(tree);
  return tree;
}

/**
 * Delete a character's tree file from disk.
 * @param {string} charName
 */
function deleteTree(charName) {
  const p = treePath(charName);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

/**
 * List all characters that have a tree on disk.
 * @returns {string[]}
 */
function listTrees() {
  ensureDataDir();
  return fs
    .readdirSync(DATA_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));
}

// ── Node helpers ──────────────────────────────────────────────────────────────

/**
 * Create a new node object (not yet added to any tree).
 * @param {string} id
 * @param {string} label
 * @param {string|null} parentId
 * @param {object} [opts]
 * @returns {object}
 */
function makeNode(id, label, parentId, opts = {}) {
  const t = now();
  return {
    id,
    label,
    summary: opts.summary ?? "",
    parentId,
    children: [],
    tags: opts.tags ?? [],
    entries: [],
    isArc: opts.isArc ?? false,
    createdAt: t,
    updatedAt: t,
  };
}

/**
 * Add a new child node to a parent. Saves tree.
 * @param {object} tree
 * @param {string} parentId
 * @param {string} label
 * @param {object} [opts]  — summary, tags, isArc
 * @returns {object}  the new node
 */
function addNode(tree, parentId, label, opts = {}) {
  const parent = tree.nodes[parentId];
  if (!parent) throw new Error(`Parent node "${parentId}" not found`);

  const id = genNodeId();
  const node = makeNode(id, label, parentId, opts);

  tree.nodes[id] = node;
  parent.children.push(id);
  parent.updatedAt = now();

  saveTree(tree);
  return node;
}

/**
 * Remove a node and all its descendants. Orphaned entries are moved to root.
 * @param {object} tree
 * @param {string} nodeId
 */
function removeNode(tree, nodeId) {
  if (nodeId === tree.rootId || nodeId === tree.summariesId) {
    throw new Error(`Cannot remove reserved node "${nodeId}"`);
  }

  // Collect all descendant IDs (including nodeId itself)
  const toRemove = new Set();
  function collect(id) {
    toRemove.add(id);
    const node = tree.nodes[id];
    if (node) for (const cid of node.children) collect(cid);
  }
  collect(nodeId);

  // Move entries from removed nodes to root
  const root = tree.nodes[tree.rootId];
  for (const id of toRemove) {
    const node = tree.nodes[id];
    if (node?.entries?.length) {
      root.entries.push(...node.entries);
    }
    delete tree.nodes[id];
  }

  // Remove from parent's children array
  for (const node of Object.values(tree.nodes)) {
    node.children = node.children.filter((cid) => !toRemove.has(cid));
  }

  saveTree(tree);
}

/**
 * Move a node to a new parent.
 * @param {object} tree
 * @param {string} nodeId
 * @param {string} newParentId
 */
function moveNode(tree, nodeId, newParentId) {
  if (nodeId === tree.rootId) throw new Error("Cannot move root node");

  const node = tree.nodes[nodeId];
  const newParent = tree.nodes[newParentId];
  if (!node) throw new Error(`Node "${nodeId}" not found`);
  if (!newParent) throw new Error(`Target node "${newParentId}" not found`);

  // Remove from old parent
  if (node.parentId) {
    const oldParent = tree.nodes[node.parentId];
    if (oldParent) {
      oldParent.children = oldParent.children.filter((c) => c !== nodeId);
      oldParent.updatedAt = now();
    }
  }

  // Attach to new parent
  node.parentId = newParentId;
  node.updatedAt = now();
  newParent.children.push(nodeId);
  newParent.updatedAt = now();

  saveTree(tree);
}

/**
 * Find a node by ID. Returns null if not found.
 * @param {object} tree
 * @param {string} nodeId
 * @returns {object|null}
 */
function getNode(tree, nodeId) {
  return tree.nodes[nodeId] ?? null;
}

/**
 * Walk the tree depth-first, calling fn(node, depth) for each node.
 * @param {object} tree
 * @param {function} fn
 * @param {string} [startId]
 */
function walkTree(tree, fn, startId) {
  function walk(id, depth) {
    const node = tree.nodes[id];
    if (!node) return;
    fn(node, depth);
    for (const cid of node.children) walk(cid, depth + 1);
  }
  walk(startId ?? tree.rootId, 0);
}

// ── Entry helpers ─────────────────────────────────────────────────────────────

/**
 * Add an entry to a specific node. Auto-assigns a UID.
 * @param {object} tree
 * @param {string} nodeId
 * @param {object} params  { title, content, keys }
 * @returns {object}  the created entry
 */
function addEntry(tree, nodeId, params) {
  const node = tree.nodes[nodeId];
  if (!node) throw new Error(`Node "${nodeId}" not found`);

  const t = now();
  const entry = {
    uid: tree.nextUid++,
    title: params.title ?? "Untitled",
    content: params.content ?? "",
    keys: Array.isArray(params.keys) ? params.keys : [],
    enabled: true,
    createdAt: t,
    updatedAt: t,
  };

  node.entries.push(entry);
  node.updatedAt = t;

  saveTree(tree);
  return entry;
}

/**
 * Find an entry by UID anywhere in the tree.
 * @param {object} tree
 * @param {number} uid
 * @returns {{ node: object, entry: object } | null}
 */
function findEntry(tree, uid) {
  for (const node of Object.values(tree.nodes)) {
    const entry = node.entries.find((e) => e.uid === uid);
    if (entry) return { node, entry };
  }
  return null;
}

/**
 * Update an entry by UID. Merges provided fields only.
 * @param {object} tree
 * @param {number} uid
 * @param {object} updates  { title?, content?, keys?, enabled? }
 * @returns {object}  the updated entry
 */
function updateEntry(tree, uid, updates) {
  const found = findEntry(tree, uid);
  if (!found) throw new Error(`Entry UID ${uid} not found`);

  const { node, entry } = found;
  if (updates.title !== undefined) entry.title = updates.title;
  if (updates.content !== undefined) entry.content = updates.content;
  if (updates.keys !== undefined) entry.keys = updates.keys;
  if (updates.enabled !== undefined) entry.enabled = updates.enabled;
  entry.updatedAt = now();
  node.updatedAt = now();

  saveTree(tree);
  return entry;
}

/**
 * Disable (soft-delete) an entry by UID.
 * @param {object} tree
 * @param {number} uid
 */
function disableEntry(tree, uid) {
  return updateEntry(tree, uid, { enabled: false });
}

/**
 * Move an entry from its current node to another.
 * @param {object} tree
 * @param {number} uid
 * @param {string} targetNodeId
 */
function moveEntry(tree, uid, targetNodeId) {
  const found = findEntry(tree, uid);
  const target = tree.nodes[targetNodeId];
  if (!found) throw new Error(`Entry UID ${uid} not found`);
  if (!target) throw new Error(`Target node "${targetNodeId}" not found`);

  const { node: srcNode, entry } = found;
  srcNode.entries = srcNode.entries.filter((e) => e.uid !== uid);
  srcNode.updatedAt = now();
  target.entries.push(entry);
  target.updatedAt = now();

  saveTree(tree);
}

/**
 * Get all enabled entries across the entire tree (or a subtree).
 * @param {object} tree
 * @param {string} [startId]
 * @returns {Array<{ nodeId: string, nodeLabel: string, entry: object }>}
 */
function getAllEntries(tree, startId) {
  const results = [];
  walkTree(
    tree,
    (node) => {
      for (const entry of node.entries) {
        if (entry.enabled !== false) {
          results.push({ nodeId: node.id, nodeLabel: node.label, entry });
        }
      }
    },
    startId,
  );
  return results;
}

// ── Tree overview (for tool injection) ───────────────────────────────────────

/**
 * Build a compact text representation of the tree for the AI.
 * This is injected into the Search tool description so Claude can navigate.
 *
 * Format (collapsed):
 *   [node_id] Label (N entries)
 *     Summary text
 *     ├── [child_id] Child Label (N entries)
 *
 * @param {object} tree
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=99]
 * @param {boolean} [opts.includeEntryTitles=false]  show entry titles at leaf nodes
 * @returns {string}
 */
function buildTreeOverview(tree, opts = {}) {
  const { maxDepth = 99, includeEntryTitles = false } = opts;
  const lines = [`📺 TunnelVision — ${tree.charName}`];

  function countEntries(nodeId) {
    let count = 0;
    walkTree(
      tree,
      (n) => {
        count += n.entries.filter((e) => e.enabled !== false).length;
      },
      nodeId,
    );
    return count;
  }

  function render(nodeId, depth, prefix) {
    if (depth > maxDepth) return;
    const node = tree.nodes[nodeId];
    if (!node) return;

    const total = countEntries(nodeId);
    const direct = node.entries.filter((e) => e.enabled !== false).length;
    const isLeaf = node.children.length === 0;
    const summary = node.summary ? `  ${node.summary}` : "";

    const countStr = total > 0 ? ` (${total} entries)` : "";
    lines.push(`${prefix}[${nodeId}] ${node.label}${countStr}`);
    if (summary) lines.push(`${prefix}  └─ ${node.summary}`);

    if (includeEntryTitles && isLeaf && direct > 0) {
      for (const e of node.entries
        .filter((e) => e.enabled !== false)
        .slice(0, 8)) {
        lines.push(`${prefix}    • UID ${e.uid}: ${e.title}`);
      }
      if (direct > 8) lines.push(`${prefix}    • ... +${direct - 8} more`);
    }

    const childPrefix = prefix + "  ";
    for (const cid of node.children) {
      render(cid, depth + 1, childPrefix);
    }
  }

  // Skip root label, render its children directly to keep overview concise
  const root = tree.nodes[tree.rootId];
  if (!root) return "(empty tree)";

  // Root-level direct entries (if any)
  const rootDirect = root.entries.filter((e) => e.enabled !== false);
  if (rootDirect.length > 0) {
    lines.push(`[root] Root (${rootDirect.length} entries)`);
  }

  for (const cid of root.children) render(cid, 0, "");

  return lines.join("\n");
}

/**
 * Retrieve all entries under a node (and its descendants) as formatted text.
 * Used by Search tool to build the context block.
 * @param {object} tree
 * @param {string} nodeId
 * @returns {string}
 */
function retrieveNodeContent(tree, nodeId) {
  const results = getAllEntries(tree, nodeId);
  if (!results.length) return "";

  const lines = [];
  for (const { nodeLabel, entry } of results) {
    lines.push(`[${nodeLabel} | UID: ${entry.uid} | ${entry.title}]`);
    lines.push(entry.content);
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ── Trigram deduplication ─────────────────────────────────────────────────────

/**
 * Compute trigram similarity between two strings (0–1).
 * Used by Remember tool to warn about near-duplicate entries.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function trigramSimilarity(a, b) {
  if (!a || !b) return 0;
  const getTrigrams = (s) => {
    const set = new Set();
    const norm = s.toLowerCase().replace(/\s+/g, " ").trim();
    for (let i = 0; i < norm.length - 2; i++) set.add(norm.slice(i, i + 3));
    return set;
  };
  const ta = getTrigrams(a);
  const tb = getTrigrams(b);
  if (!ta.size && !tb.size) return 1;
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const t of ta) if (tb.has(t)) intersection++;
  return (2 * intersection) / (ta.size + tb.size);
}

/**
 * Find entries in the tree that are similar to a given text.
 * Returns entries with similarity above threshold.
 * @param {object} tree
 * @param {string} text
 * @param {number} [threshold=0.6]
 * @returns {Array<{ nodeId, nodeLabel, entry, similarity }>}
 */
function findSimilarEntries(tree, text, threshold = 0.6) {
  const all = getAllEntries(tree);
  return all
    .map((item) => ({
      ...item,
      similarity: trigramSimilarity(
        text,
        `${item.entry.title} ${item.entry.content}`,
      ),
    }))
    .filter((item) => item.similarity >= threshold)
    .sort((a, b) => b.similarity - a.similarity);
}

// ── Summaries arc helpers ─────────────────────────────────────────────────────

/**
 * Get or create a named arc under the Summaries node.
 * Arc = a sub-node of summaries for organizing by narrative thread.
 * @param {object} tree
 * @param {string} arcName
 * @returns {object}  the arc node
 */
function getOrCreateArc(tree, arcName) {
  const summaries = tree.nodes[tree.summariesId];
  if (!summaries) throw new Error("Summaries node missing from tree");

  // Check for existing arc with this name
  for (const cid of summaries.children) {
    const child = tree.nodes[cid];
    if (child?.isArc && child.label === arcName) return child;
  }

  // Create new arc
  const arc = addNode(tree, tree.summariesId, arcName, { isArc: true });
  return arc;
}

module.exports = {
  // I/O
  loadTree,
  saveTree,
  getOrCreateTree,
  createTree,
  deleteTree,
  listTrees,
  sanitizeCharName,
  treePath,

  // Node ops
  addNode,
  removeNode,
  moveNode,
  getNode,
  walkTree,

  // Entry ops
  addEntry,
  findEntry,
  updateEntry,
  disableEntry,
  moveEntry,
  getAllEntries,

  // Tree overview / retrieval
  buildTreeOverview,
  retrieveNodeContent,

  // Dedup
  trigramSimilarity,
  findSimilarEntries,

  // Summaries arcs
  getOrCreateArc,
};
