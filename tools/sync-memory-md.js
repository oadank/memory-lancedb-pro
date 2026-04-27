// tools/sync-memory-md.js — MEMORY.md → knowledge_base 同步工具
const { Type } = require("@sinclair/typebox");

function register(api, { db, embeddings }) {
  const { syncMemoryMdToKB } = require("../lib/sync-memory-md");

  api.registerTool({
    name: "memory_sync_md_to_kb",
    label: "Sync MEMORY.md to Knowledge Base",
    description: "Read MEMORY.md, parse entries, embed them, and store in knowledge_base table for recall.",
    parameters: Type.Object({}),
    async execute() {
      return await syncMemoryMdToKB(db, embeddings, api);
    }
  });
}

module.exports = { register };
