// tools/sync.js — 同步/迁移工具（3 个）
const { Type } = require("@sinclair/typebox");

function register(api, { db }) {
  const lancedb = require("@lancedb/lancedb");

  api.registerTool({
    name: "memory_sync_sessions",
    label: "Memory Session Sync",
    description: "Sync memories across sessions/devices. Export current DB state for import elsewhere, or import an external sync package.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ default: "status", description: "Mode: export | import | status" })),
      syncData: Type.Optional(Type.Any({ description: "Sync package data for import command" })),
      mergeStrategy: Type.Optional(Type.String({ default: "newer", description: "Merge strategy for conflicts: newer | both" }))
    }),
    async execute(_id, params) {
      const mode = params?.mode || "status";
      const syncData = params?.syncData;
      const mergeStrategy = params?.mergeStrategy || "newer";
      await db.ensureInitialized();
      const now = Date.now();

      if (mode === "status") {
        const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(5000).toArray();
        const memories = all.filter(m => m.id !== "__schema__");
        const sessions = new Map();
        memories.forEach(m => {
          const sid = m.sessionId || "unknown";
          if (!sessions.has(sid)) sessions.set(sid, { sessionId: sid, count: 0, latest: 0, earliest: Infinity });
          const s = sessions.get(sid);
          s.count++;
          if (m.createdAt > s.latest) s.latest = m.createdAt;
          if (m.createdAt < s.earliest) s.earliest = m.createdAt;
        });
        return {
          totalMemories: memories.length, sessionCount: sessions.size,
          sessions: [...sessions.values()].map(s => ({
            ...s, earliest: new Date(s.earliest).toISOString(), latest: new Date(s.latest).toISOString()
          })).sort((a, b) => b.count - a.count)
        };
      }

      if (mode === "export") {
        const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(5000).toArray();
        const memories = all.filter(m => m.id !== "__schema__").map(m => ({
          id: m.id, text: m.text, vector: m.vector, importance: m.importance,
          category: m.category, createdAt: m.createdAt, tier: m.tier,
          recallCount: m.recallCount || 0, lastRecalledAt: m.lastRecalledAt,
          decayShape: m.decayShape, decayScale: m.decayScale,
          sessionId: m.sessionId, channelId: m.channelId
        }));
        return { version: "1.0", type: "sync-export", exportedAt: new Date(now).toISOString(), count: memories.length, syncData: memories };
      }

      if (mode === "import" && syncData) {
        const memories = Array.isArray(syncData) ? syncData : syncData.syncData || [];
        let imported = 0, skipped = 0, updated = 0;
        for (const m of memories) {
          try {
            const existing = await db.table.filter(`id = '${m.id}'`).limit(1).toArray();
            if (existing.length === 0) { await db.table.add([m]); imported++; }
            else if (mergeStrategy === "newer" && m.createdAt > (existing[0].createdAt || 0)) { await db.table.update(`id = '${m.id}'`, () => m); updated++; }
            else { skipped++; }
          } catch (e) { skipped++; }
        }
        return { imported, updated, skipped, total: memories.length };
      }

      return { error: "Invalid mode or missing data" };
    }
  });

  api.registerTool({
    name: "memory_share_package",
    label: "Memory Share Package",
    description: "Create or import a shareable memory bundle. Supports category filtering and optional notes.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ default: "create", description: "Mode: create | import" })),
      packageData: Type.Optional(Type.Any({ description: "Package data for import" })),
      categories: Type.Optional(Type.Array(Type.String(), { description: "Categories to include (create only)" })),
      note: Type.Optional(Type.String({ description: "Optional note attached to the package" }))
    }),
    async execute(_id, params) {
      const mode = params?.mode || "create";
      const packageData = params?.packageData;
      const categories = params?.categories;
      const note = params?.note;
      await db.ensureInitialized();

      if (mode === "create") {
        const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(500).toArray();
        let memories = all.filter(m => m.id !== "__schema__");
        if (categories && categories.length > 0) memories = memories.filter(m => categories.includes(m.category));
        return {
          version: "1.0", type: "share-package", createdAt: new Date().toISOString(),
          count: memories.length, note: note || "",
          package: memories.map(m => ({
            id: m.id, text: m.text, category: m.category, importance: m.importance,
            tier: m.tier, recallCount: m.recallCount || 0, createdAt: m.createdAt
          }))
        };
      }

      if (mode === "import" && packageData) {
        const memories = packageData.package || packageData;
        const memList = Array.isArray(memories) ? memories : [];
        let imported = 0, skipped = 0;
        for (const m of memList) {
          try {
            const existing = await db.table.filter(`id = '${m.id}'`).limit(1).toArray();
            if (existing.length === 0) {
              await db.table.add([{
                id: m.id, text: m.text, vector: Array(db.vectorDim).fill(0),
                importance: m.importance || 1, category: m.category || "other",
                createdAt: m.createdAt || Date.now(), tier: m.tier || "peripheral",
                recallCount: m.recallCount || 0, lastRecalledAt: m.createdAt || Date.now(),
                lastDecayedAt: Date.now(), decayShape: 1.0, decayScale: 30 * 24 * 60 * 60 * 1000
              }]);
              imported++;
            } else { skipped++; }
          } catch (e) { skipped++; }
        }
        return { imported, skipped, total: memList.length, note: packageData.note || "" };
      }

      return { error: "Invalid mode or missing data" };
    }
  });

  api.registerTool({
    name: "memory_migrate_from_core",
    label: "Migrate from Memory Core",
    description: "Import memories from the legacy memory-core plugin database.",
    parameters: Type.Object({
      sourceDbPath: Type.Optional(Type.String({ description: "Path to legacy memory-core LanceDB (default: auto-detect)" })),
      dryRun: Type.Optional(Type.Boolean({ default: true, description: "Preview migration without importing" }))
    }),
    async execute(_id, params) {
      const sourceDbPath = params?.sourceDbPath;
      const dryRun = params?.dryRun !== false;
      await db.ensureInitialized();

      const legacyPaths = [
        sourceDbPath,
        api.resolvePath("~/.openclaw/memory/lancedb"),
        "/root/.openclaw/memory/lancedb",
        process.env.HOME + "/.openclaw/memory/lancedb"
      ].filter(Boolean);

      let legacyTable = null, foundPath = null;
      for (const lp of legacyPaths) {
        try {
          const { statSync } = await import("fs");
          statSync(lp.replace("~", process.env.HOME));
          const legacyDb = await lancedb.connect(lp);
          const tables = await legacyDb.tableNames();
          if (tables.length > 0) { legacyTable = await legacyDb.openTable(tables[0]); foundPath = lp; break; }
        } catch (e) { /* try next */ }
      }

      if (!legacyTable) return { found: false, searched: legacyPaths, message: "No legacy memory-core database found" };

      const legacy = await legacyTable.search(Array(db.vectorDim).fill(0)).limit(5000).toArray();
      const legacyMemories = legacy.filter(m => m.id !== "__schema__");
      const currentAll = await db.table.search(Array(db.vectorDim).fill(0)).limit(5000).toArray();
      const existingIds = new Set(currentAll.map(m => m.id));
      const toMigrate = legacyMemories.filter(m => !existingIds.has(m.id));

      if (dryRun) {
        return {
          found: true, sourcePath: foundPath, legacy_total: legacyMemories.length,
          newCount: toMigrate.length, alreadyExists: legacyMemories.length - toMigrate.length,
          dryRun: true, sampleMemories: toMigrate.slice(0, 3).map(m => m.text?.slice?.(0, 100) || m.text)
        };
      }

      let imported = 0, skipped = 0;
      for (const m of toMigrate) {
        try {
          await db.table.add([{
            id: m.id, text: m.text || m.content || "", vector: m.vector || Array(db.vectorDim).fill(0),
            importance: m.importance || 1, category: m.category || "user_message",
            createdAt: m.createdAt || Date.now(), tier: "peripheral", recallCount: m.recallCount || 0,
            lastRecalledAt: m.lastRecalledAt || Date.now(), lastDecayedAt: Date.now(),
            decayShape: 1.0, decayScale: 30 * 24 * 60 * 60 * 1000,
            sessionId: m.sessionId, channelId: m.channelId, migratedFrom: "memory-core"
          }]);
          imported++;
        } catch (e) { skipped++; }
      }

      return { found: true, sourcePath: foundPath, imported, skipped, total: toMigrate.length };
    }
  });
}

module.exports = { register };
