// sync-memory-md.js — 读取 MEMORY.md 并同步到知识库
const fs = require("fs");
const { randomUUID } = require("node:crypto");

async function syncMemoryMdToKB(db, embeddings, api) {
  const filePath = "/root/.openclaw/workspace/MEMORY.md";
  if (!fs.existsSync(filePath)) return { written: 0, skipped: 0 };

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const entries = [];
  let currentEntry = null;

  for (const line of lines) {
    if (line.startsWith("### ") && line.includes("— Dreaming")) {
      if (currentEntry) entries.push(currentEntry);
      currentEntry = { header: line, text: "" };
    } else if (currentEntry) {
      currentEntry.text += line + "\n";
    }
  }
  if (currentEntry) entries.push(currentEntry);

  if (entries.length === 0) return { written: 0, skipped: 0 };

  const recentEntries = entries.slice(-3);
  const kbTable = await db.openTable("knowledge_base");
  const existing = await kbTable.query().limit(50).toArray();
  const existingTexts = existing.map(r => r.text || "");

  let written = 0, skipped = 0;

  for (const entry of recentEntries) {
    const excerpt = entry.text.slice(0, 500).trim();
    if (!excerpt || excerpt.length < 20) { skipped++; continue; }

    // 字符串去重
    const shortSig = excerpt.slice(-100);
    if (existingTexts.some(t => t.includes(shortSig))) {
      skipped++;
      continue;
    }

    // 生成向量
    let vector = null;
    try {
      if (embeddings?.embed) {
        vector = await embeddings.embed(excerpt);
      }
    } catch(e) {}
    if (!vector) {
      skipped++;
      api?.logger?.warn("[sync-memory-md] no vector, skipping");
      continue;
    }

    try {
      await kbTable.add([{
        id: randomUUID(),
        text: excerpt,
        vector,
        category: "summary",
        source: "MEMORY.md",
        importance: 1,
        createdAt: Date.now(),
        promotedFrom: "dreaming",
        repeatCount: 0,
        originalCreatedAt: new Date().toISOString()
      }]);
      written++;
    } catch(e) {
      api?.logger?.warn(`[sync-memory-md] write failed: ${e.message}`);
    }
  }

  return { written, skipped, total: entries.length };
}

module.exports = { syncMemoryMdToKB };
