// index.js — memory-lancedb-pro 插件入口（模块化重构版）
// 职责：初始化 → 注册所有工具 → 设置事件监听 → 启动后台服务

const { randomUUID } = require("node:crypto");
const lancedb = require("@lancedb/lancedb");

// ============================================================
// Lib imports
// ============================================================
const { MemoryDB, recallFromWiki } = require("./lib/store");
const { Embeddings } = require("./lib/embedder");
const { Reranker } = require("./lib/reranker");
const { LLMExtractor } = require("./lib/extractor");
const { isNoise, shouldForceRecall, shouldSkipRecall, ENVELOPE_PATTERNS } = require("./lib/noise-filter");
const { lengthNormalizeScore } = require("./lib/utils");
const { jaccardSimilarity } = require("./lib/utils");
const { shouldDemote } = require("./lib/decay");
const { runDreaming, scheduleDreaming } = require("./lib/dreaming");

// ============================================================
// Tool imports
// ============================================================
const recallTools = require("./tools/recall");
const crudTools = require("./tools/crud");
const statsTools = require("./tools/stats");
const decayTools = require("./tools/decay-tools");
const kgTools = require("./tools/knowledge-graph");
const qualityTools = require("./tools/quality");
const exportTools = require("./tools/export");
const syncTools = require("./tools/sync");
const healthTools = require("./tools/health");
const kbTools = require("./tools/knowledge-base");
const dreamingTools = require("./tools/dreaming-tools");

// ============================================================
// Constants
// ============================================================
const DEFAULT_DIMENSIONS = 512;
const DEFAULT_DB_PATH = "~/.openclaw/memory/lancedb-pro";

