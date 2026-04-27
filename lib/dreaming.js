// dreaming.js — Dreaming / Memory Consolidation Module
// 替代 memory-core 的 Dreaming 功能，直接操作 LanceDB

const fs = require("fs").promises;
const path = require("path");

// ============================================================
// Scoring model (无 recallCount，适配当前只召回 KB 的现状)
// ============================================================

const CATEGORY_WEIGHTS = {
  decision: 1.0,
  preference: 0.9,
  fact: 0.7,
  lesson: 0.85,
  error: 0.8,
  correction: 0.8,
  best_practice: 0.85,
  entity: 0.5,
  concept: 0.6,
  process: 0.55,
  user_message: 0.3,
  other: 0.4
};

function scoreMemory(memory, now = Date.now()) {
  const hoursSinceCreation = (now - (memory.createdAt || now)) / (60 * 60 * 1000);
  const daysSinceCreation = hoursSinceCreation / 24;
  const repeatCount = typeof memory.repeatCount === 'bigint' ? Number(memory.repeatCount) : (memory.repeatCount || 0);
  const category = (memory.category || "other").toLowerCase();

  // 重复出现 (0.30)
  const frequencyScore = Math.min(repeatCount / 3, 1.0);

  // 分类重要性 (0.25)
  const categoryScore = CATEGORY_WEIGHTS[category] || 0.4;

  // 新鲜度 (0.25) — 指数衰减，半衰期 7 天
  const recencyScore = Math.exp(-daysSinceCreation / 7);

  // 概念丰富度 (0.10) — 中文关键词密度
  const textLen = (memory.text || "").length;
  const keywordDensity = Math.min((memory.text || "").match(/[\u4e00-\u9fa5]/g)?.length || 0, 50) / Math.max(textLen / 10, 1);
  const conceptualScore = Math.min(keywordDensity / 3, 1.0);

  // 长度适中 (0.10) — 最佳 30-150 字符
  let lengthScore = 0;
  if (textLen >= 20 && textLen <= 200) {
    lengthScore = 1.0 - Math.abs(textLen - 100) / 100;
  } else if (textLen > 200) {
    lengthScore = Math.max(0.2, 1.0 - (textLen - 200) / 500);
  }

  return {
    total: 0.30 * frequencyScore + 0.25 * categoryScore + 0.25 * recencyScore + 0.10 * conceptualScore + 0.10 * lengthScore,
    frequency: frequencyScore,
    category: categoryScore,
    recency: recencyScore,
    conceptual: conceptualScore,
    length: lengthScore
  };
}

// ============================================================
// LLM Extract — 从碎片中提炼结构化要点
// ============================================================

async function llmExtract(extractor, memories) {
  if (!extractor || !extractor.client) {
    return null;
  }

  // 只取前 20 条高分记忆，避免 prompt 过大
  const topMemories = memories.slice(0, 20);
  const text = topMemories.map(m => `[${m.category || "other"}] ${m.text}`).join("\n");
  const prompt = `以下是一段时间内的对话记忆片段。请提炼出其中的关键信息，按以下格式输出：

**决策：**（用户做出的决定、选择）
**偏好：**（用户的个人偏好、习惯）
**教训：**（踩坑、错误、经验总结）
**事实：**（客观信息、配置、环境状态）
**进展：**（项目/任务的推进情况）

只提取真正有价值的信息，忽略闲聊、问候、无意义的确认。
如果某个类别没有内容，可以省略该类别。

记忆片段：
${text}

提炼结果：`;

  try {
    const response = await extractor.client.chat.completions.create({
      model: extractor.model || "auto",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1024,
      timeout: 60000  // 60 秒超时
    });
    return response.choices[0].message.content?.trim();
  } catch (e) {
    console.error('[dreaming] LLM extract error:', e.message);
    return null;
  }
}

// ============================================================
// Dream Diary — 生成人类可读的梦境日记
// ============================================================

async function llmDreamDiary(extractor, memories) {
  if (!extractor || !extractor.client) return null;

  // 只取前 15 条
  const text = memories.slice(0, 15).map(m => `• ${m.text}`).join("\n");
  const prompt = `以下是今天积累的一些记忆片段。请用第一人称（"我"）写一段简短的梦境日记摘要，语气轻松、带有反思性。不超过 300 字。

记忆片段：
${text}

梦境日记：`;

  try {
    const response = await extractor.client.chat.completions.create({
      model: extractor.model || "auto",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 512,
      timeout: 60000
    });
    return response.choices[0].message.content?.trim();
  } catch (e) {
    console.error('[dreaming] LLM diary error:', e.message);
    return null;
  }
}

