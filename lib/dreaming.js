// dreaming.js — 三阶段梦境系统（模仿 memory-core）
//
// 流程: Light → REM → Deep
//   Light: 去重、候选筛选 → phase-signals.json
//   REM:   提炼主题、反思 → DREAMS.md
//   Deep:  评分、过门槛 → MEMORY.md

const { randomUUID } = require("node:crypto");
const { join, dirname } = require("node:path");

const MEMORY_MD = "/root/.openclaw/workspace/MEMORY.md";
const DREAMS_MD = "/root/.openclaw/workspace/DREAMS.md";
const DREAMS_DIR = "/root/.openclaw/memory/.dreams";
const CHECKPOINT_FILE = join(DREAMS_DIR, "checkpoint.json");
const LOCK_FILE = join(DREAMS_DIR, "lock.json");
const PHASE_SIGNALS = join(DREAMS_DIR, "phase-signals.json");
const MAX_DREAMING_ENTRIES = 3;

// ─── State management ─────────────────────────────────────────────
function ensureDreamsDir() {
  const fs = require("fs");
  if (!fs.existsSync(DREAMS_DIR)) fs.mkdirSync(DREAMS_DIR, { recursive: true });
}

function readJson(file, fallback = null) {
  try { return JSON.parse(require("fs").readFileSync(file, "utf8")); } catch(e) { return fallback; }
}
function writeJson(file, data) {
  ensureDreamsDir();
  require("fs").writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function acquireLock() {
  const lock = readJson(LOCK_FILE);
  if (lock && Date.now() - lock.acquiredAt < 300000) { // 5min timeout
    console.error("[dreaming] lock held, skipping");
    return false;
  }
  writeJson(LOCK_FILE, { acquiredAt: Date.now() });
  return true;
}
function releaseLock() {
  try { require("fs").unlinkSync(LOCK_FILE); } catch(e) {}
}

function getCheckpoint() {
  return readJson(CHECKPOINT_FILE, { lastRun: 0, processedIds: [], lastDreamDate: null });
}
function saveCheckpoint(cp) {
  writeJson(CHECKPOINT_FILE, cp);
}

function getPhaseSignals() {
  return readJson(PHASE_SIGNALS, { light: {}, rem: {} });
}
function addPhaseSignal(phase, id, signal) {
  const ps = getPhaseSignals();
  if (!ps[phase]) ps[phase] = {};
  ps[phase][id] = signal;
  writeJson(PHASE_SIGNALS, ps);
}

// ─── Filtering ─────────────────────────────────────────────────────
function filterBootstrapNoise(memories) {
  return memories.filter(m => {
    const src = (m.source || "").toLowerCase();
    const text = (m.text || "").toLowerCase();
    if (src.includes("agents.md") || src.includes("soul.md") || src.includes("user.md")) return false;
    if (src.includes("/workspace/") && !src.includes("memory") && !src.includes("dream")) return false;
    if (text.includes("about the user") || text.includes("preferences") ||
        text.includes("tools & configs") || text.includes("docker 挂载")) return false;
    return true;
  });
}

function filterProcessed(memories, processedIds) {
  return memories.filter(m => !processedIds.includes(m.id));
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
      return union > 0 ? intersection / union >= threshold : false;
    });
    if (!isDup) kept.push(m);
  }
  return kept;
}

// ─── Light phase ───────────────────────────────────────────────────
async function lightPhase(api, db, deps) {
  api.logger.info("[dreaming:light] starting light phase");
  // 直接从 memories 表查询最近 100 条
  const tbl = db.table;
  const recent = await tbl.query().limit(100).toArray();
  const filtered = filterBootstrapNoise(recent);
  
  // 过滤已处理的
  const cp = getCheckpoint();
  const unprocessed = filterProcessed(filtered, cp.processedIds);
  
  // 去重
  const candidates = deduplicateMemories(unprocessed, 0.85);
  
  // 记录阶段信号
  for (const m of candidates) {
    const signal = { count: 1, freshness: 1.0, time: Date.now() };
    addPhaseSignal("light", m.id, signal);
  }
  
  // 更新 checkpoint
  cp.lastRun = Date.now();
  for (const m of candidates) {
    if (!cp.processedIds.includes(m.id)) cp.processedIds.push(m.id);
  }
  // 只保留最近 500 个 ID
  if (cp.processedIds.length > 500) cp.processedIds = cp.processedIds.slice(-500);
  saveCheckpoint(cp);
  
  api.logger.info(`[dreaming:light] ${recent.length} → ${filtered.length} → ${unprocessed.length} new → ${candidates.length} candidates`);
  return candidates;
}

