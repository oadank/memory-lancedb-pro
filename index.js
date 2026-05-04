// index.js — memory-lancedb-pro 插件入口（模块化重构版）
// 职责：初始化 → 注册所有工具 → 设置事件监听 → 启动后台服务

const { randomUUID } = require("node:crypto");
const lancedb = require("@lancedb/lancedb");

// ============================================================
// Lib imports
// ============================================================
const { MemoryDB } = require("./lib/store");
const { Embeddings } = require("./lib/embedder");
const { Reranker } = require("./lib/reranker");
const { LLMExtractor } = require("./lib/extractor");
const { isNoise, shouldForceRecall, shouldSkipRecall, ENVELOPE_PATTERNS } = require("./lib/noise-filter");
const { lengthNormalizeScore } = require("./lib/utils");
const { jaccardSimilarity } = require("./lib/utils");
const { shouldDemote } = require("./lib/decay");
const { LcmSync } = require("./lib/lcm-sync.cjs");

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
      dreaming: { type: "object" }, storageOptions: { type: "object" },
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

    // Shared deps for all tools
    const deps = {
      api, db, embeddings, reranker,
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

    // ============================================================
    // Auto-capture (message_received)
    // ============================================================
    api.logger.info(`memory-lancedb-pro: autoCapture=${cfg.autoCapture} (lcm-sync mode), autoRecall=${cfg.autoRecall}, llmExtractor=${!!llmExtractor}, reranker=${!!reranker}`);

    // ============================================================
    // LCM Sync — 从 lcm.db 读取对话对作为记忆源
    // ============================================================
    const lcmSync = new LcmSync(cfg.lcmDbPath || '/opt/openclaw/data/lcm.db', db, embeddings, {
      minContentLength: cfg.lcmMinLength || 15,
      maxTextLen: cfg.lcmMaxTextLen || 2000
    });

    // 初始全量同步（后台执行，不阻塞启动）
    (async () => {
      try {
        const added = await lcmSync.fullSync(cfg.lcmInitialLimit || 200);
        if (added > 0) api.logger.info(`memory-lancedb-pro: LCM initial sync done, ${added} memories loaded`);
      } catch (err) { api.logger.warn(`memory-lancedb-pro: LCM initial sync failed: ${err.message}`); }
      // 同步 LCM summaries 到 knowledge_base
      try {
        const kbAdded = await lcmSync.summarySync();
        if (kbAdded > 0) api.logger.info(`memory-lancedb-pro: LCM summaries synced, ${kbAdded} knowledge entries loaded`);
      } catch (err) { api.logger.warn(`memory-lancedb-pro: LCM summary sync failed: ${err.message}`); }
    })();

    // 实时同步：定期从 lcm.db 拉新对话对（每 5 分钟）
    const LCM_SYNC_INTERVAL = 5 * 60 * 1000;
    setInterval(async () => {
      try {
        const added = await lcmSync.syncLatest(3);
        if (added > 0) api.logger.info(`memory-lancedb-pro: LCM synced ${added} conversation pair(s)`);
      } catch (err) { api.logger.warn(`memory-lancedb-pro: LCM sync failed: ${err.message}`); }
    }, LCM_SYNC_INTERVAL);

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
          // 同时查 memories 和 knowledge_base
          const memResults = await db.hybridSearch(vector, event.prompt, forceRecall ? 5 : 3, 0.7, 0.3, reranker);
          const kbResults = await db.hybridSearchKB(vector, event.prompt, forceRecall ? 5 : 3, 0.7, 0.3, reranker);
          const results = [...memResults, ...kbResults];
          if (results.length === 0) return;
          const filtered = results
            .filter(r => !isNoise(r.text))
            .filter(r => {
              const similarity = 1 - (r._distance || 0);
              return similarity < 0.9;
            })
            .map(r => ({
              category: r.category || "other", text: r.text,
              _normalizedScore: lengthNormalizeScore(1 - (r._distance || 0), (r.text || "").length)
            }))
            .filter(r => r._normalizedScore >= 0.25)
            .sort((a, b) => b._normalizedScore - a._normalizedScore)
            .slice(0, 3);
          if (filtered.length === 0) return;
          const catMap = {user_message:"对话",decision:"决策",fact:"事实",preference:"偏好",process:"过程",entity:"实体",concept:"概念",other:"参考"};
          const ctx = filtered.map(r => `- [${catMap[r.category] || "其他"}] ${r.text} (分:${r._normalizedScore.toFixed(2)})`).join("\n");
          const topHit = filtered[0];
          const activeHint = topHit._normalizedScore > 0.8
            ? `\n\n💡 主动提醒：你之前提到过 "${topHit.text.slice(0, 30)}..." 相关内容` : "";
          api.logger.info(`memory-lancedb-pro: injecting ${filtered.length} memories into context`);
          return { prependContext: "\n💾 系统快照（禁止调用）：\n```\n" + ctx + "\n```\n🔚 结束" + activeHint };
        } catch (err) { api.logger.warn(`memory-lancedb-pro: recall failed: ${String(err)}`); }
      });
    }

    // ============================================================
    // Background decay maintenance daemon
    // ============================================================
    api.registerService({
      id: "memory-lancedb-pro",
      async start() {
        await db.ensureInitialized();
        api.logger.info(`memory-lancedb-pro: initialized (db: ${resolvedDbPath}, model: ${model})`);

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
      },
      async stop() { api.logger.info("memory-lancedb-pro: stopped"); }
    });
  }
};
