// dreaming.js — 修复版
// 1. 只提炼 plugin 自身记忆，过滤 AGENTS/SOUL/USER bootstrap 来源
// 2. 每天最多写 1 次 MEMORY.md（避免重复堆积）
// 3. sync-memory-md 只同步最新 3 条到 KB

const LAST_DREAM_FILE = "/tmp/memory-lancedb-pro-last-dream.txt";

function shouldRunDreaming() {
  try {
    const lastRun = parseInt(require("fs").readFileSync(LAST_DREAM_FILE, "utf8").trim() || "0");
    const hoursSinceLastDream = (Date.now() - lastRun) / (1000 * 60 * 60);
    if (hoursSinceLastDream < 20) {
      console.error(`[dreaming] skip — last dream ${hoursSinceLastDream.toFixed(1)}h ago`);
      return false;
    }
  } catch(e) {}
  return true;
}

function markDreamingRan() {
  try { require("fs").writeFileSync(LAST_DREAM_FILE, String(Date.now())); } catch(e) {}
}

function deduplicateMemories(memories, threshold = 0.85) {
  if (memories.length === 0) return [];
  const kept = [];
  for (const m of memories) {
    const isDup = kept.some(k => {
      const a = m.text || "";
      const b = k.text || "";
      const short = a.length < b.length ? a : b;
      const long = a.length < b.length ? b : a;
      if (short.length === 0) return false;
      const charsA = new Set(short.split(""));
      const charsB = new Set(long.split(""));
      let intersection = 0;
      for (const c of charsA) { if (charsB.has(c)) intersection++; }
      const union = new Set([...charsA, ...charsB]).size;
      const sim = union === 0 ? 0 : intersection / union;
      return sim >= threshold;
    });
    if (!isDup) kept.push(m);
  }
  return kept;
}

// 过滤掉来自 workspace bootstrap 文件的记忆（AGENTS/SOUL/USER）
function filterBootstrapNoise(memories) {
  return memories.filter(m => {
    const src = (m.source || "").toLowerCase();
    const text = (m.text || "").toLowerCase();
    // 过滤掉完全来自 bootstrap 文件的记忆
    if (src.includes("agents.md") || src.includes("soul.md") || src.includes("user.md")) return false;
    // 过滤掉 workspace 目录下非 memory 的 bootstrap 内容
    if (src.includes("/workspace/") && !src.includes("memory") && !src.includes("dream")) return false;
    // 过滤掉包含 SOUL/AGENTS/USER 章节标题的记忆
    if (text.includes("about the user") || text.includes("preferences") ||
        text.includes("tools & configs") || text.includes("docker 挂载")) return false;
    return true;
  });
}

async function llmExtract(extractor, memories) {
  if (!extractor?.client) return null;
  const filtered = filterBootstrapNoise(memories);
  if (filtered.length === 0) return null;

  const topMemories = filtered.slice(0, 15);
  const text = topMemories.map(m => `[${m.category || "other"}] ${m.text}`).join("\n");
  const prompt = `以下是一段时间内的对话记忆片段。请提炼关键信息：

**决策：**（用户做出的决定）
**偏好：**（用户偏好）
**教训：**（踩坑、错误）[格式: [~]]
**事实：**（客观信息）
**进展：**（推进情况）

只提取真正有价值的信息，忽略闲聊和重复确认。

记忆片段：
${text}

提炼结果（简洁，不重复之前的共识）：`;

  try {
    const response = await extractor.client.chat.completions.create({
      model: extractor.model || "auto",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 800,
      timeout: 60000
    });
    return response.choices[0].message.content?.trim();
  } catch (e) {
    console.error("[dreaming] LLM extract error:", e.message);
    return null;
  }
}

async function runDreamingSequence(api, db, deps, options = {}) {
  if (!shouldRunDreaming()) return { skipped: true };

  const { getRecentMemories } = require("./store");
  const { getExtractor } = require("./extractor");
  const now = Date.now();

  try {
    const recent = await getRecentMemories(db, 100);
    if (recent.length < 3) {
      api.logger.info("[dreaming] not enough memories, skipping");
      return { skipped: true };
    }

    const deduped = deduplicateMemories(recent, 0.85);
    api.logger.info(`[dreaming] ${recent.length} → ${deduped.length} after dedup+filter`);

    const results = { errors: [] };

    if (options.extract !== false && deps?.extractor?.client) {
      const extracted = await llmExtract(deps.extractor, deduped);
      if (extracted) {
        const written = appendToMemoryMd(extracted, now);
        results.memoryWrite = written;
        if (written) {
          markDreamingRan();
          const { syncMemoryMdToKB } = require("../lib/sync-memory-md");
          try {
            const syncResult = await syncMemoryMdToKB(db, deps.embeddings, api);
            results.kbSync = syncResult;
          } catch (e) {
            api.logger.warn("[dreaming] KB sync failed: " + e.message);
          }
        }
      }
    }

    return results;
  } catch (e) {
    api.logger.error("[dreaming] fatal: " + e.message);
    return { errors: [e.message] };
  }
}

function appendToMemoryMd(content, now) {
  try {
    const fs = require("fs");
    const filePath = "/root/.openclaw/workspace/MEMORY.md";
    const dateStr = new Date(now).toISOString().slice(0, 19).replace("T", " ");
    const entry = `\n\n### ${dateStr} — Dreaming Auto-Consolidation\n\n${content}\n`;
    fs.appendFileSync(filePath, entry, "utf8");
    console.error("[dreaming] MEMORY.md write OK");
    return true;
  } catch (e) {
    console.error("[dreaming] MEMORY.md write failed:", e.message);
    return false;
  }
}

module.exports = { runDreamingSequence, llmExtract };
