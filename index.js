// index.js — memory-lancedb-pro 插件入口（模块化重构版）
// 职责：初始化 → 注册所有工具 → 设置事件监听 → 启动后台服务

const { randomUUID } = require("node:crypto");
const lancedb = require("@lancedb/lancedb");

// ============================================================
// Lib imports
// ============================================================
const { MemoryDB } = require("./lib/store");
const { recallFromWikiWithVector } = require("./lib/wiki-recall.cjs");
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
        api.logger.info(`memory-lancedb-pro: before_agent_start FIRED, prompt_len=${event.prompt?.length || 0}`);
        if (!event.prompt || event.prompt.length < 15) return;
        if (shouldSkipRecall(event.prompt)) return;
        const forceRecall = shouldForceRecall(event.prompt);
        try {
          const vector = await embeddings.embed(event.prompt);
          
          // 提取用户实际消息（清洗 JSON 元数据）
          const raw = event.prompt || "";
          const msgLines = raw.split('\n').filter(l => l.trim().length > 2);
          const tsMatch = raw.match(/\[([A-Z][a-z]{2})\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(:\d{2})?\s+GMT[^\]]*\]\s*(.+)/);
          const cleanQuery = tsMatch ? tsMatch[3].trim() : msgLines[msgLines.length - 1] || raw;
          
          const [kbResults, wikiResults] = await Promise.all([
            db.hybridSearchKB(vector, event.prompt, forceRecall ? 10 : 8, 0.7, 0.3, reranker),
            recallFromWikiWithVector(vector, cleanQuery, 2).then(r => {
              api.logger.info(`memory-lancedb-pro: wiki recall returned ${r?.length || 0} results`);
              return r;
            }).catch(e => {
              api.logger.warn(`memory-lancedb-pro: wiki recall failed: ${e.message}\n${e.stack}`);
              return [];
            })
          ]);
          const results = [...wikiResults, ...kbResults];
          api.logger.info(`memory-lancedb-pro: raw results — wiki:${wikiResults.length} kb:${kbResults.length} total:${results.length}`);
          if (results.length === 0) {
            api.logger.info(`memory-lancedb-pro: no raw results, returning`);
            return;
          }

          // === 评分系统：向量 60% + jieba 关键词 40% ===
          const jieba = require("./lib/wiki-recall.cjs");
          const keywords = jieba.tokenize ? jieba.tokenize(cleanQuery) : [];
          api.logger.info(`[memory-lancedb-pro] cleanQuery: "${cleanQuery.slice(0, 80)}" keywords: ${JSON.stringify(keywords)}`);

          const MIN_COMBINED = 0.35;  // 组合分数门槛
          const MAX_RESULTS = 3;

          // 去重：按 ID 去重（不用文本，因为 KB 条目前缀可能相同）
          const seen = new Map();
          const uniqueResults = [];
          for (const r of results) {
            const id = r.id || (r.text || "").toLowerCase().replace(/\s+/g, "").slice(0, 50);
            const prevIdx = seen.get(id);
            if (prevIdx !== undefined) {
              const prev = uniqueResults[prevIdx];
              if ((r._normalizedScore || 0) > (prev._normalizedScore || 0)) uniqueResults[prevIdx] = r;
            } else { seen.set(id, uniqueResults.length); uniqueResults.push(r); }
          }

          // 统一评分：KB 条目用 0.6*inv + 0.4*kw，wiki 条目已有 _normalizedScore
          const scored = uniqueResults
            .filter(r => !isNoise(r.text))
            .map(r => {
              // Wiki 条目已有组合分数
              if (r._normalizedScore !== undefined && r.category === "wiki") return r;

              // KB 条目：重新计算
              const dist = r._distance || 0;
              const invScore = 1 / (1 + dist);

              // jieba 关键词匹配
              let matched = 0;
              const text = (r.text || "").toLowerCase();
              for (const kw of keywords) {
                if (text.includes(kw.toLowerCase())) matched++;
              }
              const kwScore = keywords.length > 0 ? matched / keywords.length : 0;
              const combined = 0.6 * invScore + 0.4 * kwScore;

              return {
                ...r,
                _normalizedScore: combined,
                _kwScore: kwScore,
                _kwMatched: matched,
                _kwTotal: keywords.length
              };
            })
            // 门槛：combined >= 0.35 且至少匹配 1 个关键词
            .filter(r => r._normalizedScore >= MIN_COMBINED && (r._kwMatched || 0) >= 1)
            .sort((a, b) => b._normalizedScore - a._normalizedScore)
            .slice(0, MAX_RESULTS);

          if (scored.length === 0) return;

          // 标签：统一单括号（label 自带 [ ]，外层不要再包）
          const catMap = {user_message:"memory",decision:"决策",fact:"事实",preference:"偏好",process:"过程",entity:"实体",concept:"概念",lesson:"教训",summary:"总结",other:"参考"};
          const ctx = scored.map(r => {
            // source=MEMORY.md 的条目标 [memory]，wiki vault 的标 [wiki]
            const isMemoryMd = r.source === "MEMORY.md" && !r._source;
            const isWiki = r.category === "wiki" || (r._source && r._source.includes("/"));
            const label = isWiki ? "wiki" : (isMemoryMd ? "memory" : (catMap[r.category] || "其他"));
            return `- [${label}] ${r.text} (分:${r._normalizedScore.toFixed(2)})`;
          }).join("\n");

          api.logger.info(`memory-lancedb-pro: recall sources — ${scored.map(r => {
            const isWiki = r.category === "wiki" || (r._source && r._source.includes("/"));
            const isMemoryMd = r.source === "MEMORY.md" && !r._source;
            return isWiki ? 'wiki:' + r._source : isMemoryMd ? 'memory:' + r.category : 'kb:' + r.category;
          }).join(', ')} (kw: ${keywords.slice(0,6).join('/')})`);
          api.logger.info(`memory-lancedb-pro: injecting ${scored.length} memories into context (min=${MIN_COMBINED})`);
          return { prependContext: "\n💾 系统快照（禁止调用）：\n```\n" + ctx + "\n```\n🔚 结束" };
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