// ============================================================
// Plugin export
// ============================================================
module.exports = {
  id: "memory-lancedb-pro",
  name: "Memory (LanceDB Pro)",
  description: "LanceDB-backed long-term memory with auto-recall/capture (modular)",
  kind: "memory",
  configSchema: {
    type: "object",
    additionalProperties: true,
    properties: {
      embedding: {
        type: "object", additionalProperties: true,
        properties: { apiKey: { type: "string" }, model: { type: "string" }, baseUrl: { type: "string" }, dimensions: { type: "number" } },
        required: ["apiKey"]
      },
      dbPath: { type: "string" }, autoCapture: { type: "boolean" }, autoRecall: { type: "boolean" },
      dreaming: { type: "object", properties: { enabled: { type: "boolean" }, frequency: { type: "string" } } },
      storageOptions: { type: "object" },
      rerank: { type: "object", properties: { apiKey: { type: "string" }, baseUrl: { type: "string" }, model: { type: "string" } } },
      llm: { type: "object", properties: { apiKey: { type: "string" }, baseUrl: { type: "string" }, model: { type: "string" } } }
    },
    required: ["embedding"]
  },

  register(api) {
    const cfg = api.pluginConfig;
    console.error('[DEBUG] pluginConfig:', JSON.stringify(cfg, null, 2));
    const dbPath = cfg.dbPath || DEFAULT_DB_PATH;
    const resolvedDbPath = dbPath.includes("://") ? dbPath : api.resolvePath(dbPath);
    const { model, dimensions, apiKey, baseUrl } = cfg.embedding;

    // Init core instances
    const db = new MemoryDB(resolvedDbPath, dimensions || DEFAULT_DIMENSIONS, cfg.storageOptions);
    const embeddings = new Embeddings(apiKey, model, baseUrl, dimensions);
    console.error("[DEBUG] embeddings created, client=", !!embeddings?.client, "model=", embeddings?.model);
    const reranker = cfg.rerank?.apiKey ? new Reranker(cfg.rerank.apiKey, cfg.rerank.baseUrl) : null;
    const llmExtractor = new LLMExtractor(cfg.llm?.apiKey, cfg.llm?.baseUrl);
    const llmClient = llmExtractor?.client ? { client: llmExtractor.client, model: llmExtractor.model } : null;

    // Shared deps for all tools
    const deps = {
      api, db, embeddings, reranker, extractor: llmClient,
      isNoise, lengthNormalizeScore, jaccardSimilarity, shouldDemote
    };

    // ============================================================
    // Register all tool modules
    // ============================================================
    recallTools.register(api, deps);
    crudTools.register(api, deps);
    statsTools.register(api, deps);
    decayTools.register(api, deps);
    kgTools.register(api, deps);
    qualityTools.register(api, deps);
    exportTools.register(api, deps);
    syncTools.register(api, deps);
    healthTools.register(api, deps);
    kbTools.register(api, deps);
    dreamingTools.register(api, deps);

    // MEMORY.md sync tool
    const syncMdTools = require("./tools/sync-memory-md");
    syncMdTools.register(api, deps);

    // ============================================================
    // Auto-capture (message_received)
    // ============================================================
    api.logger.info(`memory-lancedb-pro: autoCapture=${cfg.autoCapture}, llmExtractor=${!!llmExtractor}, reranker=${!!reranker}`);
    if (cfg.autoCapture) {
      api.on("message_received", async (event) => {
        api.logger.info(`memory-lancedb-pro: message_received FIRED! content_len=${event?.content?.length || 0}`);
        try {
          const content = event?.content;
          if (!content || typeof content !== "string") return;
          if (content.length < 20 || content.length > 2000) return;
          if (isNoise(content)) { api.logger.info(`memory-lancedb-pro: filtered noise`); return; }

          // P4: LLM classification
          let category = "user_message";
          if (llmExtractor) {
            category = await llmExtractor.classify(content);
            api.logger.info(`memory-lancedb-pro: classified as '${category}'`);
          }

          const vector = await embeddings.embed(content);
          
          // Self-evolve: lesson/error categories use addWithSelfEvolve
          const EVOLVE_CATEGORIES = ['lesson', 'error', 'correction', 'best_practice'];
          if (EVOLVE_CATEGORIES.includes(category)) {
            const result = await db.addWithSelfEvolve(content, vector, 2, category, {
              channelId: event.channelId, sessionId: event.sessionId
            });
            api.logger.info(`memory-lancedb-pro: self-evolve result: ${result.action} (${result.reason})`);
          } else {
            await db.addMemory(content, vector, 1, category, {
              channelId: event.channelId, sessionId: event.sessionId
            });
            api.logger.info(`memory-lancedb-pro: auto-captured 1 memory (category: ${category})`);
          }

          // P9: KB auto-promote
          const PROMOTE_PATTERNS = [
            /存到知识库/i, /记住这个/i, /这个记下来/i, /晋升到知识库/i,
            /把.*存到.*知识库/i, /永久记住/i, /这个很重要/i,
            /以后别再犯/i, /这个坑记一下/i
          ];
          if (PROMOTE_PATTERNS.some(p => p.test(content))) {
            try {
              api.logger.info('memory-lancedb-pro: 检测到晋升关键词，准备存知识库');
              const recentMems = await db.table.search(vector).limit(3).toArray();
              const contextText = recentMems.filter(m => m.id !== '__schema__').map(m => m.text).join('\n---\n');
              const kbText = contextText.length > 50 ? contextText : content;
              const kbVector = await embeddings.embed(kbText);
              const kbCategory = /错|坑|别再犯|教训/i.test(content) ? 'lesson' : 'fact';
              const kbId = await db.addKBEntry(kbText, kbVector, 2, kbCategory, {
                channelId: event.channelId, sessionId: event.sessionId, promotedFrom: 'auto-keyword'
              });
              api.logger.info('memory-lancedb-pro: ✅ 已晋升到知识库，ID: ' + kbId);
            } catch (err) { api.logger.warn('memory-lancedb-pro: 晋升失败: ' + String(err)); }
          }
        } catch (err) { api.logger.warn(`memory-lancedb-pro: capture failed: ${String(err)}`); }
      });
    }

    api.on("afterMessage", async (event) => {
      api.logger.info(`memory-lancedb-pro: afterMessage FIRED! event_type=${typeof event} success=${event?.success}`);
    });

    // ============================================================
    // Auto-recall (before_agent_start)
    // ============================================================
    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 15) return;
        if (shouldSkipRecall(event.prompt)) return;
        const forceRecall = shouldForceRecall(event.prompt);
        try {
          const vector = await embeddings.embed(event.prompt);
          // Fetch more candidates for better filtering
          const [kbResults, wikiResults] = await Promise.all([
            db.hybridSearchKB(vector, event.prompt, forceRecall ? 10 : 8, 0.7, 0.3, reranker),
            recallFromWiki(event.prompt, 2).catch(e => { api.logger.warn("memory-lancedb-pro: wiki recall failed: " + e.message); return []; })
          ]);
          const results = [...wikiResults, ...kbResults];
          if (results.length === 0) return;
          // KB 召回：不用 lengthNormalizeScore（过度惩罚长文本），用混合分数 + 原始相似度
          const MIN_SIM = 0.15;  // KB 条目阈值（BGE 对 markdown 格式文本的查询通常 0.15-0.30）
          const MAX_RESULTS = 3;   // 最多注入 3 条，不够就不凑数
          // 去重：用 2-gram Jaccard 去除内容重复的条目（保留最高分）
          // 去重：精确相同才合并；Jaccard 仅作为辅助判断（阈值 0.95，防误判）
          const seen = new Map();
          const uniqueResults = [];
          for (const r of results) {
            const norm = (r.text || "").toLowerCase().replace(/\s+/g, "");
            const prevIdx = seen.get(norm);
            if (prevIdx !== undefined) {
              // exact dup — keep the one with lower distance (higher similarity)
              const prev = uniqueResults[prevIdx];
              const prevDist = prev._distance ?? 999;
              const thisDist = r._distance ?? 999;
              if (thisDist < prevDist) uniqueResults[prevIdx] = r;
            } else {
              // not exact — check Jaccard against existing
              let isJaccardDup = false;
              for (const [key, idx] of seen) {
                if (key !== norm && key.length > 20 && norm.length > 20 && jaccardSimilarity(key, norm, 2) >= 0.95) {
                  isJaccardDup = true;
                  const prev = uniqueResults[idx];
                  const prevDist = prev._distance ?? 999;
                  const thisDist = r._distance ?? 999;
                  if (thisDist < prevDist) uniqueResults[idx] = r;
                  break;
                }
              }
              if (!isJaccardDup) { seen.set(norm, uniqueResults.length); uniqueResults.push(r); }
            }
          }
          const filtered = uniqueResults
            .filter(r => !isNoise(r.text))
            .filter(r => {
              const similarity = 1 - (r._distance || 0);
              return similarity < 0.9;
            })
            .map(r => {
              const rawSim = 1 - (r._distance || 0);
              const hybridScore = r._hybridScore || r._finalScore || rawSim;
              return {
                category: r.category || "other",
                source: r.source || r.category || "kb",
                text: r.text,
                _normalizedScore: Math.max(rawSim, hybridScore * 0.5)
              };
            })
            .filter(r => r._normalizedScore >= MIN_SIM)
            .sort((a, b) => b._normalizedScore - a._normalizedScore)
            .slice(0, MAX_RESULTS);  // 动态数量
          if (filtered.length === 0) return;  // 无高匹配结果，不注入（省 token）
          const catMap = {user_message:"[对话]",decision:"[决策]",fact:"[事实]",preference:"[偏好]",process:"[过程]",entity:"[实体]",concept:"[概念]",lesson:"[教训]",summary:"[总结]",other:"[参考]"};
          const ctx = filtered.map(r => {
            const isWiki = r.source === "MEMORY.md" || (r._source && r._source.includes("/"));
            const label = isWiki ? "[wiki]" : (catMap[r.category] || "[其他]");
            // Wiki authority boost: 1.5x multiplier
            if (isWiki) r._normalizedScore *= 1.5;
            return `- [${label}] ${r.text} (分:${r._normalizedScore.toFixed(2)})`;
          }).join("\n");
          const topHit = filtered[0];
          const matchedTerms = (() => { const q = query.toLowerCase(); const t = topHit.text.toLowerCase(); const words = q.split(/[\s，。,]+/).filter(w => w.length > 1); const matched = words.filter(w => t.includes(w)); return matched.slice(0, 3).join("、"); })();
          const activeHint = topHit._normalizedScore > 0.5
            ? `\n\n💡 主动提醒：匹配原因："${event.prompt}" 因为包含「${matchedTerms || "语义相关"}」匹配到 " ${topHit.text.slice(0, 30)}..."` : "";
          api.logger.info(`memory-lancedb-pro: injecting ${filtered.length} memories into context (min_sim=${MIN_SIM})`);
          return { prependContext: "\n💾 系统快照（禁止调用）：\n```\n" + ctx + "\n```\n🔚 结束" + activeHint };
        } catch (err) { api.logger.warn(`memory-lancedb-pro: recall failed: ${String(err)}`); }
      });
    }

    // ============================================================
    // Background services: decay maintenance + dreaming
    // ============================================================
    console.error('[DEBUG] About to register memory-lancedb-pro service');
    api.registerService({
      id: "memory-lancedb-pro",
      async start() {
        console.error('[DEBUG] Service start() called!');
        await db.ensureInitialized();
        api.logger.info(`memory-lancedb-pro: initialized (db: ${resolvedDbPath}, model: ${model})`);

        // ---- Decay maintenance (existing) ----
        const runMaintenance = async () => {
          try {
            const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(1000).toArray();
            const now = Date.now();
            let demoted = 0;
            for (const m of all) {
              if (m.id === "__schema__") continue;
              const newTier = shouldDemote(m, now);
              if (newTier) {
                await db.table.update(`id = '${m.id}'`, (r) => { r.tier = newTier; r.lastDecayedAt = now; return r; });
                demoted++;
              }
            }
            if (demoted > 0) api.logger.info(`memory-lancedb-pro: decay maintenance complete, ${demoted} memories demoted`);
          } catch (e) { /* silently fail, retry next run */ }
        };

        const MAINTENANCE_INTERVAL = 24 * 60 * 60 * 1000;
        const scheduleMaintenance = () => {
          setTimeout(async () => { await runMaintenance(); scheduleMaintenance(); }, MAINTENANCE_INTERVAL);
        };
        setTimeout(scheduleMaintenance, 5 * 60 * 1000);

        // ---- Dreaming service ----
        const dreamingEnabled = cfg.dreaming?.enabled;
        if (dreamingEnabled) {
          const dreamingDeps = { api, db, embeddings, extractor: llmClient, reranker };
          const dreamingFreq = cfg.dreaming?.frequency || "0 3 * * *";
          api.logger.info(`[dreaming] Scheduled (cron: ${dreamingFreq})`);
          scheduleDreaming(api, dreamingDeps, { frequency: dreamingFreq });

          // Also run a quick dream 5 minutes after startup (for testing)
          setTimeout(async () => {
            api.logger.info("[dreaming] Quick start run (5min after boot)");
            await runDreaming(dreamingDeps, { extract: true, diary: true });
          }, 5 * 60 * 1000);
        } else {
          api.logger.info("[dreaming] Disabled (set dreaming.enabled=true to enable)");
        }
      },
      async stop() { api.logger.info("memory-lancedb-pro: stopped"); }
    });
  }
};
