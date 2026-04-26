// tools/quality.js — 质量控制工具（3 个）
const { Type } = require("@sinclair/typebox");

function register(api, { db, embeddings, jaccardSimilarity }) {
  api.registerTool({
    name: "memory_align",
    label: "Memory Alignment",
    description: "Correct/update an existing memory when AI got it wrong.",
    parameters: Type.Object({
      memoryId: Type.String({ description: "ID of the memory to correct" }),
      correctedText: Type.String({ description: "Corrected memory content" }),
      reason: Type.Optional(Type.String({ description: "Reason for correction" }))
    }),
    async execute(_id, params) {
      const memoryId = params?.memoryId;
      const correctedText = params?.correctedText;
      const reason = params?.reason;
      await db.ensureInitialized();
      const now = Date.now();
      try {
        await db.table.update(
          (record) => record.id === memoryId,
          (record) => ({
            text: correctedText,
            lastRecalledAt: now,
            recallCount: (record.recallCount || 0) + 1
          })
        );
        api.logger.info(`memory-lancedb-pro: memory ${memoryId} corrected (reason: ${reason || 'manual'})`);
        return { success: true, memoryId, corrected: true };
      } catch (e) {
        return { success: false, error: String(e) };
      }
    }
  });

  api.registerTool({
    name: "memory_detect_conflicts",
    label: "Detect Memory Conflicts",
    description: "Find conflicting memories about the same topic.",
    parameters: Type.Object({
      threshold: Type.Optional(Type.Number({ default: 0.7, description: "Similarity threshold for conflict detection" })),
      limit: Type.Optional(Type.Number({ default: 50, description: "Max memories to scan" }))
    }),
    async execute(_id, params) {
      const threshold = params?.threshold || 0.7;
      const limit = params?.limit || 50;
      await db.ensureInitialized();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(limit).toArray();
      const memories = all.filter(m => m.id !== "__schema__");
      const conflicts = [];
      const OPPOSITE_PAIRS = [
        ["喜欢", "讨厌"], ["支持", "反对"], ["正确", "错误"],
        ["完成", "未完成"], ["有", "没有"], ["是", "不是"]
      ];
      for (let i = 0; i < memories.length; i++) {
        for (let j = i + 1; j < memories.length; j++) {
          const m1 = memories[i];
          const m2 = memories[j];
          const sharedKeywords = OPPOSITE_PAIRS.filter(([a, b]) =>
            (m1.text.includes(a) && m2.text.includes(b)) ||
            (m1.text.includes(b) && m2.text.includes(a))
          );
          if (sharedKeywords.length > 0) {
            conflicts.push({
              memory1: { id: m1.id, text: m1.text.slice(0, 100), date: new Date(m1.createdAt).toISOString() },
              memory2: { id: m2.id, text: m2.text.slice(0, 100), date: new Date(m2.createdAt).toISOString() },
              conflictingKeywords: sharedKeywords.map(p => p.join('/')),
              suggestion: "Latest memory is likely correct, consider deleting or correcting the older one"
            });
          }
        }
      }
      return { scanned: memories.length, conflictsFound: conflicts.length, conflicts };
    }
  });

  api.registerTool({
    name: "memory_auto_cleanup",
    label: "Memory Auto Cleanup",
    description: "Automatically clean up duplicate and low-quality memories.",
    parameters: Type.Object({
      mode: Type.Optional(Type.String({ default: "report", description: "Mode: report | delete" })),
      similarityThreshold: Type.Optional(Type.Number({ default: 0.92, description: "Text similarity threshold for duplicate detection (0-1)" })),
      minRecalls: Type.Optional(Type.Number({ default: 1, description: "Minimum recalls to keep a memory" }))
    }),
    async execute(_id, params) {
      const mode = params?.mode || "report";
      const similarityThreshold = params?.similarityThreshold !== undefined ? params.similarityThreshold : 0.92;
      const minRecalls = params?.minRecalls !== undefined ? params.minRecalls : 1;
      await db.ensureInitialized();
      const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(5000).toArray();
      const memories = all.filter(m => m.id !== "__schema__");

      const duplicates = [];
      const toDeleteIds = new Set();

      for (let i = 0; i < memories.length; i++) {
        if (toDeleteIds.has(memories[i].id)) continue;
        const textA = (memories[i].text || "").toLowerCase();
        const wordsA = new Set(textA.split(/\s+/));
        for (let j = i + 1; j < memories.length; j++) {
          if (toDeleteIds.has(memories[j].id)) continue;
          const textB = (memories[j].text || "").toLowerCase();
          const wordsB = new Set(textB.split(/\s+/));
          const lenRatio = Math.min(textA.length, textB.length) / Math.max(textA.length, textB.length, 1);
          if (lenRatio < 0.5) continue;
          const intersection = [...wordsA].filter(w => wordsB.has(w));
          const union = new Set([...wordsA, ...wordsB]);
          const similarity = intersection.length / union.size;
          if (similarity >= similarityThreshold) {
            const keep = (memories[i].recallCount || 0) >= (memories[j].recallCount || 0) ? memories[i] : memories[j];
            const remove = keep === memories[i] ? memories[j] : memories[i];
            toDeleteIds.add(remove.id);
            duplicates.push({
              keep: { id: keep.id, text: keep.text?.slice?.(0, 80) },
              remove: { id: remove.id, text: remove.text?.slice?.(0, 80) },
              similarity: Math.round(similarity * 1000) / 1000
            });
          }
        }
      }

      const now = Date.now();
      const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;
      const lowQuality = memories.filter(m =>
        !toDeleteIds.has(m.id) && m.tier === "peripheral" && (m.recallCount || 0) < minRecalls && m.createdAt < thirtyDaysAgo
      );
      lowQuality.forEach(m => toDeleteIds.add(m.id));

      const totalToRemove = toDeleteIds.size;

      if (mode === "delete" && totalToRemove > 0) {
        let deleted = 0;
        for (const id of toDeleteIds) { try { await db.table.delete(`id = '${id}'`); deleted++; } catch (e) {} }
        return { mode: "delete", deleted, duplicatesFound: duplicates.length, lowQualityFound: lowQuality.length, totalScanned: memories.length };
      }

      return {
        mode: "report", totalScanned: memories.length,
        duplicatesFound: duplicates.length, duplicates: duplicates.slice(0, 20),
        lowQualityFound: lowQuality.length,
        lowQuality: lowQuality.slice(0, 10).map(m => ({
          id: m.id, text: m.text?.slice?.(0, 80), tier: m.tier,
          recallCount: m.recallCount || 0, ageDays: Math.round((now - m.createdAt) / (24 * 60 * 60 * 1000))
        })),
        totalToRemove, suggestion: `运行 mode="delete" 将清理 ${totalToRemove} 条记忆`
      };
    }
  });
}

module.exports = { register };
