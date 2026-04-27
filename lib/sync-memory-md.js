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
    let synced = 0;
    let skipped = 0;

    for (const entry of entries) {
      if (!entry.content.trim()) continue;

      // Check if already exists (simple text match)
      const existing = await kbTable.search(Array(db.vectorDim).fill(0)).limit(10).toArray();
      const dup = existing.find(e => e.text && e.text.includes(entry.content.slice(0, 50)));
      if (dup) {
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
      synced++;
    }

    api.logger.info(`[sync-memory-md] Synced ${synced} entries, skipped ${skipped} duplicates`);
    return { synced, skipped, total: entries.length };
  } catch (e) {
    api.logger.error(`[sync-memory-md] Sync failed: ${e.message}`);
    return { synced: 0, error: e.message };
  }
}

module.exports = { syncMemoryMdToKB, parseMemoryMd };
