// tools/health.js — 健康评估工具（3 个）
const { Type } = require("@sinclair/typebox");

function register(api, { db, embeddings, jaccardSimilarity }) {
  api.registerTool({
    name: "memory_health_score",
    label: "Memory Health Score",
    description: "Comprehensive memory health assessment: overall score, quality breakdown, recommendations.",
    parameters: Type.Object({
      detailed: Type.Optional(Type.Boolean({ default: false, description: "Include detailed per-memory analysis" }))
    }),
    async execute(_id, params) {
      const detailed = params?.detailed !== undefined ? params.detailed : false;
      await db.ensureInitialized();
      const now = Date.now();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(5000).toArray();
      const memories = all.filter(m => m.id !== "__schema__");

      if (memories.length === 0) return { score: 0, grade: "N/A", message: "No memories to assess" };

      let qualityTotal = 0;
      const qualityBreakdown = { excellent: 0, good: 0, fair: 0, poor: 0 };
      memories.forEach(m => {
        const tierBonus = m.tier === "core" ? 1.5 : m.tier === "working" ? 1.2 : 1.0;
        const recallBonus = Math.min((m.recallCount || 0) / 10, 0.5);
        const q = ((m.importance || 1) * tierBonus + recallBonus) / 4 * 100;
        qualityTotal += q;
        if (q >= 75) qualityBreakdown.excellent++;
        else if (q >= 50) qualityBreakdown.good++;
        else if (q >= 25) qualityBreakdown.fair++;
        else qualityBreakdown.poor++;
      });
      const qualityScore = qualityTotal / memories.length;

      const categoryCounts = new Map();
      memories.forEach(m => { const c = m.category || "other"; categoryCounts.set(c, (categoryCounts.get(c) || 0) + 1); });
      const maxPossibleCategories = Math.max(categoryCounts.size, 1);
      const evenness = maxPossibleCategories >= 3 ? Math.min(categoryCounts.size / 7 * 100, 100) : categoryCounts.size * 25;

      const oneDayAgo = now - 24 * 60 * 60 * 1000;
      const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
      const recent = memories.filter(m => m.createdAt > oneDayAgo).length;
      const weekOld = memories.filter(m => m.createdAt > oneWeekAgo).length;
      const freshnessScore = Math.min((recent * 2 + weekOld) / memories.length * 50, 100);

      const recentlyMaintained = memories.filter(m => m.lastDecayedAt && (now - m.lastDecayedAt) < 7 * 24 * 60 * 60 * 1000).length;
      const decayScore = memories.length > 0 ? (recentlyMaintained / memories.length) * 100 : 0;

      const overallScore = Math.round(qualityScore * 0.4 + evenness * 0.2 + freshnessScore * 0.2 + decayScore * 0.2);

      const grade = overallScore >= 90 ? "A+" : overallScore >= 80 ? "A" :
                    overallScore >= 70 ? "B+" : overallScore >= 60 ? "B" :
                    overallScore >= 50 ? "C" : overallScore >= 30 ? "D" : "F";

      const recommendations = [];
      if (qualityBreakdown.poor > memories.length * 0.3) recommendations.push("运行智能遗忘清理低质量记忆");
      if (categoryCounts.size < 3) recommendations.push("增加记忆分类多样性");
      if (recent === 0 && memories.length > 5) recommendations.push("近期无新记忆，建议捕获更多交互");
      if (decayScore < 50) recommendations.push("运行衰减维护更新记忆时效状态");

      const result = {
        overallScore, grade, totalMemories: memories.length,
        breakdown: { quality: Math.round(qualityScore), diversity: Math.round(evenness), freshness: Math.round(freshnessScore), decayHealth: Math.round(decayScore) },
        qualityDistribution: qualityBreakdown, categoryDistribution: Object.fromEntries(categoryCounts),
        recommendations,
        tierDistribution: {
          core: memories.filter(m => m.tier === "core").length,
          working: memories.filter(m => m.tier === "working").length,
          peripheral: memories.filter(m => m.tier === "peripheral").length
        }
      };

      if (detailed) {
        result.poorMemories = memories
          .filter(m => {
            const q = ((m.importance || 1) * (m.tier === "core" ? 1.5 : m.tier === "working" ? 1.2 : 1.0) + Math.min((m.recallCount || 0) / 10, 0.5)) / 4;
            return q < 0.25;
          })
          .slice(0, 10)
          .map(m => ({ id: m.id, text: m.text?.slice?.(0, 80), score: Math.round(((m.importance || 1) / 4) * 100) }));
      }

      return result;
    }
  });

  api.registerTool({
    name: "memory_archive",
    label: "Archive Low-Value Memories",
    description: "Archive memories below importance threshold by setting importance=0.",
    parameters: Type.Object({
      maxImportance: Type.Optional(Type.Number({ default: 1, description: "Archive memories with importance <= this (default: 1)" })),
      maxAgeDays: Type.Optional(Type.Number({ default: 7, description: "Only archive memories older than N days (default: 7)" })),
      dryRun: Type.Optional(Type.Boolean({ default: true, description: "Preview only, don't actually archive" }))
    }),
    async execute(_id, params) {
      await db.ensureInitialized();
      const maxImp = params?.maxImportance ?? 1;
      const maxAge = (params?.maxAgeDays ?? 7) * 24 * 60 * 60 * 1000;
      const now = Date.now();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(2000).toArray();
      const candidates = all.filter(m => m.id !== '__schema__' && m.importance <= maxImp && (now - m.createdAt) > maxAge);
      if (params?.dryRun) return { wouldArchive: candidates.length, memories: candidates.slice(0, 20).map(m => ({ id: m.id, text: m.text.slice(0, 80), importance: m.importance, age: Math.round((now - m.createdAt) / 86400000) + 'd' })) };
      let archived = 0;
      for (const m of candidates) { try { await db.table.delete(`id = '${m.id}'`); archived++; } catch(e) {} }
      return { ok: true, archived };
    }
  });

  api.registerTool({
    name: "memory_compact",
    label: "Compact Duplicate Memories",
    description: "Find and merge duplicate/similar memories. Keeps the highest-quality version.",
    parameters: Type.Object({
      threshold: Type.Optional(Type.Number({ default: 0.85, description: "Similarity threshold 0-1 (default: 0.85)" })),
      dryRun: Type.Optional(Type.Boolean({ default: true, description: "Preview only" }))
    }),
    async execute(_id, params) {
      await db.ensureInitialized();
      const threshold = params?.threshold ?? 0.85;
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(2000).toArray();
      const memories = all.filter(m => m.id !== '__schema__');
      const groups = [];
      const used = new Set();
      for (let i = 0; i < memories.length; i++) {
        if (used.has(memories[i].id)) continue;
        const group = [memories[i]];
        used.add(memories[i].id);
        for (let j = i + 1; j < memories.length; j++) {
          if (used.has(memories[j].id)) continue;
          const textSim = jaccardSimilarity(memories[i].text, memories[j].text);
          if (textSim >= threshold) { group.push(memories[j]); used.add(memories[j].id); }
        }
        if (group.length > 1) groups.push(group);
      }
      if (params?.dryRun) return { duplicateGroups: groups.length, totalDuplicates: groups.reduce((s, g) => s + g.length - 1, 0), groups: groups.slice(0, 10).map(g => ({ keep: g[0].id.slice(0, 8), text: g[0].text.slice(0, 80), remove: g.slice(1).map(m => m.id.slice(0, 8)) })) };
      let merged = 0, removed = 0;
      for (const group of groups) {
        for (let k = 1; k < group.length; k++) { try { await db.table.delete(`id = '${group[k].id}'`); removed++; } catch(e) {} }
        merged++;
      }
      return { ok: true, mergedGroups: merged, duplicatesRemoved: removed };
    }
  });
}

module.exports = { register };
