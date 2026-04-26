// tools/knowledge-graph.js — 知识图谱/时间线/摘要工具（3 个）
const { Type } = require("@sinclair/typebox");

function register(api, { db }) {
  api.registerTool({
    name: "memory_build_knowledge_graph",
    label: "Build Knowledge Graph",
    description: "Extract entities, relationships, and connections from all memories to build a knowledge graph.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ default: 100, description: "Max memories to process" })),
      category: Type.Optional(Type.String({ description: "Filter by category (optional)" }))
    }),
    async execute(_id, params) {
      const limit = params?.limit || 100;
      const category = params?.category;
      await db.ensureInitialized();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(limit).toArray();
      let memories = all.filter(m => m.id !== "__schema__");
      if (category) memories = memories.filter(m => m.category === category);

      const entities = new Map();
      const relations = [];
      const NAME_PATTERN = /(?:我|你|他|她|它|我们|你们|他们|橙子|阿丹|老大|老板|大佬)[的\s]*([^\s，。！？；："']{2,8})/g;
      const TECH_PATTERN = /(LanceDB|OpenClaw|memory|向量|记忆|插件|API|LLM|AI|P[0-9])/gi;

      memories.forEach((m, i) => {
        const text = m.text;
        let match;
        while ((match = TECH_PATTERN.exec(text)) !== null) {
          const name = match[1].toLowerCase();
          if (!entities.has(name)) {
            entities.set(name, { name: match[1], type: "technology", count: 0, memories: [] });
          }
          const e = entities.get(name);
          e.count++;
          if (!e.memories.includes(m.id)) e.memories.push(m.id);
        }
        const techInThisMem = [...new Set(text.match(TECH_PATTERN) || [])].map(t => t.toLowerCase());
        for (let a = 0; a < techInThisMem.length; a++) {
          for (let b = a + 1; b < techInThisMem.length; b++) {
            relations.push({ from: techInThisMem[a], to: techInThisMem[b], type: "co-occurrence", memoryId: m.id });
          }
        }
      });

      const nodeScores = new Map();
      entities.forEach((_, name) => nodeScores.set(name, 1));
      for (let iter = 0; iter < 10; iter++) {
        const newScores = new Map(nodeScores);
        relations.forEach(r => {
          const transfer = nodeScores.get(r.from) * 0.15;
          newScores.set(r.to, (newScores.get(r.to) || 0) + transfer);
        });
        nodeScores.clear();
        newScores.forEach((v, k) => nodeScores.set(k, v));
      }

      const entityList = [...entities.values()].map(e => ({
        ...e, importance: nodeScores.get(e.name.toLowerCase()) || 1
      })).sort((a, b) => b.importance - a.importance);

      return {
        entities: entityList.slice(0, 50), relations: relations.slice(0, 100),
        totalMemories: memories.length, totalEntities: entities.size, totalRelations: relations.length
      };
    }
  });

  api.registerTool({
    name: "memory_summarize_topic",
    label: "Summarize Topic",
    description: "Merge all memories related to a keyword into a single concise summary.",
    parameters: Type.Object({
      keyword: Type.String({ description: "Topic keyword to summarize" }),
      maxMemories: Type.Optional(Type.Number({ default: 20, description: "Max memories to include" }))
    }),
    async execute(_id, params) {
      const keyword = params?.keyword;
      const maxMemories = params?.maxMemories || 20;
      await db.ensureInitialized();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(100).toArray();
      const kw = keyword.toLowerCase();
      const related = all.filter(m => m.id !== "__schema__" && m.text.toLowerCase().includes(kw))
        .sort((a, b) => b.createdAt - a.createdAt).slice(0, maxMemories);

      if (related.length === 0) return { found: 0, summary: "No related memories found." };

      const lines = new Set();
      related.forEach(m => {
        m.text.split(/\n/).forEach(line => {
          const trimmed = line.trim();
          if (trimmed.length > 10 && !trimmed.startsWith("---")) lines.add(trimmed);
        });
      });

      return {
        found: related.length, keyword,
        timespan: { from: new Date(related[related.length - 1].createdAt).toISOString(), to: new Date(related[0].createdAt).toISOString() },
        summary: [...lines].join("\n\n").slice(0, 5000)
      };
    }
  });

  api.registerTool({
    name: "memory_timeline",
    label: "Memory Timeline",
    description: "View the evolution of a topic over time, ordered chronologically.",
    parameters: Type.Object({
      keyword: Type.String({ description: "Topic keyword to track" }),
      maxEntries: Type.Optional(Type.Number({ default: 20, description: "Max timeline entries" }))
    }),
    async execute(_id, params) {
      const keyword = params?.keyword;
      const maxEntries = params?.maxEntries || 20;
      await db.ensureInitialized();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(100).toArray();
      const kw = keyword.toLowerCase();
      const related = all.filter(m => m.id !== "__schema__" && m.text.toLowerCase().includes(kw))
        .sort((a, b) => a.createdAt - b.createdAt).slice(0, maxEntries);

      if (related.length === 0) return { found: 0, timeline: [] };

      return {
        found: related.length, keyword,
        timeline: related.map((m, i) => ({
          step: i + 1, date: new Date(m.createdAt).toISOString(),
          tier: m.tier, recallCount: m.recallCount || 0, content: m.text.slice(0, 200)
        }))
      };
    }
  });
}

module.exports = { register };
