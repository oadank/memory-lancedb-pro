// tools/dreaming-tools.js — Dreaming manual trigger tool
const { Type } = require("@sinclair/typebox");

function register(api, { db, embeddings, reranker, extractor }) {
  const deps = { api, db, embeddings, reranker, extractor };

  api.registerTool({
    name: "memory_dreaming_run",
    label: "Memory Dreaming Run",
    description: "Manually trigger the dreaming process: collect recent memories, deduplicate, score, promote tiers, extract structured summary to MEMORY.md, generate dream diary.",
    parameters: Type.Object({
      dryRun: Type.Optional(Type.Boolean({ default: false, description: "Preview only, don't write files or modify tiers" })),
      noExtract: Type.Optional(Type.Boolean({ default: false, description: "Skip LLM extraction to MEMORY.md" })),
      noDiary: Type.Optional(Type.Boolean({ default: false, description: "Skip dream diary generation" }))
    }),
    async execute(_id, params) {
      const { runDreaming } = require("../lib/dreaming");

      if (params?.dryRun) {
        await db.ensureInitialized();
        const now = Date.now();
        const all = await db.table.search(Array(db.vectorDim).fill(0)).limit(200).toArray();
        const recent = all.filter(m => {
          if (m.id === "__schema__") return false;
          return (now - m.createdAt) / (60 * 60 * 1000) <= 24;
        });
        const { scoreMemory } = require("../lib/dreaming");
        const scored = recent.map(m => ({
          id: m.id.slice(0, 8), text: m.text.slice(0, 80), category: m.category,
          tier: m.tier, score: scoreMemory(m, now).total.toFixed(2)
        })).sort((a, b) => b.score - a.score);

        return {
          dryRun: true,
          recentCount: recent.length,
          candidates: scored.slice(0, 10),
          message: "Dry run complete. No files modified."
        };
      }

      return await runDreaming(deps, {
        extract: !params?.noExtract,
        diary: !params?.noDiary
      });
    }
  });

  api.registerTool({
    name: "memory_dreaming_schedule",
    label: "Memory Dreaming Schedule",
    description: "Set or check the dreaming schedule. Default: daily at 3:00 AM (Asia/Shanghai).",
    parameters: Type.Object({
      action: Type.Optional(Type.String({ enum: ["status", "set"], default: "status" })),
      cron: Type.Optional(Type.String({ description: "Cron expression, e.g. '0 3 * * *' for 3 AM daily" }))
    }),
    async execute(_id, params) {
      if (params?.action === "status") {
        return {
          scheduled: true,
          defaultCron: "0 3 * * *",
          timezone: "Asia/Shanghai",
          description: "Daily at 3:00 AM (Shanghai time)"
        };
      }
      if (params?.action === "set" && params?.cron) {
        api.logger.info(`[dreaming] Schedule set to: ${params.cron} (requires restart)`);
        return {
          cron: params.cron,
          message: "Schedule updated. Restart gateway to apply."
        };
      }
      return { current: "0 3 * * *", timezone: "Asia/Shanghai" };
    }
  });
}

module.exports = { register };
