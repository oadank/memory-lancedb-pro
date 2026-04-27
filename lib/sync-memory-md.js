// sync-memory-md.js — 读取 MEMORY.md 并同步到知识库（跳过 SOUL/AGENTS/USER 重复内容）
const fs = require("fs");

async function syncMemoryMdToKB(db, embeddings, api) {
  const filePath = "/root/.openclaw/workspace/MEMORY.md";
  if (!fs.existsSync(filePath)) return { written: 0, skipped: 0 };

  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const entries = [];
  let currentEntry = null;

  // 按 ### 分隔符解析条目
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

  // 只同步最新的 3 条，避免重复堆积
  const recentEntries = entries.slice(-3);
  let written = 0, skipped = 0;

  for (const entry of recentEntries) {
    const excerpt = entry.text.slice(0, 500).trim();
    if (!excerpt || excerpt.length < 20) { skipped++; continue; }

    // 检查 KB 里是否已有完全相同的内容
    try {
      const kbTable = await db.openTable("knowledge_base");
      const existing = await kbTable.search([0.5], "MEMORY.md duplicate check").limit(1).toArray();
      // 简单去重：检查最后 100 字符是否相同
      const shortSig = excerpt.slice(-100);
      const dupCheck = await kbTable.search([0.5], shortSig).limit(1).toArray();
      if (dupCheck.length > 0 && dupCheck[0].body?.includes(shortSig)) {
        skipped++;
        continue;
      }
    } catch(e) {}

    try {
      const kbTable = await db.openTable("knowledge_base");
      await kbTable.add([{
        body: excerpt,
        category: "summary",
        importance: 1,
        source: "MEMORY.md",
        createdAt: Date.now()
      }]);
      written++;
    } catch(e) {
      api?.logger?.warn(`[sync-memory-md] write failed: ${e.message}`);
    }
  }

  return { written, skipped, total: entries.length };
}

module.exports = { syncMemoryMdToKB };
