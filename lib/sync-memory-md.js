// sync-memory-md.js — MEMORY.md → knowledge_base 同步
const fs = require("fs");
const path = require("path");

function parseMemoryMd(content) {
  const entries = [];
  const lines = content.split("\n");
  let currentEntry = null;

  for (const line of lines) {
    if (line.startsWith("### ")) {
      if (currentEntry) entries.push(currentEntry);
      currentEntry = { date: line.replace("### ", "").trim(), content: "" };
    } else if (line.startsWith("- ") || line.startsWith("**")) {
      if (currentEntry) currentEntry.content += line + "\n";
    }
  }
  if (currentEntry) entries.push(currentEntry);
  return entries;
}

async function syncMemoryMdToKB(db, embeddings, api) {
  try {
    const filePath = "/root/.openclaw/workspace/MEMORY.md";
    if (!fs.existsSync(filePath)) {
      api.logger.info("[sync-memory-md] MEMORY.md not found, skipping");
      return { synced: 0 };
    }

    const content = fs.readFileSync(filePath, "utf8");
    const entries = parseMemoryMd(content);
    if (entries.length === 0) {
      api.logger.info("[sync-memory-md] No entries found in MEMORY.md");
      return { synced: 0 };
    }

    await db.ensureInitialized();
    const kbTable = await db.getKnowledgeTable();

    // Fetch ALL existing KB entries (limit 200 to be safe)
    const allKBEntries = await kbTable.search(Array(db.vectorDim).fill(0)).limit(200).toArray();
    const kbEntries = allKBEntries.filter(e => e.id !== "__schema__");

    let synced = 0;
    let skipped = 0;

    for (const entry of entries) {
      if (!entry.content.trim()) continue;

      // Dedup check against ALL existing KB entries
      const isDuplicate = checkDuplicate(entry.content, kbEntries);
      if (isDuplicate) {
        skipped++;
        continue;
      }

      // Embed and add
      const vector = await embeddings.embed(entry.content);
      await db.addKBEntry(entry.content, vector, 2, "lesson", {
        source: "MEMORY.md",
        date: entry.date,
        promotedFrom: 'memory-md-sync',
        repeatCount: 0,
        originalCreatedAt: Date.now()
      });
      // Add to in-memory list so subsequent entries in this run can detect it too
      kbEntries.push({ text: entry.content, id: '__temp__' });
      synced++;
    }

    api.logger.info(`[sync-memory-md] Synced ${synced} entries, skipped ${skipped} duplicates`);
    return { synced, skipped, total: entries.length };
  } catch (e) {
    api.logger.error(`[sync-memory-md] Sync failed: ${e.message}`);
    return { synced: 0, error: e.message };
  }
}

/**
 * Check if entry text is a duplicate of existing KB entries.
 * 3-tier matching: exact → substring → n-gram similarity.
 */
function checkDuplicate(text, existingEntries) {
  const normalized = text.trim().toLowerCase();

  for (const entry of existingEntries) {
    if (!entry.text) continue;
    const existingText = entry.text.trim().toLowerCase();

    // 1. Exact match (after normalization)
    if (normalized === existingText) return true;

    // 2. Substring match: one is contained in the other (>= 80 chars overlap)
    if (normalized.length >= 80 && existingText.includes(normalized.substring(0, 80))) return true;
    if (existingText.length >= 80 && normalized.includes(existingText.substring(0, 80))) return true;

    // 3. N-gram Jaccard similarity (catches near-duplicates with minor wording changes)
    if (normalized.length > 30 && existingText.length > 30) {
      const sim = ngramJaccard(normalized, existingText, 2);
      if (sim >= 0.40) return true;
    }
  }
  return false;
}

/**
 * Calculate Jaccard similarity using character n-grams.
 */
function ngramJaccard(a, b, n = 2) {
  if (a.length < n || b.length < n) return 0;
  const ngramsA = new Set();
  const ngramsB = new Set();
  for (let i = 0; i <= a.length - n; i++) ngramsA.add(a.slice(i, i + n));
  for (let i = 0; i <= b.length - n; i++) ngramsB.add(b.slice(i, i + n));
  let intersection = 0;
  for (const ng of ngramsA) { if (ngramsB.has(ng)) intersection++; }
  const union = ngramsA.size + ngramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

module.exports = { syncMemoryMdToKB, parseMemoryMd };