// ─── REM phase ─────────────────────────────────────────────────────
async function remPhase(api, deps, candidates) {
  if (!deps?.extractor?.client || candidates.length === 0) return null;
  api.logger.info("[dreaming:rem] starting REM phase");
  
  const text = candidates.slice(0, 10).map(m => m.text).join("\n");
  const prompt = `以下是近期的记忆片段。请提炼主题和反思：

记忆片段：
${text}

请输出：
1. 主要主题（1-3个）
2. 反思/洞察（1-2条）
3. 日记条目（简短叙述）

简洁输出。`;

  try {
    const response = await deps.extractor.client.chat.completions.create({
      model: deps.extractor.model || "auto",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      max_tokens: 600,
      timeout: 60000
    });
    const content = response.choices[0].message.content?.trim();
    if (!content) return null;
    
    // 写入 DREAMS.md
    appendToDreamsMd(content);
    
    // 记录 REM 信号
    for (const m of candidates) {
      addPhaseSignal("rem", m.id, { reflected: true, time: Date.now() });
    }
    
    api.logger.info("[dreaming:rem] diary written");
    return content;
  } catch(e) {
    api.logger.warn("[dreaming:rem] error: " + e.message);
    return null;
  }
}

// ─── Session continuity analysis ──────────────────────────────────
function analyzeSessionContinuity(candidates) {
  // 按 source/session 分组，计算会话连贯性
  const sessionGroups = {};
  for (const m of candidates) {
    const src = m.source || m.sessionKey || "unknown";
    if (!sessionGroups[src]) sessionGroups[src] = [];
    sessionGroups[src].push(m);
  }
  
  const boosts = {};
  for (const m of candidates) {
    const src = m.source || m.sessionKey || "unknown";
    const group = sessionGroups[src] || [];
    // 同一会话出现 >=3 条 = 高连贯性
    if (group.length >= 5) boosts[m.id] = 0.08;
    else if (group.length >= 3) boosts[m.id] = 0.05;
    else if (group.length >= 2) boosts[m.id] = 0.02;
    else boosts[m.id] = 0;
  }
  return boosts;
}

// ─── Deep phase ────────────────────────────────────────────────────
async function deepPhase(api, deps, candidates) {
  if (!deps?.extractor?.client || candidates.length === 0) return [];
  api.logger.info("[dreaming:deep] starting deep phase");
  
  const ps = getPhaseSignals();
  
  // 评分：6 维度 + 门槛 + 会话连贯性
  const sessionBoosts = analyzeSessionContinuity(candidates);
  
  const scored = candidates.map(m => {
    const lightSignal = ps.light?.[m.id] || {};
    const remSignal = ps.rem?.[m.id] || {};
    
    const frequency = lightSignal.count || 1;
    const relevance = 0.7;
    const queryDiversity = 0.5;
    const recency = Math.max(0, 1 - (Date.now() - (m.createdAt || Date.now())) / (30*24*60*60*1000));
    const consolidation = (lightSignal.count || 0) > 1 ? 0.8 : 0.2;
    const richness = m.text.length > 100 ? 0.8 : 0.4;
    
    let score = frequency * 0.24 + relevance * 0.30 + queryDiversity * 0.15 +
                recency * 0.15 + consolidation * 0.10 + richness * 0.06;
    
    // 阶段信号加成
    if (remSignal.reflected) score += 0.05;
    
    // 会话连贯性加成（Session 转录摄入）
    const sBoost = sessionBoosts[m.id] || 0;
    score += sBoost;
    
    return { ...m, _dreamScore: score, _sessionBoost: sBoost };
  });
  
  // 过门槛 (minScore: 0.5 + minRecallCount: 2)
  const promoted = scored.filter(m => m._dreamScore >= 0.5 && (m.recallCount || 0) >= 2);
  
  api.logger.info(`[dreaming:deep] ${candidates.length} scored, ${promoted.length} promoted (recallCount>=2, +sessionBoost)`);
  return promoted.slice(0, 5);
}

// ─── Writing ───────────────────────────────────────────────────────
function appendToDreamsMd(content) {
  try {
    const fs = require("fs");
    const dateStr = new Date().toISOString().slice(0, 10);
    const entry = `\n### ${dateStr}\n\n${content}\n`;
    
    if (!fs.existsSync(DREAMS_MD)) {
      fs.writeFileSync(DREAMS_MD, `# Dream Diary\n\n${entry}`, "utf8");
    } else {
      fs.appendFileSync(DREAMS_MD, entry, "utf8");
    }
  } catch(e) {
    console.error("[dreaming] DREAMS.md write error:", e.message);
  }
}

