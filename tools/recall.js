// tools/recall.js — 召回类工具
const { Type } = require("@sinclair/typebox");

function register(api, { db, embeddings, reranker, isNoise, lengthNormalizeScore }) {
  api.registerTool({
    name: "memory_recall",
    label: "Memory Recall",
    description: "Search through long-term memories using hybrid vector + BM25 search.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" }))
    }),
    async execute(_id, params) {
      const query = params?.query || '';
      const limit = params?.limit || 5;
      const vector = await embeddings.embed(query);
      const [memResults, kbResults] = await Promise.all([
        db.hybridSearch(vector, query, limit),
        db.hybridSearchKB(vector, query, limit)
      ]);
      const allResults = [
        ...memResults.map(r => ({ ...r, _source: '对话记忆' })),
        ...kbResults.map(r => {
          const score = r._finalScore || r._hybridScore || 0;
          return { ...r, _source: '永久知识库', _hybridScore: score * 1.1, _finalScore: score * 1.1 };
        })
      ].sort((a, b) => (b._hybridScore || b._finalScore || 0) - (a._hybridScore || a._finalScore || 0))
       .slice(0, limit);
      return {
        memories: allResults.map(r => ({
          id: r.id, text: r.text, category: r.category,
          importance: r.importance, createdAt: r.createdAt, source: r._source
        }))
      };
    }
  });

  api.registerTool({
    name: "memory_bm25_search",
    label: "Memory BM25 Search",
    description: "Full-text search through long-term memories (BM25).",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      limit: Type.Optional(Type.Number({ description: "Max results (default: 5)" }))
    }),
    async execute(_id, params) {
      const query = params?.query || '';
      const limit = params?.limit || 5;
      const results = await db.bm25Search(query, limit);
      return {
        memories: results.map(r => ({
          id: r.id, text: r.text, category: r.category,
          importance: r.importance, createdAt: r.createdAt
        }))
      };
    }
  });

  api.registerTool({
    name: "memory_advanced_search",
    label: "Advanced Memory Search",
    description: "Search memories with keyword, time range, and category filters.",
    parameters: Type.Object({
      keyword: Type.Optional(Type.String({ description: "Keyword to search in memory text" })),
      category: Type.Optional(Type.String({ description: "Category filter: preference/decision/fact/entity/concept/process/user_message" })),
      hours: Type.Optional(Type.Number({ description: "Only recall memories from last N hours" })),
      limit: Type.Optional(Type.Number({ default: 5, description: "Max number of results" }))
    }),
    async execute(_id, params) {
      const keyword = params?.keyword;
      const category = params?.category;
      const hours = params?.hours;
      const limit = params?.limit || 5;
      await db.ensureInitialized();
      const now = Date.now();
      const cutoff = hours ? now - hours * 60 * 60 * 1000 : 0;
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(100).toArray();
      let filtered = all.filter(m => m.id !== "__schema__");
      if (category) filtered = filtered.filter(m => m.category === category);
      if (cutoff > 0) filtered = filtered.filter(m => m.createdAt >= cutoff);
      if (keyword) {
        const kw = keyword.toLowerCase();
        filtered = filtered.filter(m => m.text.toLowerCase().includes(kw));
      }
      filtered.sort((a, b) => b.createdAt - a.createdAt);
      return filtered.slice(0, limit).map(m => ({
        id: m.id, text: m.text, category: m.category, tier: m.tier,
        recallCount: m.recallCount || 0, createdAt: new Date(m.createdAt).toISOString()
      }));
    }
  });
}

module.exports = { register };
