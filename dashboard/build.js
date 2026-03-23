// ============================================================
// dashboard/build.js — Concatenates all dashboard JS files
// into a single dashboard.bundle.js for faster page loads.
// Run manually: node dashboard/build.js
// Or automatically on proxy startup via index.js.
// ============================================================

const fs = require("fs");
const path = require("path");

// ── File order matters — core must be first ────────────────
const FILES = [
  "js/dashboard-core.js",
  "js/dashboard-overview.js",
  "js/dashboard-logs.js",
  "js/dashboard-samplers.js",
  "js/dashboard-regex.js",
  "js/dashboard-rag.js",
  "js/dashboard-tunnelvision.js",
];

const OUT = path.join(__dirname, "dashboard.bundle.js");
const BASE = __dirname;

let bundle = `// dashboard.bundle.js — Auto-generated on ${new Date().toISOString()}
// DO NOT EDIT — edit the source files in dashboard/js/ instead.\n\n`;

let totalBytes = 0;

for (const file of FILES) {
  const fullPath = path.join(BASE, file);
  if (!fs.existsSync(fullPath)) {
    console.warn(`[build] ⚠ Missing file: ${file} — skipping`);
    continue;
  }
  const src = fs.readFileSync(fullPath, "utf8");
  totalBytes += Buffer.byteLength(src, "utf8");
  bundle += `// ── ${file} ${"─".repeat(Math.max(0, 52 - file.length))}\n`;
  bundle += src.trim() + "\n\n";
  console.log(
    `[build] ✓ ${file} (${(Buffer.byteLength(src, "utf8") / 1024).toFixed(1)} KB)`,
  );
}

fs.writeFileSync(OUT, bundle, "utf8");

const outSize = Buffer.byteLength(bundle, "utf8");
console.log(
  `[build] ✦ Bundle written → dashboard.bundle.js (${(outSize / 1024).toFixed(1)} KB total)`,
);