async function llmExtract(extractor, candidates) {
  if (!extractor?.client) return null;
  
  const text = candidates.map(m => m.text).join("\n");
  const prompt = `以下是一段时间内的对话记忆片段。请提炼关键信息，严格按以下 5 个类别分别输出。

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
  } catch(e) {
    console.error("[dreaming] LLM extract error:", e.message);
    return null;
  }
}

function parseCategories(content) {
  const categories = [
    { section: '## 决策', label: '决策' },
    { section: '## 偏好', label: '偏好' },
    { section: '## 教训', label: '教训' },
    { section: '## 事实', label: '事实' },
    { section: '## 进展', label: '进展' },
  ];
  const results = [];
  for (let i = 0; i < categories.length; i++) {
    const start = content.indexOf(categories[i].section);
    if (start === -1) continue;
    let end = content.length;
    for (let j = i + 1; j < categories.length; j++) {
      const nextStart = content.indexOf(categories[j].section, start + 1);
      if (nextStart !== -1 && nextStart < end) end = nextStart;
    }
    let body = content.slice(start + categories[i].section.length, end).trim();
    body = body.replace(/^\n+/, '').replace(/```\s*$/gm, '').trim();
    if (!body || body === '无') continue;
    results.push({ label: categories[i].label, content: body });
  }
  return results;
}

function appendToMemoryMdSplit(categories) {
  try {
    const fs = require("fs");
    const now = Date.now();
    if (!categories || categories.length === 0) return false;

    let existingContent = fs.readFileSync(MEMORY_MD, "utf8");
    const dreamingMarker = "\n---\n*Last updated:";
    const markerIdx = existingContent.indexOf(dreamingMarker);

    let staticPart;
    if (markerIdx !== -1) {
      staticPart = existingContent.slice(0, existingContent.indexOf("\n", markerIdx + 2));
    } else {
      staticPart = existingContent.replace(/\n### .*Dreaming[\s\S]*$/gm, "").trimEnd();
    }

    const dateStr = new Date(now).toISOString().slice(0, 19).replace("T", " ");
    let dreamingPart = "";
    for (const cat of categories) {
      dreamingPart += `\n### ${dateStr} — [${cat.label}] Dreaming\n\n${cat.content}\n`;
    }

    const finalContent = staticPart + dreamingPart + dreamingMarker + ` ${dateStr.slice(0, 10)}*\n`;
    fs.writeFileSync(MEMORY_MD, finalContent, "utf8");
    console.error(`[dreaming:deep] MEMORY.md write OK (${categories.length} categories)`);
    return true;
  } catch(e) {
    console.error("[dreaming:deep] MEMORY.md write error:", e.message);
    return false;
  }
}

// ─── Main flow ─────────────────────────────────────────────────────
async function runDreamingSequence(api, db, deps, options = {}) {
  if (!acquireLock()) return { skipped: true, reason: "locked" };
  
  try {
    const results = { phases: {} };
    
    // Phase 1: Light
    const candidates = await lightPhase(api, db, deps);
    results.phases.light = { candidates: candidates.length };
    
    if (candidates.length === 0) {
      api.logger.info("[dreaming] no new candidates, skipping REM and Deep");
      return results;
    }
    
    // Phase 2: REM
    const diary = await remPhase(api, deps, candidates);
    results.phases.rem = { diaryWritten: !!diary };
    
    // Phase 3: Deep
    const promoted = await deepPhase(api, deps, candidates);
    results.phases.deep = { promoted: promoted.length };
    
    if (promoted.length > 0) {
      const extracted = await llmExtract(deps.extractor, promoted);
      api.logger.info(`[dreaming:deep] llmExtract output length: ${extracted?.length || 0}`);
      api.logger.info(`[dreaming:deep] llmExtract preview: ${extracted?.slice(0, 200) || 'null'}`);
      if (extracted) {
        const categories = parseCategories(extracted);
        api.logger.info(`[dreaming:deep] parsed categories: ${JSON.stringify(categories.map(c => c.label))}`);
        const written = appendToMemoryMdSplit(categories);
        api.logger.info(`[dreaming:deep] memoryWrite: ${written}`);
        results.memoryWrite = written;
        
        // Sync to KB
        if (written) {
          const { syncMemoryMdToKB } = require("../lib/sync-memory-md.cjs");
          try {
            await syncMemoryMdToKB(db.db, deps.embeddings, api);
          } catch(e) {
            api.logger.warn("[dreaming] KB sync failed: " + e.message);
          }
        }
      }
    }
    
    return results;
  } finally {
    releaseLock();
  }
}

async function runDreaming(deps, options = {}) {
  return runDreamingSequence(deps.api, deps.db, deps, options);
}

function scheduleDreaming() {}

// 单条评分（dry run 用）
function scoreMemory(m, now = Date.now()) {
  const age = (now - (m.createdAt || now)) / (24 * 60 * 60 * 1000);
  const recency = Math.max(0, 1 - age / 30);
  const richness = (m.text || "").length > 100 ? 0.8 : 0.4;
  const recallBoost = Math.min((m.recallCount || 0) * 0.05, 0.5);
  const total = recency * 0.4 + richness * 0.3 + recallBoost;
  return { total, recency, richness, recallBoost };
}

module.exports = { runDreamingSequence, runDreaming, scheduleDreaming, llmExtract, parseCategories, scoreMemory };