// ============================================================
// Core: runDreaming
// ============================================================

async function runDreaming(deps, options = {}) {
  const { api, db, embeddings, reranker, extractor } = deps;
  const now = Date.now();
  const results = { light: [], deep: [], diary: null, memoryWrite: false, errors: [] };

  try {
    await db.ensureInitialized();

    // ---- Light Phase: 收集近期记忆，去重合并 ----
    api.logger.info("[dreaming] Light phase: collecting recent memories");
    const allMemories = await db.table.search(Array(db.vectorDim).fill(0)).limit(200).toArray();
    const recent = allMemories.filter(m => {
      if (m.id === "__schema__") return false;
      const hoursAgo = (now - m.createdAt) / (60 * 60 * 1000);
      return hoursAgo <= 24; // 最近 24 小时
    });

    if (recent.length === 0) {
      api.logger.info("[dreaming] No recent memories to process");
      return { ...results, message: "No recent memories to process" };
    }

    // 去重：按文本相似度合并
    const deduped = deduplicateMemories(recent);
    results.light = deduped.map(m => ({ id: m.id, text: m.text.slice(0, 80), category: m.category }));
    api.logger.info(`[dreaming] Light phase: ${recent.length} → ${deduped.length} after dedup`);

    // ---- Deep Phase: 评分提炼 ----
    api.logger.info("[dreaming] Deep phase: scoring and promoting");
    const scored = deduped.map(m => ({
      ...m,
      score: scoreMemory(m, now)
    })).sort((a, b) => b.score.total - a.score.total);

    // 高分条目提升 tier
    let promoted = 0;
    for (const m of scored) {
      const currentTier = m.tier || "peripheral";
      let newTier = currentTier;

      if (m.score.total >= 0.55 && currentTier === "peripheral") {
        newTier = "working";
      } else if (m.score.total >= 0.65 && currentTier === "working") {
        newTier = "core";
      }

      if (newTier !== currentTier) {
        try {
          await db.table.update({
            where: `id = '${m.id}'`,
            values: { tier: newTier }
          });
          promoted++;
          api.logger.info(`[dreaming] Promoted ${m.id.slice(0, 8)}: ${currentTier} → ${newTier} (score: ${m.score.total.toFixed(2)})`);
        } catch (e) {
          results.errors.push(`Promote failed for ${m.id.slice(0, 8)}: ${e.message}`);
        }
      }
    }
    results.deep = scored.filter(s => s.score.total >= 0.5).map(s => {
      let resolvedTier = s.tier;
      if (s.score.total >= 0.55 && s.tier === "peripheral") resolvedTier = "working";
      else if (s.score.total >= 0.65 && s.tier === "working") resolvedTier = "core";
      return {
        id: s.id.slice(0, 8), text: s.text.slice(0, 100), score: s.score.total.toFixed(2),
        oldTier: s.tier, newTier: resolvedTier
      };
    });
    api.logger.info(`[dreaming] Deep phase: ${promoted} memories promoted`);

    // ---- LLM Extraction: 提炼结构化要点 → MEMORY.md ----
    if (options.extract !== false && extractor?.client) {
      api.logger.info("[dreaming] LLM extraction: generating structured summary");
      const extracted = await llmExtract(extractor, deduped);
      api.logger.info(`[dreaming] LLM extraction result: ${extracted ? "got content (" + extracted.length + " chars)" : "null/empty"}`);
      if (extracted) {
        api.logger.info(`[dreaming] LLM extraction preview: ${extracted.slice(0, 100)}...`);
        const written = appendToMemoryMd(extracted, now);
        results.memoryWrite = written;
        api.logger.info(`[dreaming] MEMORY.md ${written ? "updated" : "failed"}`);

        // Sync to knowledge_base
        if (written) {
          const { syncMemoryMdToKB } = require("../lib/sync-memory-md");
          try {
            const syncResult = await syncMemoryMdToKB(db, embeddings, api);
            api.logger.info(`[dreaming] MEMORY.md → KB sync: ${JSON.stringify(syncResult)}`);
          } catch (syncErr) {
            api.logger.warn(`[dreaming] MEMORY.md → KB sync failed: ${syncErr.message}`);
          }
        }
      }
    }

    // ---- Dream Diary → DREAMS.md ----
    if (options.diary !== false && extractor?.client) {
      const diary = await llmDreamDiary(extractor, deduped);
      api.logger.info(`[dreaming] Dream diary result: ${diary ? "got content (" + diary.length + " chars)" : "null/empty"}`);
      if (diary) {
        api.logger.info(`[dreaming] Dream diary preview: ${diary.slice(0, 100)}...`);
        const written = appendToDreamsMd(diary, now);
        results.diary = { text: diary.slice(0, 100), written };
        api.logger.info(`[dreaming] DREAMS.md ${written ? "updated" : "failed"}`);
      }
    }

    // ---- Low-score: 标记遗忘 ----
    const lowScore = scored.filter(s => s.score.total < 0.3);
    let forgotten = 0;
    for (const m of lowScore) {
      if (m.tier === "peripheral" && (now - m.createdAt) > 7 * 24 * 60 * 60 * 1000) {
        try {
          await db.table.delete(`id = '${m.id}'`);
          forgotten++;
        } catch (e) {}
      }
    }

    results.summary = {
      lightCollected: recent.length,
      lightDeduped: deduped.length,
      deepPromoted: promoted,
      lowScoreForgotten: forgotten,
      memoryWritten: results.memoryWrite,
      diaryWritten: results.diary?.written || false
    };

    api.logger.info(`[dreaming] Complete: ${JSON.stringify(results.summary)}`);
  } catch (e) {
    results.errors.push(`Dreaming failed: ${e.message}`);
    api.logger.error(`[dreaming] Fatal error: ${e.message}`);
  }

  return results;
}

