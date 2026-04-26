// tools/decay-tools.js — 衰减维护工具（2 个）
const { Type } = require("@sinclair/typebox");

function register(api, { db, embeddings, shouldDemote }) {
  api.registerTool({
    name: "memory_run_decay_maintenance",
    label: "Memory Decay Maintenance",
    description: "Run temporal decay and tier demotion maintenance on all memories.",
    parameters: Type.Object({}),
    async execute() {
      await db.ensureInitialized();
      const now = Date.now();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(1000).toArray();
      let decayed = 0, demoted = 0;
      for (const m of all) {
        if (m.id === "__schema__") continue;
        try {
          const newTier = shouldDemote(m, now);
          const updates = { lastDecayedAt: now };
          if (newTier) { updates.tier = newTier; demoted++; }
          await db.table.update(
            (record) => record.id === m.id,
            () => updates
          );
          decayed++;
        } catch (e) {}
      }
      return { processed: decayed, demoted, ok: true };
    }
  });

  api.registerTool({
    name: "memory_run_forgetting",
    label: "Intelligent Forgetting",
    description: "Auto-clean low-value memories: peripheral tier + >30 days old + <3 recalls.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ default: true, description: "If true, only list what would be deleted, don't actually delete" }))
    }),
    async execute(_id, params) {
      const dryRun = params?.dryRun !== false;
      await db.ensureInitialized();
      const now = Date.now();
      const cutoff = now - 30 * 24 * 60 * 60 * 1000;
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(500).toArray();
      const toForget = all.filter(m =>
        m.id !== "__schema__" && m.tier === "peripheral" && m.createdAt < cutoff && (m.recallCount || 0) < 3
      );
      if (!dryRun && toForget.length > 0) {
        for (const m of toForget) { try { await db.table.delete(`id = '${m.id}'`); } catch (e) {} }
      }
      return {
        wouldDelete: toForget.length, dryRun, deleted: dryRun ? 0 : toForget.length,
        memories: toForget.map(m => ({ id: m.id, text: m.text.slice(0, 100), ageDays: Math.round((now - m.createdAt) / (24 * 60 * 60 * 1000)) }))
      };
    }
  });
}

module.exports = { register };
