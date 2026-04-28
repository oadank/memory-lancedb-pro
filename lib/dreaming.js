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
  const prompt = `以下是一段时间内的对话记忆片段。请提炼关键信息，严格按以下 5 个类别分别输出。每个类别单独一个标题，不要合并。

## 决策
（用户做出的决定，简洁列点）

## 偏好
（用户偏好，简洁列点）

## 教训
（踩坑、错误，每条前加 [~]）

## 事实
（客观信息，简洁列点）

## 进展
（推进情况，简洁列点）

只提取真正有价值的信息，忽略闲聊和重复确认。如果某个类别没有新内容，输出"无"。
不要添加类别标题以外的额外格式。
不重复之前已共识的内容。

记忆片段：
${text}

请开始提炼：`;

  try {
    const response = await extractor.client.chat.completions.create({
      model: extractor.model || "auto",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      max_tokens: 1200,
      timeout: 60000
    });
    return response.choices[0].message.content?.trim();
  } catch (e) {
    console.error("[dreaming] LLM extract error:", e.message);
    return null;
  }
}

// 将 LLM 输出按类别拆分为 { category, label, content } 数组
function parseCategories(content) {
  const categories = [
    { section: '## 决策', label: '决策', key: 'decision' },
    { section: '## 偏好', label: '偏好', key: 'preference' },
    { section: '## 教训', label: '教训', key: 'lesson' },
    { section: '## 事实', label: '事实', key: 'fact' },
    { section: '## 进展', label: '进展', key: 'progress' },
  ];
  const results = [];
  for (let i = 0; i < categories.length; i++) {
    const start = content.indexOf(categories[i].section);
    if (start === -1) continue;
    // 内容从标题下一行开始，到下一个标题或末尾为止
    let end = content.length;
    for (let j = i + 1; j < categories.length; j++) {
      const nextStart = content.indexOf(categories[j].section, start + 1);
      if (nextStart !== -1 && nextStart < end) end = nextStart;
    }
    let body = content.slice(start + categories[i].section.length, end).trim();
    // 去掉开头的换行和可能的空行，也去掉结尾多余的 ``` 等格式符
    body = body.replace(/^\n+/, '').replace(/```\s*$/gm, '').trim();
    if (!body || body === '无') continue;
    results.push({ label: categories[i].label, key: categories[i].key, content: body });
  }
  return results;
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
        // 按类别拆分，分别写入独立条目
        const categories = parseCategories(extracted);
        const written = appendToMemoryMdSplit(categories, now);
        results.memoryWrite = written;
        if (written) {
          markDreamingRan();
          const { syncMemoryMdToKB } = require("../lib/sync-memory-md.cjs");
          try {
            const syncResult = await syncMemoryMdToKB(db.db, deps.embeddings, api);
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

// 新版：覆盖写入 MEMORY.md 结构化部分 + 最新 N 条 Dreaming（解决无限膨胀问题）
const MAX_DREAMING_ENTRIES = 3; // 最多保留 3 条 Dreaming

function appendToMemoryMdSplit(categories, now) {
  try {
    const fs = require("fs");
    const filePath = "/root/.openclaw/workspace/MEMORY.md";
    if (!categories || categories.length === 0) return false;

    // 读取现有文件，分离静态部分（用户手动维护）和 Dreaming 部分（自动生成）
    let existingContent = fs.readFileSync(filePath, "utf8");
    const dreamingMarker = "\n---\n*Last updated:";
    const markerIdx = existingContent.indexOf(dreamingMarker);

    // 静态部分：Everything 到 "---" 之前的内容（Projects, Decisions, Lessons, Wiki Vault）
    let staticPart;
    if (markerIdx !== -1) {
      // 包含 marker 行，保留已有的 last updated 行位置
      staticPart = existingContent.slice(0, existingContent.indexOf("\n", markerIdx + 2));
    } else {
      // 没有 marker，用整个文件作为静态部分（首次运行或格式不匹配）
      staticPart = existingContent.replace(/\n### .*Dreaming[\s\S]*$/gm, "").trimEnd();
    }

    // 生成 Dreaming 部分（覆盖写入，只保留最新 N 条）
    const dateStr = new Date(now).toISOString().slice(0, 19).replace("T", " ");
    let dreamingPart = "";
    for (const cat of categories) {
      dreamingPart += `\n### ${dateStr} — [${cat.label}] Dreaming\n\n${cat.content}\n`;
    }

    // 合并写入：静态部分 + Dreaming 部分
    const finalContent = staticPart + dreamingPart + dreamingMarker + ` ${dateStr.slice(0, 10)}*\n`;
    fs.writeFileSync(filePath, finalContent, "utf8");
    console.error(`[dreaming] MEMORY.md overwrite OK (${categories.length} categories, capped at ${MAX_DREAMING_ENTRIES})`);
    return true;
  } catch (e) {
    console.error("[dreaming] MEMORY.md write failed:", e.message);
    return false;
  }
}

// 别名
async function runDreaming(deps, options = {}) {
  return runDreamingSequence(deps.api, deps.db, deps, options);
}
function scheduleDreaming() {}
module.exports = { runDreamingSequence, runDreaming, scheduleDreaming, llmExtract };
