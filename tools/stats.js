// tools/stats.js — 统计类工具（3 个）
const { Type } = require("@sinclair/typebox");

function register(api, { db, embeddings, jaccardSimilarity, lengthNormalizeScore }) {
  api.registerTool({
    name: "memory_db_stats",
    label: "Memory Stats",
    description: "Show memory database statistics including tier distribution.",
    parameters: Type.Object({}),
    async execute() {
      await db.ensureInitialized();
      const count = await db.table.countRows();
      let peripheral = 0, working = 0, core = 0;
      try {
        const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(1000).toArray();
        for (const m of all) {
          if (m.tier === "core") core++;
          else if (m.tier === "working") working++;
          else peripheral++;
        }
      } catch (e) {}
      return { totalMemories: count, ftsEnabled: db.ftsReady, dbPath: db.dbPath, tiers: { peripheral, working, core } };
    }
  });

  api.registerTool({
    name: "memory_dashboard",
    label: "Memory Dashboard",
    description: "Full memory health analysis: tier distribution, recall stats, decay timeline, quality scores.",
    parameters: Type.Object({}),
    async execute() {
      await db.ensureInitialized();
      const now = Date.now();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(1000).toArray();
      const memories = all.filter(m => m.id !== "__schema__");
      const tiers = { peripheral: 0, working: 0, core: 0 };
      let totalRecalls = 0;
      const quality = { excellent: 0, good: 0, average: 0, poor: 0 };
      const ages = { "<1h": 0, "1h-1d": 0, "1d-1w": 0, ">1w": 0 };
      memories.forEach(m => {
        tiers[m.tier || "peripheral"]++;
        totalRecalls += m.recallCount || 0;
        const tierMultiplier = m.tier === "core" ? 1.5 : m.tier === "working" ? 1.2 : 1.0;
        const q = (m.importance || 1) * tierMultiplier;
        if (q >= 2.5) quality.excellent++;
        else if (q >= 1.8) quality.good++;
        else if (q >= 1.2) quality.average++;
        else quality.poor++;
        const ageHours = (now - m.createdAt) / (1000 * 60 * 60);
        if (ageHours < 1) ages["<1h"]++;
        else if (ageHours < 24) ages["1h-1d"]++;
        else if (ageHours < 168) ages["1d-1w"]++;
        else ages[">1w"]++;
      });
      return {
        total: memories.length, tiers,
        avgRecalls: memories.length > 0 ? Math.round(totalRecalls / memories.length * 10) / 10 : 0,
        quality, ageDistribution: ages,
        lastMaintenance: memories.length > 0 ? new Date(Math.max(...memories.map(m => m.lastDecayedAt || 0))).toISOString() : null
      };
    }
  });

  api.registerTool({
    name: "memory_explain_rank",
    label: "Explain Memory Ranking",
    description: "Explain why a specific memory ranked high for a query.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      memoryId: Type.String({ description: "Memory ID to explain" })
    }),
    async execute(_id, params) {
      await db.ensureInitialized();
      const vector = await embeddings.embed(params?.query || '');
      const searchResults = await db.table.search(vector).limit(50).toArray();
      const mem = searchResults.find(m => m.id.startsWith(params?.memoryId || ''));
      if (!mem) return { error: `Memory not found in search results: ${params?.memoryId}` };
      const similarity = 1 - (mem._distance || 0.5);
      const explanations = [];
      if (similarity > 0.8) explanations.push(`向量相似度高 (${(similarity * 100).toFixed(1)}%)，与查询词高度相关`);
      else if (similarity > 0.6) explanations.push(`向量相似度中等 (${(similarity * 100).toFixed(1)}%)，部分语义重叠`);
      else explanations.push(`向量相似度较低 (${(similarity * 100).toFixed(1)}%)，可能通过 BM25 补充`);
      if (mem.importance >= 3) explanations.push('重要性高（3/3），核心记忆');
      else if (mem.importance >= 2) explanations.push('重要性中等（2/3），工作记忆');
      if (mem.recallCount > 5) explanations.push(`被召回 ${mem.recallCount} 次，频繁使用`);
      if (mem.tier === 'core') explanations.push('已晋升到 core 层级，长期保留');
      if (mem.text && params?.query) {
        const textOverlap = jaccardSimilarity(mem.text, params.query);
        if (textOverlap > 0.1) explanations.push(`文本关键词重叠率 ${(textOverlap * 100).toFixed(1)}%`);
      }
      return {
        memoryId: mem.id, text: mem.text.slice(0, 100),
        similarity: similarity.toFixed(3), importance: mem.importance,
        tier: mem.tier || 'peripheral', recallCount: mem.recallCount || 0, explanations
      };
    }
  });
}

module.exports = { register };
