// tools/export.js — 导出类工具（2 个）
const { Type } = require("@sinclair/typebox");

function register(api, { db }) {
  api.registerTool({
    name: "memory_export",
    label: "Memory Export",
    description: "Export all memories as Markdown or JSON.",
    parameters: Type.Object({
      format: Type.Optional(Type.String({ default: "markdown", description: "Export format: markdown/json" })),
      category: Type.Optional(Type.String({ description: "Filter by category (optional)" }))
    }),
    async execute(_id, params) {
      const format = params?.format || 'markdown';
      const category = params?.category;
      await db.ensureInitialized();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(500).toArray();
      let memories = all.filter(m => m.id !== "__schema__");
      if (category) memories = memories.filter(m => m.category === category);
      memories.sort((a, b) => b.createdAt - a.createdAt);

      if (format === "json") {
        return {
          count: memories.length, exportedAt: new Date().toISOString(),
          memories: memories.map(m => ({
            id: m.id, text: m.text, category: m.category, tier: m.tier,
            recallCount: m.recallCount || 0, createdAt: new Date(m.createdAt).toISOString()
          }))
        };
      }

      let md = `# Memory Export\n\nExported: ${new Date().toISOString()}\nTotal: ${memories.length} memories\n\n---\n\n`;
      memories.forEach(m => {
        md += `## ${m.category} (${m.tier})\n\n${m.text}\n\n*Recalls: ${m.recallCount || 0} | Created: ${new Date(m.createdAt).toISOString()}*\n\n---\n\n`;
      });
      return { count: memories.length, markdown: md };
    }
  });

  api.registerTool({
    name: "memory_snapshot",
    label: "Memory Snapshot",
    description: "Export full memory database snapshot or restore from backup.",
    parameters: Type.Object({
      action: Type.String({ description: "Action: export or import" }),
      snapshotData: Type.Optional(Type.Any({ description: "Snapshot data for import action" }))
    }),
    async execute(_id, params) {
      const action = params?.action;
      const snapshotData = params?.snapshotData;
      await db.ensureInitialized();
      const now = Date.now();

      if (action === "export") {
        const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(5000).toArray();
        const memories = all.filter(m => m.id !== "__schema__").map(m => ({
          id: m.id, text: m.text, vector: m.vector, importance: m.importance,
          category: m.category, createdAt: m.createdAt, tier: m.tier,
          recallCount: m.recallCount || 0, lastRecalledAt: m.lastRecalledAt,
          decayShape: m.decayShape, decayScale: m.decayScale
        }));
        return { version: "1.0", exportedAt: new Date(now).toISOString(), count: memories.length, snapshot: memories };
      }

      if (action === "import" && snapshotData) {
        const memories = Array.isArray(snapshotData) ? snapshotData : snapshotData.snapshot || [];
        let imported = 0, skipped = 0;
        for (const m of memories) {
          try {
            const existing = await db.table.filter(`id = '${m.id}'`).limit(1).toArray();
            if (existing.length === 0) { await db.table.add([m]); imported++; }
            else { skipped++; }
          } catch (e) { skipped++; }
        }
        return { imported, skipped, total: memories.length };
      }

      return { error: "Invalid action or missing snapshot data" };
    }
  });
}

module.exports = { register };