// ============================================================
// Deduplication
// ============================================================

function deduplicateMemories(memories, threshold = 0.85) {
  if (memories.length === 0) return [];

  // Simple text overlap dedup
  const kept = [];
  for (const m of memories) {
    const isDup = kept.some(k => {
      const sim = textSimilarity(m.text, k.text);
      return sim >= threshold;
    });
    if (!isDup) kept.push(m);
  }
  return kept;
}

function textSimilarity(a, b) {
  const short = a.length < b.length ? a : b;
  const long = a.length < b.length ? b : a;
  if (short.length === 0) return 1.0;

  // Character-level Jaccard for Chinese text
  const charsA = new Set(short.split(""));
  const charsB = new Set(long.split(""));
  let intersection = 0;
  for (const c of charsA) { if (charsB.has(c)) intersection++; }
  const union = new Set([...charsA, ...charsB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ============================================================
// File I/O — MEMORY.md / DREAMS.md
// ============================================================

async function getWorkspaceDir(api) {
  // Workspace is always /root/.openclaw/workspace in Docker container
  return "/root/.openclaw/workspace";
}

function appendToMemoryMd(content, now) {
  try {
    const fs = require('fs');
    const filePath = '/root/.openclaw/workspace/MEMORY.md';
    const dateStr = new Date(now).toISOString().slice(0, 19).replace('T', ' ');
    const entry = `\n\n### ${dateStr} — Dreaming Auto-Consolidation\n\n${content}\n`;
    fs.appendFileSync(filePath, entry, 'utf8');
    console.error('[dreaming] MEMORY.md append: OK');
    return true;
  } catch (e) {
    console.error('[dreaming] MEMORY.md write failed:', e.message);
    return false;
  }
}

function appendToDreamsMd(content, now) {
  try {
    const fs = require('fs');
    const filePath = '/root/.openclaw/workspace/DREAMS.md';
    const dateStr = new Date(now).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const entry = `\n\n## ${dateStr}\n\n${content}\n`;
    fs.appendFileSync(filePath, entry, 'utf8');
    console.error('[dreaming] DREAMS.md append: OK');
    return true;
  } catch (e) {
    console.error('[dreaming] DREAMS.md write failed:', e.message);
    return false;
  }
}

// ============================================================
// Cron-like scheduler
// ============================================================

function scheduleDreaming(api, deps, options = {}) {
  const cronExpr = options.frequency || "0 3 * * *"; // default: 3 AM daily

  // Parse simple cron (only supports "N H * * *" format)
  const parts = cronExpr.split(" ");
  const targetHour = parseInt(parts[1]) || 3;
  const targetMinute = parseInt(parts[0]) || 0;

  const scheduleNext = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(targetHour, targetMinute, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1); // tomorrow

    const delayMs = next.getTime() - now.getTime();
    api.logger.info(`[dreaming] Scheduled next run at ${next.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })} (${Math.round(delayMs / 60000)}min)`);

    setTimeout(async () => {
      api.logger.info("[dreaming] Triggered by schedule");
      await runDreaming(deps, { extract: true, diary: true });
      scheduleNext(); // reschedule
    }, delayMs);
  };

  scheduleNext();
}

module.exports = { runDreaming, scheduleDreaming, scoreMemory, deduplicateMemories };
